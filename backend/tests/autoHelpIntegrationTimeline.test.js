import { jest } from '@jest/globals';
import jsonLogic from 'json-logic-js';
import { createFakePrisma } from './helpers/fakePrismaStore.js';

/**
 * Auto-help integration W6 — timeline simulations (plans/AUTO_HELP_INTEGRATION_PLAN.md).
 *
 * Fake timers + a business-calendar fixture (IT, America/Vancouver, Mon–Fri
 * 08:00–17:00), an in-memory database, and the REAL intake queue, delivery,
 * proposal store, ack-merge service, park sweep, follow-up loop and business
 * calendar. Simulated around them: the assignment pipeline's settles (when it
 * would emit ticket.intake_settled), the "Ticket arrived" ack workflow and the
 * seeded "Follow-up nudge" workflow (its compiled condition, evaluated on the
 * context the engine would resume with), and the drafting model (runForTicket
 * records a run with its settle facts and stages it through delivery).
 *
 * Every e-mail the requester would get is recorded in one outbox:
 *   ack         the "Ticket arrived" workflow (TP-born) or FreshService's own
 *               ack (FS-born — FreshService sends it, not us)
 *   answer      the Auto-help answer (agent click, or auto when stubbed on)
 *   check-in    Auto-help's nudge
 *   wf-nudge    the generic Follow-up nudge template (must never fire here)
 */
let db;
const prismaProxy = new Proxy({}, { get: (_t, prop) => db[prop] });
const gatewayMock = { runToolTurn: jest.fn(), sendJson: jest.fn() };
const outbox = [];
const workflowEvents = [];

const ticketServiceMock = {
  addReply: jest.fn(async (ticketId, workspaceId, input, actor) => {
    const entry = await db.ticketThreadEntry.create({
      data: {
        ticketId, workspaceId, eventType: 'reply', authorType: 'agent', source: 'ticketpulse_user',
        actorName: actor?.name || actor?.email || 'Ticket Pulse', actorEmail: actor?.email || null,
        isPrivate: false, incoming: false, bodyHtml: input.bodyHtml, bodyText: input.bodyText, occurredAt: new Date(),
        ...(input.idempotencyKey ? { rawPayload: { idempotencyKey: input.idempotencyKey } } : {}),
      },
    });
    const kind = String(input.idempotencyKey || '').includes('check-in') ? 'check-in' : 'answer';
    outbox.push({ at: new Date(), kind, text: input.bodyText });
    // The seeded "Follow-up nudge" workflow hears every public reply (ticket.public_reply_added).
    scheduleWorkflowNudge(ticketId);
    return { entry, email: { sent: true } };
  }),
  addPrivateNote: jest.fn(async () => ({ entry: { id: 1 } })),
  changeStatus: jest.fn(async (ticketId, _ws, status, actor) => db.ticket.update({
    where: { id: ticketId },
    data: { status, ...(['Resolved', 'Closed'].includes(status) ? { resolvedByKind: actor?.resolvedByKind === 'auto_help' ? 'auto_help' : 'automation' } : {}) },
  })),
  updateFsTicket: jest.fn(async (ticketId, _ws, input) => db.ticket.update({ where: { id: ticketId }, data: { status: input.status } })),
  updateTicketFields: jest.fn(async () => ({})),
  assignTicket: jest.fn(async () => ({})),
  _broadcast: jest.fn(),
};
const lifecycleMock = { emitTicketEvent: jest.fn(async (type, ticketId, payload) => { workflowEvents.push({ type, ticketId, extra: payload?.extra }); return {}; }) };
const fsBornMock = {
  changeFsBornStatus: jest.fn(async (ticketId, _ws, status, actor) => db.ticket.update({
    where: { id: ticketId }, data: { status, resolvedByKind: actor?.resolvedByKind === 'auto_help' ? 'auto_help' : 'automation' },
  })),
};
const BASE = { Resolved: 'Resolved', Closed: 'Closed', Pending: 'Pending' };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaProxy }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: gatewayMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ sendTransactionalEmail: jest.fn(async () => ({ sent: true })), default: { sendTransactionalEmail: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ ...lifecycleMock, default: lifecycleMock }));
jest.unstable_mockModule('../src/services/fsBornStatusService.js', () => ({ ...fsBornMock, default: fsBornMock }));
jest.unstable_mockModule('../src/services/fsThreadPullService.js', () => ({ default: { pull: jest.fn(async () => 0), enqueue: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: {
    resolveBaseStatus: jest.fn(async (_ws, s) => BASE[s] || 'Open'),
    baseStatusOf: jest.fn(async (_ws, s) => BASE[s] || 'Open'),
    statusNamesForBase: jest.fn(async () => ['Open', 'Pending']),
    assertValidStatus: jest.fn(async (_ws, s) => s),
  },
}));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => false,
  embedQueryTexts: jest.fn(async () => null),
  cosineSimilarity: () => 0,
  nearestVerifiedSolutions: jest.fn(async () => ({ cosById: new Map(), topIds: [] })),
}));
jest.unstable_mockModule('../src/services/ticketSimilaritySearchService.js', () => ({ default: { search: jest.fn() } }));
jest.unstable_mockModule('../src/utils/publicBaseUrl.js', () => ({ resolvePublicBaseUrl: () => 'https://tp.example' }));

