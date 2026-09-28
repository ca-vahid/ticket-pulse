import { jest } from '@jest/globals';
import { createFakePrisma } from './helpers/fakePrismaStore.js';

/**
 * Auto-help integration W1 + W5 (plans/AUTO_HELP_INTEGRATION_PLAN.md A, C, G):
 * the durable settle-job queue and the settle decisions, on an in-memory
 * database. The runner's model work is stubbed (runForTicket records a run
 * the way the real one does, with the settle facts); staging goes through the
 * REAL delivery service and proposal store.
 */
let db;
// `overrides` lets a test stand in for Postgres-only behaviour (the advisory lock).
const overrides = {};
const prismaProxy = new Proxy({}, { get: (_t, prop) => (prop in overrides ? overrides[prop] : db[prop]) });
const gatewayMock = { runToolTurn: jest.fn(), sendJson: jest.fn() };
const lifecycleMock = { emitTicketEvent: jest.fn(async () => ({})) };
const ticketServiceMock = { addPrivateNote: jest.fn(async () => ({ entry: { id: 1 } })), addReply: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaProxy }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: gatewayMock }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ ...lifecycleMock, default: lifecycleMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { resolveBaseStatus: jest.fn(async (_ws, s) => (['Resolved', 'Closed', 'Pending'].includes(s) ? s : 'Open')) },
}));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => false,
  embedQueryTexts: jest.fn(async () => null),
  cosineSimilarity: () => 0,
  nearestVerifiedSolutions: jest.fn(async () => ({ cosById: new Map(), topIds: [] })),
}));
jest.unstable_mockModule('../src/services/ticketSimilaritySearchService.js', () => ({ default: { search: jest.fn() } }));

const { default: runner, settleFacts } = await import('../src/services/autoHelpRunner.js');
const { default: delivery } = await import('../src/services/autoHelpDeliveryService.js');
const {
  default: intake, AutoHelpIntakeService, dedupeKeyFor, verdictSkipCode, backoffMs, JOB_MAX_ATTEMPTS,
  JOB_RETENTION_MS, CATCH_UP_CREATED_LOOKBACK_MS, CATCH_UP_BATCH,
} = await import('../src/services/autoHelpIntakeService.js');
const { setAutoHelpEventEmitter } = await import('../src/services/autoHelpEvents.js');

const ANSWER = { html: '<ol><li>Open Company Portal.</li></ol>', text: '1. Open Company Portal.' };
const PLAYBOOK = { id: 3, workspaceId: 1, name: 'Software installs', enabled: true, mode: 'approve', sensitive: false, minConfidence: 0.8, version: 2, followUp: null };
const events = [];

function seed({ mode = 'approve', categoryId = 10, subcategoryId = 101 } = {}) {
  db = createFakePrisma({
    workspace: [{ id: 1, name: 'IT', defaultTimezone: 'America/Vancouver' }],
    autoHelpSettings: [{ workspaceId: 1, enabled: true, approveModeEnabled: true, disclosureEnabled: true }],
    autoHelpPlaybook: [{ ...PLAYBOOK, mode }],
    competencyCategory: [
      { id: 10, workspaceId: 1, name: 'Software & Apps' }, { id: 101, workspaceId: 1, name: 'Installation' },
      { id: 20, workspaceId: 1, name: 'Hardware' }, { id: 201, workspaceId: 1, name: 'Laptop' },
    ],
    ticket: [{
      id: 55, workspaceId: 1, origin: 'ticketpulse', status: 'Open', subject: 'Install Bluebeam please', requesterId: 7,
      internalCategoryId: categoryId, internalSubcategoryId: subcategoryId, fsApprovalStatus: null, replyOwner: null, replyOwnerRef: null,
      firstPublicAgentReplyAt: null,
    }],
  });
  // auto_help_jobs.dedupe_key is UNIQUE in the database.
  const jobModel = db.autoHelpJob;
  const create = jobModel.create;
  jobModel.create = async (args) => {
    if (db._rows('autoHelpJob').some((j) => j.dedupeKey === args.data.dedupeKey)) {
      const err = new Error('Unique constraint failed on dedupe_key');
      err.code = 'P2002';
      throw err;
    }
    return create(args);
  };
  // ticket_proposed_replies.status defaults to 'proposed' in the database.
  const proposalModel = db.ticketProposedReply;
  const createProposal = proposalModel.create;
  proposalModel.create = async (args) => createProposal({ ...args, data: { status: 'proposed', ...args.data } });
}

