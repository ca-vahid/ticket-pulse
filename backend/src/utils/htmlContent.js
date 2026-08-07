/**
 * Real-HTML detection for intake bodies (QA 08-06 #5).
 *
 * API senders (Power Automate etc.) post plain-text descriptions that contain
 * angle-bracket tokens like `<Processed>`. The old `/<[a-z]/i` heuristics
 * treated those as HTML, so the tokens were stripped by sanitizers on both
 * sides. A string only counts as HTML when it contains a KNOWN html tag —
 * `<p>`, `</div>`, `<br/>`, `<h2 style=...>` — not just anything in brackets.
 *
 * Keep in sync with the frontend copy: frontend/src/utils/htmlContent.js
 */
const KNOWN_HTML_TAG_RE = new RegExp(
  '</?(?:'
  + 'a|abbr|address|article|aside|b|bdi|blockquote|body|br|button|caption|cite|code|col|colgroup|'
  + 'dd|del|details|dfn|div|dl|dt|em|fieldset|figcaption|figure|font|footer|form|h[1-6]|head|header|hr|html|'
  + 'i|iframe|img|input|ins|kbd|label|legend|li|main|mark|nav|ol|optgroup|option|p|picture|pre|q|'
  + 's|samp|section|select|small|source|span|strike|strong|style|sub|summary|sup|'
  + 'table|tbody|td|textarea|tfoot|th|thead|time|title|tr|u|ul|var|video'
  + ')(?=[\\s/>])[^>]*>',
  'i',
);

export function looksLikeRealHtml(value) {
  return KNOWN_HTML_TAG_RE.test(String(value || ''));
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Plain text → display-safe HTML: entities escaped (brackets survive as
 * visible text), newlines become <br>.
 */
export function plainTextToHtml(value) {
  const text = String(value ?? '');
  if (!text.trim()) return null;
  return escapeHtml(text).replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
}
