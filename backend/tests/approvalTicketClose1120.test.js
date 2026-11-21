import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

/**
 * 20 Nov 2026 (product owner): "If a ticket has an approval but it is closed,
 * assume that the approval was decided another way, so remove it and mark it
 * as not needed any more."
 *
 * A ticket whose status base becomes Closed ends its open approvals (pending,
 * info_requested) as closed / not_needed / decidedVia ticket_closed, quietly:
 * no e-mail, no Teams message, no workflow event. One history row; existing
 * Teams cards are refreshed in place. Resolved does not count.
 */

// ---- a tiny in-memory database --------------------------------------------
const db = { approvals: [], tickets: [], activities: [] };
const inList = (cond, v) => (cond && Array.isArray(cond.in) ? cond.in.includes(v) : true);
function matchApproval(a, where = {}) {
  if (where.ticketId !== undefined && a.ticketId !== where.ticketId) return false;
  if (where.workspaceId !== undefined && a.workspaceId !== where.workspaceId) return false;
  if (typeof where.status === 'string' ? a.status !== where.status : (where.status && !inList(where.status, a.status))) return false;
  if (where.decidedVia !== undefined && a.decidedVia !== where.decidedVia) return false;
  if (where.decidedAt instanceof Date && !(a.decidedAt instanceof Date && a.decidedAt.getTime() === where.decidedAt.getTime())) return false;
  if (where.id && typeof where.id === 'object') {
    if (Array.isArray(where.id.in) && !where.id.in.includes(a.id)) return false;
    if (where.id.gt !== undefined && !(a.id > where.id.gt)) return false;
  }
  return true;
}
async function realUpdateMany({ where, data }) {
  let count = 0;
  for (const a of db.approvals) if (matchApproval(a, where)) { Object.assign(a, data); count += 1; }
  return { count };
}
const prismaMock = {
  ticketApproval: {
    findMany: jest.fn(async ({ where, take, select } = {}) => {
      const rows = db.approvals.filter((a) => matchApproval(a, where)).sort((x, y) => x.id - y.id).slice(0, take || 10000);
      return rows.map((a) => (select?.ticket ? { ...a, ticket: db.tickets.find((t) => t.id === a.ticketId) || null } : { ...a }));
    }),
    updateMany: jest.fn(async (args) => realUpdateMany(args)),
  },
  ticket: {
    findUnique: jest.fn(async ({ where }) => {
      const t = db.tickets.find((x) => x.id === where.id);
      return t ? { ...t } : null;
    }),
  },
};

const BASES = { Open: 'Open', Pending: 'Pending', Resolved: 'Resolved', Closed: 'Closed', 'Closed - duplicate': 'Closed' };
const resolveBaseStatus = jest.fn(async (_ws, name) => BASES[name] ?? null);
const activityCreate = jest.fn(async (row) => { db.activities.push(row); return { id: db.activities.length, ...row }; });

