import { describe, expect, test } from '@jest/globals';
import { stripQuotedHtml, stripQuotedText } from '../src/utils/replyQuoteStripper.js';

/**
 * FR 09-10 — outbound replies now quote the whole conversation. If inbound
 * replies keep the sender's own quoted copy of that thread, every round trip
 * folds another copy in and message N carries N copies. This strips the client's
 * quote so the stored entry is what the person actually typed.
 *
 * Conservative by design: if stripping would leave nothing, keep the original.
 * Losing a customer's reply is far worse than storing a duplicate of one.
 */

describe('HTML — the shapes real clients send', () => {
  test('Gmail', () => {
    const html = '<div dir="ltr">Yes, that worked — thanks!</div>'
      + '<div class="gmail_quote"><div>On Wed, Sep 10, Soheil wrote:</div><blockquote>Try the VPN client.</blockquote></div>';
    const out = stripQuotedHtml(html);
    expect(out).toContain('Yes, that worked');
    expect(out).not.toContain('Try the VPN client');
  });

  test('Outlook / OWA', () => {
    const html = '<p>Confirmed, the laptop arrived.</p>'
      + '<div id="appendonsend"></div><div id="divRplyFwdMsg">From: Ticket Pulse<br>Sent: Thursday</div>';
    const out = stripQuotedHtml(html);
    expect(out).toContain('the laptop arrived');
    expect(out).not.toContain('divRplyFwdMsg');
  });

  test('Apple Mail / cited blockquote', () => {
    const html = '<div>Still broken.</div><blockquote type="cite"><div>Earlier message</div></blockquote>';
    expect(stripQuotedHtml(html)).not.toContain('Earlier message');
  });

  test('Thunderbird', () => {
    const html = '<p>Works now.</p><div class="moz-cite-prefix">On 10/09/2026, X wrote:</div><blockquote>old</blockquote>';
    expect(stripQuotedHtml(html)).not.toContain('old');
  });
});

describe('plain text — the shapes real clients send', () => {
  test('"On … wrote:"', () => {
    const text = 'Yes please go ahead.\n\nOn Wed, Sep 10, 2026 at 3:11 PM Soheil Nasiri wrote:\n> Shall I order it?';
    expect(stripQuotedText(text)).toBe('Yes please go ahead.');
  });

  test('Outlook "-----Original Message-----"', () => {
    const text = 'Approved.\n\n-----Original Message-----\nFrom: Ticket Pulse\nSubject: TP-1279';
    expect(stripQuotedText(text)).toBe('Approved.');
  });

  test('Outlook From:/Sent: header block', () => {
    const text = 'Looks good.\n\nFrom: Ticket Pulse <ticketpulse@bgcengineering.ca>\nSent: Thursday, September 10, 2026';
    expect(stripQuotedText(text)).toBe('Looks good.');
  });

  test('bare "> " quoting', () => {
    expect(stripQuotedText('No, not yet.\n\n> Did the driver install?')).toBe('No, not yet.');
  });
});

describe('it refuses to destroy a reply', () => {
  test('a reply that is ONLY a quote is kept whole', () => {
    // Someone replying with nothing but the quote still said something by
    // replying — better a duplicate than an empty entry.
    const text = '> Did the driver install?';
    expect(stripQuotedText(text)).toBe(text);
  });

  test('html that is only a quote container is kept whole', () => {
    const html = '<div class="gmail_quote"><blockquote>only this</blockquote></div>';
    expect(stripQuotedHtml(html)).toBe(html);
  });

  test('a reply with no quote at all is untouched', () => {
    const text = 'Thanks, all sorted.';
    expect(stripQuotedText(text)).toBe(text);
    const html = '<p>Thanks, all sorted.</p>';
    expect(stripQuotedHtml(html)).toBe(html);
  });

  test('empty and nullish inputs are safe', () => {
    for (const v of [null, undefined, '']) {
      expect(typeof stripQuotedHtml(v)).toBe('string');
      expect(typeof stripQuotedText(v)).toBe('string');
    }
  });

  test('the word "wrote" in ordinary prose does not truncate the reply', () => {
    const text = 'I wrote to the vendor yesterday and they confirmed the part is in stock.';
    expect(stripQuotedText(text)).toBe(text);
  });
});