const rows = (n) => db._rows(n);
let runCalls;
/** Restore a working job insert (unique dedupe key) after a test broke it. */
function seedJobCreate() {
  const base = createFakeJobCreate();
  db.autoHelpJob.create = base;
}
function createFakeJobCreate() {
  return async ({ data }) => {
    if (rows('autoHelpJob').some((j) => j.dedupeKey === data.dedupeKey)) { const e = new Error('dupe'); e.code = 'P2002'; throw e; }
    const row = { id: rows('autoHelpJob').length + 1, createdAt: new Date(), ...data };
    rows('autoHelpJob').push(row);
    return { ...row };
  };
}

/** runForTicket as the real runner records it: settle facts on the run, approve → staged through delivery. */
async function fakeRunForTicket(ticketId, { workspaceId, settle = null, allowRerun = false } = {}) {
  runCalls.push({ ticketId, settle, allowRerun });
  const ticket = await db.ticket.findFirst({ where: { id: ticketId } });
  const pb = rows('autoHelpPlaybook')[0];
  let run = await db.autoHelpRun.create({
    data: {
      workspaceId, ticketId, playbookId: pb.id, playbookVersion: pb.version, mode: pb.mode, trigger: 'categorized', status: 'drafted',
      gateDecision: 'shadow_recorded', confidence: 0.9, draftSubject: 'Installing Bluebeam', transcript: { body: ANSWER },
      outcomeDetail: settle ? { settle: settleFacts(settle, ticket) } : null, decision: null, outcome: null, proposedReplyId: null,
    },
  });
  if (pb.mode === 'approve') {
    const staged = await delivery.stageRun({
      run, ticket, playbook: pb, settings: { enabled: true, approveModeEnabled: true }, mode: 'approve', confidence: 0.9,
      gateDecision: 'shadow_recorded', preview: { subject: 'Installing Bluebeam', html: ANSWER.html, text: ANSWER.text }, body: ANSWER,
    });
    run = { ...run, ...staged };
  }
  return { id: run.id, status: run.status, gateDecision: run.gateDecision };
}

beforeEach(() => {
  jest.clearAllMocks();
  events.length = 0;
  setAutoHelpEventEmitter((type, ticketId, payload) => { events.push({ type, ticketId, extra: payload.extra }); });
  runCalls = [];
  seed();
  intake.autoDrain = false;
  jest.spyOn(runner, 'runForTicket').mockImplementation(fakeRunForTicket);
});
afterEach(() => {
  jest.restoreAllMocks();
  setAutoHelpEventEmitter(null);
  for (const k of Object.keys(overrides)) delete overrides[k];
});

/**
 * pg_advisory_xact_lock stand-in: transactions run one after another, the way
 * two transactions taking the same ticket lock do in Postgres.
 */
function simulateTicketLock() {
  let chain = Promise.resolve();
  overrides.$queryRaw = async () => [{ locked: 1 }];
  overrides.$transaction = (fn) => {
    const run = chain.then(() => fn(prismaProxy));
    chain = run.catch(() => {});
    return run;
  };
}

const settle = (extra) => intake.onIntakeSettled(55, 1, extra).then(() => intake.drain({ now: new Date(Date.now() + 1000) }));

describe('helpers', () => {
  test('one job per settle kind; manual settles are keyed by their stamp', () => {
    expect(dedupeKeyFor(55, { provisional: true })).toBe('settle:55:provisional');
    expect(dedupeKeyFor(55, { provisional: false, source: 'pipeline' })).toBe('settle:55:final');
    expect(dedupeKeyFor(55, { source: 'manual', stamp: 'manual:fields:55:9' })).toBe('settle:55:manual:manual:fields:55:9');
  });
  test('verdict skips: never-noise hold, noise decision, not actionable', () => {
    expect(verdictSkipCode({ noiseVeto: true, decision: 'pending_review' })).toBe('noise_veto');
    expect(verdictSkipCode({ decision: 'noise_dismissed' })).toBe('noise_decision');
    expect(verdictSkipCode({ decision: 'pending_review', nonActionable: true })).toBe('not_actionable');
    expect(verdictSkipCode({ decision: 'auto_assigned' })).toBeNull();
  });
  test('backoff 1 / 5 / 15 min', () => {
    expect([1, 2, 3, 9].map(backoffMs)).toEqual([60e3, 300e3, 900e3, 900e3]);
  });
});