const { default: runner, settleFacts } = await import('../src/services/autoHelpRunner.js');
const { default: delivery } = await import('../src/services/autoHelpDeliveryService.js');
const { default: intake } = await import('../src/services/autoHelpIntakeService.js');
const { default: ackMerge, ackTextFrom } = await import('../src/services/autoHelpAckMergeService.js');
const { default: ticketParkService } = await import('../src/services/ticketParkService.js');
const { default: proposals } = await import('../src/services/ticketProposedReplyService.js');
const { default: playbookService } = await import('../src/services/autoHelpPlaybookService.js');
const { default: businessCalendarService } = await import('../src/services/businessCalendarService.js');
const { expectedFor, pipelineContextFor } = await import('../src/services/autoHelpContextService.js');
const { setAutoHelpEventEmitter } = await import('../src/services/autoHelpEvents.js');
const { compileConditionGroup } = await import('../src/services/notificationConditionModel.js');
const { WORKFLOW_TEMPLATES } = await import('../src/services/notificationWorkflowDefinition.js');

const PDT = (iso) => new Date(`${iso}-07:00`);
const AGENT = { name: 'Dana Agent', email: 'dana@example.com', role: 'user', technicianId: 5 };
const ANSWER = { html: '<ol><li>Open Company Portal.</li><li>Search for Bluebeam Revu and choose Install.</li></ol>', text: '1. Open Company Portal.\n2. Search for Bluebeam Revu and choose Install.' };
const ACK_TEXT = 'We received your request and a member of the IT team will be in touch.';
const MERGE_WAIT_MIN = 5;
const autoHelpEvents = [];
const pendingWorkflowNudges = [];
let runCalls = [];

// The seeded Follow-up nudge template, compiled exactly as the engine does.
const NUDGE_RULE = compileConditionGroup(WORKFLOW_TEMPLATES.find((t) => t.key === 'follow_up_nudge').build().nodes.find((n) => n.id === 'still-open').data.conditionGroup);

function scheduleWorkflowNudge(ticketId) {
  const t = db._rows('ticket').find((r) => r.id === ticketId);
  // The engine stores the trigger-time context; on resume it refreshes park + resolver (W3).
  pendingWorkflowNudges.push({ ticketId, due: new Date(Date.now() + 24 * 3600e3), status: t.status });
}
async function runDueWorkflowNudges(now) {
  for (const n of pendingWorkflowNudges.filter((x) => !x.done && x.due <= now)) {
    n.done = true;
    const t = db._rows('ticket').find((r) => r.id === n.ticketId);
    const scope = { ticket: { status: n.status, parkKind: t.parkKind || null, resolvedByKind: t.resolvedByKind || null } };
    if (jsonLogic.apply(NUDGE_RULE, scope)) outbox.push({ at: new Date(now), kind: 'wf-nudge' });
  }
}

