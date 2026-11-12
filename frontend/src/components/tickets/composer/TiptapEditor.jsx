import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { Extension, Mark } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import { Suggestion } from '@tiptap/suggestion';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  Bold, Code, FileText, Heading2, Heading3, Italic, Link2, List, ListOrdered, Maximize2, Minimize2, Pilcrow, Redo2,
  RemoveFormatting, SquareCode, Strikethrough, TextQuote, Underline, Undo2,
} from 'lucide-react';
import { PersonAvatar } from '../ticketUi';
import { awayTag } from '../../../utils/away';
import {
  INLINE_IMAGE_KEEP_BYTES, cleanPastedHtml, extractInlineImages, htmlToPlainText, inlineImageToFile, sanitizeRichHtml,
} from '../RichTextEditor';
import { firstWord, suggestCompletion } from '../../../utils/composerPhrases';

/**
 * The new editor (Nov 2026, early access): the same contract as RichTextEditor
 * — value in, `{ html, text }` out, the same props and the same ref methods —
 * built on Tiptap 3 instead of a hand-driven contentEditable.
 *
 * What it adds: Markdown shortcuts as you type (**bold**, - lists, > quote,
 * ``` code), real undo/redo, a "/" menu for templates and quick notes, and the
 * base for inline completion.
 *
 * What it must not lose (the classic editor's promises):
 *  - Everything it emits goes through the SAME sanitizer (sanitizeRichHtml).
 *  - Pasted Office/Excel/VS Code markup goes through the SAME clean-up
 *    (cleanPastedHtml); pictures inside it become attachments the same way.
 *  - Inline styles, table borders and our tp-* classes survive: the schema is
 *    widened below (style/class on blocks and table parts, a styled-span mark)
 *    because a stock Tiptap schema silently drops what it does not model.
 *  - The HTML it hands on has the classic shapes: <li>text</li> (not a
 *    paragraph inside), <p><br></p> for an empty line, [Image: name] markers.
 */

const KEEP_STYLE = {
  style: {
    default: null,
    parseHTML: (el) => el.getAttribute('style') || null,
    renderHTML: (attrs) => (attrs.style ? { style: attrs.style } : {}),
  },
};
const keep = (name) => ({
  default: null,
  parseHTML: (el) => el.getAttribute(name) || null,
  renderHTML: (attrs) => (attrs[name] ? { [name]: attrs[name] } : {}),
});

/** style / class / legacy table attributes kept on the nodes that carry them in pasted mail. */
const KeepMarkup = Extension.create({
  name: 'tpKeepMarkup',
  addGlobalAttributes() {
    return [
      { types: ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'table', 'tableRow', 'tableCell', 'tableHeader'], attributes: KEEP_STYLE },
      { types: ['table', 'tableRow', 'tableCell', 'tableHeader'], attributes: { class: keep('class'), width: keep('width'), height: keep('height'), align: keep('align'), valign: keep('valign') } },
    ];
  },
});

/** <span style="…"> from pasted mail (colours, fonts in a signature). */
const StyledSpan = Mark.create({
  name: 'tpStyledSpan',
  priority: 90,
  addAttributes() { return { style: KEEP_STYLE.style }; },
  parseHTML() { return [{ tag: 'span[style]' }]; },
  renderHTML({ HTMLAttributes }) { return ['span', HTMLAttributes, 0]; },
});

/** A picked @mention: <strong class="tp-mention">@Name</strong>. Typing after it is plain text. */
const MentionMark = Mark.create({
  name: 'tpMention',
  priority: 1100, // before Bold, which would also claim the <strong>
  inclusive: false,
  parseHTML() { return [{ tag: 'strong.tp-mention' }]; },
  renderHTML() { return ['strong', { class: 'tp-mention' }, 0]; },
});

const TpImage = Image.extend({
  addAttributes() {
    return { ...this.parent?.(), class: keep('class'), 'data-tp-img': keep('data-tp-img'), width: keep('width'), height: keep('height') };
  },
});

