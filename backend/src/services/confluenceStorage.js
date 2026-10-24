/**
 * Confluence storage format -> Knowledge article HTML (QA 10-23 #4).
 *
 * Storage format is XHTML plus Confluence's own ac:/ri: elements. A small
 * tolerant parser builds a tree, the Confluence parts are rewritten into
 * plain HTML, and the result goes through the article sanitizer and the
 * Knowledge scrubber (piiScrubber: secrets, passwords, e-mail addresses,
 * phone numbers, IPs, names) before it is stored or shown to a model.
 *
 *   kept         headings, paragraphs, lists, tables, links, bold/italic, quotes
 *   code         code / noformat macros -> <pre><code> (text escaped)
 *   panels       info / note / tip / warning / panel -> a quote with its label
 *   expand       its title in bold, then its content
 *   layouts      sections and columns flattened, content kept
 *   tasks        task lists -> bullet lists
 *   page links   the link text (or the page title) as plain text
 *   images       NOT copied: a link "Picture: <file> (in Confluence)" to the
 *                attachment, or to the image's own address; opening it needs
 *                a Confluence sign-in
 *   dropped      every other macro (table of contents, Jira, include, children,
 *                user mentions, emoticons, status lozenges...) - named in
 *                `dropped` so the import can count them
 */
import sanitizeHtml from 'sanitize-html';
import { sanitizeArticleHtml, htmlToText } from './knowledgeArticleService.js';
import { scrubPii } from '../utils/piiScrubber.js';
import { EMAIL_SANITIZE_OPTIONS } from './notificationWorkflowSignatureService.js';

const VOID = new Set(['br', 'hr', 'img', 'col', 'input', 'meta', 'link', 'area', 'base', 'wbr', 'source', 'track', 'embed', 'param']);
const PANEL_LABELS = Object.freeze({ info: 'Info', note: 'Note', tip: 'Tip', warning: 'Warning', panel: null });
const UNWRAP_MACROS = new Set(['excerpt', 'section', 'column', 'details', 'div', 'span', 'align', 'center']);
const TOKEN_RE = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>|<!?[^>]*>/g;
const ATTR_RE = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

function parseAttrs(raw) {
  const out = {};
  if (!raw) return out;
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

/** Tolerant XHTML parse: a mismatched close tag closes back to its opener, or is ignored. */
export function parseStorage(xml) {
  const root = { type: 'el', name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const src = String(xml || '');
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(src))) {
    if (m.index > last) top().children.push({ type: 'text', value: src.slice(last, m.index) });
    last = TOKEN_RE.lastIndex;
    if (m[1] !== undefined) {
      top().children.push({ type: 'cdata', value: m[1] });
    } else if (m[2]) {
      const name = m[2].toLowerCase();
      const at = stack.map((n) => n.name).lastIndexOf(name);
      if (at > 0) stack.length = at;
    } else if (m[3]) {
      const node = { type: 'el', name: m[3].toLowerCase(), attrs: parseAttrs(m[4]), children: [] };
      top().children.push(node);
      if (!m[5] && !VOID.has(node.name)) stack.push(node);
    }
  }
  if (last < src.length) top().children.push({ type: 'text', value: src.slice(last) });
  return root;
}

const child = (node, name) => (node.children || []).find((c) => c.type === 'el' && c.name === name) || null;
const param = (node, name) => {
  const p = (node.children || []).find((c) => c.type === 'el' && c.name === 'ac:parameter' && String(c.attrs['ac:name'] || '').toLowerCase() === name);
  return p ? plainText(p).trim() : '';
};

/** Text content, entities left as written (CDATA escaped). */
function rawText(node) {
  if (node.type === 'text') return node.value;
  if (node.type === 'cdata') return escapeText(node.value);
  return (node.children || []).map(rawText).join('');
}