function seed({ origin = 'ticketpulse', mode = 'approve' } = {}) {
  db = createFakePrisma({
    workspace: [{ id: 1, name: 'IT', defaultTimezone: 'America/Vancouver', isActive: false }],
    businessHour: [1, 2, 3, 4, 5].map((d) => ({ id: d, workspaceId: 1, dayOfWeek: d, startTime: '08:00', endTime: '17:00', isEnabled: true, timezone: 'America/Vancouver' })),
    autoHelpSettings: [{ workspaceId: 1, enabled: true, approveModeEnabled: true, disclosureEnabled: true, disclosureText: 'This is an automated first answer from the {{workspace}} team.' }],
    autoHelpPlaybook: [{
      id: 3, workspaceId: 1, name: 'Software installs', enabled: true, mode, sensitive: false, minConfidence: 0.8, version: 2,
      followUp: { nudgeAfterBusinessDays: 2, closeAfterBusinessDays: 2, onSilence: 'resolve' }, onHelp: 'assign_normally',
    }],
    competencyCategory: [{ id: 10, workspaceId: 1, name: 'Software & Apps' }, { id: 20, workspaceId: 1, name: 'Hardware' }],
    ticket: [{
      id: 55, workspaceId: 1, origin, status: 'Open', subject: 'Install Bluebeam please', nativeNumber: 900,
      freshserviceTicketId: origin === 'ticketpulse' ? null : 241500, parkedUntil: null, parkKind: null, assignedTechId: 5, dueBy: null,
      requesterId: 7, requester: { email: 'pat@example.com' }, assignedTech: { id: 5, name: 'Dana Agent', email: 'dana@example.com' },
      internalCategoryId: null, internalSubcategoryId: null, replyOwner: null, replyOwnerRef: null, firstPublicAgentReplyAt: null, resolvedByKind: null,
    }],
  });
  const jobs = db.autoHelpJob;
  const createJob = jobs.create;
  jobs.create = async (args) => {
    if (db._rows('autoHelpJob').some((j) => j.dedupeKey === args.data.dedupeKey)) { const e = new Error('dupe'); e.code = 'P2002'; throw e; }
    return createJob(args);
  };
  const props = db.ticketProposedReply;
  const createProp = props.create;
  props.create = async (args) => createProp({ ...args, data: { status: 'proposed', ...args.data } });
  const acks = db.autoHelpPendingAck;
  const createAck = acks.create;
  acks.create = async (args) => createAck({ ...args, data: { ...args.data, updatedAt: new Date() } });
}

const rows = (n) => db._rows(n);
const ticket = () => rows('ticket')[0];
const kinds = () => outbox.map((m) => m.kind);

/** The drafting model: a grounded answer, staged (approve) or sent (auto) through the REAL delivery service. */
async function fakeRunForTicket(ticketId, { workspaceId, settle = null, allowRerun = false } = {}) {
  runCalls.push({ at: new Date(), settle, allowRerun });
  const t = await db.ticket.findFirst({ where: { id: ticketId } });
  const pb = rows('autoHelpPlaybook')[0];
  const run = await db.autoHelpRun.create({
    data: {
      workspaceId, ticketId, requesterId: 7, playbookId: pb.id, playbookVersion: pb.version, mode: pb.mode, trigger: 'categorized', status: 'drafted',
      gateDecision: 'shadow_recorded', confidence: 0.9, draftSubject: 'Installing Bluebeam', transcript: { body: ANSWER },
      sources: [], outcomeDetail: settle ? { settle: settleFacts(settle, t) } : null, decision: null, outcome: null, nudgedAt: null,
    },
  });
  const staged = await delivery.stageRun({
    run, ticket: t, playbook: pb, settings: await playbookService.getSettings(1), mode: pb.mode, confidence: 0.9, gateDecision: 'shadow_recorded',
    preview: { subject: 'Installing Bluebeam', html: ANSWER.html, text: ANSWER.text }, body: ANSWER, autoSendEligible: true,
  });
  return { id: run.id, ...staged };
}

async function drainAt(when) {
  jest.setSystemTime(when);
  await intake.drain({ now: new Date() });
}

/** The pipeline finished and saved everything: it settles (and queues the job) — optionally "losing" the job. */
async function pipelineSettles(when, { provisional, decision = provisional ? 'priority_only' : 'pending_review', categoryId = 10, lose = false } = {}) {
  jest.setSystemTime(when);
  Object.assign(ticket(), { internalCategoryId: categoryId });
  rows('assignmentPipelineRun').push({
    id: rows('assignmentPipelineRun').length + 700, ticketId: 55, workspaceId: 1, status: 'completed', decision, nonActionable: false,
    triggerSource: provisional ? 'priority_assessment_after_hours' : 'webhook', createdAt: new Date(when.getTime() - 60e3), updatedAt: new Date(when),
  });
  if (!lose) await intake.onIntakeSettled(55, 1, { provisional, source: 'pipeline', decision, categoryId, afterHours: provisional, fullRunPending: provisional });
  await drainAt(new Date(when.getTime() + 1000));
}