describe('W5 durable queue', () => {
  test('a settle becomes one job; the same settle twice is deduped; a disabled workspace writes nothing', async () => {
    const a = await intake.onIntakeSettled(55, 1, { provisional: false, source: 'pipeline', decision: 'pending_review' });
    const b = await intake.onIntakeSettled(55, 1, { provisional: false, source: 'pipeline', decision: 'pending_review' });
    expect(a.id).toBeTruthy();
    expect(b.duplicate).toBe(true);
    expect(rows('autoHelpJob')).toHaveLength(1);
    rows('autoHelpSettings')[0].enabled = false;
    const c = await intake.onIntakeSettled(55, 1, { provisional: true });
    expect(c).toEqual({ skipped: 'workspace_disabled' });
    expect(rows('autoHelpJob')).toHaveLength(1);
  });

  test('two workers draining at once run each job exactly once (conditional claim)', async () => {
    for (const id of [55, 56, 57, 58]) {
      if (id !== 55) rows('ticket').push({ ...rows('ticket')[0], id });
      await intake.enqueue({ workspaceId: 1, ticketId: id, extra: { provisional: false, source: 'pipeline', decision: 'pending_review' } });
    }
    const w1 = new AutoHelpIntakeService();
    const w2 = new AutoHelpIntakeService();
    w1.autoDrain = false; w2.autoDrain = false;
    const now = new Date(Date.now() + 1000);
    await Promise.all([w1.drain({ now }), w2.drain({ now }), w1.drain({ now })]);
    expect(runCalls.map((c) => c.ticketId).sort()).toEqual([55, 56, 57, 58]);
    expect(rows('autoHelpJob').every((j) => j.status === 'done' && j.attempts === 1)).toBe(true);
  });

  test('a failing job retries with backoff and gives up after the last attempt', async () => {
    runner.runForTicket.mockRejectedValue(new Error('provider down'));
    await intake.enqueue({ workspaceId: 1, ticketId: 55, extra: { provisional: false, source: 'pipeline' } });
    let now = new Date(Date.now() + 1000);
    for (let attempt = 1; attempt <= JOB_MAX_ATTEMPTS; attempt += 1) {
      await intake.drain({ now });
      const job = rows('autoHelpJob')[0];
      expect(job.attempts).toBe(attempt);
      if (attempt < JOB_MAX_ATTEMPTS) {
        expect(job.status).toBe('pending');
        expect(new Date(job.runAfter).getTime()).toBeGreaterThan(now.getTime() + backoffMs(attempt) - 5000);
        // Not due yet: nothing happens.
        await intake.drain({ now: new Date(now.getTime() + 1000) });
        expect(rows('autoHelpJob')[0].attempts).toBe(attempt);
        now = new Date(new Date(job.runAfter).getTime() + 1000);
      }
    }
    expect(rows('autoHelpJob')[0]).toMatchObject({ status: 'failed', lastError: 'provider down' });
  });

  test('age cap: a settle older than 6 h is expired, never run', async () => {
    await intake.enqueue({ workspaceId: 1, ticketId: 55, extra: { provisional: false, source: 'pipeline' } });
    rows('autoHelpJob')[0].createdAt = new Date(Date.now() - 7 * 3600e3);
    await intake.drain({ now: new Date() });
    expect(rows('autoHelpJob')[0].status).toBe('expired');
    expect(runCalls).toHaveLength(0);
  });

  test('a claim whose container died is recovered and run again', async () => {
    await intake.enqueue({ workspaceId: 1, ticketId: 55, extra: { provisional: false, source: 'pipeline' } });
    Object.assign(rows('autoHelpJob')[0], { status: 'running', claimedAt: new Date(Date.now() - 20 * 60e3), attempts: 1 });
    await intake.drain({ now: new Date() });
    expect(rows('autoHelpJob')[0]).toMatchObject({ status: 'done', attempts: 2 });
    expect(runCalls).toHaveLength(1);
  });

  test('catch-up sweep: a lost settle (pipeline finished, no job, no decision) is re-queued once', async () => {
    const now = new Date();
    rows('assignmentPipelineRun').push(
      { id: 700, ticketId: 55, workspaceId: 1, triggerSource: 'webhook', status: 'completed', decision: 'pending_review', nonActionable: false, errorMessage: null, createdAt: new Date(now - 3600e3), updatedAt: new Date(now - 600e3) },
      // not an intake settle, and one too old: ignored
      { id: 701, ticketId: 55, workspaceId: 1, triggerSource: 'priority_changed', status: 'completed', decision: 'priority_only', createdAt: new Date(now - 3600e3), updatedAt: new Date(now - 600e3) },
      // a noise rule's dismissal is not an intake settle either (27 Sep 2026)
      { id: 703, ticketId: 56, workspaceId: 1, triggerSource: 'noise_rule', status: 'completed', decision: 'noise_dismissed', createdAt: new Date(now - 3600e3), updatedAt: new Date(now - 600e3) },
      { id: 702, ticketId: 55, workspaceId: 1, triggerSource: 'webhook', status: 'completed', decision: 'pending_review', createdAt: new Date(now - 30 * 3600e3), updatedAt: new Date(now - 8 * 3600e3) },
    );
    const first = await intake.catchUp({ now });
    expect(first.requeued).toBe(1);
    expect(rows('autoHelpJob')[0]).toMatchObject({ dedupeKey: 'settle:55:final', status: 'pending' });
    expect(rows('autoHelpJob')[0].payload).toMatchObject({ recovered: true, pipelineRunId: 700, categoryId: 10, subcategoryId: 101 });
    const second = await intake.catchUp({ now });
    expect(second.requeued).toBe(0);
    await intake.drain({ now: new Date(now.getTime() + 1000) });
    expect(runCalls).toHaveLength(1);
    // Decided already (a run after the pipeline finished): nothing to catch up.
    rows('autoHelpJob').length = 0;
    expect((await intake.catchUp({ now })).requeued).toBe(0);
  });
});

