import { jest } from '@jest/globals';

/**
 * Backtests: resolved tickets that match the playbook (not yet backtested),
 * a cost estimate from history or list price, confirm-then-queue with
 * concurrency 2 and one backtest per workspace, trigger 'backtest' on every
 * run, a cost cap stops the batch, results read back from the database.
 */
const prismaMock = {
  ticket: { findMany: jest.fn() },
  autoHelpRun: { findMany: jest.fn(), groupBy: jest.fn() },
};
const playbookMock = { get: jest.fn() };
const runnerMock = { runForTicket: jest.fn(), budgetState: jest.fn() };
const resolverMock = { resolveAttempts: jest.fn() };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../src/services/autoHelpRunner.js', () => ({ default: runnerMock }));
jest.unstable_mockModule('../src/services/aiProviders/providerModelResolver.js', () => ({ default: resolverMock }));
const { explainMatch } = await import('../src/services/autoHelpPlaybookService.js').catch(() => ({}));
jest.unstable_mockModule('../src/services/autoHelpPlaybookService.js', () => ({
  default: playbookMock,
  explainMatch: explainMatch || ((pb, t) => ({ matches: /install/i.test(t.subject) })),
}));
jest.unstable_mockModule('../src/services/tokenUsageService.js', () => ({
  costUsdFor: ({ inputTokens, outputTokens }) => (inputTokens * 3 + outputTokens * 15) / 1e6,
}));

const { AutoHelpBacktestService, BACKTEST_TRIGGER, clampN, MAX_N, STALE_MS } = await import('../src/services/autoHelpBacktestService.js');

/**
 * The shared lease (app_settings in production: PgBacktestJobStore, whose SQL
 * is exercised against a real Postgres by hand — see the service header),
 * in memory here with the same rules: claim wins only when no job is running
 * or its heartbeat is stale; heartbeat writes only for the owner and returns
 * a cancel flag set by anyone.
 */
class MemoryLease {
  constructor() { this.rows = new Map(); this.now = () => Date.now(); }
  async claim(ws, job, staleMs) {
    const cur = this.rows.get(ws);
    if (cur && cur.value.status === 'running' && this.now() - cur.at < staleMs) return false;
    this.rows.set(ws, { value: JSON.parse(JSON.stringify(job)), at: this.now() });
    return true;
  }
  async heartbeat(ws, job) {
    const cur = this.rows.get(ws);
    if (!cur || cur.value.id !== job.id) return { owned: false, cancelRequested: false };
    const cancelRequested = Boolean(cur.value.cancelRequested);
    this.rows.set(ws, { value: { ...JSON.parse(JSON.stringify(job)), cancelRequested }, at: this.now() });
    return { owned: true, cancelRequested };
  }
  async read(ws) {
    const cur = this.rows.get(ws);
    return cur ? { ...cur.value, heartbeatAt: new Date(cur.at) } : null;
  }
  async requestCancel(ws) {
    const cur = this.rows.get(ws);
    if (!cur || cur.value.status !== 'running') return null;
    cur.value.cancelRequested = true;
    return cur.value;
  }
  async release(ws, id) {
    if (this.rows.get(ws)?.value.id === id) this.rows.delete(ws);
  }
}

const PLAYBOOK = {
  id: 3, name: 'Software installs', enabled: false, categoryId: 10, subcategoryIds: [101], version: 2,
  match: { keywords: ['install'], excludeKeywords: [] },
};
const T = (id, subject) => ({
  id, subject, descriptionText: '', status: 'Resolved', resolvedAt: new Date(2026, 8, 30 - id), internalCategoryId: 10,
  internalSubcategoryId: 101, origin: 'ticketpulse', nativeNumber: id, freshserviceTicketId: null,
});
const TICKETS = [T(1, 'Install Revit'), T(2, 'Printer broken'), T(3, 'Install Bluebeam'), T(4, 'Please install GeoStudio'), T(5, 'Install Office')];
const flush = () => new Promise((r) => setTimeout(r, 0));

