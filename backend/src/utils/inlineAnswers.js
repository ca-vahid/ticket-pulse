/**
 * Answers typed inside the quoted text of a reply (inline answers, 20 Nov 2026).
 *
 * An agent asks three numbered questions; the requester answers each one under
 * the question, inside their mail client's quote of our message, and writes
 * only "Please see below" at the top. The quote stripper keeps the top line, so
 * the answers were lost on both sides (Ticket Pulse and the FreshService copy).
 *
 * Deterministic, no AI: the quoted part of the reply is compared word by word
 * with the message being replied to (the agent's entry we sent). Text in the
 * quote that is not in our message is an answer; consecutive added text is one
 * answer, attached to the nearest preceding line of OUR message (usually the
 * question) as its context line. Highlighting on the added text is recorded
 * as a confidence signal only.
 *
 * Unreliable comparisons return no pairs: when our message cannot be found in
 * the quote, or when most of the quote is new (a forward or an older thread).
 * Pure functions; callers wrap them so an error never fails ingest.
 */

export const FULL_BODY_CAP = 200 * 1024;
export const CONTEXT_MAX = 120;
const MAX_TOKENS = 2000; // per side; the comparison table is tokens² × 2 bytes
const MAX_NEW_SHARE = 0.6; // more of the quote than this is new: not our message
const MIN_COVERAGE = 0.4; // less of our message than this is in the quote: not our message
const ANCHOR_RUN = 3; // matched words in a row that pin the quote to our message
const MAX_PAIRS = 25;
const ANSWER_MAX = 1500;
export const INLINE_ANSWERS_LABEL = 'Answered inline';

const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'tbody', 'thead', 'tfoot',
  'ul', 'ol', 'pre', 'section', 'article', 'header', 'footer', 'dt', 'dd', 'dl', 'address', 'center', 'caption', 'figure', 'main', 'nav', 'aside',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'wbr', 'col', 'area', 'base', 'source', 'track', 'embed', 'param']);

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  ndash: '–', mdash: '—', hellip: '…', middot: '·', bull: '•', zwnj: '', zwj: '', shy: '', ensp: ' ', emsp: ' ',
  thinsp: ' ', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', laquo: '«', raquo: '»',
};

