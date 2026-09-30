import { jest } from '@jest/globals';

// 30 Sep 2026 (Vahid) Part 2: approve by day, auto by night (the schedule,
// the overnight mark, the morning summary) and the "Ticket ready" trigger
// (sorted + Auto-help done, at most 3 minutes, once per ticket).

const prismaMock = {
  ticket: { findUnique: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
  ticketActivity: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(async ({ data }) => ({ id: 1, ...data })) },
  notificationWorkflow: { findMany: jest.fn() },
  autoHelpRun: { count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn(async () => ({})) },
  autoHelpSettings: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  autoHelpPlaybook: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
  workspace: { findUnique: jest.fn(async () => ({ name: 'IT', defaultTimezone: 'America/Vancouver' })) },
  workspaceAccess: { findMany: jest.fn() },
  $executeRaw: jest.fn(async () => 1),
  $transaction: jest.fn(async (fn) => fn(prismaMock)),
};
const emitTicketEvent = jest.fn(async () => ({ status: 'completed' }));
const sendTransactionalEmail = jest.fn(async () => ({ sent: true, via: 'graph' }));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ emitTicketEvent, default: { emitTicketEvent } }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ sendTransactionalEmail }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));

const { default: ticketReady, READY_MAX_WAIT_MS } = await import('../src/services/ticketReadyService.js');
const { default: playbooks, cleanSummaryRecipients } = await import('../src/services/autoHelpPlaybookService.js');
const { default: delivery } = await import('../src/services/autoHelpDeliveryService.js');
const { expectedFor } = await import('../src/services/autoHelpContextService.js');
const { ValidationError } = await import('../src/utils/errors.js');

const NOW = new Date('2026-09-30T18:00:00Z');
const ENABLED_AT = new Date('2026-09-30T10:00:00Z');
let spies = [];

beforeEach(() => {
  jest.clearAllMocks();
  ticketReady._usesCache.clear();
  playbooks._afterHoursCache.clear();
  playbooks._readinessCache.clear();
  prismaMock.notificationWorkflow.findMany.mockResolvedValue([{ workspaceId: 1, enabledAt: ENABLED_AT, lastPublishedAt: null, createdAt: ENABLED_AT }]);
  prismaMock.ticketActivity.findFirst.mockResolvedValue(null);
  prismaMock.autoHelpRun.count.mockResolvedValue(0);
});
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; });

describe('"Ticket ready"', () => {
  const ticket = (minutesOld) => ({ id: 55, workspaceId: 1, createdAt: new Date(NOW.getTime() - minutesOld * 60e3) });

  test('a new ticket: claimed once (activity under a lock), then the event with what Auto-help did', async () => {
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket(2));
    const res = await ticketReady.markReady(55, { reason: 'auto_help_done', runId: 901, now: NOW });
    expect(res).toEqual({ emitted: true, reason: 'auto_help_done' });
    expect(prismaMock.$executeRaw).toHaveBeenCalled();
    expect(prismaMock.ticketActivity.create.mock.calls[0][0].data).toMatchObject({ ticketId: 55, activityType: 'ticket_ready' });
    expect(emitTicketEvent).toHaveBeenCalledWith('ticket.ready', 55, expect.objectContaining({
      dedupeStamp: 'ready:55',
      extra: expect.objectContaining({ readyReason: 'auto_help_done', autoHelpAnswered: false, autoHelpRunId: 901, waitedSeconds: 120 }),
    }));
  });

  test('already ready → nothing again', async () => {
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket(2));
    prismaMock.ticketActivity.findFirst.mockResolvedValueOnce({ id: 3 });
    expect(await ticketReady.markReady(55, { now: NOW })).toEqual({ already: true });
    expect(emitTicketEvent).not.toHaveBeenCalled();
  });

  test('"answering" says Auto-help answered', async () => {
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket(1));
    await ticketReady.markReady(55, { reason: 'auto_help_answering', autoHelpAnswered: true, now: NOW });
    expect(emitTicketEvent.mock.calls[0][2].extra).toMatchObject({ readyReason: 'auto_help_answering', autoHelpAnswered: true });
  });

  test('an old ticket, a workspace without the trigger, or a ticket from before the trigger was switched on → skipped', async () => {
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket(200));
    expect(await ticketReady.markReady(55, { now: NOW })).toEqual({ skipped: 'not_new' });
    prismaMock.ticket.findUnique.mockResolvedValueOnce({ ...ticket(5), workspaceId: 2 });
    prismaMock.notificationWorkflow.findMany.mockResolvedValueOnce([]);
    expect(await ticketReady.markReady(55, { now: NOW })).toEqual({ skipped: 'unused' });
    prismaMock.ticket.findUnique.mockResolvedValueOnce({ ...ticket(5), createdAt: new Date(ENABLED_AT.getTime() - 60e3) });
    expect(await ticketReady.markReady(55, { now: new Date(ENABLED_AT.getTime() + 60e3) })).toEqual({ skipped: 'before_trigger_on' });
    expect(emitTicketEvent).not.toHaveBeenCalled();
  });

  test('the sweep: tickets past 3 minutes and not ready go ahead ("timeout"); ready ones are left', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([{ id: 55 }, { id: 56 }]);
    prismaMock.ticketActivity.findMany.mockResolvedValueOnce([{ ticketId: 56 }]);
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket(4));
    const res = await ticketReady.sweep({ now: NOW });
    expect(res.ready).toBe(1);
    const where = prismaMock.ticket.findMany.mock.calls[0][0].where.OR[0];
    expect(where.workspaceId).toBe(1);
    expect(where.createdAt.lte).toEqual(new Date(NOW.getTime() - READY_MAX_WAIT_MS));
    expect(where.createdAt.gte).toEqual(new Date(NOW.getTime() - 2 * 3600e3));
    expect(emitTicketEvent).toHaveBeenCalledTimes(1);
    expect(emitTicketEvent.mock.calls[0][2].extra.readyReason).toBe('timeout');
  });

  test('no workspace uses the trigger → the sweep reads no tickets', async () => {
    prismaMock.notificationWorkflow.findMany.mockResolvedValueOnce([]);
    expect(await ticketReady.sweep({ now: NOW })).toEqual({ ready: 0 });
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });
});

