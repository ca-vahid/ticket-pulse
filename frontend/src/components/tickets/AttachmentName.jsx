import { useEffect, useId, useRef, useState } from 'react';
import { Check, Loader2, Pencil, Undo2 } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import {
  attachmentName, canRevertName, composeName, nameFieldsFrom, namedAutomaticallyTitle, nameProblem, originalNameIfRenamed, splitExtension,
} from './attachmentNames';

const NOTE_MS = 8000;
const ILLEGAL_TYPED = /[\\/:*?"<>|]/;

/**
 * An attachment's name on the Attachments tab (4.4.08): the name people see
 * (the automatic vendor name when there is one), the original underneath in
 * muted text ("was INV-100234.pdf"), and for agents who can edit the ticket
 * "Edit name" and "Revert". Edit opens an inline box with the extension fixed;
 * Enter saves, Escape cancels. A short line confirms what changed.
 *
 * variant 'grid' (card body) or 'list' (row; the name opens the preview).
 */
export default function AttachmentName({ ticketId, a, variant = 'grid', canRename = false, onPreview = null, onChanged = null }) {
  const name = attachmentName(a);
  const original = originalNameIfRenamed(a);
  const auto = Boolean(original) && a?.nameSource === 'auto';
  const { ext } = splitExtension(a?.originalName || a?.fileName || name);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(null); // 'revert' | 'edit' | null
  const [note, setNote] = useState(null); // { tone: 'ok'|'error', text }
  const inputRef = useRef(null);
  const editButtonRef = useRef(null);
  const timerRef = useRef(null);
  const ids = useId();
  const inputId = `${ids}-name`;
  const hintId = `${ids}-hint`;
  const errorId = `${ids}-error`;

  useEffect(() => () => clearTimeout(timerRef.current), []);
  useEffect(() => {
    if (editing) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [editing]);

  const say = (tone, text) => {
    clearTimeout(timerRef.current);
    setNote({ tone, text });
    if (tone === 'ok') timerRef.current = setTimeout(() => setNote(null), NOTE_MS);
  };
  const focusEdit = () => setTimeout(() => editButtonRef.current?.focus(), 0);

  const startEdit = () => {
    // The box holds the name without its extension; the extension sits beside it, fixed.
    setDraft(ext && name.toLowerCase().endsWith(ext.toLowerCase()) ? name.slice(0, -ext.length) : name);
    setProblem(null);
    setNote(null);
    setEditing(true);
  };
  const cancel = () => {
    if (busy) return;
    setEditing(false);
    setProblem(null);
    focusEdit();
  };

  const save = async () => {
    if (busy) return;
    const why = nameProblem(draft);
    if (why) { setProblem(why); inputRef.current?.focus(); return; }
    const next = composeName(draft, ext);
    if (next === name) { setEditing(false); focusEdit(); return; }
    setBusy('edit');
    setProblem(null);
    try {
      const res = await ticketsAPI.renameAttachment(ticketId, a.id, { action: 'edit', name: next });
      const fields = nameFieldsFrom(res?.data, { displayName: next, nameSource: 'manual', nameDetails: a?.nameDetails ?? null });
      onChanged?.(a.id, fields, res?.data);
      setEditing(false);
      say('ok', `Renamed to ${fields.displayName || next}.`);
      focusEdit();
    } catch (err) {
      setProblem(`Could not save the name: ${String(err?.message || 'unknown error').replace(/[.!]+$/, '')}. Try again.`);
    } finally {
      setBusy(null);
    }
  };

  const revert = async () => {
    if (busy) return;
    const was = original;
    setBusy('revert');
    setNote(null);
    try {
      const res = await ticketsAPI.renameAttachment(ticketId, a.id, { action: 'revert' });
      const fields = nameFieldsFrom(res?.data, { displayName: null, nameSource: 'reverted', nameDetails: a?.nameDetails ?? null });
      onChanged?.(a.id, fields, res?.data);
      say('ok', `Name put back to ${was}.`);
      focusEdit();
    } catch (err) {
      say('error', `Could not put the name back: ${String(err?.message || 'unknown error').replace(/[.!]+$/, '')}.`);
    } finally {
      setBusy(null);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === 'Enter') { e.preventDefault(); save(); }
  };

  // Typed characters a file name can't have are flagged as they are typed.
  const liveProblem = problem || (ILLEGAL_TYPED.test(draft) ? nameProblem(draft) : null);
  const small = variant === 'grid';
  const nameText = small ? 'text-xs font-semibold' : 'text-sm font-medium';
  const subText = small ? 'text-[11px]' : 'text-xs';

  return (
    <div className="min-w-0" data-testid="attachment-name">
      {editing ? (
        <form onSubmit={(e) => { e.preventDefault(); save(); }} className="flex min-w-0 flex-col gap-1" aria-label={`Rename ${name}`}>
          <label htmlFor={inputId} className={`${subText} font-semibold text-foreground`}>New name</label>
          <div className={`flex min-w-0 items-center rounded-md border bg-card focus-within:ring-2 focus-within:ring-ring ${liveProblem ? 'border-red-500 dark:border-red-400' : 'border-input'}`}>
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setProblem(null); }}
              onKeyDown={onKeyDown}
              disabled={busy === 'edit'}
              maxLength={200}
              spellCheck={false}
              aria-invalid={liveProblem ? true : undefined}
              aria-describedby={`${hintId}${liveProblem ? ` ${errorId}` : ''}`}
              className={`min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 ${small ? 'text-xs' : 'text-sm'} text-foreground outline-none disabled:opacity-60`}
            />
            {ext && <span className={`flex-none select-none pr-2 ${small ? 'text-xs' : 'text-sm'} text-muted-foreground`} aria-hidden="true">{ext}</span>}
          </div>
          <span id={hintId} className="sr-only">{ext ? `The name ends in ${ext}, which stays. ` : ''}Enter saves, Escape cancels.</span>
          {liveProblem && <p id={errorId} role="alert" className={`${subText} text-red-700 dark:text-red-300`}>{liveProblem}</p>}
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button type="submit" disabled={busy === 'edit'} className={`tp-focus-ring inline-flex items-center gap-1 rounded ${subText} font-semibold text-primary hover:underline disabled:opacity-60`}>
              {busy === 'edit' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Check className="h-3 w-3" aria-hidden="true" />}
              Save
            </button>
            <button type="button" onClick={cancel} disabled={busy === 'edit'} className={`tp-focus-ring rounded ${subText} font-semibold text-muted-foreground hover:text-foreground disabled:opacity-60`}>
              Cancel
            </button>
          </span>
        </form>
      ) : (
        <>
          {variant === 'list'
            ? (
              <button type="button" onClick={() => onPreview?.(a)} className={`tp-focus-ring block max-w-full truncate rounded text-left ${nameText} text-foreground hover:text-primary`} title={`Preview ${name}`}>
                {name}
              </button>
            )
            : <span className={`block truncate ${nameText} text-foreground`} title={name}>{name}</span>}
          {original && (
            <span className={`block truncate ${subText} text-muted-foreground`} title={`Original name: ${original}`} data-testid="attachment-original-name">
              was {original}
              {auto && <span title={namedAutomaticallyTitle(a)} className="text-muted-foreground/75"> · named automatically</span>}
            </span>
          )}
        </>
      )}

      {canRename && !editing && (
        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <button
            ref={editButtonRef}
            type="button"
            onClick={startEdit}
            disabled={Boolean(busy)}
            aria-label={`Edit name of ${name}`}
            className={`tp-focus-ring inline-flex items-center gap-1 whitespace-nowrap rounded ${subText} font-semibold text-muted-foreground hover:text-foreground disabled:opacity-60`}
          >
            <Pencil className="h-3 w-3" aria-hidden="true" /> Edit name
          </button>
          {canRevertName(a) && (
            <button
              type="button"
              onClick={revert}
              disabled={Boolean(busy)}
              aria-label={`Revert ${name} to its original name, ${original}`}
              title={`Put the original name back: ${original}`}
              className={`tp-focus-ring inline-flex items-center gap-1 whitespace-nowrap rounded ${subText} font-semibold text-muted-foreground hover:text-foreground disabled:opacity-60`}
            >
              {busy === 'revert' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Undo2 className="h-3 w-3" aria-hidden="true" />}
              Revert
            </button>
          )}
        </span>
      )}

      {note && (
        <p
          role={note.tone === 'error' ? 'alert' : 'status'}
          className={`mt-0.5 ${subText} ${note.tone === 'error' ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'}`}
          data-testid="attachment-name-note"
        >
          {note.text}
        </p>
      )}
    </div>
  );
}