function decodeEntities(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ' ';
      try { return String.fromCodePoint(code); } catch { return ' '; }
    }
    const v = NAMED_ENTITIES[name.toLowerCase()];
    return v === undefined ? whole : v;
  });
}

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs || '');
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all|(?:^|[;\s])font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?\s*(?:;|$|!)|max-height\s*:\s*0(?:px)?\s*(?:;|$)/i;
const PLAIN_BACKGROUND = /^(?:transparent|none|inherit|initial|unset|white|window|#fff|#ffffff|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)|rgba\([^)]*,\s*0(?:\.0+)?\s*\))(?:\s|$|!)/;

function isHiddenTag(attrs) {
  const bare = String(attrs || '').replace(/[\w:-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g, (whole) => (/^hidden\s*=/i.test(whole) ? 'hidden' : ''));
  if (/(?:^|\s)hidden(?:\s|$)/i.test(bare)) return true;
  return HIDDEN_STYLE.test(decodeEntities(attr(attrs, 'style') || ''));
}

function isHighlightTag(tag, attrs) {
  if (tag === 'mark') return true;
  const style = decodeEntities(attr(attrs, 'style') || '');
  if (/mso-highlight\s*:\s*(?!none)\w/i.test(style)) return true;
  const m = /(?:^|[;\s])background(?:-color)?\s*:\s*([^;]+)/i.exec(style);
  if (!m) return false;
  return !PLAIN_BACKGROUND.test(m[1].trim().toLowerCase());
}

/** Comparison key of a word: case, accents and punctuation gone. */
export function wordKey(surface) {
  return String(surface || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Cut a string at `end` UTF-16 units without splitting a surrogate pair (an
 * emoji cut in half is invalid JSON for Postgres and would lose the reply).
 */
export function safeSlice(value, end) {
  const s = String(value || '');
  let e = Math.max(0, Math.min(end, s.length));
  const last = s.charCodeAt(e - 1);
  if (e > 0 && e < s.length && last >= 0xd800 && last <= 0xdbff) e -= 1;
  return s.slice(0, e);
}

/** Lone surrogates (a half emoji from a broken numeric entity) become U+FFFD, so the JSON stays valid. */
export function wellFormed(value) {
  const s = String(value ?? '');
  return typeof s.toWellFormed === 'function' ? s.toWellFormed() : s;
}

/** The tail of a string from `start`, never starting on the second half of a surrogate pair. */
export function safeTail(value, start) {
  const s = String(value || '');
  let b = Math.max(0, Math.min(start, s.length));
  const first = s.charCodeAt(b);
  if (b > 0 && first >= 0xdc00 && first <= 0xdfff) b += 1;
  return s.slice(b);
}

// Outlook's plain-text quote rewrites links as "text<https://…>" and
// "a@b.com<mailto:a@b.com>": the address in angle brackets is not text anyone typed.
const BRACKETED_LINK = /<\s*(?:https?:|mailto:|cid:)[^<>]*>|\[cid:[^\]]*\]/gi;

/** Segments ({ text, hl }) of one line → words ({ s, k, hl }). A highlight boundary splits a word. */
function segmentsToWords(segments) {
  const words = [];
  let word = null;
  const end = () => { if (word && word.s) words.push({ s: word.s, k: wordKey(word.s), hl: word.hl }); word = null; };
  for (const seg of segments) {
    for (const piece of String(seg.text).replace(BRACKETED_LINK, ' ').split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) { end(); continue; }
      if (word && word.hl !== seg.hl) end();
      if (!word) word = { s: '', hl: seg.hl };
      word.s += piece;
    }
  }
  end();
  return words;
}

function toLine(words, extra = {}) {
  return { words, text: words.map((w) => w.s).join(' '), ...extra };
}

/** E-mail HTML → visible lines of words, in reading order. Hidden elements are skipped. */
export function htmlToLines(html) {
  const source = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|style|script|title|xml|template)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const lines = [];
  let current = [];
  const flush = () => {
    if (current.some((seg) => /\S/.test(seg.text))) {
      const words = segmentsToWords(current);
      if (words.length) lines.push(toLine(words));
    }
    current = [];
  };
  const stack = [];
  let hiddenDepth = 0;
  let highlightDepth = 0;
  const re = /<(\/?)([a-zA-Z][\w:-]*)\b([^>]*)>|<[^>]*>|([^<]+)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (m[4] !== undefined) {
      if (hiddenDepth > 0) continue;
      // Zero-width and other format characters (Outlook sprinkles them) are not text.
      current.push({ text: decodeEntities(m[4]).replace(/\p{Cf}+/gu, ''), hl: highlightDepth > 0 });
      continue;
    }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    const closing = m[1] === '/';
    const attrs = m[3] || '';
    if (closing) {
      if (BLOCK_TAGS.has(tag)) flush();
      let at = -1;
      for (let i = stack.length - 1; i >= 0; i -= 1) { if (stack[i].tag === tag) { at = i; break; } }
      if (at >= 0) {
        for (const popped of stack.splice(at)) {
          if (popped.hidden) hiddenDepth -= 1;
          if (popped.hl) highlightDepth -= 1;
        }
      }
      continue;
    }
    if (tag === 'br' || tag === 'hr') { flush(); continue; }
    if (BLOCK_TAGS.has(tag)) flush();
    if (VOID_TAGS.has(tag) || /\/\s*$/.test(attrs)) continue;
    const hidden = isHiddenTag(attrs);
    const hl = isHighlightTag(tag, attrs);
    stack.push({ tag, hidden, hl });
    if (hidden) hiddenDepth += 1;
    if (hl) highlightDepth += 1;
  }
  flush();
  return lines;
}

/** Plain-text mail → lines of words. Outlook's ">" quote prefixes are removed and remembered. */
export function textToLines(text) {
  const lines = [];
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const quoted = /^\s*>/.test(raw);
    const words = segmentsToWords([{ text: raw.replace(/^\s*(?:>\s?)+/, ''), hl: false }]);
    if (words.length) lines.push(toLine(words, { quoted }));
  }
  return lines;
}

