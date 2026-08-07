/**
 * Real-HTML detection for ticket/thread bodies (QA 08-06 #5).
 *
 * Plain-text descriptions can contain angle-bracket tokens like `<Processed>`
 * — the old `/<[a-z]/i` heuristic treated those as HTML and DOMPurify then ate
 * the tokens. A string only counts as HTML when it contains a KNOWN html tag,
 * so plain text renders through the pre-wrap branch with brackets intact.
 *
 * Keep in sync with the backend copy: backend/src/utils/htmlContent.js
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
