import { describe, expect, test } from 'vitest';
import { replyBodyParts, splitQuotedHistory } from './quotedHistory';

const QUOTE = '<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p><b>From:</b> IT Helpdesk<br><b>Sent:</b> Thursday</p></div><p>Earlier message</p>';
const REPLY = `<p>Thank you Sam.</p><p>Alex Doe</p>${QUOTE}`;

describe('quoted history under a requester reply (QA 10-16)', () => {
  test('splits at the Outlook desktop From/Sent block', () => {
    const { fresh, quoted } = splitQuotedHistory(REPLY);
    expect(quoted).toBe(true);
    expect(fresh).toBe('<p>Thank you Sam.</p><p>Alex Doe</p>');
  });

  test('never hides a reply that is only a quote, and leaves plain replies alone', () => {
    expect(splitQuotedHistory(QUOTE)).toEqual({ fresh: QUOTE, quoted: false });
    expect(splitQuotedHistory('<p>Works now</p>')).toEqual({ fresh: '<p>Works now</p>', quoted: false });
  });

  test('an older stored reply is folded on screen; the full mail is behind the toggle', () => {
    const parts = replyBodyParts({ eventType: 'customer_reply' }, REPLY);
    expect(parts.fresh).toBe('<p>Thank you Sam.</p><p>Alex Doe</p>');
    expect(parts.full).toBe(REPLY);
  });

  test('a reply trimmed on the server offers the original from the raw payload', () => {
    const entry = { eventType: 'customer_reply', rawPayload: { tpQuotedHistoryTrimmed: true, body: REPLY } };
    const parts = replyBodyParts(entry, '<p>Thank you Sam.</p>');
    expect(parts).toEqual({ fresh: '<p>Thank you Sam.</p>', full: REPLY });
  });

  test('notes and agent replies are never folded', () => {
    expect(replyBodyParts({ eventType: 'private_note' }, REPLY)).toEqual({ fresh: REPLY, full: null });
    expect(replyBodyParts({ eventType: 'reply', authorType: 'agent' }, REPLY)).toEqual({ fresh: REPLY, full: null });
  });
});
