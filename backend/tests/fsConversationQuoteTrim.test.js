import { describe, expect, test } from '@jest/globals';
import { transformTicketConversationEntry } from '../src/integrations/freshserviceTransformer.js';
import { stripFlattenedQuoteHeader, stripQuotedHtml, stripQuotedText } from '../src/utils/replyQuoteStripper.js';

// QA 10-16: a "Thank you" from the requester arrived through FreshService
// carrying the whole earlier thread under Outlook desktop's "From: / Sent:"
// block, which has no id — only a thin grey top rule.
const THREAD = Array.from({ length: 40 }, (_, i) => `<p class="MsoNormal">Earlier message line ${i}</p>`).join('');
const OUTLOOK_REPLY_HTML = '<div class="WordSection1"><p class="MsoNormal">Thank you Sam.</p>'
  + '<p class="MsoNormal">Alex Doe | Senior Engineer</p>'
  + '<div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in">'
  + '<p class="MsoNormal"><b>From:</b> IT Helpdesk &lt;help@example.com&gt;<br><b>Sent:</b> Thursday, October 15, 2026 3:12 PM<br><b>To:</b> Alex Doe</p></div></div>'
  + THREAD + '</div>';
const OUTLOOK_REPLY_TEXT = 'Thank you Sam. Alex Doe | Senior Engineer From: IT Helpdesk <help@example.com> Sent: Thursday, October 15, 2026 3:12 PM To: Alex Doe Subject: RE: Remote computer Earlier message line 0 Earlier message line 1';

const conversation = (over = {}) => ({
  id: 1043300001,
  incoming: true,
  private: false,
  body: OUTLOOK_REPLY_HTML,
  body_text: OUTLOOK_REPLY_TEXT,
  from_email: 'Alex Doe <alex.doe@example.com>',
  user_id: 5001,
  created_at: '2026-10-15T23:01:35Z',
  ...over,
});

describe('Outlook desktop quoted history (QA 10-16)', () => {
  test('the HTML keeps what was written and drops the From/Sent block and everything after it', () => {
    const out = stripQuotedHtml(OUTLOOK_REPLY_HTML);
    expect(out).toContain('Thank you Sam.');
    expect(out).toContain('Alex Doe | Senior Engineer');
    expect(out).not.toContain('Sent:');
    expect(out).not.toContain('Earlier message line');
  });

  test('the flattened one-line text is cut at "From: … Sent: … To:"', () => {
    const out = stripFlattenedQuoteHeader(OUTLOOK_REPLY_TEXT);
    expect(out).toBe('Thank you Sam. Alex Doe | Senior Engineer');
  });

  test('"from" and "sent" in ordinary prose do not cut a reply', () => {
    const text = 'The file from the vendor was sent to Jo yesterday; to be safe I copied it.';
    expect(stripQuotedText(text)).toBe(text);
  });

  test('a pasted bounce in the person own text is never cut when the HTML has no quote block', () => {
    const text = 'Here is the bounce I got: From: postmaster Sent: Mon To: me Undeliverable';
    expect(stripQuotedText(text)).toBe(text);
    const entry = transformTicketConversationEntry(conversation({ body: `<p>${text}</p>`, body_text: text }), { ticketId: 61, workspaceId: 1 });
    expect(entry.bodyText).toBe(text);
    expect(entry.bodyHtml).toBe(`<p>${text}</p>`);
  });

  test('a reply that is only the quote is kept whole (losing a reply is worse than a long one)', () => {
    const onlyQuote = '<div style="border:none;border-top:solid #E1E1E1 1.0pt"><p><b>From:</b> A</p></div>';
    expect(stripQuotedHtml(onlyQuote)).toBe(onlyQuote);
  });
});

describe('FreshService conversation entries (QA 10-16)', () => {
  test('an incoming requester reply is stored trimmed; the full mail stays in rawPayload', () => {
    const entry = transformTicketConversationEntry(conversation(), { ticketId: 61, workspaceId: 1 });
    expect(entry.eventType).toBe('customer_reply');
    expect(entry.bodyHtml).toContain('Thank you Sam.');
    expect(entry.bodyHtml).not.toContain('Earlier message line');
    expect(entry.bodyText).toBe('Thank you Sam. Alex Doe | Senior Engineer');
    expect(entry.rawPayload.body).toBe(OUTLOOK_REPLY_HTML);
    expect(entry.rawPayload.tpQuotedHistoryTrimmed).toBe(true);
  });

  test('private notes and agent replies are never trimmed', () => {
    const note = transformTicketConversationEntry(conversation({ incoming: false, private: true }), { ticketId: 61, workspaceId: 1 });
    expect(note.eventType).toBe('private_note');
    expect(note.bodyHtml).toBe(OUTLOOK_REPLY_HTML);
    expect(note.rawPayload.tpQuotedHistoryTrimmed).toBeUndefined();
    const reply = transformTicketConversationEntry(conversation({ incoming: false }), { ticketId: 61, workspaceId: 1 });
    expect(reply.eventType).toBe('public_reply');
    expect(reply.bodyText).toBe(OUTLOOK_REPLY_TEXT);
  });

  test('a short reply with nothing quoted is stored exactly as it came', () => {
    const plain = conversation({ body: '<p>Works now, thanks.</p>', body_text: 'Works now, thanks.' });
    const entry = transformTicketConversationEntry(plain, { ticketId: 61, workspaceId: 1 });
    expect(entry.bodyHtml).toBe('<p>Works now, thanks.</p>');
    expect(entry.rawPayload).toBe(plain);
  });
});
