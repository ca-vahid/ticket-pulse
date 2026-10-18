import { jest } from '@jest/globals';

/**
 * Device notifications (web push): who is told, the person's own rules, dead
 * subscriptions, and which endpoints a subscription may name.
 */

const prismaMock = {
  pushSubscription: {
    count: jest.fn(), findMany: jest.fn(), upsert: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue({}), deleteMany: jest.fn().mockResolvedValue({}),
  },
  notificationWorkspaceSetting: { findUnique: jest.fn().mockResolvedValue(null) },
  notificationPreference: { findUnique: jest.fn() },
  ticketNotificationMute: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  technicianLeave: { findFirst: jest.fn().mockResolvedValue(null) },
  technicianNotificationPreference: { findUnique: jest.fn().mockResolvedValue(null) },
  group: { findFirst: jest.fn() },
  groupMember: { findMany: jest.fn() },
};
const sendNotification = jest.fn();
const setVapidDetails = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/teamsBotClient.js', () => ({ default: { isTeamsConfigured: () => false, describeError: (e) => e.message } }));
jest.unstable_mockModule('web-push', () => ({ default: { sendNotification, setVapidDetails } }));

process.env.WEB_PUSH_PUBLIC_KEY = 'pub';
process.env.WEB_PUSH_PRIVATE_KEY = 'priv';

const { WebPushService, isAllowedEndpoint, deviceLabel } = await import('../src/services/webPushService.js');

const SUB = { id: 7, email: 'ana@x.io', endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'k', auth: 'a' };
const tech = { id: 5, name: 'Ana', email: 'ana@x.io', timezone: 'America/Vancouver', workStartTime: null, workEndTime: null };
const ctxFor = (type, extra = {}, ticket = {}) => ({
  workspace: { id: 1, timezone: 'America/Vancouver' },
  event: { type, extra },
  ticket: { id: 42, displayRef: 'TP-42', subject: 'Printer is down', priority: 2, ...ticket },
  assignedAgent: { id: 5 },
  requester: { name: 'Rita' },
});

let svc;
beforeEach(() => {
  jest.clearAllMocks();
  svc = new WebPushService();
  prismaMock.pushSubscription.count.mockResolvedValue(1);
  prismaMock.pushSubscription.findMany.mockResolvedValue([SUB]);
  prismaMock.technician.findFirst.mockResolvedValue(tech);
  prismaMock.notificationPreference.findUnique.mockResolvedValue(null);
  prismaMock.ticketNotificationMute.findUnique.mockResolvedValue(null);
  prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue(null);
  sendNotification.mockResolvedValue({});
});

describe('webPushService', () => {
  test('an assignment is pushed to the assignee, pointing at the ticket', async () => {
    await svc._onTicketEvent(ctxFor('ticket.assigned'));
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [sub, body, opts] = sendNotification.mock.calls[0];
    expect(sub.endpoint).toBe(SUB.endpoint);
    const payload = JSON.parse(body);
    expect(payload).toMatchObject({ title: 'Assigned to you: TP-42', url: '/tickets/42', tag: 'ticket-42' });
    expect(payload.body).toContain('Printer is down');
    expect(opts.urgency).toBe('normal');
  });

  test('never about your own action', async () => {
    await svc._onTicketEvent(ctxFor('ticket.assigned', { actor: { email: 'ana@x.io', technicianId: 5 } }));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  test('an event the person switched off, or kept for the digest, is not pushed', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue({ events: { assigned: 'off' }, options: {} });
    await svc._onTicketEvent(ctxFor('ticket.assigned'));
    prismaMock.notificationPreference.findUnique.mockResolvedValue({ events: { assigned: 'digest' }, options: {} });
    await svc._onTicketEvent(ctxFor('ticket.assigned'));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  test('a muted ticket is not pushed', async () => {
    prismaMock.ticketNotificationMute.findUnique.mockResolvedValue({ until: new Date(Date.now() + 3600_000) });
    await svc._onTicketEvent(ctxFor('ticket.assigned'));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  test('quiet hours hold a normal ticket and let an urgent one through', async () => {
    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue({ quietHoursEnabled: true, quietHoursStart: '00:00', quietHoursEnd: '23:59' });
    await svc._onTicketEvent(ctxFor('ticket.assigned'));
    expect(sendNotification).not.toHaveBeenCalled();
    await svc._onTicketEvent(ctxFor('ticket.assigned', {}, { priority: 4 }));
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0][2].urgency).toBe('high');
  });

  test('nothing is looked up when nobody has a device', async () => {
    prismaMock.pushSubscription.count.mockResolvedValue(0);
    await svc._onTicketEvent(ctxFor('ticket.assigned'));
    expect(prismaMock.technician.findFirst).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  test('a subscription the browser dropped (410) is removed; another error is counted', async () => {
    sendNotification.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    expect(await svc.sendToEmail('ana@x.io', { title: 't', body: 'b', url: '/' })).toEqual({ sent: 0, failed: 0, removed: 1 });
    expect(prismaMock.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: 7 } });
    sendNotification.mockRejectedValueOnce(Object.assign(new Error('busy'), { statusCode: 500 }));
    expect(await svc.sendToEmail('ana@x.io', { title: 't', body: 'b', url: '/' })).toEqual({ sent: 0, failed: 1, removed: 0 });
  });

  test('an approval is pushed to the approver and opens Approvals', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 5 });
    await svc._notifyApproval({ approval: { id: 9, approverEmail: 'Ana@x.io' }, ticket: { id: 42, workspaceId: 1, subject: 'New laptop' }, categoryName: 'Laptop purchase', requestedByName: 'Vahid', note: 'Two quotes attached' });
    const payload = JSON.parse(sendNotification.mock.calls[0][1]);
    expect(payload).toMatchObject({ title: 'Approval waiting: Laptop purchase', url: '/approvals', tag: 'approval-9' });
    expect(payload.body).toBe('Vahid asks — Two quotes attached');
  });

  test('subscribe refuses an endpoint that is not a push service', async () => {
    await expect(svc.subscribe('ana@x.io', { endpoint: 'https://evil.example.com/hook', keys: { p256dh: 'k', auth: 'a' } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.subscribe('ana@x.io', { endpoint: 'http://fcm.googleapis.com/x', keys: { p256dh: 'k', auth: 'a' } })).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.pushSubscription.upsert).not.toHaveBeenCalled();
    prismaMock.pushSubscription.findMany.mockResolvedValue([]);
    await svc.subscribe('Ana@X.io', { endpoint: SUB.endpoint, keys: { p256dh: 'k', auth: 'a' } }, 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36');
    expect(prismaMock.pushSubscription.upsert.mock.calls[0][0].create).toMatchObject({ email: 'ana@x.io', endpoint: SUB.endpoint });
  });

  test('endpoint allow-list and device names', () => {
    expect(isAllowedEndpoint('https://web.push.apple.com/abc')).toBe(true);
    expect(isAllowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isAllowedEndpoint('https://wns2-by3p.notify.windows.com/w/?token=x')).toBe(true);
    expect(isAllowedEndpoint('https://googleapis.com.evil.io/x')).toBe(false);
    expect(isAllowedEndpoint('nonsense')).toBe(false);
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36')).toBe('Chrome on Android');
  });
});
