import { describe, expect, test } from 'vitest';
import { compactTemplateHtml, formatTemplateHtml } from './templateHtmlFormat';

// QA 10-05 #4: template HTML must stay readable after an edit.
describe('formatTemplateHtml', () => {
  test('one long line from the rich editor gets a line per block', () => {
    const oneLine = '<p>We received your request <strong>#{{ ticket.id }}</strong>.</p><p>{{ ticket.subject }}</p>{% if a %}<p>Starts {{ when }}.</p>{% endif %}<p>Bye</p>';
    expect(formatTemplateHtml(oneLine)).toBe([
      '<p>We received your request <strong>#{{ ticket.id }}</strong>.</p>',
      '<p>{{ ticket.subject }}</p>',
      '{% if a %}',
      '<p>Starts {{ when }}.</p>',
      '{% endif %}',
      '<p>Bye</p>',
    ].join('\n'));
  });

  test('never breaks next to text or between two Liquid tags (a new line there could show as a space)', () => {
    const inline = '<p>Hi {% if a %}A{% endif %}{% if b %}B{% endif %} there <a href="x">link</a></p>';
    expect(formatTemplateHtml(inline)).toBe(inline);
  });

  test('HTML that already has line breaks is left exactly as written', () => {
    const authored = '<table>\n  <tr><td>Kept</td></tr>\n</table>';
    expect(formatTemplateHtml(authored)).toBe(authored);
    expect(formatTemplateHtml('')).toBe('');
    expect(formatTemplateHtml(null)).toBe('');
  });

  test('formatting only adds breaks: compacting gives the original back', () => {
    const oneLine = '<table><tr><td>A</td><td>B</td></tr></table>{% if x %}<p>C</p>{% endif %}';
    expect(compactTemplateHtml(formatTemplateHtml(oneLine))).toBe(oneLine);
  });
});
