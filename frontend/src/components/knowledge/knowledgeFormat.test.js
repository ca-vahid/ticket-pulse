/** @vitest-environment jsdom */
import { describe, expect, test } from 'vitest';
import { readableReason } from './knowledgeFormat';
import { renderDisclosure } from './KnowledgeSettingsStrip';
import { sanitizeRichHtml } from '../tickets/RichTextEditor';

describe('Knowledge QA 09-25 helpers', () => {
  test('model reasons name the article, never "article:1"', () => {
    const sources = [{ sourceId: 'article:1', title: 'Install software from Company Portal' }];
    expect(readableReason('Supported per article:1 and Article:1.', sources))
      .toBe('Supported per “Install software from Company Portal” and “Install software from Company Portal”.');
    expect(readableReason('See ticket:99', [])).toBe('See a resolved ticket');
    expect(readableReason(null, sources)).toBeNull();
  });

  test('the disclosure preview fills {{workspace}} like the runner does', () => {
    expect(renderDisclosure('Automated answer from the {{ workspace }} team.', 'IT')).toBe('Automated answer from the IT team.');
    expect(renderDisclosure('From the {{workspace}} team.', null)).toBe('From the support team.');
  });

  test('headings survive only in the article editor (K1); the reply composer is unchanged', () => {
    const html = '<h2>Install</h2><p>Open it.</p><h3>Sub</h3>';
    expect(sanitizeRichHtml(html, { headings: true })).toBe(html);
    expect(sanitizeRichHtml(html)).toBe('Install<p>Open it.</p>Sub');
  });
});
