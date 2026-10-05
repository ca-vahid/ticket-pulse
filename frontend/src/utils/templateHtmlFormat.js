/**
 * Keep e-mail template HTML readable (QA 10-05 #4).
 *
 * The rich-text editor hands its HTML back as one long line, so a template
 * edited there lost every line break and was hard to review in the code
 * editor. `formatTemplateHtml` puts each block back on its own line.
 *
 * It only ever adds a line break between two tags that sit directly next to
 * each other, where at least one is an HTML block tag (</p><p>, </p>{% if %},
 * {% endif %}<p>, <tr><td> …). Whitespace there never shows in an e-mail.
 * It never breaks next to text or between two Liquid tags, where a new line
 * could become a visible space. HTML that already has line breaks is the
 * author's layout and is returned untouched.
 */

const BLOCK = 'p|div|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|h[1-6]|blockquote|pre|hr|br|section|header|footer|center';
const BLOCK_TAG = `</?(?:${BLOCK})\\b[^>]*>`;
const LIQUID_TAG = '\\{%-?[^%]*-?%\\}';
// (block)(block) | (block)(liquid) | (liquid)(block)
const ADJACENT = new RegExp(`(${BLOCK_TAG})(?=${BLOCK_TAG}|${LIQUID_TAG})|(${LIQUID_TAG})(?=${BLOCK_TAG})`, 'gi');

export function formatTemplateHtml(html) {
  const source = String(html ?? '');
  if (!source || /[\r\n]/.test(source)) return source;
  return source.replace(ADJACENT, (match) => `${match}\n`);
}

/** The same HTML with the breaks between tags removed — for comparing two copies. */
export function compactTemplateHtml(html) {
  return String(html ?? '').replace(/>\s*[\r\n]\s*</g, '><').replace(/>\s*[\r\n]\s*\{%/g, '>{%').replace(/%\}\s*[\r\n]\s*</g, '%}<').trim();
}
