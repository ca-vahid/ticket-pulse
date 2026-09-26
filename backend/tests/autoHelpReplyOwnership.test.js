import { jest } from '@jest/globals';
import { createFakePrisma } from './helpers/fakePrismaStore.js';

/**
 * Auto-help integration W2 (plans/AUTO_HELP_INTEGRATION_PLAN.md B): one owner
 * of the first reply — agent > auto_help (grounded answer) > workflow_draft —
 * written under the per-ticket proposal lock; a workflow propose_reply never
 * replaces a higher owner; an agent's own reply supersedes a staged Auto-help
 * answer and the run records outcome 'superseded_by'.
 */
let db;
const prismaProxy = new Proxy({}, { get: (_t, prop) => db[prop] });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaProxy }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { addReply: jest.fn() } }));

const owner = await import('../src/services/autoHelpReplyOwner.js');
const { default: proposals } = await import('../src/services/ticketProposedReplyService.js');

function seed(ticket = {}) {
  db = createFakePrisma({
    ticket: [{ id: 55, workspaceId: 1, replyOwner: null, replyOwnerRef: null, firstPublicAgentReplyAt: null, ...ticket }],
    autoHelpRun: [{ id: 901, workspaceId: 1, ticketId: 55, status: 'staged', decision: null, outcome: null, outcomeDetail: { history: [] } }],
  });
  const m = db.ticketProposedReply;
  const create = m.create;
  m.create = async (args) => create({ ...args, data: { status: 'proposed', ...args.data } });
}
const rows = (n) => db._rows(n);
const ticket = () => rows('ticket')[0];

beforeEach(() => seed());

describe('ranks', () => {
  test('agent > auto_help > workflow_draft; equal rank may replace', () => {
    expect(owner.mayClaim('agent', 'auto_help')).toBe(true);
    expect(owner.mayClaim('auto_help', 'workflow_draft')).toBe(true);
    expect(owner.mayClaim('auto_help', null)).toBe(true);
    expect(owner.mayClaim('workflow_draft', 'auto_help')).toBe(false);
    expect(owner.mayClaim('workflow_draft', 'agent')).toBe(false);
    expect(owner.mayClaim('auto_help', 'agent')).toBe(false);
    expect(owner.mayClaim('workflow_draft', 'workflow_draft')).toBe(true);
    expect(owner.mayClaim('nobody', null)).toBe(false);
  });

  test('claimReplyOwner refuses a lower owner and records a higher one', async () => {
    expect((await owner.claimReplyOwner(55, 'auto_help', 'run:901')).claimed).toBe(true);
    expect(ticket()).toMatchObject({ replyOwner: 'auto_help', replyOwnerRef: 'run:901' });
    expect((await owner.claimReplyOwner(55, 'workflow_draft', 'proposal:1')).claimed).toBe(false);
    expect(ticket().replyOwner).toBe('auto_help');
    expect((await owner.claimReplyOwner(55, 'agent', 'entry:5')).claimed).toBe(true);
    expect(ticket()).toMatchObject({ replyOwner: 'agent', replyOwnerRef: 'entry:5' });
  });

  test('the claim runs under the per-ticket advisory lock (same namespace as proposals)', async () => {
    const queryRaw = jest.fn(async () => [{ locked: 1 }]);
    const tx = new Proxy({}, { get: (_t, p) => (p === '$queryRaw' ? queryRaw : db[p]) });
    const realTx = db.$transaction;
    const spy = jest.fn(async (fn) => fn(tx));
    db = new Proxy(db, { get: (t, p) => (p === '$transaction' ? spy : t[p]) });
    await owner.claimReplyOwner(55, 'auto_help', 'run:901');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const values = queryRaw.mock.calls[0].slice(1);
    expect(values).toEqual([owner.REPLY_LOCK_NAMESPACE, 55]);
    expect(realTx).toBeDefined();
  });
});

