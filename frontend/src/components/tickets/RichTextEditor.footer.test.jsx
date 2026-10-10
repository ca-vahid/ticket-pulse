/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import RichTextEditor from './RichTextEditor';

// QA 10-09 #4: the reply composer shows the signature inside the editor frame,
// straight under the message. `footer` is read-only chrome — never part of the
// html the editor emits (the server appends the real signature at send time).
afterEach(cleanup);

const Signature = () => <div data-testid="sig">Ana Agent</div>;

describe('RichTextEditor footer', () => {
  test('renders after the editable area, inside the same scrolling frame', () => {
    render(<RichTextEditor value="<p>Hello</p>" onChange={() => {}} ariaLabel="Reply body" minHeight={280} footer={<Signature />} />);
    const editor = screen.getByRole('textbox', { name: 'Reply body' });
    const sig = screen.getByTestId('sig');
    expect(editor.nextElementSibling).toBe(sig);
    expect(editor).not.toContainElement(sig);
    // The frame takes over the height and the scrolling; the body hugs its text.
    expect(editor.parentElement).toHaveStyle({ minHeight: '280px', maxHeight: '460px' });
    expect(editor.style.minHeight).toBe('');
  });

  test('is never part of what the editor emits', () => {
    const onChange = vi.fn();
    render(<RichTextEditor value="" onChange={onChange} ariaLabel="Reply body" footer={<Signature />} />);
    const editor = screen.getByRole('textbox', { name: 'Reply body' });
    editor.innerHTML = '<p>Kind regards,</p>';
    fireEvent.input(editor);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ html: '<p>Kind regards,</p>' }));
    expect(onChange.mock.calls.at(-1)[0].html).not.toContain('Ana Agent');
  });

  test('a click on the empty space of the frame puts the caret in the message', () => {
    render(<RichTextEditor value="<p>Hello</p>" onChange={() => {}} ariaLabel="Reply body" footer={<Signature />} />);
    const editor = screen.getByRole('textbox', { name: 'Reply body' });
    fireEvent.mouseDown(editor.parentElement);
    expect(editor).toHaveFocus();
  });

  test('the editable node keeps its content when the footer comes and goes (note ⇄ reply)', () => {
    const { rerender } = render(<RichTextEditor value="<p>Draft</p>" onChange={() => {}} ariaLabel="Body" />);
    const editor = screen.getByRole('textbox', { name: 'Body' });
    // Without a footer the editor is laid out exactly as before.
    expect(editor).toHaveStyle({ minHeight: '170px', maxHeight: '460px' });
    expect(editor.parentElement).not.toHaveAttribute('style');

    rerender(<RichTextEditor value="<p>Draft</p>" onChange={() => {}} ariaLabel="Body" footer={<Signature />} />);
    expect(screen.getByRole('textbox', { name: 'Body' })).toBe(editor);
    expect(editor).toHaveTextContent('Draft');

    rerender(<RichTextEditor value="<p>Draft</p>" onChange={() => {}} ariaLabel="Body" />);
    expect(screen.getByRole('textbox', { name: 'Body' })).toBe(editor);
    expect(editor).toHaveTextContent('Draft');
    expect(screen.queryByTestId('sig')).toBeNull();
  });
});
