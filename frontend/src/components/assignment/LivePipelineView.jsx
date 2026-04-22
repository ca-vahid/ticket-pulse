import { useState, useEffect, useRef, useCallback } from 'react';
import { assignmentAPI } from '../../services/api';
import { readSSEStream } from '../../hooks/useStreamingFetch';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Loader2, CheckCircle, XCircle, AlertTriangle, Brain, MessageSquare,
  Users, Search, MapPin, X, ChevronDown, ChevronRight, Star, Sparkles,
} from 'lucide-react';
import {
  CopyBadge, mdComponents, StreamContent, cleanTranscript, processStreamEvent,
} from './StreamingComponents';

/** Strip obvious script/event-handler vectors before rendering FreshService HTML. Not a full sanitizer. */
function sanitizeBriefingHtml(html) {
  if (!html) return '';
  return html
    .replace(/<\/(?:script|style)[^>]*>[\s\S]*?<\/(?:script|style)>/gi, '')
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/on\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/on\w+\s*=\s*'[^']*'/gi, '')
    .replace(/on\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:\s*/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '');
}

/**
 * Inline preview of the private note that will be (or has been) posted to FreshService.
 * Mirrors AgentBriefingCard in PipelineRunDetail so the user can see the same content
 * without having to navigate to the run detail page.
 */
function AgentBriefingPreview({ recommendation, decision }) {
  if (!recommendation) return null;

  const isNoise = decision === 'noise_dismissed'
    || (Array.isArray(recommendation.recommendations) && recommendation.recommendations.length === 0);
  const briefing = isNoise ? recommendation.closureNoticeHtml : recommendation.agentBriefingHtml;
  const fieldName = isNoise ? 'closureNoticeHtml' : 'agentBriefingHtml';

  if (!briefing) {
    return (
      <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
            <MessageSquare className="w-3.5 h-3.5 text-amber-700" />
          </div>
          <h4 className="text-xs font-semibold text-amber-800 uppercase tracking-wide">What the agent will see</h4>
          <span className="ml-auto text-[10px] font-medium text-amber-700/80 uppercase tracking-wider">Public note</span>
        </div>
        <p className="text-xs text-amber-800/90">
          The LLM did not produce a <code className="font-mono bg-amber-100 px-1 rounded">{fieldName}</code> for this run.
          On sync, the FreshService note will fall back to {isNoise ? 'a generic closure message' : 'the internal reasoning above'} — which may leak routing logic.
        </p>
      </div>
    );
  }

  const safeHtml = sanitizeBriefingHtml(briefing);

  return (
    <div className="mt-4 bg-gradient-to-br from-emerald-50 via-teal-50 to-slate-50 border border-emerald-100 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-6 h-6 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0">
          <MessageSquare className="w-3.5 h-3.5 text-emerald-700" />
        </div>
        <h4 className="text-xs font-semibold text-emerald-800 uppercase tracking-wide">
          {isNoise ? 'Closure notice (what the agent will see)' : 'What the agent will see'}
        </h4>
        <span className="ml-auto text-[10px] font-medium text-emerald-700/80 uppercase tracking-wider">Public note</span>
      </div>
      <div
        className="text-sm text-slate-700 leading-relaxed prose prose-sm max-w-none prose-p:my-2 prose-a:text-emerald-700"
        dangerouslySetInnerHTML={{ __html: safeHtml }}
      />
    </div>
  );
}


function ScoreRing({ pct, selected = false, size = 52 }) {
  if (pct === null || pct === undefined) return null;
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct / 100);
  const trackColor = '#e2e8f0';
  const fillColor = selected ? '#3b82f6' : pct >= 80 ? '#10b981' : pct >= 60 ? '#6366f1' : pct >= 40 ? '#f59e0b' : '#94a3b8';
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={trackColor} strokeWidth="5" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={fillColor} strokeWidth="5"
          strokeDasharray={`${circ} ${circ}`}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.5s ease, stroke 0.3s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className={`text-[11px] font-bold tabular-nums leading-none ${selected ? 'text-blue-600' : 'text-slate-600'}`}>{pct}%</span>
      </div>
    </div>
  );
}

