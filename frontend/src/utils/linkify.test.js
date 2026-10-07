/** @vitest-environment jsdom */
import { describe, expect, test } from 'vitest';
import { linkifyHtml, shortLinkLabel } from './linkify';

// QA 10-06 #8: a pasted link in a description was plain text (TP-1790).
const AMAZON = 'https://www.amazon.ca/Dell-Power-Adapter-7-4mm-Factor/dp/B0F493DZTG/ref=sr_1_1?crid=33DREZT7MEK44&dib=eyJ2IjoiMSJ9&keywords=Dell+240W&qid=1791311101&sr=1-1';

const anchors = (html) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return [...d.querySelectorAll('a')];
};

describe('linkifyHtml', () => {
  test('the TP-1790 Amazon link becomes a short, new-tab link with the full address as tooltip', () => {
    const out = linkifyHtml(`<p>Gaby,<br>please order one of those to be delivered to Calgary:<br>${AMAZON}</p><p>Thank you.</p>`);
    const [a] = anchors(out);
    expect(a.getAttribute('href')).toBe(AMAZON);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.getAttribute('title')).toBe(AMAZON);
    expect(a.textContent).toMatch(/^amazon\.ca\/Dell-Power-Adapter/);
    expect(a.textContent.length).toBeLessThanOrEqual(48);
    expect(a.textContent.endsWith('…')).toBe(true);
    expect(out).toContain('Thank you.');
  });

  test('sentence punctuation stays outside; www. gets https; short links keep their text', () => {
    const out = linkifyHtml('See https://example.com/a. Or www.bgcengineering.ca, (https://x.org/y) ok');
    const links = anchors(out);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a', 'https://www.bgcengineering.ca', 'https://x.org/y']);
    expect(links[0].textContent).toBe('https://example.com/a');
    expect(out).toContain('</a>. Or');
    expect(out).toContain('</a>) ok');
  });

  test('existing links, code and plain text are untouched', () => {
    const html = '<a href="https://a.com">https://a.com</a> <code>https://b.com</code> no links here';
    expect(anchors(linkifyHtml(html))).toHaveLength(1);
    expect(linkifyHtml('nothing to see')).toBe('nothing to see');
  });

  test('labels', () => {
    expect(shortLinkLabel('https://example.com')).toBe('https://example.com');
    expect(shortLinkLabel('https://www.bgcengineering.ca/about/team/very/long/path/that/keeps/going/on')).toMatch(/^bgcengineering\.ca\/about.*…$/);
  });
});
