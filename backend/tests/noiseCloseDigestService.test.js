import { jest } from '@jest/globals';

/**
 * Noise auto-close digest + Reopen & route (27 Sep 2026).
 */

const prismaMock = {
  assignmentPipelineRun: { findMany: jest.fn(), findUnique: jest.fn() },
  assignmentConfig: { findMany: jest.fn() },
  workspaceAccess: { findMany: jest.fn() },
  ticket: { findUnique: jest.fn() },
};
const settings = new Map();
const settingsMock = {
  get: jest.fn(async (k) => (settings.has(k) ? settings.get(k) : null)),
  set: jest.fn(async (k, v) => { settings.set(k, v); }),
};
const sendMock = jest.fn();
const ticketServiceMock = { changeStatus: jest.fn(), updateFsTicket: jest.fn(), setNoise: jest.fn() };
const statusServiceMock = { baseStatusOf: jest.fn() };
const pipelineMock = { runPipeline: jest.fn().mockResolvedValue({}) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ sendTransactionalEmail: sendMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({ default: statusServiceMock }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: pipelineMock }));
jest.unstable_mockModule('../src/utils/publicBaseUrl.js', () => ({ resolvePublicBaseUrl: () => 'https://ticketpulse.example' }));

const { default: service, closeReason, ticketRef, digestLastSentKey, digestEnabledKey } = await import('../src/services/noiseCloseDigestService.js');

const NOW = new Date('2026-09-28T15:05:00.000Z'); // Monday 08:05 PT

const aiRun = (id, over = {}) => ({
  id, triggerSource: 'webhook', syncStatus: 'synced', errorMessage: null,
  recommendation: { recommendations: [], closureNoticeHtml: '<p>Vendor marketing. No action needed.</p>' },
  ticket: { id: id + 1000, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 240000 + id, subject: `Subject ${id}`, status: 'Closed', isNoise: true, requester: { name: 'Vendor', email: 'news@vendor.com' } },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  settings.clear();
  prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([]);
  prismaMock.workspaceAccess.findMany.mockResolvedValue([{ email: 'Admin@BGC.ca' }]);
  prismaMock.assignmentConfig.findMany.mockResolvedValue([{ workspaceId: 1, workspace: { name: 'IT', isActive: true } }]);
  sendMock.mockResolvedValue({ sent: true });
});

describe('helpers', () => {
  test('closeReason prefers the labelled reason, then the closure notice, first sentence only', () => {
    expect(closeReason({ nonActionableReason: 'Automated backup success notice' })).toBe('Automated backup success notice');
    expect(closeReason({ closureNoticeHtml: '<p>Vendor marketing. No action needed.</p>' })).toBe('Vendor marketing.');
    expect(closeReason({ overallReasoning: 'x'.repeat(300) })).toHaveLength(178);
  });

  test('ticketRef names TP-born tickets by their TP number', () => {
    expect(ticketRef({ origin: 'ticketpulse', nativeNumber: 12 })).toBe('TP-12');
    expect(ticketRef({ origin: 'freshservice', freshserviceTicketId: 242259n })).toBe('#242259');
  });
});

describe('window', () => {
  test('first digest covers 24 hours; later ones start where the last left off, capped at 96 hours', async () => {
    let w = await service.window(1, NOW);
    expect(NOW - w.since).toBe(24 * 3600e3);
    settings.set(digestLastSentKey(1), '2026-09-25T15:05:00.000Z'); // Friday's digest
    w = await service.window(1, NOW);
    expect(w.since.toISOString()).toBe('2026-09-25T15:05:00.000Z');
    settings.set(digestLastSentKey(1), '2026-09-01T00:00:00.000Z');
    w = await service.window(1, NOW);
    expect(NOW - w.since).toBe(96 * 3600e3);
  });
});

describe('buildDigest', () => {
  test('lists AI closes, the held ones, and summarizes rule closes by rule', async () => {
    prismaMock.assignmentPipelineRun.findMany
      .mockResolvedValueOnce([
        aiRun(1),
        aiRun(2, { triggerSource: 'noise_rule', recommendation: { noiseRuleMatched: 'Synology NAS Alerts' } }),
        aiRun(3, { triggerSource: 'noise_rule', recommendation: { noiseRuleMatched: 'Synology NAS Alerts' } }),
        aiRun(4, { ticket: { ...aiRun(4).ticket, isNoise: false } }),
      ])
      .mockResolvedValueOnce([aiRun(9, { errorMessage: 'Noise close held: HR notice - parked until 2026-10-05 instead of closed.' })]);
    const d = await service.buildDigest(1, { since: new Date(NOW - 864e5), until: NOW });
    expect(d.aiClosed.map((r) => r.ref)).toEqual(['#240001', '#240004']);
    expect(d.aiClosed[1].stillClosed).toBe(false);
    expect(d.held[0].why).toBe('HR notice - parked until 2026-10-05 instead of closed.');
    expect(d.rules).toEqual([{ name: 'Synology NAS Alerts', count: 2 }]);
    expect(d.ruleTotal).toBe(2);
    // Only runs that really closed a ticket count.
    expect(prismaMock.assignmentPipelineRun.findMany.mock.calls[0][0].where).toMatchObject({ decision: 'noise_dismissed', syncStatus: 'synced', workspaceId: 1 });
  });
});

