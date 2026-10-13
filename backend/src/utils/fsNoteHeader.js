/**
 * The first line of a note Ticket Pulse writes on a FreshService ticket.
 *
 * FreshService shows every API note as written by "Ticket Pulse" (the API key's
 * owner), so this line is the only place a FreshService agent can see who really
 * wrote it. It used to open with the bold marker "[Ticket Pulse mirror]", which
 * read as the author (Vahid, 12 Oct 2026). Now the person comes first, in bold,
 * then what they did, then the ticket; the marker moves to the end in small grey.
 *
 * The marker text itself must stay in the body unchanged: the reconcile skips our
 * own notes by `includes(marker)`, and FreshService-side automations exclude
 * Ticket Pulse traffic by the same words. "Name <email>" stays adjacent because
 * it is the only machine-readable attribution the FreshService side gets.
 */
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const FS_NOTE_ACTIONS = {
  note: { icon: '🔒', text: 'internal note' },
  reply: { icon: '✉️', text: 'reply, already e-mailed to the requester by Ticket Pulse' },
  received: { icon: '📨', text: 'reply received by e-mail in Ticket Pulse' },
  attachment: { icon: '📎', text: 'attachment added in Ticket Pulse' },
  copy: { icon: '🔁', text: 'copy of a Ticket Pulse ticket' },
};

export function fsNoteHeader({ who = null, email = null, action = 'note', detail = null, ref = null, url = null, marker }) {
  const act = FS_NOTE_ACTIONS[action] || FS_NOTE_ACTIONS.note;
  const name = `<b>${esc(who || 'Ticket Pulse')}</b>${email ? ` <span style="color:#64748b">&lt;${esc(email)}&gt;</span>` : ''}`;
  const refHtml = ref ? ` · ${url ? `<a href="${esc(url)}">${esc(ref)}</a>` : esc(ref)}` : '';
  return `<p style="margin:0 0 8px">${name} <span style="color:#475569">· ${act.icon} ${esc(detail || act.text)}${refHtml}</span>`
    + ` <span style="font-size:11px;color:#94a3b8">${esc(marker)}</span></p>`;
}

export default fsNoteHeader;
