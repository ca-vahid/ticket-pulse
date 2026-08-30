import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Cloud, Loader2, Pencil, X } from 'lucide-react';
import RichTextEditor from './RichTextEditor';
import RequesterTypeahead, { toPickedRequester } from './RequesterTypeahead';

const truncate = (s, n = 70) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Edit ticket (Phase ET3, QA 08-27 #1): requester / subject / description in
 * one dialog, for BOTH origins.
 *  - TP-born: `onSubmit(payload, changes)` PATCHes only the changed fields.
 *  - FS-born: the parent routes the same payload through its FsSyncConfirm
 *    flow (write to FreshService first, verify, then mirror) — this dialog
 *    stays open underneath until FreshService confirms or the user cancels.
 * `onSubmit` must resolve on success (the parent closes the dialog) and
 * reject on failure; a rejection whose message is 'cancelled' (the confirm
 * dialog was dismissed) is silent, anything else renders inline.
 */
export default function EditTicketModal({ ticket, isNative, fsRef = null, onClose, onSubmit }) {
  const original = useMemo(() => ({
    requester: ticket?.requester ? toPickedRequester(ticket.requester) : null,
    subject: ticket?.subject || '',
    descriptionHtml: ticket?.description || ticket?.descriptionText || '',
    descriptionText: ticket?.descriptionText || '',
  }), [ticket]);

  const [requester, setRequester] = useState(original.requester);
  const [subject, setSubject] = useState(original.subject);
  const [description, setDescription] = useState(null); // {html,text} once the editor emits
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.(); };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const trimmedSubject = subject.trim();
  const requesterChanged = Boolean(requester) && (
    requester.id ? requester.id !== original.requester?.id
      : (requester.email || '').toLowerCase() !== (original.requester?.email || '').toLowerCase()
  );
  const subjectChanged = trimmedSubject !== original.subject;
  const descriptionChanged = description !== null && description.html !== original.descriptionHtml;
  const subjectInvalid = subjectChanged && trimmedSubject.length < 3;
  const hasChanges = requesterChanged || subjectChanged || descriptionChanged;

  const changes = useMemo(() => {
    const list = [];
    if (requesterChanged) list.push({ field: 'Requester', from: original.requester?.name || original.requester?.email || '—', to: requester.name || requester.email });
    if (subjectChanged) list.push({ field: 'Subject', from: original.subject || '—', to: trimmedSubject });
    if (descriptionChanged) list.push({ field: 'Description', from: truncate(original.descriptionText) || '—', to: truncate(description.text) || '—' });
    return list;
  }, [requesterChanged, subjectChanged, descriptionChanged, original, requester, trimmedSubject, description]);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!hasChanges || subjectInvalid || busy) return;
    const payload = {};
    if (requesterChanged) {
      if (requester.id) payload.requesterId = requester.id;
      else {
        payload.requesterEmail = requester.email;
        if (requester.name) payload.requesterName = requester.name;
      }
    }
    if (subjectChanged) payload.subject = trimmedSubject;
    if (descriptionChanged) payload.description = description.html;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(payload, changes);
    } catch (err) {
      if (err?.message !== 'cancelled') setError(err?.response?.data?.message || err?.message || 'Could not save the ticket');
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px] animate-fadeIn"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-ticket-title"
      onClick={busy ? undefined : onClose}
    >
      <form
        ref={dialogRef}
        tabIndex={-1}
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="tp-focus-ring flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl bg-card shadow-2xl animate-scaleIn"
      >
        <div className="flex items-center gap-2.5 border-b border-border/60 px-5 py-3.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-500/20">
            <Pencil className="h-4 w-4 text-blue-600 dark:text-blue-300" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 id="edit-ticket-title" className="text-sm font-bold text-foreground">Edit ticket {ticket?.displayRef ? <span className="font-mono text-muted-foreground/75">{ticket.displayRef}</span> : null}</h3>
            <p className="text-xs text-muted-foreground/75">Requester, subject and description. Everything else lives in the sidebar pickers.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="tp-focus-ring rounded p-1 text-muted-foreground/75 hover:text-muted-foreground">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 settings-scrollbar">
          {!isNative && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground" data-testid="edit-fs-owned-note">
              <Cloud className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-sky-500" aria-hidden="true" />
              <span>
                FreshService owns <span className="font-mono font-semibold">#{fsRef}</span> — saving writes these fields to FreshService first;
                Ticket Pulse only updates after FreshService confirms. The requester must already exist in FreshService.
              </span>
            </div>
          )}

          <div>
            <label htmlFor="edit-ticket-requester" className="block text-sm font-semibold text-foreground/85 mb-1.5">Requester</label>
            <RequesterTypeahead
              inputId="edit-ticket-requester"
              value={requester}
              onChange={setRequester}
              allowNewEmail={isNative}
              newEmailNote={<>New requester — “this email” will be created when you save.</>}
              placeholder="Search people by name or email…"
            />
            {!requester && <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-300">Pick a requester — a ticket always has one.</p>}
          </div>

          <div>
            <label htmlFor="edit-ticket-subject" className="block text-sm font-semibold text-foreground/85 mb-1.5">Subject</label>
            <input
              id="edit-ticket-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={500}
              className="tp-focus-ring w-full text-sm bg-card border border-input rounded-lg px-3 py-2.5 text-foreground"
            />
            {subjectInvalid && <p className="mt-1 text-[11px] text-red-600 dark:text-red-300">Subject needs at least 3 characters.</p>}
          </div>

          <div>
            <span className="block text-sm font-semibold text-foreground/85 mb-1.5">Description</span>
            <RichTextEditor
              value={original.descriptionHtml}
              onChange={({ html, text }) => setDescription({ html, text })}
              onSubmit={submit}
              minHeight={160}
              placeholder="Describe the request…"
              ariaLabel="Description"
              className="bg-card border-input"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 px-3 py-2" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600 dark:text-red-300" aria-hidden="true" />
              <span className="text-xs text-red-700 dark:text-red-200">{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-5 py-3.5">
          <p className="text-xs text-muted-foreground/75" data-testid="edit-ticket-summary">
            {hasChanges
              ? `${changes.length} change${changes.length === 1 ? '' : 's'}: ${changes.map((c) => c.field.toLowerCase()).join(', ')}`
              : 'No changes yet'}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="tp-focus-ring rounded-lg border border-border bg-card px-3.5 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/50">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!hasChanges || subjectInvalid || busy || !requester}
              className={`tp-focus-ring flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-50 ${
                isNative ? 'bg-blue-600 hover:bg-blue-700' : 'bg-slate-800 hover:bg-slate-700 dark:bg-slate-600 dark:hover:bg-slate-500'
              }`}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : (isNative ? null : <Cloud className="h-3.5 w-3.5 text-sky-300" aria-hidden="true" />)}
              {isNative ? 'Save changes' : 'Write to FreshService…'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