// Where a client's quote of an earlier message begins.
const QUOTE_START = [
  /^on\b.{4,240}\bwrote\s*:?\s*$/i,
  /^le\b.{4,240}\ba écrit\s*:?\s*$/i,
  /^am\b.{4,240}\bschrieb\b.{0,120}:?\s*$/i,
  /^-{2,}\s*(?:original message|forwarded message|ursprüngliche nachricht|message d'origine)\s*-{2,}/i,
  /^_{8,}$/,
  /^earlier in this conversation\b/i, // our own outbound history heading
];
const FROM_LINE = /^(?:from|von|de|van|da|från|fra)\s*:\s*\S/i;
const HEADER_FIELD = /^(?:from|sent|date|to|cc|bcc|subject|reply-to|importance|von|gesendet|an|betreff|de|envoyé|à|objet|datum)\s*:/i;
const FLATTENED_HEADER = /\bfrom:\s.{1,200}?\b(?:sent|date):\s.{1,80}?\bto:\s/i;

function isQuoteStart(lines, i) {
  const text = lines[i].text.trim();
  if (QUOTE_START.some((re) => re.test(text))) return true;
  if (FLATTENED_HEADER.test(text)) return true;
  if (FROM_LINE.test(text)) {
    for (let k = i + 1; k < Math.min(lines.length, i + 5); k += 1) {
      if (HEADER_FIELD.test(lines[k].text.trim())) return true;
    }
  }
  return false;
}

/** Index of the first line after a quote header that starts at `i` (skips From/Sent/To/Cc/Subject lines). */
function skipHeader(lines, i) {
  let k = i + 1;
  while (k < lines.length && k < i + 10 && HEADER_FIELD.test(lines[k].text.trim())) k += 1;
  return k;
}

function firstQuoteStart(lines, from = 0) {
  for (let i = from; i < lines.length; i += 1) if (isQuoteStart(lines, i)) return i;
  return -1;
}

/**
 * The quoted message in a reply: after the first quote header, up to the next
 * one (older history under it is not the message being answered). Without a
 * header: from the first ">" line of a plain-text reply, else the whole body.
 */
export function quotedRegion(lines) {
  let start = firstQuoteStart(lines);
  if (start >= 0) start = skipHeader(lines, start);
  else {
    const firstQuoted = lines.findIndex((l) => l.quoted);
    start = firstQuoted >= 0 ? firstQuoted : 0;
  }
  const next = firstQuoteStart(lines, start);
  return { start, end: next >= 0 ? next : lines.length };
}

/** Our message, without any history it quoted itself. */
function ownMessageLines(lines) {
  const cut = firstQuoteStart(lines);
  if (cut > 0) return lines.slice(0, cut);
  return lines;
}

function flatten(lines) {
  const tokens = [];
  lines.forEach((line, li) => {
    line.words.forEach((w, wi) => { if (w.k) tokens.push({ ...w, line: li, first: wi === 0 }); });
  });
  return tokens;
}

/** Longest common subsequence of two key arrays → for each b index, the matched a index or -1. */
function align(a, b) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const matchB = new Int32Array(m).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { matchB[j] = i; i += 1; j += 1; } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) i += 1; else j += 1;
  }
  return matchB;
}

/** Runs of consecutive matches (consecutive on both sides): [{ from, to }] over b indexes, inclusive. */
function matchedBlocks(matchB) {
  const blocks = [];
  let open = null;
  for (let j = 0; j < matchB.length; j += 1) {
    if (matchB[j] < 0) { if (open) { blocks.push(open); open = null; } continue; }
    if (open && matchB[j] === matchB[j - 1] + 1) open.to = j;
    else { if (open) blocks.push(open); open = { from: j, to: j }; }
  }
  if (open) blocks.push(open);
  return blocks;
}

