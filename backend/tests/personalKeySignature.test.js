import { normalizeSignatureText, stripTrailingSignature } from '../src/utils/personalKeySignature.js';

/**
 * Personal API keys (4.4.05), owner change 4: a personal-key reply that ends
 * with the person's own signature has that trailing copy dropped (the app adds
 * it once). Exact match only; nothing else is ever removed.
 */
const SIG = {
  html: '<p style="margin: 0"><strong>Dana Fox</strong><br>IT Service Desk<br>dana.fox@example.com</p>',
  text: 'Dana Fox\nIT Service Desk\ndana.fox@example.com',
};

describe('normalizeSignatureText', () => {
  test('tags out, entities decoded, white space collapsed', () => {
    expect(normalizeSignatureText('<p>Dana&nbsp;Fox<br>IT &amp; Ops</p>')).toBe('Dana Fox IT & Ops');
    expect(normalizeSignatureText('  Dana\n\nFox  ')).toBe('Dana Fox');
    expect(normalizeSignatureText(null)).toBe('');
  });
});

describe('stripTrailingSignature — HTML bodies', () => {
  test('a trailing copy of the signature (its own paragraph) is dropped', () => {
    const out = stripTrailingSignature({ bodyHtml: '<p>Hi Sam,</p><p>The printer is fixed.</p><p><b>Dana Fox</b><br>IT Service Desk<br>dana.fox@example.com</p>' }, SIG);
    expect(out.removed).toBe(true);
    expect(out.bodyHtml).toBe('<p>Hi Sam,</p><p>The printer is fixed.</p>');
  });

  test('blank paragraphs and <br>s between the message and the copy go too', () => {
    const out = stripTrailingSignature({ bodyHtml: '<p>Done.</p><p><br></p><p>Dana Fox<br>IT Service Desk<br>dana.fox@example.com</p>' }, SIG);
    expect(out.removed).toBe(true);
    expect(out.bodyHtml).toBe('<p>Done.</p>');
  });

  test('a copy that starts mid-paragraph after a <br> is dropped; the head is kept as written', () => {
    const out = stripTrailingSignature({ bodyHtml: '<p>Thanks,<br>Dana Fox<br>IT Service Desk<br>dana.fox@example.com</p>' }, SIG);
    expect(out.removed).toBe(true);
    expect(out.bodyHtml).toBe('<p>Thanks,');
  });

  test('a partial signature, a sign-off name only, or the signature in the middle is left alone', () => {
    const partial = '<p>Done.</p><p>Dana Fox<br>IT Service Desk</p>';
    expect(stripTrailingSignature({ bodyHtml: partial }, SIG)).toEqual({ bodyText: null, bodyHtml: partial, removed: false });
    const signOff = '<p>Done.</p><p>Thanks, Dana</p>';
    expect(stripTrailingSignature({ bodyHtml: signOff }, SIG).removed).toBe(false);
    const middle = '<p>Dana Fox<br>IT Service Desk<br>dana.fox@example.com</p><p>PS: call me.</p>';
    expect(stripTrailingSignature({ bodyHtml: middle }, SIG).removed).toBe(false);
  });

  test('extra words in the same block are not a match (exact only)', () => {
    const body = '<p>Done.</p><p>Regards Dana Fox<br>IT Service Desk<br>dana.fox@example.com</p>';
    expect(stripTrailingSignature({ bodyHtml: body }, SIG).removed).toBe(false);
  });

  test('a body that is nothing but the signature is left alone', () => {
    const body = '<p>Dana Fox<br>IT Service Desk<br>dana.fox@example.com</p>';
    expect(stripTrailingSignature({ bodyHtml: body }, SIG)).toEqual({ bodyText: null, bodyHtml: body, removed: false });
  });

  test('no signature (none saved, or switched off) changes nothing', () => {
    const body = { bodyHtml: '<p>Done.</p>', bodyText: 'Done.' };
    expect(stripTrailingSignature(body, null)).toEqual({ ...body, removed: false });
    expect(stripTrailingSignature(body, { html: '', text: '' })).toEqual({ ...body, removed: false });
  });
});

describe('stripTrailingSignature — plain text bodies', () => {
  test('the trailing lines that read as the signature are dropped', () => {
    const out = stripTrailingSignature({ bodyText: 'Hi Sam,\n\nThe printer is fixed.\n\nDana Fox\nIT Service Desk\ndana.fox@example.com\n' }, SIG);
    expect(out).toEqual({ bodyText: 'Hi Sam,\n\nThe printer is fixed.', bodyHtml: null, removed: true });
  });

  test('the signature on one line (white space differs) still matches; a "-- " delimiter line stays', () => {
    const out = stripTrailingSignature({ bodyText: 'Fixed.\n--\nDana Fox IT Service Desk   dana.fox@example.com' }, SIG);
    expect(out.removed).toBe(true);
    expect(out.bodyText).toBe('Fixed.\n--');
  });

  test('a different last line is never touched', () => {
    const body = 'Fixed.\nDana Fox\nIT Service Desk\ndana.fox@example.com\nPS: back Monday';
    expect(stripTrailingSignature({ bodyText: body }, SIG)).toEqual({ bodyText: body, bodyHtml: null, removed: false });
  });
});
