import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { Bold, Italic, Link2, List, ListOrdered, RemoveFormatting, Underline } from 'lucide-react';

const ALLOWED = {
  ALLOWED_TAGS: ['b', 'strong', 'i', 'em', 'u', 'p', 'br', 'div', 'ul', 'ol', 'li', 'a'],
  ALLOWED_ATTR: ['href', 'target', 'rel'],
};

export function sanitizeRichHtml(html) {
  return DOMPurify.sanitize(String(html || ''), ALLOWED);
}

/** True when the html carries formatting worth sending as bodyHtml. */
export function isRichContent(html) {
  return /<(b|strong|i|em|u|ul|ol|li|a)\b/i.test(String(html || ''));
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
  className = 'border-input bg-white',
  minHeight = 170,
  onImagePaste,
}, ref) {
  const editorRef = useRef(null);
  const lastEmittedRef = useRef(null);
  const savedRangeRef = useRef(null);
  const [isEmpty, setIsEmpty] = useState(true);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
  }), []);

  // Adopt external value changes (draft restore, clear-after-send).
  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    const el = editorRef.current;
    if (!el) return;
    const html = /<[a-z][\s\S]*>/i.test(value) ? sanitizeRichHtml(value) : textToHtml(value);
    el.innerHTML = html;
    lastEmittedRef.current = value;
    setIsEmpty(!el.textContent.trim());
  }, [value]);

  const emit = () => {
    const el = editorRef.current;
    if (!el) return;
    const html = sanitizeRichHtml(el.innerHTML);
    const text = el.innerText.replace(/\u00a0/g, ' ').trimEnd();
    lastEmittedRef.current = html;
    setIsEmpty(!el.textContent.trim());
    onChange?.({ html, text });
  };

  const exec = (command, arg = null) => {
    editorRef.current?.focus();
    document.execCommand(command, false, arg);
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

  const toolBtn = 'tp-focus-ring p-1.5 rounded-md text-slate-500 hover:text-blue-700 hover:bg-blue-50';

  return (
    <div className={`border rounded-lg transition-colors focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100 ${className}`}>
      <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-slate-100 relative" role="toolbar" aria-label="Formatting">
        <button type="button" onClick={() => exec('bold')} title="Bold (Ctrl+B)" aria-label="Bold" className={toolBtn}><Bold className="w-3.5 h-3.5" aria-hidden="true" /></button>
        <button type="button" onClick={() => exec('italic')} title="Italic (Ctrl+I)" aria-label="Italic" className={toolBtn}><Italic className="w-3.5 h-3.5" aria-hidden="true" /></button>
        <button type="button" onClick={() => exec('underline')} title="Underline (Ctrl+U)" aria-label="Underline" className={toolBtn}><Underline className="w-3.5 h-3.5" aria-hidden="true" /></button>
        <span className="w-px h-4 bg-slate-200 mx-1" aria-hidden="true" />
        <button type="button" onClick={() => exec('insertUnorderedList')} title="Bulleted list" aria-label="Bulleted list" className={toolBtn}><List className="w-3.5 h-3.5" aria-hidden="true" /></button>
        <button type="button" onClick={() => exec('insertOrderedList')} title="Numbered list" aria-label="Numbered list" className={toolBtn}><ListOrdered className="w-3.5 h-3.5" aria-hidden="true" /></button>
        <span className="w-px h-4 bg-slate-200 mx-1" aria-hidden="true" />
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
              className="tp-focus-ring flex-1 text-xs bg-white border border-input rounded-md px-2 py-1.5"
            />
            <button type="button" onClick={applyLink} className="tp-focus-ring px-2 py-1.5 text-xs font-semibold rounded-md bg-primary text-primary-foreground hover:bg-blue-700">Add</button>
            <button type="button" onClick={() => setLinkOpen(false)} className="tp-focus-ring px-1.5 py-1.5 text-xs rounded-md text-slate-500 hover:bg-slate-100">Esc</button>
          </div>
        )}
      </div>

      <div className="relative">
        {isEmpty && (
          <span aria-hidden="true" className="absolute left-3 top-2.5 text-sm text-slate-400 pointer-events-none select-none">
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
              const insert = htmlData ? sanitizeRichHtml(htmlData) : textToHtml(textData);
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
            const insert = htmlData ? sanitizeRichHtml(htmlData) : textToHtml(textData);
            document.execCommand('insertHTML', false, insert);
            emit();
          }}
          className="tp-focus-ring w-full text-sm text-slate-800 px-3 py-2.5 rounded-b-lg outline-none overflow-y-auto settings-scrollbar [&_a]:text-blue-600 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
          style={{ minHeight, maxHeight: 460 }}
        />
      </div>
    </div>
  );
});

export default RichTextEditor;
