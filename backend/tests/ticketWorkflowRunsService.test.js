import { jest } from '@jest/globals';

/**
 * QA 11-05 #9 — workflow runs on the ticket's Activity tab. The summary says
 * what a run did (e-mailed, set the status, added a note), whether it was
 * Shadow, and why it stopped; it never reads e-mail bodies, and a failed read
 * only hides the rows.
 */

const prismaMock = {
  notificationWorkflowRun: { findMany: jest.fn() },
  $queryRaw: jest.fn(),
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));

const { summarizeWorkflowRun, listTicketWorkflowRuns } = await import('../src/services/ticketWorkflowRunsService.js');

const RUN = {
  id: 11, workflowId: 3, eventType: 'ticket.created', status: 'completed', executionMode: 'live', dryRun: false,
  triggerSource: 'ticketpulse_native', startedAt: new Date('2026-11-05T21:02:09.118Z'), completedAt: new Date('2026-11-05T21:02:09.471Z'),
  durationMs: 355, error: null, workflow: { name: 'New ticket acknowledgement' },
};
const step = (nodeType, extra = {}) => ({ nodeId: nodeType, nodeType, status: 'completed', durationMs: 5, error: null, ...extra });

beforeEach(() => jest.clearAllMocks());

describe('summarizeWorkflowRun', () => {
  test('a live run that e-mailed reads as acted, with the recipient count', () => {
    const s = summarizeWorkflowRun(RUN, [step('trigger'), step('send_email', { toCount: 1, ccCount: 1, mocked: 'false', skipped: 'false' })]);
    expect(s).toMatchObject({ workflowName: 'New ticket acknowledgement', outcome: 'acted', shadow: false, stopReason: null });
    expect(s.actions).toEqual([{ type: 'email', to: 1, cc: 1, sent: true, reason: null }]);
  });

  test('a Shadow run is flagged and its e-mail is not sent', () => {
    const s = summarizeWorkflowRun({ ...RUN, executionMode: 'mock', dryRun: true }, [step('send_email', { toCount: 1, mocked: 'true', skipped: 'true', reason: 'Shadow - email not sent' })]);
    expect(s.shadow).toBe(true);
    expect(s.actions[0]).toMatchObject({ type: 'email', sent: false, reason: 'Shadow - email not sent' });
  });

  test('a run that stopped on a condition says why, and does not count the stop as an action', () => {
    const s = summarizeWorkflowRun(RUN, [
      step('condition', { passed: 'false', summary: 'Ticket source is Phone (this ticket: Email)' }),
      step('stop', { reason: 'Noise ticket skipped' }),
    ]);
    expect(s).toMatchObject({ outcome: 'stopped', stopReason: 'Noise ticket skipped', stopCause: 'Did not pass: Ticket source is Phone (this ticket: Email)', actions: [] });
  });

  test('the closing stop after an action is not a stop reason', () => {
    const s = summarizeWorkflowRun(RUN, [step('update_ticket', { updated: { status: { from: 'Pending', to: 'Open' } } }), step('stop', { reason: 'Workflow stopped' })]);
    expect(s).toMatchObject({ outcome: 'acted', stopReason: null });
    expect(s.actions).toEqual([{ type: 'update', fields: ['status'], status: { from: 'Pending', to: 'Open' }, assignedTo: null }]);
  });

  test('an assignment by a workflow names the person; a failed run carries its error', () => {
    const a = summarizeWorkflowRun(RUN, [step('update_ticket', { updated: {}, assignmentAssigned: 'true', assignmentTechName: 'Alex Rivera' })]);
    expect(a.actions[0]).toMatchObject({ type: 'update', assignedTo: 'Alex Rivera' });
    const f = summarizeWorkflowRun({ ...RUN, status: 'failed', error: 'x'.repeat(900) }, [step('template_render', { status: 'failed' })]);
    expect(f.outcome).toBe('failed');
    expect(f.error).toHaveLength(300);
  });

  test('steps carry only the small fields — never a body', () => {
    const s = summarizeWorkflowRun(RUN, [step('send_email', { toCount: 2, htmlBody: '<p>secret</p>', textBody: 'secret' })]);
    expect(JSON.stringify(s)).not.toMatch(/secret/);
    expect(Object.keys(s.steps[0]).sort()).toEqual(['durationMs', 'error', 'nodeId', 'nodeType', 'note', 'status']);
  });
});

describe('listTicketWorkflowRuns', () => {
  test('reads the newest 50 for the ticket without selecting step output, then the small step keys', async () => {
    prismaMock.notificationWorkflowRun.findMany.mockResolvedValue([RUN]);
    prismaMock.$queryRaw.mockResolvedValue([{ runId: 11, ...step('send_email', { toCount: 1, mocked: 'false', skipped: 'false' }) }]);
    const rows = await listTicketWorkflowRuns(500);
    const args = prismaMock.notificationWorkflowRun.findMany.mock.calls[0][0];
    expect(args).toMatchObject({ where: { ticketId: 500 }, orderBy: { startedAt: 'desc' }, take: 50 });
    expect(args.select.steps).toBeUndefined();
    expect(args.select.eventContext).toBeUndefined();
    const sql = prismaMock.$queryRaw.mock.calls[0][0].join('?');
    expect(sql).not.toMatch(/htmlBody|textBody|'llm'|'email'/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 11, outcome: 'acted' });
  });

  test('a failed read hides the rows instead of failing the page', async () => {
    prismaMock.notificationWorkflowRun.findMany.mockRejectedValue(new Error('relation does not exist'));
    await expect(listTicketWorkflowRuns(500)).resolves.toEqual([]);
    prismaMock.notificationWorkflowRun.findMany.mockResolvedValue([RUN]);
    prismaMock.$queryRaw.mockRejectedValue(new Error('timeout'));
    const rows = await listTicketWorkflowRuns(500);
    expect(rows[0]).toMatchObject({ id: 11, outcome: 'nothing', steps: [] });
    await expect(listTicketWorkflowRuns('abc')).resolves.toEqual([]);
  });
});
