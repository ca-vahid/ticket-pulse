import { jest } from '@jest/globals';

/**
 * Alert correlation (20 Sep 2026): pair rules + storm grouping for machine
 * alerts. These pin the airtight ordering — the human always wins on the
 * fired side, a fired with no cleared is never touched, vetoes win over rules,
 * dry runs write nothing.
 */

const prismaMock = {
  alertCorrelationRule: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn() },
  ticketLink: { findFirst: jest.fn(), upsert: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn() },
  ticketActivity: { findFirst: jest.fn(), findMany: jest.fn() },
  assignmentPipelineRun: { updateMany: jest.fn(), create: jest.fn() },
  ticketStatusDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  $queryRaw: jest.fn().mockResolvedValue([]),
};
const ticketServiceMock = { addPrivateNote: jest.fn(), changeStatus: jest.fn(), updateFsTicket: jest.fn() };
const linkServiceMock = { setParent: jest.fn() };
const noiseMock = { evaluateNeverNoise: jest.fn().mockResolvedValue({ vetoed: false }) };
const activityMock = { create: jest.fn().mockResolvedValue({}) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/ticketLinkService.js', () => ({ default: linkServiceMock }));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: noiseMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const svc = (await import('../src/services/alertCorrelationService.js')).default;
const { matchKey, compileRule, validateRuleInput, STARTER_RULES, humanMinutes } = await import('../src/services/alertCorrelationService.js');

const azureRule = {
  id: 1, workspaceId: 1, name: 'Azure Monitor alerts (Fired / Resolved)', isEnabled: true,
  senderPattern: '^azure-noreply@microsoft\\.com$',
  firedPattern: '^Fired:Sev\\d+ Azure Monitor Alert (?<key>.+?) \\(',
  clearedPattern: '^Resolved:Sev\\d+ Azure Monitor Alert (?<key>.+?) \\(',
  followupPattern: null, pairWindowMinutes: 360, pairAction: 'resolve', orphanClearedAction: 'resolve',
  stormEnabled: true, stormWindowMinutes: 60, stormMinCount: 3, resolutionReason: 'benign_expected', skipAi: true,
};
const t = (id, subject, over = {}) => ({
  id, workspaceId: 1, subject, status: 'Open', origin: 'freshservice', createdAt: new Date('2026-09-19T12:00:00Z'), assignedTechId: null,
  freshserviceTicketId: 243000 + id, nativeNumber: null, triageMode: null, category: null, descriptionText: '', description: '',
  requester: { email: 'azure-noreply@microsoft.com' }, internalCategory: null, ...over,
});
const FIRED = 'Fired:Sev3 Azure Monitor Alert vm availability - bgc-azu-instr-suncor on bgc-azu-instr-suncor ( microsoft.compute/virtualmachines ) at 9/19/2026 4:57:03 AM';
const RESOLVED = 'Resolved:Sev3 Azure Monitor Alert vm availability - bgc-azu-instr-suncor on bgc-azu-instr-suncor ( microsoft.compute/virtualmachines ) at 9/19/2026 5:12:03 AM';

beforeEach(() => {
  jest.clearAllMocks();
  svc._ruleCache.clear();
  prismaMock.alertCorrelationRule.findMany.mockResolvedValue([azureRule]);
  prismaMock.alertCorrelationRule.update.mockResolvedValue({});
  prismaMock.ticketLink.findFirst.mockResolvedValue(null);
  prismaMock.ticketLink.upsert.mockResolvedValue({});
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.ticketActivity.findFirst.mockResolvedValue(null);
  prismaMock.assignmentPipelineRun.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.ticketStatusDefinition.findMany.mockResolvedValue([]);
  ticketServiceMock.addPrivateNote.mockResolvedValue({});
  ticketServiceMock.changeStatus.mockResolvedValue({});
  ticketServiceMock.updateFsTicket.mockResolvedValue({});
  noiseMock.evaluateNeverNoise.mockResolvedValue({ vetoed: false });
});

describe('patterns', () => {
  test('matchKey reads the named key and ignores the timestamp that differs between Fired and Resolved', () => {
    const c = compileRule(azureRule);
    expect(matchKey(c.fired, FIRED).key).toBe('vm availability - bgc-azu-instr-suncor on bgc-azu-instr-suncor');
    expect(matchKey(c.cleared, RESOLVED).key).toBe(matchKey(c.fired, FIRED).key);
    expect(matchKey(c.fired, 'Something else')).toBeNull();
  });
  test('without a key group the key is the subject minus the matched prefix', () => {
    const re = /^ON - /i;
    expect(matchKey(re, 'ON - BGC-VAN-INSTR2 - Data Feed Outage').key).toBe('bgc-van-instr2 - data feed outage');
  });
  test('the starter rules all compile and every fired/cleared pattern shares a key', () => {
    for (const r of STARTER_RULES) {
      const c = compileRule({ ...r, id: 0 });
      expect(c).not.toBeNull();
    }
  });
  test('validateRuleInput refuses a bad regex, unknown actions and out-of-range windows', () => {
    expect(() => validateRuleInput({ name: 'x', senderPattern: '(', firedPattern: 'a' })).toThrow(/senderPattern/);
    expect(() => validateRuleInput({ name: 'x', senderPattern: 'a', firedPattern: 'b', pairAction: 'nuke' })).toThrow(/pairAction/);
    expect(() => validateRuleInput({ name: 'x', senderPattern: 'a', firedPattern: 'b', pairWindowMinutes: 0 })).toThrow(/pairWindowMinutes/);
    expect(validateRuleInput({ name: 'x', senderPattern: 'a', firedPattern: 'b', stormMinCount: 4, isEnabled: true })).toMatchObject({ stormMinCount: 4, isEnabled: true });
  });
  test('humanMinutes', () => {
    expect(humanMinutes(15)).toBe('15 min');
    expect(humanMinutes(90)).toBe('1.5 h');
    expect(humanMinutes(3 * 1440)).toBe('3 d');
  });
});

describe('pairing', () => {
  test('a Resolved arriving after its Fired links, notes and resolves both, and supersedes their queued AI runs', async () => {
    const fired = t(10, FIRED, { createdAt: new Date('2026-09-19T11:57:00Z') });
    const cleared = t(11, RESOLVED, { createdAt: new Date('2026-09-19T12:12:00Z') });
    prismaMock.ticket.findFirst.mockResolvedValue(cleared);
    prismaMock.ticket.findMany.mockResolvedValue([fired, cleared]);
    const res = await svc.evaluateTicket(11, 1, { triggerSource: 'webhook' });
    expect(res).toMatchObject({ handled: true, kind: 'pair', skipAi: true });
    expect(res.pair).toMatchObject({ firedId: 10, clearedId: 11, gapMinutes: 15, touched: false, firedTerminal: false });
    expect(prismaMock.ticketLink.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ ticketId: 10, relatedTicketId: 11, kind: 'cleared_by' }) }));
    // FS-born → FreshService write-back, both tickets
    expect(ticketServiceMock.updateFsTicket).toHaveBeenCalledTimes(2);
    expect(ticketServiceMock.updateFsTicket.mock.calls.map((c) => c[0]).sort()).toEqual([10, 11]);
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
    expect(ticketServiceMock.addPrivateNote).toHaveBeenCalledTimes(2);
    expect(prismaMock.assignmentPipelineRun.updateMany).toHaveBeenCalledTimes(2);
    expect(activityMock.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.alertCorrelationRule.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ matchCount: { increment: 1 } }) }));
  });

  test('a TP-born pair resolves through changeStatus with the rule reason', async () => {
    const fired = t(10, FIRED, { origin: 'ticketpulse', nativeNumber: 1600, createdAt: new Date('2026-09-19T11:57:00Z') });
    const cleared = t(11, RESOLVED, { origin: 'ticketpulse', nativeNumber: 1601, createdAt: new Date('2026-09-19T12:12:00Z') });
    prismaMock.ticket.findFirst.mockResolvedValue(cleared);
    prismaMock.ticket.findMany.mockResolvedValue([fired, cleared]);
    await svc.evaluateTicket(11, 1);
    expect(ticketServiceMock.changeStatus).toHaveBeenCalledWith(10, 1, 'Resolved', expect.objectContaining({ role: 'system' }), expect.objectContaining({ resolutionReason: 'benign_expected' }));
    expect(ticketServiceMock.changeStatus).toHaveBeenCalledWith(11, 1, 'Resolved', expect.anything(), expect.anything());
  });

  test('a person on the fired ticket wins: link + note only, the fired status is untouched, the cleared still resolves', async () => {
    const fired = t(10, FIRED, { createdAt: new Date('2026-09-19T11:57:00Z') });
    const cleared = t(11, RESOLVED, { createdAt: new Date('2026-09-19T12:12:00Z') });
    prismaMock.ticket.findFirst.mockResolvedValue(cleared);
    prismaMock.ticket.findMany.mockResolvedValue([fired, cleared]);
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ id: 5 }); // an agent wrote on it
    const res = await svc.evaluateTicket(11, 1);
    expect(res.pair.touched).toBe(true);
    expect(ticketServiceMock.updateFsTicket).toHaveBeenCalledTimes(1);
    expect(ticketServiceMock.updateFsTicket.mock.calls[0][0]).toBe(11);
    expect(res.actions.some((a) => a.type === 'left_to_person' && a.ticketId === 10)).toBe(true);
  });

  test('a fired ticket someone already closed keeps that status; the clear notice is filed against it and resolved', async () => {
    const fired = t(10, FIRED, { status: 'Closed', createdAt: new Date('2026-09-19T11:57:00Z') });
    const cleared = t(11, RESOLVED, { createdAt: new Date('2026-09-19T12:12:00Z') });
    prismaMock.ticket.findFirst.mockResolvedValue(cleared);
    prismaMock.ticket.findMany.mockResolvedValue([fired, cleared]);
    const res = await svc.evaluateTicket(11, 1);
    expect(res.pair.firedTerminal).toBe(true);
    expect(ticketServiceMock.updateFsTicket).toHaveBeenCalledTimes(1);
    expect(ticketServiceMock.updateFsTicket.mock.calls[0][0]).toBe(11);
    expect(prismaMock.ticketLink.upsert).toHaveBeenCalled();
  });

  test('a fired ticket with no clear notice is never touched', async () => {
    const fired = t(10, FIRED);
    prismaMock.ticket.findFirst.mockResolvedValue(fired);
    prismaMock.ticket.findMany.mockResolvedValue([fired]);
    const res = await svc.evaluateTicket(10, 1);
    expect(res).toMatchObject({ handled: false, kind: 'fired' });
    expect(ticketServiceMock.updateFsTicket).not.toHaveBeenCalled();
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
    expect(prismaMock.ticketLink.upsert).not.toHaveBeenCalled();
  });

  test('out-of-order arrival: a Fired that arrives after its Resolved still pairs', async () => {
    const fired = t(10, FIRED, { createdAt: new Date('2026-09-19T11:57:00Z') });
    const cleared = t(11, RESOLVED, { createdAt: new Date('2026-09-19T12:12:00Z') });
    prismaMock.ticket.findFirst.mockResolvedValue(fired);
    prismaMock.ticket.findMany.mockResolvedValue([fired, cleared]);
    const res = await svc.evaluateTicket(10, 1);
    expect(res).toMatchObject({ handled: true, kind: 'pair' });
    expect(res.pair).toMatchObject({ firedId: 10, clearedId: 11 });
  });

  test('a clear notice with nothing to match is an orphan: resolved (or left, per rule)', async () => {
    const cleared = t(11, RESOLVED);
    prismaMock.ticket.findFirst.mockResolvedValue(cleared);
    prismaMock.ticket.findMany.mockResolvedValue([cleared]);
    const res = await svc.evaluateTicket(11, 1);
    expect(res).toMatchObject({ handled: true, kind: 'orphan' });
    expect(ticketServiceMock.updateFsTicket).toHaveBeenCalledWith(11, 1, { status: 'Resolved' }, expect.anything());

    jest.clearAllMocks();
    svc._ruleCache.clear();
    prismaMock.alertCorrelationRule.findMany.mockResolvedValue([{ ...azureRule, orphanClearedAction: 'leave' }]);
    prismaMock.ticket.findFirst.mockResolvedValue(cleared);
    prismaMock.ticket.findMany.mockResolvedValue([cleared]);
    const res2 = await svc.evaluateTicket(11, 1);
    expect(res2.kind).toBe('orphan');
    expect(ticketServiceMock.updateFsTicket).not.toHaveBeenCalled();
  });

  test('trusted intake vetoes everything; a never_noise rule vetoes orphan resolves but not a pair the platform itself cleared', async () => {
    const fired = t(10, FIRED, { createdAt: new Date('2026-09-19T11:57:00Z') });
    const cleared = t(11, RESOLVED, { createdAt: new Date('2026-09-19T12:12:00Z') });
    prismaMock.ticket.findFirst.mockResolvedValue(cleared);
    prismaMock.ticket.findMany.mockResolvedValue([fired, cleared]);
    noiseMock.evaluateNeverNoise.mockResolvedValue({ vetoed: true, ruleName: 'Physical packages & shipping' });
    const res = await svc.evaluateTicket(11, 1);
    expect(res).toMatchObject({ handled: true, kind: 'pair' }); // evidence beats a subject regex
    expect(ticketServiceMock.updateFsTicket).toHaveBeenCalledTimes(2);

    jest.clearAllMocks();
    svc._ruleCache.clear();
    prismaMock.alertCorrelationRule.findMany.mockResolvedValue([azureRule]);
    prismaMock.ticket.findFirst.mockResolvedValue(cleared);
    prismaMock.ticket.findMany.mockResolvedValue([cleared]); // no fired → orphan → the never_noise rule holds it
    noiseMock.evaluateNeverNoise.mockResolvedValue({ vetoed: true, ruleName: 'Physical packages & shipping' });
    const res2 = await svc.evaluateTicket(11, 1);
    expect(res2.handled).toBe(false);
    expect(res2.actions.some((a) => a.type === 'vetoed')).toBe(true);
    expect(ticketServiceMock.updateFsTicket).not.toHaveBeenCalled();

    noiseMock.evaluateNeverNoise.mockResolvedValue({ vetoed: false });
    prismaMock.ticket.findFirst.mockResolvedValue({ ...cleared, triageMode: 'trusted' });
    prismaMock.ticket.findMany.mockResolvedValue([fired, cleared]);
    const res3 = await svc.evaluateTicket(11, 1);
    expect(res3.handled).toBe(false);
    expect(res3.actions[0]).toMatchObject({ type: 'vetoed', reason: 'Trusted intake (credential)' });
  });

  test('a clear notice younger than the grace period is deferred to the sweep, not resolved and not run through the AI', async () => {
    const cleared = t(11, RESOLVED, { createdAt: new Date(Date.now() - 3 * 60000) });
    prismaMock.ticket.findFirst.mockResolvedValue(cleared);
    prismaMock.ticket.findMany.mockResolvedValue([cleared]);
    const res = await svc.evaluateTicket(11, 1);
    expect(res).toMatchObject({ handled: false, defer: true, kind: 'orphan_pending' });
    expect(ticketServiceMock.updateFsTicket).not.toHaveBeenCalled();
  });

  test('a sender the rules do not name is ignored', async () => {
    const other = t(20, FIRED, { requester: { email: 'someone@bgcengineering.ca' } });
    prismaMock.ticket.findFirst.mockResolvedValue(other);
    const res = await svc.evaluateTicket(20, 1);
    expect(res.handled).toBe(false);
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });

  test('dry run writes nothing but reports the same actions', async () => {
    const fired = t(10, FIRED, { createdAt: new Date('2026-09-19T11:57:00Z') });
    const cleared = t(11, RESOLVED, { createdAt: new Date('2026-09-19T12:12:00Z') });
    prismaMock.ticket.findFirst.mockResolvedValue(cleared);
    prismaMock.ticket.findMany.mockResolvedValue([fired, cleared]);
    const session = { links: new Set(), linkedIds: new Set(), children: new Set(), parents: new Map() };
    const res = await svc.evaluateTicket(11, 1, { dryRun: true, session });
    expect(res.kind).toBe('pair');
    expect(res.actions.filter((a) => a.type === 'resolve')).toHaveLength(2);
    expect(prismaMock.ticketLink.upsert).not.toHaveBeenCalled();
    expect(ticketServiceMock.updateFsTicket).not.toHaveBeenCalled();
    expect(ticketServiceMock.addPrivateNote).not.toHaveBeenCalled();
    expect(activityMock.create).not.toHaveBeenCalled();
    expect(prismaMock.alertCorrelationRule.update).not.toHaveBeenCalled();
    // the session remembers the pair so the fired half is not paired twice
    expect(session.links.has('10:11:cleared_by')).toBe(true);
  });
});