describe('auto by night: sending', () => {
  const run = { id: 901, ticketId: 55, workspaceId: 1, outcomeDetail: { history: [] } };
  const pb = { id: 3, name: 'Software', sensitive: false, mode: 'approve', enabled: true };
  const settings = { enabled: true, approveModeEnabled: true, autoAfterHours: true };

  test('"Ticket ready" fires BEFORE the answer goes (so an ack can merge), then the ticket is marked overnight', async () => {
    const order = [];
    spies = [
      jest.spyOn(delivery, '_autoSendPermit').mockResolvedValue({ ok: true, scheduled: true }),
      jest.spyOn(delivery, '_assertSendable').mockResolvedValue({}),
      jest.spyOn(ticketReady, 'markReady').mockImplementation(async () => { order.push('ready'); return { emitted: true }; }),
      jest.spyOn(delivery, '_deliver').mockImplementation(async () => { order.push('send'); return { entryId: 5000 }; }),
    ];
    prismaMock.autoHelpRun.findFirst.mockResolvedValue(run);
    const out = await delivery._autoSend({ run, ticket: { id: 55, workspaceId: 1 }, playbook: pb, settings, preview: { subject: 'Re: x', html: '<p>x</p>' }, body: { html: '<p>x</p>' }, detail: {} });
    expect(order).toEqual(['ready', 'send']);
    expect(ticketReady.markReady).toHaveBeenCalledWith(55, expect.objectContaining({ reason: 'auto_help_answering', autoHelpAnswered: true, runId: 901 }));
    expect(out).toMatchObject({ status: 'sent', decision: 'auto_sent' });
    const detail = prismaMock.autoHelpRun.update.mock.calls[0][0].data.outcomeDetail;
    expect(detail.scheduledAuto).toMatchObject({ summarizedAt: null });
    expect(detail.history.map((h) => h.step)).toContain('sent_overnight');
    expect(prismaMock.ticketActivity.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ activityType: 'auto_help_sent_overnight' }) }));
  });

  test('no permit (business hours again, switch off) → refused, nothing sent', async () => {
    spies = [
      jest.spyOn(delivery, '_autoSendPermit').mockResolvedValue({ ok: false, scheduled: false }),
      jest.spyOn(delivery, '_deliver').mockResolvedValue({}),
    ];
    await expect(delivery._autoSend({ run, ticket: { id: 55, workspaceId: 1 }, playbook: pb, settings, preview: {}, body: {}, detail: {} })).rejects.toThrow(/not allowed/);
    expect(delivery._deliver).not.toHaveBeenCalled();
  });

  test('the permit: build switch off → only the schedule; sensitive or Auto-help off → never', async () => {
    spies = [jest.spyOn(playbooks, 'scheduledAuto').mockResolvedValue(true)];
    expect(await delivery._autoSendPermit(1, pb, settings)).toEqual({ ok: true, scheduled: true });
    expect(await delivery._autoSendPermit(1, { ...pb, sensitive: true }, settings)).toEqual({ ok: false, scheduled: false });
    expect(await delivery._autoSendPermit(1, pb, { ...settings, enabled: false })).toEqual({ ok: false, scheduled: false });
    playbooks.scheduledAuto.mockResolvedValue(false);
    expect(await delivery._autoSendPermit(1, pb, settings)).toEqual({ ok: false, scheduled: false });
  });
});