describe('manual settles are durable (marker + retried job + catch-up)', () => {
  const MANUAL = { source: 'manual', stamp: 'manual:fields:55:77', categoryId: 10, subcategoryId: 101, by: 'human' };

  test('writes the marker and the job in the same call', async () => {
    const job = await intake.onManualSettle(55, 1, MANUAL, { retryDelaysMs: [] });
    expect(job.id).toBeTruthy();
    expect(rows('autoHelpJob')[0]).toMatchObject({ dedupeKey: 'settle:55:manual:manual:fields:55:77', status: 'pending' });
    expect(rows('ticketActivity')[0]).toMatchObject({ ticketId: 55, activityType: 'auto_help_manual_settle' });
    expect(rows('ticketActivity')[0].details).toMatchObject({ workspaceId: 1, stamp: 'manual:fields:55:77', categoryId: 10 });
  });

  test('Auto-help off: no marker, no job', async () => {
    rows('autoHelpSettings')[0].enabled = false;
    expect(await intake.onManualSettle(55, 1, MANUAL, { retryDelaysMs: [] })).toEqual({ skipped: 'workspace_disabled' });
    expect(rows('ticketActivity')).toHaveLength(0);
    expect(rows('autoHelpJob')).toHaveLength(0);
  });

  test('a failing job insert is retried', async () => {
    const create = db.autoHelpJob.create;
    let fails = 2;
    db.autoHelpJob.create = async (args) => { if (fails > 0) { fails -= 1; throw new Error('db blip'); } return create(args); };
    const job = await intake.onManualSettle(55, 1, MANUAL, { retryDelaysMs: [1, 1] });
    expect(job.id).toBeTruthy();
    expect(rows('autoHelpJob')).toHaveLength(1);
  });

  test('a job that never landed is re-queued by the catch-up sweep from the marker, once', async () => {
    db.autoHelpJob.create = async () => { throw new Error('db down'); };
    await intake.onManualSettle(55, 1, MANUAL, { retryDelaysMs: [1] });
    expect(rows('autoHelpJob')).toHaveLength(0);
    expect(rows('ticketActivity')).toHaveLength(1);
    seedJobCreate();
    const now = new Date(Date.now() + 60e3);
    expect((await intake.catchUp({ now })).requeued).toBe(1);
    expect(rows('autoHelpJob')[0]).toMatchObject({ dedupeKey: 'settle:55:manual:manual:fields:55:77' });
    expect(rows('autoHelpJob')[0].payload).toMatchObject({ source: 'manual', recovered: true, categoryId: 10 });
    expect((await intake.catchUp({ now })).requeued).toBe(0);
    await intake.drain({ now: new Date(now.getTime() + 1000) });
    expect(runCalls).toHaveLength(1);
  });
});

