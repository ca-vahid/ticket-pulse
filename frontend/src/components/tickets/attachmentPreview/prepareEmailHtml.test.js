/** @vitest-environment jsdom */
import { describe, expect, test } from 'vitest';
import { prepareEmailHtml } from './prepareEmailHtml';

describe('prepareEmailHtml (an e-mail from a stranger)', () => {
  const html = '<p>Hi</p><img src="https://tracker.example.com/open.gif"><img src="data:image/png;base64,AAAA" alt="inline">'
    + '<table><tr><td background="https://cdn.example.com/bg.png">x</td></tr></table><div style="background:url(https://cdn.example.com/a.png) no-repeat">y</div>'
    + '<a href="https://example.com/invoice">invoice</a>';

  test('remote pictures are hidden and counted; pictures inside the e-mail stay', () => {
    const { html: out, blocked } = prepareEmailHtml(html);
    expect(blocked).toBe(3);
    expect(out).not.toContain('tracker.example.com');
    expect(out).not.toContain('cdn.example.com');
    expect(out).toContain('data:image/png;base64,AAAA');
  });

  test('Show pictures brings them back', () => {
    const { html: out, blocked } = prepareEmailHtml(html, { showImages: true });
    expect(blocked).toBe(0);
    expect(out).toContain('https://tracker.example.com/open.gif');
  });

  test('links open in a new tab without a referrer', () => {
    const { html: out } = prepareEmailHtml(html);
    expect(out).toMatch(/<a href="https:\/\/example\.com\/invoice" target="_blank" rel="noopener noreferrer">/);
  });
});
