import { jest } from '@jest/globals';

/**
 * Urgent response — the weekly admin e-mail (plans/URGENT_RESPONSE_PLAN.md):
 * one per workspace in Shadow or Live, skipped for the sandboxes, for mode off
 * and for a week with nothing in it; to the workspace admins; Outlook-safe
 * HTML with the counts by layer, the rule's own sentences and links.
 */
const prismaMock = {
  urgentResponseSettings: { findMany: jest.fn() },
  workspace: { findMany: jest.fn() },
  workspaceAccess: { findMany: jest.fn() },
};
const settings = new Map();
const settingsRepoMock = { get: jest.fn(async (k) => (settings.has(k) ? settings.get(k) : null)) };
const sendMock = jest.fn();
const engineMock = { weeklySummary: jest.fn() };
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepoMock }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ sendTransactionalEmail: sendMock }));
jest.unstable_mockModule('../src/services/urgentResponse/urgentResponseService.js', () => ({ default: engineMock }));
jest.unstable_mockModule('../src/utils/publicBaseUrl.js', () => ({ resolvePublicBaseUrl: () => 'https://ticketpulse.example' }));

const { default: service } = await import('../src/services/urgentResponse/urgentResponseDigestService.js');

const NOW = new Date('2026-10-19T15:10:00.000Z'); // Monday 08:10 Pacific
const ZERO = { redirected: 0, held: 0, moved: 0, raiseMoved: 0, clockMoved: 0, toldOwnerAway: 0, teamTold: 0, coordinator: 0, onCallAssigned: 0, undone: 0 };
const BUSY = { redirected: 12, held: 1, moved: 7, raiseMoved: 4, clockMoved: 3, toldOwnerAway: 5, teamTold: 9, coordinator: 2, onCallAssigned: 6, undone: 8 };
const EXAMPLES = [
  { createdAt: '2026-10-14T14:10:00.000Z', sentence: 'Shadow: would have moved from David Zapata to Andrew Fong by the Urgent rule. Became Urgent at 07:10; David starts at 09:00.', ticketId: 500, displayRef: 'TP-1700' },
  { createdAt: '2026-10-15T17:00:00.000Z', sentence: 'Shadow: would have told the people at work. Urgent and untouched for 15 minutes.', ticketId: 501, displayRef: '#242611' },
];
const summary = (over = {}) => ({ mode: 'observe', live: { ...ZERO }, shadow: { ...BUSY }, examples: EXAMPLES, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  settings.clear();
  delete process.env.URGENT_RESPONSE_DIGEST;
  delete process.env.ADMIN_EMAILS;
  prismaMock.urgentResponseSettings.findMany.mockResolvedValue([{ workspaceId: 1, mode: 'observe' }]);
  prismaMock.workspace.findMany.mockResolvedValue([{ id: 1, name: 'IT', isActive: true }]);
  prismaMock.workspaceAccess.findMany.mockResolvedValue([{ email: 'Admin@BGC.ca' }, { email: 'admin@bgc.ca' }, { email: 'second@bgc.ca' }]);
  engineMock.weeklySummary.mockResolvedValue(summary());
  sendMock.mockResolvedValue({ sent: true });
});

describe('enabled / window', () => {
  test('on unless the kill switch says false', () => {
    expect(service.enabled()).toBe(true);
    process.env.URGENT_RESPONSE_DIGEST = 'false';
    expect(service.enabled()).toBe(false);
    process.env.URGENT_RESPONSE_DIGEST = 'true';
    expect(service.enabled()).toBe(true);
  });

  test('the window is the seven days that end at the run', () => {
    expect(service.window(NOW)).toEqual({ since: new Date('2026-10-12T15:10:00.000Z'), until: NOW });
  });
});

describe('buildDigest', () => {
  test('asks the engine for the week and keeps at most five sentences', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ createdAt: NOW, sentence: `Sentence ${i}.`, ticketId: i + 1, displayRef: `TP-${i + 1}` }));
    engineMock.weeklySummary.mockResolvedValue(summary({ examples: [...many, { sentence: '' }] }));
    const win = service.window(NOW);
    const digest = await service.buildDigest('1', win);
    expect(engineMock.weeklySummary).toHaveBeenCalledWith(1, win);
    expect(digest).toMatchObject({ mode: 'observe', shadow: BUSY, live: ZERO, empty: false, since: win.since, until: win.until });
    expect(digest.examples.map((e) => e.sentence)).toEqual(['Sentence 0.', 'Sentence 1.', 'Sentence 2.', 'Sentence 3.', 'Sentence 4.']);
  });

  test('a week with nothing on either side is empty; missing counts read as zero', async () => {
    engineMock.weeklySummary.mockResolvedValue({ mode: 'live', live: {}, shadow: null, examples: null });
    expect(await service.buildDigest(1, service.window(NOW))).toMatchObject({ mode: 'live', live: ZERO, shadow: ZERO, examples: [], empty: true });
    engineMock.weeklySummary.mockResolvedValue(null);
    expect(await service.buildDigest(1, service.window(NOW))).toMatchObject({ mode: 'off', empty: true });
  });
});