describe('W1 settle decisions', () => {
  const FINAL = { provisional: false, source: 'pipeline', decision: 'pending_review' };
  const NIGHT = { provisional: true, source: 'pipeline', decision: 'priority_only', afterHours: true, fullRunPending: true };

  test('first settle runs once and keeps the settle facts on the run; approve stages it', async () => {
    await settle(NIGHT);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].settle).toMatchObject({ provisional: true, categoryId: 10, subcategoryId: 101 });
    const run = rows('autoHelpRun')[0];
    expect(run).toMatchObject({ status: 'staged', gateDecision: 'staged_for_agent' });
    expect(run.outcomeDetail.settle).toMatchObject({ provisional: true, categoryId: 10 });
    expect(events.map((e) => e.type)).toEqual(['auto_help.staged']);
    expect(rows('ticket')[0]).toMatchObject({ replyOwner: 'auto_help', replyOwnerRef: `run:${run.id}` });
  });

  test('noise / not-actionable / never-noise verdicts record a skip row (clearable) and do not run', async () => {
    await settle({ ...NIGHT, decision: 'noise_dismissed' });
    expect(runCalls).toHaveLength(0);
    expect(rows('autoHelpRun')[0]).toMatchObject({ status: 'skipped', gateDecision: 'noise_decision' });
    // The morning run says it is a real request: Auto-help runs (the skip row is not "already ran").
    await settle(FINAL);
    expect(runCalls).toHaveLength(1);
  });

  test('morning settle, same category: the night draft is kept, no second run', async () => {
    await settle(NIGHT);
    await settle(FINAL);
    expect(runCalls).toHaveLength(1);
    const run = rows('autoHelpRun')[0];
    expect(run.status).toBe('staged');
    expect(rows('ticketProposedReply')[0].status).toBe('proposed');
    expect(run.outcomeDetail.history.map((h) => h.step)).toContain('settle_confirmed');
  });

  test('morning recategorization: the staged draft is withdrawn (why recorded) and ONE re-run happens on the new category', async () => {
    await settle(NIGHT);
    const night = rows('autoHelpRun')[0];
    Object.assign(rows('ticket')[0], { internalCategoryId: 20, internalSubcategoryId: 201 });
    await settle(FINAL);
    const fresh = rows('autoHelpRun').find((r) => r.id === night.id);
    expect(fresh.outcome).toBe('withdrawn');
    expect(fresh.outcomeDetail.withdrawn).toMatchObject({ why: 'the full intake run chose a different category', fromCategoryId: 10, toCategoryId: 20 });
    expect(rows('ticketProposedReply').find((p) => p.autoHelpRunId === night.id)).toMatchObject({ status: 'dismissed', decidedBy: 'auto_help_withdrawn' });
    expect(rows('ticketActivity').map((a) => a.activityType)).toContain('auto_help_withdrawn');
    expect(runCalls).toHaveLength(2);
    expect(runCalls[1]).toMatchObject({ allowRerun: true, settle: { rerunOf: night.id, provisional: false, categoryId: 20 } });
    // The re-run's draft took the first reply back.
    const rerun = rows('autoHelpRun').find((r) => r.id !== night.id);
    expect(rows('ticket')[0]).toMatchObject({ replyOwner: 'auto_help', replyOwnerRef: `run:${rerun.id}` });
  });

  test('a person recategorizing (nothing sent) withdraws the staged draft and re-runs; at most 3 runs per ticket', async () => {
    await settle(NIGHT); // run 1 on 10
    Object.assign(rows('ticket')[0], { internalCategoryId: 20, internalSubcategoryId: 201 });
    await settle(FINAL); // withdrawn + automatic re-run (run 2 on 20)
    expect(runCalls).toHaveLength(2);
    Object.assign(rows('ticket')[0], { internalCategoryId: 10, internalSubcategoryId: 101 });
    await settle({ source: 'manual', stamp: 'manual:fields:55:1' }); // withdrawn + manual re-run (run 3 on 10)
    expect(runCalls).toHaveLength(3);
    expect(runCalls[2].settle).toMatchObject({ source: 'manual', categoryId: 10, rerunOf: runCalls.length && rows('autoHelpRun')[1].id });
    const second = rows('autoHelpRun')[1];
    expect(second.outcome).toBe('withdrawn');
    expect(second.outcomeDetail.withdrawn.why).toBe('the category was changed by hand');
    // A fourth category: the stale draft is still withdrawn, but no fourth run (cap 3).
    Object.assign(rows('ticket')[0], { internalCategoryId: 20, internalSubcategoryId: 201 });
    await settle({ source: 'manual', stamp: 'manual:fields:55:2' });
    expect(runCalls).toHaveLength(3);
    expect(rows('autoHelpRun')[2].outcome).toBe('withdrawn');
    expect(rows('autoHelpJob').find((j) => j.dedupeKey.endsWith('manual:fields:55:2')).result).toMatchObject({ rerun: false, reason: 'run_cap' });
    expect(rows('ticketProposedReply').filter((x) => x.status === 'proposed')).toHaveLength(0);
  });

  test('a person recategorizing after the morning run withdrew the draft (noise) gets a fresh run on the new category', async () => {
    await settle(NIGHT);
    await settle({ ...FINAL, decision: 'noise_dismissed' });
    expect(rows('autoHelpRun')[0].outcome).toBe('withdrawn');
    Object.assign(rows('ticket')[0], { internalCategoryId: 20, internalSubcategoryId: 201 });
    await settle({ source: 'manual', stamp: 'manual:fields:55:3' });
    expect(runCalls).toHaveLength(2);
    expect(runCalls[1]).toMatchObject({ allowRerun: true, settle: { source: 'manual', categoryId: 20 } });
  });

  test('a person recategorizing after the answer was SENT: an internal note only, no withdraw, no run', async () => {
    await settle(NIGHT);
    Object.assign(rows('autoHelpRun')[0], { status: 'sent', decision: 'agent_sent', decidedAt: new Date() });
    Object.assign(rows('ticket')[0], { internalCategoryId: 20, internalSubcategoryId: 201 });
    await settle({ source: 'manual', stamp: 'manual:fields:55:4' });
    expect(ticketServiceMock.addPrivateNote).toHaveBeenCalledTimes(1);
    expect(runCalls).toHaveLength(1);
    expect(rows('autoHelpRun')[0].outcome).toBeNull();
  });

  test('an agent dismissed the draft: a person recategorizing does not bring Auto-help back', async () => {
    await settle(NIGHT);
    Object.assign(rows('autoHelpRun')[0], { decision: 'agent_dismissed' });
    Object.assign(rows('ticket')[0], { internalCategoryId: 20 });
    await settle({ source: 'manual', stamp: 'manual:fields:55:5' });
    expect(runCalls).toHaveLength(1);
  });

  test('morning verdict turned noise: the staged draft is withdrawn and nothing re-runs', async () => {
    await settle(NIGHT);
    await settle({ ...FINAL, decision: 'noise_dismissed' });
    expect(rows('autoHelpRun')[0]).toMatchObject({ outcome: 'withdrawn' });
    expect(rows('autoHelpRun')[0].outcomeDetail.withdrawn.why).toMatch(/noise/);
    expect(runCalls).toHaveLength(1);
    expect(rows('ticket')[0].replyOwner).toBeNull();
  });

  test('an approval started overnight withdraws the staged draft', async () => {
    await settle(NIGHT);
    rows('ticketApproval').push({ id: 1, ticketId: 55, status: 'pending' });
    await settle(FINAL);
    expect(rows('autoHelpRun')[0].outcome).toBe('withdrawn');
    expect(rows('autoHelpRun')[0].outcomeDetail.withdrawn.why).toMatch(/approval/);
    expect(runCalls).toHaveLength(1);
  });

  test('an agent mid-send wins: a draft already being sent is not withdrawn', async () => {
    await settle(NIGHT);
    rows('ticketProposedReply')[0].status = 'sending';
    Object.assign(rows('ticket')[0], { internalCategoryId: 20 });
    await settle(FINAL);
    expect(rows('autoHelpRun')[0].outcome).toBeNull();
    expect(rows('autoHelpJob').find((j) => j.dedupeKey === 'settle:55:final').result).toMatchObject({ result: 'agent_acting' });
    expect(runCalls).toHaveLength(1);
  });

  test('already SENT on the night category: an internal note tells the assignee, nothing is withdrawn', async () => {
    await settle(NIGHT);
    Object.assign(rows('autoHelpRun')[0], { status: 'sent', decision: 'agent_sent', decidedAt: new Date() });
    Object.assign(rows('ticket')[0], { internalCategoryId: 20, internalSubcategoryId: 201 });
    await settle(FINAL);
    expect(ticketServiceMock.addPrivateNote).toHaveBeenCalledTimes(1);
    const [tId, ws, body, actor, files, opts] = ticketServiceMock.addPrivateNote.mock.calls[0];
    expect([tId, ws]).toEqual([55, 1]);
    expect(body.bodyText).toBe('Auto-help answered this as Software & Apps › Installation; the full intake run chose Hardware › Laptop. Check that the answer the requester got still fits.');
    expect(actor.role).toBe('automation');
    expect(files).toEqual([]);
    expect(opts).toEqual({ systemNote: true });
    expect(rows('autoHelpRun')[0].outcome).toBeNull();
    expect(runCalls).toHaveLength(1);
  });

  test('a provisional settle after something already ran does nothing', async () => {
    await settle({ source: 'manual', stamp: 'm1' });
    await settle(NIGHT);
    expect(runCalls).toHaveLength(1);
    expect(rows('autoHelpJob').find((j) => j.dedupeKey === 'settle:55:provisional').result).toMatchObject({ result: 'already_ran' });
  });

  test('a run still drafting makes the settle retry later instead of deciding blind', async () => {
    await settle(NIGHT);
    Object.assign(rows('autoHelpRun')[0], { status: 'running', decision: null });
    Object.assign(rows('ticket')[0], { internalCategoryId: 20 });
    await settle(FINAL);
    const job = rows('autoHelpJob').find((j) => j.dedupeKey === 'settle:55:final');
    expect(job).toMatchObject({ status: 'pending', attempts: 1 });
    expect(job.lastError).toMatch(/still running/);
  });
});

