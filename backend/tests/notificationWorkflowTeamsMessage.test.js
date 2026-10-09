import { jest } from '@jest/globals';

/**
 * send_teams_message (QA 10-08 #3): a Mail Workflow step that has the Ticket
 * Pulse bot message IT team members in Teams — first use: "nobody picked this
 * up for N hours, tell these people".
 */

const prismaMock = {
  technician: { findMany: jest.fn(), findFirst: jest.fn() },
  ticket: { groupBy: jest.fn(), findUnique: jest.fn() },
  ticketAssignmentEpisode: { groupBy: jest.fn() },
  group: { findFirst: jest.fn() },
  groupMember: { findMany: jest.fn() },
};
const sendWorkflowMessage = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/teamsNotificationService.js', () => ({ default: { sendWorkflowMessage } }));

const { executeSendTeamsMessageNode } = await import('../src/services/notificationWorkflowActionNodes.js');
const def = await import('../src/services/notificationWorkflowDefinition.js');

const member = (email, isActive = true) => ({ technician: { email, isActive } });
const node = (data) => ({ id: 'teams', type: 'send_teams_message', data: { bodyTemplate: 'x', ...data } });
const ctx = (extra = {}) => ({ ticket: { id: 77, displayRef: 'TP-77', workspaceId: 1, internalGroupId: null, groupId: null, ...extra.ticket }, assignedAgent: extra.assignedAgent || null, workspace: { id: 1 } });

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.groupMember.findMany.mockResolvedValue([]);
  prismaMock.group.findFirst.mockResolvedValue(null);
  sendWorkflowMessage.mockResolvedValue({ sent: 2, skipped: 0, failed: 0, firstError: null, off: null });
});

describe('who is told', () => {
  test('listed people + internal group members + the ticket group, each once, lower-cased', async () => {
    prismaMock.groupMember.findMany
      .mockResolvedValueOnce([member('Adrian@bgc.ca'), member('gone@bgc.ca', false)]) // internal_group:9
      .mockResolvedValueOnce([member('adrian@bgc.ca'), member('reza@bgc.ca')]);        // the ticket's group
    prismaMock.group.findFirst.mockResolvedValue({ id: 4 });
    const out = await executeSendTeamsMessageNode(
      node({ people: ['Vahid@bgc.ca', 'not-an-address'], groups: [9], roles: ['ticket_group', 'assigned_agent'] }),
      ctx({ ticket: { groupId: '1000210021' } }),
      { renderedTitle: 'Nobody has picked up TP-77', renderedBody: 'Unassigned for 4 hours.', workspaceId: 1, runId: 500 },
    );
    expect(sendWorkflowMessage).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 1, emails: ['vahid@bgc.ca', 'adrian@bgc.ca', 'reza@bgc.ca'], title: 'Nobody has picked up TP-77', body: 'Unassigned for 4 hours.',
      ticketId: 77, ticketRef: 'TP-77', includeTicketLink: true, refKey: 'wf:500:teams',
    }));
    expect(prismaMock.group.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 1, freshserviceId: 1000210021n } }));
    // Counts only: the run log never carries an address.
    expect(out).toEqual({ sent: 2, skippedPeople: 0, failedPeople: 0, recipients: 3 });
    expect(JSON.stringify(out)).not.toMatch(/@/);
  });

  test('an unassigned ticket with only "the assignee" to tell is a clean skip, not an error', async () => {
    const out = await executeSendTeamsMessageNode(node({ roles: ['assigned_agent'] }), ctx(), { renderedBody: 'hello', workspaceId: 1 });
    expect(out).toMatchObject({ skipped: true, reason: expect.stringMatching(/Nobody to tell/) });
    expect(sendWorkflowMessage).not.toHaveBeenCalled();
  });

  test('the group columns are read from the ticket when the event did not carry them', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ internalGroupId: 12, groupId: null });
    prismaMock.groupMember.findMany.mockResolvedValue([member('soheil@bgc.ca')]);
    await executeSendTeamsMessageNode(node({ roles: ['ticket_group'] }), { ticket: { id: 77, workspaceId: 1 }, workspace: { id: 1 } }, { renderedBody: 'hello', workspaceId: 1 });
    expect(prismaMock.groupMember.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { groupId: 12 } }));
    expect(sendWorkflowMessage.mock.calls[0][0].emails).toEqual(['soheil@bgc.ca']);
  });
});

