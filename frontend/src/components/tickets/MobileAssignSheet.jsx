import { useEffect, useMemo, useRef, useState } from 'react';
import { Drawer } from 'vaul';
import { Check, Loader2, Search, Sparkles, UserRound, X } from 'lucide-react';
import { PersonAvatar, TagChip, ticketCategoryLabels } from './ticketUi';
import { OverridePromptToast, useOverridePrompt } from './OverridePrompt';
import { assignmentAPI, ticketsAPI } from '../../services/api';

/**
 * Touch-first assignment for the mobile Tickets queue: a bottom sheet (vaul)
 * that leads with the ranked AI candidates (one-tap Approve), shows the current
 * assignee, and offers a big-tap member list. The search field is deliberately
 * NOT auto-focused, so the on-screen keyboard only appears when the user taps
 * it — the queue-row picker on desktop pops a keyboard, which felt crude on a
 * phone. Mirrors AssigneePicker's write paths (assign / decide / triage).
 */
export default function MobileAssignSheet({
  ticket,
  open,
  onClose,
  technicians = [],
  assignFn = null, // FS write-back with confirmation (FS-born tickets)
  onAssigned,
  canReview = false,
  canSeeAi = false, // read/act split (QA 08-19 #2): non-reviewers SEE the suggestion, read-only
  onAiAssign = null, // open the full "Review…" AI modal
}) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedAiTechId, setSelectedAiTechId] = useState(null);
  const searchRef = useRef(null);
  // Correction feedback loop: manual pick over a completed AI decision — same
  // one-click "why the override?" toast as the desktop picker.
  const overridePrompt = useOverridePrompt();

  const ticketId = ticket?.id;
  const value = ticket?.assignedTechId ?? null;
  const ai = ticket?.ai || null;
  const ticketOrigin = ticket?.origin || null;

  // Prefer the row's own assignee object so deactivated / FS-only agents still
  // resolve by name (they're absent from the active technicians list).
  const activeMatch = technicians.find((t) => t.id === value) || null;
  const current = activeMatch || (value != null ? ticket?.assignedTech || null : null);
  const currentReadOnly = Boolean(current) && !activeMatch;

  const aiCandidates = useMemo(() => {
    if (ai?.state !== 'suggested') return [];
    if (Array.isArray(ai.candidates) && ai.candidates.length) return ai.candidates.filter((c) => c.techId != null);
    return ai.techId != null ? [{ techId: ai.techId, techName: ai.techName, score: ai.score }] : [];
  }, [ai]);

  useEffect(() => {
    if (open) { setQuery(''); setSelectedAiTechId(aiCandidates[0]?.techId ?? null); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ticketId, ai?.runId]);

  const members = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Local agents can't hold an FS-born ticket (server rejects it) — hide them.
    let list = ticketOrigin === 'freshservice' ? technicians.filter((t) => t.origin !== 'local') : technicians;
    if (q) list = list.filter((t) => t.name.toLowerCase().includes(q));
    return list;
  }, [technicians, query, ticketOrigin]);

  const done = (techId) => { onClose?.(); onAssigned?.(techId); };

  const assign = async (techId) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await (assignFn ? assignFn(techId) : ticketsAPI.assign(ticketId, techId));
      // {success, data} envelope — aiOverride flags a manual pick that
      // overrode a completed AI decision (native assign and FS write-back).
      overridePrompt.maybePrompt(res, ticketId, techId);
      done(techId);
    } catch { /* cancelled or failed — the silent refresh shows the true state */ }
    setBusy(false);
  };

  const approve = async () => {
    const chosen = selectedAiTechId ?? ai?.techId;
    if (busy || !ai?.runId || !chosen) return;
    setBusy(true);
    try {
      await assignmentAPI.decide(ai.runId, { decision: 'approved', assignedTechId: chosen });
      done(chosen);
    } catch { /* stale suggestion — refresh shows the true state */ }
    setBusy(false);
  };

  const letAiAssign = async () => {
    if (busy) return;
    if (onAiAssign) { onClose?.(); onAiAssign(); return; }
    setBusy(true);
    try { await ticketsAPI.triage(ticketId); done(value); } catch { /* non-fatal */ }
    setBusy(false);
  };

  // Read/act split (QA 08-19 #2): reviewers get the actionable candidate card
  // (radio + Approve → reviewer-gated decide endpoint); other members get a
  // read-only info card — same facts, nothing clickable that could 403.
  const seeAi = canReview || canSeeAi;
  const showAiCard = canReview && ai?.state === 'suggested' && !value && aiCandidates.length > 0;
  const showAiInfoCard = !canReview && seeAi && ai?.state === 'suggested' && !value && aiCandidates.length > 0;
  const showAiPending = seeAi && (ai?.state === 'analyzing' || ai?.state === 'queued');

  return (
    <>
      {/* Outside the drawer portal so the toast survives the sheet closing
          right after a successful assign (the component stays mounted). */}
      <OverridePromptToast
        prompt={overridePrompt.prompt}
        state={overridePrompt.state}
        onReason={overridePrompt.sendReason}
        onDismiss={overridePrompt.dismiss}
      />
      <Drawer.Root open={open} onOpenChange={(o) => { if (!o) onClose?.(); }} shouldScaleBackground>
        <Drawer.Portal>
          <Drawer.Overlay className="md:hidden fixed inset-0 z-[70] bg-slate-900/40" />
          <Drawer.Content className="md:hidden fixed inset-x-0 bottom-0 z-[70] flex flex-col rounded-t-2xl bg-card shadow-soft max-h-[90vh] focus:outline-none">
            <Drawer.Title className="sr-only">Assign ticket</Drawer.Title>
            <div className="pt-2.5 pb-1 flex justify-center shrink-0" aria-hidden="true">
              <span className="h-1.5 w-10 rounded-full bg-muted-foreground/40" />
            </div>

            {/* Ticket context */}
            <div className="px-4 pb-2 shrink-0 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[11px] font-semibold text-muted-foreground/75">{ticket?.displayRef}</p>
                <p className="text-sm font-semibold text-foreground line-clamp-2">{ticket?.subject || '(no subject)'}</p>
                {/* Context for the assignment decision (gap plan 2 P1.2) */}
                {(() => {
                  const { category, subcategory } = ticketCategoryLabels(ticket || {});
                  const label = subcategory || category;
                  const tags = ticket?.tags || [];
                  if (!label && tags.length === 0) return null;
                  return (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {label && <span className="text-[11px] text-muted-foreground truncate max-w-[60%]">{label}</span>}
                      {tags.slice(0, 3).map((tag) => <TagChip key={tag.id} tag={tag} size="xs" />)}
                      {tags.length > 3 && <span className="text-[10px] text-muted-foreground/75">+{tags.length - 3}</span>}
                    </div>
                  );
                })()}
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="tp-focus-ring shrink-0 h-8 w-8 rounded-full inline-flex items-center justify-center text-muted-foreground/75 hover:bg-muted"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <div className="overflow-y-auto settings-scrollbar px-4 pb-2">
              {/* Current assignee */}
              {current && (
                <div className="mb-2 flex items-center gap-2.5 rounded-xl border border-border bg-muted/50 px-3 py-2.5">
                  <PersonAvatar name={current.name} photoUrl={current.photoUrl} size="h-9 w-9" textSize="text-xs" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75">Currently assigned</span>
                    <span className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-foreground truncate">{current.name}</span>
                      {currentReadOnly && (
                        <span className="flex-shrink-0 text-[8px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200">read-only</span>
                      )}
                    </span>
                  </span>
                  <button
                    onClick={() => assign(null)}
                    disabled={busy}
                    className="tp-focus-ring shrink-0 text-xs font-medium text-muted-foreground px-2.5 py-2 rounded-lg hover:bg-muted disabled:opacity-60"
                  >
                  Unassign
                  </button>
                </div>
              )}

              {/* AI ranked candidates */}
              {showAiCard && (
                <div className="mb-2 rounded-xl border border-indigo-200 dark:border-indigo-500/30 bg-gradient-to-br from-indigo-50 dark:from-indigo-500/15 to-violet-50/60 p-2.5">
                  <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-indigo-500 mb-1.5">
                    <Sparkles className="w-3 h-3" aria-hidden="true" /> AI suggests
                  </p>
                  <div role="radiogroup" aria-label="AI candidates" className="space-y-1">
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
                          className={`tp-focus-ring w-full flex items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors ${selected ? 'bg-card ring-1 ring-indigo-300 dark:ring-indigo-500/40' : 'active:bg-card/70'}`}
                        >
                          <span className={`flex-shrink-0 h-4 w-4 rounded-full border-[1.5px] inline-flex items-center justify-center ${selected ? 'border-indigo-500' : 'border-input'}`} aria-hidden="true">
                            {selected && <span className="h-2 w-2 rounded-full bg-indigo-500" />}
                          </span>
                          <PersonAvatar name={c.techName || '?'} photoUrl={photoUrl} size="h-8 w-8" textSize="text-[10px]" />
                          <span className="text-sm font-medium text-foreground truncate flex-1">{c.techName || 'Unknown'}</span>
                          {pct !== null && <span className="text-xs tabular-nums text-muted-foreground flex-shrink-0">{pct}%</span>}
                          {i === 0 && <span className="text-[8px] font-bold uppercase tracking-wider bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200 px-1 rounded flex-shrink-0">AI</span>}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    onClick={approve}
                    disabled={busy || !selectedAiTechId}
                    className="tp-focus-ring mt-2 w-full min-h-[44px] rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Check className="w-4 h-4" aria-hidden="true" />}
                  Approve
                  </button>
                </div>
              )}

              {/* Read-only AI card for non-reviewers: same suggestion facts, no
                  radios, no Approve — the decision belongs to a reviewer. */}
              {showAiInfoCard && (
                <div
                  className="mb-2 rounded-xl border border-indigo-200 dark:border-indigo-500/30 bg-gradient-to-br from-indigo-50 dark:from-indigo-500/15 to-violet-50/60 p-2.5"
                  title="AI suggestion — waiting on a reviewer's approval"
                >
                  <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-indigo-500 mb-1.5">
                    <Sparkles className="w-3 h-3" aria-hidden="true" /> AI suggests
                  </p>
                  <div className="space-y-1">
                    {aiCandidates.map((c, i) => {
                      const pct = typeof c.score === 'number' ? Math.round(c.score * 100) : null;
                      const photoUrl = technicians.find((t) => t.id === c.techId)?.photoUrl;
                      return (
                        <div key={c.techId ?? i} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
                          <PersonAvatar name={c.techName || '?'} photoUrl={photoUrl} size="h-8 w-8" textSize="text-[10px]" />
                          <span className="text-sm font-medium text-foreground truncate flex-1">{c.techName || 'Unknown'}</span>
                          {pct !== null && <span className="text-xs tabular-nums text-muted-foreground flex-shrink-0">{pct}%</span>}
                          {i === 0 && <span className="text-[8px] font-bold uppercase tracking-wider bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200 px-1 rounded flex-shrink-0">AI</span>}
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-[11px] font-medium text-indigo-500">
                    Waiting on a reviewer&rsquo;s approval — you can still assign someone below.
                  </p>
                </div>
              )}

              {showAiPending && (canReview && onAiAssign ? (
                <button
                  onClick={() => { onClose?.(); onAiAssign(); }}
                  className="mb-2 w-full flex items-center gap-2 rounded-xl border border-indigo-100 dark:border-indigo-500/20 bg-indigo-50/60 dark:bg-indigo-500/10 px-3 py-2.5 text-left"
                >
                  {ai.state === 'analyzing'
                    ? <Loader2 className="w-4 h-4 text-indigo-500 animate-spin flex-shrink-0" aria-hidden="true" />
                    : <Sparkles className="w-4 h-4 text-indigo-400 flex-shrink-0" aria-hidden="true" />}
                  <span className="text-sm font-medium text-indigo-700 dark:text-indigo-200">
                    {ai.state === 'analyzing' ? 'AI is analyzing this ticket…' : 'AI run queued for business hours'}
                  </span>
                </button>
              ) : (
                <div className="mb-2 w-full flex items-center gap-2 rounded-xl border border-indigo-100 dark:border-indigo-500/20 bg-indigo-50/60 dark:bg-indigo-500/10 px-3 py-2.5 text-left">
                  {ai.state === 'analyzing'
                    ? <Loader2 className="w-4 h-4 text-indigo-500 animate-spin flex-shrink-0" aria-hidden="true" />
                    : <Sparkles className="w-4 h-4 text-indigo-400 flex-shrink-0" aria-hidden="true" />}
                  <span className="text-sm font-medium text-indigo-700 dark:text-indigo-200">
                    {ai.state === 'analyzing' ? 'AI is analyzing this ticket…' : 'AI run queued for business hours'}
                  </span>
                </div>
              ))}

              {/* Search — no autoFocus, so the keyboard only appears when tapped */}
              <div className="relative mb-1.5">
                <Search className="w-4 h-4 text-muted-foreground/50 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search members…"
                  aria-label="Search members"
                  className="tp-focus-ring w-full pl-9 pr-3 min-h-[44px] text-sm bg-muted/50 border border-border rounded-xl placeholder:text-muted-foreground/75"
                />
              </div>

              <div className="pb-1">
                <button
                  onClick={() => assign(null)}
                  className="tp-focus-ring w-full flex items-center gap-2.5 px-2 py-2.5 rounded-lg active:bg-muted text-left"
                >
                  <span className="h-8 w-8 rounded-full border-[1.5px] border-dashed border-input text-muted-foreground/75 inline-flex items-center justify-center flex-shrink-0">
                    <UserRound className="w-4 h-4" aria-hidden="true" />
                  </span>
                  <span className="text-sm text-muted-foreground italic flex-1">Unassigned</span>
                  {value === null && <Check className="w-4 h-4 text-blue-600 dark:text-blue-300 flex-shrink-0" aria-hidden="true" />}
                </button>
                {members.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => assign(t.id)}
                    disabled={busy}
                    className={`tp-focus-ring w-full flex items-center gap-2.5 px-2 py-2.5 rounded-lg text-left active:bg-blue-50 dark:active:bg-blue-500/15 disabled:opacity-60 ${t.id === value ? 'bg-blue-50/70 dark:bg-blue-500/10' : ''}`}
                  >
                    <PersonAvatar name={t.name} photoUrl={t.photoUrl} size="h-8 w-8" textSize="text-[10px]" />
                    <span className="text-sm text-foreground/85 truncate flex-1">{t.name}</span>
                    {t.origin === 'local' && (
                      <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-300 flex-shrink-0">Local</span>
                    )}
                    {t.id === value && <Check className="w-4 h-4 text-blue-600 dark:text-blue-300 flex-shrink-0" aria-hidden="true" />}
                  </button>
                ))}
                {members.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground/75">No member matches “{query}”.</p>}
              </div>
            </div>

            {/* Footer: AI actions */}
            {canReview && (
              <div className="border-t border-border/60 px-4 py-2.5 shrink-0 flex items-center gap-2 pb-safe">
                <button
                  onClick={letAiAssign}
                  disabled={busy}
                  className="tp-focus-ring flex-1 min-h-[44px] rounded-xl border border-indigo-200 dark:border-indigo-500/30 text-indigo-700 dark:text-indigo-200 text-sm font-semibold inline-flex items-center justify-center gap-1.5 active:bg-indigo-50 dark:active:bg-indigo-500/15 disabled:opacity-60"
                >
                  <Sparkles className="w-4 h-4" aria-hidden="true" /> Let AI assign
                </button>
                {onAiAssign && (
                  <button
                    onClick={() => { onClose?.(); onAiAssign(); }}
                    className="tp-focus-ring flex-1 min-h-[44px] rounded-xl border border-border text-muted-foreground text-sm font-medium active:bg-muted/50"
                  >
                  Review…
                  </button>
                )}
              </div>
            )}
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </>
  );
}