let svc;
let lease;
const makeService = () => {
  const s = new AutoHelpBacktestService();
  s.runner = runnerMock;
  s.store = lease;
  return s;
};
beforeEach(() => {
  jest.clearAllMocks();
  lease = new MemoryLease();
  svc = makeService();
  playbookMock.get.mockResolvedValue(PLAYBOOK);
  prismaMock.ticket.findMany.mockResolvedValue(TICKETS);
  prismaMock.autoHelpRun.findMany.mockImplementation(async ({ where }) => {
    if (where.trigger === BACKTEST_TRIGGER && where.ticketId) return [{ ticketId: 5 }]; // already backtested
    if (where.costUsd) return [];
    return [];
  });
  prismaMock.autoHelpRun.groupBy.mockResolvedValue([]);
  runnerMock.budgetState.mockResolvedValue({ capUsd: null, spentUsd: 0, exhausted: false });
  resolverMock.resolveAttempts.mockResolvedValue({ attempts: [{ provider: 'anthropic', model: 'claude-sonnet-5' }] });
  runnerMock.runForTicket.mockImplementation(async (id) => ({ id: 900 + id, status: id === 3 ? 'not_answerable' : 'drafted' }));
});

test('candidates: resolved, in the playbook category, matching its keywords (even when switched off), not yet backtested', async () => {
  const out = await svc.candidates(1, 3, { n: 10 });
  expect(out.tickets.map((t) => t.id)).toEqual([1, 3, 4]);
  expect(out.alreadyBacktested).toBe(1);
  const q = prismaMock.ticket.findMany.mock.calls[0][0];
  expect(q.where).toMatchObject({ workspaceId: 1, internalCategoryId: 10, internalSubcategoryId: { in: [101] }, isNoise: false, resolvedAt: { not: null } });
  expect(q.orderBy).toEqual({ resolvedAt: 'desc' });
  expect(q.take).toBeLessThanOrEqual(400);
  expect(q.select.photoUrl).toBeUndefined();
});

test('N defaults to 20 and is capped at 50', () => {
  expect(clampN(undefined)).toBe(20);
  expect(clampN(500)).toBe(MAX_N);
  expect(clampN(3)).toBe(3);
});

test('estimate from the model list price when there is no history; from history when there is', async () => {
  let est = await svc.estimate(1, 3, { n: 20 });
  expect(est).toMatchObject({ count: 3, basis: 'model_price', model: 'claude-sonnet-5' });
  expect(est.perRunUsd).toBeCloseTo((12000 * 3 + 1200 * 15) / 1e6, 4);
  expect(est.totalUsd).toBeCloseTo(est.perRunUsd * 3, 4);
  prismaMock.autoHelpRun.findMany.mockImplementation(async ({ where }) => (where.costUsd ? [{ costUsd: 0.01 }, { costUsd: 0.03 }, { costUsd: 0.02 }] : []));
  runnerMock.budgetState.mockResolvedValue({ capUsd: 0.05, spentUsd: 0.04 });
  est = await svc.estimate(1, 3, { n: 20 });
  expect(est).toMatchObject({ basis: 'history', perRunUsd: 0.02, sampleRuns: 3 });
  expect(est.budget).toMatchObject({ remainingUsd: 0.01, mayStop: true });
});

test('start queues every ticket with trigger "backtest", at most 2 at a time, and reports progress', async () => {
  let active = 0;
  let peak = 0;
  runnerMock.runForTicket.mockImplementation(async (id, opts) => {
    active += 1;
    peak = Math.max(peak, active);
    await flush();
    active -= 1;
    return { id: 900 + id, status: id === 3 ? 'not_answerable' : 'drafted', trigger: opts.trigger };
  });
  const job = await svc.start(1, 3, { n: 20, actor: { email: 'a@x' } });
  expect(job).toMatchObject({ status: 'running', total: 3, done: 0, playbookName: 'Software installs' });
  for (let i = 0; i < 10 && (await svc.status(1)).status === 'running'; i += 1) await flush();
  const done = await svc.status(1);
  expect(done).toMatchObject({ status: 'done', done: 3, counts: { drafted: 2, not_answerable: 1, failed: 0, other: 0 } });
  expect(done.items.map((i) => i.runId)).toEqual([901, 903, 904]);
  expect(peak).toBe(2);
  for (const call of runnerMock.runForTicket.mock.calls) {
    expect(call[1]).toMatchObject({ trigger: 'backtest', playbookId: 3, workspaceId: 1 });
  }
});

