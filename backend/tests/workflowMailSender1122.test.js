import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * 22 Nov 2026, two rules for a workflow e-mail at send time:
 *  1. It names the ticket's team (group, internal group) to the transport, so a
 *     workspace with one mailbox per team sends from that team's address.
 *     Assignment pings and e-mails with no ticket do not.
 *  2. Machine senders come off the step's own Bcc too — but the workspace
 *     observer ("Copy me on workflow e-mails") is never dropped, and a Bcc alone
 *     never makes a send.
 * Invented names, example.com / example.org only.
 */
const store = new Map();
const settingsMock = { get: jest.fn(async (k) => store.get(k) ?? null), set: jest.fn(async (k, v) => { store.set(k, v); }) };
const prismaMock = {
  notificationWorkflowRun: { findUnique: jest.fn() },
  notificationDelivery: { update: jest.fn() },
  ticket: { findUnique: jest.fn() },
};
const deliverMock = jest.fn();

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ deliverTransactionalEmail: deliverMock }));
jest.unstable_mockModule('../src/services/workspaceEmailIdentityService.js', () => ({ resolveFromName: jest.fn(async () => 'Accounting') }));
jest.unstable_mockModule('../src/services/twilioNotificationService.js', () => ({ placeVoiceCall: jest.fn(), sendSms: jest.fn(), sendWhatsApp: jest.fn() }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const machine = await import('../src/services/machineSenderService.js');
const observers = await import('../src/services/workflowMailObserverService.js');
const { processDelivery } = await import('../src/services/notificationDeliveryService.js');

const arTicketRow = {
  id: 9002, workspaceId: 2, origin: 'ticketpulse', nativeNumber: 12, freshserviceTicketId: null, ccEmails: [],
  groupId: 1002n, internalGroupId: null, requester: { email: 'priya.nair@example.com' },
};
const delivery = (over = {}) => ({
  id: 701, workspaceId: 2, ticketId: 9002, channel: 'email', workflowRunId: 88, recipient: 'priya.nair@example.com',
  toRecipients: ['priya.nair@example.com'], ccRecipients: [], bccRecipients: [], subject: '[TP-12] Received',
  htmlBody: '<p>Received</p>', textBody: 'Received', payload: { node: 'send' }, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  machine.invalidateMachineSenderCache();
  observers.invalidateObserverCache();
  prismaMock.notificationWorkflowRun.findUnique.mockResolvedValue({ workflowId: 16100 });
  prismaMock.notificationDelivery.update.mockResolvedValue({});
  prismaMock.ticket.findUnique.mockResolvedValue(arTicketRow);
  deliverMock.mockResolvedValue({ provider: 'msgraph', providerMessageId: '<g@example.com>', messageId: '<g@example.com>', via: 'msgraph', from: 'ar@example.com' });
});

describe('the team mailbox', () => {
  test('a workflow e-mail about an AR ticket hands the ticket team to the transport; the name is untouched', async () => {
    await processDelivery(delivery());
    expect(deliverMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 2,
      fromName: 'Accounting',
      mailboxTicket: { workspaceId: 2, groupId: 1002n, internalGroupId: null },
      ticket: expect.objectContaining({ id: 9002 }),
    }));
    expect(prismaMock.ticket.findUnique).toHaveBeenCalledTimes(1);
    const data = prismaMock.notificationDelivery.update.mock.calls[0][0].data;
    expect(data.fromAddress).toBe('ar@example.com');
  });

  test('an agent-facing workflow e-mail about the ticket still uses the team mailbox (no threading ticket)', async () => {
    await processDelivery(delivery({ recipient: 'eli.park@example.com', toRecipients: ['eli.park@example.com'] }));
    const args = deliverMock.mock.calls[0][0];
    expect(args.ticket).toBeNull();
    expect(args.mailboxTicket).toEqual({ workspaceId: 2, groupId: 1002n, internalGroupId: null });
  });

  test('the editor test send of a workflow uses it too', async () => {
    await processDelivery(delivery({ workflowRunId: null, notificationType: 'notification_workflow_test_email', recipient: 'sam.okafor@example.com', toRecipients: ['sam.okafor@example.com'] }));
    expect(deliverMock.mock.calls[0][0].mailboxTicket).toEqual({ workspaceId: 2, groupId: 1002n, internalGroupId: null });
  });

  test('no ticket, an assignment ping, or a ticket of another workspace: no team pick (the primary, as before)', async () => {
    await processDelivery(delivery({ ticketId: null }));
    expect(deliverMock.mock.calls[0][0]).not.toHaveProperty('mailboxTicket');

    await processDelivery(delivery({ workflowRunId: null, htmlBody: null, textBody: null, payload: { message: 'New ticket' } }));
    expect(deliverMock.mock.calls[1][0]).not.toHaveProperty('mailboxTicket');

    prismaMock.ticket.findUnique.mockResolvedValue({ ...arTicketRow, workspaceId: 9 });
    await processDelivery(delivery());
    expect(deliverMock.mock.calls[2][0]).not.toHaveProperty('mailboxTicket');
  });

  test('a pinned from the Graph lane ignored: the address really used is kept in the payload', async () => {
    await processDelivery(delivery({ fromAddress: 'billing@example.com' }));
    const data = prismaMock.notificationDelivery.update.mock.calls[0][0].data;
    expect(data.fromAddress).toBeUndefined(); // the pinned column is left as it was
    expect(data.payload).toEqual({ node: 'send', sentFrom: 'ar@example.com' });
  });

  test('a pinned from that was used (SendGrid lane): nothing extra recorded', async () => {
    deliverMock.mockResolvedValue({ provider: 'sendgrid', providerMessageId: 'x', messageId: '<m@example.com>', via: 'sendgrid', from: 'Billing@example.com' });
    await processDelivery(delivery({ fromAddress: 'billing@example.com' }));
    expect(prismaMock.notificationDelivery.update.mock.calls[0][0].data.payload).toBeUndefined();
  });

  test('a failed ticket lookup never blocks the send', async () => {
    prismaMock.ticket.findUnique.mockRejectedValue(new Error('db hiccup'));
    const res = await processDelivery(delivery());
    expect(res.success).toBe(true);
    expect(deliverMock.mock.calls[0][0]).not.toHaveProperty('mailboxTicket');
  });
});