/** "Ticket arrived": FS-born → FreshService acks; TP-born → our workflow, with the ack-merge option on. */
async function ticketArrives(when, origin) {
  jest.setSystemTime(when);
  if (origin !== 'ticketpulse') { outbox.push({ at: new Date(), kind: 'ack', by: 'freshservice' }); return null; }
  if (await expectedFor(55, 1)) {
    const held = await ackMerge.hold({ workspaceId: 1, ticketId: 55, workflowRunId: 1, nodeId: 'send', ackText: ackTextFrom({ text: ACK_TEXT }), waitMinutes: MERGE_WAIT_MIN });
    return { held, resumeAt: new Date(when.getTime() + MERGE_WAIT_MIN * 60e3) };
  }
  outbox.push({ at: new Date(), kind: 'ack', by: 'workflow', text: ACK_TEXT });
  return null;
}
async function ackWorkflowWakes(pending) {
  if (!pending) return;
  jest.setSystemTime(pending.resumeAt);
  const out = await ackMerge.settle(pending.held.id);
  if (out.send) outbox.push({ at: new Date(), kind: 'ack', by: 'workflow', text: ACK_TEXT });
}

async function sweepAt(when) {
  jest.setSystemTime(when);
  await runDueWorkflowNudges(when);
  const parks = await ticketParkService.sweep({ now: new Date() });
  // Audit S1: the Auto-help queue has its own tick (never inside the park sweep).
  await intake.tick({ now: new Date() });
  return parks;
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.clearAllMocks();
  outbox.length = 0;
  workflowEvents.length = 0;
  autoHelpEvents.length = 0;
  pendingWorkflowNudges.length = 0;
  runCalls = [];
  setAutoHelpEventEmitter((type) => { autoHelpEvents.push(type); });
  intake.autoDrain = false;
  ticketParkService._ahPass = 1; // the sweep's catch-up runs on passes 1, 6, 11 … — not by default here
  jest.spyOn(runner, 'runForTicket').mockImplementation(fakeRunForTicket);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  setAutoHelpEventEmitter(null);
});

// Arrivals: Monday 28 Sep 2026 10:00 (business hours) and 22:30 (after hours; morning drain Tue 08:02).
const SCENARIOS = [];
for (const hours of ['business', 'after']) {
  for (const origin of ['ticketpulse', 'freshservice']) {
    for (const priorityAtNight of [true, false]) {
      if (hours === 'business' && !priorityAtNight) continue; // the night switch only matters after hours
      SCENARIOS.push({ hours, origin, priorityAtNight });
    }
  }
}