// Everything that could tell a person something — none of it may be called.
const sendTransactionalEmail = jest.fn();
const teams = { refreshApprovalCards: jest.fn(), notifyApproval: jest.fn(), notify: jest.fn(), notifyApprovalDecided: jest.fn() };
const push = { notifyApproval: jest.fn() };
const executeForEvent = jest.fn();
const assetronTouch = jest.fn();
const sseBroadcast = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { resolveBaseStatus, listStatuses: jest.fn(async () => []) },
  TERMINAL_BASE_STATUSES: ['Resolved', 'Closed'],
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: activityCreate } }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ sendTransactionalEmail, default: { sendTransactionalEmail } }));
jest.unstable_mockModule('../src/services/teamsNotificationService.js', () => ({ default: teams }));
jest.unstable_mockModule('../src/services/webPushService.js', () => ({ default: push }));
jest.unstable_mockModule('../src/services/assetronReservationService.js', () => ({ default: { touch: assetronTouch } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ sseManager: { broadcast: sseBroadcast } }));
jest.unstable_mockModule('../src/services/notificationWorkflowEngine.js', () => ({
  default: { executeForEvent, workspaceHasSentimentReader: jest.fn() },
}));
jest.unstable_mockModule('../src/services/reviewQueueSettleService.js', () => ({ default: { settleOnChange: jest.fn(async () => ({ settled: 0 })) } }));
jest.unstable_mockModule('../src/services/competencyFeedbackService.js', () => ({ default: { processTicketClosed: jest.fn(async () => null) } }));
jest.unstable_mockModule('../src/services/ticketReopenService.js', () => ({ default: { observeStatusTransition: jest.fn(async () => null) } }));
jest.unstable_mockModule('../src/services/hrLifecycleService.js', () => ({ default: { onTicketCreated: jest.fn(async () => null) } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const close = await import('../src/services/approvalTicketCloseService.js');
const { emitTicketLifecycleNotifications } = await import('../src/services/ticketLifecycleNotificationService.js');

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

function ticket(over = {}) {
  return { id: 65083, workspaceId: 1, status: 'Closed', origin: 'ticketpulse', nativeNumber: 10648, freshserviceTicketId: null, closedAt: new Date('2026-11-05T18:00:00Z'), ...over };
}
function approval(over = {}) {
  return {
    id: 173, ticketId: 65083, workspaceId: 1, status: 'pending', approverEmail: 'dana.fox@example.com', requestGroupId: 'grp-1',
    createdAt: new Date('2026-10-26T17:00:00Z'), closeReason: null, decidedVia: null, decidedAt: null, decisionNote: null, ...over,
  };
}
function seed({ tickets = [ticket()], approvals = [] } = {}) {
  db.tickets = tickets.map((t) => ({ ...t }));
  db.approvals = approvals.map((a) => ({ ...a }));
  db.activities = [];
}
const byId = (id) => db.approvals.find((a) => a.id === id);
function expectQuiet() {
  expect(sendTransactionalEmail).not.toHaveBeenCalled();
  expect(teams.notifyApproval).not.toHaveBeenCalled();
  expect(teams.notify).not.toHaveBeenCalled();
  expect(teams.notifyApprovalDecided).not.toHaveBeenCalled();
  expect(push.notifyApproval).not.toHaveBeenCalled();
  // No approval.decided (or any) workflow event: workflows would send mail.
  expect(executeForEvent).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('closing a ticket ends its open approvals, quietly', () => {
  test('pending and info_requested become closed / not_needed / ticket_closed, with the note', async () => {
    seed({
      tickets: [ticket({ status: 'Closed' })],
      approvals: [
        approval({ id: 173, status: 'info_requested', decisionNote: 'Which model?' }),
        approval({ id: 174, status: 'pending', approverEmail: 'eli.park@example.com' }),
      ],
    });
    const out = await close.closeApprovalsAfterStatusChange(ticket({ status: 'Open' }), ticket({ status: 'Closed' }), { source: 'ticketpulse_native' });
    await flush();

    expect(out.closed).toBe(2);
    for (const id of [173, 174]) {
      expect(byId(id)).toMatchObject({
        status: 'closed',
        closeReason: 'not_needed',
        decidedVia: 'ticket_closed',
        decisionNote: 'Not needed any more: the ticket was closed without a decision.',
        decisionNoteHtml: null,
      });
      expect(byId(id).decidedAt).toBeInstanceOf(Date);
    }
    // ONE history row for the ticket.
    expect(activityCreate).toHaveBeenCalledTimes(1);
    expect(activityCreate.mock.calls[0][0]).toMatchObject({
      ticketId: 65083,
      activityType: 'approval_closed',
      performedBy: 'Ticket Pulse',
      details: expect.objectContaining({
        via: 'ticket_closed', closeReason: 'not_needed', note: 'Approval no longer needed: the ticket was closed', approvalIds: [173, 174], closed: 2,
      }),
    });
    // Existing Teams cards follow the approval; nothing new is sent.
    expect(teams.refreshApprovalCards).toHaveBeenCalledWith(65083);
    expect(assetronTouch).toHaveBeenCalledWith('grp-1');
    expectQuiet();
  });

  test('a custom Closed-base status counts too', async () => {
    seed({ tickets: [ticket({ status: 'Closed - duplicate' })], approvals: [approval()] });
    const out = await close.closeApprovalsAfterStatusChange(ticket({ status: 'Resolved' }), ticket({ status: 'Closed - duplicate' }));
    expect(out.closed).toBe(1);
    expect(byId(173).status).toBe('closed');
  });

  test('Resolved does NOT close them (a resolved ticket can reopen)', async () => {
    seed({ tickets: [ticket({ status: 'Resolved' })], approvals: [approval()] });
    const out = await close.closeApprovalsAfterStatusChange(ticket({ status: 'Open' }), ticket({ status: 'Resolved' }));
    await flush();
    expect(out.closed).toBe(0);
    expect(byId(173).status).toBe('pending');
    expect(prismaMock.ticketApproval.findMany).not.toHaveBeenCalled();
    expect(prismaMock.ticketApproval.updateMany).not.toHaveBeenCalled();
    expect(activityCreate).not.toHaveBeenCalled();
    expect(teams.refreshApprovalCards).not.toHaveBeenCalled();
  });

  test('already-decided approvals are untouched', async () => {
    const decided = [
      approval({ id: 160, status: 'approved', decidedVia: 'app', decisionNote: 'Fine by me.' }),
      approval({ id: 161, status: 'rejected', decidedVia: 'link', decisionNote: 'Budget.' }),
      approval({ id: 162, status: 'cancelled', decidedVia: 'app' }),
      approval({ id: 163, status: 'escalated', decidedVia: 'app' }),
      approval({ id: 164, status: 'forwarded', decidedVia: 'app' }),
      approval({ id: 165, status: 'closed', closeReason: 'handled_otherwise', decidedVia: 'app' }),
    ];
    seed({ approvals: [...decided, approval({ id: 173, status: 'pending' })] });
    const before = JSON.parse(JSON.stringify(decided));
    const out = await close.closeApprovalsAfterStatusChange(ticket({ status: 'Pending' }), ticket({ status: 'Closed' }));
    expect(out.closed).toBe(1);
    expect(byId(173).decidedVia).toBe('ticket_closed');
    for (const row of before) expect(JSON.parse(JSON.stringify(byId(row.id)))).toEqual(row);
  });

  test('nothing open on the ticket: no write, no history row', async () => {
    seed({ approvals: [approval({ status: 'approved' })] });
    const out = await close.closeApprovalsAfterStatusChange(ticket({ status: 'Open' }), ticket({ status: 'Closed' }));
    expect(out.closed).toBe(0);
    expect(prismaMock.ticketApproval.updateMany).not.toHaveBeenCalled();
    expect(activityCreate).not.toHaveBeenCalled();
  });

  test('a ticket reopened before the hook ran keeps its approvals (fresh read)', async () => {
    seed({ tickets: [ticket({ status: 'Open' })], approvals: [approval()] });
    const out = await close.closeApprovalsAfterStatusChange(ticket({ status: 'Open' }), ticket({ status: 'Closed' }));
    expect(out).toMatchObject({ closed: 0 });
    expect(byId(173).status).toBe('pending');
  });

  test('the status did not move: nothing is read', async () => {
    seed({ approvals: [approval()] });
    await close.closeApprovalsAfterStatusChange(ticket({ status: 'Closed' }), ticket({ status: 'Closed' }));
    expect(resolveBaseStatus).not.toHaveBeenCalled();
    expect(prismaMock.ticketApproval.findMany).not.toHaveBeenCalled();
  });

  test('a row decided between the read and the write is not named in the history row or the result', async () => {
    seed({ approvals: [approval({ id: 173 }), approval({ id: 174, approverEmail: 'eli.park@example.com' })] });
    prismaMock.ticketApproval.updateMany.mockImplementationOnce(async (args) => {
      Object.assign(byId(174), { status: 'approved', decidedVia: 'app', decidedAt: new Date() }); // Eli approves that instant
      return realUpdateMany(args);
    });
    const out = await close.closeApprovalsAfterStatusChange(ticket({ status: 'Open' }), ticket({ status: 'Closed' }));
    expect(out.closed).toBe(1);
    expect(out.approvals.map((a) => a.approvalId)).toEqual([173]);
    expect(byId(174).status).toBe('approved');
    expect(activityCreate.mock.calls[0][0].details).toMatchObject({ approvalIds: [173], closed: 1 });
  });

  test('the close hands back its Assetron release and Teams refresh to wait on', async () => {
    let released = false;
    assetronTouch.mockImplementationOnce(() => new Promise((r) => setTimeout(() => { released = true; r(); }, 20)));
    seed({ approvals: [approval()] });
    const out = await close.closeApprovalsForClosedTicket(65083);
    expect(released).toBe(false); // not awaited by a person's click…
    await out.followUps; // …but available to wait on
    expect(released).toBe(true);
    expect(teams.refreshApprovalCards).toHaveBeenCalledWith(65083);
  });

  test('a database failure never reaches the caller', async () => {
    seed({ approvals: [approval()] });
    prismaMock.ticket.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(close.closeApprovalsAfterStatusChange(ticket({ status: 'Open' }), ticket({ status: 'Closed' }))).resolves.toMatchObject({ closed: 0 });
  });
});

describe('every road reports here: the lifecycle emitter', () => {
  test('an FS-born ticket closed in FreshService (sync, workflows off) closes its approvals', async () => {
    const fsTicket = ticket({ id: 70001, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 250001n, status: 'Closed' });
    seed({ tickets: [fsTicket], approvals: [approval({ id: 300, ticketId: 70001, status: 'pending', requestGroupId: null })] });
    await emitTicketLifecycleNotifications({
      existingTicket: { ...fsTicket, status: 'Open' }, upsertedTicket: fsTicket, source: 'freshservice_sync', allowNotificationWorkflows: false,
    });
    await flush();
    expect(byId(300)).toMatchObject({ status: 'closed', closeReason: 'not_needed', decidedVia: 'ticket_closed' });
    expect(activityCreate.mock.calls[0][0].details.source).toBe('freshservice_sync');
    expectQuiet();
  });

  test('a person closing a TP-born ticket in the app closes them too', async () => {
    seed({ approvals: [approval()] });
    await emitTicketLifecycleNotifications({
      existingTicket: ticket({ status: 'Resolved' }), upsertedTicket: ticket({ status: 'Closed' }), source: 'ticketpulse_native', allowNotificationWorkflows: false,
      actor: { name: 'Sam Okafor', email: 'sam.okafor@example.com', technicianId: 4 },
    });
    expect(byId(173).status).toBe('closed');
  });

  test('a resolve through the emitter leaves them open', async () => {
    seed({ tickets: [ticket({ status: 'Resolved' })], approvals: [approval()] });
    await emitTicketLifecycleNotifications({ existingTicket: ticket({ status: 'Open' }), upsertedTicket: ticket({ status: 'Resolved' }), source: 'freshservice_sync' });
    expect(byId(173).status).toBe('pending');
  });
});

describe('writers that bypass the lifecycle emitter call the hook themselves', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

  test('ticketService.updateFsTicket: a write-back told not to notify (a workflow\'s) still closes approvals', () => {
    const src = read('../src/services/ticketService.js');
    const fn = src.slice(src.indexOf('  async updateFsTicket('), src.indexOf('  async _handBackEvent('));
    expect(fn).toMatch(/if \(notifyLifecycle && \(changes\.status[\s\S]{0,200}_notifyLifecycle\([\s\S]{0,120}\} else if \(changes\.status\) \{[\s\S]{0,600}closeApprovalsAfterStatusChange\(ticket, updated, \{ source: 'freshservice_writeback' \}\)/);
  });

  test('ticketService.changeStatus reports to the lifecycle emitter (covers app, API, bulk, macros, auto-close)', () => {
    const src = read('../src/services/ticketService.js');
    const fn = src.slice(src.indexOf('  async changeStatus('), src.indexOf('  async assignTicket('));
    expect(fn).toContain('this._notifyLifecycle(ticket, updated,');
  });

  test('workflow update_ticket on a TP-born ticket (direct write)', () => {
    const src = read('../src/services/notificationWorkflowEngine.js');
    const write = src.indexOf('await prisma.ticket.update({ where: { id: ticket.id }, data: patch });');
    const hook = src.indexOf("closeApprovalsAfterStatusChange(ticket, { ...ticket, ...patch }, { source: 'workflow' })");
    expect(write).toBeGreaterThan(-1);
    expect(hook).toBeGreaterThan(write);
    expect(hook - write).toBeLessThan(2500);
  });

  test('syncService on-open reconcile (direct write)', () => {
    const src = read('../src/services/syncService.js');
    expect(src).toContain('if (statusChanged) await this._closeApprovalsOnClose(current, updated);');
    expect(src).toMatch(/async _closeApprovalsOnClose\(before, after\) \{[\s\S]{0,300}closeApprovalsAfterStatusChange\(before, after, \{ source: 'freshservice_reconcile' \}\)/);
  });

  test('the lifecycle emitter runs it before the workflow gate', () => {
    const src = read('../src/services/ticketLifecycleNotificationService.js');
    const hook = src.indexOf('await closeApprovalsOnClose(existingTicket, upsertedTicket, { source });');
    const gate = src.indexOf('if (!allowNotificationWorkflows) {');
    expect(hook).toBeGreaterThan(-1);
    expect(hook).toBeLessThan(gate);
  });
});

describe('the one-off sweep', () => {
  function seedSweep() {
    seed({
      tickets: [
        ticket({ id: 65083, nativeNumber: 10648, status: 'Closed' }),
        ticket({ id: 65090, nativeNumber: 10650, status: 'Resolved' }),
        ticket({ id: 65100, nativeNumber: 10660, status: 'Open' }),
        ticket({ id: 65200, workspaceId: 2, nativeNumber: 10700, status: 'Closed' }),
      ],
      approvals: [
        approval({ id: 173, ticketId: 65083, status: 'info_requested' }),
        approval({ id: 180, ticketId: 65090, status: 'pending' }),
        approval({ id: 181, ticketId: 65100, status: 'pending' }),
        approval({ id: 182, ticketId: 65083, status: 'approved' }),
        approval({ id: 190, ticketId: 65200, workspaceId: 2, status: 'pending', requestGroupId: 'grp-2' }),
      ],
    });
  }

  test('dry-run lists open approvals on Closed tickets and writes nothing', async () => {
    seedSweep();
    const out = await close.closeApprovalsOnClosedTickets({ dryRun: true });
    expect(out).toMatchObject({ dryRun: true, tickets: 2, closed: 0 });
    expect(out.approvals.map((a) => a.approvalId)).toEqual([173, 190]);
    expect(out.approvals[0]).toMatchObject({ ticketId: 65083, ticketRef: 'TP-10648', status: 'info_requested', ticketStatus: 'Closed' });
    expect(prismaMock.ticketApproval.updateMany).not.toHaveBeenCalled();
    expect(activityCreate).not.toHaveBeenCalled();
    expect(byId(173).status).toBe('info_requested');
  });

  test('dry-run is the default', async () => {
    seedSweep();
    const out = await close.closeApprovalsOnClosedTickets();
    expect(out.dryRun).toBe(true);
    expect(prismaMock.ticketApproval.updateMany).not.toHaveBeenCalled();
  });

  test('apply writes the same quiet close, one history row per ticket', async () => {
    seedSweep();
    const out = await close.closeApprovalsOnClosedTickets({ dryRun: false });
    await flush();
    expect(out).toMatchObject({ dryRun: false, tickets: 2, closed: 2 });
    expect(out.approvals.every((a) => a.applied)).toBe(true);
    expect(byId(173)).toMatchObject({ status: 'closed', closeReason: 'not_needed', decidedVia: 'ticket_closed' });
    expect(byId(190).status).toBe('closed');
    expect(byId(180).status).toBe('pending'); // Resolved ticket
    expect(byId(181).status).toBe('pending'); // Open ticket
    expect(byId(182).status).toBe('approved');
    expect(activityCreate).toHaveBeenCalledTimes(2);
    expect(activityCreate.mock.calls.map((c) => c[0].details.source)).toEqual(['sweep', 'sweep']);
    expectQuiet();
  });

  test('apply reports only the rows it actually closed', async () => {
    seedSweep();
    let first = true;
    prismaMock.ticketApproval.updateMany.mockImplementation(async (args) => {
      if (first) { first = false; Object.assign(byId(173), { status: 'approved', decidedVia: 'app', decidedAt: new Date() }); }
      return realUpdateMany(args);
    });
    const out = await close.closeApprovalsOnClosedTickets({ dryRun: false });
    prismaMock.ticketApproval.updateMany.mockImplementation(async (args) => realUpdateMany(args));
    expect(out.closed).toBe(1);
    expect(out.approvals.find((a) => a.approvalId === 173).applied).toBe(false);
    expect(out.approvals.find((a) => a.approvalId === 190).applied).toBe(true);
    expect(activityCreate).toHaveBeenCalledTimes(1); // the ticket that lost its only open row gets no row
  });

  test('apply waits for the Assetron release before it returns', async () => {
    seedSweep();
    let released = false;
    assetronTouch.mockImplementation(() => new Promise((r) => setTimeout(() => { released = true; r(); }, 20)));
    await close.closeApprovalsOnClosedTickets({ dryRun: false });
    assetronTouch.mockImplementation(() => undefined);
    expect(released).toBe(true);
  });

  test('one workspace only', async () => {
    seedSweep();
    const out = await close.closeApprovalsOnClosedTickets({ workspaceId: 2, dryRun: false });
    expect(out.approvals.map((a) => a.approvalId)).toEqual([190]);
    expect(byId(173).status).toBe('info_requested');
  });
});
