/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import RichTextEditor from './RichTextEditor';
import MentionNotice, { mentionNoticeText } from './MentionNotice';
import { buildThreadPayload } from '../../services/api';

// @mentions in internal notes (29 Oct 2026).

const people = [
  { id: 20, name: 'Gaby Tonnova' },
  { id: 4, name: 'Alexey Lavrenyuk' },
  { id: 7, name: 'Soheil Nasiri' },
];

// jsdom has no execCommand: insertHTML replaces the selection, as a browser does.
let originalExec;
beforeEach(() => {
  originalExec = document.execCommand;
  document.execCommand = vi.fn((cmd, _ui, html) => {
    if (cmd !== 'insertHTML') return false;
    const sel = window.getSelection();
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    range.insertNode(tpl.content);
    return true;
  });
});
afterEach(() => { document.execCommand = originalExec; cleanup(); });

function typeInto(editor, text) {
  editor.innerHTML = '';
  const node = document.createTextNode(text);
  editor.appendChild(node);
  const range = document.createRange();
  range.setStart(node, text.length);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent.input(editor);
}

describe('the @ menu in the note editor', () => {
  it('offers matching colleagues after "@" and inserts the picked name', () => {
    const onMention = vi.fn();
    const onChange = vi.fn();
    render(<RichTextEditor ariaLabel="Internal note body" mentionPeople={people} onMention={onMention} onChange={onChange} />);
    const editor = screen.getByRole('textbox', { name: 'Internal note body' });
    typeInto(editor, 'Hello @ga');
    const menu = screen.getByTestId('mention-menu');
    expect(menu).toHaveTextContent('Gaby Tonnova');
    expect(menu).not.toHaveTextContent('Soheil');
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Gaby Tonnova' }));
    expect(onMention).toHaveBeenCalledWith({ id: 20, name: 'Gaby Tonnova' });
    expect(editor.querySelector('.tp-mention')).toHaveTextContent('@Gaby Tonnova');
    expect(editor.textContent).toContain('Hello @Gaby Tonnova');
    expect(onChange.mock.calls.at(-1)[0].text).toContain('@Gaby Tonnova');
    expect(screen.queryByTestId('mention-menu')).toBeNull();
  });

  it('Enter picks the highlighted person, arrows move, Esc closes', () => {
    const onMention = vi.fn();
    render(<RichTextEditor ariaLabel="Internal note body" mentionPeople={people} onMention={onMention} />);
    const editor = screen.getByRole('textbox', { name: 'Internal note body' });
    typeInto(editor, '@');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onMention).toHaveBeenCalledWith({ id: 4, name: 'Alexey Lavrenyuk' });
    typeInto(editor, 'again @so');
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByTestId('mention-menu')).toBeNull();
  });

  it('an e-mail address or a reply (no people) opens no menu', () => {
    const { rerender } = render(<RichTextEditor ariaLabel="Body" mentionPeople={people} onMention={() => {}} />);
    typeInto(screen.getByRole('textbox', { name: 'Body' }), 'write to gaby@example');
    expect(screen.queryByTestId('mention-menu')).toBeNull();
    rerender(<RichTextEditor ariaLabel="Body" mentionPeople={null} onMention={() => {}} />);
    typeInto(screen.getByRole('textbox', { name: 'Body' }), 'Hi @ga');
    expect(screen.queryByTestId('mention-menu')).toBeNull();
  });

  it('the caret lands after the bold name, outside it', () => {
    render(<RichTextEditor ariaLabel="Body" mentionPeople={people} onMention={() => {}} />);
    const editor = screen.getByRole('textbox', { name: 'Body' });
    typeInto(editor, '@ga');
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Gaby Tonnova' }));
    const sel = window.getSelection();
    expect(editor.querySelector('.tp-mention').contains(sel.anchorNode)).toBe(false);
  });

  it('text typed into a bold name moves out of it, and a mark that is no name is unbolded', () => {
    render(<RichTextEditor ariaLabel="Body" mentionPeople={people} onMention={() => {}} />);
    const editor = screen.getByRole('textbox', { name: 'Body' });
    editor.innerHTML = '<strong class="tp-mention">@Gaby Tonnova and more</strong><div><strong class="tp-mention">@Nobody</strong></div>';
    const tail = editor.querySelector('.tp-mention').firstChild;
    const range = document.createRange();
    range.setStart(tail, tail.nodeValue.length);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    fireEvent.input(editor);
    const marks = editor.querySelectorAll('.tp-mention');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('@Gaby Tonnova');
    expect(editor.textContent).toBe('@Gaby Tonnova and more@Nobody');
    expect(window.getSelection().anchorNode.nodeValue).toBe(' and more');
  });

  it('lists everyone who matches (not six), with their pictures', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, name: `Person ${String.fromCharCode(65 + i)}`, photoUrl: i === 0 ? 'https://example.test/a.jpg' : null }));
    render(<RichTextEditor ariaLabel="Body" mentionPeople={many} onMention={() => {}} />);
    typeInto(screen.getByRole('textbox', { name: 'Body' }), '@');
    expect(screen.getAllByRole('option')).toHaveLength(12);
    expect(screen.getByRole('option', { name: 'Person A' }).querySelector('img')).toHaveAttribute('src', 'https://example.test/a.jpg');
  });
});

describe('"You were mentioned" on the ticket', () => {
  it('names who, how many notes, and jumps to the note', () => {
    const onJump = vi.fn();
    render(<MentionNotice mentions={[{ entryId: 900, by: 'Alexey Lavrenyuk', at: '2026-10-28T22:28:35Z' }]} onJump={onJump} onDismiss={() => {}} />);
    expect(screen.getByTestId('mention-notice')).toHaveTextContent('Alexey Lavrenyuk mentioned you in a note');
    fireEvent.click(screen.getByRole('button', { name: 'Show the note' }));
    expect(onJump).toHaveBeenCalledWith(900);
  });

  it('one full stop, even when the time ends in "p.m."', () => {
    const text = mentionNoticeText([{ by: 'Alexey Lavrenyuk', at: '2026-10-29T22:28:35Z' }]);
    expect(text).not.toMatch(/\.\.$/);
    expect(text).toMatch(/\.$/);
  });

  it('several notes and people read naturally; none renders nothing', () => {
    expect(mentionNoticeText([{ by: 'Alexey Lavrenyuk' }, { by: 'Soheil Nasiri' }])).toBe('Alexey Lavrenyuk and Soheil Nasiri mentioned you in 2 notes.');
    const { container } = render(<MentionNotice mentions={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('sending the picks', () => {
  it('JSON notes carry the ids', () => {
    const [payload] = buildThreadPayload({ bodyText: 'hi @Gaby Tonnova', mentions: [20] });
    expect(payload.mentions).toEqual([20]);
  });

  it('a note with a picture keeps them in the form', () => {
    const file = new File(['x'], 'pasted-image-1.png', { type: 'image/png' });
    const [form] = buildThreadPayload({ bodyText: 'hi', files: [file], mentions: [20, 4] });
    expect(form.get('mentions')).toBe('20,4');
  });

  it('no picks, no field', () => {
    const [payload] = buildThreadPayload({ bodyText: 'hi' });
    expect(payload).not.toHaveProperty('mentions');
  });
});
