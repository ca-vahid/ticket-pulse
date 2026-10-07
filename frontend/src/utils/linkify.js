/**
 * Clickable links in ticket bodies (QA 10-06 #8). A URL pasted into a
 * description or a message was plain text. linkifyHtml() walks the text of
 * already-sanitised HTML and wraps web addresses in links that open in a new
 * tab. Long addresses show as host + path, cut with "…"; the full address is
 * the link's tooltip. Text already inside a link, code or pre is left alone.
 */

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const SKIP_TAGS = new Set(['A', 'CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'BUTTON']);
const MAX_LABEL = 48;

/** Trailing punctuation belongs to the sentence, not the address. */
function trimUrl(raw) {
  let url = raw;
  for (;;) {
    const last = url.slice(-1);
    if (/[.,;:!?'"]/.test(last)) { url = url.slice(0, -1); continue; }
    // A closing bracket only belongs to the URL when it opened one.
    if (last === ')' && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) { url = url.slice(0, -1); continue; }
    if (last === ']' && (url.match(/\[/g) || []).length < (url.match(/]/g) || []).length) { url = url.slice(0, -1); continue; }
    break;
  }
  return url;
}

/** "https://www.amazon.ca/Dell-Power…/dp/B0F…?crid=…" → "amazon.ca/Dell-Power-Adapter-7-4mm-Factor/dp/B0…" */
export function shortLinkLabel(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const host = u.hostname.replace(/^www\./i, '');
    const path = u.pathname === '/' ? '' : decodeURI(u.pathname).replace(/\/$/, '');
    const label = `${host}${path}`;
    const hasMore = Boolean(u.search || u.hash);
    if (label.length > MAX_LABEL) return `${label.slice(0, MAX_LABEL - 1)}…`;
    if (url.length > MAX_LABEL && hasMore) return `${label}…`;
    return url.length > MAX_LABEL ? label : url;
  } catch {
    return url.length > MAX_LABEL ? `${url.slice(0, MAX_LABEL - 1)}…` : url;
  }
}

function linkifyTextNode(node, doc) {
  const text = node.nodeValue;
  URL_RE.lastIndex = 0;
  if (!URL_RE.test(text)) return;
  URL_RE.lastIndex = 0;
  const frag = doc.createDocumentFragment();
  let last = 0;
  let m;
  while ((m = URL_RE.exec(text))) {
    const url = trimUrl(m[0]);
    if (!url || url.length < 8) continue;
    if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const a = doc.createElement('a');
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    a.setAttribute('title', href);
    a.setAttribute('data-autolink', '');
    a.textContent = shortLinkLabel(url);
    frag.appendChild(a);
    last = m.index + url.length;
    URL_RE.lastIndex = last;
  }
  if (last === 0) return;
  if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
  node.parentNode.replaceChild(frag, node);
}

/** Wrap bare URLs in already-sanitised HTML. Returns the HTML unchanged when there are none. */
export function linkifyHtml(html) {
  const source = String(html || '');
  if (!/(?:https?:\/\/|www\.)/i.test(source) || typeof document === 'undefined') return source;
  const tpl = document.createElement('template');
  tpl.innerHTML = source;
  const doc = tpl.content.ownerDocument || document;
  const walker = doc.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      for (let p = n.parentNode; p && p !== tpl.content; p = p.parentNode) {
        if (SKIP_TAGS.has(p.nodeName)) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach((n) => linkifyTextNode(n, doc));
  return tpl.innerHTML;
}
