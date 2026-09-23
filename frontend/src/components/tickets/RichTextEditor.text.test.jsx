/** @vitest-environment jsdom */
import { describe, expect, test } from 'vitest';
import { htmlToPlainText } from './RichTextEditor';

/**
 * QA 09-22 #1: the composer's plain text came from innerText, which counts a
 * paragraph boundary as two breaks — one blank line between paragraphs became
 * five newlines and five <br/>s in the requester's mail.
 */
describe('htmlToPlainText', () => {
  test('one empty paragraph between two paragraphs is ONE blank line', () => {
    expect(htmlToPlainText('<p>Hi Susan,</p><p><br></p><p>Ticket TP-1618: QA TEST</p><p><br></p><p>Kind regards,</p>'))
      .toBe('Hi Susan,\n\nTicket TP-1618: QA TEST\n\nKind regards,');
    expect(htmlToPlainText('<div>Hi</div><div><br></div><div>There</div>')).toBe('Hi\n\nThere');
    expect(htmlToPlainText('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
  });

  test('a <br> inside a paragraph is a line break; lists get dashes; nbsp becomes a space', () => {
    expect(htmlToPlainText('<p>line one<br>line two</p>')).toBe('line one\nline two');
    expect(htmlToPlainText('<ul><li>first</li><li>second</li></ul><p>after</p>')).toBe('- first\n- second\nafter');
    expect(htmlToPlainText('<p>a&nbsp;b</p>')).toBe('a b');
  });

  test('plain text passes through with runs of blank lines collapsed', () => {
    expect(htmlToPlainText('a\n\n\n\n\nb')).toBe('a\n\nb');
    expect(htmlToPlainText('')).toBe('');
    expect(htmlToPlainText(null)).toBe('');
  });
});
