/**
 * Double-signature safety net for personal API keys (4.4.05).
 *
 * Ticket Pulse adds the person's own signature to every reply it sends. An AI
 * assistant that also signs off with that signature would send it twice, so a
 * personal-key reply whose body ENDS with the person's enabled signature has
 * that trailing copy dropped before it is sent.
 *
 * Exact match only: the text of the body's tail, with markup removed and white
 * space collapsed, must equal the signature's text the same way. Nothing else
 * is ever removed (not a sign-off line, not a "-- " delimiter, not a partial
 * signature), and a body that is nothing but the signature is left alone.
 *
 * Pure module (no imports) so it is easy to test on its own.
 */

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&apos;': "'",
};

/** Text of a fragment for comparison: tags out, entities decoded, white space collapsed. */
export function normalizeSignatureText(value) {
  return String(value ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39|#x27);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The signature texts a body may end with (its plain text and its HTML read as text). */
export function signatureTexts(signature) {
  if (!signature) return [];
  const out = new Set();
  for (const candidate of [signature.text, signature.html]) {
    const t = normalizeSignatureText(candidate);
    if (t) out.add(t);
  }
  return [...out];
}

/**
 * The LATEST cut position in `source` whose tail reads exactly as one of
 * `wanted` (so the cut takes the signature and nothing before it), as long as
 * the head still holds something: words, or a picture.
 */
function findCut(source, positions, wanted) {
  for (const pos of [...positions].sort((a, b) => b - a)) {
    const tail = normalizeSignatureText(source.slice(pos));
    if (!wanted.includes(tail)) continue;
    const headRaw = source.slice(0, pos);
    if (!normalizeSignatureText(headRaw) && !/<img\b/i.test(headRaw)) return -1; // the whole body is the signature
    return pos;
  }
  return -1;
}

/**
 * Cut points in HTML: the start of a block (<p>, <div>, <table>, <hr>) or the
 * point just after a <br>. Never at an inline tag, so "Please call <b>Dana
 * Fox</b>" is never read as a signature.
 */
function htmlCutPositions(html) {
  const positions = [];
  const block = /<(?:p|div|table|hr)\b/gi;
  let m;
  while ((m = block.exec(html)) !== null) positions.push(m.index);
  const br = /<br\b[^>]*>/gi;
  while ((m = br.exec(html)) !== null) positions.push(m.index + m[0].length);
  return positions;
}

/** Cut points in plain text: the start of every line. */
function textCutPositions(text) {
  const positions = [];
  for (let i = 0; i < text.length; i += 1) {
    if (i === 0 || text[i - 1] === '\n') positions.push(i);
  }
  return positions;
}

/** Trailing blank markup and white space left after the cut. */
function trimHtmlTail(html) {
  let out = html;
  for (let pass = 0; pass < 6; pass += 1) {
    const next = out
      .replace(/(?:\s|&nbsp;|\u00a0)+$/i, '')
      .replace(/(?:<br\s*\/?>)+$/i, '')
      .replace(/<(p|div)\b[^>]*>(?:\s|&nbsp;|\u00a0|<br\s*\/?>)*<\/\1>$/i, '')
      .replace(/<(p|div|span|b|strong|i|em)\b[^>]*>(?:\s|&nbsp;|\u00a0|<br\s*\/?>)*$/i, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Drop the person's own signature from the END of a reply body.
 * `body` = { bodyText, bodyHtml } (either may be null). Returns the body to send
 * and `removed: true` when a trailing copy was dropped.
 */
export function stripTrailingSignature(body, signature) {
  const wanted = signatureTexts(signature);
  const input = { bodyText: body?.bodyText ?? null, bodyHtml: body?.bodyHtml ?? null };
  if (!wanted.length) return { ...input, removed: false };

  let removed = false;
  let { bodyText, bodyHtml } = input;
  if (typeof bodyHtml === 'string' && bodyHtml.trim()) {
    const cut = findCut(bodyHtml, htmlCutPositions(bodyHtml), wanted);
    if (cut > 0) {
      bodyHtml = trimHtmlTail(bodyHtml.slice(0, cut));
      removed = true;
    }
  }
  if (typeof bodyText === 'string' && bodyText.trim()) {
    const normalized = bodyText.replace(/\r\n?/g, '\n');
    const cut = findCut(normalized, textCutPositions(normalized), wanted);
    if (cut > 0) {
      bodyText = normalized.slice(0, cut).replace(/\s+$/, '');
      removed = true;
    }
  }
  return { bodyText, bodyHtml, removed };
}

export default { normalizeSignatureText, signatureTexts, stripTrailingSignature };
