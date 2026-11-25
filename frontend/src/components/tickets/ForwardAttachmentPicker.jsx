import { useState } from 'react';
import { AlertTriangle, Image as ImageIcon, Lock, Paperclip } from 'lucide-react';
import { formatBytes } from './ticketUi';
import { attachmentName } from './attachmentNames';
import { FORWARD_MAIL_TOTAL_BYTES, fitsInMail } from './forwardAttachments';

/**
 * "Include the original attachments" on a forward (QA 11-24 #5). An invoice
 * ticket was forwarded to an engineer for approval and he wrote back "there
 * was no attachment to the email": a forward carried only the typed text.
 *
 * The ticket's files are listed with a tick each, all ticked. Pictures that
 * came inside an e-mail (signature logos, Outlook's image001.png, pasted
 * screenshots shown in a message) are left out unless asked for, behind
 * "Show pictures from the e-mail (n)". A file over 3 MB cannot go by e-mail
 * (the reply lane's limit), so it is shown but cannot be ticked.
 *
 * Files of internal notes, earlier forwards and "Reply to" messages are never
 * ticked by default (review, 24 Nov 2026): the forward's own text carries
 * public messages only. They sit apart under "From internal notes (n)",
 * folded and unticked, so an agent can still send one on purpose.
 *
 * Controlled: `value` is { include, ids }; `onChange` gets the next value.
 * The grouping and default selection live in ./forwardAttachments.
 */

function Row({ a, checked, disabled, onToggle, picture = false, internal = false }) {
  const tooBig = !fitsInMail(a);
  const name = attachmentName(a);
  const Icon = internal ? Lock : picture ? ImageIcon : Paperclip;
  return (
    <li>
      <label className={`flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-xs ${tooBig || disabled ? 'text-muted-foreground' : 'text-foreground/85 hover:bg-muted/50'}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled || tooBig}
          onChange={onToggle}
          aria-label={`Include ${name}`}
          className="tp-focus-ring h-3.5 w-3.5 shrink-0 rounded border-input text-violet-600 dark:text-violet-300"
        />
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/75" aria-hidden="true" />
        <span className="min-w-0 truncate" title={name}>{name}</span>
        {a.sizeBytes ? <span className="shrink-0 tabular-nums text-muted-foreground/75">{formatBytes(a.sizeBytes)}</span> : null}
        {tooBig && <span className="shrink-0 text-[11px] text-amber-700 dark:text-amber-300">over 3 MB, too big to e-mail</span>}
      </label>
    </li>
  );
}

export default function ForwardAttachmentPicker({ files = [], pictures = [], internal = [], value, onChange, disabled = false }) {
  const [showPictures, setShowPictures] = useState(false);
  const [showInternal, setShowInternal] = useState(false);
  if (files.length === 0 && pictures.length === 0 && internal.length === 0) return null;
  const include = Boolean(value?.include);
  const picked = new Set(value?.ids || []);
  const set = (next) => onChange?.({ include, ids: [...picked], ...next });
  const toggle = (id) => {
    const ids = new Set(picked);
    if (ids.has(id)) ids.delete(id); else ids.add(id);
    set({ ids: [...ids] });
  };
  const all = [...files, ...pictures, ...internal];
  const pickedBytes = all.filter((a) => picked.has(a.id)).reduce((sum, a) => sum + (Number(a.sizeBytes) || 0), 0);
  const tooMuch = include && pickedBytes > FORWARD_MAIL_TOTAL_BYTES;

  return (
    <div className="mt-2" data-testid="forward-originals">
      <label className="inline-flex items-center gap-2 text-xs font-medium text-foreground">
        <input
          type="checkbox"
          checked={include}
          disabled={disabled}
          onChange={(e) => set({ include: e.target.checked })}
          className="tp-focus-ring h-3.5 w-3.5 rounded border-input text-violet-600 dark:text-violet-300"
        />
        Include the original attachments ({files.length})
      </label>
      {include && (
        <div className="ml-5 mt-1">
          {files.length > 0 && (
            <ul className="max-h-40 space-y-0.5 overflow-y-auto settings-scrollbar" aria-label="Attachments to include">
              {files.map((a) => (
                <Row key={a.id} a={a} checked={picked.has(a.id)} disabled={disabled} onToggle={() => toggle(a.id)} />
              ))}
            </ul>
          )}
          {pictures.length > 0 && (
            <button
              type="button"
              onClick={() => setShowPictures((v) => !v)}
              aria-expanded={showPictures}
              className="tp-focus-ring mt-1 rounded px-1 text-xs font-medium text-primary hover:underline"
            >
              {showPictures ? 'Hide the pictures from the e-mail' : `Show pictures from the e-mail (${pictures.length})`}
            </button>
          )}
          {showPictures && pictures.length > 0 && (
            <ul className="mt-0.5 max-h-40 space-y-0.5 overflow-y-auto settings-scrollbar" aria-label="Pictures from the e-mail to include">
              {pictures.map((a) => (
                <Row key={a.id} a={a} picture checked={picked.has(a.id)} disabled={disabled} onToggle={() => toggle(a.id)} />
              ))}
            </ul>
          )}
          {internal.length > 0 && (
            <button
              type="button"
              onClick={() => setShowInternal((v) => !v)}
              aria-expanded={showInternal}
              className="tp-focus-ring mt-1 block rounded px-1 text-xs font-medium text-primary hover:underline"
            >
              {showInternal ? 'Hide the files from internal notes' : `From internal notes (${internal.length})`}
            </button>
          )}
          {showInternal && internal.length > 0 && (
            <>
              <p className="mt-0.5 px-1 text-[11px] text-muted-foreground">
                Only your team has seen these. Tick one only if the person you forward to should have it.
              </p>
              <ul className="mt-0.5 max-h-40 space-y-0.5 overflow-y-auto settings-scrollbar" aria-label="Files from internal notes to include">
                {internal.map((a) => (
                  <Row key={a.id} a={a} internal checked={picked.has(a.id)} disabled={disabled} onToggle={() => toggle(a.id)} />
                ))}
              </ul>
            </>
          )}
          {tooMuch && (
            <p role="alert" className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
              Together these are {formatBytes(pickedBytes)}, more than one e-mail can carry (about 18 MB). Untick some.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
