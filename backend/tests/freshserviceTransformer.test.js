import { transformTicket } from '../src/integrations/freshserviceTransformer.js';

describe('FreshService transformer', () => {
  test('captures original ticket email recipient fields', () => {
    const ticket = transformTicket({
      id: 225001,
      subject: 'VPN access problem',
      status: 2,
      priority: 2,
      type: 'Service Request',
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
    expect(ticket.ticketType).toBe('Service Request');
  });

  test('maps first_responded_at from FreshService stats (gap plan P4.1)', () => {
    const withStats = transformTicket({
      id: 2, subject: 'FR', status: 2, priority: 2,
      created_at: '2026-07-01T10:00:00.000Z',
      updated_at: '2026-07-01T11:00:00.000Z',
      stats: { first_responded_at: '2026-07-01T10:30:00.000Z' },
    });
    expect(withStats.firstPublicAgentReplyAt).toEqual(new Date('2026-07-01T10:30:00.000Z'));

    const withoutStats = transformTicket({
      id: 3, subject: 'No FR', status: 2, priority: 2,
      created_at: '2026-07-01T10:00:00.000Z',
      updated_at: '2026-07-01T11:00:00.000Z',
    });
    expect(withoutStats.firstPublicAgentReplyAt).toBeNull();
  });
});

describe('getStatusId (Phase 8c base mapping)', () => {
  test('canonical labels map directly', async () => {
    const { getStatusId } = await import('../src/integrations/freshserviceTransformer.js');
    expect(getStatusId('Open')).toBe(2);
    expect(getStatusId('Pending')).toBe(3);
    expect(getStatusId('Resolved')).toBe(4);
    expect(getStatusId('Closed')).toBe(5);
  });

  test('custom labels map through the caller-resolved base status', async () => {
    const { getStatusId } = await import('../src/integrations/freshserviceTransformer.js');
    expect(getStatusId('Needs Rework', { baseStatus: 'Pending' })).toBe(3);
    expect(getStatusId('Fixed', { baseStatus: 'Resolved' })).toBe(4);
  });

  test('unknown labels with no base return null — never the old silent Open(2)', async () => {
    const { getStatusId } = await import('../src/integrations/freshserviceTransformer.js');
    expect(getStatusId('Needs Rework')).toBeNull();
    expect(getStatusId('Needs Rework', { baseStatus: null })).toBeNull();
    expect(getStatusId('Whatever', { baseStatus: 'Not A Base' })).toBeNull();
  });
});
