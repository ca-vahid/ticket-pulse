import { useState } from 'react';
import { assignmentAPI } from '../../services/api';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronDown, ChevronRight, CheckCircle, XCircle, AlertTriangle,
  User, Loader2, Brain, MapPin, Calendar, BarChart3, Award, MessageSquare, Copy, Check,
} from 'lucide-react';

function cleanTranscript(raw) {
  if (!raw) return '';
  return raw
    .replace(/\[Tool: ([\w_]+)\] → \{[\s\S]*?\}(?:\.\.\.)?\n*/g, '\n> **Tool:** `$1` — *data returned (see Pipeline Steps above for details)*\n\n')
    .replace(/\[Server Tool: ([\w_]+)\] query="([^"]*)"\n*/g, '\n> **Web Search:** `$2`\n\n')
    .replace(/\[Web Search Results: (\d+) results\]\n*/g, '> *$1 search results returned*\n\n')
    .replace(/\s*\*\(\d+\.\d+KB\)\*\s*/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

const STEP_ICONS = {
  classification: Brain,
  categorization: Award,
  location: MapPin,
  availability: Calendar,
  competency: Award,
  workload: BarChart3,
  recommendation: MessageSquare,
};

const STATUS_STYLES = {
  completed: { icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50' },
  failed: { icon: XCircle, color: 'text-red-600', bg: 'bg-red-50' },
  running: { icon: Loader2, color: 'text-blue-600', bg: 'bg-blue-50' },
  skipped: { icon: AlertTriangle, color: 'text-gray-400', bg: 'bg-gray-50' },
};

function StepCard({ step }) {
  const [expanded, setExpanded] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  const statusStyle = STATUS_STYLES[step.status] || STATUS_STYLES.running;
  const StatusIcon = statusStyle.icon;
  const StepIcon = STEP_ICONS[step.stepName] || Brain;

  return (
    <div className={`border rounded-lg ${statusStyle.bg} mb-2`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 text-left hover:bg-white/40 transition-colors rounded-lg"
      >
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-gray-400 w-5">{step.stepNumber}</span>
          <StepIcon className="w-4 h-4 text-gray-500" />
          <span className="font-medium text-sm capitalize">{step.stepName.replace(/_/g, ' ')}</span>
          <StatusIcon className={`w-4 h-4 ${statusStyle.color} ${step.status === 'running' ? 'animate-spin' : ''}`} />
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {step.durationMs && <span>{step.durationMs}ms</span>}
          {step.tokensUsed && <span>{step.tokensUsed} tokens</span>}
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {step.output && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Output</h4>
              <pre className="bg-white rounded p-2 text-xs overflow-x-auto max-h-60 border">
                {JSON.stringify(step.output, null, 2)}
              </pre>
            </div>
          )}

          {step.input && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Input</h4>
              <pre className="bg-white rounded p-2 text-xs overflow-x-auto max-h-40 border">
                {JSON.stringify(step.input, null, 2)}
              </pre>
            </div>
          )}

          {(step.llmPrompt || step.llmResponse) && (
            <div>
              <button
                onClick={() => setShowPrompt(!showPrompt)}
                className="text-xs text-blue-600 hover:underline"
              >
                {showPrompt ? 'Hide' : 'Show'} LLM prompt/response
              </button>
              {showPrompt && (
                <div className="mt-2 space-y-2">
                  {step.llmPrompt && (
                    <div>
                      <h5 className="text-xs font-semibold text-gray-400">Prompt</h5>
                      <pre className="bg-gray-900 text-green-300 rounded p-2 text-xs overflow-x-auto max-h-60">
                        {step.llmPrompt}
                      </pre>
                    </div>
                  )}
                  {step.llmResponse && (
                    <div>
                      <h5 className="text-xs font-semibold text-gray-400">Response</h5>
                      <pre className="bg-gray-900 text-blue-300 rounded p-2 text-xs overflow-x-auto max-h-60">
                        {step.llmResponse}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {step.errorMessage && (
            <div className="bg-red-100 text-red-700 rounded p-2 text-xs">
              {step.errorMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RecommendationCard({ rec, rank, isSelected, onSelect }) {
  return (
    <div
      onClick={onSelect}
      className={`border rounded-lg p-3 cursor-pointer transition-all ${
        isSelected ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200' : 'border-gray-200 hover:border-gray-300 bg-white'
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">
            {rank}
          </span>
          <User className="w-4 h-4 text-gray-400" />
          <span className="font-medium text-sm">{rec.techName}</span>
        </div>
        <span className="text-sm font-mono font-bold text-blue-700">
          {typeof rec.score === 'number' ? (rec.score * 100).toFixed(0) : rec.compositeScore ? (rec.compositeScore * 100).toFixed(0) : '?'}%
        </span>
      </div>
      {rec.reasoning && <p className="text-xs text-gray-600 mb-2">{rec.reasoning}</p>}
      {rec.breakdown && (
        <div className="grid grid-cols-3 gap-1 text-xs">
          <div className="text-center">
            <div className="text-gray-400">Competency</div>
            <div className="font-medium">{((rec.breakdown.competency || 0) * 100).toFixed(0)}%</div>
          </div>
          <div className="text-center">
            <div className="text-gray-400">Workload</div>
            <div className="font-medium">{((rec.breakdown.workload || 0) * 100).toFixed(0)}%</div>
          </div>
          <div className="text-center">
            <div className="text-gray-400">Location</div>
            <div className="font-medium">{((rec.breakdown.location || 0) * 100).toFixed(0)}%</div>
          </div>
        </div>
      )}
    </div>
  );
}

function CopyBadge({ label, value }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(String(value));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 hover:bg-gray-200 rounded text-xs text-gray-500 font-mono transition-colors"
      title={`Copy ${label}`}
    >
      {label} #{value}
      {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

const DECISION_BADGES = {
  pending_review: { label: 'Pending Review', style: 'bg-yellow-100 text-yellow-800' },
  approved: { label: 'Approved', style: 'bg-green-100 text-green-800' },
  modified: { label: 'Modified', style: 'bg-blue-100 text-blue-800' },
  rejected: { label: 'Rejected', style: 'bg-red-100 text-red-800' },
  auto_assigned: { label: 'Auto-Assigned', style: 'bg-purple-100 text-purple-800' },
  noise_dismissed: { label: 'Noise Dismissed', style: 'bg-gray-100 text-gray-600' },
};

const RUN_STATUS_BADGES = {
  queued: { label: 'Queued', style: 'bg-orange-100 text-orange-800' },
  running: { label: 'Running', style: 'bg-blue-100 text-blue-800' },
  failed: { label: 'Failed', style: 'bg-red-100 text-red-800' },
  cancelled: { label: 'Cancelled', style: 'bg-gray-100 text-gray-600' },
  superseded: { label: 'Superseded', style: 'bg-gray-100 text-gray-600' },
  skipped_stale: { label: 'Skipped Stale', style: 'bg-gray-100 text-gray-600' },
};

const SYNC_BADGES = {
  synced: { label: 'Synced to FreshService', style: 'bg-green-100 text-green-800', icon: '✓' },
  failed: { label: 'Sync failed', style: 'bg-red-100 text-red-800', icon: '✗' },
  dry_run: { label: 'Dry run (not synced)', style: 'bg-yellow-100 text-yellow-800', icon: '◑' },
  pending: { label: 'Sync pending', style: 'bg-gray-100 text-gray-600', icon: '…' },
  skipped: { label: 'Sync skipped', style: 'bg-gray-100 text-gray-500', icon: '–' },
};

function SyncStatusCard({ run, onSyncComplete }) {
  const [syncing, setSyncing] = useState(false);
  const [localSyncStatus, setLocalSyncStatus] = useState(run.syncStatus);
  const [localSyncedAt, setLocalSyncedAt] = useState(run.syncedAt);
  const [localSyncError, setLocalSyncError] = useState(run.syncError);
  const [result, setResult] = useState(null);
  const badge = SYNC_BADGES[localSyncStatus] || SYNC_BADGES.pending;

  const handleSync = async (dryRun) => {
    try {
      setSyncing(true);
      setResult(null);
      const res = dryRun ? await assignmentAPI.syncPreview(run.id) : await assignmentAPI.syncRun(run.id);
      const data = res?.data || res;
      setResult(data);
      if (!dryRun && data?.success) {
        setLocalSyncStatus('synced');
        setLocalSyncedAt(new Date().toISOString());
        setLocalSyncError(null);
        onSyncComplete?.();
      } else if (!dryRun && !data?.success) {
        setLocalSyncStatus('failed');
        setLocalSyncError(data?.error || 'Sync failed');
      }
    } catch (err) {
      setResult({ success: false, error: err.message });
      if (!dryRun) {
        setLocalSyncStatus('failed');
        setLocalSyncError(err.message);
      }
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className={`rounded-lg border p-3 ${localSyncStatus === 'failed' ? 'border-red-200 bg-red-50' : localSyncStatus === 'dry_run' ? 'border-yellow-200 bg-yellow-50' : localSyncStatus === 'synced' ? 'border-green-200 bg-green-50' : 'border-slate-200 bg-slate-50'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.style}`}>{badge.icon} {badge.label}</span>
          {localSyncedAt && <span className="text-xs text-gray-400">{new Date(localSyncedAt).toLocaleString()}</span>}
        </div>
        <div className="flex gap-1.5">
          {(localSyncStatus === 'dry_run' || localSyncStatus === 'failed') && (
            <button onClick={() => handleSync(false)} disabled={syncing} className="px-2.5 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700 disabled:opacity-50">
              {syncing ? 'Syncing...' : localSyncStatus === 'failed' ? 'Retry Sync' : 'Execute for Real'}
            </button>
          )}
          {!localSyncStatus && (
            <button onClick={() => handleSync(true)} disabled={syncing} className="px-2.5 py-1 border rounded text-xs font-medium hover:bg-slate-50 disabled:opacity-50">
              Preview Sync
            </button>
          )}
        </div>
      </div>
      {localSyncError && <p className="text-xs text-red-600 mt-1.5">{localSyncError}</p>}
      {run.syncPayload?.preview && <p className="text-xs text-slate-500 mt-1.5">Actions: {run.syncPayload.preview}</p>}
      {result && (
        <div className={`mt-2 text-xs p-2 rounded ${result.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {result.success ? (result.dryRun ? `Dry run: ${result.preview}` : `Synced: ${result.preview}`) : `Error: ${result.error}`}
        </div>
      )}
    </div>
  );
}

export default function PipelineRunDetail({ run, onDecide, deciding, onSyncComplete }) {
  const [selectedTechId, setSelectedTechId] = useState(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [showTechPicker, setShowTechPicker] = useState(false);
  const [allTechs, setAllTechs] = useState([]);
  const [techSearch, setTechSearch] = useState('');

  if (!run) return null;

  const recommendations = run.recommendation?.recommendations || [];
  const topRec = recommendations[0];
  const decisionBadge = run.status === 'completed'
    ? (DECISION_BADGES[run.decision] || DECISION_BADGES.pending_review)
    : (RUN_STATUS_BADGES[run.status] || RUN_STATUS_BADGES.running);
  const isPending = run.decision === 'pending_review' && run.status === 'completed';

  const handleApprove = () => {
    const techId = topRec?.techId;
    if (techId) onDecide({ decision: 'approved', assignedTechId: techId });
  };

  const handleModify = () => {
    if (selectedTechId && overrideReason.trim()) {
      onDecide({ decision: 'modified', assignedTechId: selectedTechId, overrideReason: overrideReason.trim() });
    }
  };

  const handleReject = () => {
    onDecide({ decision: 'rejected' });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-lg font-semibold">
              Pipeline Run #{run.id}
            </h3>
            <CopyBadge label="Run" value={run.id} />
          </div>
          <p className="text-sm text-gray-500">
            Ticket #{run.ticket?.freshserviceTicketId} &mdash; {run.ticket?.subject || 'No subject'}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            Triggered: {run.triggerSource} &bull; {new Date(run.createdAt).toLocaleString()} &bull; {run.totalDurationMs ? `${(run.totalDurationMs / 1000).toFixed(1)}s` : ''}
            {run.totalTokensUsed ? ` &bull; ${run.totalTokensUsed} tokens` : ''}
          </p>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-medium ${decisionBadge.style}`}>
          {decisionBadge.label}
        </span>
      </div>

      {run.status !== 'completed' && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
          This run is in status <strong>{run.status}</strong>.
          {run.errorMessage ? ` ${run.errorMessage}` : ''}
        </div>
      )}

      {/* FreshService Sync Status */}
      {run.syncStatus && (
        <SyncStatusCard run={run} onSyncComplete={onSyncComplete} />
      )}

      {/* Overall reasoning */}
      {run.recommendation?.overallReasoning && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
          <h4 className="text-xs font-semibold text-blue-700 uppercase mb-1">Overall Reasoning</h4>
          <p className="text-sm text-blue-900">{run.recommendation.overallReasoning}</p>
          {run.recommendation.severity && (
            <span className="text-xs text-blue-600 mt-1 inline-block">Severity: {run.recommendation.severity}</span>
          )}
        </div>
      )}

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-gray-700 mb-2">Recommendations</h4>
          <div className="grid gap-2">
            {recommendations.map((rec, i) => (
              <RecommendationCard
                key={rec.techId || i}
                rec={rec}
                rank={rec.rank || i + 1}
                isSelected={selectedTechId === rec.techId}
                onSelect={() => setSelectedTechId(rec.techId)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Decision actions */}
      {isPending && (
        <div className="bg-gray-50 border rounded-lg p-4 space-y-3">
          <h4 className="text-sm font-semibold text-gray-700">Make Decision</h4>
          <div className="flex gap-2">
            <button
              onClick={handleApprove}
              disabled={deciding || !topRec}
              className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              {deciding ? 'Processing...' : `Approve (${topRec?.techName || '?'})`}
            </button>
            <button
              onClick={handleReject}
              disabled={deciding}
              className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              Reject
            </button>
          </div>

          {selectedTechId && selectedTechId !== topRec?.techId && (
            <div className="space-y-2 mt-2">
              <p className="text-xs text-gray-500">
                You selected a different technician. Provide a reason for the override:
              </p>
              <textarea
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="Why are you choosing a different technician?"
                className="w-full border rounded-lg p-2 text-sm resize-none h-20"
              />
              <button
                onClick={handleModify}
                disabled={deciding || !overrideReason.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                Override Assignment
              </button>
            </div>
          )}

          {/* Assign to someone else */}
          <div className="border-t pt-3 mt-3">
            <button
              onClick={async () => {
                if (!showTechPicker && allTechs.length === 0) {
                  try {
                    const res = await assignmentAPI.getCompetencyTechnicians();
                    setAllTechs(res?.data || []);
                  } catch { /* ignore */ }
                }
                setShowTechPicker(!showTechPicker);
              }}
              className="text-xs text-blue-600 hover:underline"
            >
              {showTechPicker ? 'Hide technician list' : 'Assign to someone else...'}
            </button>

            {showTechPicker && (
              <div className="mt-2 space-y-2">
                <input
                  type="text"
                  value={techSearch}
                  onChange={(e) => setTechSearch(e.target.value)}
                  placeholder="Search technicians..."
                  className="w-full border rounded-lg px-3 py-1.5 text-sm"
                />
                <div className="max-h-48 overflow-y-auto border rounded-lg divide-y">
                  {allTechs
                    .filter((t) => !techSearch || t.name.toLowerCase().includes(techSearch.toLowerCase()) || t.location?.toLowerCase().includes(techSearch.toLowerCase()))
                    .map((t) => (
                      <button
                        key={t.id}
                        onClick={() => { setSelectedTechId(t.id); setShowTechPicker(false); setTechSearch(''); }}
                        className={`w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-blue-50 text-sm ${selectedTechId === t.id ? 'bg-blue-50' : ''}`}
                      >
                        {t.photoUrl ? (
                          <img src={t.photoUrl} alt="" className="w-6 h-6 rounded-full object-cover" />
                        ) : (
                          <span className="w-6 h-6 rounded-full bg-gray-200 text-gray-500 text-[10px] font-bold flex items-center justify-center">{t.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}</span>
                        )}
                        <span className="font-medium">{t.name}</span>
                        {t.location && <span className="text-xs text-gray-400">({t.location})</span>}
                      </button>
                    ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Decided info */}
      {run.decidedAt && (
        <div className="bg-gray-50 border rounded-lg p-3 text-sm">
          <p><span className="text-gray-500">Decided by:</span> {run.decidedByEmail}</p>
          <p><span className="text-gray-500">At:</span> {new Date(run.decidedAt).toLocaleString()}</p>
          {run.assignedTech && <p><span className="text-gray-500">Assigned to:</span> {run.assignedTech.name}</p>}
          {run.overrideReason && <p><span className="text-gray-500">Override reason:</span> {run.overrideReason}</p>}
        </div>
      )}

      {/* Pipeline Steps */}
      <div>
        <h4 className="text-sm font-semibold text-gray-700 mb-2">Pipeline Steps</h4>
        {run.steps?.map((step) => (
          <StepCard key={step.id} step={step} />
        ))}
      </div>

      {/* Full Transcript */}
      <div>
        <h4 className="text-sm font-semibold text-gray-700 mb-2">Full Conversation</h4>
        {run.fullTranscript ? (
          <div className="border rounded-lg bg-white p-4 prose prose-sm max-w-none">
            <Markdown remarkPlugins={[remarkGfm]}>
              {cleanTranscript(run.fullTranscript)}
            </Markdown>
          </div>
        ) : (
          <div className="border rounded-lg bg-gray-50 p-4 text-sm text-gray-500">
            No full transcript was captured for this run.
          </div>
        )}
      </div>

      {/* Error */}
      {run.errorMessage && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          <strong>Error:</strong> {run.errorMessage}
        </div>
      )}
    </div>
  );
}