describe('audit S2: one ticket, one Auto-help run at a time', () => {
  test('two settle jobs for ONE ticket on two workers → one real run; the other waits, then keeps it', async () => {
    simulateTicketLock();
    await intake.enqueue({ workspaceId: 1, ticketId: 55, extra: { provisional: false, source: 'pipeline', decision: 'pending_review' } });
    await intake.enqueue({ workspaceId: 1, ticketId: 55, extra: { source: 'manual', provisional: false, stamp: 'manual:fields:55:1' } });
    const w1 = new AutoHelpIntakeService();
    const w2 = new AutoHelpIntakeService();
    w1.autoDrain = false; w2.autoDrain = false;
    const now = new Date(Date.now() + 1000);
    const [a, b] = await Promise.all([w1.drain({ now }), w2.drain({ now })]);
    expect(runCalls).toHaveLength(1);
    expect(a.busy + b.busy).toBeGreaterThanOrEqual(1);
    expect(rows('autoHelpJob').filter((j) => j.status === 'pending')).toHaveLength(1);
    // Next tick: the waiting job sees the run and keeps it (no second model call).
    await intake.drain({ now: new Date(now.getTime() + 1000) });
    expect(runCalls).toHaveLength(1);
    expect(rows('autoHelpJob').every((j) => j.status === 'done')).toBe(true);
    expect(rows('autoHelpJob').map((j) => j.result.result).sort()).toEqual(['kept', 'ran']);
    expect(rows('autoHelpRun').filter((r) => !['skipped', 'no_match'].includes(r.status))).toHaveLength(1);
  });

  test('a running job whose claim went stale (dead container) does not block the ticket', async () => {
    simulateTicketLock();
    await intake.enqueue({ workspaceId: 1, ticketId: 55, extra: { provisional: false, source: 'pipeline' } });
    rows('ticket').push({ ...rows('ticket')[0], id: 56 });
    rows('autoHelpJob').push({ id: 99, workspaceId: 1, ticketId: 55, dedupeKey: 'x', status: 'running', attempts: 1, claimedAt: new Date(Date.now() - 20 * 60e3), createdAt: new Date(), runAfter: new Date() });
    const job = rows('autoHelpJob')[0];
    const claimed = await intake.claim(job, new Date(Date.now() + 1000));
    expect(claimed?.busy).toBeUndefined();
    expect(claimed?.status).toBe('running');
  });
});

