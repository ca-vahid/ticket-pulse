import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Loader2, Search, Sparkles, UserRound } from 'lucide-react';
import { PersonAvatar, UnassignedBadge } from './ticketUi';
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
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiState, setAiState] = useState(null); // 'queued' | null
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  // The panel renders in a body portal (fixed), so queue-row overflow-hidden
  // cards can't clip it — position is computed from the trigger rect.
  const [panelPos, setPanelPos] = useState(null); // { left, top } | { left, bottom }

  const current = technicians.find((t) => t.id === value) || null;

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
    setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
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
      await (assignFn ? assignFn(techId) : ticketsAPI.assign(ticketId, techId));
      setOpen(false);
      onAssigned?.(techId);
    } catch { /* cancelled or failed — the silent refresh shows the true state */ }
    setBusy(false);
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

  const approveSuggestion = async () => {
    if (busy || !aiSuggestion?.runId) return;
    setBusy(true);
    try {
      await assignmentAPI.decide(aiSuggestion.runId, { decision: 'approved', assignedTechId: aiSuggestion.techId || undefined });
      setOpen(false);
      onAssigned?.(aiSuggestion.techId ?? value);
    } catch { /* stale suggestion — the refresh shows the true state */ }
    setBusy(false);
  };

  const suggestedTech = aiSuggestion?.state === 'suggested'
    ? technicians.find((t) => t.id === aiSuggestion.techId) || null
    : null;

  const sm = size === 'sm';

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
        className={`tp-focus-ring group flex items-center gap-1.5 min-w-0 w-full rounded-lg border transition-colors text-left ${
          sm ? 'px-1.5 py-1' : 'px-2.5 py-1.5'
        } ${open ? 'border-blue-300 bg-white' : 'border-transparent hover:border-slate-200 hover:bg-white'} disabled:cursor-not-allowed`}
      >
        {busy ? (
          <Loader2 className={`${sm ? 'w-4 h-4' : 'w-5 h-5'} animate-spin text-slate-400 flex-shrink-0`} aria-hidden="true" />
        ) : current ? (
          <>
            <PersonAvatar name={current.name} photoUrl={current.photoUrl} size={sm ? 'h-5 w-5' : 'h-7 w-7'} textSize={sm ? 'text-[8px]' : 'text-[10px]'} />
            <span className={`${sm ? 'text-xs' : 'text-sm'} text-slate-700 truncate`}>{current.name}</span>
          </>
        ) : aiSuggestion?.state === 'suggested' ? (
          // Unassigned but the AI has a pending pick — surface it at a glance.
          <>
            <span className={`${sm ? 'h-5 w-5' : 'h-7 w-7'} rounded-full border-[1.5px] border-dashed border-indigo-300 bg-indigo-50 text-indigo-500 inline-flex items-center justify-center flex-shrink-0`}>
              <Sparkles className={sm ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5'} aria-hidden="true" />
            </span>
            <span className={`${sm ? 'text-xs' : 'text-sm'} font-semibold text-indigo-700 truncate`} title={`AI suggests ${aiSuggestion.techName || 'a technician'}`}>
              AI: {aiSuggestion.techName || 'suggestion'}
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
            <div className="mb-1.5 rounded-lg border border-indigo-200 bg-gradient-to-r from-indigo-50 to-violet-50/60 p-2">
              <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-indigo-500 mb-1">
                <Sparkles className="w-3 h-3" aria-hidden="true" /> AI suggests
              </p>
              <div className="flex items-center gap-2 min-w-0">
                <PersonAvatar name={aiSuggestion.techName || '?'} photoUrl={suggestedTech?.photoUrl} size="h-7 w-7" textSize="text-[10px]" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-800 truncate">{aiSuggestion.techName || 'Unknown'}</span>
                  {typeof aiSuggestion.score === 'number' && (
                    <span className="block text-[10px] text-indigo-500 font-medium">{Math.round(aiSuggestion.score * 100)}% match</span>
                  )}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  onClick={approveSuggestion}
                  disabled={busy}
                  className="tp-focus-ring flex-1 px-2 py-1.5 rounded-md bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 disabled:opacity-60"
                >
                  Approve
                </button>
                {onAiAssign && (
                  <button
                    onClick={() => { setOpen(false); onAiAssign(); }}
                    className="tp-focus-ring px-2 py-1.5 rounded-md border border-indigo-200 text-indigo-700 text-xs font-medium hover:bg-indigo-100/60"
                  >
                    Review…
                  </button>
                )}
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
    </span>
  );
}
