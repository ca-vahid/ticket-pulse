import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Activity, Sparkles } from 'lucide-react';
import { knowledgeGrowthAPI } from '../../services/api';
import { labelClass, textareaClass } from './knowledgeUi';
import { MAX_PICKED, parseTicketRefs } from './knowledgeGrowthFormat';

/**
 * "Draft from solved tickets": a person names up to 12 resolved tickets
 * (TP-1234, #241406) and Auto-help drafts one article from how they were
 * solved. In-app dialog (never window.confirm), Escape closes, focus stays
 * inside; on success the draft opens in the editor.
 */
export default function DraftFromTicketsDialog({ open, onClose }) {
  const navigate = useNavigate();
  const titleId = useId();
  const fieldId = useId();
  const boxRef = useRef(null);
  const fieldRef = useRef(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const refs = parseTicketRefs(text);
  const tooMany = refs.length > MAX_PICKED;

  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement;
    setError(null);
    fieldRef.current?.focus();
    return () => { if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus(); };
  }, [open]);

  if (!open) return null;

  const close = () => { if (!busy) onClose?.(); };
  const submit = async (e) => {
    e.preventDefault();
    if (!refs.length || tooMany) return;
    setBusy(true);
    setError(null);
    try {
      const res = await knowledgeGrowthAPI.draftFromTickets({ ticketRefs: refs, kind: 'tickets' });
      const id = res?.data?.article?.id;
      setText('');
      onClose?.();
      if (id) navigate(`/knowledge/articles/${id}`, { state: { afterDraft: { used: res?.data?.used || null } } });
    } catch (err) {
      setError(err?.message || 'The draft could not be written');
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {
      const items = boxRef.current?.querySelectorAll('textarea, button:not([disabled])') || [];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-foreground/30 p-4 animate-fadeIn" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <form
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        onSubmit={submit}
        className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-soft animate-scaleIn"
        data-testid="draft-from-tickets-dialog"
      >
        <h2 id={titleId} className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" /> Draft an article from solved tickets
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Name up to {MAX_PICKED} resolved tickets about the same thing. The draft uses their verified solutions and public replies — never internal notes — with names, e-mail addresses and phone numbers taken out. It stays a draft until someone publishes it.
        </p>
        <label htmlFor={fieldId} className={`${labelClass} mt-4`}>Tickets</label>
        <textarea
          id={fieldId}
          ref={fieldRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="TP-1234, #241406, TP-1301"
          className={textareaClass}
          disabled={busy}
        />
        <p className={`mt-1 text-[11px] ${tooMany ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground/75'}`} aria-live="polite">
          {tooMany ? `That's more than ${MAX_PICKED} — keep the ones that best show the fix.` : refs.length ? `${refs.length} ticket${refs.length === 1 ? '' : 's'}: ${refs.join(', ')}` : 'Separate them with commas or spaces.'}
        </p>
        {error && <p className="mt-2 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
        {busy && (
          <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading the tickets and drafting… this can take up to a minute.
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={close} disabled={busy} className="tp-focus-ring inline-flex h-9 items-center rounded-lg px-3 text-sm text-foreground/85 hover:bg-muted disabled:opacity-50">
            Cancel
          </button>
          <button type="submit" disabled={busy || !refs.length || tooMany} className="tp-focus-ring inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {busy ? 'Drafting…' : 'Draft article'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
