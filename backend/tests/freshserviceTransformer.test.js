import { transformTicket } from '../src/integrations/freshserviceTransformer.js';

describe('FreshService transformer', () => {
  test('captures original ticket email recipient fields', () => {
    const ticket = transformTicket({
      id: 225001,
      subject: 'VPN access problem',
      status: 2,
      priority: 2,
      requester_id: 99,
      requester: { name: 'Requester', email: 'requester@example.com' },
      created_at: '2026-05-29T18:30:00.000Z',
      updated_at: '2026-05-29T18:42:00.000Z',
      to_emails: ['helpdesk@example.com'],
      cc_emails: ['manager@example.com', 'Manager@example.com', 'not-an-email'],
      reply_cc_emails: ['lead@example.com'],
      fwd_emails: ['audit@example.com'],
    });

    expect(ticket.toEmails).toEqual(['helpdesk@example.com']);
    expect(ticket.ccEmails).toEqual(['manager@example.com']);
    expect(ticket.replyCcEmails).toEqual(['lead@example.com']);
    expect(ticket.fwdEmails).toEqual(['audit@example.com']);
  });
});