describe('renderHtml', () => {
  test('links each close to its run with ?reopen=1, escapes subjects, and keeps Outlook-safe colour bands', () => {
    const html = service.renderHtml({
      since: new Date(NOW - 864e5), until: NOW,
      aiClosed: [{ runId: 7, ref: '#1', subject: '<script>x</script>', requester: 'A', reason: 'r', stillClosed: true }],
      held: [], rules: [], ruleTotal: 0,
    }, { workspaceName: 'IT', baseUrl: 'https://ticketpulse.example' });
    expect(html).toContain('https://ticketpulse.example/assignments/run/7?reopen=1');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/gradient/i);
    expect(html).toContain('bgcolor="#1e3a8a"');
  });
});

describe('sendDigests', () => {
  test('sends to the workspace admins and records the send', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValueOnce([aiRun(1)]).mockResolvedValueOnce([]);
    const out = await service.sendDigests({ now: NOW });
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 1, to: ['admin@bgc.ca'], label: 'noise-close-digest', subject: 'Ticket Pulse: 1 closed as noise - IT',
    }));
    expect(out).toEqual([expect.objectContaining({ workspaceId: 1, sent: true, aiClosed: 1 })]);
    expect(settings.get(digestLastSentKey(1))).toBe(NOW.toISOString());
  });

  test('quiet when there is nothing to report (rule closes alone do not send)', async () => {
    prismaMock.assignmentPipelineRun.findMany
      .mockResolvedValueOnce([aiRun(2, { triggerSource: 'noise_rule', recommendation: { noiseRuleMatched: 'X' } })])
      .mockResolvedValueOnce([]);
    const out = await service.sendDigests({ now: NOW });
    expect(sendMock).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ skipped: 'nothing_to_report' });
  });

  test('a failed send does not move the window', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValueOnce([aiRun(1)]).mockResolvedValueOnce([]);
    sendMock.mockResolvedValueOnce({ sent: false, reason: 'no lane' });
    await service.sendDigests({ now: NOW });
    expect(settings.has(digestLastSentKey(1))).toBe(false);
  });

  test('per-workspace switch, kill switch and sandbox workspaces', async () => {
    settings.set(digestEnabledKey(1), 'false');
    expect(await service.sendDigests({ now: NOW })).toEqual([]);
    process.env.NOISE_CLOSE_DIGEST = 'false';
    settings.clear();
    expect(await service.sendDigests({ now: NOW })).toEqual([]);
    delete process.env.NOISE_CLOSE_DIGEST;
    await service.sendDigests({ now: NOW });
    expect(prismaMock.assignmentConfig.findMany.mock.calls.at(-1)[0].where).toMatchObject({ autoCloseNoise: true, workspaceId: { notIn: [6, 7, 8] } });
  });
});

describe('reopenAndRoute', () => {
  const actor = { name: 'Coordinator', email: 'c@bgc.ca' };

  test('FS-born: reopens through FreshService, clears the noise flag, routes', async () => {
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue({ id: 5, workspaceId: 1, ticketId: 50, decision: 'noise_dismissed' });
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 50, origin: 'freshservice', freshserviceTicketId: 242259n, status: 'Closed' });
    statusServiceMock.baseStatusOf.mockResolvedValue('Closed');
    const r = await service.reopenAndRoute(5, 1, actor);
    expect(r).toEqual({ ticketId: 50, reopened: true, routing: true });
    expect(ticketServiceMock.updateFsTicket).toHaveBeenCalledWith(50, 1, { status: 'Open' }, actor);
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
    expect(ticketServiceMock.setNoise).toHaveBeenCalledWith(50, 1, { noise: false }, actor);
    expect(pipelineMock.runPipeline).toHaveBeenCalledWith(50, 1, 'manual');
  });

  test('TP-born: reopens locally', async () => {
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue({ id: 5, workspaceId: 1, ticketId: 51, decision: 'noise_dismissed' });
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 51, origin: 'ticketpulse', freshserviceTicketId: null, status: 'Resolved' });
    statusServiceMock.baseStatusOf.mockResolvedValue('Resolved');
    await service.reopenAndRoute(5, 1, actor);
    expect(ticketServiceMock.changeStatus).toHaveBeenCalledWith(51, 1, 'Open', actor);
  });

  test('an already-open ticket is not re-opened, only un-flagged and routed', async () => {
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue({ id: 5, workspaceId: 1, ticketId: 52, decision: 'noise_dismissed' });
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 52, origin: 'freshservice', freshserviceTicketId: 1n, status: 'Open' });
    statusServiceMock.baseStatusOf.mockResolvedValue('Open');
    expect(await service.reopenAndRoute(5, 1, actor)).toMatchObject({ reopened: false });
    expect(ticketServiceMock.updateFsTicket).not.toHaveBeenCalled();
    expect(ticketServiceMock.setNoise).toHaveBeenCalled();
  });

  test('refuses another workspace\'s run and runs that did not close as noise', async () => {
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValueOnce({ id: 5, workspaceId: 2, ticketId: 50, decision: 'noise_dismissed' });
    await expect(service.reopenAndRoute(5, 1, actor)).rejects.toThrow(/not found/);
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValueOnce({ id: 5, workspaceId: 1, ticketId: 50, decision: 'auto_assigned' });
    await expect(service.reopenAndRoute(5, 1, actor)).rejects.toThrow(/closed its ticket as noise/);
    expect(pipelineMock.runPipeline).not.toHaveBeenCalled();
  });
});