describe('machine senders on Bcc', () => {
  test('a machine sender on the step Bcc comes off; To and the person on Bcc still get it, and the record says so', async () => {
    await processDelivery(delivery({ bccRecipients: ['no-reply@example.org', 'dana.fox@example.com'] }));
    expect(deliverMock).toHaveBeenCalledWith(expect.objectContaining({
      to: ['priya.nair@example.com'], bcc: ['dana.fox@example.com'],
    }));
    const data = prismaMock.notificationDelivery.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'sent', bccRecipients: ['dana.fox@example.com'] });
    expect(data.payload.machineRemoved).toEqual([{ address: 'no-reply@example.org', entry: 'no-reply', field: 'bcc' }]);
  });

  test('the observer Bcc is never dropped, even when its address matches the list', async () => {
    await machine.setMachineSenders(2, ['@monitor.example.org']);
    await observers.setObservers(2, [{ email: 'dana.fox@monitor.example.org', until: new Date(Date.now() + 86400000).toISOString() }]);
    await processDelivery(delivery({ bccRecipients: ['probe@monitor.example.org'] }));
    const args = deliverMock.mock.calls[0][0];
    expect(args.bcc).toEqual(['dana.fox@monitor.example.org']);
    const data = prismaMock.notificationDelivery.update.mock.calls[0][0].data;
    expect(data.bccRecipients).toEqual(['dana.fox@monitor.example.org']);
    expect(data.payload.observerBcc).toEqual(['dana.fox@monitor.example.org']);
  });

  test('a Bcc alone never makes a send: To only machine senders, a person on Bcc → not sent', async () => {
    const res = await processDelivery(delivery({ recipient: 'noreply@example.org', toRecipients: ['noreply@example.org'], bccRecipients: ['dana.fox@example.com'] }));
    expect(res).toMatchObject({ success: true, skipped: 'machine_sender' });
    expect(deliverMock).not.toHaveBeenCalled();
  });

  test('nothing on the list: Bcc and the record exactly as before', async () => {
    await processDelivery(delivery({ bccRecipients: ['dana.fox@example.com'] }));
    expect(deliverMock.mock.calls[0][0].bcc).toEqual(['dana.fox@example.com']);
    const data = prismaMock.notificationDelivery.update.mock.calls[0][0].data;
    expect(data.bccRecipients).toBeUndefined();
    expect(data.payload).toBeUndefined();
  });

  test('not a workflow e-mail (no run): the list does not touch Bcc', async () => {
    await processDelivery(delivery({ workflowRunId: null, bccRecipients: ['noreply@example.org'] }));
    expect(deliverMock.mock.calls[0][0].bcc).toEqual(['noreply@example.org']);
  });
});