describe('W6 timelines (approve mode — auto sending is locked in this build)', () => {
  test.each(SCENARIOS)('$hours hours · $origin-born · priority at night $priorityAtNight', async ({ hours, origin, priorityAtNight }) => {
    seed({ origin });
    const arrive = hours === 'business' ? PDT('2026-09-28T10:00:00') : PDT('2026-09-28T22:30:00');
    const cal = await businessCalendarService.loadCalendar(1);
    const inHours = (await businessCalendarService.nextBusinessInstant(arrive, { workspaceId: 1, calendar: cal })).getTime() === arrive.getTime();
    expect(inHours).toBe(hours === 'business');

    const pending = await ticketArrives(arrive, origin);
    expect(pending).toBeNull(); // approve mode: the ack is never held back
    let expectedSettles = 0;
    if (inHours) {
      await pipelineSettles(new Date(arrive.getTime() + 49e3), { provisional: false });
      expectedSettles = 1;
    } else {
      if (priorityAtNight) {
        await pipelineSettles(new Date(arrive.getTime() + 40e3), { provisional: true });
        expectedSettles += 1;
      }
      const morning = await businessCalendarService.nextBusinessInstant(arrive, { workspaceId: 1, calendar: cal });
      expect(morning.toISOString()).toBe(PDT('2026-09-29T08:00:00').toISOString());
      await pipelineSettles(new Date(morning.getTime() + 120e3), { provisional: false });
      expectedSettles += 1;
    }

    // Auto-help ran ONCE (the morning settle kept the night draft), one job per settle, all done.
    expect(runCalls).toHaveLength(1);
    expect(rows('autoHelpJob')).toHaveLength(expectedSettles);
    expect(rows('autoHelpJob').every((j) => j.status === 'done')).toBe(true);
    expect(rows('autoHelpRun')[0]).toMatchObject({ status: 'staged', gateDecision: 'staged_for_agent' });
    expect(rows('autoHelpRun')[0].outcomeDetail.settle.provisional).toBe(!inHours && priorityAtNight);
    // Nothing reached the requester but the ack: a staged answer waits for an agent.
    expect(kinds()).toEqual(['ack']);

    // An agent sends it (next business hour after the settle).
    const sendAt = inHours ? PDT('2026-09-28T10:20:00') : PDT('2026-09-29T09:00:00');
    jest.setSystemTime(sendAt);
    const proposal = rows('ticketProposedReply')[0];
    await proposals.send(55, 1, proposal.id, {}, AGENT);
    expect(kinds()).toEqual(['ack', 'answer']);
    expect(ticket()).toMatchObject({ status: 'Pending', parkKind: 'auto_help', replyOwner: 'auto_help' });
    expect((await pipelineContextFor(55))).toMatchObject({ sent: true, requesterReplied: false });

    // The week goes by with nobody writing back: a check-in, then the close. The generic
    // Follow-up nudge (24 h after the answer, again after the check-in) never fires.
    for (let d = 0; d < 8; d += 1) {
      await sweepAt(new Date(sendAt.getTime() + d * 86400e3 + 3600e3));
    }
    expect(kinds()).toEqual(['ack', 'answer', 'check-in']);
    expect(pendingWorkflowNudges.every((n) => n.done)).toBe(true);
    expect(ticket()).toMatchObject({ status: 'Resolved', resolvedByKind: 'auto_help', parkKind: null });
    expect(rows('autoHelpRun')[0].outcome).toBe('resolved_silence');

    // Order: ack < answer < check-in, strictly.
    const at = outbox.map((m) => m.at.getTime());
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Workflow triggers along the way (one each).
    expect(autoHelpEvents).toEqual(['auto_help.staged', 'auto_help.answered', 'auto_help.nudged', 'auto_help.resolved']);
  });
});

describe('W6 night → morning recategorization', () => {
  test('the staged night draft is withdrawn in the morning and one re-run stages on the new category; the requester got only the ack', async () => {
    seed({ origin: 'ticketpulse' });
    await ticketArrives(PDT('2026-09-28T22:30:00'), 'ticketpulse');
    await pipelineSettles(PDT('2026-09-28T22:30:40'), { provisional: true, categoryId: 10 });
    const night = rows('autoHelpRun')[0];
    expect(night.status).toBe('staged');
    await pipelineSettles(PDT('2026-09-29T08:02:00'), { provisional: false, categoryId: 20 });
    expect(rows('autoHelpRun').find((r) => r.id === night.id)).toMatchObject({ outcome: 'withdrawn' });
    expect(rows('ticketProposedReply').find((p) => p.autoHelpRunId === night.id).status).toBe('dismissed');
    expect(runCalls).toHaveLength(2);
    expect(runCalls[1].settle).toMatchObject({ rerunOf: night.id, categoryId: 20 });
    const open = rows('ticketProposedReply').filter((p) => p.status === 'proposed');
    expect(open).toHaveLength(1);
    expect(open[0].autoHelpRunId).not.toBe(night.id);
    expect(kinds()).toEqual(['ack']);
    expect(autoHelpEvents).toEqual(['auto_help.staged', 'auto_help.staged']);
  });
});

describe('W6 lost trigger', () => {
  test('a settle the queue never got is recovered by the catch-up sweep, and Auto-help runs once', async () => {
    seed({ origin: 'ticketpulse' });
    await ticketArrives(PDT('2026-09-28T10:00:00'), 'ticketpulse');
    await pipelineSettles(PDT('2026-09-28T10:00:49'), { provisional: false, lose: true });
    expect(rows('autoHelpJob')).toHaveLength(0);
    expect(runCalls).toHaveLength(0);
    intake._pass = 0; // next tick runs the catch-up
    await sweepAt(PDT('2026-09-28T10:01:30'));
    expect(rows('autoHelpJob')).toHaveLength(1);
    expect(rows('autoHelpJob')[0]).toMatchObject({ status: 'done', dedupeKey: 'settle:55:final' });
    expect(rows('autoHelpJob')[0].payload.recovered).toBe(true);
    expect(runCalls).toHaveLength(1);
    // A second catch-up pass finds it decided: nothing more.
    intake._pass = 0;
    await sweepAt(PDT('2026-09-28T10:07:00'));
    expect(runCalls).toHaveLength(1);
  });
});