const MENTION_KEY = new PluginKey('tpMentionMenu');
const SLASH_KEY = new PluginKey('tpSlashMenu');
export const GHOST_KEY = new PluginKey('tpGhost');

/**
 * "Complete as I type" (Nov 2026): grey text after the caret, offered from the
 * phrases the host passes in. Tab takes all of it, Right-arrow too (the caret
 * is at the end of the line, so the arrow has nowhere else to go), Ctrl+Right
 * takes one word, Esc waves it away until the text changes. The grey text is a
 * decoration: it is never part of what the editor holds or sends.
 */
function ghostPlugin(live) {
  const none = { text: null, pos: null, before: null, dismissed: null };
  return new Plugin({
    key: GHOST_KEY,
    state: {
      init: () => none,
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(GHOST_KEY);
        const dismissed = meta?.dismiss ? meta.dismiss : prev.dismissed;
        const { phrases, completionOn } = live.current;
        if (!completionOn || !phrases?.length) return none;
        const sel = state.selection;
        if (!sel.empty) return { ...none, dismissed };
        const $from = sel.$from;
        const parent = $from.parent;
        // Only at the end of a line of prose: never mid-sentence, never in code.
        if (!parent.isTextblock || parent.type.spec.code || $from.parentOffset !== parent.content.size) return { ...none, dismissed };
        const before = parent.textBetween(0, $from.parentOffset, undefined, ' ');
        if (dismissed && dismissed === before) return { text: null, pos: null, before, dismissed };
        const text = suggestCompletion(before, phrases);
        return { text: text || null, pos: text ? sel.from : null, before, dismissed: null };
      },
    },
    props: {
      decorations(state) {
        const g = GHOST_KEY.getState(state);
        if (!g?.text) return null;
        const widget = Decoration.widget(g.pos, () => {
          const span = document.createElement('span');
          span.className = 'tp-ghost';
          span.setAttribute('data-ghost', 'true');
          span.setAttribute('aria-hidden', 'true');
          span.title = 'Tab to accept · Ctrl+Right for one word · Esc to dismiss';
          span.textContent = g.text;
          return span;
        }, { side: 1, key: `ghost-${g.text}` });
        return DecorationSet.create(state.doc, [widget]);
      },
      handleKeyDown(view, event) {
        const g = GHOST_KEY.getState(view.state);
        if (!g?.text) return false;
        const plain = !event.shiftKey && !event.altKey;
        const mod = event.ctrlKey || event.metaKey;
        if (plain && !mod && (event.key === 'Tab' || event.key === 'ArrowRight')) {
          event.preventDefault();
          view.dispatch(view.state.tr.insertText(g.text));
          return true;
        }
        if (plain && mod && event.key === 'ArrowRight') {
          event.preventDefault();
          view.dispatch(view.state.tr.insertText(firstWord(g.text)));
          return true;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          view.dispatch(view.state.tr.setMeta(GHOST_KEY, { dismiss: g.before }));
          return true;
        }
        return false;
      },
    },
  });
}

function textToHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text || '');
  return div.innerHTML.replace(/\n/g, '<br>');
}

