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

