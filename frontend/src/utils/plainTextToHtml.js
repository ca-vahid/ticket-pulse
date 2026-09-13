/**
 * Plain-text mail body → HTML, the way a mail client renders it.
 *
 * FR 09-11 #3: the conversation used to turn EVERY newline into a `<br>`, so a
 * body whose lines are separated by blank lines — which is what an HTML email
 * looks like after Outlook/Graph down-converts it to text, one blank line per
 * block element — rendered with a full empty line between every single line,
 * including one-word lines like "Planning". QA asked us to remove the extra
 * spacing.
 *
 * A blank line is a PARAGRAPH break and a single newline is a LINE break, so
 * the structure survives, but the gap between paragraphs becomes a normal
 * paragraph margin (`[&_p]:my-1.5`, 6px) instead of a whole blank line (~20px).
 * Prose keeps its paragraphs; a blank-line-separated list reads as a list.
 */

export const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// U+00A0. Outlook's text down-conversion sprinkles non-breaking spaces, which
// render as odd gaps and refuse to wrap. Named so the next reader can see it —
// a literal NBSP in a regex is invisible.
const NBSP = /\u00A0/g;

export function plainTextToHtml(text) {
  const normalized = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(NBSP, ' ')
    .trim();
  if (!normalized) return '';
  return normalized
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export default plainTextToHtml;
