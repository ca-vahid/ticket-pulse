import { jest } from '@jest/globals';

/**
 * "Copy me on workflow e-mails" (16 Nov 2026): an observer gets a Bcc of every
 * e-mail a workflow sends in the workspace, for a set time, without any
 * workflow knowing. Invented names and example.com only.
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
jest.unstable_mockModule('../src/services/workspaceEmailIdentityService.js', () => ({ resolveFromName: jest.fn(async () => 'IT Help') }));
jest.unstable_mockModule('../src/services/twilioNotificationService.js', () => ({ placeVoiceCall: jest.fn(), sendSms: jest.fn(), sendWhatsApp: jest.fn() }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const observers = await import('../src/services/workflowMailObserverService.js');
const { processDelivery } = await import('../src/services/notificationDeliveryService.js');

const NOW = Date.now();
const inDays = (d) => new Date(NOW + d * 86400000).toISOString();
const delivery = (over = {}) => ({
  id: 501, workspaceId: 1, ticketId: 9001, channel: 'email', workflowRunId: 77, recipient: 'rita@example.com',
  toRecipients: ['rita@example.com'], ccRecipients: [], bccRecipients: [], subject: '[TP-9] We got your request',
  htmlBody: '<p>Hello</p>', textBody: 'Hello', payload: {}, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  observers.invalidateObserverCache();
  prismaMock.notificationWorkflowRun.findUnique.mockResolvedValue({ workflowId: 16100 });
  prismaMock.notificationDelivery.update.mockResolvedValue({});
  prismaMock.ticket.findUnique.mockResolvedValue(null);
  deliverMock.mockResolvedValue({ provider: 'msgraph', providerMessageId: '<m1@example.com>', messageId: '<m1@example.com>', via: 'msgraph' });
});

describe('the setting', () => {
  test('saves cleaned entries: lower-case, deduped, ended ones dropped, at most 90 days', async () => {
    const out = await observers.setObservers(1, [
      { email: 'Alex.Rivera@Example.com', name: 'Alex Rivera', until: inDays(14) },
      { email: 'alex.rivera@example.com', until: inDays(3) },
      { email: 'sam@example.com', until: inDays(-1) },
      { email: 'not-an-address', until: inDays(5) },
      { email: 'kim@example.com', until: inDays(400), workflowIds: [5, '5', 'x'] },
    ], { actorEmail: 'Admin@Example.com', now: NOW });
    expect(out.observers.map((o) => o.email)).toEqual(['alex.rivera@example.com', 'kim@example.com']);
    expect(out.observers[0]).toMatchObject({ name: 'Alex Rivera', workflowIds: null, addedBy: 'admin@example.com' });
    expect(new Date(out.observers[1].until).getTime()).toBeLessThanOrEqual(NOW + 90 * 86400000 + 1000);
    expect(out.observers[1].workflowIds).toEqual([5]);
    expect(JSON.parse(store.get('workflow_mail_observers_ws1')).observers).toHaveLength(2);
  });

  test('who is Bcc\'d: active, in scope, not already on the mail', async () => {
    await observers.setObservers(1, [
      { email: 'alex@example.com', until: inDays(14) },
      { email: 'kim@example.com', until: inDays(14), workflowIds: [5] },
    ], { now: NOW });
    expect(await observers.observerBccFor({ workspaceId: 1, workflowId: 16100, to: ['rita@example.com'] })).toEqual(['alex@example.com']);
    expect(await observers.observerBccFor({ workspaceId: 1, workflowId: 5, to: ['rita@example.com'] })).toEqual(['alex@example.com', 'kim@example.com']);
    expect(await observers.observerBccFor({ workspaceId: 1, workflowId: 5, cc: ['ALEX@example.com'] })).toEqual(['kim@example.com']);
    expect(await observers.observerBccFor({ workspaceId: 1, workflowId: 5, now: NOW + 15 * 86400000 })).toEqual([]);
    expect(await observers.observerBccFor({ workspaceId: 2, workflowId: 5 })).toEqual([]);
  });

  test('a settings read that fails means nobody, never an error', async () => {
    settingsMock.get.mockRejectedValueOnce(new Error('db down'));
    expect(await observers.observerBccFor({ workspaceId: 3, workflowId: 1 })).toEqual([]);
  });
});

describe('sending a workflow e-mail', () => {
  test('the observer is Bcc\'d, and the delivery record says so', async () => {
    await observers.setObservers(1, [{ email: 'alex@example.com', until: inDays(14) }], { now: NOW });
    const res = await processDelivery(delivery());
    expect(res.success).toBe(true);
    expect(deliverMock).toHaveBeenCalledWith(expect.objectContaining({ to: ['rita@example.com'], cc: [], bcc: ['alex@example.com'] }));
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'sent', bccRecipients: ['alex@example.com'], payload: expect.objectContaining({ observerBcc: ['alex@example.com'] }) }),
    }));
  });

  test('no observer: the e-mail and its record are exactly as before', async () => {
    await processDelivery(delivery());
    expect(deliverMock).toHaveBeenCalledWith(expect.objectContaining({ bcc: [] }));
    const data = prismaMock.notificationDelivery.update.mock.calls[0][0].data;
    expect(data.bccRecipients).toBeUndefined();
    expect(data.payload).toBeUndefined();
  });

  test('a non-workflow e-mail (no run) never gets an observer', async () => {
    await observers.setObservers(1, [{ email: 'alex@example.com', until: inDays(14) }], { now: NOW });
    await processDelivery(delivery({ workflowRunId: null }));
    expect(prismaMock.notificationWorkflowRun.findUnique).not.toHaveBeenCalled();
    expect(deliverMock).toHaveBeenCalledWith(expect.objectContaining({ bcc: [] }));
  });
});