describe('storms', () => {
  test('the third fired alert of a family inside the window becomes a child of the first; its AI run is skipped', async () => {
    const a = t(10, FIRED.replace('suncor', 'newafton').replace('suncor', 'newafton'), { createdAt: new Date('2026-09-19T11:57:00Z') });
    const b = t(11, FIRED.replace('suncor', 'hudbay').replace('suncor', 'hudbay'), { createdAt: new Date('2026-09-19T12:01:00Z') });
    const c = t(12, FIRED, { createdAt: new Date('2026-09-19T12:06:00Z') });
    prismaMock.ticket.findFirst.mockImplementation(async ({ where }) => [a, b, c].find((x) => x.id === where.id) || null);
    prismaMock.ticket.findMany.mockResolvedValue([a, b, c]);
    linkServiceMock.setParent.mockResolvedValue({});
    const res = await svc.evaluateTicket(12, 1, { triggerSource: 'webhook' });
    expect(res).toMatchObject({ handled: true, kind: 'storm', skipAi: true });
    expect(res.storm).toMatchObject({ rootId: 10, childId: 12, count: 3 });
    expect(linkServiceMock.setParent).toHaveBeenCalledWith(12, 1, { parentTicketId: 10 }, expect.objectContaining({ role: 'system' }));
    expect(prismaMock.assignmentPipelineRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { ticketId: 12, status: 'queued' } }));
    expect(ticketServiceMock.updateFsTicket).not.toHaveBeenCalled(); // storms never resolve anything
  });

  test('two alerts are not a storm; the second stays a plain fired alert', async () => {
    const a = t(10, FIRED.replace(/suncor/g, 'newafton'), { createdAt: new Date('2026-09-19T11:57:00Z') });
    const b = t(11, FIRED, { createdAt: new Date('2026-09-19T12:01:00Z') });
    prismaMock.ticket.findFirst.mockResolvedValue(b);
    prismaMock.ticket.findMany.mockResolvedValue([a, b]);
    const res = await svc.evaluateTicket(11, 1);
    expect(res).toMatchObject({ handled: false, kind: 'fired' });
    expect(linkServiceMock.setParent).not.toHaveBeenCalled();
  });

  test('the root follows an existing parent link so a storm never nests', async () => {
    const root = t(9, FIRED.replace(/suncor/g, 'root'), { createdAt: new Date('2026-09-19T11:50:00Z') });
    const a = t(10, FIRED.replace(/suncor/g, 'newafton'), { createdAt: new Date('2026-09-19T11:57:00Z') });
    const b = t(11, FIRED.replace(/suncor/g, 'hudbay'), { createdAt: new Date('2026-09-19T12:01:00Z') });
    const c = t(12, FIRED, { createdAt: new Date('2026-09-19T12:06:00Z') });
    prismaMock.ticket.findFirst.mockImplementation(async ({ where }) => [root, a, b, c].find((x) => x.id === where.id) || null);
    prismaMock.ticket.findMany.mockResolvedValue([a, b, c]);
    // a is already a child of root
    prismaMock.ticketLink.findFirst.mockImplementation(async ({ where }) => (where.relatedTicketId === 10 && where.kind === 'parent_of' ? { ticketId: 9 } : null));
    linkServiceMock.setParent.mockResolvedValue({});
    const res = await svc.evaluateTicket(12, 1);
    expect(res.storm.rootId).toBe(9);
    expect(linkServiceMock.setParent).toHaveBeenCalledWith(12, 1, { parentTicketId: 9 }, expect.anything());
  });
});

describe('recordRun', () => {
  test('writes a completed, non-actionable run the assignment page can show', async () => {
    prismaMock.assignmentPipelineRun.create.mockResolvedValue({ id: 77 });
    const run = await svc.recordRun(11, 1, 'webhook', { kind: 'pair', pair: { firedRef: '#243170', clearedRef: '#243182', gapMinutes: 15 } });
    expect(run.id).toBe(77);
    const data = prismaMock.assignmentPipelineRun.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'completed', decision: 'alert_correlated', nonActionable: true, nonActionableReason: 'alert_pair', llmModel: 'alert-correlation' });
    expect(data.recommendation.overallReasoning).toMatch(/#243170 was cleared by #243182 15 min after it fired/);
  });
});