const LIST_MARKER = /^\(?(?:\d{1,3}|[a-z]|[ivx]{1,4})[.)]$/i;
const URLISH = /^<?(?:https?:\/\/|mailto:|cid:|www\.)|^\[cid:|^<[^>]+@[^>]+>$/i;
const LEADING_MARKER = /^\s*(?:\(?(?:\d{1,3}|[a-z])[.)]|[•·▪●*\-–])\s+/i;

/** A context line from our message: list marker gone, at most ~120 characters, cut from the front with "…". */
export function contextLine(text, max = CONTEXT_MAX) {
  const clean = wellFormed(String(text || '').replace(LEADING_MARKER, '').replace(/\s+/g, ' ').trim());
  if (clean.length <= max) return clean;
  const sentences = clean.split(/(?<=[.!?])\s+/);
  let kept = '';
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const candidate = kept ? `${sentences[i]} ${kept}` : sentences[i];
    if (candidate.length > max - 1) break;
    kept = candidate;
  }
  if (!kept) {
    const tail = safeTail(clean, clean.length - (max - 1));
    const space = tail.indexOf(' ');
    kept = space > 0 && space < 30 ? tail.slice(space + 1) : tail;
  }
  return `…${kept.trim()}`;
}

function answerText(tokens) {
  const lines = [];
  let lastLine = null;
  for (const t of tokens) {
    if (t.line !== lastLine) { lines.push([]); lastLine = t.line; }
    lines[lines.length - 1].push(t.s);
  }
  const text = lines.map((l) => l.join(' ')).join('\n').trim();
  return wellFormed(text.length > ANSWER_MAX ? `${safeSlice(text, ANSWER_MAX - 1).trimEnd()}…` : text);
}

/**
 * Compare a reply with the message it answers.
 * @returns {{ result: 'found'|'none'|'unreliable', reason?: string, answers: Array<{context, answer, highlighted}>, newShare?: number, coverage?: number }}
 */
export function detectInlineAnswers({ replyHtml = null, replyText = null, sentHtml = null, sentText = null, sentSignatureText = null } = {}) {
  const replyLines = replyHtml ? htmlToLines(replyHtml) : textToLines(replyText);
  let sentLines = ownMessageLines(sentHtml ? htmlToLines(sentHtml) : textToLines(sentText));
  if (sentSignatureText) sentLines = [...sentLines, ...textToLines(sentSignatureText)];
  if (!replyLines.length) return { result: 'none', reason: 'empty_reply', answers: [] };
  if (!sentLines.length) return { result: 'unreliable', reason: 'no_message', answers: [] };

  const { start, end } = quotedRegion(replyLines);
  const quoteLines = replyLines.slice(start, end);
  const a = flatten(sentLines);
  const b = flatten(quoteLines);
  if (a.length < 3) return { result: 'unreliable', reason: 'message_too_short', answers: [] };
  if (!b.length) return { result: 'none', reason: 'no_quote', answers: [] };
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return { result: 'unreliable', reason: 'too_long', answers: [] };

  const matchB = align(a.map((t) => t.k), b.map((t) => t.k));
  const minRun = a.length < 6 ? 1 : ANCHOR_RUN;
  const blocks = matchedBlocks(matchB);
  // A stray short match inside added text (a common word that happens to line
  // up) is part of the answer, not our message.
  for (const block of blocks) {
    const len = block.to - block.from + 1;
    if (len >= minRun) continue;
    const before = block.from > 0 && matchB[block.from - 1] < 0;
    const after = block.to < matchB.length - 1 && matchB[block.to + 1] < 0;
    if (before && after) for (let j = block.from; j <= block.to; j += 1) matchB[j] = -1;
  }
  const anchors = matchedBlocks(matchB).filter((bl) => bl.to - bl.from + 1 >= minRun);

  let matched = 0;
  for (let j = 0; j < matchB.length; j += 1) if (matchB[j] >= 0) matched += 1;
  const coverage = matched / a.length;
  const newShare = (b.length - matched) / b.length;
  const stats = { newShare: Math.round(newShare * 100) / 100, coverage: Math.round(coverage * 100) / 100 };
  if (!anchors.length || coverage < MIN_COVERAGE) return { result: 'unreliable', reason: 'message_not_in_quote', answers: [], ...stats };
  if (newShare > MAX_NEW_SHARE) return { result: 'unreliable', reason: 'mostly_new', answers: [], ...stats };

  const spanFrom = anchors[0].from;
  const spanTo = anchors[anchors.length - 1].to;
  const answers = [];
  let j = spanFrom;
  while (j <= spanTo && answers.length < MAX_PAIRS) {
    if (matchB[j] >= 0) { j += 1; continue; }
    const runStart = j;
    while (j <= spanTo && matchB[j] < 0) j += 1;
    const run = b.slice(runStart, j).filter((t) => !URLISH.test(t.s) && !(t.first && LIST_MARKER.test(t.s)));
    if (!run.length) continue;
    const firstLine = quoteLines[run[0].line]?.text || '';
    if (HEADER_FIELD.test(firstLine.trim()) || QUOTE_START.some((re) => re.test(firstLine.trim()))) continue;
    const prevA = matchB[runStart - 1];
    const context = contextLine(sentLines[a[prevA]?.line]?.text || '');
    const answer = answerText(run);
    if (!context || !answer) continue;
    const lit = run.filter((t) => t.hl).length;
    answers.push({ context, answer, highlighted: lit * 2 >= run.length });
  }
  return answers.length ? { result: 'found', answers, ...stats } : { result: 'none', answers: [], ...stats };
}

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Usable pairs from a stored rawPayload value (anything else → []). */
export function storedInlineAnswers(value) {
  return (Array.isArray(value) ? value : [])
    .filter((p) => p && typeof p.context === 'string' && typeof p.answer === 'string' && p.context.trim() && p.answer.trim())
    .slice(0, MAX_PAIRS);
}