test('one backtest per workspace at a time', async () => {
  let release;
  runnerMock.runForTicket.mockImplementation(() => new Promise((r) => { release = r; }));
  await svc.start(1, 3, { n: 1 });
  await expect(svc.start(1, 3, { n: 1 })).rejects.toThrow(/already running/);
  // another workspace is independent
  await expect(svc.start(2, 3, { n: 1 })).resolves.toMatchObject({ status: 'running' });
  release({ id: 1, status: 'drafted' });
});

test('the monthly cost cap stops the batch; cancel stops scheduling more', async () => {
  runnerMock.runForTicket.mockImplementation(async (id) => {
    if (id === 1) { const e = new Error('cap reached'); e.code = 'auto_help_budget_exhausted'; throw e; }
    return { id: 900 + id, status: 'drafted' };
  });
  svc.concurrency = 1;
  await svc.start(1, 3, { n: 20 });
  for (let i = 0; i < 10 && !(await svc.status(1)).finishedAt; i += 1) await flush();
  const job = await svc.status(1);
  expect(job.status).toBe('stopped');
  expect(job.error).toMatch(/cap reached/);
  expect(job.items.filter((i) => i.state === 'not_run')).toHaveLength(2);

  svc.jobs.clear();
  lease.rows.clear();
  let release;
  runnerMock.runForTicket.mockImplementation(() => new Promise((r) => { release = () => r({ id: 1, status: 'drafted' }); }));
  await svc.start(1, 3, { n: 20 });
  expect((await svc.cancel(1)).cancelling).toBe(true);
  release();
  for (let i = 0; i < 10 && (await svc.status(1)).status === 'running'; i += 1) await flush();
  expect(await svc.status(1)).toMatchObject({ status: 'cancelled', done: 1 });
});

test('nothing to backtest -> clear errors, lock released', async () => {
  prismaMock.ticket.findMany.mockResolvedValue([T(2, 'Printer broken')]);
  await expect(svc.start(1, 3, {})).rejects.toThrow(/No resolved tickets match/);
  expect(await svc.status(1)).toBeNull();
  expect(lease.rows.size).toBe(0); // the lease was given back
  playbookMock.get.mockResolvedValue({ ...PLAYBOOK, categoryId: null });
  await expect(svc.candidates(1, 3)).rejects.toThrow(/category first/);
});

test('results read the backtest runs back with counts', async () => {
  prismaMock.autoHelpRun.findMany.mockResolvedValue([{ id: 901, ticketId: 1, status: 'drafted', gateDecision: 'shadow_recorded', confidence: 0.9, reviewVerdict: 'good', createdAt: new Date() }]);
  prismaMock.autoHelpRun.groupBy
    .mockResolvedValueOnce([{ status: 'drafted', _count: { _all: 4 } }, { status: 'not_answerable', _count: { _all: 2 } }])
    .mockResolvedValueOnce([{ reviewVerdict: 'good', _count: { _all: 3 } }, { reviewVerdict: 'wrong', _count: { _all: 1 } }]);
  prismaMock.ticket.findMany.mockResolvedValue([{ id: 1, subject: 'Install Revit', origin: 'ticketpulse', nativeNumber: 1, freshserviceTicketId: null }]);
  const out = await svc.results(1, 3);
  expect(out.counts).toEqual({ total: 6, drafted: 4, notAnswerable: 2, failed: 0, reviewed: 4, good: 3 });
  expect(out.runs[0]).toMatchObject({ id: 901, ticketRef: 'TP-1', ticketSubject: 'Install Revit' });
  expect(prismaMock.autoHelpRun.findMany.mock.calls[0][0].where).toEqual({ workspaceId: 1, playbookId: 3, trigger: 'backtest' });
});

