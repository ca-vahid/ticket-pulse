/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../hooks/useRequesterPhoto', () => ({ useRequesterPhoto: () => null }));

import TiptapEditor, { GHOST_KEY, classicShape } from './TiptapEditor';
import { cleanPastedHtml, htmlToPlainText, sanitizeRichHtml } from '../RichTextEditor';

/**
 * The new editor must not lose what the classic one keeps (Vahid, 11 Nov 2026).
 * These load real-shaped content into it and read back what it would hand on.
 */

beforeAll(() => {
  // ProseMirror asks the DOM for geometry that jsdom does not have.
  const rect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* iter() { /* none */ } });
  Element.prototype.getClientRects = Range.prototype.getClientRects;
  document.elementFromPoint = () => null;
});
afterEach(cleanup);

const EXCEL = `
<html><head><style>
<!--td {padding-top:1px; color:black; border:none;}
.xl65 {font-weight:700; border:.5pt solid windowtext; background:#D9E1F2;}
.xl66 {border:.5pt solid windowtext;}
-->
</style></head><body>
<table border=0 cellpadding=0 cellspacing=0 width=192 style='border-collapse:collapse;width:144pt'>
<tr height=20 style='height:15.0pt'>
 <td height=20 class=xl65 width=64 style='height:15.0pt;width:48pt'>Server</td>
 <td class=xl65 width=64 style='width:48pt'>Status</td>
 <td class=xl65 width=64 style='width:48pt'>Owner</td>
</tr>
<tr height=20 style='height:15.0pt'>
 <td height=20 class=xl66 style='height:15.0pt'>bgc-app-01 &amp; ok</td>
 <td class=xl66 colspan=2>Mehdi</td>
</tr>
</table></body></html>`;

const SIGNATURE = `
<div class=WordSection1>
<p class=MsoNormal><b><span style='font-size:11.0pt;color:#1F4E79'>Jane Doe</span></b><o:p></o:p></p>
<p class=MsoNormal><span style='color:#595959'>IT Coordinator | BGC Engineering</span><o:p>&nbsp;</o:p></p>
<p class=MsoNormal><img width=120 height=40 src="https://example.com/logo.png" alt="BGC"><o:p></o:p></p>
</div>`;

async function load(html, props = {}) {
  const ref = createRef();
  const onChange = vi.fn();
  render(<TiptapEditor ref={ref} value={html} onChange={onChange} ariaLabel="Body" {...props} />);
  await waitFor(() => expect(ref.current?.getEditor?.()).toBeTruthy());
  const editor = ref.current.getEditor();
  const out = () => sanitizeRichHtml(classicShape(editor.getHTML()));
  return { ref, editor, onChange, out };
}
const dom = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d; };