describe('W6 queue under two workers (morning drain burst)', () => {
  test('two containers draining the same settles run each ticket once', async () => {
    seed({ origin: 'ticketpulse' });
    for (const id of [56, 57, 58]) rows('ticket').push({ ...ticket(), id, replyOwner: null });
    jest.setSystemTime(PDT('2026-09-29T08:02:00'));
    for (const id of [55, 56, 57, 58]) {
      Object.assign(rows('ticket').find((t) => t.id === id), { internalCategoryId: 10 });
      await intake.enqueue({ workspaceId: 1, ticketId: id, extra: { provisional: false, source: 'pipeline', decision: 'pending_review' } });
    }
    const { AutoHelpIntakeService } = await import('../src/services/autoHelpIntakeService.js');
    const a = new AutoHelpIntakeService();
    const b = new AutoHelpIntakeService();
    a.autoDrain = false; b.autoDrain = false;
    const now = PDT('2026-09-29T08:02:01');
    await Promise.all([a.drain({ now }), b.drain({ now })]);
    expect(runCalls).toHaveLength(4);
    expect(rows('autoHelpRun')).toHaveLength(4);
    expect(rows('ticketProposedReply').filter((p) => p.status === 'proposed')).toHaveLength(4);
  });
});

describe('W6 ack merge (auto sending stubbed ON — locked in this build)', () => {
  beforeEach(() => {
    jest.spyOn(playbookService, 'autoModeAllowed').mockReturnValue(true);
  });

  test('business hours, TP-born: the ack waits and rides on top of the auto-sent answer — ONE e-mail', async () => {
    seed({ origin: 'ticketpulse', mode: 'auto' });
    const pending = await ticketArrives(PDT('2026-09-28T10:00:00'), 'ticketpulse');
    expect(pending).not.toBeNull();
    expect(kinds()).toEqual([]);
    await pipelineSettles(PDT('2026-09-28T10:00:49'), { provisional: false });
    expect(kinds()).toEqual(['answer']);
    expect(outbox[0].text.startsWith(ACK_TEXT)).toBe(true);
    expect(outbox[0].text).toContain('This is an automated first answer from the IT team.');
    expect(outbox[0].text).toContain('Search for Bluebeam Revu and choose Install.');
    await ackWorkflowWakes(pending);
    expect(kinds()).toEqual(['answer']); // the ack is not sent again
    expect(rows('autoHelpPendingAck')[0]).toMatchObject({ status: 'consumed' });
    // An auto-sent answer never stops the first-response clock (Vahid) unless the workspace opts in.
    const [, , , actor, , opts] = ticketServiceMock.addReply.mock.calls[0];
    expect(actor.role).toBe('automation');
    expect(opts).toMatchObject({ replyOwner: { kind: 'auto_help' }, automatedReply: { kind: 'answer', countsAsFirstResponse: false } });
  });

  test('after hours without the night run: the ack waits 5 minutes, then goes alone; the morning answer is a second e-mail', async () => {
    seed({ origin: 'ticketpulse', mode: 'auto' });
    const pending = await ticketArrives(PDT('2026-09-28T22:30:00'), 'ticketpulse');
    await ackWorkflowWakes(pending);
    expect(kinds()).toEqual(['ack']);
    expect(rows('autoHelpPendingAck')[0].status).toBe('released');
    await pipelineSettles(PDT('2026-09-29T08:02:00'), { provisional: false });
    expect(kinds()).toEqual(['ack', 'answer']);
    expect(outbox[1].text.startsWith(ACK_TEXT)).toBe(false);
  });

  test('FS-born: FreshService acks on its own — nothing is held; the answer is its own e-mail', async () => {
    seed({ origin: 'freshservice', mode: 'auto' });
    const pending = await ticketArrives(PDT('2026-09-28T10:00:00'), 'freshservice');
    expect(pending).toBeNull();
    await pipelineSettles(PDT('2026-09-28T10:00:49'), { provisional: false });
    expect(kinds()).toEqual(['ack', 'answer']);
    expect(rows('autoHelpPendingAck')).toHaveLength(0);
  });
});