describe('the schedule itself', () => {
  const pb = { id: 3, name: 'Software', sensitive: false, mode: 'approve', enabled: true };
  const settings = { enabled: true, approveModeEnabled: true, autoAfterHours: true };

  test('scheduledAuto needs: switch, approve mode on, after hours, not sensitive, not shadow, readiness met', async () => {
    spies = [
      jest.spyOn(playbooks, 'isAfterHours').mockResolvedValue(true),
      jest.spyOn(playbooks, 'cachedReadiness').mockResolvedValue({ met: true }),
    ];
    expect(await playbooks.scheduledAuto(1, pb, settings)).toBe(true);
    expect(await playbooks.scheduledAuto(1, pb, { ...settings, autoAfterHours: false })).toBe(false);
    expect(await playbooks.scheduledAuto(1, pb, { ...settings, approveModeEnabled: false })).toBe(false);
    expect(await playbooks.scheduledAuto(1, { ...pb, sensitive: true }, settings)).toBe(false);
    expect(await playbooks.scheduledAuto(1, { ...pb, mode: 'shadow' }, settings)).toBe(false);
    playbooks.cachedReadiness.mockResolvedValue({ met: false });
    expect(await playbooks.scheduledAuto(1, pb, settings)).toBe(false);
    playbooks.cachedReadiness.mockResolvedValue({ met: true });
    playbooks.isAfterHours.mockResolvedValue(false);
    expect(await playbooks.scheduledAuto(1, pb, settings)).toBe(false);
  });

  test('a failing calendar reads as business hours (nothing sends by itself)', async () => {
    prismaMock.workspace.findUnique.mockRejectedValueOnce(new Error('db down'));
    expect(await playbooks.isAfterHours(1, { at: NOW })).toBe(false);
  });

  test('an acknowledgement set to merge waits after hours when a proven playbook may answer', async () => {
    spies = [
      jest.spyOn(playbooks, 'getSettings').mockResolvedValue(settings),
      jest.spyOn(playbooks, 'scheduledAuto').mockResolvedValue(true),
      jest.spyOn(playbooks, 'isAfterHours').mockResolvedValue(true),
    ];
    prismaMock.autoHelpPlaybook.findMany.mockResolvedValue([pb]);
    prismaMock.autoHelpRun.findFirst.mockResolvedValue(null);
    prismaMock.autoHelpRun.findMany.mockResolvedValue([]);
    expect(await expectedFor(55, 1)).toBe(true);
    playbooks.scheduledAuto.mockResolvedValue(false);
    expect(await expectedFor(55, 1)).toBe(false);
  });

  test('morning-summary recipients are cleaned; a bad address or too many is refused', () => {
    expect(cleanSummaryRecipients('A@x.io, b@x.io; a@x.io')).toEqual(['a@x.io', 'b@x.io']);
    expect(cleanSummaryRecipients([])).toEqual([]);
    expect(() => cleanSummaryRecipients('not-an-address')).toThrow(ValidationError);
    expect(() => cleanSummaryRecipients(Array.from({ length: 11 }, (_, i) => `p${i}@x.io`))).toThrow(/At most 10/);
  });
});