/** Tiptap's HTML → the shapes the classic editor emits (see the header). */
export function classicShape(html) {
  if (!html) return '';
  const box = document.createElement('div');
  box.innerHTML = html;
  // <li><p>x</p></li> / <td><p>x</p></td> → the text itself (one paragraph only).
  box.querySelectorAll('li, td, th, blockquote').forEach((cell) => {
    const kids = Array.from(cell.children);
    const onlyPara = kids.length >= 1 && kids[0].tagName === 'P' && !kids[0].getAttribute('style')
      && kids.slice(1).every((k) => /^(UL|OL)$/.test(k.tagName));
    if (onlyPara && !Array.from(cell.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim())) {
      kids[0].replaceWith(...kids[0].childNodes);
    }
  });
  // An empty paragraph is a blank line: mail clients collapse <p></p> to nothing.
  box.querySelectorAll('p').forEach((p) => { if (!p.childNodes.length) p.appendChild(document.createElement('br')); });
  // A pasted picture's preview goes out as its marker; the file is the attachment.
  box.querySelectorAll('img[data-tp-img]').forEach((img) => {
    const marker = document.createElement('i');
    marker.textContent = `[Image: ${img.getAttribute('data-tp-img')}]`;
    img.replaceWith(marker);
  });
  // Tiptap's own table bookkeeping is not ours to send: its column group and
  // the colspan/rowspan it writes on every cell, merged or not.
  box.querySelectorAll('colgroup').forEach((c) => c.remove());
  box.querySelectorAll('td, th').forEach((cell) => {
    for (const span of ['colspan', 'rowspan']) if (cell.getAttribute(span) === '1') cell.removeAttribute(span);
  });
  // The empty paragraph Tiptap keeps after a table, code block or quote (so
  // there is somewhere to type) is not a blank line the author wrote.
  const last = box.lastElementChild;
  if (last && last.tagName === 'P' && !last.textContent && last.children.length <= 1 && /^(TABLE|PRE|BLOCKQUOTE)$/.test(last.previousElementSibling?.tagName || '')) last.remove();
  const out = box.innerHTML;
  return out === '<p><br></p>' ? '' : out;
}