describe('audit S1: the queue has its own tick', () => {
  test('tick drains on its own; a second tick while one is running is skipped (never piles up)', async () => {
    let release;
    runner.runForTicket.mockImplementationOnce((...args) => new Promise((r) => { release = () => r(fakeRunForTicket(...args)); }));
    await intake.enqueue({ workspaceId: 1, ticketId: 55, extra: { provisional: false, source: 'pipeline' } });
    const svc = new AutoHelpIntakeService();
    svc.autoDrain = false;
    const now = new Date(Date.now() + 1000);
    const first = svc.tick({ now });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(await svc.tick({ now })).toEqual({ skipped: true });
    release();
    const out = await first;
    expect(out.jobs).toMatchObject({ ran: 1 });
  });

  test('start() arms an unref-ed interval once; AUTO_HELP_JOB_SWEEP_ENABLED=false keeps it off', () => {
    const svc = new AutoHelpIntakeService();
    svc.start();
    const timer = svc._timer;
    expect(timer).toBeTruthy();
    svc.start();
    expect(svc._timer).toBe(timer);
    svc.stop();
    expect(svc._timer).toBeNull();
    process.env.AUTO_HELP_JOB_SWEEP_ENABLED = 'false';
    try {
      svc.start();
      expect(svc._timer).toBeNull();
    } finally {
      delete process.env.AUTO_HELP_JOB_SWEEP_ENABLED;
    }
  });
});

describe('audit nice-to-have 3: finished jobs are cleaned up', () => {
  test('done / failed / expired rows older than 14 days go (bounded batch); recent and pending rows stay', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - JOB_RETENTION_MS - 60e3);
    const recent = new Date(now.getTime() - 5 * 86400e3);
    const push = (id, status, finishedAt) => rows('autoHelpJob').push({ id, workspaceId: 1, ticketId: 55, dedupeKey: `k${id}`, status, attempts: 1, finishedAt, createdAt: finishedAt || now, runAfter: now });
    push(1, 'done', old); push(2, 'failed', old); push(3, 'expired', old);
    push(4, 'done', recent); push(5, 'pending', null); push(6, 'running', null);
    expect(JOB_RETENTION_MS).toBeGreaterThanOrEqual(CATCH_UP_CREATED_LOOKBACK_MS);
    expect(await intake.cleanup({ now, limit: 2 })).toBe(2);
    expect(await intake.cleanup({ now })).toBe(1);
    expect(rows('autoHelpJob').map((j) => j.id).sort()).toEqual([4, 5, 6]);
  });
});

