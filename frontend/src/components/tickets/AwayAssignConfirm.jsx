import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Palmtree } from 'lucide-react';
import { awaySentence } from '../../utils/away';

/**
 * "Sam is away" before a ticket goes to him (Vahid, 31 Oct 2026): people
 * assigned tickets to colleagues who were off without knowing it. Shown only
 * when the person has a full day off at the next working moment (see
 * utils/away.js); assigning anyway is one click, so it informs, never blocks.
 *
 * `people` = [{ name, away }] — one for a single ticket, or the person picked
 * for several tickets at once (bulk assign says how many).
 */
export default function AwayAssignConfirm({ open, people = [], ticketCount = 1, onConfirm, onCancel }) {
  const confirmRef = useRef(null);
  const cancelRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    // "Pick someone else" is the primary button and has the focus: Enter does not assign by accident (UI Design).
    setTimeout(() => cancelRef.current?.focus(), 0);
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel?.(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onCancel]);
  if (!open || !people.length || typeof document === 'undefined') return null;
  const [first] = people;
  const who = String(first.name || 'This person').trim().split(/\s+/)[0];
  const title = people.length === 1 ? `${who} is away` : `${people.length} people are away`;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center p-4 min-[640px]:items-center" role="alertdialog" aria-modal="true" aria-labelledby="away-title" aria-describedby="away-body" data-testid="away-assign-confirm">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-[2px]" onClick={onCancel} aria-hidden="true" />
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-soft motion-on:animate-scaleIn">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-100">
            <Palmtree className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h4 id="away-title" className="text-base font-bold text-foreground">{title}</h4>
            <div id="away-body" className="mt-1 space-y-1 text-sm text-foreground/85">
              {people.map((p) => <p key={p.name}>{awaySentence(p.name, p.away)}</p>)}
            </div>
            <p className="mt-2 text-[13px] text-muted-foreground">
              {ticketCount > 1 ? `Assign these ${ticketCount} tickets to ${who} anyway?` : 'Assign this ticket anyway?'}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={onCancel} className="tp-focus-ring rounded-[10px] bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:bg-blue-700">
            Pick someone else
          </button>
          <button ref={confirmRef} type="button" onClick={onConfirm} className="tp-focus-ring rounded-[10px] border border-border bg-card px-3.5 py-2 text-[13px] font-semibold text-foreground hover:bg-muted">
            Assign anyway
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