export function RecommendationCards({ data, onDecide, deciding, hideReasoning = false, hideAgentBriefing = false, decision = null }) {
  const [selectedTechId, setSelectedTechId] = useState(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [showTechPicker, setShowTechPicker] = useState(false);
  const [allTechs, setAllTechs] = useState([]);
  const [techSearch, setTechSearch] = useState('');
  const [selectedOverrideTech, setSelectedOverrideTech] = useState(null);
  const [showReasoning, setShowReasoning] = useState(false);

  useEffect(() => {
    assignmentAPI.getCompetencyTechnicians().then(res => setAllTechs(res?.data || [])).catch(() => {});
  }, []);

  const techMap = {};
  for (const t of allTechs) techMap[t.id] = t;

  if (!data?.recommendations?.length) {
    return (
      <div className="mt-4 border-t pt-4 space-y-3">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-yellow-800 mb-1 text-center">No Assignment Needed</h4>
          {data?.overallReasoning ? (
            <div className="text-sm text-yellow-800 prose prose-sm max-w-none prose-p:my-1.5 prose-headings:text-yellow-900 prose-strong:text-yellow-900">
              <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{data.overallReasoning}</Markdown>
            </div>
          ) : (
            <p className="text-sm text-yellow-700 text-center">This ticket was classified as noise or non-actionable.</p>
          )}
          {data?.ticketClassification && (
            <p className="text-xs text-yellow-600 mt-2 text-center">Classification: {data.ticketClassification}</p>
          )}
          <p className="text-xs text-gray-400 mt-2 text-center">No technician recommendations were produced for this run.</p>
        </div>
        {!hideAgentBriefing && <AgentBriefingPreview recommendation={data} decision={decision || 'noise_dismissed'} />}
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

  const scorePercent = (score) => typeof score === 'number' ? Math.round(score * 100) : null;

  return (
    <div className="mt-3 sm:mt-4 border-t pt-3 sm:pt-4">
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3 sm:gap-4">
        {/* LEFT: Candidates (3/5 width) */}
        <div className="lg:col-span-3 space-y-2 sm:space-y-2.5">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Recommendations</h4>
          {data.recommendations.map((rec, i) => {
            const isSelected = effectiveTechId === rec.techId && !isOverride;
            const isTopPick = i === 0;
            const tech = techMap[rec.techId];
            const initials = rec.techName?.split(' ').map((n) => n[0]).join('').slice(0, 2) || '?';
            const pct = scorePercent(rec.score);
            const rankColors = ['bg-amber-400', 'bg-slate-400', 'bg-slate-300'];
            return (
              <div
                key={rec.techId || i}
                onClick={() => { setSelectedTechId(rec.techId); setSelectedOverrideTech(null); setShowTechPicker(false); }}
                className={`relative rounded-xl cursor-pointer transition-all touch-manipulation overflow-hidden ${
                  isSelected
                    ? 'border-2 border-blue-500 bg-blue-50/60 shadow-md'
                    : isTopPick
                      ? 'border border-amber-200 bg-gradient-to-br from-amber-50/40 to-white hover:border-amber-300 hover:shadow-sm'
                      : 'border border-slate-200 hover:border-slate-300 hover:shadow-sm bg-white'
                }`}
              >
                {/* Selected indicator stripe */}
                {isSelected && (
                  <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-blue-400 to-blue-600" />
                )}

                <div className="p-3 sm:p-4 flex items-center gap-3">
                  {/* Avatar with rank badge */}
                  <div className="relative flex-shrink-0">
                    {tech?.photoUrl ? (
                      <img src={tech.photoUrl} alt="" className={`w-12 h-12 rounded-full object-cover ${isSelected ? 'ring-2 ring-blue-400' : isTopPick ? 'ring-2 ring-amber-300' : 'ring-1 ring-slate-200'}`} />
                    ) : (
                      <span className={`w-12 h-12 rounded-full text-sm font-bold flex items-center justify-center ${isSelected ? 'bg-blue-100 text-blue-700' : isTopPick ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{initials}</span>
                    )}
                    <span className={`absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full text-[9px] font-bold flex items-center justify-center ring-2 ring-white ${rankColors[i] || 'bg-slate-200 text-slate-600'} text-white`}>
                      {i + 1}
                    </span>
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                      <span className={`font-semibold text-sm truncate ${isSelected ? 'text-blue-900' : 'text-slate-900'}`}>{rec.techName}</span>
                      {isTopPick && (
                        <span className={`inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full flex-shrink-0 ${isSelected ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
                          <Star className="w-2.5 h-2.5" /> Top Pick
                        </span>
                      )}
                    </div>
                    {tech?.location && (
                      <p className="text-[11px] text-slate-400 flex items-center gap-1 mb-1">
                        <MapPin className="w-3 h-3 flex-shrink-0" /> {tech.location}
                      </p>
                    )}
                    {rec.reasoning && (
                      <p className="text-xs text-slate-500 leading-relaxed">{rec.reasoning}</p>
                    )}
                  </div>

                  {/* Score ring */}
                  {pct !== null && <ScoreRing pct={pct} selected={isSelected} />}
                </div>
              </div>
            );
          })}
        </div>

        {/* RIGHT: Decision Panel (2/5 width) */}
        {onDecide && (
          <div className="lg:col-span-2">
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-3 sm:p-4 space-y-2.5 sm:space-y-3 lg:sticky lg:top-4">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Decision</h4>
                <button
                  onClick={async () => { await loadTechs(); setShowTechPicker(!showTechPicker); }}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors flex items-center gap-1 ${
                    showTechPicker ? 'bg-slate-200 text-slate-700' : 'text-blue-600 hover:bg-blue-50'
                  }`}
                >
                  <Users className="w-3 h-3" />
                  {showTechPicker ? 'Close' : 'Other tech'}
                </button>
              </div>

              {/* Tech picker */}
              {showTechPicker && (
                <div className="border border-slate-200 rounded-lg bg-white overflow-hidden shadow-sm">
                  <div className="px-3 py-2 bg-slate-50 border-b">
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input
                        type="text"
                        value={techSearch}
                        onChange={(e) => setTechSearch(e.target.value)}
                        placeholder="Search by name or location..."
                        className="w-full pl-8 pr-3 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:ring-2 focus:ring-blue-200 focus:border-blue-300"
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
                            className={`w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors border-b border-slate-100 last:border-0 ${
                              isActive ? 'bg-blue-50' : 'hover:bg-slate-50'
                            }`}
                          >
                            {t.photoUrl ? (
                              <img src={t.photoUrl} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                            ) : (
                              <span className="w-7 h-7 rounded-full bg-slate-100 text-slate-500 text-[10px] font-bold flex items-center justify-center flex-shrink-0">
                                {t.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                              </span>
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-slate-900 truncate">{t.name}</p>
                              {t.location && <p className="text-[10px] text-slate-400">{t.location}</p>}
                            </div>
                            {isRecommended && <span className="text-[9px] font-medium bg-blue-100 text-blue-700 px-1 py-0.5 rounded flex-shrink-0">rec</span>}
                          </button>
                        );
                      })}
                    {allTechs.length === 0 && (
                      <div className="px-3 py-4 text-center text-xs text-slate-400">
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

              {/* Triage note */}
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Triage Note <span className="text-slate-400">(optional — helps future AI decisions)</span></label>
                <textarea
                  value={decisionNote}
                  onChange={(e) => setDecisionNote(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg p-2 sm:p-2.5 text-sm resize-none h-12 sm:h-16 focus:ring-2 focus:ring-blue-200 focus:border-blue-300 transition-all bg-white"
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

      {/* AI Reasoning — shown here only when not displayed elsewhere (e.g. LivePipelineView) */}
      {!hideReasoning && data.overallReasoning && (
        <div className="mt-4">
          <button
            onClick={() => setShowReasoning(!showReasoning)}
            className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors text-left"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-slate-700">
              <Sparkles className="w-4 h-4 text-blue-500" />
              AI Reasoning
            </span>
            {showReasoning ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
          </button>
          {showReasoning && (
            <div className="border border-t-0 border-slate-200 rounded-b-lg px-4 py-3 bg-white">
              <div className="text-sm text-slate-700 leading-relaxed prose prose-sm max-w-none prose-p:my-2 prose-headings:text-slate-800 prose-strong:text-slate-900">
                <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{data.overallReasoning}</Markdown>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Public note preview — what gets posted to FreshService for the assignee. */}
      {!hideAgentBriefing && <AgentBriefingPreview recommendation={data} decision={decision} />}
    </div>
  );
}

/**
 * @param {object}   props
 * @param {number}   props.ticketId             Ticket to analyze (drives the default trigger stream URL)
 * @param {Function} [props.onComplete]         Called after the user makes a decision via the embedded RecommendationCards
 * @param {Function} [props.onBack]             Renders a "Back to queue" link in the header when provided
 * @param {string}   [props.streamPath]         Override the SSE endpoint. Use for run-now (an already-claimed
 *                                              queued run) — pass `/assignment/runs/{runId}/run-now?stream=true`.
 *                                              When omitted, defaults to `/assignment/trigger/{ticketId}?stream=true`.
 * @param {boolean}  [props.skipExistingCheck]  Skip the "do we already have a recent run for this ticket?" probe
 *                                              and start streaming immediately. Used for run-now where the run
 *                                              has already been claimed server-side and we always want the live feed.
 * @param {number}   [props.initialRunId]       Seed the runId state so the "Run #N" badge renders before the
 *                                              first run_started event arrives. Used for run-now.
 */
export default function LivePipelineView({ ticketId, onComplete, onBack, streamPath, skipExistingCheck = false, initialRunId = null }) {
  const [status, setStatus] = useState('loading');
  const [events, setEvents] = useState([]);
  const [toolCalls, setToolCalls] = useState([]);
  const [recommendation, setRecommendation] = useState(null);
  const [runId, setRunId] = useState(initialRunId);
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

    // Run-now path: the queued run was already claimed server-side. Skip the
    // "is there a recent run?" probe (it would race the just-claimed run and
    // possibly short-circuit into a stale completed view) and stream immediately.
    if (skipExistingCheck) {
      startStream();
      return () => { cancelled = true; };
    }

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

    let currentStatus = 'connecting';
    let currentRecommendation = null;
    let currentRunId = initialRunId;

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
        currentStatus = 'running';
        setStatus('running');

        await readSSEStream(streamPath || `/assignment/trigger/${ticketId}?stream=true`, {
          signal: abortController.signal,
          onEvent: handleEvent,
        });
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
          {showExistingRun && existingRun?.status !== 'queued' && (
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
