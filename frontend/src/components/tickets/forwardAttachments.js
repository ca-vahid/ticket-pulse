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

/**
 * { files, pictures }: `pictures` are the pictures that came inside a message
 * (in `inlinePictureIds`, a signature logo seen on many tickets, or named the
 * way mail clients name an inline picture); everything else is a file.
 */
export function groupForwardAttachments(attachments, inlinePictureIds = null) {
  const inline = inlinePictureIds instanceof Set ? inlinePictureIds : new Set(inlinePictureIds || []);
  const files = [];
  const pictures = [];
  for (const a of attachments || []) {
    if (!a || a.id === undefined || a.id === null) continue;
    const fromMessage = isImage(a) && (inline.has(a.id) || a.recurring === true || INLINE_NAME.test(String(a.fileName || '').trim()));
    (fromMessage ? pictures : files).push(a);
  }
  return { files, pictures };
}

/** On, with every file that can be e-mailed ticked, when the ticket has any. */
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
