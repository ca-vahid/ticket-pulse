import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { Bold, Heading2, Heading3, Italic, Link2, List, ListOrdered, Pilcrow, RemoveFormatting, Underline } from 'lucide-react';

const ALLOWED = {
  ALLOWED_TAGS: [
    'b', 'strong', 'i', 'em', 'u', 'p', 'br', 'div', 'ul', 'ol', 'li', 'a',
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
  if (typeof DOMParser !== 'undefined' && /<(?:table|style)\b/i.test(out)) {
    const doc = new DOMParser().parseFromString(out, 'text/html');

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
  return /<(b|strong|i|em|u|ul|ol|li|a|table|img)\b/i.test(String(html || ''));
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
export function htmlToPlainText(html) {
  const source = String(html || '');
  if (!source) return '';
  if (!/<[a-z][\s\S]*>/i.test(source)) return source.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trimEnd();
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
}, ref) {
  const editorRef = useRef(null);
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

  const emit = () => {
    const el = editorRef.current;
    if (!el) return;
    const html = sanitize(el.innerHTML);
    const text = htmlToPlainText(html);
    lastEmittedRef.current = html;
    setIsEmpty(!el.textContent.trim());
    onChange?.({ html, text });
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

  const toolBtn = 'tp-focus-ring p-1.5 rounded-md text-muted-foreground hover:text-blue-700 dark:hover:text-blue-200 hover:bg-blue-50 dark:hover:bg-blue-500/15';
  const blockOn = 'bg-muted text-foreground';

  return (
    <div className={`border rounded-lg transition-colors focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100 dark:focus-within:ring-blue-500/30 ${className}`}>
      <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-border/60 relative" role="toolbar" aria-label="Formatting">
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
        <button type="button" onClick={openLink} title="Insert link" aria-label="Insert link" className={toolBtn}><Link2 className="w-3.5 h-3.5" aria-hidden="true" /></button>
        <button type="button" onClick={() => exec('removeFormat')} title="Clear formatting" aria-label="Clear formatting" className={`${toolBtn} ml-auto`}><RemoveFormatting className="w-3.5 h-3.5" aria-hidden="true" /></button>

        {linkOpen && (
          <div className="absolute left-2 top-full mt-1 z-30 tp-card rounded-lg shadow-soft p-2 flex items-center gap-1.5 w-72">
            <input
              type="url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
                if (e.key === 'Escape') setLinkOpen(false);
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

      <div className="relative">
        {isEmpty && (
          <span aria-hidden="true" className="absolute left-3 top-2.5 text-sm text-muted-foreground/75 pointer-events-none select-none">
            {placeholder}
          </span>
        )}
        <div
          ref={editorRef}
          contentEditable
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          onInput={emit}
          onBlur={emit}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onSubmit?.(); }
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
            if (images.length && onImagePaste) {
              e.preventDefault();
              // Keep any text the clipboard also carried, first.
              const insert = htmlData ? sanitize(cleanPastedHtml(htmlData)) : textToHtml(textData);
              if (insert) document.execCommand('insertHTML', false, insert);
              // Stage each image and drop a lightweight reference at the caret so
              // the tech can anchor where the picture belongs in their write-up.
              // onImagePaste returns the staged filename (or nothing for older hosts).
              images.forEach((f) => {
                const label = onImagePaste(f);
                if (label) {
                  const esc = document.createElement('div');
                  esc.textContent = label;
                  document.execCommand('insertHTML', false, `&nbsp;<i>[Image:&nbsp;${esc.innerHTML}]</i>&nbsp;`);
                }
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
                  const esc = document.createElement('div');
                  esc.textContent = label;
                  replacement = `&nbsp;<i>[Image:&nbsp;${esc.innerHTML}]</i>&nbsp;`;
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
            emit();
          }}
          className="tp-rich-editor tp-focus-ring w-full text-sm text-foreground px-3 py-2.5 rounded-b-lg outline-none overflow-y-auto settings-scrollbar [&_a]:text-blue-600 dark:[&_a]:text-blue-300 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h3]:mt-2.5 [&_h3]:mb-1 [&_h3]:font-semibold [&_h4]:mt-2 [&_h4]:font-medium [&>:first-child]:mt-0"
          style={{ minHeight, maxHeight: 460 }}
        />
      </div>
    </div>
  );
});

export default RichTextEditor;
