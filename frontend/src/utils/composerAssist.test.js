/** @vitest-environment jsdom */
import { describe, expect, test } from 'vitest';
import { hasRichMarkup, plainToHtml } from './composerAssist';
import { reconcileDraft } from '../hooks/useServerDraft';

describe('plainToHtml', () => {
  test('paragraphs, line breaks and lists; markup in the text is escaped', () => {
    expect(plainToHtml('Hi Rita,\n\nPlease try:\n- restart\n- sign in <again>\n\n1. one\n2) two\nThanks'))
      .toBe('<p>Hi Rita,</p><p>Please try:</p><ul><li>restart</li><li>sign in &lt;again&gt;</li></ul><ol><li>one</li><li>two</li></ol><p>Thanks</p>');
    expect(plainToHtml('a\nb')).toBe('<p>a<br>b</p>');
    expect(plainToHtml('  ')).toBe('');
  });
  test('inline: one line goes in with no paragraph around it', () => {
    expect(plainToHtml('restart the laptop', { inline: true })).toBe('restart the laptop');
    expect(plainToHtml('a\n\nb', { inline: true })).toBe('<p>a</p><p>b</p>');
  });
  test('hasRichMarkup spots what a plain-text rewrite would lose', () => {
    expect(hasRichMarkup('<p>plain <br> text</p>')).toBe(false);
    expect(hasRichMarkup('<p>see <a href="https://x.io">this</a></p>')).toBe(true);
    expect(hasRichMarkup('<p><strong class="tp-mention">@Bo</strong></p>')).toBe(true);
    expect(hasRichMarkup('<table><tr><td>1</td></tr></table>')).toBe(true);
  });
});

describe('reconcileDraft', () => {
  const cases = [
    [{ local: '', server: '', synced: '' }, 'keep'],
    [{ local: '', server: 'S', synced: '' }, 'adopt'],
    [{ local: 'L', server: '', synced: '' }, 'keep'], // never saved: it will be
    [{ local: 'L', server: '', synced: 'L' }, 'drop'], // saved, then sent or cleared elsewhere
    [{ local: 'L2', server: '', synced: 'L' }, 'keep'], // edited since
    [{ local: 'S', server: 'S', synced: 'S' }, 'keep'],
    [{ local: 'L', server: 'S', synced: 'L' }, 'adopt'], // the server moved on elsewhere
    [{ local: 'L2', server: 'S', synced: 'L' }, 'keep'], // unsent edits here win
    [{ local: 'L', server: 'S', synced: '' }, 'keep'],
  ];
  test.each(cases)('%o → %s', (input, verdict) => { expect(reconcileDraft(input)).toBe(verdict); });
});
