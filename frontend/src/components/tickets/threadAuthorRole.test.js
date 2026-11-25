import { describe, expect, test } from 'vitest';
import {
  bareEmail, ccAddressesOf, forwardRecipientsOf, incomingAuthorRole, participantReplySubject, senderFirstName,
} from './threadAuthorRole';

// QA 11-24 #7: a reply from the person a ticket was forwarded to read "From requester".

const forward = { id: 70, eventType: 'forward', rawPayload: { forwardTo: ['Tim@Example.com'] } };
const directReply = { id: 71, eventType: 'forward', rawPayload: { to_emails: ['casey@example.com'], directReply: { entryId: 9, email: 'casey@example.com' } } };
const ccReply = { id: 72, eventType: 'reply', rawPayload: { cc_emails: ['lead@example.com'] } };
const entries = [forward, directReply, ccReply];
const ctx = {
  requesterEmail: 'Rita Requester <rita@example.com>',
  forwardRecipients: forwardRecipientsOf(entries),
  ccAddresses: ccAddressesOf({ ccEmails: ['also@example.com'], replyCcEmails: [] }, entries),
};

describe('incomingAuthorRole', () => {
  test('the requester (any case, any "Name <address>" form) is the requester', () => {
    expect(incomingAuthorRole({ actorEmail: 'RITA@example.com' }, ctx)).toMatchObject({ kind: 'requester', badge: 'From requester', avatarLabel: 'Requester' });
  });

  test('the person the ticket was forwarded to is not "From requester"', () => {
    const role = incomingAuthorRole({ actorEmail: 'tim@example.com', actorName: 'Tim Example' }, ctx);
    expect(role).toMatchObject({ kind: 'forwardee', badge: 'Reply to your forward', avatarLabel: 'Forwarded to' });
    expect(role.badge).not.toMatch(/requester/i);
  });

  test('someone on Cc (the ticket\'s list or a message\'s) says so', () => {
    expect(incomingAuthorRole({ actorEmail: 'also@example.com' }, ctx)).toMatchObject({ kind: 'cc', badge: 'From someone on Cc', avatarLabel: 'Cc' });
    expect(incomingAuthorRole({ actorEmail: 'lead@example.com' }, ctx).kind).toBe('cc');
  });

  test('anyone else is plainly "Not the requester"', () => {
    expect(incomingAuthorRole({ actorEmail: 'stranger@example.com' }, ctx)).toMatchObject({ kind: 'other', badge: 'Not the requester' });
  });

  test('answering someone does not make them a forward recipient', () => {
    expect(ctx.forwardRecipients.has('casey@example.com')).toBe(false);
    expect(incomingAuthorRole({ actorEmail: 'casey@example.com' }, ctx).kind).toBe('other');
  });

  test('a delegate sending on the requester\'s behalf is the requester', () => {
    expect(incomingAuthorRole({ actorEmail: 'assistant@example.com', rawPayload: { onBehalfOf: { email: 'rita@example.com' } } }, ctx).kind).toBe('requester');
  });

  test('nothing to compare (no sender address, or no requester address) keeps the requester reading', () => {
    expect(incomingAuthorRole({ actorEmail: null, actorName: 'Rita' }, ctx).kind).toBe('requester');
    expect(incomingAuthorRole({ actorEmail: 'tim@example.com' }, { ...ctx, requesterEmail: '' }).kind).toBe('requester');
  });
});

describe('helpers', () => {
  test('bareEmail and senderFirstName', () => {
    expect(bareEmail('Tim Example <Tim@Example.com>')).toBe('tim@example.com');
    expect(bareEmail('no address')).toBe('');
    expect(senderFirstName({ actorName: 'Jordan Example', actorEmail: 'jordan@example.com' })).toBe('Jordan');
    expect(senderFirstName({ actorName: 'tim@example.com', actorEmail: 'tim@example.com' })).toBe('tim@example.com');
  });

  test('the subject: their forward\'s for a forward recipient, else the ticket\'s reply subject', () => {
    const ticket = { subject: 'Invoice 4471', displayRef: 'TP-1042', replySubjectDefault: 'Re: [TP-1042] Invoice 4471' };
    expect(participantReplySubject(ticket, { wasForwardedTo: true })).toBe('Re: FW: Invoice 4471 [TP-1042]');
    expect(participantReplySubject(ticket)).toBe('Re: [TP-1042] Invoice 4471');
  });
});
