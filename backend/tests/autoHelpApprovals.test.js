import { jest } from '@jest/globals';

// 30 Sep 2026 (Vahid): approve mode that scales — the assignee, reviewers and
// admins may send or dismiss an Auto-help answer; a Knowledge → Approvals
// queue; the assignee is told once; a reply sent in FreshService sets the
// waiting answer aside.

const prismaMock = {
  ticketProposedReply: { findMany: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn() },
  autoHelpRun: { findFirst: jest.fn(), update: jest.fn(async () => ({})) },
  autoHelpPlaybook: { findFirst: jest.fn(async () => null) },
  autoHelpSettings: { findUnique: jest.fn(async () => null) },
  workspace: { findUnique: jest.fn(async () => ({ name: 'IT' })) },
  $transaction: jest.fn(async (ops) => (typeof ops === 'function' ? ops(prismaMock) : Promise.all(ops))),
};
const sendTransactionalEmail = jest.fn(async () => ({ sent: true, via: 'graph' }));
const claimForAgentReply = jest.fn(async () => ({ superseded: [901] }));
const activityCreate = jest.fn(async () => ({}));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ sendTransactionalEmail }));
jest.unstable_mockModule('../src/services/autoHelpReplyOwner.js', () => ({ claimForAgentReply, mayClaim: () => true }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: activityCreate } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));

const { default: delivery, canApproveAutoHelp } = await import('../src/services/autoHelpDeliveryService.js');
const { AuthorizationError } = await import('../src/utils/errors.js');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketProposedReply.updateMany.mockResolvedValue({ count: 1 });
});

describe('who may approve', () => {
  const ticket = { assignedTechId: 42 };
  test.each([
    ['global admin', { role: 'admin' }, true],
    ['workspace admin', { role: 'user', workspaceRole: 'admin' }, true],
    ['reviewer', { role: 'user', workspaceRole: 'reviewer' }, true],
    ['auto mode', { role: 'automation' }, true],
    ['the assignee with basic access', { role: 'user', workspaceRole: null, technicianId: 42 }, true],
    ['the assignee who is read-only', { role: 'user', workspaceRole: 'readonly', technicianId: 42 }, true],
    ['a standard member who is not the assignee', { role: 'user', workspaceRole: 'viewer', technicianId: 7 }, false],
    ['a read-only member', { role: 'user', workspaceRole: 'readonly' }, false],
    ['another technician', { role: 'user', technicianId: 7 }, false],
    ['nobody', null, false],
  ])('%s', (_label, actor, expected) => {
    expect(canApproveAutoHelp(actor, ticket)).toBe(expected);
  });

  test('an unassigned ticket: only reviewers and admins', () => {
    expect(canApproveAutoHelp({ role: 'user', technicianId: 42 }, { assignedTechId: null })).toBe(false);
    expect(canApproveAutoHelp({ role: 'user', workspaceRole: 'reviewer' }, { assignedTechId: null })).toBe(true);
  });

  test('dismiss is refused for someone who may not approve, and nothing changes', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ assignedTechId: 42 });
    await expect(delivery.dismissProposal({
      ticketId: 5, workspaceId: 1, proposal: { id: 9, autoHelpRunId: 901 }, reason: 'wrong_answer', actor: { role: 'user', workspaceRole: 'viewer', technicianId: 7 },
    })).rejects.toThrow(AuthorizationError);
    expect(prismaMock.ticketProposedReply.updateMany).not.toHaveBeenCalled();
  });

  test('the assignee may dismiss', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ assignedTechId: 42 });
    prismaMock.autoHelpRun.findFirst.mockResolvedValueOnce({ id: 901, decision: null, outcomeDetail: {} });
    prismaMock.ticketProposedReply.findFirst.mockResolvedValueOnce({ id: 9, status: 'dismissed' });
    await delivery.dismissProposal({
      ticketId: 5, workspaceId: 1, proposal: { id: 9, autoHelpRunId: 901 }, reason: 'wrong_answer', actor: { role: 'user', technicianId: 42, email: 'a@x.io' },
    });
    expect(prismaMock.ticketProposedReply.updateMany).toHaveBeenCalled();
  });
});

