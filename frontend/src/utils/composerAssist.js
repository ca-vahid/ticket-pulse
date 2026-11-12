// Composer writing help (Nov 2026): the choices the menu offers and the two
// small text helpers around a suggestion. The suggestion is plain text; it
// goes into the editor as paragraphs and simple lists, nothing else.

export const ASSIST_CHOICES = [
  { key: 'improve', label: 'Fix spelling and grammar' },
  { key: 'shorter', label: 'Make it shorter' },
  { key: 'friendlier', label: 'Friendlier' },
  { key: 'formal', label: 'More formal' },
  { key: 'english', label: 'Translate to English' },
  { key: 'french', label: 'Translate to French' },
  { key: 'notes_to_reply', label: 'Turn my notes into a reply', replyOnly: true },
];

export const assistLabel = (key) => ASSIST_CHOICES.find((c) => c.key === key)?.label || 'Suggestion';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const BULLET = /^\s*[-*•]\s+/;
const NUMBER = /^\s*\d{1,2}[.)]\s+/;

/**
 * Plain text → the editor's HTML. Blank lines split paragraphs, single line
 * breaks stay line breaks, runs of "- " or "1. " lines become lists.
 * `inline: true` returns one line with no paragraph around it, for dropping
 * into the middle of a sentence.
 */
export function plainToHtml(text, { inline = false } = {}) {
  const clean = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!clean) return '';
  if (inline && !clean.includes('\n')) return esc(clean);
  const out = [];
  for (const block of clean.split(/\n{2,}/)) {
    const lines = block.split('\n');
    let run = [];
    let list = null; // { tag, items }
    const flushRun = () => { if (run.length) { out.push(`<p>${run.map(esc).join('<br>')}</p>`); run = []; } };
    const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${esc(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
    for (const line of lines) {
      const tag = BULLET.test(line) ? 'ul' : NUMBER.test(line) ? 'ol' : null;
      if (tag) {
        flushRun();
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push(line.replace(tag === 'ul' ? BULLET : NUMBER, ''));
      } else {
        flushList();
        run.push(line);
      }
    }
    flushRun();
    flushList();
  }
  return out.join('');
}

/** Formatting a plain-text rewrite cannot carry: say so before replacing. */
export function hasRichMarkup(html) {
  return /<(img|table|a\s|strong|b>|em>|i>|u>|pre|code|blockquote|h[1-6])|data-mention|tp-mention/i.test(String(html || ''));
}
