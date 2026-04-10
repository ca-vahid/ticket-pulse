import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { assignmentAPI } from '../../services/api';
import { useStreamingFetch } from '../../hooks/useStreamingFetch';
import {
  Loader2, Brain, CheckCircle, XCircle, Play,
  ChevronDown, ChevronRight, ArrowRight, FileText, Users, AlertTriangle,
  Target, TrendingUp, BarChart3, History,
} from 'lucide-react';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mdComponents } from './StreamingComponents';

const PRESETS = [
  { label: 'Last 2 weeks', days: 14 },
  { label: 'Last month', days: 30 },
  { label: 'Last 3 months', days: 90 },
];

function OutcomeBadge({ outcome }) {
  const styles = {
    top_rec: 'bg-green-100 text-green-800',
    in_pool: 'bg-blue-100 text-blue-800',
    outside_pool: 'bg-orange-100 text-orange-800',
    unresolved: 'bg-gray-100 text-gray-600',
  };
  const labels = {
    top_rec: 'Top Rec',
    in_pool: 'In Pool',
    outside_pool: 'Outside Pool',
    unresolved: 'Unresolved',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[outcome] || styles.unresolved}`}>
      {labels[outcome] || outcome}
    </span>
  );
}

function StatusBadge({ status }) {
  const styles = {
    running: 'bg-blue-100 text-blue-800',
    collecting: 'bg-blue-100 text-blue-800',
    analyzing_prompt: 'bg-purple-100 text-purple-800',
    analyzing_competencies: 'bg-indigo-100 text-indigo-800',
    completed: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || 'bg-gray-100 text-gray-700'}`}>
      {status?.replace(/_/g, ' ')}
    </span>
  );
}

function SummaryCards({ data }) {
  const total = data.totalRuns || 0;
  const pct = (n) => total > 0 ? Math.round((n / total) * 100) : 0;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
      <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
        <div className="text-2xl font-bold text-slate-800">{total}</div>
        <div className="text-xs text-slate-500">Total Runs</div>
      </div>
      <div className="bg-green-50 rounded-lg p-3 border border-green-200">
        <div className="text-2xl font-bold text-green-700">{data.outcome1 ?? data.outcome1Count ?? 0}</div>
        <div className="text-xs text-green-600">Top Rec ({pct(data.outcome1 ?? data.outcome1Count ?? 0)}%)</div>
      </div>
      <div className="bg-blue-50 rounded-lg p-3 border border-blue-200">
        <div className="text-2xl font-bold text-blue-700">{data.outcome2 ?? data.outcome2Count ?? 0}</div>
        <div className="text-xs text-blue-600">In Pool ({pct(data.outcome2 ?? data.outcome2Count ?? 0)}%)</div>
      </div>
      <div className="bg-orange-50 rounded-lg p-3 border border-orange-200">
        <div className="text-2xl font-bold text-orange-700">{data.outcome3 ?? data.outcome3Count ?? 0}</div>
        <div className="text-xs text-orange-600">Outside ({pct(data.outcome3 ?? data.outcome3Count ?? 0)}%)</div>
      </div>
      <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
        <div className="text-2xl font-bold text-slate-600">{data.accuracyRate ?? pct((data.outcome1 ?? data.outcome1Count ?? 0) + (data.outcome2 ?? data.outcome2Count ?? 0))}%</div>
        <div className="text-xs text-slate-500">Accuracy</div>
      </div>
    </div>
  );
}