describe('nothing is lost on the way through', () => {
  test('an Excel range keeps its table, cell borders, fill, widths and merged cell', async () => {
    const pasted = sanitizeRichHtml(cleanPastedHtml(EXCEL));
    const { out } = await load(pasted);
    const d = dom(out());
    const table = d.querySelector('table');
    expect(table).toHaveClass('tp-data-table');
    expect(table.getAttribute('style')).toMatch(/border-collapse:\s*collapse/);
    const cells = [...d.querySelectorAll('td, th')];
    expect(cells.map((c) => c.textContent.trim())).toEqual(['Server', 'Status', 'Owner', 'bgc-app-01 & ok', 'Mehdi']);
    expect(cells[0].getAttribute('style')).toMatch(/border:\s*1px solid (#000|rgb\(0, 0, 0\))/);
    expect(d.querySelector('colgroup')).toBeNull();
    expect(cells[0].hasAttribute('rowspan')).toBe(false);
    // No stray blank line after the table.
    expect(d.lastElementChild.tagName).toBe('TABLE');
    expect(cells[0].getAttribute('style')).toMatch(/background:\s*(#D9E1F2|rgb\(217, 225, 242\))/i);
    expect(cells[0].getAttribute('style')).toMatch(/width:\s*48pt/);
    expect(cells[4].getAttribute('colspan')).toBe('2');
    // Cells hold their text directly, as the classic editor emits them.
    expect(cells[0].querySelector('p')).toBeNull();
  });

  test('an Outlook signature keeps its colours and its logo', async () => {
    const pasted = sanitizeRichHtml(cleanPastedHtml(SIGNATURE));
    const { out } = await load(pasted);
    const d = dom(out());
    const name = [...d.querySelectorAll('span')].find((s) => s.textContent === 'Jane Doe');
    expect(name.getAttribute('style')).toMatch(/color:\s*(#1F4E79|rgb\(31, 78, 121\))/i);
    expect(name.closest('strong, b')).not.toBeNull();
    const img = d.querySelector('img');
    expect(img.getAttribute('src')).toBe('https://example.com/logo.png');
    expect(img.getAttribute('width')).toBe('120');
    expect(d.textContent).toContain('IT Coordinator | BGC Engineering');
  });

  test('lists, blank lines, links, quotes and code keep the classic shapes', async () => {
    const html = '<p>Hi Rita,</p><p><br></p><ul><li>one</li><li>two <strong>bold</strong></li></ul><ol><li>first</li></ol>'
      + '<blockquote>quoted</blockquote><pre><code>Get-Service | Where Status -eq Running\n  indented</code></pre>'
      + '<p>See <a href="https://example.com/kb" target="_blank" rel="noreferrer">the article</a> and <code>ipconfig /all</code>.</p>';
    const { out } = await load(html);
    const result = out();
    const d = dom(result);
    expect([...d.querySelectorAll('ul > li')].map((li) => li.innerHTML)).toEqual(['one', 'two <strong>bold</strong>']);
    expect(d.querySelector('ol > li').innerHTML).toBe('first');
    expect(result).toContain('<p>Hi Rita,</p><p><br></p>');
    expect(d.querySelector('blockquote').textContent).toBe('quoted');
    expect(d.querySelector('pre code').textContent).toBe('Get-Service | Where Status -eq Running\n  indented');
    const a = d.querySelector('a');
    expect(a.getAttribute('href')).toBe('https://example.com/kb');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(d.querySelector('p code').textContent).toBe('ipconfig /all');
    // The plain-text mirror reads like the classic editor's.
    expect(htmlToPlainText(result)).toBe('Hi Rita,\n\n- one\n- two bold\n- first\nquoted\nGet-Service | Where Status -eq Running\n  indented\nSee the article and ipconfig /all.');
  });

  test('an @mention stays a mention, and a pasted picture goes out as its marker', async () => {
    const { out } = await load('<p><strong class="tp-mention">@Sam Ortiz</strong>&nbsp;see <img class="tp-editor-thumb" data-tp-img="pasted-image-1.png" alt="[Image: pasted-image-1.png]" src="data:image/png;base64,iVBORw0KGgo="></p>');
    const result = out();
    expect(result).toContain('<strong class="tp-mention">@Sam Ortiz</strong>');
    expect(result).toContain('<i>[Image: pasted-image-1.png]</i>');
    expect(result).not.toContain('<img');
  });

  test('headings only exist where the host asks for them (Knowledge articles)', async () => {
    const withH = await load('<h2>Fix</h2><p>Steps</p>', { headings: true });
    expect(sanitizeRichHtml(classicShape(withH.editor.getHTML()), { headings: true })).toContain('<h2>Fix</h2>');
    cleanup();
    const without = await load('<h2>Fix</h2><p>Steps</p>');
    expect(without.out()).not.toContain('<h2>');
    expect(without.out()).toContain('Fix');
  });
});

describe('the contract with the host', () => {
  test('typing emits sanitized html and its text; clearing emits empty', async () => {
    const { editor, onChange } = await load('');
    act(() => { editor.commands.insertContent('Hello <b onclick="x()">team</b><img src="javascript:alert(1)">'); });
    const last = onChange.mock.calls.at(-1)[0];
    expect(last.html).toBe('<p>Hello <strong>team</strong></p>');
    expect(last.text).toBe('Hello team');
    act(() => { editor.commands.clearContent(true); });
    expect(onChange.mock.calls.at(-1)[0]).toEqual({ html: '', text: '' });
  });

  test('insertHtml and insertText go in at the caret; a new value replaces the content', async () => {
    const ref = createRef();
    const onChange = vi.fn();
    const { rerender } = render(<TiptapEditor ref={ref} value="<p>Hi</p>" onChange={onChange} ariaLabel="Body" />);
    await waitFor(() => expect(ref.current?.getEditor?.()).toBeTruthy());
    act(() => { ref.current.getEditor().commands.focus('end'); ref.current.insertText('👍'); });
    expect(onChange.mock.calls.at(-1)[0].text).toBe('Hi👍');
    act(() => { ref.current.insertHtml('<blockquote>quoted</blockquote>'); });
    expect(onChange.mock.calls.at(-1)[0].html).toContain('<blockquote>quoted</blockquote>');
    rerender(<TiptapEditor ref={ref} value="" onChange={onChange} ariaLabel="Body" />);
    await waitFor(() => expect(ref.current.getEditor().isEmpty).toBe(true));
  });

  test('writing help: the selected part is read and only that part is replaced; a changed selection is refused', async () => {
    const ref = createRef();
    const onChange = vi.fn();
    render(<TiptapEditor ref={ref} value="<p>Hi Rita. pls restart <strong>teh</strong> laptop. Thanks</p>" onChange={onChange} ariaLabel="Body" />);
    await waitFor(() => expect(ref.current?.getEditor?.()).toBeTruthy());
    expect(ref.current.getSelection()).toBeNull();
    // "pls restart teh laptop." sits at positions 10..33 of the paragraph.
    act(() => { ref.current.getEditor().commands.setTextSelection({ from: 10, to: 33 }); });
    const sel = ref.current.getSelection();
    expect(sel.text).toBe('pls restart teh laptop.');
    expect(sel.rich).toBe(true);
    let ok;
    act(() => { ok = ref.current.replaceSelection(sel.token, 'Please restart the laptop.'); });
    expect(ok).toBe(true);
    expect(onChange.mock.calls.at(-1)[0].text).toBe('Hi Rita. Please restart the laptop. Thanks');
    // The same token again: that text is no longer there.
    act(() => { ok = ref.current.replaceSelection(sel.token, 'again'); });
    expect(ok).toBe(false);
    expect(onChange.mock.calls.at(-1)[0].text).toBe('Hi Rita. Please restart the laptop. Thanks');
  });

  test('it is a labelled, spell-checked textbox, and Ctrl+Enter submits (Shift for send and set status)', async () => {
    const onSubmit = vi.fn();
    await load('<p>x</p>', { onSubmit });
    const box = screen.getByRole('textbox', { name: 'Body' });
    expect(box).toHaveAttribute('spellcheck', 'true');
    expect(box).toHaveAttribute('lang', 'en-CA');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenLastCalledWith();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenLastCalledWith({ shift: true });
  });

  test('the toolbar has the classic buttons plus undo, redo and strikethrough', async () => {
    await load('<p>x</p>', { onToggleExpand: () => {} });
    for (const name of ['Bold', 'Italic', 'Underline', 'Strikethrough', 'Bulleted list', 'Numbered list', 'Quote', 'Inline code', 'Code block', 'Insert link', 'Undo', 'Redo', 'Clear formatting', 'Full screen']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });
});

describe('complete as I type', () => {
  const PHRASES = ['I will let you know once the vendor replies.', 'Could you tell me the model of the device?'];
  const ghost = (editor) => GHOST_KEY.getState(editor.state)?.text || null;
  const press = (key, extra = {}) => screen.getByRole('textbox', { name: 'Body' }).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));

  test('off by default: no grey text, and Tab is not taken', async () => {
    const { editor } = await load('', { completionPhrases: PHRASES });
    act(() => { editor.commands.insertContent('I will'); });
    expect(ghost(editor)).toBeNull();
    expect(document.querySelector('[data-ghost]')).toBeNull();
  });

  test('offers the rest in grey; it is never part of what is sent; Tab takes it', async () => {
    const { editor, onChange } = await load('', { completionPhrases: PHRASES, completionOn: true });
    act(() => { editor.commands.insertContent('I will'); });
    expect(ghost(editor)).toBe(' let you know once the vendor replies.');
    await waitFor(() => expect(document.querySelector('[data-ghost]')).toHaveTextContent('let you know once the vendor replies.'));
    expect(onChange.mock.calls.at(-1)[0]).toEqual({ html: '<p>I will</p>', text: 'I will' });
    act(() => { press('Tab'); });
    expect(onChange.mock.calls.at(-1)[0].text).toBe('I will let you know once the vendor replies.');
    expect(ghost(editor)).toBeNull();
  });

  test('Ctrl+Right takes one word; Esc waves it away until the text changes', async () => {
    const { editor, onChange } = await load('', { completionPhrases: PHRASES, completionOn: true });
    act(() => { editor.commands.insertContent('Could you'); });
    act(() => { press('ArrowRight', { ctrlKey: true }); });
    expect(onChange.mock.calls.at(-1)[0].text).toBe('Could you tell');
    expect(ghost(editor)).toBe(' me the model of the device?');
    act(() => { press('Escape'); });
    expect(ghost(editor)).toBeNull();
    act(() => { editor.commands.insertContent(' me'); });
    expect(ghost(editor)).toBe(' the model of the device?');
  });

  test('only at the end of a line of prose: not mid-sentence and not in code', async () => {
    const { editor } = await load('<p>I will see</p>', { completionPhrases: PHRASES, completionOn: true });
    act(() => { editor.commands.setTextSelection(7); }); // after "I will", text follows
    expect(ghost(editor)).toBeNull();
    act(() => { editor.commands.setContent('<pre><code>I will</code></pre>'); editor.commands.focus('end'); });
    expect(ghost(editor)).toBeNull();
  });
});