const TiptapEditor = forwardRef(function TiptapEditor({
  value = '',
  onChange,
  onSubmit,
  placeholder = 'Write…',
  ariaLabel = 'Rich text editor',
  className = 'border-input bg-card',
  minHeight = 170,
  onImagePaste,
  headings = false,
  footer = null,
  expanded = false,
  onToggleExpand = null,
  mentionPeople = null,
  onMention = null,
  // "/" menu: [{ id, name, hint, html }] — reply templates or quick notes.
  slashItems = null,
  slashLabel = 'Templates',
  // "Complete as I type": the phrases on offer (most likely first), and the
  // person's own switch. Off or empty = no grey text, Tab is an ordinary Tab.
  completionPhrases = null,
  completionOn = false,
}, ref) {
  const frameRef = useRef(null);
  const lastEmittedRef = useRef(null);
  const thumbUrlsRef = useRef([]);
  const [menu, setMenu] = useState(null); // { kind: 'mention' | 'slash', items, index, top, left }
  const menuRef = useRef(null);
  menuRef.current = menu;
  const menuCommandRef = useRef(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [, bump] = useState(0);

  // Latest props for the handlers Tiptap binds once.
  const live = useRef({});
  live.current = { onChange, onSubmit, onImagePaste, mentionPeople, onMention, slashItems, headings, phrases: completionPhrases, completionOn };
  const sanitize = (html) => sanitizeRichHtml(html, { headings: live.current.headings });

  useEffect(() => () => {
    thumbUrlsRef.current.forEach((url) => { try { URL.revokeObjectURL(url); } catch { /* nothing to release */ } });
    thumbUrlsRef.current = [];
  }, []);
  const previewUrlFor = (file) => {
    try { const url = URL.createObjectURL(file); thumbUrlsRef.current.push(url); return url; } catch { return null; }
  };
  const pictureHtml = (label, src) => {
    const esc = document.createElement('div');
    esc.textContent = label;
    const name = esc.innerHTML.replace(/"/g, '&quot;');
    if (!src) return `&nbsp;<i>[Image:&nbsp;${esc.innerHTML}]</i>&nbsp;`;
    return `&nbsp;<img class="tp-editor-thumb" data-tp-img="${name}" alt="[Image: ${name}]" title="${name}" src="${src}">&nbsp;`;
  };

  const placeMenu = (clientRect) => {
    let top = 0;
    let left = 0;
    try {
      const caret = clientRect?.();
      const frame = frameRef.current?.getBoundingClientRect();
      if (frame && caret && (caret.top || caret.left)) {
        top = caret.bottom - frame.top + 4;
        left = Math.max(0, Math.min(caret.left - frame.left, frame.width - 260));
      }
    } catch { /* no layout: the menu sits at the top left */ }
    return { top, left };
  };
  const menuRender = (kind) => () => ({
    onStart: (props) => { menuCommandRef.current = props.command; setMenu(props.items.length ? { kind, items: props.items, index: 0, ...placeMenu(props.clientRect) } : null); },
    onUpdate: (props) => { menuCommandRef.current = props.command; setMenu((prev) => (props.items.length ? { kind, items: props.items, index: Math.min(prev?.index || 0, props.items.length - 1), ...placeMenu(props.clientRect) } : null)); },
    onKeyDown: ({ event }) => {
      const m = menuRef.current;
      if (!m || !m.items.length) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setMenu((prev) => (prev ? { ...prev, index: (prev.index + step + prev.items.length) % prev.items.length } : prev));
        return true;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        menuCommandRef.current?.(m.items[m.index]);
        return true;
      }
      if (event.key === 'Escape') { event.stopPropagation(); setMenu(null); return true; }
      return false;
    },
    onExit: () => { menuCommandRef.current = null; setMenu(null); },
  });

  const Menus = useMemo(() => Extension.create({
    name: 'tpMenus',
    addProseMirrorPlugins() {
      return [
        ghostPlugin(live),
        Suggestion({
          editor: this.editor,
          pluginKey: MENTION_KEY,
          char: '@',
          allowSpaces: false,
          allowedPrefixes: null,
          allow: ({ state, range }) => {
            const { mentionPeople: people, onMention: cb } = live.current;
            if (!Array.isArray(people) || !people.length || typeof cb !== 'function') return false;
            const $from = state.doc.resolve(range.from);
            if ($from.parent.type.spec.code) return false;
            // After a space or an opening bracket, or at the start: an e-mail address is not a mention.
            const before = $from.parent.textBetween(0, $from.parentOffset, undefined, ' ');
            return before === '' || /[\s(]$/.test(before);
          },
          items: ({ query }) => {
            const people = live.current.mentionPeople || [];
            const q = String(query || '').toLowerCase();
            return people
              .filter((p) => p?.name && (!q || String(p.name).toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || String(p.name).toLowerCase().startsWith(q)))
              .slice(0, 100);
          },
          command: ({ editor, range, props }) => {
            editor.chain().focus().insertContentAt(range, [
              { type: 'text', text: `@${props.name}`, marks: [{ type: 'tpMention' }] },
              { type: 'text', text: '\u00a0' },
            ]).run();
            live.current.onMention?.(props);
          },
          render: menuRender('mention'),
        }),
        Suggestion({
          editor: this.editor,
          pluginKey: SLASH_KEY,
          char: '/',
          allowSpaces: true,
          startOfLine: false,
          // The check below decides what may come before the "/" (a plain or a
          // non-breaking space, or nothing); the default allows a plain space only.
          allowedPrefixes: null,
          allow: ({ state, range }) => {
            const items = live.current.slashItems;
            if (!Array.isArray(items) || !items.length) return false;
            const $from = state.doc.resolve(range.from);
            if ($from.parent.type.spec.code) return false;
            // "/" only after a space or at the start of a line: 1/2 and URLs are not a command.
            const before = $from.parent.textBetween(0, $from.parentOffset, undefined, ' ');
            return before === '' || /\s$/.test(before);
          },
          items: ({ query }) => {
            const q = String(query || '').toLowerCase().trim();
            if (q.length > 40) return [];
            return (live.current.slashItems || [])
              .filter((t) => !q || `${t.name} ${t.hint || ''}`.toLowerCase().includes(q))
              .slice(0, 50);
          },
          command: ({ editor, range, props }) => {
            editor.chain().focus().deleteRange(range).insertContent(sanitize(props.html || '')).run();
          },
          render: menuRender('slash'),
        }),
      ];
    },
    addKeyboardShortcuts() {
      return {
        // Tab inside a code block indents instead of leaving the editor.
        Tab: () => (this.editor.isActive('codeBlock') ? this.editor.commands.insertContent('  ') : false),
      };
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  const editorRef = useRef(null);
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;

  const emit = (editor) => {
    const html = sanitize(classicShape(editor.getHTML()));
    const text = htmlToPlainText(html);
    lastEmittedRef.current = html;
    live.current.onChange?.({ html, text });
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: headings ? { levels: [2, 3, 4] } : false,
        link: { openOnClick: false, autolink: true, HTMLAttributes: { target: '_blank', rel: 'noreferrer' } },
      }),
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
      TableKit.configure({ table: { resizable: false, HTMLAttributes: {} } }),
      TpImage.configure({ inline: true, allowBase64: true }),
      KeepMarkup,
      StyledSpan,
      MentionMark,
      Menus,
    ],
    content: /<[a-z][\s\S]*>/i.test(value) ? sanitizeRichHtml(value, { headings }) : textToHtml(value),
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': ariaLabel,
        spellcheck: 'true',
        lang: 'en-CA',
        autocorrect: 'on',
        autocapitalize: 'sentences',
        class: 'tp-rich-editor tp-tiptap w-full text-sm text-foreground px-3 py-2.5 outline-none',
      },
      handleKeyDown: (_view, event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          if (event.shiftKey) live.current.onSubmit?.({ shift: true }); else live.current.onSubmit?.();
          return true;
        }
        return false;
      },
      handlePaste: (view, event) => {
        const data = event.clipboardData;
        if (!data) return false;
        const images = Array.from(data.items || [])
          .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
          .map((it) => it.getAsFile())
          .filter(Boolean);
        const htmlData = data.getData('text/html');
        const textData = data.getData('text/plain');
        const ed = editorRef.current;
        if (!ed) return false;
        // Inside a code block, a paste is code: plain text, every space and line kept.
        if (!images.length && ed.isActive('codeBlock')) return false;
        const host = live.current.onImagePaste;
        if (images.length && host) {
          event.preventDefault();
          const lead = htmlData ? sanitize(cleanPastedHtml(htmlData)) : textToHtml(textData);
          let insert = lead || '';
          images.forEach((f) => {
            const label = host(f);
            if (label) insert += pictureHtml(label, previewUrlFor(f));
          });
          if (insert) ed.chain().focus().insertContent(insert).run();
          return true;
        }
        if (!htmlData) return false; // plain text: Tiptap's own paste keeps lines as paragraphs
        event.preventDefault();
        const { html: withoutImages, images: embedded } = extractInlineImages(cleanPastedHtml(htmlData));
        let insert = sanitize(withoutImages);
        embedded.forEach((image, i) => {
          let replacement;
          const label = host ? host(inlineImageToFile(image, i)) : null;
          if (label) replacement = pictureHtml(label, image.dataUri);
          else if (!host && image.base64.length * 0.75 <= INLINE_IMAGE_KEEP_BYTES) replacement = `<img src="${image.dataUri}" alt="">`;
          else replacement = host ? '' : '&nbsp;<i>[Picture removed &mdash; attach it as a file]</i>&nbsp;';
          insert = insert.replace(`[[TPIMG:${i}]]`, replacement);
        });
        ed.chain().focus().insertContent(insert).run();
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => emit(ed),
    onSelectionUpdate: () => bump((n) => n + 1),
    onBlur: ({ editor: ed }) => { emit(ed); setMenu(null); },
  });
  editorRef.current = editor;

  // The label and placeholder follow the composer's mode.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return; // a torn-down instance (remount) has no commands
    editor.setOptions({ editorProps: { ...editor.options.editorProps, attributes: { ...editor.options.editorProps.attributes, 'aria-label': ariaLabel } } });
    editor.view.dispatch(editor.state.tr); // repaint the placeholder
  }, [editor, ariaLabel, placeholder]);

  // Adopt external value changes (draft restore, clear-after-send, templates).
  useEffect(() => {
    if (!editor || editor.isDestroyed || value === lastEmittedRef.current) return;
    const html = /<[a-z][\s\S]*>/i.test(value) ? sanitize(value) : textToHtml(value);
    editor.commands.setContent(html, { emitUpdate: false });
    lastEmittedRef.current = value;
    bump((n) => n + 1);
  }, [value, editor]);

  const liveEditor = () => (editorRef.current && !editorRef.current.isDestroyed ? editorRef.current : null);
  useImperativeHandle(ref, () => ({
    focus: () => { const ed = liveEditor(); if (ed) ed.commands.focus(); },
    insertText: (text) => { const ed = liveEditor(); if (ed) ed.chain().focus().insertContent({ type: 'text', text: String(text ?? '') }).run(); },
    insertHtml: (html) => { const ed = liveEditor(); if (ed) ed.chain().focus().insertContent(sanitize(String(html ?? ''))).run(); },
    // For add-ons (inline completion): the live editor.
    getEditor: () => liveEditor(),
  }));

  const openLink = () => { setLinkUrl(editor?.getAttributes('link').href || ''); setLinkOpen(true); };
  const applyLink = () => {
    const url = linkUrl.trim();
    setLinkOpen(false);
    if (!editor) return;
    if (!url) { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    if (editor.state.selection.empty && !editor.isActive('link')) {
      editor.chain().focus().insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
  };

  const toolBtn = 'tp-focus-ring p-1.5 rounded-md text-muted-foreground hover:text-blue-700 dark:hover:text-blue-200 hover:bg-blue-50 dark:hover:bg-blue-500/15 disabled:opacity-40 disabled:hover:bg-transparent';
  const on = 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200';
  const alive = Boolean(editor && !editor.isDestroyed);
  const is = (name, attrs) => alive && Boolean(editor.isActive(name, attrs));
  const run = (fn) => () => { if (alive) fn(editor.chain().focus()).run(); };
  const Btn = ({ label, title, active = false, onClick, disabled = false, className: extra = '', children }) => (
    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onClick} title={title || label} aria-label={label} aria-pressed={active || undefined} disabled={disabled} className={`${toolBtn} ${active ? on : ''} ${extra}`}>{children}</button>
  );
  const sep = <span className="w-px h-4 bg-secondary mx-1" aria-hidden="true" />;
  const isEmpty = !alive || editor.isEmpty;

  return (
    <div data-editor="tiptap" className={`${expanded ? 'flex flex-col flex-1 min-h-0 ' : ''}border rounded-lg transition-colors focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100 dark:focus-within:ring-blue-500/30 ${className}`}>
      <div className="flex flex-wrap items-center gap-0.5 px-1.5 py-1 border-b border-border/60 relative" role="toolbar" aria-label="Formatting">
        {headings && (
          <>
            <Btn label="Normal text" active={is('paragraph')} onClick={run((c) => c.setParagraph())}><Pilcrow className="w-3.5 h-3.5" aria-hidden="true" /></Btn>
            <Btn label="Section heading" title="Section heading (Auto-help reads each section on its own)" active={is('heading', { level: 2 })} onClick={run((c) => c.toggleHeading({ level: 2 }))}><Heading2 className="w-3.5 h-3.5" aria-hidden="true" /></Btn>
            <Btn label="Subheading" active={is('heading', { level: 3 })} onClick={run((c) => c.toggleHeading({ level: 3 }))}><Heading3 className="w-3.5 h-3.5" aria-hidden="true" /></Btn>
            {sep}
          </>
        )}
        <Btn label="Bold" title="Bold (Ctrl+B)" active={is('bold')} onClick={run((c) => c.toggleBold())}><Bold className="w-3.5 h-3.5" aria-hidden="true" /></Btn>
        <Btn label="Italic" title="Italic (Ctrl+I)" active={is('italic')} onClick={run((c) => c.toggleItalic())}><Italic className="w-3.5 h-3.5" aria-hidden="true" /></Btn>
        <Btn label="Underline" title="Underline (Ctrl+U)" active={is('underline')} onClick={run((c) => c.toggleUnderline())}><Underline className="w-3.5 h-3.5" aria-hidden="true" /></Btn>
        <Btn label="Strikethrough" active={is('strike')} onClick={run((c) => c.toggleStrike())}><Strikethrough className="w-3.5 h-3.5" aria-hidden="true" /></Btn>
        {sep}
        <Btn label="Bulleted list" title="Bulleted list (type - and a space)" active={is('bulletList')} onClick={run((c) => c.toggleBulletList())}><List className="w-3.5 h-3.5" aria-hidden="true" /></Btn>
        <Btn label="Numbered list" title="Numbered list (type 1. and a space)" active={is('orderedList')} onClick={run((c) => c.toggleOrderedList())}><ListOrdered className="w-3.5 h-3.5" aria-hidden="true" /></Btn>
        {sep}
        <Btn label="Quote" title="Quote (type > and a space)" active={is('blockquote')} onClick={run((c) => c.toggleBlockquote())}><TextQuote className="w-3.5 h-3.5" aria-hidden="true" /></Btn>
        <Btn label="Inline code" title="Inline code (wrap in `backticks`)" active={is('code')} onClick={run((c) => c.toggleCode())}><Code className="w-3.5 h-3.5" aria-hidden="true" /></Btn>
        <Btn label="Code block" title="Code block (type ``` and Enter; Enter three times to leave it)" active={is('codeBlock')} onClick={run((c) => c.toggleCodeBlock())}><SquareCode className="w-3.5 h-3.5" aria-hidden="true" /></Btn>
        {sep}
        <Btn label="Insert link" title={is('link') ? 'Edit link' : 'Insert link'} active={is('link')} onClick={openLink}><Link2 className="w-3.5 h-3.5" aria-hidden="true" /></Btn>
        {Array.isArray(slashItems) && slashItems.length > 0 && (
          <span className="ml-1 hidden items-center gap-1 text-[11px] text-muted-foreground/75 sm:inline-flex" title={`Type / in the text to search ${slashLabel.toLowerCase()}`}>
            <FileText className="h-3 w-3" aria-hidden="true" />type <kbd className="rounded border border-border bg-muted px-1 font-sans text-[10px]">/</kbd> for {slashLabel.toLowerCase()}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-0.5">
          <Btn label="Undo" title="Undo (Ctrl+Z)" disabled={!alive || !editor.can().undo()} onClick={run((c) => c.undo())}><Undo2 className="w-3.5 h-3.5" aria-hidden="true" /></Btn>
          <Btn label="Redo" title="Redo (Ctrl+Y)" disabled={!alive || !editor.can().redo()} onClick={run((c) => c.redo())}><Redo2 className="w-3.5 h-3.5" aria-hidden="true" /></Btn>
          <Btn label="Clear formatting" onClick={run((c) => c.unsetAllMarks().clearNodes())}><RemoveFormatting className="w-3.5 h-3.5" aria-hidden="true" /></Btn>
          {onToggleExpand && (
            <button
              type="button"
              onClick={onToggleExpand}
              title={expanded ? 'Back to the small editor (Esc)' : 'Bigger editor (Ctrl+Shift+F)'}
              aria-label={expanded ? 'Exit full screen' : 'Full screen'}
              aria-pressed={expanded}
              className={toolBtn}
            >
              {expanded ? <Minimize2 className="w-3.5 h-3.5" aria-hidden="true" /> : <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />}
            </button>
          )}
        </span>

        {linkOpen && (
          <div className="absolute left-2 top-full mt-1 z-30 tp-card rounded-lg shadow-soft p-2 flex items-center gap-1.5 w-80">
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
            <button type="button" onClick={applyLink} className="tp-focus-ring px-2 py-1.5 text-xs font-semibold rounded-md bg-primary text-primary-foreground hover:bg-blue-700">{is('link') ? 'Save' : 'Add'}</button>
            {is('link') && <button type="button" onClick={() => { setLinkUrl(''); setLinkOpen(false); editor?.chain().focus().extendMarkRange('link').unsetLink().run(); }} className="tp-focus-ring px-1.5 py-1.5 text-xs rounded-md text-muted-foreground hover:bg-muted">Remove</button>}
            <button type="button" onClick={() => setLinkOpen(false)} className="tp-focus-ring px-1.5 py-1.5 text-xs rounded-md text-muted-foreground hover:bg-muted">Esc</button>
          </div>
        )}
      </div>

      <div ref={frameRef} className={expanded ? 'relative flex flex-col flex-1 min-h-0' : 'relative'}>
        {menu && menu.items.length > 0 && (
          <div
            role="listbox"
            aria-label={menu.kind === 'mention' ? 'Mention a colleague' : slashLabel}
            data-testid={menu.kind === 'mention' ? 'mention-menu' : 'slash-menu'}
            className="absolute z-30 w-72 tp-card rounded-lg shadow-soft py-1"
            style={{ top: menu.top, left: menu.left }}
          >
            <div className="max-h-72 overflow-y-auto overscroll-contain settings-scrollbar">
              {menu.items.map((item, i) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={i === menu.index}
                  ref={i === menu.index ? (el) => el?.scrollIntoView?.({ block: 'nearest' }) : undefined}
                  onMouseDown={(e) => { e.preventDefault(); menuCommandRef.current?.(item); }}
                  className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm ${i === menu.index ? 'bg-blue-50 text-blue-800 dark:bg-blue-500/15 dark:text-blue-100' : 'text-foreground hover:bg-muted'}`}
                >
                  {menu.kind === 'mention' ? (
                    <>
                      <span aria-hidden="true" className="inline-flex shrink-0"><PersonAvatar name={item.name} photoUrl={item.photoUrl || null} size="h-6 w-6" /></span>
                      <span className="truncate">{item.name}</span>
                      {item.away && <span className="ml-auto whitespace-nowrap pl-1 text-[10px] font-medium text-amber-700 dark:text-amber-300" data-testid="mention-away">{awayTag(item.away)}</span>}
                    </>
                  ) : (
                    <span className="min-w-0">
                      <span className="block truncate">{item.name}</span>
                      {item.hint && <span className="block truncate text-[11px] text-muted-foreground">{item.hint}</span>}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <p className="px-3 pt-1 pb-0.5 border-t border-border text-[11px] text-muted-foreground">
              {menu.kind === 'mention' ? 'They get an e-mail with this note.' : 'Enter to insert · Esc to keep typing'}
            </p>
          </div>
        )}
        <div
          className={footer ? `flex flex-col cursor-text overflow-y-auto settings-scrollbar rounded-b-lg${expanded ? ' flex-1 min-h-0' : ''}` : `overflow-y-auto settings-scrollbar rounded-b-lg${expanded ? ' flex flex-col flex-1 min-h-0' : ''}`}
          style={{ minHeight, maxHeight: expanded ? 'none' : 460 }}
          data-empty={isEmpty ? 'true' : undefined}
          onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); editor?.commands.focus('end'); } }}
        >
          <EditorContent editor={editor} className={footer ? 'min-h-[5.5rem]' : 'flex-1'} />
          {footer}
        </div>
      </div>
    </div>
  );
});

export default TiptapEditor;
