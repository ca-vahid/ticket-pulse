import { useState, useEffect, useRef, useCallback } from 'react';
import { assignmentAPI, getAuthToken, getWorkspaceId } from '../../services/api';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Loader2, CheckCircle, XCircle, Wrench, ChevronDown, ChevronRight,
  User, AlertTriangle, Brain, Copy, Check, Users, Search, MapPin, X,
} from 'lucide-react';

function CopyBadge({ label, value }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e) => {
    e.stopPropagation();
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

const mdComponents = {
  table: (props) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full text-xs border-collapse border border-gray-200" {...props} />
    </div>
  ),
  thead: (props) => <thead className="bg-gray-50" {...props} />,
  th: (props) => <th className="border border-gray-200 px-2 py-1 text-left font-semibold text-gray-600" {...props} />,
  td: (props) => <td className="border border-gray-200 px-2 py-1 text-gray-700" {...props} />,
  h1: (props) => <h1 className="text-lg font-bold mt-3 mb-1" {...props} />,
  h2: (props) => <h2 className="text-base font-bold mt-3 mb-1" {...props} />,
  h3: (props) => <h3 className="text-sm font-bold mt-2 mb-1" {...props} />,
  h4: (props) => <h4 className="text-sm font-semibold mt-2 mb-0.5" {...props} />,
  p: (props) => <p className="my-1" {...props} />,
  ul: (props) => <ul className="list-disc ml-5 my-1 space-y-0.5" {...props} />,
  ol: (props) => <ol className="list-decimal ml-5 my-1 space-y-0.5" {...props} />,
  li: (props) => <li className="text-sm" {...props} />,
  hr: () => <hr className="my-3 border-gray-200" />,
  strong: (props) => <strong className="font-semibold" {...props} />,
  code: ({ children, className, ...props }) => {
    const isBlock = className?.startsWith('language-');
    if (isBlock) {
      return <pre className="bg-gray-100 rounded p-2 my-1 overflow-x-auto text-xs"><code {...props}>{children}</code></pre>;
    }
    return <code className="bg-gray-100 px-1 py-0.5 rounded text-xs font-mono" {...props}>{children}</code>;
  },
  blockquote: (props) => <blockquote className="border-l-3 border-blue-300 pl-3 my-1 text-gray-600 italic" {...props} />,
};