describe('lease across containers and restarts', () => {
  const waitDone = async (service, ws = 1) => {
    for (let i = 0; i < 30 && (await service.status(ws))?.status === 'running'; i += 1) await flush();
    return service.status(ws);
  };

  test('two containers: the second start is refused while the first runs, and sees its progress', async () => {
    let release;
    runnerMock.runForTicket.mockImplementation(() => new Promise((r) => { release = () => r({ id: 1, status: 'drafted' }); }));
    const a = makeService();
    const b = makeService();
    await a.start(1, 3, { n: 1 });
    await expect(b.start(1, 3, { n: 1 })).rejects.toThrow(/already running/);
    expect(await b.status(1)).toMatchObject({ status: 'running', playbookName: 'Software installs', total: 1 });
    // Both clicking at once: only one claim wins.
    lease.rows.clear();
    a.jobs.clear();
    const both = await Promise.allSettled([makeService().start(2, 3, { n: 1 }), makeService().start(2, 3, { n: 1 })]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    release();
  });

  test('progress is persisted after every ticket, so another container reports it', async () => {
    runnerMock.runForTicket.mockImplementation(async (id) => ({ id: 900 + id, status: 'drafted' }));
    await svc.start(1, 3, { n: 20 });
    await waitDone(svc);
    const other = makeService();
    expect(await other.status(1)).toMatchObject({ status: 'done', done: 3, total: 3, counts: { drafted: 3 } });
  });

  test('cancel from another container reaches the driver through the heartbeat', async () => {
    svc.concurrency = 1;
    const releases = [];
    runnerMock.runForTicket.mockImplementation(() => new Promise((r) => { releases.push(() => r({ id: 1, status: 'drafted' })); }));
    await svc.start(1, 3, { n: 20 });
    await flush();
    const other = makeService();
    expect((await other.cancel(1))?.cancelling).toBe(true);
    releases.shift()();
    const done = await waitDone(svc);
    expect(done).toMatchObject({ status: 'cancelled', done: 1 });
    expect(runnerMock.runForTicket).toHaveBeenCalledTimes(1);
  });

  test('a restart leaves a stale lease: reported "interrupted", and a new start takes over', async () => {
    runnerMock.runForTicket.mockImplementation(() => new Promise(() => {})); // the old container never finishes
    await svc.start(1, 3, { n: 20 });
    const t0 = Date.now();
    lease.now = () => t0 + STALE_MS - 1000;
    const restarted = makeService();
    expect(await restarted.status(1)).toMatchObject({ status: 'running' });
    await expect(restarted.start(1, 3, { n: 20 })).rejects.toThrow(/already running/);
    lease.now = () => t0 + STALE_MS + 1000;
    restarted.staleMs = STALE_MS;
    const realNow = Date.now;
    Date.now = () => t0 + STALE_MS + 1000;
    try {
      expect(await restarted.status(1)).toMatchObject({ status: 'interrupted', error: expect.stringMatching(/restarted/) });
    } finally {
      Date.now = realNow;
    }
    runnerMock.runForTicket.mockImplementation(async (id) => ({ id: 900 + id, status: 'drafted' }));
    await expect(restarted.start(1, 3, { n: 20 })).resolves.toMatchObject({ status: 'running' });
  });

  test('a driver whose lease was taken over stops scheduling more tickets', async () => {
    svc.concurrency = 1;
    const releases = [];
    runnerMock.runForTicket.mockImplementation(() => new Promise((r) => { releases.push(() => r({ id: 1, status: 'drafted' })); }));
    await svc.start(1, 3, { n: 20 });
    await flush();
    lease.rows.set(1, { value: { id: 'someone-else', status: 'running' }, at: Date.now() });
    releases.shift()();
    for (let i = 0; i < 10 && svc.jobs.get(1).status === 'running'; i += 1) await flush();
    expect(svc.jobs.get(1).status).toBe('interrupted');
    expect(runnerMock.runForTicket).toHaveBeenCalledTimes(1);
    expect(lease.rows.get(1).value.id).toBe('someone-else'); // never overwritten
  });

  test('the lease being unavailable refuses to start (no unguarded run)', async () => {
    lease.claim = async () => { throw new Error('db down'); };
    await expect(svc.start(1, 3, { n: 1 })).rejects.toThrow(/lock is unavailable/);
    expect(runnerMock.runForTicket).not.toHaveBeenCalled();
  });
});