/** Text content, decoded enough to be an attribute or a label. */
function plainText(node) {
  return rawText(node).replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function attachmentUrl(ctx, filename) {
  if (!ctx.siteUrl || !ctx.pageId || !filename) return null;
  return `${ctx.siteUrl}/wiki/download/attachments/${encodeURIComponent(ctx.pageId)}/${encodeURIComponent(filename)}`;
}

function renderChildren(node, ctx) {
  return (node.children || []).map((c) => render(c, ctx)).join('');
}

function renderMacro(node, ctx) {
  const name = String(node.attrs['ac:name'] || '').toLowerCase();
  const body = child(node, 'ac:rich-text-body');
  const plain = child(node, 'ac:plain-text-body');
  if (name === 'code' || name === 'noformat') {
    const code = plain ? plain.children.map((c) => (c.type === 'cdata' ? escapeText(c.value) : c.type === 'text' ? c.value : '')).join('') : '';
    return code.trim() ? `<pre><code>${code}</code></pre>` : '';
  }
  if (Object.prototype.hasOwnProperty.call(PANEL_LABELS, name)) {
    const label = param(node, 'title') || PANEL_LABELS[name];
    const inner = body ? renderChildren(body, ctx) : '';
    if (!inner.trim()) return '';
    return `<blockquote>${label ? `<p><strong>${escapeText(label)}</strong></p>` : ''}${inner}</blockquote>`;
  }
  if (name === 'expand') {
    const title = param(node, 'title');
    const inner = body ? renderChildren(body, ctx) : '';
    return `${title ? `<p><strong>${escapeText(title)}</strong></p>` : ''}${inner}`;
  }
  if (UNWRAP_MACROS.has(name) && body) return renderChildren(body, ctx);
  ctx.dropped.push(name || 'unknown');
  return '';
}

function renderLink(node, ctx) {
  const body = child(node, 'ac:link-body');
  const plainBody = child(node, 'ac:plain-text-link-body');
  const page = child(node, 'ri:page');
  const attachment = child(node, 'ri:attachment');
  const url = child(node, 'ri:url');
  const text = body ? renderChildren(body, ctx) : plainBody ? escapeText(plainText(plainBody)) : '';
  if (child(node, 'ri:user')) return text; // a person mention: never the name of someone not passed in
  if (url?.attrs['ri:value']) return `<a href="${escapeAttr(url.attrs['ri:value'])}">${text || escapeText(url.attrs['ri:value'])}</a>`;
  if (attachment?.attrs['ri:filename']) {
    const href = attachmentUrl(ctx, attachment.attrs['ri:filename']);
    const label = text || escapeText(attachment.attrs['ri:filename']);
    return href ? `<a href="${escapeAttr(href)}">${label}</a>` : label;
  }
  if (page) return text || escapeText(page.attrs['ri:content-title'] || '');
  return text;
}

function renderImage(node, ctx) {
  ctx.images += 1;
  const attachment = child(node, 'ri:attachment');
  const url = child(node, 'ri:url');
  const alt = node.attrs['ac:alt'] || node.attrs['ac:title'] || '';
  if (attachment?.attrs['ri:filename']) {
    const href = attachmentUrl(ctx, attachment.attrs['ri:filename']);
    const label = `Picture: ${alt || attachment.attrs['ri:filename']} (in Confluence)`;
    return href ? ` <a href="${escapeAttr(href)}">${escapeText(label)}</a> ` : ` ${escapeText(label)} `;
  }
  if (url?.attrs['ri:value']) return ` <a href="${escapeAttr(url.attrs['ri:value'])}">${escapeText(`Picture${alt ? `: ${alt}` : ''}`)}</a> `;
  return '';
}

function render(node, ctx) {
  if (node.type === 'text') return node.value;
  if (node.type === 'cdata') return escapeText(node.value);
  const { name } = node;
  if (name === 'ac:structured-macro' || name === 'ac:macro') return renderMacro(node, ctx);
  if (name === 'ac:link') return renderLink(node, ctx);
  if (name === 'ac:image') return renderImage(node, ctx);
  if (name === 'ac:task-list') return `<ul>${renderChildren(node, ctx)}</ul>`;
  if (name === 'ac:task') {
    const body = child(node, 'ac:task-body');
    return body ? `<li>${renderChildren(body, ctx)}</li>` : '';
  }
  if (['ac:layout', 'ac:layout-section', 'ac:layout-cell', 'ac:rich-text-body', 'ac:inline-comment-marker', 'ac:link-body'].includes(name)) return renderChildren(node, ctx);
  if (name === 'time') return escapeText(node.attrs.datetime || plainText(node));
  if (name.startsWith('ac:') || name.startsWith('ri:')) {
    if (!['ac:parameter', 'ac:emoticon', 'ac:placeholder', 'ac:task-id', 'ac:task-status'].includes(name)) ctx.dropped.push(name.slice(3));
    return '';
  }
  if (name === '#root') return renderChildren(node, ctx);
  const attrs = Object.entries(node.attrs).filter(([k]) => !k.includes(':')).map(([k, v]) => ` ${k}="${escapeAttr(v.replace(/&amp;/g, '&'))}"`).join('');
  if (VOID.has(name)) return `<${name}${attrs}>`;
  return `<${name}${attrs}>${renderChildren(node, ctx)}</${name}>`;
}

/**
 * scrubPii trims each line; the parser hands text over in pieces (split at
 * entities), so the spaces around each piece and each line's indent (code)
 * are put back.
 */
export function scrubKeepingSpace(text) {
  return String(text ?? '').split('\n').map((line) => {
    const m = line.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return m[2] ? `${m[1]}${scrubPii(m[2])}${m[3]}` : line;
  }).join('\n');
}

/**
 * Run the Knowledge scrubber over every text node and drop any link whose
 * address the scrubber would change (a token in a URL). Input must already
 * be sanitized article HTML.
 */
export function scrubArticleHtml(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: [...new Set([...EMAIL_SANITIZE_OPTIONS.allowedTags, 'h4'])],
    allowedAttributes: EMAIL_SANITIZE_OPTIONS.allowedAttributes,
    allowedSchemes: EMAIL_SANITIZE_OPTIONS.allowedSchemes,
    allowedSchemesByTag: EMAIL_SANITIZE_OPTIONS.allowedSchemesByTag,
    textFilter: (text) => scrubKeepingSpace(text),
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href || '';
        if (href && scrubPii(href) !== href) {
          const rest = { ...attribs };
          delete rest.href;
          return { tagName, attribs: rest };
        }
        return { tagName, attribs };
      },
    },
  }).trim();
}

/**
 * Storage XHTML -> clean, scrubbed article HTML.
 * @returns {{ html: string, text: string, dropped: string[], images: number, words: number }}
 */
export function storageToArticleHtml(storage, { siteUrl = null, pageId = null } = {}) {
  const ctx = { siteUrl, pageId: pageId ? String(pageId) : null, dropped: [], images: 0 };
  const raw = render(parseStorage(storage), ctx);
  const html = scrubArticleHtml(sanitizeArticleHtml(raw));
  const text = htmlToText(html);
  return { html, text, dropped: [...new Set(ctx.dropped)], images: ctx.images, words: countWords(text) };
}

export function countWords(text) {
  const m = String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

/** Words in a storage body without converting it (hierarchy counts). */
export function storageWords(storage) {
  const text = String(storage || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, ' $1 ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
  return countWords(text);
}