function ToolCallCard({ name, input, result, durationMs }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-2 border rounded-lg bg-gray-50 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-100 transition-colors"
      >
        <Wrench className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
        <span className="text-xs font-medium text-blue-700">{name}</span>
        {result ? <CheckCircle className="w-3.5 h-3.5 text-green-500" /> : <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />}
        {durationMs != null && <span className="text-xs text-gray-400 ml-auto">{durationMs}ms</span>}
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-1">
          {input && (
            <div>
              <span className="text-xs text-gray-400 font-medium">Input:</span>
              <pre className="text-xs bg-white rounded p-1.5 border overflow-x-auto max-h-28">{JSON.stringify(input, null, 2)}</pre>
            </div>
          )}
          {result && (
            <div>
              <span className="text-xs text-gray-400 font-medium">Result:</span>
              <pre className="text-xs bg-white rounded p-1.5 border overflow-x-auto max-h-40">{JSON.stringify(result, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RecommendationCards({ data, onDecide, deciding }) {
  const [selectedTechId, setSelectedTechId] = useState(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [showTechPicker, setShowTechPicker] = useState(false);
  const [allTechs, setAllTechs] = useState([]);
  const [techSearch, setTechSearch] = useState('');
  const [selectedOverrideTech, setSelectedOverrideTech] = useState(null);

  if (!data?.recommendations?.length) {
    return (
      <div className="mt-4 border-t pt-4">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-center">
          <h4 className="text-sm font-semibold text-yellow-800 mb-1">No Assignment Needed</h4>
          <p className="text-sm text-yellow-700">{data?.overallReasoning || 'This ticket was classified as noise or non-actionable.'}</p>
          {data?.ticketClassification && (
            <p className="text-xs text-yellow-600 mt-2">Classification: {data.ticketClassification}</p>
          )}
          <p className="text-xs text-gray-400 mt-2">This run has been auto-dismissed.</p>
        </div>
      </div>
    );
  }

  const topRec = data.recommendations[0];
  const recTechIds = new Set(data.recommendations.map((r) => r.techId));
  const isOverride = selectedTechId && !recTechIds.has(selectedTechId);

  return (
    <div className="mt-4 border-t pt-4">
      <h4 className="text-sm font-semibold text-gray-700 mb-2">Recommendations</h4>
      {data.overallReasoning && (
        <p className="text-sm text-gray-600 mb-3 bg-blue-50 rounded-lg p-3">{data.overallReasoning}</p>
      )}
      <div className="space-y-2 mb-4">
        {data.recommendations.map((rec, i) => (
          <div
            key={rec.techId || i}
            onClick={() => { setSelectedTechId(rec.techId); setSelectedOverrideTech(null); }}
            className={`border rounded-lg p-3 cursor-pointer transition-all ${
              selectedTechId === rec.techId ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200' : 'hover:border-gray-300 bg-white'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">{rec.rank || i + 1}</span>
                <User className="w-4 h-4 text-gray-400" />
                <span className="font-medium text-sm">{rec.techName}</span>
              </div>
              {typeof rec.score === 'number' && (
                <span className="text-sm font-mono font-bold text-blue-700">{(rec.score * 100).toFixed(0)}%</span>
              )}
            </div>
            {rec.reasoning && <p className="text-xs text-gray-500 mt-1 ml-8">{rec.reasoning}</p>}
          </div>
        ))}
      </div>

      {onDecide && (
        <div className="bg-gray-50 rounded-lg p-4 space-y-3">
          <h4 className="text-sm font-semibold text-gray-700">Make Decision</h4>

          {/* Override selection banner */}
          {selectedOverrideTech && (
            <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
              {selectedOverrideTech.photoUrl ? (
                <img src={selectedOverrideTech.photoUrl} alt="" className="w-8 h-8 rounded-full object-cover ring-2 ring-blue-400" />
              ) : (
                <span className="w-8 h-8 rounded-full bg-blue-200 text-blue-700 text-xs font-bold flex items-center justify-center ring-2 ring-blue-400">
                  {selectedOverrideTech.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                </span>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-blue-900">{selectedOverrideTech.name}</p>
                {selectedOverrideTech.location && <p className="text-xs text-blue-600 flex items-center gap-1"><MapPin className="w-3 h-3" />{selectedOverrideTech.location}</p>}
              </div>
              <button onClick={() => { setSelectedTechId(null); setSelectedOverrideTech(null); }} className="p-1 hover:bg-blue-100 rounded-full transition-colors"><X className="w-4 h-4 text-blue-400" /></button>
            </div>
          )}

          {/* Override reason */}
          {selectedTechId && selectedTechId !== topRec?.techId && (
            <div className="space-y-2">
              <textarea
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                className="w-full border border-gray-200 rounded-lg p-2.5 text-sm resize-none h-16 focus:ring-2 focus:ring-blue-200 focus:border-blue-300 transition-all"
                placeholder="Why assign to a different technician? (required)"
              />
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            {!selectedOverrideTech ? (
              <button
                onClick={() => onDecide({ decision: 'approved', assignedTechId: topRec?.techId })}
                disabled={deciding}
                className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 disabled:opacity-50 transition-colors shadow-sm"
              >
                {deciding ? 'Processing...' : `Approve (${topRec?.techName})`}
              </button>
            ) : (
              <button
                onClick={() => onDecide({ decision: 'modified', assignedTechId: selectedTechId, overrideReason })}
                disabled={deciding || !overrideReason.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-sm"
              >
                {deciding ? 'Processing...' : `Assign to ${selectedOverrideTech.name.split(' ')[0]}`}
              </button>
            )}
            <button
              onClick={() => onDecide({ decision: 'rejected' })}
              disabled={deciding}
              className="px-4 py-2 bg-red-50 text-red-700 border border-red-200 rounded-lg text-sm font-medium hover:bg-red-100 disabled:opacity-50 transition-colors"
            >
              Reject
            </button>
            <div className="flex-1" />
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
              className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                showTechPicker ? 'bg-gray-200 text-gray-700' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 hover:border-gray-300'
              }`}
            >
              <Users className="w-3.5 h-3.5" />
              {showTechPicker ? 'Close' : 'Choose different tech'}
            </button>
          </div>

          {/* Tech picker panel */}
          {showTechPicker && (
            <div className="border border-gray-200 rounded-lg bg-white overflow-hidden shadow-sm">
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-200">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    value={techSearch}
                    onChange={(e) => setTechSearch(e.target.value)}
                    placeholder="Search by name or location..."
                    className="w-full pl-8 pr-3 py-1.5 border border-gray-200 rounded-md text-sm bg-white focus:ring-2 focus:ring-blue-200 focus:border-blue-300"
                    autoFocus
                  />
                </div>
              </div>
              <div className="max-h-56 overflow-y-auto">
                {allTechs
                  .filter((t) => !techSearch || t.name.toLowerCase().includes(techSearch.toLowerCase()) || t.location?.toLowerCase().includes(techSearch.toLowerCase()))
                  .map((t) => {
                    const isRecommended = recTechIds.has(t.id);
                    const isActive = selectedTechId === t.id;
                    return (
                      <button
                        key={t.id}
                        onClick={() => { setSelectedTechId(t.id); setSelectedOverrideTech(t); setShowTechPicker(false); setTechSearch(''); }}
                        className={`w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors border-b border-gray-100 last:border-0 ${
                          isActive ? 'bg-blue-50' : 'hover:bg-gray-50'
                        }`}
                      >
                        {t.photoUrl ? (
                          <img src={t.photoUrl} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
                        ) : (
                          <span className="w-8 h-8 rounded-full bg-gray-100 text-gray-500 text-[10px] font-bold flex items-center justify-center flex-shrink-0">
                            {t.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                          </span>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{t.name}</p>
                          {t.location && <p className="text-xs text-gray-400 flex items-center gap-1"><MapPin className="w-3 h-3 flex-shrink-0" />{t.location}</p>}
                        </div>
                        {isRecommended && <span className="text-[10px] font-medium bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded flex-shrink-0">recommended</span>}
                      </button>
                    );
                  })}
                {allTechs.length === 0 && (
                  <div className="px-3 py-4 text-center text-sm text-gray-400">
                    <Loader2 className="w-4 h-4 animate-spin mx-auto mb-1" /> Loading technicians...
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function LivePipelineView({ ticketId, onComplete, onBack }) {
  const [status, setStatus] = useState('loading');
  const [events, setEvents] = useState([]);
  const [toolCalls, setToolCalls] = useState([]);
  const [recommendation, setRecommendation] = useState(null);
  const [runId, setRunId] = useState(null);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState(null);
  const [existingRun, setExistingRun] = useState(null);
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef(null);
  const abortRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  // Check for existing run on mount (and on F5 refresh)
  useEffect(() => {
    if (!ticketId) return;
    let cancelled = false;

    async function checkExisting() {
      try {
        const res = await assignmentAPI.getLatestRunForTicket(ticketId);
        if (cancelled) return;
        const run = res?.data;
        if (run && (run.status === 'completed' || run.status === 'failed' || run.status === 'queued')) {
          setExistingRun(run);
          setRunId(run.id);
          setStatus(run.status === 'queued' ? 'queued' : run.status === 'failed' ? 'error' : 'completed');
          if (run.recommendation) setRecommendation(run.recommendation);
          if (run.errorMessage) setError(run.errorMessage);
        } else if (run && run.status === 'running') {
          // A run is in progress (possibly from another tab) — show a message
          setExistingRun(run);
          setRunId(run.id);
          setStatus('running_elsewhere');
        } else {
          // No existing run — auto-trigger
          startStream();
        }
      } catch {
        if (!cancelled) startStream();
      }
    }

    checkExisting();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  function startStream() {
    if (streaming) return;
    setStreaming(true);
    setExistingRun(null);
    setStatus('connecting');
    setEvents([]);
    setToolCalls([]);
    setRecommendation(null);
    setError(null);
    setRunId(null);

    const abortController = new AbortController();
    abortRef.current = abortController;

    const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000') + '/api';
    const authToken = getAuthToken();
    const wsId = getWorkspaceId();
    let currentStatus = 'connecting';
    let currentRecommendation = null;
    let currentRunId = null;

    function processEvent(event) {
      setEvents((prev) => [...prev, event]);

      switch (event.type) {
      case 'run_started':
        currentRunId = event.runId;
        setRunId(event.runId);
        break;
      case 'queued':
        setRunId(event.runId);
        currentStatus = 'queued';
        setStatus('queued');
        setError(null);
        break;
      case 'text':
        setTimeout(scrollToBottom, 10);
        break;
      case 'tool_call':
        setToolCalls((prev) => [...prev, {
          id: event.toolUseId || `${event.name}-${Date.now()}`,
          name: event.name,
          input: event.input,
          result: null,
          durationMs: null,
        }]);
        setTimeout(scrollToBottom, 10);
        break;
      case 'tool_result':
        setToolCalls((prev) => prev.map((tc) => {
          if (event.toolUseId && tc.id === event.toolUseId) {
            return { ...tc, result: event.data, durationMs: event.durationMs };
          }
          if (!event.toolUseId && tc.name === event.name && !tc.result) {
            return { ...tc, result: event.data, durationMs: event.durationMs };
          }
          return tc;
        }));
        break;
      case 'recommendation':
        currentRecommendation = event.data;
        setRecommendation(event.data);
        currentStatus = 'completed';
        setStatus('completed');
        setTimeout(scrollToBottom, 50);
        break;
      case 'error':
        setError(event.message);
        if (!currentRecommendation) {
          currentStatus = 'error';
          setStatus('error');
        }
        break;
      case 'complete':
      case 'done':
        if (currentStatus !== 'error' && currentStatus !== 'queued') {
          currentStatus = 'completed';
          setStatus('completed');
        }
        break;
      default:
        break;
      }
    }

    (async () => {
      try {
        const response = await fetch(`${API_BASE}/assignment/trigger/${ticketId}?stream=true`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            ...(wsId ? { 'X-Workspace-Id': String(wsId) } : {}),
          },
          signal: abortController.signal,
        });

        if (!response.ok) {
          setStatus('error');
          setError(`HTTP ${response.status}`);
          setStreaming(false);
          return;
        }

        currentStatus = 'running';
        setStatus('running');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let reading = true;

        while (reading) {
          const { done, value } = await reader.read();
          if (done) { reading = false; break; }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try { processEvent(JSON.parse(line.slice(6))); } catch { /* skip malformed */ }
          }
        }

        if (buffer.startsWith('data: ')) {
          try { processEvent(JSON.parse(buffer.slice(6))); } catch { /* skip */ }
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          setStatus('error');
          setError(err.message);
        }
      } finally {
        setStreaming(false);

        // Refetch the completed run so transcript survives F5 and existingRun is populated
        if (currentStatus === 'completed' && currentRunId) {
          try {
            const res = await assignmentAPI.getLatestRunForTicket(ticketId);
            if (res?.data) {
              setExistingRun(res.data);
              if (res.data.recommendation && !currentRecommendation) {
                setRecommendation(res.data.recommendation);
              }
            }
          } catch { /* non-critical */ }
        }
      }
    })();
  }

  // Cleanup abort on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const handleDecide = async (decisionData) => {
    if (!runId) return;
    try {
      setDeciding(true);
      await assignmentAPI.decide(runId, decisionData);
      onComplete?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeciding(false);
    }
  };

  const renderStream = () => {
    const segments = [];
    let textSoFar = '';
    let toolIndex = 0;

    for (const event of events) {
      if (event.type === 'text') {
        textSoFar += event.text;
      } else if (event.type === 'tool_call') {
        if (textSoFar) {
          segments.push({ type: 'text', content: textSoFar });
          textSoFar = '';
        }
        const tc = toolCalls[toolIndex] || { name: event.name, input: event.input };
        segments.push({ type: 'tool', ...tc });
        toolIndex++;
      }
    }
    if (textSoFar) {
      segments.push({ type: 'text', content: textSoFar });
    }

    return segments.map((seg, i) => {
      if (seg.type === 'text') {
        return (
          <div key={i} className="text-sm text-gray-800 leading-relaxed prose prose-sm max-w-none">
            <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {seg.content}
            </Markdown>
          </div>
        );
      }
      if (seg.type === 'tool') {
        return (
          <ToolCallCard
            key={i}
            name={seg.name}
            input={seg.input}
            result={seg.result}
            durationMs={seg.durationMs}
          />
        );
      }
      return null;
    });
  };

  function cleanTranscript(raw) {
    if (!raw) return '';
    return raw
      .replace(/```json\n([\s\S]*?)```/g, (_, json) => {
        try { const parsed = JSON.parse(json); return '```json\n' + JSON.stringify(parsed, null, 2) + '\n```'; } catch { return _; }
      })
      .replace(/\n{3,}/g, '\n\n');
  }

  const STATUS_INDICATORS = {
    loading: { icon: Loader2, text: 'Loading...', color: 'text-gray-500', spin: true },
    connecting: { icon: Loader2, text: 'Connecting...', color: 'text-gray-500', spin: true },
    running: { icon: Brain, text: 'Claude is analyzing...', color: 'text-blue-600', spin: true },
    completed: { icon: CheckCircle, text: 'Analysis complete', color: 'text-green-600', spin: false },
    error: { icon: XCircle, text: 'Pipeline failed', color: 'text-red-600', spin: false },
    queued: { icon: AlertTriangle, text: 'Queued for business hours', color: 'text-orange-600', spin: false },
    running_elsewhere: { icon: Brain, text: 'Analysis running...', color: 'text-blue-600', spin: true },
  };

  const statusInfo = STATUS_INDICATORS[status] || STATUS_INDICATORS.loading;
  const StatusIcon = statusInfo.icon;
  const showExistingRun = existingRun && !streaming;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <StatusIcon className={`w-5 h-5 ${statusInfo.color} ${statusInfo.spin ? 'animate-spin' : ''}`} />
          <span className={`text-sm font-medium ${statusInfo.color}`}>{statusInfo.text}</span>
          {runId && <CopyBadge label="Run" value={runId} />}
        </div>
        <div className="flex items-center gap-2">
          {showExistingRun && (
            <button
              onClick={startStream}
              className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition-colors flex items-center gap-1"
            >
              <Brain className="w-3.5 h-3.5" /> Re-run Analysis
            </button>
          )}
          {onBack && (
            <button onClick={onBack} className="text-sm text-blue-600 hover:underline">
              Back to queue
            </button>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto border rounded-lg bg-white p-4 min-h-[300px] max-h-[600px]"
      >
        {status === 'loading' && (
          <div className="flex items-center justify-center h-full text-gray-400">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        )}
        {events.length === 0 && status === 'connecting' && (
          <div className="flex items-center justify-center h-full text-gray-400">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        )}
        {status === 'running_elsewhere' && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-center">
            <Brain className="w-8 h-8 text-blue-500 mx-auto mb-2" />
            <h4 className="text-sm font-semibold text-blue-800 mb-1">Analysis In Progress</h4>
            <p className="text-sm text-blue-700">This ticket is being analyzed in another session. Refresh to check for results.</p>
          </div>
        )}
        {status === 'queued' && !streaming && existingRun && (
          <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 text-center">
            <AlertTriangle className="w-8 h-8 text-orange-500 mx-auto mb-2" />
            <h4 className="text-sm font-semibold text-orange-800 mb-1">Queued Until Next Business Window</h4>
            <p className="text-sm text-orange-700">{existingRun.queuedReason || 'Currently outside business hours.'}</p>
            <p className="text-xs text-gray-500 mt-2">This ticket will be processed automatically when business hours resume.</p>
          </div>
        )}
        {status === 'queued' && streaming && (
          <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 text-center">
            <AlertTriangle className="w-8 h-8 text-orange-500 mx-auto mb-2" />
            <h4 className="text-sm font-semibold text-orange-800 mb-1">Queued Until Next Business Window</h4>
            <p className="text-sm text-orange-700">
              {events.find((e) => e.type === 'queued')?.reason || 'Currently outside business hours.'}
            </p>
            <p className="text-xs text-gray-500 mt-2">This ticket will be processed automatically when business hours resume.</p>
          </div>
        )}
        {showExistingRun && existingRun.fullTranscript && (
          <div className="text-sm text-gray-800 leading-relaxed prose prose-sm max-w-none">
            <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {cleanTranscript(existingRun.fullTranscript)}
            </Markdown>
          </div>
        )}
        {showExistingRun && !existingRun.fullTranscript && existingRun.status === 'completed' && (
          <div className="text-sm text-gray-500 italic py-4 text-center">
            Analysis completed — transcript not available. Click &quot;Re-run Analysis&quot; to run again.
          </div>
        )}
        {events.length > 0 && renderStream()}
        {status === 'running' && (
          <span className="inline-block w-2 h-4 bg-blue-500 animate-pulse ml-0.5" />
        )}
      </div>

      {error && (
        <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {recommendation && (
        <RecommendationCards
          data={recommendation}
          onDecide={status === 'completed' ? handleDecide : null}
          deciding={deciding}
        />
      )}
    </div>
  );
}