describe('the morning summary', () => {
  const overnightRun = (id, summarizedAt = null) => ({
    id, ticketId: 55, workspaceId: 1, playbookId: 3, decision: 'auto_sent', outcome: null,
    outcomeDetail: { scheduledAuto: { at: '2026-09-30T08:00:00Z', summarizedAt } },
  });
  beforeEach(() => {
    prismaMock.autoHelpSettings.findMany.mockResolvedValue([{ workspaceId: 1, afterHoursSummaryTo: [], afterHoursSummarySentFor: '2026-09-29' }]);
    prismaMock.autoHelpSettings.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.ticket.findMany.mockResolvedValue([{ id: 55, subject: 'VPN drops', status: 'Open', origin: 'ticketpulse', nativeNumber: 1285, requester: { name: 'Riley' } }]);
    prismaMock.autoHelpPlaybook.findMany.mockResolvedValue([{ id: 3, name: 'Network & VPN' }]);
    prismaMock.workspaceAccess.findMany.mockResolvedValue([{ email: 'Admin@x.io' }]);
  });

  test('first business-hours tick: claims the day, mails the admins the overnight answers, marks them summarised', async () => {
    spies = [jest.spyOn(playbooks, 'isAfterHours').mockResolvedValue(false)];
    prismaMock.autoHelpRun.findMany.mockResolvedValue([overnightRun(901), overnightRun(902, '2026-09-29T16:00:00Z')]);
    const res = await delivery.sendMorningSummaries({ now: NOW });
    expect(res.sent).toBe(1);
    expect(prismaMock.autoHelpSettings.updateMany.mock.calls[0][0].data).toEqual({ afterHoursSummarySentFor: '2026-09-30' });
    const mail = sendTransactionalEmail.mock.calls[0][0];
    expect(mail).toMatchObject({ to: ['admin@x.io'], label: 'auto-help-overnight-summary', subject: 'Auto-help answered 1 ticket overnight (IT)' });
    expect(mail.html).toContain('TP-1285');
    expect(mail.html).not.toMatch(/gradient/);
    const marked = prismaMock.autoHelpRun.update.mock.calls.map((c) => c[0]);
    expect(marked).toHaveLength(1);
    expect(marked[0].where.id).toBe(901);
    expect(marked[0].data.outcomeDetail.scheduledAuto.summarizedAt).toBeTruthy();
  });

  test('still after hours, or already sent today → nothing', async () => {
    spies = [jest.spyOn(playbooks, 'isAfterHours').mockResolvedValue(true)];
    expect(await delivery.sendMorningSummaries({ now: NOW })).toEqual({ sent: 0 });
    playbooks.isAfterHours.mockResolvedValue(false);
    prismaMock.autoHelpSettings.findMany.mockResolvedValue([{ workspaceId: 1, afterHoursSummaryTo: [], afterHoursSummarySentFor: '2026-09-30' }]);
    expect(await delivery.sendMorningSummaries({ now: NOW })).toEqual({ sent: 0 });
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  test('another container claimed the day → nothing', async () => {
    spies = [jest.spyOn(playbooks, 'isAfterHours').mockResolvedValue(false)];
    prismaMock.autoHelpSettings.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await delivery.sendMorningSummaries({ now: NOW })).toEqual({ sent: 0 });
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  test('nothing went out overnight → no e-mail', async () => {
    spies = [jest.spyOn(playbooks, 'isAfterHours').mockResolvedValue(false)];
    prismaMock.autoHelpRun.findMany.mockResolvedValue([]);
    expect(await delivery.sendMorningSummaries({ now: NOW })).toEqual({ sent: 0 });
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  test('the mail fails → the day is given back for the next tick', async () => {
    spies = [jest.spyOn(playbooks, 'isAfterHours').mockResolvedValue(false)];
    prismaMock.autoHelpRun.findMany.mockResolvedValue([overnightRun(901)]);
    sendTransactionalEmail.mockResolvedValueOnce({ sent: false, error: 'refused' });
    expect(await delivery.sendMorningSummaries({ now: NOW })).toEqual({ sent: 0 });
    expect(prismaMock.autoHelpSettings.updateMany.mock.calls[1][0]).toMatchObject({ where: { workspaceId: 1, afterHoursSummarySentFor: '2026-09-30' }, data: { afterHoursSummarySentFor: '2026-09-29' } });
    expect(prismaMock.autoHelpRun.update).not.toHaveBeenCalled();
  });

  test('named recipients win over the admins', async () => {
    spies = [jest.spyOn(playbooks, 'isAfterHours').mockResolvedValue(false)];
    prismaMock.autoHelpSettings.findMany.mockResolvedValue([{ workspaceId: 1, afterHoursSummaryTo: ['lead@x.io'], afterHoursSummarySentFor: null }]);
    prismaMock.autoHelpRun.findMany.mockResolvedValue([overnightRun(901)]);
    await delivery.sendMorningSummaries({ now: NOW });
    expect(sendTransactionalEmail.mock.calls[0][0].to).toEqual(['lead@x.io']);
    expect(prismaMock.workspaceAccess.findMany).not.toHaveBeenCalled();
  });
});