describe('audit nice-to-have 2: catch-up only since Auto-help was switched on, paged', () => {
  const pipelineRun = (id, ticketId, createdAt, over = {}) => ({
    id, ticketId, workspaceId: 1, status: 'completed', decision: 'pending_review', nonActionable: false, errorMessage: null,
    triggerSource: 'webhook', createdAt, updatedAt: new Date(), ...over,
  });

  test('settles from before enabled_at are never re-queued', async () => {
    const now = new Date();
    rows('autoHelpSettings')[0].enabledAt = new Date(now.getTime() - 3600e3);
    rows('ticket').push({ ...rows('ticket')[0], id: 56 });
    rows('assignmentPipelineRun').push(
      pipelineRun(700, 55, new Date(now.getTime() - 2 * 3600e3)), // before Auto-help was on
      pipelineRun(701, 56, new Date(now.getTime() - 30 * 60e3)),
    );
    const out = await intake.catchUp({ now });
    expect(out.requeued).toBe(1);
    expect(rows('autoHelpJob').map((j) => j.ticketId)).toEqual([56]);
  });

  test('a morning burst larger than one page is re-queued in full (paged by id, not the newest 100)', async () => {
    const now = new Date();
    const total = CATCH_UP_BATCH + 30;
    for (let i = 0; i < total; i += 1) {
      rows('ticket').push({ ...rows('ticket')[0], id: 1000 + i });
      rows('assignmentPipelineRun').push(pipelineRun(2000 + i, 1000 + i, new Date(now.getTime() - 60 * 60e3)));
    }
    const out = await intake.catchUp({ now });
    expect(out.requeued).toBe(total);
    expect(new Set(rows('autoHelpJob').map((j) => j.ticketId)).size).toBe(total);
  });
});

describe('audit nice-to-have 4: a missed morning settle', () => {
  function nightDraft(createdAt) {
    rows('autoHelpRun').push({
      id: 500, workspaceId: 1, ticketId: 55, trigger: 'categorized', status: 'staged', outcome: null, decision: null, createdAt,
      outcomeDetail: { settle: { provisional: true, categoryId: 10, subcategoryId: 101 } },
    });
    rows('autoHelpJob').push({ id: 1, workspaceId: 1, ticketId: 55, dedupeKey: 'settle:55:provisional', status: 'done', attempts: 1, createdAt, runAfter: createdAt, finishedAt: createdAt });
  }

  test('no final settle within business hours + 2 h: queued from the latest completed full pipeline run', async () => {
    const draftAt = new Date(Date.now() - 30 * 3600e3);
    nightDraft(draftAt);
    rows('assignmentPipelineRun').push(
      { id: 800, ticketId: 55, workspaceId: 1, status: 'completed', decision: 'priority_only', triggerSource: 'priority_assessment_after_hours', createdAt: new Date(draftAt.getTime() - 60e3), updatedAt: new Date(draftAt.getTime() - 30e3) },
      { id: 801, ticketId: 55, workspaceId: 1, status: 'completed', decision: 'pending_review', nonActionable: false, triggerSource: 'webhook', createdAt: new Date(draftAt.getTime() - 60e3), updatedAt: new Date(draftAt.getTime() + 8 * 3600e3) },
    );
    const out = await intake.missedFinalSettles({ now: new Date() });
    expect(out.requeued).toBe(1);
    const job = rows('autoHelpJob').find((j) => j.dedupeKey === 'settle:55:final');
    expect(job.payload).toMatchObject({ provisional: false, source: 'pipeline', pipelineRunId: 801, missedSettle: true, decision: 'pending_review' });
    // Once queued, a second pass does nothing.
    expect((await intake.missedFinalSettles({ now: new Date() })).requeued).toBe(0);
  });

  test('still inside the grace window, or no full run yet → nothing (the draft keeps waiting for an agent)', async () => {
    nightDraft(new Date(Date.now() - 10 * 60e3));
    rows('assignmentPipelineRun').push({ id: 801, ticketId: 55, workspaceId: 1, status: 'completed', decision: 'pending_review', triggerSource: 'webhook', createdAt: new Date(), updatedAt: new Date() });
    expect((await intake.missedFinalSettles({ now: new Date() })).requeued).toBe(0);
    rows('autoHelpRun')[0].createdAt = new Date(Date.now() - 30 * 3600e3);
    rows('assignmentPipelineRun').length = 0;
    expect((await intake.missedFinalSettles({ now: new Date() })).requeued).toBe(0);
    expect(rows('autoHelpJob').some((j) => j.dedupeKey === 'settle:55:final')).toBe(false);
  });
});