describe('proposals yield to a higher owner', () => {
  test('an Auto-help staging takes the first reply; a later workflow draft yields and supersedes nothing', async () => {
    const staged = await proposals.create({ workspaceId: 1, ticketId: 55, source: 'auto_help', autoHelpRunId: 901, bodyHtml: '<p>a</p>', supersede: false });
    expect(staged.id).toBeTruthy();
    expect(ticket()).toMatchObject({ replyOwner: 'auto_help', replyOwnerRef: 'run:901' });
    const wf = await proposals.create({ workspaceId: 1, ticketId: 55, workflowRunId: 3, bodyHtml: '<p>workflow</p>' });
    expect(wf).toBeNull();
    expect(rows('ticketProposedReply')).toHaveLength(1);
    expect(rows('ticketProposedReply')[0].status).toBe('proposed');
    expect(ticket().replyOwner).toBe('auto_help');
  });

  test('a workflow draft takes an empty first reply; Auto-help then waits (open draft = clearable skip)', async () => {
    const wf = await proposals.create({ workspaceId: 1, ticketId: 55, workflowRunId: 3, bodyHtml: '<p>workflow</p>' });
    expect(ticket()).toMatchObject({ replyOwner: 'workflow_draft', replyOwnerRef: `proposal:${wf.id}` });
    const staged = await proposals.create({ workspaceId: 1, ticketId: 55, source: 'auto_help', autoHelpRunId: 901, bodyHtml: '<p>a</p>', supersede: false });
    expect(staged).toBeNull();
    // Dismissing the workflow draft gives the first reply back.
    await proposals.dismiss(55, 1, wf.id, { email: 'a@x.io' });
    expect(ticket().replyOwner).toBeNull();
    const again = await proposals.create({ workspaceId: 1, ticketId: 55, source: 'auto_help', autoHelpRunId: 901, bodyHtml: '<p>a</p>', supersede: false });
    expect(again.id).toBeTruthy();
    expect(ticket().replyOwner).toBe('auto_help');
  });

  test('an agent owns the first reply: Auto-help never stages over it', async () => {
    seed({ replyOwner: 'agent', replyOwnerRef: 'entry:9' });
    const staged = await proposals.create({ workspaceId: 1, ticketId: 55, source: 'auto_help', autoHelpRunId: 901, bodyHtml: '<p>a</p>', supersede: false });
    expect(staged).toBeNull();
    expect(ticket().replyOwner).toBe('agent');
  });

  test('after the first reply went out, a workflow draft (e.g. a low-confidence resolution summary) is still allowed and the owner stays', async () => {
    seed({ replyOwner: 'agent', replyOwnerRef: 'entry:9', firstPublicAgentReplyAt: new Date() });
    const wf = await proposals.create({ workspaceId: 1, ticketId: 55, source: 'auto_send_downgrade', bodyHtml: '<p>summary</p>' });
    expect(wf.id).toBeTruthy();
    expect(ticket()).toMatchObject({ replyOwner: 'agent', replyOwnerRef: 'entry:9' });
  });
});

describe("an agent's own reply", () => {
  test('supersedes a staged Auto-help answer nobody sent: proposal dismissed, run outcome superseded_by, activity line', async () => {
    await proposals.create({ workspaceId: 1, ticketId: 55, source: 'auto_help', autoHelpRunId: 901, bodyHtml: '<p>a</p>', supersede: false });
    const res = await owner.claimForAgentReply(55, { entryId: 4242, actor: { name: 'Dana Agent', email: 'dana@example.com' } });
    expect(res.superseded).toEqual([901]);
    expect(ticket()).toMatchObject({ replyOwner: 'agent', replyOwnerRef: 'entry:4242' });
    expect(rows('ticketProposedReply')[0]).toMatchObject({ status: 'dismissed', decidedBy: 'superseded_by_agent' });
    const run = rows('autoHelpRun')[0];
    expect(run.outcome).toBe('superseded_by');
    expect(run.outcomeDetail.supersededBy).toMatchObject({ by: 'agent', entryId: 4242, actorName: 'Dana Agent' });
    await new Promise((r) => setImmediate(r));
    expect(rows('ticketActivity').map((a) => a.activityType)).toContain('auto_help_superseded');
  });

  test('never touches an answer that is being sent or was sent (the one-click send is not a supersede)', async () => {
    await proposals.create({ workspaceId: 1, ticketId: 55, source: 'auto_help', autoHelpRunId: 901, bodyHtml: '<p>a</p>', supersede: false });
    rows('ticketProposedReply')[0].status = 'sending';
    const res = await owner.claimForAgentReply(55, { entryId: 1 });
    expect(res.superseded).toEqual([]);
    expect(rows('autoHelpRun')[0].outcome).toBeNull();
    // A decided run is never marked superseded either.
    rows('autoHelpRun')[0].decision = 'agent_sent';
    expect(await owner.markRunSuperseded(901, { by: 'agent' })).toBe(false);
  });
});
