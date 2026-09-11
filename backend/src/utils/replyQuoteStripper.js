/**
 * Strip the quoted history a mail client tacks onto a reply (FR 09-10).
 *
 * Without this, quoting the whole thread on our outbound replies compounds:
 * we quote the conversation, the requester's client quotes our whole mail back,
 * we store that verbatim, and the next outbound quote carries a copy of a copy.
 * Message N ends up containing N copies of the thread.
 *
 * What we keep is what the person actually typed — everything above the first
 * quote marker. Deliberately conservative: if a strip would leave nothing, the
 * original is returned untouched, because losing a reply is far worse than
 * carrying a duplicate of it.
 */

// Ordered most-specific first. Each marks the START of quoted history.
const HTML_QUOTE_CONTAINERS = [
  /<div[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*$/i,
  /<blockquote[^>]*type="cite"[\s\S]*$/i,
  /<div[^>]*id="(?:divRplyFwdMsg|appendonsend)"[\s\S]*$/i,   // Outlook / OWA
  /<div[^>]*class="[^"]*moz-cite-prefix[^"]*"[\s\S]*$/i,      // Thunderbird
  /<hr[^>]*id="?stopSpelling"?[\s\S]*$/i,                     // older Outlook
];

const TEXT_QUOTE_MARKERS = [
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^_{10,}\s*$/m,                                             // Outlook's rule
  /^From:\s.+\r?\nSent:\s.+$/im,
  /^On .{4,80}\bwrote:\s*$/im,
  /^>{1,}\s?.*$/m,
];

/** Would stripping leave anything meaningful behind? */
function meaningful(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim().length >= 2;
}

export function stripQuotedHtml(html) {
  const input = String(html || '');
  if (!input) return input;
  let out = input;
  for (const pattern of HTML_QUOTE_CONTAINERS) {
    const candidate = out.replace(pattern, '');
    if (candidate !== out && meaningful(candidate)) out = candidate;
  }
  return meaningful(out) ? out.trim() : input;
}

export function stripQuotedText(text) {
  const input = String(text || '');
  if (!input) return input;
  let cutAt = input.length;
  for (const marker of TEXT_QUOTE_MARKERS) {
    const m = marker.exec(input);
    if (m && m.index < cutAt) cutAt = m.index;
  }
  const candidate = input.slice(0, cutAt).trim();
  return meaningful(candidate) ? candidate : input;
}

export default { stripQuotedHtml, stripQuotedText };
