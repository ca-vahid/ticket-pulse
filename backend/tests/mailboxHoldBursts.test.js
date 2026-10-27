import { jest } from '@jest/globals';

/**
 * QA 10-26 #3 — alert bursts in the hold queue: the per-workspace burst
 * grouping (off / shadow / on), one decision for many held mails, and the
 * daily digest grouped by device in plain, Outlook-safe e-mail.
 */

const prismaMock = {
  mailboxHeldMessage: {
    findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(), groupBy: jest.fn(),
  },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  workspace: { findUnique: jest.fn() },
};
const settings = new Map();
const settingsMock = {
  get: jest.fn((key) => Promise.resolve(settings.has(key) ? settings.get(key) : null)),
  set: jest.fn((key, value) => { settings.set(key, value); return Promise.resolve({ key, value }); }),
};
const ticketServiceMock = { addPrivateNote: jest.fn() };
const sendTransactionalEmailMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/mailboxIngestService.js', () => ({ default: { ingestReply: jest.fn().mockResolvedValue({ id: 1 }) } }));
jest.unstable_mockModule('../src/services/reportRecipients.js', () => ({ reportRecipients: jest.fn().mockResolvedValue(['lead@x.io']) }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({
  sendTransactionalEmail: sendTransactionalEmailMock,
  default: { sendTransactionalEmail: sendTransactionalEmailMock },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const {
  default: holdService, buildHoldDigest, formatWhen, formatSpan, burstFoldKey, DEFAULT_BURST_FOLD_MODE,
} = await import('../src/services/mailboxHoldService.js');

const NAS = 'nas-one@x.io';
const connection = { id: 4, workspaceId: 1, address: 'help@x.io' };
const mail = (subject, n = 1) => ({
  id: `g-${n}`, internetMessageId: `<m-${n}@x.io>`, subject, from: NAS, fromName: 'NAS-ONE', to: ['help@x.io'], cc: [],
  receivedAt: new Date('2026-10-23T16:52:31Z'), bodyPreview: 'alert',
});
const DRIVE = '[NAS-ONE] Drive 12 on RS1 is not on the Products Compatibility List';
const driveTicket = {
  id: 64845, nativeNumber: 10558, origin: 'ticketpulse', freshserviceTicketId: null, status: 'Closed', occurrenceCount: 0,
  subject: '[NAS-ONE] Drive 3 on RS1 is not on the Products Compatibility List', createdAt: new Date('2026-10-23T16:52:26Z'), requester: { email: NAS },
};
const burst = (subject = DRIVE, n = 1) => holdService.holdMessage(connection, mail(subject, n), {
  reason: 'sender_burst', decision: { rule: 'sender_burst', details: { cap: 3, sender: NAS } },
});

beforeEach(() => {
  jest.clearAllMocks();
  settings.clear();
  prismaMock.mailboxHeldMessage.findFirst.mockResolvedValue(null);
  prismaMock.mailboxHeldMessage.create.mockImplementation(({ data }) => Promise.resolve({ id: 900, status: data.status }));
  prismaMock.mailboxHeldMessage.update.mockResolvedValue({});
  prismaMock.mailboxHeldMessage.updateMany.mockImplementation(({ where }) => Promise.resolve({ count: where.id.in.length }));
  prismaMock.ticket.findMany.mockResolvedValue([driveTicket]);
  prismaMock.ticket.findUnique.mockResolvedValue({ occurrenceCount: 0, lastOccurrenceAt: null });
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.workspace.findUnique.mockResolvedValue({ name: 'IT', defaultTimezone: 'America/Vancouver' });
  ticketServiceMock.addPrivateNote.mockResolvedValue({ id: 1 });
});

describe('burst grouping at hold time', () => {
  test('defaults to shadow: the row stays held, says which ticket it would have joined, and that ticket is the best guess', async () => {
    expect(DEFAULT_BURST_FOLD_MODE).toBe('shadow');
    const out = await burst();
    expect(out).toMatchObject({ id: 900, status: 'held', fold: { mode: 'shadow', ticketId: 64845, displayRef: 'TP-10558' } });
    const update = prismaMock.mailboxHeldMessage.update.mock.calls[0][0];
    expect(update.data.bestGuessTicketId).toBe(64845);
    expect(update.data.status).toBeUndefined();
    expect(update.data.decision.details).toMatchObject({ cap: 3, sender: NAS, fold: { mode: 'shadow', ticketId: 64845 } });
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('on: a known kind is counted on its ticket and the row is filed as attached', async () => {
    settings.set(burstFoldKey(1), 'on');
    const out = await burst();
    expect(out.status).toBe('attached');
    const update = prismaMock.mailboxHeldMessage.update.mock.calls[0][0];
    expect(update.data).toMatchObject({ status: 'attached', resolvedTicketId: 64845, resolvedBy: 'Ticket Pulse burst grouping' });
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 64845 }, data: expect.objectContaining({ occurrenceCount: 2, lastOccurrenceSummary: DRIVE }),
    }));
    // 2 is a note count: the ticket says why its counter moved.
    expect(ticketServiceMock.addPrivateNote).toHaveBeenCalledWith(64845, 1, expect.objectContaining({ bodyText: expect.stringContaining('arrived 2 times') }), expect.anything(), [], { systemNote: true });
  });

  test('on: a new kind on the same device stays held', async () => {
    settings.set(burstFoldKey(1), 'on');
    const out = await burst('[NAS-ONE] Volume 1 on NAS-ONE is running out of available capacity');
    expect(out.status).toBe('held');
    expect(prismaMock.mailboxHeldMessage.update).not.toHaveBeenCalled();
  });

  test('on: a crash whose earlier ticket is closed stays held; with the ticket open it is counted', async () => {
    settings.set(burstFoldKey(1), 'on');
    const crash = { ...driveTicket, id: 7, nativeNumber: 7, subject: '[NAS-ONE] Storage Pool 1 on NAS-ONE has crashed' };
    prismaMock.ticket.findMany.mockResolvedValue([crash]);
    expect((await burst(crash.subject)).status).toBe('held');
    prismaMock.ticket.findMany.mockResolvedValue([{ ...crash, status: 'Open' }]);
    expect((await burst(crash.subject, 2)).status).toBe('attached');
  });

  test('off: nothing is looked up; other hold reasons never fold', async () => {
    settings.set(burstFoldKey(1), 'off');
    expect((await burst()).status).toBe('held');
    settings.set(burstFoldKey(1), 'on');
    await holdService.holdMessage(connection, mail(DRIVE, 3), { reason: 'unknown_reference', decision: { rule: 'x' } });
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });

  test('a failed lookup never loses the hold', async () => {
    settings.set(burstFoldKey(1), 'on');
    prismaMock.ticket.findMany.mockRejectedValue(new Error('db down'));
    expect(await burst()).toMatchObject({ id: 900, status: 'held' });
  });

  test('the mode setting only takes off / shadow / on', async () => {
    await expect(holdService.setBurstFoldMode(1, 'sometimes')).rejects.toThrow(/mode must be one of/);
    expect(await holdService.setBurstFoldMode(1, 'ON')).toBe('on');
    expect(await holdService.getBurstFoldMode(1)).toBe('on');
  });
});

describe('bulk decisions', () => {
  const heldRows = [
    { id: 1, subject: DRIVE, fromEmail: NAS, receivedAt: new Date('2026-10-23T15:53:00Z') },
    { id: 2, subject: DRIVE.replace('12', '9'), fromEmail: NAS, receivedAt: new Date('2026-10-23T16:10:00Z') },
    { id: 3, subject: '[NAS-ONE] Storage Pool 1 on NAS-ONE has crashed', fromEmail: NAS, receivedAt: new Date('2026-10-23T16:52:00Z') },
  ];
  const actor = { email: 'ari@x.io', name: 'Ari Agent' };

  test('attach all: one internal note listing the kinds, the rows filed as attached, the count on the ticket', async () => {
    prismaMock.mailboxHeldMessage.findMany.mockResolvedValue(heldRows);
    prismaMock.ticket.findFirst.mockResolvedValue(driveTicket);
    const out = await holdService.bulk(1, [1, 2, 3, 3], 'attach', { ticketId: 64845, actor });
    expect(out).toEqual({ action: 'attach', count: 3, ticket: { id: 64845, displayRef: 'TP-10558' } });
    expect(ticketServiceMock.addPrivateNote).toHaveBeenCalledTimes(1);
    const note = ticketServiceMock.addPrivateNote.mock.calls[0][2].bodyText;
    expect(note).toContain('3 held emails from nas-one@x.io were added here from Unmatched replies by Ari Agent.');
    expect(note).toContain('Fri 23 Oct, 08:53 and Fri 23 Oct, 09:52'); // Pacific, not the server's UTC
    expect(note).toContain('- 2 × Drive # on RS1 is not on the Products Compatibility List');
    expect(note).toContain('- 1 × Storage Pool 1 on NAS-ONE has crashed');
    expect(prismaMock.mailboxHeldMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [1, 2, 3] }, status: 'held' },
      data: expect.objectContaining({ status: 'attached', resolvedTicketId: 64845, resolvedBy: 'ari@x.io' }),
    });
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ occurrenceCount: 4 }) }));
    expect(prismaMock.mailboxHeldMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [1, 2, 3] }, workspaceId: 1, status: 'held' } }));
  });

  test('discard all touches only rows still held in this workspace', async () => {
    prismaMock.mailboxHeldMessage.findMany.mockResolvedValue(heldRows.slice(0, 2));
    expect(await holdService.bulk(1, [1, 2, 99], 'discard', { actor })).toEqual({ action: 'discard', count: 2 });
    expect(prismaMock.mailboxHeldMessage.updateMany).toHaveBeenCalledWith({ where: { id: { in: [1, 2] }, status: 'held' }, data: expect.objectContaining({ status: 'discarded' }) });
    expect(ticketServiceMock.addPrivateNote).not.toHaveBeenCalled();
  });

  test('refuses an unknown action, no ids, a ticket from elsewhere, and rows already dealt with', async () => {
    await expect(holdService.bulk(1, [1], 'merge', { actor })).rejects.toThrow(/attach or discard/);
    await expect(holdService.bulk(1, [], 'discard', { actor })).rejects.toThrow(/ids are required/);
    prismaMock.mailboxHeldMessage.findMany.mockResolvedValue([]);
    await expect(holdService.bulk(1, [1], 'discard', { actor })).rejects.toThrow(/already dealt with/);
    prismaMock.mailboxHeldMessage.findMany.mockResolvedValue(heldRows);
    prismaMock.ticket.findFirst.mockResolvedValue(null);
    await expect(holdService.bulk(1, [1, 2], 'attach', { ticketId: 5, actor })).rejects.toThrow(/Ticket not found/);
  });
});

