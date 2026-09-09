import { jest } from '@jest/globals';

/**
 * Signature line spacing (QA 09-08).
 *
 * The reported bug: a signature pasted from Outlook went out looking far
 * looser than the same signature sent from FreshService. Cause — the composer
 * paste filter kept `color` but dropped `margin`, leaving bare <p> lines that
 * every mail client pads with its own ~1em paragraph margin. These tests pin
 * the send-time fix against the reporter's ACTUAL stored signature shape.
 */

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  applySignatureSpacing, appendSignatureToEmail, normalizeSpacing,
  SIGNATURE_SPACINGS, DEFAULT_SIGNATURE_SPACING,
} = await import('../src/services/userSignatureService.js');

// Trimmed from the real production row (mblackstock@bgcengineering.ca): six
// bare <p> lines, colors intact, not one margin declaration anywhere.
const REPORTED_SIGNATURE = '<p style="background-color:rgb(255, 255, 255)"><span style="color:rgb(12, 25, 117)">'
  + '<b>Marcus Blackstock,</b></span></p><p><span style="color:rgb(0, 0, 0)">Junior IT Technician</span></p>'
  + '<p><span style="color:rgb(0, 0, 0)">BGC Engineering</span></p>';

describe('signature line spacing', () => {
  test('the reporter\'s signature has no margins of its own — the bug in one line', () => {
    expect(REPORTED_SIGNATURE).not.toMatch(/margin/i);
    expect((REPORTED_SIGNATURE.match(/<p\b/g) || []).length).toBe(3);
  });

  test('tight puts margin:0 on every paragraph', () => {
    const out = applySignatureSpacing(REPORTED_SIGNATURE, 'tight');
    const paragraphs = out.match(/<p\b[^>]*>/g) || [];
    expect(paragraphs).toHaveLength(3);
    for (const p of paragraphs) expect(p).toMatch(/style="margin: 0(?:;|")/);
  });

  test('normal and relaxed set their own margins', () => {
    expect(applySignatureSpacing(REPORTED_SIGNATURE, 'normal')).toContain('margin: 0 0 6px');
    expect(applySignatureSpacing(REPORTED_SIGNATURE, 'relaxed')).toContain('margin: 0 0 12px');
  });

  test('existing non-margin styles survive; existing margins are replaced, never stacked', () => {
    const out = applySignatureSpacing(REPORTED_SIGNATURE, 'tight');
    // The author's background-color is still there…
    expect(out).toContain('background-color:rgb(255, 255, 255)');
    // …and applying twice does not compound margin declarations.
    const twice = applySignatureSpacing(out, 'tight');
    expect((twice.match(/margin:/g) || []).length).toBe(3);
  });

  test('an author margin loses to the chosen spacing', () => {
    const authored = '<p style="margin:24px 0; color:red">Hi</p>';
    const out = applySignatureSpacing(authored, 'tight');
    expect(out).not.toContain('24px');
    expect(out).toContain('margin: 0');
    expect(out).toContain('color:red');
  });

  test('only <p> is rewritten — <div> layout is left alone', () => {
    const divs = '<div style="padding:4px">Line</div><table><tr><td>Cell</td></tr></table>';
    expect(applySignatureSpacing(divs, 'tight')).toBe(divs);
  });

  test('spacing normalizes, and anything unrecognised falls back to tight', () => {
    expect(SIGNATURE_SPACINGS).toEqual(['tight', 'normal', 'relaxed']);
    expect(DEFAULT_SIGNATURE_SPACING).toBe('tight');
    expect(normalizeSpacing('RELAXED')).toBe('relaxed');
    expect(normalizeSpacing('enormous')).toBe('tight');
    expect(normalizeSpacing(null)).toBe('tight');
  });

  test('empty input stays empty', () => {
    expect(applySignatureSpacing('', 'tight')).toBe('');
    expect(applySignatureSpacing(null, 'tight')).toBe('');
  });

  test('the send path applies the spacing to the outbound email', () => {
    const email = { html: '<p>Thanks for the update.</p>', text: 'Thanks for the update.' };
    const out = appendSignatureToEmail(email, { html: REPORTED_SIGNATURE, text: 'Marcus', spacing: 'tight' });
    expect(out.html).toContain('margin: 0');
    expect(out.html).toContain('Junior IT Technician');
    // The reply body itself is untouched — only the signature is respaced.
    expect(out.html.startsWith('<p>Thanks for the update.</p>')).toBe(true);
    // Plain-text variant keeps the classic delimiter.
    expect(out.text).toContain('\n\n-- \n');
  });

  test('a signature with no spacing recorded still goes out tight', () => {
    const out = appendSignatureToEmail({ html: '<p>Body</p>' }, { html: REPORTED_SIGNATURE, text: 'Marcus' });
    expect(out.html).toContain('margin: 0');
  });
});
