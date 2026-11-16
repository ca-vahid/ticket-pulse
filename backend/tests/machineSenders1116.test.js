import { jest } from '@jest/globals';

/**
 * Machine senders (16 Nov 2026): addresses that never get a workflow e-mail
 * (an HR system's new-hire notices, a security tool's alerts, no-reply
 * senders). Their tickets open as usual; only workflow e-mails to them stop.
 * Invented names and example.com / example.org only.
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

const machine = await import('../src/services/machineSenderService.js');
const observers = await import('../src/services/workflowMailObserverService.js');
const { processDelivery } = await import('../src/services/notificationDeliveryService.js');

const delivery = (over = {}) => ({
  id: 601, workspaceId: 1, ticketId: 9002, channel: 'email', workflowRunId: 88, recipient: 'notifications@app.hr-example.com',
  toRecipients: ['notifications@app.hr-example.com'], ccRecipients: [], bccRecipients: [], subject: '[TP-12] New Hire: Jamie Doe',
  htmlBody: '<p>Received</p>', textBody: 'Received', payload: { node: 'send' }, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  machine.invalidateMachineSenderCache();
  observers.invalidateObserverCache();
  prismaMock.notificationWorkflowRun.findUnique.mockResolvedValue({ workflowId: 16100 });
  prismaMock.notificationDelivery.update.mockResolvedValue({});
  prismaMock.ticket.findUnique.mockResolvedValue(null);
  deliverMock.mockResolvedValue({ provider: 'sendgrid', providerMessageId: 'x1', messageId: '<tp-1@example.com>', via: 'sendgrid' });
});

describe('the list', () => {
  test('three shapes: an exact address, a whole domain (sub-domains too), a word in the name', () => {
    expect(machine.entryMatches('notifications@app.hr-example.com', 'Notifications@App.HR-Example.com')).toBe(true);
    expect(machine.entryMatches('notifications@app.hr-example.com', 'people@app.hr-example.com')).toBe(false);
    expect(machine.entryMatches('alerts-example.org', 'analysis@alerts-example.org')).toBe(true);
    expect(machine.entryMatches('@alerts-example.org', 'x@eu.alerts-example.org')).toBe(true);
    expect(machine.entryMatches('alerts-example.org', 'x@notalerts-example.org')).toBe(false);
    expect(machine.entryMatches('noreply', 'defender-noreply@example.com')).toBe(true);
    expect(machine.entryMatches('noreply', 'rita@noreply.example.com')).toBe(false);
  });

  test('cleaning: lower-case, *@ and mailto: accepted, nonsense refused', () => {
    expect(machine.cleanEntryValue(' *@Alerts-Example.org ')).toBe('@alerts-example.org');
    expect(machine.cleanEntryValue('mailto:Bot@Example.com')).toBe('bot@example.com');
    expect(machine.cleanEntryValue('no')).toBeNull();
    expect(machine.cleanEntryValue('bad')).toBeNull(); // too short for a word: would catch "badri@"
    expect(machine.cleanEntryValue('alerts')).toBe('alerts');
    expect(machine.cleanEntryValue('two@at@example.com')).toBeNull();
    expect(machine.cleanEntryValue('bot@localhost')).toBeNull();
    expect(machine.cleanEntryValue('has space.com')).toBeNull();
  });

  test('a workspace that never saved uses the standard no-reply names; a saved list replaces them', async () => {
    const before = await machine.getMachineSenders(1);
    expect(before.saved).toBe(false);
    expect(before.entries.map((e) => e.value)).toEqual(['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster']);
    const out = await machine.setMachineSenders(1, ['noreply', 'Notifications@App.HR-Example.com', 'noreply', 'bad'], { actorEmail: 'Admin@Example.com' });
    expect(out.entries.map((e) => e.value)).toEqual(['noreply', 'notifications@app.hr-example.com']);
    expect(out.entries[1].addedBy).toBe('admin@example.com');
    expect(JSON.parse(store.get('machine_senders_ws1')).entries).toHaveLength(2);
    machine.invalidateMachineSenderCache();
    expect((await machine.getMachineSenders(1)).saved).toBe(true);
  });

  test('a settings read that fails means the standard list, never an error', async () => {
    settingsMock.get.mockRejectedValueOnce(new Error('db down'));
    expect((await machine.getMachineSenders(3)).entries.length).toBe(6);
  });
});

describe('sending a workflow e-mail', () => {
  test('to a machine sender only: not sent, recorded as skipped with the entry it matched', async () => {
    await machine.setMachineSenders(1, ['notifications@app.hr-example.com']);
    const res = await processDelivery(delivery());
    expect(res).toMatchObject({ success: true, skipped: 'machine_sender' });
    expect(deliverMock).not.toHaveBeenCalled();
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'skipped',
        payload: expect.objectContaining({ node: 'send', skippedReason: 'machine_sender', machineRemoved: [{ address: 'notifications@app.hr-example.com', entry: 'notifications@app.hr-example.com' }] }),
      }),
    }));
  });

  test('the observer never gets a Bcc of an e-mail that was not sent', async () => {
    await machine.setMachineSenders(1, ['hr-example.com']);
    await observers.setObservers(1, [{ email: 'alex@example.com', until: new Date(Date.now() + 86400000).toISOString() }]);
    await processDelivery(delivery());
    expect(deliverMock).not.toHaveBeenCalled();
  });

  test('a machine sender on Cc comes off; the person on To still gets it, and the record says who', async () => {
    await processDelivery(delivery({ recipient: 'rita@example.com', toRecipients: ['rita@example.com', 'no-reply@example.com'], ccRecipients: ['donotreply@example.org', 'sam@example.com'] }));
    expect(deliverMock).toHaveBeenCalledWith(expect.objectContaining({ to: ['rita@example.com'], cc: ['sam@example.com'] }));
    const data = prismaMock.notificationDelivery.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'sent', toRecipients: ['rita@example.com'], ccRecipients: ['sam@example.com'] });
    expect(data.payload.machineRemoved.map((r) => r.entry)).toEqual(['no-reply', 'donotreply']);
  });

  test('a person: exactly as before (nothing removed, no extra fields on the record)', async () => {
    await processDelivery(delivery({ recipient: 'rita@example.com', toRecipients: ['rita@example.com'] }));
    expect(deliverMock).toHaveBeenCalledWith(expect.objectContaining({ to: ['rita@example.com'] }));
    const data = prismaMock.notificationDelivery.update.mock.calls[0][0].data;
    expect(data.status).toBe('sent');
    expect(data.toRecipients).toBeUndefined();
    expect(data.payload).toBeUndefined();
  });

  test('not a workflow e-mail (no run): the list does not apply', async () => {
    await processDelivery(delivery({ workflowRunId: null, recipient: 'noreply@example.com', toRecipients: ['noreply@example.com'] }));
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });
});