describe('approvals queue', () => {
  test('lists waiting answers with their ticket; a ticket outside the workspace is left out', async () => {
    prismaMock.ticketProposedReply.findMany.mockResolvedValueOnce([
      { id: 9, ticketId: 5, source: 'auto_help', status: 'proposed', autoHelpRunId: null, createdAt: new Date() },
      { id: 10, ticketId: 6, source: 'auto_help', status: 'proposed', autoHelpRunId: null, createdAt: new Date() },
    ]);
    prismaMock.ticket.findMany.mockResolvedValueOnce([{
      id: 5, subject: 'VPN drops', status: 'Open', priority: 2, origin: 'ticketpulse', nativeNumber: 1285, freshserviceTicketId: null, createdAt: new Date(),
      assignedTech: { id: 42, name: 'Dana Agent' }, requester: { name: 'Riley', email: 'r@x.io' },
    }]);
    const out = await delivery.listWaiting(1);
    expect(prismaMock.ticketProposedReply.findMany.mock.calls[0][0].where).toEqual({ workspaceId: 1, source: 'auto_help', status: { in: ['proposed', 'needs_check'] } });
    expect(out).toHaveLength(1);
    expect(out[0].ticket).toMatchObject({ id: 5, subject: 'VPN drops', assignee: { name: 'Dana Agent' }, requester: { name: 'Riley' } });
  });
});

describe('assignee notice', () => {
  const proposal = { id: 9, ticketId: 5, workspaceId: 1, autoHelpRunId: 901 };
  const ticket = { id: 5, subject: 'VPN drops', origin: 'ticketpulse', nativeNumber: 1285, assignedTechId: 42, assignedTech: { id: 42, name: 'Dana Agent', email: 'dana@x.io' } };

  test('tells the assignee once and remembers it on the run', async () => {
    prismaMock.ticketProposedReply.findMany.mockResolvedValueOnce([proposal]);
    prismaMock.ticket.findFirst.mockResolvedValueOnce(ticket);
    prismaMock.autoHelpRun.findFirst.mockResolvedValueOnce({ id: 901, outcomeDetail: { history: [] } });
    const res = await delivery.notifyWaitingAssignees();
    expect(res.sent).toBe(1);
    expect(sendTransactionalEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ['dana@x.io'], label: 'auto-help-assignee' }));
    expect(prismaMock.autoHelpRun.update.mock.calls[0][0].data.outcomeDetail.assigneeNotified).toEqual([42]);
    expect(activityCreate).toHaveBeenCalledWith(expect.objectContaining({ activityType: 'auto_help_assignee_told' }));
  });

  test('already told → no second e-mail', async () => {
    prismaMock.ticketProposedReply.findMany.mockResolvedValueOnce([proposal]);
    prismaMock.ticket.findFirst.mockResolvedValueOnce(ticket);
    prismaMock.autoHelpRun.findFirst.mockResolvedValueOnce({ id: 901, outcomeDetail: { assigneeNotified: [42] } });
    const res = await delivery.notifyWaitingAssignees();
    expect(res.sent).toBe(0);
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  test('not assigned yet → nobody to tell (the queue covers it)', async () => {
    prismaMock.ticketProposedReply.findMany.mockResolvedValueOnce([proposal]);
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ ...ticket, assignedTechId: null, assignedTech: null });
    const res = await delivery.notifyWaitingAssignees();
    expect(res.sent).toBe(0);
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });
});

describe('a reply sent in FreshService', () => {
  test('sets the waiting answer aside as the agent\'s reply', async () => {
    prismaMock.ticketProposedReply.findMany.mockResolvedValueOnce([{ id: 9, ticketId: 5, createdAt: new Date('2026-09-30T10:00:00Z') }]);
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValueOnce({ id: 777, actorName: 'Dana Agent' });
    const res = await delivery.supersedeRepliedInFreshService();
    const where = prismaMock.ticketThreadEntry.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ ticketId: 5, eventType: 'public_reply', ticket: { origin: { not: 'ticketpulse' } } });
    expect(where.occurredAt.gt).toEqual(new Date('2026-09-30T10:00:00Z'));
    expect(claimForAgentReply).toHaveBeenCalledWith(5, { entryId: 777, actor: { name: 'Dana Agent' } });
    expect(res.setAside).toBe(1);
  });

  test('no newer reply → left alone', async () => {
    prismaMock.ticketProposedReply.findMany.mockResolvedValueOnce([{ id: 9, ticketId: 5, createdAt: new Date() }]);
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValueOnce(null);
    const res = await delivery.supersedeRepliedInFreshService();
    expect(claimForAgentReply).not.toHaveBeenCalled();
    expect(res.setAside).toBe(0);
  });
});
