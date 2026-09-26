/**
 * "Stay quiet when" helpers (26 Sep 2026).
 *
 * findStayQuietBlock: playbooks written before the list existed carry their
 * hard stops inside the instructions ("Say it is not answerable when:" or
 * "Stay quiet when:" followed by "- …" lines). The editor OFFERS to move those
 * lines into the list — it never moves them on its own.
 */
const HEADING = /^\s*(?:say (?:it is|it's) not answerable (?:when|if)|stay quiet (?:when|if)|do not answer (?:when|if)|don't answer (?:when|if))\s*:?\s*$/i;
const BULLET = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.+?)\s*$/;

/**
 * @returns {null | { items: string[], rest: string }} the bullet lines under
 *   the first stay-quiet heading, and the instructions without that block.
 */
export function findStayQuietBlock(instructions) {
  const lines = String(instructions || '').split('\n');
  const start = lines.findIndex((l) => HEADING.test(l));
  if (start < 0) return null;
  const items = [];
  let end = start + 1;
  while (end < lines.length) {
    const m = lines[end].match(BULLET);
    if (!m) break;
    items.push(m[1]);
    end += 1;
  }
  if (!items.length) return null;
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  // Drop the blank line the block leaves behind (one, not every one).
  while (before.length && !before[before.length - 1].trim() && after.length && !after[0].trim()) after.shift();
  const rest = [...before, ...after].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { items, rest };
}

/** Adds conditions to a list, skipping case-insensitive duplicates. */
export function mergeConditions(list, add) {
  const out = [...(list || [])];
  for (const raw of add || []) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

export const MAX_STAY_QUIET = 20;
export const MAX_STAY_QUIET_CHARS = 300;