describe('renderHtml', () => {
  const render = async (over) => {
    engineMock.weeklySummary.mockResolvedValue(summary(over));
    return service.renderHtml(await service.buildDigest(1, service.window(NOW)), { workspaceName: 'IT & <Ops>', baseUrl: 'https://ticketpulse.example' });
  };

  test('Shadow: the mode line, every count by layer, the sentences, the ticket links and the log link', async () => {
    const html = await render();
    expect(html).toContain('Shadow: nothing was moved; this is what would have happened.');
    expect(html).toContain('Urgent response last week - IT &amp; &lt;Ops&gt;');
    for (const title of ['When assigning', 'When it became urgent', 'Untouched clock', 'Undone']) expect(html).toContain(title);
    // Every number of the table (each count is a different value, so each cell is checked).
    for (const key of ['redirected', 'held', 'raiseMoved', 'toldOwnerAway', 'onCallAssigned', 'teamTold', 'clockMoved', 'coordinator', 'undone']) {
      expect(html).toContain(`white-space:nowrap;">${BUSY[key]}</td>`);
    }
    expect(html).toContain('Shadow: would have moved from David Zapata to Andrew Fong by the Urgent rule.');
    expect(html).toContain('href="https://ticketpulse.example/tickets/500"');
    expect(html).toContain('>TP-1700</a>');
    expect(html).toContain('href="https://ticketpulse.example/tickets/501"');
    expect(html).toContain('>#242611</a>');
    expect(html).toContain('href="https://ticketpulse.example/settings#urgent-response"');
    expect(html).toContain('Open the log');
  });

  test('Live shows the live counts, and says so when Shadow rows were logged the same week', async () => {
    const html = await render({ mode: 'live', live: { ...ZERO, redirected: 3, moved: 2, raiseMoved: 2 }, shadow: { ...ZERO, teamTold: 4 } });
    expect(html).toContain('Live: these tickets were really moved');
    expect(html).not.toContain('nothing was moved');
    expect(html).toContain('white-space:nowrap;">3</td>');
    expect(html).toContain('The mode changed during the week: 4 more entries were logged in Shadow.');
  });

  test('Outlook-safe: no gradients, no background shorthand, the band is a coloured cell, text always has a colour', async () => {
    const html = await render();
    expect(html.toLowerCase()).not.toContain('gradient');
    expect(html).not.toMatch(/background:/);
    expect(html).toContain('<td bgcolor="#1e3a8a" style="background-color:#1e3a8a;');
    for (const tag of html.match(/<(p|a|strong|span)[ >][^>]*>/g)) expect(tag).toMatch(/color:#[0-9a-f]{6}/);
    for (const tag of html.match(/<td[^>]*font-size[^>]*>/g)) expect(tag).toMatch(/[^-]color:#[0-9a-f]{6}/);
  });

  test('a sentence is escaped, and one without a ticket has no link', async () => {
    const html = await render({ examples: [{ sentence: 'Moved <b>fast</b> & far.', ticketId: null, displayRef: null }] });
    expect(html).toContain('Moved &lt;b&gt;fast&lt;/b&gt; &amp; far.');
    expect(html).not.toContain('/tickets/');
  });

  test('no sentences: no "In its own words" block', async () => {
    expect(await render({ examples: [] })).not.toContain('In its own words');
  });
});

describe('sendDigests', () => {
  test('one e-mail per workspace to its admins, labelled, never with a ticket', async () => {
    const out = await service.sendDigests({ now: NOW });
    expect(out).toEqual([{ workspaceId: 1, sent: true, to: 2, mode: 'observe' }]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const mail = sendMock.mock.calls[0][0];
    expect(mail).toMatchObject({ workspaceId: 1, to: ['admin@bgc.ca', 'second@bgc.ca'], subject: 'Ticket Pulse - Urgent response last week: IT', label: 'urgent-response-digest' });
    expect('ticket' in mail).toBe(false);
    expect(mail.html).toContain('Open the log');
    expect(engineMock.weeklySummary).toHaveBeenCalledWith(1, { since: new Date('2026-10-12T15:10:00.000Z'), until: NOW });
  });

  test('only workspaces that are not off, never the sandboxes; every list read is capped', async () => {
    await service.sendDigests({ now: NOW });
    const query = prismaMock.urgentResponseSettings.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ mode: { not: 'off' }, workspaceId: { notIn: [6, 7, 8] } });
    expect(query.take).toBe(100);
    expect(prismaMock.workspace.findMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: [1] } }, select: { id: true, name: true, isActive: true }, take: 1 });
    expect(prismaMock.workspaceAccess.findMany.mock.calls[0][0]).toMatchObject({ where: { workspaceId: 1, role: 'admin' }, select: { email: true }, take: 200 });
  });

  test('skips: a sandbox row, an inactive workspace, mode off, a week with nothing', async () => {
    prismaMock.urgentResponseSettings.findMany.mockResolvedValue([
      { workspaceId: 1, mode: 'observe' }, { workspaceId: 2, mode: 'live' }, { workspaceId: 3, mode: 'live' }, { workspaceId: 4, mode: 'observe' }, { workspaceId: 7, mode: 'live' },
    ]);
    prismaMock.workspace.findMany.mockResolvedValue([
      { id: 1, name: 'IT', isActive: true }, { id: 2, name: 'Accounting', isActive: true }, { id: 3, name: 'AR', isActive: true }, { id: 4, name: 'Old', isActive: false }, { id: 7, name: 'Sandbox', isActive: true },
    ]);
    engineMock.weeklySummary.mockImplementation(async (ws) => {
      if (ws === 2) return summary({ mode: 'live', live: { ...ZERO }, shadow: { ...ZERO } }); // nothing happened
      if (ws === 3) return summary({ mode: 'off' }); // switched off since the list was read
      return summary();
    });
    const out = await service.sendDigests({ now: NOW });
    expect(out).toEqual([
      { workspaceId: 1, sent: true, to: 2, mode: 'observe' },
      { workspaceId: 2, skipped: 'nothing_to_report' },
      { workspaceId: 3, skipped: 'mode_off' },
    ]);
    expect(engineMock.weeklySummary.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  test('no workspace admins: the global admin list; nobody at all: skipped', async () => {
    prismaMock.workspaceAccess.findMany.mockResolvedValue([]);
    settings.set('admin_emails', 'Root@BGC.ca, ops@bgc.ca');
    await service.sendDigests({ now: NOW });
    expect(sendMock.mock.calls[0][0].to).toEqual(['root@bgc.ca', 'ops@bgc.ca']);

    jest.clearAllMocks();
    settings.clear();
    expect(await service.sendDigests({ now: NOW })).toEqual([{ workspaceId: 1, skipped: 'no_recipients' }]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  test('dryRun builds everything and sends nothing', async () => {
    const out = await service.sendDigests({ now: NOW, dryRun: true });
    expect(sendMock).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ workspaceId: 1, dryRun: true, to: ['admin@bgc.ca', 'second@bgc.ca'], subject: 'Ticket Pulse - Urgent response last week: IT' });
    expect(out[0].html).toContain('When assigning');
    expect(out[0].digest.shadow).toEqual(BUSY);
  });

  test('the kill switch, a missing table, and nobody in Shadow or Live: nothing happens', async () => {
    process.env.URGENT_RESPONSE_DIGEST = 'false';
    expect(await service.sendDigests({ now: NOW })).toEqual([]);
    expect(prismaMock.urgentResponseSettings.findMany).not.toHaveBeenCalled();
    delete process.env.URGENT_RESPONSE_DIGEST;

    prismaMock.urgentResponseSettings.findMany.mockRejectedValue(new Error('relation "urgent_response_settings" does not exist'));
    expect(await service.sendDigests({ now: NOW })).toEqual([]);
    prismaMock.urgentResponseSettings.findMany.mockResolvedValue([]);
    expect(await service.sendDigests({ now: NOW })).toEqual([]);
    expect(prismaMock.workspace.findMany).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  test('one workspace failing does not stop the next, and it never throws', async () => {
    prismaMock.urgentResponseSettings.findMany.mockResolvedValue([{ workspaceId: 1, mode: 'observe' }, { workspaceId: 2, mode: 'live' }]);
    prismaMock.workspace.findMany.mockResolvedValue([{ id: 1, name: 'IT', isActive: true }, { id: 2, name: 'Accounting', isActive: true }]);
    engineMock.weeklySummary.mockRejectedValueOnce(new Error('weeklySummary is not built yet'));
    sendMock.mockResolvedValue({ sent: false, error: 'SendGrid 403' });
    const out = await service.sendDigests({ now: NOW });
    expect(out).toEqual([
      { workspaceId: 1, error: 'weeklySummary is not built yet' },
      { workspaceId: 2, sent: false, to: 2, mode: 'observe' },
    ]);
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('Urgent response digest failed for workspace 1'));
  });
});
