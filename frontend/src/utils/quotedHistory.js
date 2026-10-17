/**
 * The quoted history a mail client adds under a reply (QA 10-16, #245244: a
 * "Thank you" from the requester carried the whole earlier thread, because
 * FreshService did not find the cut). The same markers as the backend's
 * replyQuoteStripper, so rows stored before the server-side trim read the same.
 */
const QUOTE_STARTS = [
  /<div[^>]*class="[^"]*gmail_quote[^"]*"/i,
  /<blockquote[^>]*type="cite"/i,
  /<div[^>]*id="(?:divRplyFwdMsg|appendonsend)"/i, // Outlook on the web
  /<div[^>]*class="[^"]*moz-cite-prefix[^"]*"/i, // Thunderbird
  /<hr[^>]*id="?stopSpelling"?/i, // older Outlook
  /<div[^>]*style="[^"]*border-top:\s*solid\s+#(?:E1E1E1|B5C4DF)[^"]*"/i, // Outlook desktop "From: / Sent:"
];

function meaningful(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim().length >= 2;
}

/**
 * Split a requester's reply into what they wrote and the history underneath.
 * Returns { fresh, quoted }; `quoted` is false when nothing was found, or when
 * cutting would leave nothing (a reply is never hidden).
 */
export function splitQuotedHistory(html) {
  const input = String(html || '');
  let cut = -1;
  for (const pattern of QUOTE_STARTS) {
    const m = pattern.exec(input);
    if (m && (cut === -1 || m.index < cut)) cut = m.index;
  }
  if (cut <= 0) return { fresh: input, quoted: false };
  const fresh = input.slice(0, cut);
  return meaningful(fresh) ? { fresh, quoted: true } : { fresh: input, quoted: false };
}

/**
 * For a conversation entry: the body to show by default and the full e-mail
 * behind "Show the full e-mail". Only requester replies are folded; notes and
 * forwards quote on purpose.
 */
export function replyBodyParts(entry, shownHtml) {
  const isRequesterReply = entry?.eventType === 'customer_reply'
    || (entry?.eventType === 'reply' && entry?.authorType === 'requester');
  if (!isRequesterReply || !shownHtml) return { fresh: shownHtml, full: null };
  // Trimmed on the server: the original mail is still in the raw payload.
  const original = entry?.rawPayload?.tpQuotedHistoryTrimmed ? entry.rawPayload.body : null;
  if (original && original !== shownHtml) return { fresh: shownHtml, full: original };
  const { fresh, quoted } = splitQuotedHistory(shownHtml);
  return quoted ? { fresh, full: shownHtml } : { fresh: shownHtml, full: null };
}
