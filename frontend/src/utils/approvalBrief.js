// Approvals page option A (7 Oct 2026): text helpers for the request and the
// ticket summary shown when a row opens.

const IMG_REF_RE = /\[Image:\s*([^\]]+?)\]/g;

/** "text [Image: a.png] more" → { text: 'text more', names: ['a.png'] } */
export function splitImageRefs(raw) {
  const names = [];
  const text = String(raw || '').replace(IMG_REF_RE, (_m, n) => { names.push(String(n).trim()); return ' '; });
  return { text: text.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim(), names };
}

/** The ticket description as readable text: no image markers, no stacked blank lines, no pasted-source footer. */
export function briefDescription(ticket) {
  const raw = String(ticket?.descriptionText || '')
    .replace(/\u00a0/g, ' ')
    .split(/\n\s*—\s*Source material/i)[0];
  return splitImageRefs(raw).text
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


/**
 * One request sent to several approvers is one row (Vahid, 7 Oct 2026). The
 * rows of a request share requestGroupId (older ones: same ticket, category,
 * asker and note). A row cancelled because a sibling decided ("Superseded")
 * is dropped; the row that matters most leads.
 */
const STATUS_RANK = { approved: 0, rejected: 0, info_requested: 1, pending: 2, escalated: 3, forwarded: 3, cancelled: 4 };
export function groupApprovals(items = []) {
  const groups = new Map();
  for (const a of items) {
    const key = a.requestGroupId || `${a.ticketId}|${a.categoryName || ''}|${String(a.requestedBy || '').trim().toLowerCase()}|${String(a.requestNote || '').trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const live = rows.some((r) => r.status !== 'cancelled');
    const members = live ? rows.filter((r) => r.status !== 'cancelled') : rows;
    const primary = [...members].sort((x, y) => (STATUS_RANK[x.status] ?? 5) - (STATUS_RANK[y.status] ?? 5)
      || new Date(y.decidedAt || y.createdAt) - new Date(x.decidedAt || x.createdAt))[0];
    return { key, primary, members };
  });
}

