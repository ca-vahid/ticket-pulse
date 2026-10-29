import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { Bold, Code, Heading2, Heading3, Italic, Link2, List, ListOrdered, Maximize2, Minimize2, Pilcrow, RemoveFormatting, SquareCode, TextQuote, Underline } from 'lucide-react';

const ALLOWED = {
  ALLOWED_TAGS: [
    'b', 'strong', 'i', 'em', 'u', 'p', 'br', 'div', 'ul', 'ol', 'li', 'a',
    // Code and quotes (25 Oct 2026): a pasted script lost its block and every
    // line break, so a PowerShell fix became one long paragraph. The server's
    // allowlist (sanitize-html defaults) already keeps these.
    'pre', 'code', 'blockquote', 'hr', 's',
    // Rich paste (QA 08-14 #1/#2): Excel ranges + Outlook signatures arrive as
    // tables/spans/imgs — keep the structure. Mirrors backend htmlContent.js's
    // table vocabulary and the server's EMAIL_SANITIZE_OPTIONS.
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col', 'caption', 'span', 'img',
  ],
  // `class` is allowed but filtered to the tp-* namespace in the hook below —
  // our own markers (tp-data-table on pasted tables, QA 08-17 #1) survive
  // re-sanitize/re-edit while Office classes (xl65, MsoNormal) are dropped.
  ALLOWED_ATTR: ['href', 'target', 'rel', 'colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'style', 'src', 'alt', 'class'],
  // DOMPurify runs EVERY attribute value through this, so the non-URI
  // alternatives (bare numbers like colspan="2", scheme-less words) must stay.
  // Schemes: http/https/mailto plus data:image (javascript:, data:text/html
  // etc fail every branch); img src is further constrained in the hook below.
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
};

// Inline-style allowlist: presentational table/text props only. Everything
// else — position/behavior props and any url()/expression() value — is
// stripped, so a pasted style can't phone home or overlay the app.
// `margin` and `line-height` earn their place here (QA 09-08): an Outlook
// signature is a stack of `<p class=MsoNormal style='margin:0'>` lines, and
// dropping the margin (the class goes too) left bare <p> elements that every
// mail client then pads with its own ~1em paragraph margin — a signature that
// is tight in Outlook went out looking loose. Negative values are rejected
// below, which is the only part of `margin` that could overlay app chrome.
const ALLOWED_STYLE_PROP_RE = /^(?:border(?:-[a-z-]+)?|background(?:-color)?|color|text-align|font-weight|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|line-height|width)$/;

// Dedicated DOMPurify instance: ticketUi.jsx installs a global hook on the
// shared one (cid-image removal for rendered emails) — the composer's much
// stricter style/img rules must not leak onto rendered thread bodies.
const purifier = typeof window !== 'undefined' ? DOMPurify(window) : DOMPurify;

purifier.addHook('afterSanitizeAttributes', (node) => {
  if (node.hasAttribute && node.hasAttribute('style')) {
    const kept = String(node.getAttribute('style') || '')
      .split(';')
      .map((decl) => {
        const sep = decl.indexOf(':');
        if (sep < 1) return null;
        const prop = decl.slice(0, sep).trim().toLowerCase();
        let value = decl.slice(sep + 1).trim();
        if (!prop || !value || !ALLOWED_STYLE_PROP_RE.test(prop)) return null;
        if (/url\s*\(|expression\s*\(/i.test(value)) return null;
        // A negative margin can drag pasted content over the app's own chrome;
        // nothing legitimate in an email signature needs one.
        if (prop.startsWith('margin') && /-\s*\d/.test(value)) return null;
        // Normalize Office-isms so pasted borders actually render (QA 08-17
        // #1): `windowtext` is an IE system color browsers/email clients don't
        // paint, and Excel's hairline `.5pt` widths round down to nothing.
        value = value
          .replace(/\bwindowtext\b/gi, '#000')
          .replace(/(\d*\.?\d+)pt\b/g, (m, n) => (parseFloat(n) < 1 ? '1px' : m));
        return `${prop}: ${value}`;
      })
      .filter(Boolean)
      .join('; ');
    if (kept) node.setAttribute('style', kept);
    else node.removeAttribute('style');
  }
  // Class allowlist: only our own tp-* markers survive — pasted Office class
  // soup (xl65, MsoNormal, WordSection1…) is dropped with its dead styling.
  if (node.hasAttribute && node.hasAttribute('class')) {
    const kept = String(node.getAttribute('class') || '')
      .split(/\s+/)
      .filter((cls) => /^tp-[\w-]+$/.test(cls));
    if (kept.length) node.setAttribute('class', kept.join(' '));
    else node.removeAttribute('class');
  }
  if (node.tagName === 'IMG' && !/^(?:https:|data:image\/)/i.test(node.getAttribute('src') || '')) {
    node.remove();
  }
  // Code keeps our own look: a source's dark theme or syntax colours would be
  // light text on our light block (and on the requester's white mail).
  if ((node.tagName === 'PRE' || node.tagName === 'CODE' || node.closest?.('pre')) && node.hasAttribute?.('style')) {
    node.removeAttribute('style');
  }
});

// Knowledge articles (QA 09-25 K1): section headings are the structure
// Auto-help splits on, so the article editor keeps h2-h4. The ticket reply
// composer never passes `headings` and keeps the exact reply vocabulary.
const ALLOWED_WITH_HEADINGS = { ...ALLOWED, ALLOWED_TAGS: [...ALLOWED.ALLOWED_TAGS, 'h2', 'h3', 'h4'] };

export function sanitizeRichHtml(html, { headings = false } = {}) {
  return purifier.sanitize(String(html || ''), headings ? ALLOWED_WITH_HEADINGS : ALLOWED);
}

/**
 * MSO clean pre-pass for pasted markup (Word/Outlook signatures + Excel
 * ranges share the shape): conditional comments, Office namespace tags and
 * truly-empty spans go away; mso-* style declarations die in the style
 * allowlist above. Run BEFORE sanitizeRichHtml on clipboard HTML.
 *
 * QA 08-17 #1 (rendered table borders): real Excel clipboard HTML carries its
 * cell borders in a <style> block (`.xl65{border:.5pt solid windowtext}`) and
 * `class=xl65` hooks — never inline — so the border info used to die right
 * here at paste. Two DOM passes fix it:
 *  - class rules from <style> blocks are folded into the matching elements'
 *    inline styles (existing inline declarations still win), preserving
 *    Excel's per-cell/partial borders through sanitization;
 *  - every clipboard-born <table> is stamped `tp-data-table`, the tp-*
 *    class the sanitizer keeps and `.tp-rich-body` styles at render time.
 */
/**
 * Pictures that arrive INSIDE pasted HTML (18 Sep 2026). A screenshot on the
 * clipboard is a file and already becomes an attachment, but copying from an
 * Outlook e-mail or a Word document puts `<img src="data:image/…;base64,…">`
 * in the markup instead — no file item at all. Those survived the paste as
 * inline data and turned a two-line note into a megabyte of HTML: past the
 * server's 200 000-character body limit, or past the 1 MB upload field limit.
 * A Field Equipment agent hit both in one minute and gave up.
 *
 * Pull each embedded picture out and leave a `[[TPIMG:n]]` token where it was.
 * The token is plain text, so it survives sanitising; the paste handler then
 * swaps it for the staged attachment's name, exactly as a pasted file gets.
 */
const INLINE_IMAGE_RE = /<img\b[^>]*?\bsrc\s*=\s*(["'])(data:image\/(png|jpe?g|gif|webp|bmp);base64,([A-Za-z0-9+/=\s]+))\1[^>]*>/gi;
// With no host to stage attachments, a small picture may stay inline; a large one is named, not kept.
export const INLINE_IMAGE_KEEP_BYTES = 60 * 1024;

export function extractInlineImages(html) {
  const images = [];
  const out = String(html || '').replace(INLINE_IMAGE_RE, (_m, _q, dataUri, ext, b64) => {
    const clean = b64.replace(/\s+/g, '');
    const type = ext.toLowerCase().startsWith('jp') ? 'jpeg' : ext.toLowerCase();
    images.push({ mime: `image/${type}`, base64: clean, dataUri: `data:image/${type};base64,${clean}`, ext: type === 'jpeg' ? 'jpg' : type });
    return `[[TPIMG:${images.length - 1}]]`;
  });
  return { html: out, images };
}

/** base64 → File, so an embedded picture stages through the same path as a pasted screenshot. */
export function inlineImageToFile(image, index = 0) {
  const bin = atob(image.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], `pasted-image-${index + 1}.${image.ext}`, { type: image.mime });
}

export function cleanPastedHtml(html) {
  let out = String(html || '');
  // Excel guards its <style> content in legacy comment markers
  // (<style><!-- .xl65{…} --></style>) — unwrap them FIRST or the comment
  // strip below would eat the border rules before the fold-in pass runs.
  out = out.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, open, css, close) => open + css.replace(/<!--|-->/g, '') + close);
  // Downlevel-hidden conditional blocks (<!--[if gte mso 9]>…<![endif]-->).
  out = out.replace(/<!--\[if[\s\S]*?<!\[endif\]\s*-->/gi, '');
  // Any remaining comments (Word litters <!--StartFragment--> etc).
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  // Downlevel-revealed markers (<![if !vml]>…<![endif]>) — keep the content,
  // it's the standards-mode fallback; only the markers go.
  out = out.replace(/<!\[(?:if|endif)[^\]]*\]>/gi, '');
  // Office namespace tags (<o:p>, <v:shape>, <w:*>…) — unwrap, keep children.
  out = out.replace(/<\/?[ovwx]:[a-z][^>]*>/gi, '');
  // Truly-empty spans (Word emits piles of them once the mso styles are gone).
  let prev;
  do {
    prev = out;
    out = out.replace(/<span[^>]*><\/span>/gi, '');
  } while (out !== prev);

  // DOM passes only when the clipboard actually carries tables or CSS —
  // plain-ish pastes keep the cheap string-only path.
  if (typeof DOMParser !== 'undefined' && /<(?:table|style)\b|white-space\s*:\s*pre/i.test(out)) {
    const doc = new DOMParser().parseFromString(out, 'text/html');

    // Code editors (VS Code, Visual Studio) copy a dark <div style="white-space: pre">
    // with one <div> per line and coloured spans. That style does not survive
    // sanitising, so the indentation collapsed: rebuild it as a plain code block.
    for (const el of Array.from(doc.body.querySelectorAll('[style]'))) {
      // Monospaced too: an e-mail paragraph with pre-wrap is prose, not code.
      const style = el.getAttribute('style') || '';
      if (!/white-space\s*:\s*pre/i.test(style) || !/font-family\s*:[^;]*(?:mono|consolas|courier|menlo|cascadia)/i.test(style) || el.closest('pre')) continue;
      if (!el.isConnected || el.parentElement?.closest('[style*="white-space"]')) continue;
      const lines = Array.from(el.children).every((c) => /^(?:DIV|P)$/.test(c.tagName)) && el.children.length > 0
        ? Array.from(el.children).map((c) => c.textContent)
        : [el.textContent];
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = lines.join('\n');
      pre.appendChild(code);
      el.replaceWith(pre);
    }

    // Fold simple `.class { … }` / `td.class { … }` rules into inline styles.
    // Naive on purpose: Excel/Word emit flat single-class selectors; anything
    // fancier is skipped and simply dies with the <style> block as before.
    const classRules = new Map();
    for (const styleEl of doc.querySelectorAll('style')) {
      const css = String(styleEl.textContent || '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const decls = rule[2].trim().replace(/;\s*$/, '');
        if (!decls) continue;
        for (const rawSelector of rule[1].split(',')) {
          const match = /^[a-z]{0,10}\.([A-Za-z_][\w-]*)$/i.exec(rawSelector.trim());
          if (!match) continue;
          classRules.set(match[1], `${classRules.get(match[1]) || ''}${decls};`);
        }
      }
      styleEl.remove();
    }
    if (classRules.size > 0) {
      for (const el of doc.body.querySelectorAll('[class]')) {
        let fromClasses = '';
        for (const cls of el.classList) fromClasses += classRules.get(cls) || '';
        if (fromClasses) {
          // Class declarations go FIRST so the element's own inline style,
          // parsed later, keeps winning — same precedence as real CSS.
          el.setAttribute('style', fromClasses + (el.getAttribute('style') || ''));
        }
      }
    }

    for (const table of doc.body.querySelectorAll('table')) table.classList.add('tp-data-table');
    out = doc.body.innerHTML;
  }
  return out;
}

/** True when the html carries formatting worth sending as bodyHtml. */
export function isRichContent(html) {
  return /<(b|strong|i|em|u|ul|ol|li|a|table|img|pre|code|blockquote|hr|s)\b/i.test(String(html || ''));
}

const BLOCK_TAGS = /^(P|DIV|LI|H[1-6]|BLOCKQUOTE|PRE|TR|SECTION|ARTICLE)$/;

/**
 * Plain text from editor HTML the way a mail client reads it: every block is
 * one paragraph, <br> is one line break, an EMPTY paragraph is one blank line.
 * The browser's innerText counts a <p> boundary as two breaks, so a single
 * blank line between paragraphs became five newlines — and five <br/>s in the
 * requester's mail (QA 09-22 #1). Runs of three or more newlines collapse to a
 * blank line; list items get a dash.
 */
function decodeEntities(value) {
  if (!value.includes('&')) return value;
  const box = document.createElement('textarea');
  box.innerHTML = value;
  return box.value;
}

export function htmlToPlainText(html) {
  const source = String(html || '');
  if (!source) return '';
  // A body with no tags is still the editor's HTML: "quote&nbsp;" must
  // leave as "quote " (QA 10-14 #4, an internal note showed the code).
  if (!/<[a-z][\s\S]*>/i.test(source)) return decodeEntities(source).replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trimEnd();
  const rootEl = document.createElement('div');
  rootEl.innerHTML = source;
  const out = [];
  const endsWithBreak = () => out.length > 0 && out[out.length - 1].endsWith('\n');
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { out.push(child.nodeValue.replace(/\u00a0/g, ' ')); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (tag === 'BR') { out.push('\n'); continue; }
      if (tag === 'STYLE' || tag === 'SCRIPT') continue;
      if (BLOCK_TAGS.test(tag)) {
        if (out.length && !endsWithBreak()) out.push('\n');
        const before = out.length;
        if (tag === 'LI') out.push('- ');
        walk(child);
        // "<p><br></p>" is one blank line, not a line break AND a paragraph end.
        const produced = out.slice(before).join('');
        if (produced === '\n') out.length = before;
        out.push('\n');
        continue;
      }
      walk(child);
    }
  };
  walk(rootEl);
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function textToHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text || '');
  return div.innerHTML.replace(/\n/g, '<br>');
}

