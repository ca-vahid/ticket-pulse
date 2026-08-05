import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Loader2, Search, Sparkles, UserRound, X } from 'lucide-react';
import { AgentFirstName, PersonAvatar, UnassignedBadge } from './ticketUi';
import { assignmentAPI, ticketsAPI } from '../../services/api';

/**
 * Rich assignee dropdown shared by the queue rows, peek drawer, and detail
 * sidebar: avatars everywhere, type-to-filter, an attention-grabbing
 * unassigned state, and an "AI assign" action. When the parent provides
 * `onAiAssign`, that opens the live pipeline modal (watch the run, approve
 * inline); otherwise it falls back to the fire-and-forget triage trigger.
 * A pending pipeline suggestion (`aiSuggestion`) renders as a first-class
 * section with one-click Approve, so review-mode recommendations are
 * actionable right where assignment happens.
 */
export default function AssigneePicker({
  ticketId,
  value = null, // assignedTechId | null
  technicians = [],
  onAssigned, // called after a successful change (or AI trigger)
  assignFn = null, // override the write (e.g. FS write-back with confirmation)
  disabled = false,
  size = 'md', // 'sm' (queue rows) | 'md' (panels)
  showAi = true,
  align = 'left',
  onAiAssign = null, // open the live AI-assignment modal instead of blind-queueing
  aiSuggestion = null, // { runId, state: 'suggested'|'analyzing'|'queued', techId, techName, score }
  ticketOrigin = null, // 'ticketpulse' | 'freshservice' — hides local agents on FS-born tickets
  currentTech = null, // the ticket's own assignee object {id,name,photoUrl,isActive,origin} — used when the assignee isn't in the active team list (deactivated / FS-only agents)
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiState, setAiState] = useState(null); // 'queued' | null
  // Correction feedback loop: the manual pick overrode a completed AI decision
  // — ask (one click, skippable) why, so the assignment LLM can learn.
  const [overridePrompt, setOverridePrompt] = useState(null); // { techId } | null
  const [overrideState, setOverrideState] = useState(null); // 'sent' | null
  const [selectedAiTechId, setSelectedAiTechId] = useState(null); // which AI candidate is picked for Approve
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  // The panel renders in a body portal (fixed), so queue-row overflow-hidden
  // cards can't clip it — position is computed from the trigger rect.
  const [panelPos, setPanelPos] = useState(null); // { left, top } | { left, bottom }

  // Prefer the active-team match; fall back to the ticket's own assignee object
  // so an assignee who's deactivated in Ticket Pulse (but still active in
  // FreshService — e.g. an external group we triage for) still renders by name
  // instead of collapsing to "unassigned" or an AI suggestion.
  const activeMatch = technicians.find((t) => t.id === value) || null;
  const current = activeMatch || (value != null ? currentTech : null);
  // The assignee exists but isn't an assignable active member: show them, tag
  // as read-only (they can only be (re)assigned in FreshService).
  const currentReadOnly = Boolean(current) && !activeMatch;

  const placePanel = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const PANEL_W = 256; // w-64
    const left = align === 'right' ? Math.max(8, rect.right - PANEL_W) : Math.min(rect.left, window.innerWidth - PANEL_W - 8);
    const spaceBelow = window.innerHeight - rect.bottom;
    // Flip upward when the trigger sits low (bottom rows) — the panel can
    // reach ~480px with the AI section.
    if (spaceBelow < 420 && rect.top > spaceBelow) {
      setPanelPos({ left, bottom: window.innerHeight - rect.top + 4 });
    } else {
      setPanelPos({ left, top: rect.bottom + 4 });
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (rootRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    const onMove = () => placePanel();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    // preventScroll: focusing must not scroll clipped ancestors (queue card).
    // Only auto-focus on fine pointers (mouse) — on touch it pops the on-screen
    // keyboard the moment the picker opens, which feels crude. Touch users tap
    // the search field when they actually want it.
    if (window.matchMedia?.('(pointer: fine)')?.matches) {
      setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
    }
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useLayoutEffect(() => { if (open) placePanel(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [open]);

  useEffect(() => { if (!open) { setQuery(''); setPanelPos(null); } }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Local agents have no FreshService license — they can never be assigned an
    // FS-born ticket (the server rejects it too). Hide them on those tickets.
    let list = ticketOrigin === 'freshservice'
      ? technicians.filter((t) => t.origin !== 'local')
      : technicians;
    if (q) list = list.filter((t) => t.name.toLowerCase().includes(q));
    return list;
  }, [technicians, query, ticketOrigin]);

  const assign = async (techId) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await (assignFn ? assignFn(techId) : ticketsAPI.assign(ticketId, techId));
      setOpen(false);
      // The interceptor unwraps to the {success, data} envelope; the assign
      // payload flags manual picks that override a completed AI decision.
      if (techId != null && res?.data?.aiOverride) setOverridePrompt({ techId });
      onAssigned?.(techId);
    } catch { /* cancelled or failed — the silent refresh shows the true state */ }
    setBusy(false);
  };

  // Auto-dismiss the override-reason prompt — it's an optional nicety, never a
  // gate on the assignment (which already went through).
  useEffect(() => {
    if (!overridePrompt || overrideState === 'sent') return undefined;
    const timer = setTimeout(() => { setOverridePrompt(null); setOverrideState(null); }, 15000);
    return () => clearTimeout(timer);
  }, [overridePrompt, overrideState]);

  const sendOverrideReason = async (reasonCode) => {
    if (!overridePrompt || overrideState === 'sent') return;
    const techId = overridePrompt.techId;
    setOverrideState('sent');
    try {
      await assignmentAPI.recordOverrideReason(ticketId, { toTechnicianId: techId, reasonCode });
    } catch { /* best-effort — the assignment itself already succeeded */ }
    setTimeout(() => { setOverridePrompt(null); setOverrideState(null); }, 1800);
  };

  const aiAssign = async () => {
    if (busy) return;
    if (onAiAssign) { setOpen(false); onAiAssign(); return; }
    setBusy(true);
    try {
      await ticketsAPI.triage(ticketId);
      setAiState('queued');
      setTimeout(() => { setAiState(null); setOpen(false); }, 1800);
      onAssigned?.(value);
    } catch { /* non-fatal */ }
    setBusy(false);
  };

  // Ranked AI candidates (top few) for the quick-assign card — falls back to the
  // single top suggestion for older payloads without the candidates array.
  const aiCandidates = useMemo(() => {
    if (aiSuggestion?.state !== 'suggested') return [];
    if (Array.isArray(aiSuggestion.candidates) && aiSuggestion.candidates.length) {
      return aiSuggestion.candidates.filter((c) => c.techId != null);
    }
    return aiSuggestion.techId != null
      ? [{ techId: aiSuggestion.techId, techName: aiSuggestion.techName, score: aiSuggestion.score }]
      : [];
  }, [aiSuggestion]);

  // Default the selection to the top pick whenever the suggestion (or open) changes.
  useEffect(() => {
    setSelectedAiTechId(aiCandidates[0]?.techId ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiSuggestion?.runId, open]);

  const approveSuggestion = async (techId) => {
    const chosen = techId ?? selectedAiTechId ?? aiSuggestion?.techId;
    if (busy || !aiSuggestion?.runId || !chosen) return;
    setBusy(true);
    try {
      await assignmentAPI.decide(aiSuggestion.runId, { decision: 'approved', assignedTechId: chosen });
      setOpen(false);
      onAssigned?.(chosen ?? value);
    } catch { /* stale suggestion — the refresh shows the true state */ }
    setBusy(false);
  };

  // Dismiss the AI proposal without assigning — the ticket stays unassigned and
  // drops out of the "Awaiting AI approval" worklist.
  const rejectSuggestion = async () => {
    if (busy || !aiSuggestion?.runId) return;
    setBusy(true);
    try {
      await assignmentAPI.decide(aiSuggestion.runId, { decision: 'rejected', decisionNote: 'Dismissed from the queue' });
      setOpen(false);
      onAssigned?.(value);
    } catch { /* stale — the refresh shows the true state */ }
    setBusy(false);
  };

  const sm = size === 'sm';
  // Unassigned + a pending AI pick = a "proposed" slot the coordinator must
  // decide on. Rendered as a dashed capsule so it never reads as a committed
  // assignee.
  const proposed = !busy && !current && aiSuggestion?.state === 'suggested';
  // The pipeline is deciding right now — the trigger becomes the "AI
  // choosing…" shimmer slot (the answer lands here). Opening the picker still
  // works, so a manual assignment can override the run at any time.
  const thinking = !busy && !current && aiSuggestion?.state === 'analyzing';
  const topPct = typeof aiSuggestion?.score === 'number' ? Math.round(aiSuggestion.score * 100) : null;

  return (
    <span
      ref={rootRef}
      className="relative inline-flex min-w-0 w-full"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={current ? `Assignee: ${current.name} — change` : 'Unassigned — assign a member'}
        className={`tp-focus-ring group flex items-center gap-1.5 min-w-0 w-full border transition-colors text-left ${
          proposed || thinking ? 'rounded-full' : 'rounded-lg'
        } ${sm ? 'px-1.5 py-1' : 'px-2.5 py-1.5'} ${
          open ? 'border-blue-300 bg-white'
            : proposed ? 'border-dashed border-violet-300 bg-violet-50/60 hover:bg-violet-50'
              : thinking ? 'tp-ai-think border-transparent'
                : 'border-transparent hover:border-slate-200 hover:bg-white'
        } disabled:cursor-not-allowed`}
      >
        {busy ? (
          <Loader2 className={`${sm ? 'w-4 h-4' : 'w-5 h-5'} animate-spin text-slate-400 flex-shrink-0`} aria-hidden="true" />
        ) : current ? (
          <>
            <PersonAvatar name={current.name} photoUrl={current.photoUrl} size={sm ? 'h-5 w-5' : 'h-7 w-7'} textSize={sm ? 'text-[8px]' : 'text-[10px]'} />
            {/* First-name-only below xl (tablet columns are narrow — QA 08-04);
                the full name stays in the tooltip + aria-label. */}
            <AgentFirstName name={current.name} className={`${sm ? 'text-xs' : 'text-sm'} text-slate-700`} />
            {currentReadOnly && (
              <span
                title="Assigned in FreshService — not an active Ticket Pulse member, so they can only be (re)assigned in FreshService."
                className="flex-shrink-0 text-[8px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded bg-amber-100 text-amber-700"
              >
                read-only
              </span>
            )}
          </>
        ) : thinking ? (
          <>
            <span
              className={`${sm ? 'h-5 w-5' : 'h-7 w-7'} rounded-full bg-violet-100 inline-flex items-center justify-center flex-shrink-0`}
              title="AI is choosing the best person for this ticket — assigning someone manually overrides the pick"
            >
              <Sparkles className={`${sm ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5'} text-violet-600 tp-ai-twinkle`} aria-hidden="true" />
            </span>
            <span className="flex flex-col min-w-0 leading-tight">
              <span className={`${sm ? 'text-[8px]' : 'text-[9px]'} font-bold uppercase tracking-wider text-violet-600`}>AI choosing…</span>
              <span className={`${sm ? 'text-xs' : 'text-sm'} italic text-slate-400 truncate`}>best person for this</span>
            </span>
          </>
        ) : proposed ? (
          // Unassigned + a pending AI pick — a dashed "proposed" slot awaiting a
          // human decision, visually distinct from a committed assignee.
          <>
            <span className="relative flex-shrink-0" title={`AI suggests ${aiSuggestion.techName || 'a technician'}${topPct !== null ? ` — ${topPct}% match` : ''} · awaiting your approval`}>
              <PersonAvatar
                name={aiSuggestion.techName || '?'}
                photoUrl={technicians.find((t) => t.id === aiSuggestion.techId)?.photoUrl}
                size={sm ? 'h-5 w-5' : 'h-7 w-7'}
                textSize={sm ? 'text-[8px]' : 'text-[10px]'}
              />
              <span className={`absolute -bottom-0.5 -right-0.5 ${sm ? 'h-2.5 w-2.5' : 'h-3 w-3'} rounded-full bg-violet-600 ring-2 ring-white inline-flex items-center justify-center`} aria-hidden="true">
                <Sparkles className="w-[7px] h-[7px] text-white" />
              </span>
            </span>
            <span className="flex flex-col min-w-0 leading-tight">
              <span className={`${sm ? 'text-[8px]' : 'text-[9px]'} font-bold uppercase tracking-wider text-violet-600`}>
                Suggested{topPct !== null ? ` · ${topPct}%` : ''}
              </span>
              {aiSuggestion.techName
                ? <AgentFirstName name={aiSuggestion.techName} className={`${sm ? 'text-xs' : 'text-sm'} font-semibold text-slate-800`} />
                : <span className={`${sm ? 'text-xs' : 'text-sm'} font-semibold text-slate-800 truncate`}>AI pick</span>}
            </span>
          </>
        ) : (
          <UnassignedBadge size={sm ? 'h-5 w-5' : 'h-7 w-7'} labelClass={sm ? 'text-xs' : 'text-sm'} variant={disabled ? 'muted' : 'interactive'} />
        )}
        {!disabled && (
          <ChevronDown className={`w-3.5 h-3.5 text-slate-300 group-hover:text-slate-400 ml-auto flex-shrink-0 ${open ? 'rotate-180' : ''} transition-transform`} aria-hidden="true" />
        )}
      </button>

      {open && panelPos && createPortal(
        <div
          ref={panelRef}
          role="listbox"
          aria-label="Choose assignee"
          className="fixed z-[60] w-64 tp-card rounded-xl shadow-soft p-1.5 animate-scaleIn"
          style={panelPos}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {aiSuggestion?.state === 'suggested' && !value && (
            <div className="mb-1.5 rounded-lg border border-violet-200 bg-gradient-to-r from-indigo-50 to-violet-50/60 p-2">
              <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-violet-600 mb-1.5">
                <Sparkles className="w-3 h-3 flex-shrink-0" aria-hidden="true" /> Awaiting your decision
                {aiCandidates.length > 1 && (
                  <span className="ml-auto text-[9px] font-semibold text-slate-400 normal-case tracking-normal">{aiCandidates.length} candidates</span>
                )}
              </p>
              <div role="radiogroup" aria-label="AI candidates" className="space-y-0.5">
                {aiCandidates.map((c, i) => {
                  const selected = selectedAiTechId === c.techId;
                  const pct = typeof c.score === 'number' ? Math.round(c.score * 100) : null;
                  const photoUrl = technicians.find((t) => t.id === c.techId)?.photoUrl;
                  return (
                    <button
                      key={c.techId ?? i}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setSelectedAiTechId(c.techId)}
                      className={`tp-focus-ring w-full flex items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors ${selected ? 'bg-white ring-1 ring-violet-300' : 'hover:bg-white/70'}`}
                    >
                      <span className={`flex-shrink-0 h-3.5 w-3.5 rounded-full border-[1.5px] inline-flex items-center justify-center ${selected ? 'border-violet-500' : 'border-slate-300'}`} aria-hidden="true">
                        {selected && <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />}
                      </span>
                      <PersonAvatar name={c.techName || '?'} photoUrl={photoUrl} size="h-6 w-6" textSize="text-[9px]" />
                      <span className="text-sm font-medium text-slate-800 truncate flex-1 min-w-0">{c.techName || 'Unknown'}</span>
                      {pct !== null && (
                        <span className="flex items-center gap-1.5 flex-shrink-0">
                          <span className="w-9 h-1.5 rounded-full bg-violet-100 overflow-hidden" aria-hidden="true">
                            <span className="block h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{ width: `${pct}%` }} />
                          </span>
                          <span className="text-[10px] font-bold tabular-nums text-violet-600 w-7 text-right">{pct}%</span>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  onClick={() => approveSuggestion(selectedAiTechId)}
                  disabled={busy || !selectedAiTechId}
                  className="tp-focus-ring flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 disabled:opacity-60"
                >
                  <Check className="w-3.5 h-3.5" aria-hidden="true" /> Approve
                </button>
                {onAiAssign && (
                  <button
                    onClick={() => { setOpen(false); onAiAssign(); }}
                    title="View the full AI analysis"
                    aria-label="View the full AI analysis"
                    className="tp-focus-ring h-8 w-8 inline-flex items-center justify-center rounded-md border border-indigo-200 text-indigo-600 hover:bg-indigo-100/60 flex-shrink-0"
                  >
                    <Sparkles className="w-4 h-4" aria-hidden="true" />
                  </button>
                )}
                <button
                  onClick={rejectSuggestion}
                  disabled={busy}
                  title="Dismiss this suggestion — leaves the ticket unassigned"
                  aria-label="Dismiss this suggestion"
                  className="tp-focus-ring h-8 w-8 inline-flex items-center justify-center rounded-md border border-slate-200 text-slate-400 hover:text-slate-600 hover:bg-slate-50 disabled:opacity-60 flex-shrink-0"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
          {(aiSuggestion?.state === 'analyzing' || aiSuggestion?.state === 'queued') && (
            <button
              onClick={onAiAssign ? () => { setOpen(false); onAiAssign(); } : undefined}
              className={`mb-1.5 w-full flex items-center gap-2 rounded-lg border border-indigo-100 bg-indigo-50/60 px-2 py-1.5 text-left ${onAiAssign ? 'tp-focus-ring hover:bg-indigo-100/60' : 'cursor-default'}`}
            >
              {aiSuggestion.state === 'analyzing'
                ? <Loader2 className="w-3.5 h-3.5 text-indigo-500 animate-spin flex-shrink-0" aria-hidden="true" />
                : <Sparkles className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" aria-hidden="true" />}
              <span className="text-xs font-medium text-indigo-700">
                {aiSuggestion.state === 'analyzing' ? 'AI is analyzing this ticket…' : 'AI run queued for business hours'}
              </span>
            </button>
          )}
          <div className="relative mb-1">
            <Search className="w-3.5 h-3.5 text-slate-300 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find member…"
              aria-label="Filter technicians"
              className="tp-focus-ring w-full pl-8 pr-2 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg placeholder:text-slate-400"
            />
          </div>

          <div className="max-h-64 overflow-y-auto settings-scrollbar">
            <button
              role="option"
              aria-selected={value === null}
              onClick={() => assign(null)}
              className="tp-focus-ring w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 text-left"
            >
              <span className="h-6 w-6 rounded-full border-[1.5px] border-dashed border-slate-300 text-slate-400 inline-flex items-center justify-center flex-shrink-0">
                <UserRound className="w-3 h-3" aria-hidden="true" />
              </span>
              <span className="text-sm text-slate-600 italic">Unassigned</span>
              {value === null && <Check className="w-3.5 h-3.5 text-blue-600 ml-auto" aria-hidden="true" />}
            </button>
            {filtered.map((t) => (
              <button
                key={t.id}
                role="option"
                aria-selected={t.id === value}
                onClick={() => assign(t.id)}
                className={`tp-focus-ring w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-blue-50 ${t.id === value ? 'bg-blue-50/70' : ''}`}
              >
                <PersonAvatar name={t.name} photoUrl={t.photoUrl} size="h-6 w-6" textSize="text-[9px]" />
                <span className="text-sm text-slate-700 truncate">{t.name}</span>
                {t.origin === 'local' && (
                  <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-100 text-blue-600 flex-shrink-0">Local</span>
                )}
                {t.id === value && <Check className="w-3.5 h-3.5 text-blue-600 ml-auto flex-shrink-0" aria-hidden="true" />}
              </button>
            ))}
            {filtered.length === 0 && <p className="px-2 py-2 text-xs text-slate-400">No member matches “{query}”.</p>}
          </div>

          {showAi && (
            <div className="border-t border-slate-100 mt-1 pt-1">
              <button
                onClick={aiAssign}
                disabled={busy || aiState === 'queued'}
                className="tp-focus-ring w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-indigo-50 disabled:opacity-70"
              >
                <span className="h-6 w-6 rounded-full bg-indigo-100 text-indigo-600 inline-flex items-center justify-center flex-shrink-0">
                  <Sparkles className="w-3 h-3" aria-hidden="true" />
                </span>
                {aiState === 'queued' ? (
                  <span className="text-sm font-medium text-indigo-700">Queued — recommendation lands in Review</span>
                ) : (
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-indigo-700">Let AI assign</span>
                    <span className="block text-[10px] text-slate-400 truncate">
                      {onAiAssign ? 'Watch the pipeline live & approve inline' : 'Runs the assignment pipeline for this ticket'}
                    </span>
                  </span>
                )}
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}

      {overridePrompt && createPortal(
        <div
          role="status"
          className="fixed bottom-4 right-4 z-[70] w-80 tp-card rounded-xl shadow-soft p-3 animate-slide-in-right"
        >
          {overrideState === 'sent' ? (
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-700">
              <Check className="w-4 h-4 flex-shrink-0" aria-hidden="true" /> Thanks — noted
            </p>
          ) : (
            <>
              <div className="flex items-start gap-2">
                <span className="h-6 w-6 rounded-full bg-violet-100 text-violet-600 inline-flex items-center justify-center flex-shrink-0">
                  <Sparkles className="w-3 h-3" aria-hidden="true" />
                </span>
                <p className="flex-1 min-w-0 text-sm font-medium text-slate-700 leading-tight">
                  Why the override?
                  <span className="block text-[11px] font-normal text-slate-400">helps the AI learn</span>
                </p>
                <button
                  onClick={() => { setOverridePrompt(null); setOverrideState(null); }}
                  aria-label="Skip — don't record a reason"
                  title="Skip"
                  className="tp-focus-ring h-6 w-6 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-50 flex-shrink-0"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[
                  ['wrong_skill', 'Wrong skill'],
                  ['load_balancing', 'Load balancing'],
                  ['availability', 'Availability'],
                  ['other', 'Other'],
                ].map(([code, label]) => (
                  <button
                    key={code}
                    onClick={() => sendOverrideReason(code)}
                    className="tp-focus-ring px-2.5 py-1 rounded-full border border-violet-200 bg-violet-50/60 text-xs font-medium text-violet-700 hover:bg-violet-100 transition-colors"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </span>
  );
}
