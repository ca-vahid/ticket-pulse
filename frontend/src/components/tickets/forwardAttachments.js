/**
 * Which of a ticket's files a forward carries (QA 11-24 #5). Helpers for
 * ForwardAttachmentPicker and the composer's send.
 */

// The reply lane's e-mail limits (backend ticketService MAIL_FILE_BYTES /
// MAIL_TOTAL_ATTACHMENT_BYTES — 25 MB of base64 is about 18.75 MB of files).
export const FORWARD_MAIL_FILE_BYTES = 3 * 1024 * 1024;
export const FORWARD_MAIL_TOTAL_BYTES = Math.floor((25 * 1024 * 1024 * 3) / 4);

const isImage = (a) => /^image\//i.test(a?.contentType || a?.mimeType || '')
  || /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i.test(a?.fileName || '');
// Names mail clients and our composer give pictures placed inside a message.
const INLINE_NAME = /^(image\d{3,}|pasted-image-\d+|outlook-[\w-]+|inline[\w-]*)\.(png|jpe?g|gif|bmp|webp)$/i;

export const fitsInMail = (a) => !(Number(a?.sizeBytes) > FORWARD_MAIL_FILE_BYTES);

const PRIVATE_EVENT_TYPES = new Set(['note', 'private_note', 'forward']);

/**
 * Ids of the thread entries only the team saw: internal notes, earlier
 * forwards and "Reply to <name>" (stored as forwards), anything marked
 * private. Review, 24 Nov 2026: their files must not go out by default.
 */
export function privateEntryIdsOf(entries) {
  const ids = new Set();
  for (const e of entries || []) {
    if (!e || e.id === undefined || e.id === null) continue;
    if (e.isPrivate === true || e.visibility === 'private' || PRIVATE_EVENT_TYPES.has(e.eventType)) ids.add(e.id);
  }
  return ids;
}

/**
 * { files, pictures, internal }:
 *  - `internal`: files of a private entry (see privateEntryIdsOf), or of an
 *    entry this page does not know (fail safe; the server agrees). Never ticked
 *    by default; listed apart under "From internal notes".
 *  - `pictures`: pictures that came inside a message (in `inlinePictureIds`, a
 *    signature logo seen on many tickets, or named the way mail clients name an
 *    inline picture).
 *  - `files`: everything else (the description's and public messages' files).
 * `entries`: the ticket's thread, to tell private entries from public ones.
 */
export function groupForwardAttachments(attachments, inlinePictureIds = null, entries = null) {
  const inline = inlinePictureIds instanceof Set ? inlinePictureIds : new Set(inlinePictureIds || []);
  const known = Array.isArray(entries) ? new Set(entries.map((e) => e?.id)) : null;
  const privateIds = privateEntryIdsOf(entries);
  const files = [];
  const pictures = [];
  const internal = [];
  for (const a of attachments || []) {
    if (!a || a.id === undefined || a.id === null) continue;
    const entryId = a.threadEntryId;
    const onEntry = entryId !== undefined && entryId !== null;
    if (onEntry && (privateIds.has(entryId) || (known && !known.has(entryId)))) { internal.push(a); continue; }
    const fromMessage = isImage(a) && (inline.has(a.id) || a.recurring === true || INLINE_NAME.test(String(a.fileName || '').trim()));
    (fromMessage ? pictures : files).push(a);
  }
  return { files, pictures, internal };
}

/** True when any of these ids is a file from an internal note (the server needs to be told). */
export function includesInternal(ids, internal) {
  const set = new Set((internal || []).map((a) => a.id));
  return (ids || []).some((id) => set.has(id));
}

/** On, with every file that can be e-mailed ticked, when the ticket has any. Internal-note files never. */
export function defaultForwardSelection(files) {
  const ids = (files || []).filter(fitsInMail).map((a) => a.id);
  return { include: ids.length > 0, ids };
}

/** The ids to send: none when the box is off; only files still on the ticket. */
export function forwardAttachmentIds(selection, attachments) {
  if (!selection?.include) return [];
  const present = new Set((attachments || []).map((a) => a.id));
  return (selection.ids || []).filter((id) => present.has(id));
}