/**
 * Minimal sanitized rich-text editor (bold/italic/underline/lists/links) for
 * replies and descriptions. Emits { html, text } — html is DOMPurify-clean.
 * Semi-controlled: pass value to reset content (draft restore / clear).
 */
const RichTextEditor = forwardRef(function RichTextEditor({
  value = '',
  onChange,
  onSubmit,
  placeholder = 'Write…',
  ariaLabel = 'Rich text editor',
  className = 'border-input bg-card',
  minHeight = 170,
  onImagePaste,
  // Article editor only: Normal / Section heading / Subheading block controls.
  headings = false,
  // Read-only content shown inside the frame, straight under the editable area
  // (the reply composer's signature). Never part of the emitted html.
  footer = null,
  // Full-screen writing (25 Oct 2026): the host owns the state and the overlay;
  // the editor grows to fill it and shows the toggle when onToggleExpand is given.
  expanded = false,
  onToggleExpand = null,
  // @mentions (29 Oct 2026): people offered after "@" ({ id, name }), and the
  // host's callback when one is picked. Without them "@" is just a character.
  mentionPeople = null,
  onMention = null,
}, ref) {
  const editorRef = useRef(null);
  const frameRef = useRef(null);
  // The open "@" menu: the typed query, where it sits, and the highlighted row.
  const [mention, setMention] = useState(null);
  const mentionCtxRef = useRef(null);
  const lastEmittedRef = useRef(null);
  const savedRangeRef = useRef(null);
  const [isEmpty, setIsEmpty] = useState(true);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [block, setBlock] = useState('p');
  const sanitize = (html) => sanitizeRichHtml(html, { headings });

  // Which block the caret sits in, so the heading buttons show their state.
  useEffect(() => {
    if (!headings) return undefined;
    const onSelection = () => {
      const el = editorRef.current;
      const sel = window.getSelection();
      if (!el || !sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return;
      let node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
      let tag = 'p';
      while (node && node !== el) {
        if (/^H[2-4]$/.test(node.tagName)) { tag = node.tagName.toLowerCase(); break; }
        node = node.parentElement;
      }
      setBlock(tag);
    };
    document.addEventListener('selectionchange', onSelection);
    return () => document.removeEventListener('selectionchange', onSelection);
  }, [headings]);

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
  }), []);

  // Adopt external value changes (draft restore, clear-after-send).
  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    const el = editorRef.current;
    if (!el) return;
    const html = /<[a-z][\s\S]*>/i.test(value) ? sanitize(value) : textToHtml(value);
    el.innerHTML = html;
    lastEmittedRef.current = value;
    setIsEmpty(!el.textContent.trim());
  }, [value]);

  // QA 10-13 #2: a pasted picture shows in the editor as a small preview. What the editor
  // hands on (and what is stored and mailed) is unchanged: the marker "[Image: name]" at that
  // spot, with the picture itself as an attached file.
  const thumbUrlsRef = useRef([]);
  useEffect(() => () => {
    thumbUrlsRef.current.forEach((url) => { try { URL.revokeObjectURL(url); } catch { /* nothing to release */ } });
    thumbUrlsRef.current = [];
  }, []);
  const pastedPictureHtml = (label, src) => {
    const esc = document.createElement('div');
    esc.textContent = label;
    const name = esc.innerHTML.replace(/"/g, '&quot;');
    if (!src) return `&nbsp;<i>[Image:&nbsp;${esc.innerHTML}]</i>&nbsp;`;
    return `&nbsp;<img class="tp-editor-thumb" data-tp-img="${name}" alt="[Image: ${name}]" title="${name}" src="${src}">&nbsp;`;
  };
  const previewUrlFor = (file) => {
    try {
      const url = URL.createObjectURL(file);
      thumbUrlsRef.current.push(url);
      return url;
    } catch {
      return null; // no preview: the marker text is used, as before
    }
  };
  const editorHtml = (el) => {
    if (!el.querySelector('img[data-tp-img]')) return el.innerHTML;
    const copy = el.cloneNode(true);
    copy.querySelectorAll('img[data-tp-img]').forEach((img) => {
      const marker = document.createElement('i');
      marker.textContent = `[Image: ${img.getAttribute('data-tp-img')}]`;
      img.replaceWith(marker);
    });
    return copy.innerHTML;
  };

  const emit = () => {
    const el = editorRef.current;
    if (!el) return;
    const html = sanitize(editorHtml(el));
    const text = htmlToPlainText(html);
    lastEmittedRef.current = html;
    setIsEmpty(!el.textContent.trim() && !el.querySelector('img[data-tp-img]'));
    onChange?.({ html, text });
  };

  // ── @mentions (29 Oct 2026) ──
  const mentionsOn = Array.isArray(mentionPeople) && mentionPeople.length > 0 && typeof onMention === 'function';
  const mentionMatches = (() => {
    if (!mention || !mentionsOn) return [];
    const q = mention.query.toLowerCase();
    return mentionPeople
      .filter((p) => p?.name && (!q || String(p.name).toLowerCase().split(/\s+/).some((word) => word.startsWith(q)) || String(p.name).toLowerCase().startsWith(q)))
      .slice(0, 6);
  })();
  // After each keystroke: is the caret right after "@word"? Then show the menu.
  const updateMention = () => {
    if (!mentionsOn) return;
    const el = editorRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0 || !sel.isCollapsed) { setMention(null); return; }
    const node = sel.anchorNode;
    if (!node || node.nodeType !== 3 || !el.contains(node) || node.parentElement?.closest('pre, code, .tp-mention')) { setMention(null); return; }
    const before = node.nodeValue.slice(0, sel.anchorOffset);
    const m = before.match(/(?:^|[\s(])@([^\s@]{0,30})$/);
    if (!m) { setMention(null); return; }
    mentionCtxRef.current = { node, offset: sel.anchorOffset, query: m[1] };
    let top = 0;
    let left = 0;
    try {
      const caret = sel.getRangeAt(0).getBoundingClientRect();
      const frame = frameRef.current?.getBoundingClientRect();
      if (frame && caret && (caret.top || caret.left)) {
        top = caret.bottom - frame.top + 4;
        left = Math.max(0, Math.min(caret.left - frame.left, frame.width - 240));
      }
    } catch { /* jsdom and odd selections: the menu sits at the top left */ }
    setMention((prev) => ({ query: m[1], top, left, index: prev && prev.query === m[1] ? prev.index : 0 }));
  };
  const pickMention = (person) => {
    const ctx = mentionCtxRef.current;
    const el = editorRef.current;
    setMention(null);
    if (!ctx || !el || !person || !ctx.node.isConnected) return;
    const start = ctx.offset - ctx.query.length - 1;
    if (start < 0 || ctx.node.nodeValue.slice(start, start + 1) !== '@') return;
    el.focus();
    const range = document.createRange();
    range.setStart(ctx.node, start);
    range.setEnd(ctx.node, ctx.offset);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertHTML', false, `<strong class="tp-mention">@${escapeText(person.name)}</strong>&nbsp;`);
    mentionCtxRef.current = null;
    emit();
    onMention(person);
  };
  // Arrow keys, Enter/Tab and Esc drive the open menu. True when the key was used.
  const onMentionKey = (e) => {
    if (!mention || !mentionMatches.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setMention((prev) => (prev ? { ...prev, index: (prev.index + step + mentionMatches.length) % mentionMatches.length } : prev));
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      pickMention(mentionMatches[Math.min(mention.index, mentionMatches.length - 1)]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setMention(null);
      return true;
    }
    return false;
  };

  const exec = (command, arg = null) => {
    editorRef.current?.focus();
    document.execCommand(command, false, arg);
    emit();
  };

  // Pressing the active heading again turns the line back into a paragraph.
  const setBlockTag = (tag) => {
    const next = tag !== 'p' && block === tag ? 'p' : tag;
    exec('formatBlock', `<${next}>`);
    setBlock(next);
  };

  // ── Code blocks, inline code, quotes (25 Oct 2026) ──
  const escapeText = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  };
  // The nearest <tag> around the caret, inside this editor only.
  const caretWithin = (tagName) => {
    const el = editorRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return null;
    let node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    while (node && node !== el) {
      if (node.tagName === tagName) return node;
      node = node.parentElement;
    }
    return null;
  };
  // A code block's text with its <br>s as line breaks.
  const codeText = (node) => {
    const copy = node.cloneNode(true);
    copy.querySelectorAll?.('br').forEach((br) => br.replaceWith('\n'));
    return copy.textContent;
  };
  const caretTo = (node, atEnd = true) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(!atEnd);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  // A block at the very end leaves nowhere to type after it: keep a paragraph there.
  const ensureTrailingParagraph = () => {
    const el = editorRef.current;
    if (!el) return;
    if (/^(?:PRE|BLOCKQUOTE)$/.test(el.lastElementChild?.tagName || '')) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      el.appendChild(p);
    }
  };

  // Focus the editor without losing what the agent had selected in it.
  const focusKeepingSelection = (el) => {
    const sel = window.getSelection();
    const saved = sel && sel.rangeCount > 0 && el.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    el.focus();
    if (saved) {
      sel.removeAllRanges();
      sel.addRange(saved);
    }
  };

  // Chrome's insertHTML stamps the editor's own text colour on what it inserts
  // (style="color: rgb(15, 23, 41)"). That is the theme's colour, not the
  // author's: pasted in light mode it reads near-black in dark mode, and the
  // other way round. Drop exactly that colour; a real author colour stays.
  const dropEchoedColor = () => {
    const el = editorRef.current;
    if (!el || typeof window.getComputedStyle !== 'function') return;
    const own = window.getComputedStyle(el).color;
    if (!own) return;
    el.querySelectorAll('[style*="color"]').forEach((node) => {
      if (node.style.color && node.style.color.replace(/\s+/g, '') === own.replace(/\s+/g, '')) {
        node.style.removeProperty('color');
        if (!node.getAttribute('style')?.trim()) node.removeAttribute('style');
        if (node.tagName === 'SPAN' && node.attributes.length === 0) node.replaceWith(...node.childNodes);
      }
    });
  };

  const toggleCodeBlock = () => {
    const el = editorRef.current;
    if (!el) return;
    focusKeepingSelection(el);
    const pre = caretWithin('PRE');
    if (pre) {
      // Out of the block: each line becomes a paragraph again.
      const lines = codeText(pre).replace(/\n$/, '').split('\n');
      const frag = document.createDocumentFragment();
      lines.forEach((line) => {
        const p = document.createElement('p');
        if (line) p.textContent = line; else p.appendChild(document.createElement('br'));
        frag.appendChild(p);
      });
      const first = frag.firstChild;
      pre.replaceWith(frag);
      if (first) caretTo(first);
      emit();
      return;
    }
    const sel = window.getSelection();
    let text = '';
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed && el.contains(sel.anchorNode)) {
      const holder = document.createElement('div');
      holder.appendChild(sel.getRangeAt(0).cloneContents());
      text = htmlToPlainText(holder.innerHTML);
    }
    document.execCommand('insertHTML', false, `<pre data-tp-new="1"><code>${text ? escapeText(text) : '<br>'}</code></pre><p><br></p>`);
    const added = el.querySelector('pre[data-tp-new]');
    if (added) {
      added.removeAttribute('data-tp-new');
      caretTo(added.querySelector('code') || added);
    }
    ensureTrailingParagraph();
    emit();
  };

  const toggleInlineCode = () => {
    const el = editorRef.current;
    if (!el) return;
    focusKeepingSelection(el);
    const code = caretWithin('CODE');
    if (code && !code.closest('pre')) {
      const text = document.createTextNode(code.textContent);
      code.replaceWith(text);
      caretTo(text);
      emit();
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const text = sel.isCollapsed ? '' : sel.toString();
    // Nothing selected: insert a placeholder word, selected, so typing replaces it.
    document.execCommand('insertHTML', false, `<code data-tp-new="1">${escapeText(text || 'code')}</code>&nbsp;`);
    const added = el.querySelector('code[data-tp-new]');
    if (added) {
      added.removeAttribute('data-tp-new');
      if (!text) {
        const range = document.createRange();
        range.selectNodeContents(added);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    emit();
  };

  const toggleQuote = () => {
    exec('formatBlock', caretWithin('BLOCKQUOTE') ? '<p>' : '<blockquote>');
    ensureTrailingParagraph();
  };

  // Keys inside a code block: Tab indents, and Enter on an empty last line leaves the block.
  const onCodeKey = (e, pre) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
      emit();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return;
    const caret = sel.getRangeAt(0);
    const after = document.createRange();
    after.selectNodeContents(pre);
    after.setStart(caret.endContainer, caret.endOffset);
    const before = document.createRange();
    before.selectNodeContents(pre);
    before.setEnd(caret.startContainer, caret.startOffset);
    const holder = document.createElement('div');
    holder.appendChild(before.cloneContents());
    const textBefore = codeText(holder);
    if (after.toString() !== '' || !/\n$/.test(textBefore)) return;
    // Second Enter at the end: drop the empty line and move below the block.
    e.preventDefault();
    const host = pre.querySelector('code') || pre;
    const last = host.lastChild;
    if (last?.nodeName === 'BR') last.remove();
    else if (last?.nodeType === 3) last.nodeValue = last.nodeValue.replace(/\n$/, '');
    let next = pre.nextElementSibling;
    if (!next) {
      next = document.createElement('p');
      next.appendChild(document.createElement('br'));
      pre.after(next);
    }
    caretTo(next, false);
    emit();
  };

  const openLink = () => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) savedRangeRef.current = selection.getRangeAt(0).cloneRange();
    setLinkUrl('');
    setLinkOpen(true);
  };

  const applyLink = () => {
    const url = linkUrl.trim();
    setLinkOpen(false);
    if (!url) return;
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const selection = window.getSelection();
    if (savedRangeRef.current && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRangeRef.current);
    }
    editorRef.current?.focus();
    if (selection && selection.isCollapsed) {
      document.execCommand('insertHTML', false, `<a href="${href}" target="_blank" rel="noreferrer">${href}</a>`);
    } else {
      document.execCommand('createLink', false, href);
    }
    emit();
  };

  // With a footer the frame, not the editable area, is the tall click target:
  // a click on its empty space puts the caret at the end of the message.
  const focusEnd = () => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const toolBtn = 'tp-focus-ring p-1.5 rounded-md text-muted-foreground hover:text-blue-700 dark:hover:text-blue-200 hover:bg-blue-50 dark:hover:bg-blue-500/15';
  const blockOn = 'bg-muted text-foreground';

  return (
    <div className={`${expanded ? 'flex flex-col flex-1 min-h-0 ' : ''}border rounded-lg transition-colors focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100 dark:focus-within:ring-blue-500/30 ${className}`}>
      <div className="flex flex-wrap items-center gap-0.5 px-1.5 py-1 border-b border-border/60 relative" role="toolbar" aria-label="Formatting">
        {headings && (
          <>
            <button type="button" onClick={() => setBlockTag('p')} title="Normal text" aria-label="Normal text" aria-pressed={block === 'p'} className={`${toolBtn} ${block === 'p' ? blockOn : ''}`}><Pilcrow className="w-3.5 h-3.5" aria-hidden="true" /></button>
            <button type="button" onClick={() => setBlockTag('h2')} title="Section heading (Auto-help reads each section on its own)" aria-label="Section heading" aria-pressed={block === 'h2'} className={`${toolBtn} ${block === 'h2' ? blockOn : ''}`}><Heading2 className="w-3.5 h-3.5" aria-hidden="true" /></button>
            <button type="button" onClick={() => setBlockTag('h3')} title="Subheading" aria-label="Subheading" aria-pressed={block === 'h3'} className={`${toolBtn} ${block === 'h3' ? blockOn : ''}`}><Heading3 className="w-3.5 h-3.5" aria-hidden="true" /></button>
            <span className="w-px h-4 bg-secondary mx-1" aria-hidden="true" />
          </>
        )}
        <button type="button" onClick={() => exec('bold')} title="Bold (Ctrl+B)" aria-label="Bold" className={toolBtn}><Bold className="w-3.5 h-3.5" aria-hidden="true" /></button>
        <button type="button" onClick={() => exec('italic')} title="Italic (Ctrl+I)" aria-label="Italic" className={toolBtn}><Italic className="w-3.5 h-3.5" aria-hidden="true" /></button>
        <button type="button" onClick={() => exec('underline')} title="Underline (Ctrl+U)" aria-label="Underline" className={toolBtn}><Underline className="w-3.5 h-3.5" aria-hidden="true" /></button>
        <span className="w-px h-4 bg-secondary mx-1" aria-hidden="true" />
        <button type="button" onClick={() => exec('insertUnorderedList')} title="Bulleted list" aria-label="Bulleted list" className={toolBtn}><List className="w-3.5 h-3.5" aria-hidden="true" /></button>
        <button type="button" onClick={() => exec('insertOrderedList')} title="Numbered list" aria-label="Numbered list" className={toolBtn}><ListOrdered className="w-3.5 h-3.5" aria-hidden="true" /></button>
        <span className="w-px h-4 bg-secondary mx-1" aria-hidden="true" />
        <button type="button" onClick={toggleQuote} title="Quote" aria-label="Quote" className={toolBtn}><TextQuote className="w-3.5 h-3.5" aria-hidden="true" /></button>
        <button type="button" onClick={toggleInlineCode} title="Inline code" aria-label="Inline code" className={toolBtn}><Code className="w-3.5 h-3.5" aria-hidden="true" /></button>
        <button type="button" onClick={toggleCodeBlock} title="Code block (Enter twice on an empty last line to leave it)" aria-label="Code block" className={toolBtn}><SquareCode className="w-3.5 h-3.5" aria-hidden="true" /></button>
        <span className="w-px h-4 bg-secondary mx-1" aria-hidden="true" />
        <button type="button" onClick={openLink} title="Insert link" aria-label="Insert link" className={toolBtn}><Link2 className="w-3.5 h-3.5" aria-hidden="true" /></button>
        <button type="button" onClick={() => exec('removeFormat')} title="Clear formatting" aria-label="Clear formatting" className={`${toolBtn} ml-auto`}><RemoveFormatting className="w-3.5 h-3.5" aria-hidden="true" /></button>
        {onToggleExpand && (
          <button
            type="button"
            onClick={onToggleExpand}
            title={expanded ? 'Exit full screen (Esc)' : 'Full screen'}
            aria-label={expanded ? 'Exit full screen' : 'Full screen'}
            aria-pressed={expanded}
            className={toolBtn}
          >
            {expanded ? <Minimize2 className="w-3.5 h-3.5" aria-hidden="true" /> : <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />}
          </button>
        )}

        {linkOpen && (
          <div className="absolute left-2 top-full mt-1 z-30 tp-card rounded-lg shadow-soft p-2 flex items-center gap-1.5 w-72">
            <input
              type="url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
                if (e.key === 'Escape') { e.stopPropagation(); setLinkOpen(false); }
              }}
              placeholder="https://…"
              aria-label="Link URL"
              autoFocus
              className="tp-focus-ring flex-1 text-xs bg-card border border-input rounded-md px-2 py-1.5"
            />
            <button type="button" onClick={applyLink} className="tp-focus-ring px-2 py-1.5 text-xs font-semibold rounded-md bg-primary text-primary-foreground hover:bg-blue-700">Add</button>
            <button type="button" onClick={() => setLinkOpen(false)} className="tp-focus-ring px-1.5 py-1.5 text-xs rounded-md text-muted-foreground hover:bg-muted">Esc</button>
          </div>
        )}
      </div>

      <div ref={frameRef} className={expanded ? 'relative flex flex-col flex-1 min-h-0' : 'relative'}>
        {mention && mentionMatches.length > 0 && (
          <div
            role="listbox"
            aria-label="Mention a colleague"
            data-testid="mention-menu"
            className="absolute z-30 w-60 tp-card rounded-lg shadow-soft py-1"
            style={{ top: mention.top, left: mention.left }}
          >
            {mentionMatches.map((person, i) => (
              <button
                key={person.id}
                type="button"
                role="option"
                aria-selected={i === mention.index}
                onMouseDown={(e) => { e.preventDefault(); pickMention(person); }}
                className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm ${i === mention.index ? 'bg-blue-50 text-blue-800 dark:bg-blue-500/15 dark:text-blue-100' : 'text-foreground hover:bg-muted'}`}
              >
                <span className="truncate">{person.name}</span>
              </button>
            ))}
            <p className="px-3 pt-1 pb-0.5 text-[11px] text-muted-foreground">They get an e-mail with this note.</p>
          </div>
        )}
        {isEmpty && (
          <span aria-hidden="true" className="absolute left-3 top-2.5 text-sm text-muted-foreground/75 pointer-events-none select-none">
            {placeholder}
          </span>
        )}
        {/* Always present so the editable node keeps its place (and its
            content) when a footer comes or goes; it only takes over the
            height and the scrolling while there is one. */}
        <div
          className={footer ? `flex flex-col cursor-text overflow-y-auto settings-scrollbar rounded-b-lg${expanded ? ' flex-1 min-h-0' : ''}` : (expanded ? 'flex flex-col flex-1 min-h-0' : undefined)}
          style={footer ? { minHeight, maxHeight: expanded ? 'none' : 460 } : undefined}
          onMouseDown={footer ? (e) => { if (e.target === e.currentTarget) { e.preventDefault(); focusEnd(); } } : undefined}
        >
          <div
            ref={editorRef}
            contentEditable
            // Spell-check (QA 10-08 #4): asked for explicitly rather than left to
            // the browser default, with Canadian English as the proofing
            // language (Edge's editor picks its dictionary from `lang`).
            spellCheck
            lang="en-CA"
            autoCorrect="on"
            autoCapitalize="sentences"
            role="textbox"
            aria-multiline="true"
            aria-label={ariaLabel}
            onInput={() => { emit(); updateMention(); }}
            onBlur={() => { emit(); setMention(null); }}
            onKeyDown={(e) => {
              if (onMentionKey(e)) return;
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onSubmit?.(); return; }
              const pre = caretWithin('PRE');
              if (pre) onCodeKey(e, pre);
            }}
            onPaste={(e) => {
            // Pasted images (e.g. a screenshot) become staged attachments rather
            // than base64-bloated inline HTML — the host handles them.
              const images = Array.from(e.clipboardData?.items || [])
                .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
                .map((it) => it.getAsFile())
                .filter(Boolean);
              const htmlData = e.clipboardData.getData('text/html');
              const textData = e.clipboardData.getData('text/plain');
              // Inside a code block, a paste is code: plain text, every space and line kept.
              if (!images.length && textData && caretWithin('PRE')) {
                e.preventDefault();
                document.execCommand('insertText', false, textData.replace(/\r\n?/g, '\n'));
                emit();
                return;
              }
              if (images.length && onImagePaste) {
                e.preventDefault();
                // Keep any text the clipboard also carried, first.
                const insert = htmlData ? sanitize(cleanPastedHtml(htmlData)) : textToHtml(textData);
                if (insert) document.execCommand('insertHTML', false, insert);
                dropEchoedColor();
                // Stage each image and drop a lightweight reference at the caret so
                // the tech can anchor where the picture belongs in their write-up.
                // onImagePaste returns the staged filename (or nothing for older hosts).
                images.forEach((f) => {
                  const label = onImagePaste(f);
                  if (label) document.execCommand('insertHTML', false, pastedPictureHtml(label, previewUrlFor(f)));
                });
                emit();
                return;
              }
              // Otherwise paste as sanitized content, not raw clipboard markup.
              e.preventDefault();
              let insert;
              if (htmlData) {
              // Embedded pictures leave the markup and become attachments.
                const { html: withoutImages, images: embedded } = extractInlineImages(cleanPastedHtml(htmlData));
                insert = sanitize(withoutImages);
                embedded.forEach((image, i) => {
                  let replacement;
                  const label = onImagePaste ? onImagePaste(inlineImageToFile(image, i)) : null;
                  if (label) {
                    replacement = pastedPictureHtml(label, image.dataUri);
                  } else if (!onImagePaste && image.base64.length * 0.75 <= INLINE_IMAGE_KEEP_BYTES) {
                    replacement = `<img src="${image.dataUri}" alt="">`;
                  } else {
                    replacement = onImagePaste ? '' : '&nbsp;<i>[Picture removed &mdash; attach it as a file]</i>&nbsp;';
                  }
                  insert = insert.replace(`[[TPIMG:${i}]]`, replacement);
                });
              } else {
                insert = textToHtml(textData);
              }
              document.execCommand('insertHTML', false, insert);
              dropEchoedColor();
              ensureTrailingParagraph();
              emit();
            }}
            className={`tp-rich-editor w-full text-sm text-foreground px-3 py-2.5 outline-none ${footer ? 'min-h-[5.5rem] only:flex-1' : `rounded-b-lg overflow-y-auto settings-scrollbar${expanded ? ' flex-1' : ''}`} [&_a]:text-blue-600 dark:[&_a]:text-blue-300 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h3]:mt-2.5 [&_h3]:mb-1 [&_h3]:font-semibold [&_h4]:mt-2 [&_h4]:font-medium [&>:first-child]:mt-0 [&_.tp-mention]:text-blue-700 dark:[&_.tp-mention]:text-blue-300`}
            style={footer ? undefined : { minHeight, maxHeight: expanded ? 'none' : 460 }}
          />
          {footer}
        </div>
      </div>
    </div>
  );
});

export default RichTextEditor;
