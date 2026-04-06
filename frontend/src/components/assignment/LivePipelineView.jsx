import { useState, useEffect, useRef, useCallback } from 'react';
import { assignmentAPI, getAuthToken, getWorkspaceId } from '../../services/api';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Loader2, CheckCircle, XCircle, User, AlertTriangle, Brain,
  Users, Search, MapPin, X,
} from 'lucide-react';
import {
  CopyBadge, mdComponents, StreamContent, cleanTranscript, processStreamEvent,
} from './StreamingComponents';

export function RecommendationCards({ data, onDecide, deciding }) {
  const [selectedTechId, setSelectedTechId] = useState(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [showTechPicker, setShowTechPicker] = useState(false);
  const [allTechs, setAllTechs] = useState([]);
  const [techSearch, setTechSearch] = useState('');
  const [selectedOverrideTech, setSelectedOverrideTech] = useState(null);

  useEffect(() => {
    assignmentAPI.getCompetencyTechnicians().then(res => setAllTechs(res?.data || [])).catch(() => {});
  }, []);

  const techMap = {};
  for (const t of allTechs) techMap[t.id] = t;

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
  const isOverride = selectedOverrideTech != null;
  const effectiveTechId = isOverride ? selectedTechId : (selectedTechId || topRec?.techId);
  const effectiveTechName = isOverride ? selectedOverrideTech.name : (data.recommendations.find((r) => r.techId === effectiveTechId)?.techName || topRec?.techName);

  const loadTechs = async () => {
    if (allTechs.length === 0) {
      try { const res = await assignmentAPI.getCompetencyTechnicians(); setAllTechs(res?.data || []); } catch { /* ignore */ }
    }
  };

  return (
    <div className="mt-3 sm:mt-4 border-t pt-3 sm:pt-4">
      {data.overallReasoning && (
        <div className="bg-blue-50 border border-blue-100 rounded-lg p-2.5 sm:p-3 mb-3 sm:mb-4">
          <h4 className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-1">Overall Reasoning</h4>
          <p className="text-xs sm:text-sm text-blue-900 leading-relaxed">{data.overallReasoning}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3 sm:gap-4">
        {/* LEFT: Candidates (3/5 width) */}
        <div className="lg:col-span-3 space-y-1.5 sm:space-y-2">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Recommendations</h4>
          {data.recommendations.map((rec, i) => {
            const isSelected = effectiveTechId === rec.techId && !isOverride;
            const tech = techMap[rec.techId];
            const initials = rec.techName?.split(' ').map((n) => n[0]).join('').slice(0, 2) || '?';
            return (
              <div
                key={rec.techId || i}
                onClick={() => { setSelectedTechId(rec.techId); setSelectedOverrideTech(null); setShowTechPicker(false); }}
                className={`border rounded-lg p-3 sm:p-4 cursor-pointer transition-all touch-manipulation ${
                  isSelected ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-200' : 'hover:border-gray-300 active:bg-blue-50 bg-white'
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className={`w-5 h-5 rounded-full text-white text-[10px] flex items-center justify-center font-bold flex-shrink-0 mt-0.5 ${isSelected ? 'bg-blue-600' : 'bg-gray-400'}`}>{rec.rank || i + 1}</span>
                  {tech?.photoUrl ? (
                    <img src={tech.photoUrl} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
                  ) : (
                    <span className="w-9 h-9 rounded-full bg-gray-200 text-gray-500 text-xs font-bold flex items-center justify-center flex-shrink-0">{initials}</span>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-sm text-slate-900">{rec.techName}</span>
                      {typeof rec.score === 'number' && (
                        <span className={`text-sm font-mono font-bold flex-shrink-0 ${isSelected ? 'text-blue-700' : 'text-gray-500'}`}>{(rec.score * 100).toFixed(0)}%</span>
                      )}
                    </div>
                    {tech?.location && (
                      <p className="text-[11px] text-slate-400 flex items-center gap-1 mt-0.5">
                        <MapPin className="w-3 h-3 flex-shrink-0" /> {tech.location}
                      </p>
                    )}
                    {rec.reasoning && (
                      <>
                        <div className="border-t border-gray-100 mt-2 mb-1.5" />
                        <p className="text-xs text-gray-500 leading-relaxed">{rec.reasoning}</p>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* RIGHT: Decision Panel (2/5 width) */}
        {onDecide && (
          <div className="lg:col-span-2">
            <div className="bg-gray-50 rounded-lg p-3 sm:p-4 space-y-2.5 sm:space-y-3 lg:sticky lg:top-4">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Decision</h4>
                <button
                  onClick={async () => { await loadTechs(); setShowTechPicker(!showTechPicker); }}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors flex items-center gap-1 ${
                    showTechPicker ? 'bg-gray-200 text-gray-700' : 'text-blue-600 hover:bg-blue-50'
                  }`}
                >
                  <Users className="w-3 h-3" />
                  {showTechPicker ? 'Close' : 'Other tech'}
                </button>
              </div>

              {/* Tech picker (opens at top of panel) */}
              {showTechPicker && (
                <div className="border border-gray-200 rounded-lg bg-white overflow-hidden shadow-sm">
                  <div className="px-3 py-2 bg-gray-50 border-b">
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
                  <div className="max-h-48 overflow-y-auto">
                    {allTechs
                      .filter((t) => !techSearch || t.name.toLowerCase().includes(techSearch.toLowerCase()) || t.location?.toLowerCase().includes(techSearch.toLowerCase()))
                      .map((t) => {
                        const isRecommended = recTechIds.has(t.id);
                        const isActive = selectedTechId === t.id;
                        return (
                          <button
                            key={t.id}
                            onClick={() => { setSelectedTechId(t.id); setSelectedOverrideTech(t); setShowTechPicker(false); setTechSearch(''); }}
                            className={`w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors border-b border-gray-100 last:border-0 ${
                              isActive ? 'bg-blue-50' : 'hover:bg-gray-50'
                            }`}
                          >
                            {t.photoUrl ? (
                              <img src={t.photoUrl} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                            ) : (
                              <span className="w-7 h-7 rounded-full bg-gray-100 text-gray-500 text-[10px] font-bold flex items-center justify-center flex-shrink-0">
                                {t.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                              </span>
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-gray-900 truncate">{t.name}</p>
                              {t.location && <p className="text-[10px] text-gray-400">{t.location}</p>}
                            </div>
                            {isRecommended && <span className="text-[9px] font-medium bg-blue-100 text-blue-700 px-1 py-0.5 rounded flex-shrink-0">rec</span>}
                          </button>
                        );
                      })}
                    {allTechs.length === 0 && (
                      <div className="px-3 py-4 text-center text-xs text-gray-400">
                        <Loader2 className="w-3 h-3 animate-spin mx-auto mb-1" /> Loading...
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Selected tech banner (override) */}
              {isOverride && !showTechPicker && (
                <div className="flex items-center gap-2.5 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                  {selectedOverrideTech.photoUrl ? (
                    <img src={selectedOverrideTech.photoUrl} alt="" className="w-8 h-8 rounded-full object-cover ring-2 ring-blue-400" />
                  ) : (
                    <span className="w-8 h-8 rounded-full bg-blue-200 text-blue-700 text-xs font-bold flex items-center justify-center ring-2 ring-blue-400">
                      {selectedOverrideTech.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                    </span>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-blue-900">{selectedOverrideTech.name}</p>
                    {selectedOverrideTech.location && <p className="text-xs text-blue-600 flex items-center gap-0.5"><MapPin className="w-3 h-3" />{selectedOverrideTech.location}</p>}
                  </div>
                  <button onClick={() => { setSelectedTechId(null); setSelectedOverrideTech(null); }} className="p-1 hover:bg-blue-100 rounded-full"><X className="w-3.5 h-3.5 text-blue-400" /></button>
                </div>
              )}

              {/* Decision / triage note */}
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Triage Note <span className="text-gray-400">(optional — helps future AI decisions)</span></label>
                <textarea
                  value={decisionNote}
                  onChange={(e) => setDecisionNote(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg p-2 sm:p-2.5 text-sm resize-none h-12 sm:h-16 focus:ring-2 focus:ring-blue-200 focus:border-blue-300 transition-all bg-white"
                  placeholder={isOverride ? 'Why this technician?' : 'Add triage context...'}
                />
              </div>

              {/* Action buttons */}
              <div className="space-y-2 pt-1">
                {!isOverride ? (
                  <button
                    onClick={() => onDecide({ decision: 'approved', assignedTechId: effectiveTechId, decisionNote })}
                    disabled={deciding}
                    className="w-full px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 disabled:opacity-50 transition-colors shadow-sm touch-manipulation min-h-[44px]"
                  >
                    {deciding ? 'Processing...' : `Approve — ${effectiveTechName}`}
                  </button>
                ) : (
                  <button
                    onClick={() => onDecide({ decision: 'modified', assignedTechId: selectedTechId, overrideReason: decisionNote || null, decisionNote })}
                    disabled={deciding}
                    className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-sm touch-manipulation min-h-[44px]"
                  >
                    {deciding ? 'Processing...' : `Assign to ${selectedOverrideTech.name.split(' ')[0]}`}
                  </button>
                )}
                <button
                  onClick={() => onDecide({ decision: 'rejected', decisionNote })}
                  disabled={deciding}
                  className="w-full px-4 py-2 bg-white text-red-600 border border-red-200 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-50 transition-colors touch-manipulation min-h-[44px]"
                >
                  Reject
                </button>
              </div>

            </div>
          </div>
        )}
      </div>
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
  const [thinkingKb, setThinkingKb] = useState(null);
  const scrollRef = useRef(null);
  const abortRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

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
          setExistingRun(run);
          setRunId(run.id);
          setStatus('running_elsewhere');
        } else {
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
    setThinkingKb(null);
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

    function handleEvent(event) {
      processStreamEvent(event, {
        setEvents,
        setToolCalls,
        setThinkingKb,
        scrollToBottom,
        onRunStarted: (e) => { currentRunId = e.runId; setRunId(e.runId); },
        onQueued: (e) => { setRunId(e.runId); currentStatus = 'queued'; setStatus('queued'); setError(null); },
        onResult: (e) => { currentRecommendation = e.data; setRecommendation(e.data); currentStatus = 'completed'; setStatus('completed'); setTimeout(scrollToBottom, 50); },
        onError: (e) => { setError(e.message); if (!currentRecommendation) { currentStatus = 'error'; setStatus('error'); } },
        onComplete: () => { if (currentStatus !== 'error' && currentStatus !== 'queued') { currentStatus = 'completed'; setStatus('completed'); } },
      });
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
            try { handleEvent(JSON.parse(line.slice(6))); } catch { /* skip malformed */ }
          }
        }
        if (buffer.startsWith('data: ')) {
          try { handleEvent(JSON.parse(buffer.slice(6))); } catch { /* skip */ }
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          setStatus('error');
          setError(err.message);
        }
      } finally {
        setStreaming(false);
        setThinkingKb(null);

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
        className="flex-1 overflow-y-auto border rounded-lg bg-white p-2.5 sm:p-4 min-h-[200px] sm:min-h-[300px] max-h-[60vh] sm:max-h-[600px]"
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
        {events.length > 0 && (
          <StreamContent events={events} toolCalls={toolCalls} thinkingKb={thinkingKb} status={status} accentColor="blue" />
        )}
        {events.length === 0 && showExistingRun && existingRun.fullTranscript && (
          <div className="text-sm text-gray-800 leading-relaxed prose prose-sm max-w-none">
            <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {cleanTranscript(existingRun.fullTranscript)}
            </Markdown>
          </div>
        )}
        {events.length === 0 && showExistingRun && !existingRun.fullTranscript && existingRun.status === 'completed' && (
          <div className="text-sm text-gray-500 italic py-4 text-center">
            Analysis completed — transcript not available. Click &quot;Re-run Analysis&quot; to run again.
          </div>
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