describe('shadow, off and failure', () => {
  test('Shadow / preview resolves who it would tell and sends nothing', async () => {
    const out = await executeSendTeamsMessageNode(node({ people: ['a@bgc.ca', 'b@bgc.ca'] }), ctx(), { renderedTitle: 'T', renderedBody: 'B', workspaceId: 1, dryRun: true });
    expect(out).toEqual({ dryRun: true, wouldSend: { recipients: 2, title: 'T' } });
    expect(sendWorkflowMessage).not.toHaveBeenCalled();
  });

  test('Teams switched off for the workspace is a skip with the reason', async () => {
    sendWorkflowMessage.mockResolvedValue({ sent: 0, skipped: 0, failed: 0, off: 'Teams is switched off for this workspace (Settings → Teams)' });
    const out = await executeSendTeamsMessageNode(node({ people: ['a@bgc.ca'] }), ctx(), { renderedBody: 'B', workspaceId: 1 });
    expect(out).toEqual({ skipped: true, reason: 'Teams is switched off for this workspace (Settings → Teams)' });
  });

  test('some people could not be reached: the step succeeds and says how many; nobody reached: it throws for onError to decide', async () => {
    sendWorkflowMessage.mockResolvedValue({ sent: 1, skipped: 0, failed: 1, firstError: 'blocked by policy' });
    expect(await executeSendTeamsMessageNode(node({ people: ['a@bgc.ca', 'b@bgc.ca'] }), ctx(), { renderedBody: 'B', workspaceId: 1 }))
      .toEqual({ sent: 1, skippedPeople: 0, failedPeople: 1, recipients: 2, note: 'blocked by policy' });
    sendWorkflowMessage.mockResolvedValue({ sent: 0, skipped: 0, failed: 2, firstError: 'blocked by policy' });
    await expect(executeSendTeamsMessageNode(node({ people: ['a@bgc.ca', 'b@bgc.ca'] }), ctx(), { renderedBody: 'B', workspaceId: 1 })).rejects.toThrow('blocked by policy');
  });

  test('an empty message is a skip', async () => {
    expect(await executeSendTeamsMessageNode(node({ people: ['a@bgc.ca'] }), ctx(), { renderedBody: '   ', workspaceId: 1 })).toEqual({ skipped: true, reason: 'No message configured' });
  });
});

describe('definition', () => {
  const graph = (teamsData) => ({
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggerType: 'ticket.unassigned_for', unassignedHours: 4 } },
      { id: 'teams', type: 'send_teams_message', position: { x: 0, y: 100 }, data: teamsData },
      { id: 'stop', type: 'stop', position: { x: 0, y: 200 }, data: {} },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'teams' }, { id: 'e2', source: 'teams', target: 'stop' }],
  });
  const errorsOf = (data) => {
    const r = def.validateWorkflowDefinition(graph(data), { triggerType: 'ticket.unassigned_for' });
    return r?.success === false ? r.errors : [];
  };

  test('is a registered, non-terminal node and counts as the workflow action on its own', () => {
    expect(def.NOTIFICATION_NODE_TYPES).toContain('send_teams_message');
    expect(def.NOTIFICATION_NODE_REGISTRY.send_teams_message).toMatchObject({ terminal: false });
    expect(errorsOf({ bodyTemplate: 'Hello', people: ['a@bgc.ca'] })).toEqual([]);
  });

  test('needs a message and somebody to tell; caps the people list; checks onError', () => {
    expect(errorsOf({ bodyTemplate: ' ', people: ['a@bgc.ca'] }).join(' ')).toMatch(/needs a message/);
    expect(errorsOf({ bodyTemplate: 'Hello', people: [], groups: [], roles: [] }).join(' ')).toMatch(/needs somebody to tell/);
    expect(errorsOf({ bodyTemplate: 'Hello', roles: ['requester'] }).join(' ')).toMatch(/needs somebody to tell/);
    expect(errorsOf({ bodyTemplate: 'Hello', people: Array.from({ length: 26 }, (_, i) => `p${i}@bgc.ca`) }).join(' ')).toMatch(/too many people/);
    expect(errorsOf({ bodyTemplate: 'Hello', roles: ['ticket_group'], onError: 'explode' }).join(' ')).toMatch(/onError must be/);
    expect(errorsOf({ bodyTemplate: 'Hello', groups: [3] })).toEqual([]);
  });

  test('ships a ready-made "unassigned for N hours → Teams" template that validates', () => {
    const template = def.WORKFLOW_TEMPLATES.find((t) => t.key === 'unassigned_teams_alert');
    expect(template).toMatchObject({ triggerType: 'ticket.unassigned_for' });
    const built = template.build();
    expect(built.nodes.find((n) => n.type === 'send_teams_message').data).toMatchObject({ roles: ['ticket_group'], includeTicketLink: true });
    expect(def.validateWorkflowDefinition(built, { triggerType: template.triggerType })?.success).not.toBe(false);
  });
});