describe('the daily digest, grouped by device', () => {
  const group = {
    sender: NAS, device: 'NAS-ONE', count: 63, firstAt: '2026-10-23T15:52:49Z', lastAt: '2026-10-23T17:08:15Z',
    kinds: [
      { key: 'a', label: 'Storage Pool 1 on NAS-ONE has crashed', count: 1, attention: true, newKind: true, ticket: null, newestAt: '2026-10-23T16:53:47Z' },
      { key: 'b', label: 'Drive # on RS1 is not on the <Products> List', count: 62, attention: false, newKind: false, ticket: { id: 1, displayRef: 'TP-10563', status: 'Closed' }, newestAt: '2026-10-23T17:08:14Z' },
    ],
  };
  const single = { id: 7, subject: 'Re: printer', fromEmail: 'rita@x.io', reason: 'unknown_reference', receivedAt: '2026-10-24T18:00:00Z', bestGuessTicket: { displayRef: 'TP-5' } };

  test('one paragraph per device, kinds as bullets with the failure marked, times in Pacific, explicit colours, no gradient', () => {
    const { subject, html } = buildHoldDigest({
      workspaceName: 'IT', count: 64, groups: [group], singles: [single], link: 'https://tp.example/settings#ticket-mailboxes', linkIsUrl: true,
    });
    expect(subject).toBe('Ticket Pulse: 64 held emails waiting for review (alert bursts from NAS-ONE)');
    expect(html).toContain('<strong>IT</strong> has <strong>64</strong> held emails waiting for review.');
    expect(html).toContain('<strong>NAS-ONE</strong>: 63 alerts, 2 kinds, Fri 23 Oct, 08:52 to 10:08');
    expect(html).toContain('Needs a look:</span> 1 × Storage Pool 1 on NAS-ONE has crashed');
    expect(html).toContain('<strong>no ticket yet</strong>');
    expect(html).toContain('62 × Drive # on RS1 is not on the &lt;Products&gt; List');
    expect(html).toContain('ticket TP-10563 (Closed)');
    expect(html).toContain('Other held emails</strong> (1)');
    expect(html).toContain('answers mail Ticket Pulse never saw · best guess TP-5 · Sat 24 Oct, 11:00');
    expect(html).not.toMatch(/gradient/i);
    expect(html).not.toContain('unknown_reference');
    expect(html).toMatch(/color:#1f2937/);
  });

  test('without a burst it keeps the old wording and subject', () => {
    const { subject, html } = buildHoldDigest({ workspaceName: 'PA', count: 1, singles: [single], link: 'Settings', linkIsUrl: false });
    expect(subject).toBe('Ticket Pulse: 1 unmatched reply waiting for review');
    expect(html).toContain('Each one needs a decision');
  });

  test('sendDailyDigests groups the queue before sending', async () => {
    prismaMock.mailboxHeldMessage.groupBy.mockResolvedValue([{ workspaceId: 1, _count: { _all: 4 } }]);
    prismaMock.mailboxHeldMessage.findMany.mockResolvedValue([1, 2, 3, 4].map((id) => ({
      id, workspaceId: 1, status: 'held', reason: 'sender_burst', subject: id === 4 ? '[NAS-ONE] Storage Pool 1 has crashed' : `[NAS-ONE] Drive ${id} on RS1 is not listed`,
      fromEmail: NAS, receivedAt: new Date('2026-10-23T16:52:00Z'), connection: { address: 'help@x.io' },
    })));
    prismaMock.ticket.findMany.mockResolvedValue([]);
    sendTransactionalEmailMock.mockResolvedValue({ sent: true, via: 'msgraph' });
    const out = await holdService.sendDailyDigests({ appUrl: 'https://tp.example' });
    expect(out.sent).toEqual([{ workspaceId: 1, count: 4, recipients: 1, sent: true, via: 'msgraph' }]);
    const params = sendTransactionalEmailMock.mock.calls[0][0];
    expect(params.subject).toContain('alert bursts from NAS-ONE');
    expect(params.html).toContain('Needs a look:</span> 1 × Storage Pool 1 has crashed');
    expect(params.html).toContain('3 × Drive # on RS1 is not listed');
  });

  test('time helpers speak Pacific', () => {
    expect(formatWhen('2026-10-23T17:08:15Z')).toBe('Fri 23 Oct, 10:08');
    expect(formatSpan('2026-10-23T15:52:49Z', '2026-10-24T17:08:15Z')).toBe('Fri 23 Oct, 08:52 to Sat 24 Oct, 10:08');
  });
});
