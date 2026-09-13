import { describe, expect, test } from 'vitest';
import { plainTextToHtml } from './plainTextToHtml';

/**
 * FR 09-11 #3 — "There are extra spaces in the requester's reply in the
 * conversation section. Remove the extra spacing."
 *
 * The body below is the real TP-1291 text from production: Chelsea Simpson's
 * August email, forwarded to patickets@, stored with NO HTML at all and every
 * line separated by a blank line. Rendering one <br> per newline gave a full
 * empty line between "Planning" and "Packing/Moving".
 */

// Verbatim from ticket_thread_entries.body_text, entry 3160654 (truncated).
const TP1291 = [
  'Hi PA Team,', '',
  'Can we please have an A-code opened for the Santiago Office Planning and Move?', '',
  'Start date – August 17, 2026', '',
  'End date – September 30, 2028', '',
  'Budget - $650,000', '',
  'BST Tasks', '',
  'Fees - $50k', '',
  'Planning', '',
  'Packing/Moving', '',
].join('\n');

describe('the TP-1291 body QA screenshotted', () => {
  const html = plainTextToHtml(TP1291);

  test('no longer emits a blank line between every line', () => {
    // The old renderer produced `<br><br>` between each line. That is the bug.
    expect(html).not.toMatch(/<br>\s*<br>/);
  });

  test('each line becomes its own paragraph, so nothing runs together', () => {
    expect(html).toContain('<p>Planning</p>');
    expect(html).toContain('<p>Packing/Moving</p>');
    expect(html).toContain('<p>BST Tasks</p>');
  });

  test('keeps every line — tightening spacing must not drop content', () => {
    for (const line of TP1291.split('\n').filter(Boolean)) {
      expect(html).toContain(line.replace(/&/g, '&amp;'));
    }
  });
});

describe('structure is preserved, not flattened', () => {
  test('a single newline stays a line break inside one paragraph', () => {
    expect(plainTextToHtml('Line one\nLine two')).toBe('<p>Line one<br>Line two</p>');
  });

  test('a blank line still starts a new paragraph', () => {
    expect(plainTextToHtml('Para one\n\nPara two')).toBe('<p>Para one</p><p>Para two</p>');
  });

  test('genuine prose keeps its paragraphs — this must not become one blob', () => {
    const prose = 'Thanks for looking into this.\n\nThe invoice still shows the old rate, '
      + 'and finance need it corrected before month end.\n\nLet me know if you need anything.';
    const out = plainTextToHtml(prose);
    expect(out.match(/<p>/g)).toHaveLength(3);
  });

  test('runs of three or more blank lines collapse to one paragraph break', () => {
    expect(plainTextToHtml('A\n\n\n\nB')).toBe('<p>A</p><p>B</p>');
  });

  test('CRLF is handled the same as LF', () => {
    expect(plainTextToHtml('A\r\n\r\nB')).toBe('<p>A</p><p>B</p>');
  });

  test('non-breaking spaces become ordinary spaces', () => {
    expect(plainTextToHtml('Start date  August 17')).toBe('<p>Start date  August 17</p>');
  });
});

describe('safety', () => {
  test('HTML in a plain-text body is escaped, never executed', () => {
    const out = plainTextToHtml('<script>alert(1)</script> & "quoted" <b>bold</b>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;quoted&quot;');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<b>');
  });

  test('empty and nullish input produce nothing, not an empty paragraph', () => {
    expect(plainTextToHtml('')).toBe('');
    expect(plainTextToHtml(null)).toBe('');
    expect(plainTextToHtml(undefined)).toBe('');
    expect(plainTextToHtml('   \n\n  ')).toBe('');
  });
});
