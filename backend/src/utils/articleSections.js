/**
 * Knowledge article → sections (Auto-help R2, plans/AUTO_HELP_PLAN.md →
 * Research findings). Structure-aware chunks so retrieval can return the one
 * procedure that answers a ticket instead of the whole article:
 *
 *  - split on h1–h4 headings (text before the first heading is its own
 *    section with an empty heading);
 *  - a section whose text is shorter than MIN_SECTION_CHARS is merged into the
 *    previous one (the first one, when short, into the next);
 *  - a section longer than MAX_SECTION_CHARS is split on block boundaries
 *    (paragraphs, lists, tables…) — never inside a list or table, so a
 *    numbered procedure stays whole even when that makes one chunk long.
 *
 * Pure: no I/O. htmlToText lives here so the service and the splitter agree
 * on what "the text" of a piece of HTML is.
 */

export const MIN_SECTION_CHARS = 200;
export const MAX_SECTION_CHARS = 2500;

/** Plain text of an article body — what the model reads and keyword search scans. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    // Inline tags vanish without a gap: "<b>Company Portal</b>," stays "Company Portal,".
    .replace(/<\/?(?:a|b|strong|i|em|u|span|code|small|sub|sup|mark|font)(?=[\s/>])[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const HEADING_RE = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
const BLOCK_TAG_RE = /<(\/?)(ol|ul|table|p|div|pre|blockquote)\b[^>]*>/gi;

/** HTML → top-level blocks, never cutting inside a list or a table. */
export function splitBlocks(html) {
  const s = String(html || '');
  const blocks = [];
  let listDepth = 0;
  let tableDepth = 0;
  let start = 0;
  BLOCK_TAG_RE.lastIndex = 0;
  let m;
  while ((m = BLOCK_TAG_RE.exec(s))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'ol' || tag === 'ul') listDepth = Math.max(0, listDepth + (closing ? -1 : 1));
    if (tag === 'table') tableDepth = Math.max(0, tableDepth + (closing ? -1 : 1));
    if (closing && listDepth === 0 && tableDepth === 0) {
      const end = m.index + m[0].length;
      const piece = s.slice(start, end);
      if (piece.trim()) blocks.push(piece);
      start = end;
    }
  }
  const tail = s.slice(start);
  if (tail.trim()) blocks.push(tail);
  return blocks;
}

function capSection(section, maxChars) {
  if (section.text.length <= maxChars) return [section];
  const out = [];
  let html = '';
  for (const block of splitBlocks(section.html)) {
    const next = html + block;
    if (html && htmlToText(next).length > maxChars) {
      out.push(html);
      html = block;
    } else {
      html = next;
    }
  }
  if (html) out.push(html);
  return out.map((h, i) => ({
    heading: i === 0 ? section.heading : `${section.heading || 'Continued'} (cont.)`,
    html: h,
    text: htmlToText(h),
  }));
}

/**
 * @returns {Array<{ heading: string, text: string }>} sections in order; an
 *   empty body gives [].
 */
export function splitArticleSections(bodyHtml, { minChars = MIN_SECTION_CHARS, maxChars = MAX_SECTION_CHARS } = {}) {
  const html = String(bodyHtml || '');
  if (!htmlToText(html)) return [];
  const raw = [];
  let cursor = 0;
  let heading = '';
  HEADING_RE.lastIndex = 0;
  let m;
  while ((m = HEADING_RE.exec(html))) {
    raw.push({ heading, html: html.slice(cursor, m.index) });
    heading = htmlToText(m[2]);
    cursor = m.index + m[0].length;
  }
  raw.push({ heading, html: html.slice(cursor) });

  const pieces = raw
    .map((p) => ({ ...p, text: htmlToText(p.html) }))
    .filter((p) => p.text || p.heading);

  // Merge short sections into the previous one (the first, when short, into the next).
  const merged = [];
  let carry = null;
  for (const p of pieces) {
    let cur = p;
    if (carry) {
      cur = {
        heading: carry.heading || p.heading,
        html: `${carry.html}${carry.heading && p.heading ? `<p>${p.heading}</p>` : ''}${p.html}`,
        text: [carry.text, carry.heading && p.heading ? p.heading : '', p.text].filter(Boolean).join('\n'),
      };
      carry = null;
    }
    if (cur.text.length < minChars) {
      if (merged.length) {
        const prev = merged[merged.length - 1];
        prev.html += `${cur.heading ? `<p>${cur.heading}</p>` : ''}${cur.html}`;
        prev.text = [prev.text, cur.heading, cur.text].filter(Boolean).join('\n');
        continue;
      }
      carry = cur;
      continue;
    }
    merged.push({ ...cur });
  }
  if (carry) merged.push(carry);

  return merged
    .flatMap((sec) => capSection(sec, maxChars))
    .filter((sec) => sec.text)
    .map((sec) => ({ heading: sec.heading || '', text: sec.text }));
}