function LiveCalibrationView({ periodStart, periodEnd, onComplete }) {
  const [phase, setPhase] = useState(null);
  const [phaseMessage, setPhaseMessage] = useState('');
  const [runId, setRunId] = useState(null);
  const [stats, setStats] = useState(null);
  const [promptDraftId, setPromptDraftId] = useState(null);
  const [promptFindings, setPromptFindings] = useState([]);
  const [flaggedTechs, setFlaggedTechs] = useState([]);
  const [techProgress, setTechProgress] = useState({ current: 0, total: 0, currentName: '' });
  const [promptText, setPromptText] = useState('');
  const [completedTechs, setCompletedTechs] = useState([]);

  const scrollRef = useRef(null);
  const navigate = useNavigate();

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, []);

  const handleEvent = useCallback((event, { setStatus: setStreamStatus, setError: setStreamError, stopTimer }) => {
    switch (event.type) {
    case 'calibration_started':
      setRunId(event.runId);
      break;
    case 'phase_update':
      setPhase(event.phase);
      setPhaseMessage(event.message);
      if (event.phase === 'completed') {
        setStreamStatus('completed');
        stopTimer();
      }
      break;
    case 'classification_complete':
      setStats({ totalRuns: event.totalRuns, outcome1: event.outcome1, outcome2: event.outcome2, outcome3: event.outcome3, unresolved: event.unresolved });
      break;
    case 'prompt_analysis_text':
      setPromptText(prev => prev + event.text);
      scrollToBottom();
      break;
    case 'prompt_draft_created':
      setPromptDraftId(event.draftId || null);
      if (Array.isArray(event.findings) && event.findings.length > 0) {
        setPromptFindings(event.findings);
      }
      break;
    case 'competency_flagged':
      setFlaggedTechs(event.techs || []);
      setTechProgress({ current: 0, total: event.total, currentName: '' });
      break;
    case 'competency_tech_start':
      setTechProgress({ current: event.index, total: event.total, currentName: event.techName });
      break;
    case 'competency_tech_complete':
      setCompletedTechs(prev => [...prev, { id: event.techId, name: event.techName, runId: event.runId }]);
      break;
    case 'competency_tech_error':
      setCompletedTechs(prev => [...prev, { id: event.techId, name: event.techName, error: event.error }]);
      break;
    case 'error':
      setStreamError(event.message);
      break;
    case 'calibration_complete':
      setRunId(event.runId);
      break;
    default:
      break;
    }
  }, [scrollToBottom]);

  const { status, elapsedSec, error } = useStreamingFetch({
    url: '/assignment/calibration?stream=true',
    body: { periodStart, periodEnd },
    onEvent: handleEvent,
    deps: [periodStart, periodEnd],
  });

  const phaseSteps = [
    { key: 'collecting', label: 'Data Collection', icon: BarChart3 },
    { key: 'analyzing_prompt', label: 'Prompt Analysis', icon: FileText },
    { key: 'analyzing_competencies', label: 'Competency Updates', icon: Users },
    { key: 'completed', label: 'Complete', icon: CheckCircle },
  ];

  const phaseOrder = phaseSteps.map(s => s.key);
  const currentPhaseIdx = phaseOrder.indexOf(phase);

  return (
    <div className="space-y-4">
      {/* Status Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {status === 'running' ? (
            <Brain className="w-5 h-5 text-purple-600 animate-spin" />
          ) : status === 'completed' ? (
            <CheckCircle className="w-5 h-5 text-green-600" />
          ) : (
            <XCircle className="w-5 h-5 text-red-600" />
          )}
          <span className={`text-sm font-semibold ${status === 'completed' ? 'text-green-700' : status === 'error' ? 'text-red-700' : 'text-purple-700'}`}>
            {status === 'running' ? `Calibrating... (${elapsedSec}s)` : status === 'completed' ? `Calibration complete (${elapsedSec}s)` : 'Calibration failed'}
          </span>
          {runId && <span className="text-xs text-gray-400">Run #{runId}</span>}
        </div>
        {status === 'completed' && (
          <button onClick={() => onComplete(runId)} className="text-sm text-blue-600 hover:text-blue-800 font-medium">
            View Results
          </button>
        )}
      </div>

      {/* Phase Progress */}
      <div className="flex items-center gap-1 bg-slate-50 rounded-lg p-2 border border-slate-200">
        {phaseSteps.map((step, i) => {
          const Icon = step.icon;
          const isActive = step.key === phase;
          const isDone = currentPhaseIdx > i || status === 'completed';
          return (
            <div key={step.key} className="flex items-center gap-1 flex-1">
              <div className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium ${isDone ? 'text-green-700' : isActive ? 'text-purple-700 bg-purple-100' : 'text-gray-400'}`}>
                {isDone ? <CheckCircle className="w-3.5 h-3.5" /> : isActive ? <Icon className="w-3.5 h-3.5 animate-pulse" /> : <Icon className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline">{step.label}</span>
              </div>
              {i < phaseSteps.length - 1 && <ArrowRight className="w-3 h-3 text-gray-300 flex-shrink-0" />}
            </div>
          );
        })}
      </div>

      {phaseMessage && (
        <div className="text-sm text-gray-600 bg-gray-50 rounded-lg px-3 py-2 border border-gray-200">
          {phaseMessage}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {/* Stats */}
      {stats && <SummaryCards data={stats} />}

      {/* Prompt Analysis Stream */}
      {(phase === 'analyzing_prompt' || promptText) && (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <div className="bg-purple-50 px-3 py-2 border-b border-slate-200 flex items-center gap-2">
            <FileText className="w-4 h-4 text-purple-600" />
            <span className="text-sm font-semibold text-purple-800">Prompt Analysis</span>
            {promptDraftId && (
              <span className="ml-auto text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">
                Draft v{promptDraftId} created
              </span>
            )}
          </div>
          <div className="p-3 max-h-80 overflow-y-auto text-sm text-gray-800 leading-relaxed prose prose-sm max-w-none">
            {promptText ? (
              <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{promptText}</Markdown>
            ) : (
              <span className="text-gray-400 text-xs">Analyzing patterns...</span>
            )}
          </div>
          {promptFindings.length > 0 && (
            <div className="px-3 pb-3 space-y-2">
              {promptFindings.map((f, i) => (
                <div key={i} className="bg-white border border-purple-100 rounded px-2.5 py-2 text-xs">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className={`px-1 py-0.5 rounded font-medium ${f.confidence === 'high' ? 'bg-green-100 text-green-700' : f.confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600'}`}>
                      {f.confidence}
                    </span>
                    <span className="font-medium text-gray-800">{f.pattern}</span>
                  </div>
                  {f.suggestedChange && <p className="text-purple-600 mt-0.5">{f.suggestedChange}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Competency Progress */}
      {(phase === 'analyzing_competencies' || completedTechs.length > 0) && (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <div className="bg-indigo-50 px-3 py-2 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-indigo-600" />
              <span className="text-sm font-semibold text-indigo-800">Competency Updates</span>
            </div>
            {techProgress.total > 0 && (
              <span className="text-xs text-indigo-600">{techProgress.current}/{techProgress.total}</span>
            )}
          </div>
          <div className="p-3 space-y-2">
            {flaggedTechs.length > 0 && (
              <div className="text-xs text-gray-500 mb-2">
                {flaggedTechs.length} technician{flaggedTechs.length !== 1 ? 's' : ''} flagged for re-evaluation
              </div>
            )}
            {techProgress.currentName && phase === 'analyzing_competencies' && (
              <div className="flex items-center gap-2 text-sm text-indigo-700 bg-indigo-50 rounded px-2 py-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Analyzing {techProgress.currentName}...
              </div>
            )}
            {completedTechs.map((tech) => (
              <div key={tech.id} className="flex items-center justify-between text-sm bg-white rounded px-2 py-1.5 border border-gray-100">
                <div className="flex items-center gap-2">
                  {tech.error ? <XCircle className="w-3.5 h-3.5 text-red-500" /> : <CheckCircle className="w-3.5 h-3.5 text-green-500" />}
                  <span className={tech.error ? 'text-red-700' : 'text-gray-700'}>{tech.name}</span>
                </div>
                {tech.runId && !tech.error && (
                  <button onClick={() => navigate(`/assignments/competency-run/${tech.runId}`)} className="text-xs text-blue-600 hover:underline">
                    View run
                  </button>
                )}
                {tech.error && <span className="text-xs text-red-500">{tech.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div ref={scrollRef} />
    </div>
  );
}

function RunDetail({ run, workspaceTimezone }) {
  const [expanded, setExpanded] = useState({ outcomes: false, findings: true, competencies: true });
  const navigate = useNavigate();

  if (!run) return null;

  const classifiedRuns = run.classifiedData?.runs || [];
  const findings = run.promptFindings || [];
  const flaggedTechs = run.flaggedTechIds || [];
  const competencyRunMap = run.competencyRunIds || {};

  const toggle = (key) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-800">Calibration Run #{run.id}</h3>
          <p className="text-sm text-slate-500">
            {new Date(run.periodStart).toLocaleDateString()} — {new Date(run.periodEnd).toLocaleDateString()}
            {run.triggeredBy && <span className="ml-2">by {run.triggeredBy}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={run.status} />
          {run.totalDurationMs && <span className="text-xs text-gray-400">{(run.totalDurationMs / 1000).toFixed(0)}s</span>}
          {run.totalTokensUsed && <span className="text-xs text-gray-400">{(run.totalTokensUsed / 1000).toFixed(1)}k tokens</span>}
        </div>
      </div>

      <SummaryCards data={run} />

      {/* Outcome Breakdown */}
      {classifiedRuns.length > 0 && (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <button onClick={() => toggle('outcomes')} className="w-full bg-slate-50 px-3 py-2 border-b border-slate-200 flex items-center justify-between hover:bg-slate-100 transition-colors">
            <div className="flex items-center gap-2">
              <Target className="w-4 h-4 text-slate-600" />
              <span className="text-sm font-semibold text-slate-800">Outcome Breakdown</span>
              <span className="text-xs text-slate-500">({classifiedRuns.length} runs)</span>
            </div>
            {expanded.outcomes ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
          </button>
          {expanded.outcomes && (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-1.5 text-xs text-gray-500 font-medium">Ticket</th>
                    <th className="text-left px-3 py-1.5 text-xs text-gray-500 font-medium">Outcome</th>
                    <th className="text-left px-3 py-1.5 text-xs text-gray-500 font-medium">Recommended</th>
                    <th className="text-left px-3 py-1.5 text-xs text-gray-500 font-medium">Actual</th>
                    <th className="text-left px-3 py-1.5 text-xs text-gray-500 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {classifiedRuns.map((r) => (
                    <tr key={r.runId} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-1.5">
                        <div className="font-medium text-gray-800 truncate max-w-[200px]" title={r.subject}>
                          {r.freshserviceTicketId ? `#${r.freshserviceTicketId}` : `Run ${r.runId}`}
                        </div>
                        <div className="text-xs text-gray-400 truncate max-w-[200px]">{r.subject}</div>
                      </td>
                      <td className="px-3 py-1.5"><OutcomeBadge outcome={r.outcome} /></td>
                      <td className="px-3 py-1.5 text-xs text-gray-600">{r.topRecName || '—'}</td>
                      <td className="px-3 py-1.5 text-xs text-gray-600">{r.actualTechName || '—'}</td>
                      <td className="px-3 py-1.5 text-xs text-gray-500 max-w-[200px] truncate" title={r.decisionNote || r.overrideReason || ''}>
                        {r.decisionNote || r.overrideReason || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Prompt Findings */}
      {findings.length > 0 && (
        <div className="border border-purple-200 rounded-lg overflow-hidden">
          <button onClick={() => toggle('findings')} className="w-full bg-purple-50 px-3 py-2 border-b border-purple-200 flex items-center justify-between hover:bg-purple-100 transition-colors">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-purple-600" />
              <span className="text-sm font-semibold text-purple-800">Prompt Findings</span>
              <span className="text-xs text-purple-500">({findings.length} finding{findings.length !== 1 ? 's' : ''})</span>
              {run.promptDraftId && (
                <span className="ml-2 text-xs bg-purple-200 text-purple-800 px-2 py-0.5 rounded-full">
                  Draft created
                </span>
              )}
            </div>
            {expanded.findings ? <ChevronDown className="w-4 h-4 text-purple-400" /> : <ChevronRight className="w-4 h-4 text-purple-400" />}
          </button>
          {expanded.findings && (
            <div className="p-3 space-y-3">
              {findings.map((f, i) => (
                <div key={i} className="bg-white border border-gray-100 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${f.confidence === 'high' ? 'bg-green-100 text-green-700' : f.confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600'}`}>
                      {f.confidence}
                    </span>
                    <span className="text-sm font-medium text-gray-800">{f.pattern}</span>
                  </div>
                  {f.evidence && <p className="text-xs text-gray-500 mt-1">{f.evidence}</p>}
                  {f.suggestedChange && (
                    <p className="text-xs text-purple-700 mt-1 bg-purple-50 rounded px-2 py-1">
                      <span className="font-medium">Suggestion:</span> {f.suggestedChange}
                    </p>
                  )}
                </div>
              ))}
              {run.promptDraftId && (
                <button
                  onClick={() => navigate('/assignments/prompts')}
                  className="w-full text-center text-sm text-purple-600 hover:text-purple-800 font-medium py-2 border border-purple-200 rounded-lg hover:bg-purple-50 transition-colors"
                >
                  Review draft in Prompt Manager →
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Competency Updates */}
      {flaggedTechs.length > 0 && (
        <div className="border border-indigo-200 rounded-lg overflow-hidden">
          <button onClick={() => toggle('competencies')} className="w-full bg-indigo-50 px-3 py-2 border-b border-indigo-200 flex items-center justify-between hover:bg-indigo-100 transition-colors">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-indigo-600" />
              <span className="text-sm font-semibold text-indigo-800">Competency Updates</span>
              <span className="text-xs text-indigo-500">({flaggedTechs.length} tech{flaggedTechs.length !== 1 ? 's' : ''} updated)</span>
            </div>
            {expanded.competencies ? <ChevronDown className="w-4 h-4 text-indigo-400" /> : <ChevronRight className="w-4 h-4 text-indigo-400" />}
          </button>
          {expanded.competencies && (
            <div className="p-3 space-y-2">
              {flaggedTechs.map((tech, i) => {
                const cRunId = competencyRunMap[tech.techId];
                return (
                  <div key={tech.techId || i} className="flex items-center justify-between bg-white border border-gray-100 rounded-lg px-3 py-2">
                    <div>
                      <div className="text-sm font-medium text-gray-800">{tech.techName}</div>
                      <div className="text-xs text-gray-500">
                        {tech.reasons?.map(r => r.replace(/_/g, ' ')).join(', ')}
                      </div>
                    </div>
                    {cRunId && (
                      <button
                        onClick={() => navigate(`/assignments/competency-run/${cRunId}`)}
                        className="text-xs text-indigo-600 hover:underline"
                      >
                        View analysis
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {run.errorMessage && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
          {run.errorMessage}
        </div>
      )}
    </div>
  );
}

export default function CalibrationManager({ workspaceTimezone }) {
  const [view, setView] = useState('trigger'); // trigger | live | detail | history
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [runs, setRuns] = useState([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [selectedRun, setSelectedRun] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const navigate = useNavigate();

  const applyPreset = (days) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    setPeriodStart(start.toISOString().slice(0, 10));
    setPeriodEnd(end.toISOString().slice(0, 10));
  };

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    try {
      const res = await assignmentAPI.getCalibrationRuns({ limit: 20 });
      setRuns(res?.items || []);
    } catch { /* ignore */ }
    setLoadingRuns(false);
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  const loadRunDetail = async (id) => {
    setLoadingDetail(true);
    try {
      const res = await assignmentAPI.getCalibrationRun(id);
      setSelectedRun(res?.data || null);
      setView('detail');
    } catch { /* ignore */ }
    setLoadingDetail(false);
  };

  const startCalibration = () => {
    if (!periodStart || !periodEnd) return;
    setView('live');
  };

  const handleLiveComplete = async (completedRunId) => {
    loadRuns();
    if (completedRunId) {
      await loadRunDetail(completedRunId);
    } else {
      setView('trigger');
    }
  };

  if (view === 'live') {
    return (
      <div>
        <button onClick={() => { setView('trigger'); loadRuns(); }} className="text-sm text-blue-600 hover:text-blue-800 mb-3 flex items-center gap-1">
          ← Back to Calibration
        </button>
        <LiveCalibrationView periodStart={periodStart} periodEnd={periodEnd} onComplete={handleLiveComplete} />
      </div>
    );
  }

  if (view === 'detail' && selectedRun) {
    return (
      <div>
        <button onClick={() => { setSelectedRun(null); setView('trigger'); }} className="text-sm text-blue-600 hover:text-blue-800 mb-3 flex items-center gap-1">
          ← Back to Calibration
        </button>
        <RunDetail run={selectedRun} workspaceTimezone={workspaceTimezone} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Trigger Section */}
      <div>
        <h3 className="text-lg font-semibold text-slate-800 mb-1 flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-purple-600" />
          Calibration Run
        </h3>
        <p className="text-sm text-slate-500 mb-4">
          Analyze assignment outcomes over a period to improve the AI assigner prompt and update technician competencies based on real-world results.
        </p>

        <div className="bg-gradient-to-br from-purple-50 to-indigo-50 border border-purple-200 rounded-xl p-4">
          <div className="flex flex-wrap items-end gap-3 mb-3">
            <div>
              <label className="block text-xs text-slate-600 font-medium mb-1">Period Start</label>
              <input
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                className="border border-slate-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 font-medium mb-1">Period End</label>
              <input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="border border-slate-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div className="flex gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.days}
                  onClick={() => applyPreset(p.days)}
                  className="text-xs px-2.5 py-2 bg-white border border-purple-200 rounded-lg text-purple-700 hover:bg-purple-100 transition-colors font-medium"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={startCalibration}
            disabled={!periodStart || !periodEnd}
            className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-lg text-sm font-semibold hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm transition-all"
          >
            <Play className="w-4 h-4" />
            Start Calibration
          </button>

          <div className="mt-3 text-xs text-slate-500 space-y-1">
            <p>This process will:</p>
            <ul className="list-disc list-inside space-y-0.5 ml-1">
              <li>Collect all decided pipeline runs in the period and classify outcomes</li>
              <li>Analyze patterns and create a draft prompt with improvements</li>
              <li>Run competency analysis for technicians with discrepancies</li>
            </ul>
          </div>
        </div>
      </div>

      {/* History Section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-slate-800 flex items-center gap-2">
            <History className="w-4 h-4 text-slate-500" />
            Calibration History
          </h3>
          <button onClick={loadRuns} className="text-xs text-blue-600 hover:text-blue-800">
            Refresh
          </button>
        </div>

        {loadingRuns ? (
          <div className="flex items-center justify-center py-8 text-gray-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
          </div>
        ) : runs.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm">
            No calibration runs yet. Start your first one above.
          </div>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <button
                key={run.id}
                onClick={() => loadRunDetail(run.id)}
                disabled={loadingDetail}
                className="w-full text-left bg-white border border-slate-200 rounded-lg px-4 py-3 hover:border-purple-300 hover:shadow-sm transition-all group"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="text-sm font-semibold text-slate-800">Run #{run.id}</div>
                    <StatusBadge status={run.status} />
                    <span className="text-xs text-slate-500">
                      {new Date(run.periodStart).toLocaleDateString()} — {new Date(run.periodEnd).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-400">
                    {run.totalRuns != null && <span>{run.totalRuns} runs</span>}
                    {run.outcome1Count != null && <span className="text-green-600">{run.outcome1Count} top</span>}
                    {run.outcome3Count != null && run.outcome3Count > 0 && <span className="text-orange-600">{run.outcome3Count} outside</span>}
                    {run.totalDurationMs && <span>{(run.totalDurationMs / 1000).toFixed(0)}s</span>}
                    <ChevronRight className="w-4 h-4 group-hover:text-purple-500 transition-colors" />
                  </div>
                </div>
                {run.triggeredBy && (
                  <div className="text-xs text-slate-400 mt-1">
                    {formatDateTimeInTimezone(run.createdAt, workspaceTimezone)} by {run.triggeredBy}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