/** The pairs as simple HTML for the FreshService copy (never the whole e-mail). Empty when there are none. */
export function inlineAnswersHtml(value) {
  const pairs = storedInlineAnswers(value);
  if (!pairs.length) return '';
  return `<p><b>${INLINE_ANSWERS_LABEL}</b></p>${pairs
    .map((p) => `<p><b>${esc(p.context)}</b><br>${esc(p.answer).replace(/\r?\n/g, '<br>')}</p>`)
    .join('')}`;
}

/** The pairs as plain text (searchable body text, copy text, AI readers). Empty when there are none. */
export function inlineAnswersText(value) {
  const pairs = storedInlineAnswers(value);
  if (!pairs.length) return '';
  return `${INLINE_ANSWERS_LABEL}\n${pairs.map((p) => `${p.context}\n${p.answer}`).join('\n\n')}`;
}

/** The whole body as it arrived, size-capped: head, styles, comments and inline data pictures go first. */
export function capFullBody(html, cap = FULL_BODY_CAP) {
  let out = wellFormed(String(html || ''));
  if (out.length <= cap) return { html: out, truncated: false };
  out = out
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|xml)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/(<img\b[^>]*\bsrc\s*=\s*["'])data:[^"']*(["'])/gi, '$1$2');
  if (out.length <= cap) return { html: out, truncated: false };
  return { html: wellFormed(safeSlice(out, cap)), truncated: true };
}

/**
 * A thread entry as the ticket page receives it. Since 21 Nov 2026 the original
 * e-mail lives in ticket_thread_entry_originals and raw_payload carries only
 * `hasOriginalEmail`; this is a guard so a full body that ever lands in
 * raw_payload is never shipped with the thread.
 */
export function withoutOriginalBody(entry) {
  const raw = entry?.rawPayload;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return entry;
  if (raw.fullBodyHtml === undefined && raw.fullBodyText === undefined) return entry;
  const { fullBodyHtml, fullBodyText, ...rest } = raw;
  return { ...entry, rawPayload: { ...rest, hasOriginalEmail: Boolean(fullBodyHtml || fullBodyText) } };
}

export default {
  withoutOriginalBody,
  detectInlineAnswers, htmlToLines, textToLines, contextLine, inlineAnswersHtml, inlineAnswersText, storedInlineAnswers, capFullBody,
};
