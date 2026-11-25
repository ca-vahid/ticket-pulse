import { jest } from '@jest/globals';

/**
 * QA 11-24 item 11: "Intake mailbox" — which connected mailbox the ticket
 * came in through. Accounting skips the e-mail notifications for tickets that
 * arrived on the AR mailbox, not for AP. A ticket that did not come by e-mail
 * never "is" a mailbox and always "is not" one.
 */
const prismaMock = {
  notificationWorkflowRun: { create: jest.fn(), update: jest.fn() },
  notificationWorkflowStepRun: { create: jest.fn(), update: jest.fn() },
  notificationDelivery: { create: jest.fn() },
  notificationLlmToolPolicy: { findUnique: jest.fn() },
  notificationEmailSignature: { findUnique: jest.fn() },
  publicTicketStatusSettings: { upsert: jest.fn() },
  publicTicketStatusLink: { findUnique: jest.fn(), upsert: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  ticketLink: { findFirst: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn(), findFirst: jest.fn() },
  ticketActivity: { findFirst: jest.fn() },
  mailboxConnection: { findMany: jest.fn() },
};
const getMailboxAliases = jest.fn(async () => []);
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({ processDelivery: jest.fn() }));
jest.unstable_mockModule('../src/services/mailboxAliasService.js', () => ({ getMailboxAliases }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: engine } = await import('../src/services/notificationWorkflowEngine.js');
const { buildDefaultWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');
const { CONDITION_FIELDS, compileConditionGroup, validateConditionGroup } = await import('../src/services/notificationConditionModel.js');
const { RULE_FIELDS } = await import('../src/services/conditionRuleShared.js');
const {
  intakeMailboxFor, matchIntakeMailbox, mailboxConditionOptions, intakeMailboxRecord,
} = await import('../src/services/intakeMailboxService.js');

const AP = 'ap@example.com';
const AR = 'ar@example.com';

beforeEach(() => {
  jest.clearAllMocks();
  let stepId = 1000;
  prismaMock.notificationWorkflowRun.create.mockImplementation(({ data }) => Promise.resolve({ id: 900, ...data }));
  prismaMock.notificationWorkflowRun.update.mockResolvedValue({});
  prismaMock.notificationWorkflowStepRun.create.mockImplementation(({ data }) => Promise.resolve({ id: stepId += 1, ...data }));
  prismaMock.notificationWorkflowStepRun.update.mockResolvedValue({});
  prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue(null);
  prismaMock.notificationEmailSignature.findUnique.mockResolvedValue(null);
  prismaMock.publicTicketStatusSettings.upsert.mockResolvedValue({ enabled: false });
  prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(null);
  prismaMock.ticket.findFirst.mockResolvedValue({ id: 100, workspaceId: 2 });
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticket.findUnique.mockResolvedValue(null);
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.ticketActivity.findFirst.mockResolvedValue(null);
  prismaMock.mailboxConnection.findMany.mockResolvedValue([{ id: 7, address: AP }, { id: 8, address: AR }]);
  getMailboxAliases.mockResolvedValue([]);
});

describe('the "Intake mailbox" field', () => {
  test('is in both catalogues, a pick-list (enum) with is / is not', () => {
    expect(CONDITION_FIELDS['ticket.intakeMailbox']).toMatchObject({ label: 'Intake mailbox', type: 'enum', path: 'ticket.intakeMailbox', dynamicOptions: 'mailboxes' });
    expect(RULE_FIELDS['ticket.intakeMailbox']).toMatchObject({ path: 'ticket.intakeMailbox', type: 'enum' });
    expect(validateConditionGroup({ logic: 'all', conditions: [{ field: 'ticket.intakeMailbox', operator: 'is_not', value: AR }] })).toEqual([]);
  });

  test('the pick-list: one option per mailbox connection, address as the value', () => {
    expect(mailboxConditionOptions([
      { address: 'AP@example.com', displayName: 'Accounts Payable', isEnabled: true },
      { address: AR, displayName: null, isEnabled: false },
      { address: 'ap@example.com', displayName: 'dupe' },
    ])).toEqual([
      { value: AP, label: 'Accounts Payable (ap@example.com)' },
      { value: AR, label: 'ar@example.com, disconnected' },
    ]);
  });

  test('compiled: "is AR" matches AR only; "is not AR" matches AP and a ticket with no mailbox', async () => {
    const { default: jsonLogic } = await import('json-logic-js');
    const isAr = compileConditionGroup({ logic: 'all', conditions: [{ field: 'ticket.intakeMailbox', operator: 'is', value: AR }] });
    const notAr = compileConditionGroup({ logic: 'all', conditions: [{ field: 'ticket.intakeMailbox', operator: 'is_not', value: AR }] });
    const scope = (box) => ({ ticket: { intakeMailbox: box } });
    expect([AR, AP, null, undefined].map((b) => jsonLogic.apply(isAr, scope(b)))).toEqual([true, false, false, false]);
    expect([AR, AP, null, undefined].map((b) => jsonLogic.apply(notAr, scope(b)))).toEqual([false, true, true, true]);
  });
});

describe('where the intake mailbox is read from', () => {
  test('mail intake hands it over in memory (null for anything else)', async () => {
    expect(await intakeMailboxFor({ id: 100, intakeMailbox: AR })).toBe(AR);
    expect(await intakeMailboxFor({ id: 100, intakeMailbox: null })).toBeNull();
    expect(intakeMailboxRecord({ id: 8, address: 'AR@Example.com' })).toEqual({ connectionId: 8, address: AR });
    expect(prismaMock.ticketActivity.findFirst).not.toHaveBeenCalled();
  });

  test('new tickets: the created audit row', async () => {
    prismaMock.ticketActivity.findFirst.mockResolvedValue({ details: { intakeMailbox: { connectionId: 8, address: AR } } });
    expect(await intakeMailboxFor({ id: 100, workspaceId: 2 })).toBe(AR);
    expect(prismaMock.ticketActivity.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { ticketId: 100, activityType: 'created' } }));
  });

  test('older tickets: the opening e-mail\'s To / Cc against the workspace mailboxes and aliases, To first', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ workspaceId: 2, rawPayload: { to_emails: ['Vendor Billing <ar+inv@example.com>'], cc_emails: [AP] } });
    expect(await intakeMailboxFor({ id: 100, workspaceId: 2 })).toBe(AR);
    expect(prismaMock.ticketThreadEntry.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { ticketId: 100, source: 'email_inbound', eventType: 'original_email' },
    }));
    getMailboxAliases.mockImplementation(async (id) => (id === 7 ? ['payables@example.com'] : []));
    expect(matchIntakeMailbox(['someone@example.com'], ['payables@example.com'], [{ address: AP, aliases: ['payables@example.com'] }])).toBe(AP);
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ workspaceId: 2, rawPayload: { to_emails: ['payables@example.com'] } });
    expect(await intakeMailboxFor({ id: 101, workspaceId: 2 })).toBe(AP);
  });

  test('no opening e-mail (app, API, Teams, FreshService): none', async () => {
    expect(await intakeMailboxFor({ id: 100, workspaceId: 2 })).toBeNull();
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ workspaceId: 2, rawPayload: { to_emails: ['elsewhere@example.org'] } });
    expect(await intakeMailboxFor({ id: 100, workspaceId: 2 })).toBeNull();
  });

  test('a failed read is "none", never a crash', async () => {
    prismaMock.ticketActivity.findFirst.mockRejectedValue(new Error('db down'));
    expect(await intakeMailboxFor({ id: 100, workspaceId: 2 })).toBeNull();
  });
});

describe('in a workflow run', () => {
  // The default "Ticket arrived" workflow, with "Intake mailbox is not AR" put first.
  const definition = (() => {
    const def = buildDefaultWorkflowDefinition('ticket.created');
    const first = def.edges.find((e) => e.source === 'trigger');
    def.nodes.push(
      { id: 'not-ar', type: 'condition', position: { x: 200, y: 60 }, data: { conditionGroup: { logic: 'all', conditions: [{ field: 'ticket.intakeMailbox', operator: 'is_not', value: AR }] } } },
      { id: 'skip-ar', type: 'stop', position: { x: 200, y: 200 }, data: {} },
    );
    def.edges.push({ id: 'e-ar-true', source: 'not-ar', target: first.target, sourceHandle: 'true' }, { id: 'e-ar-false', source: 'not-ar', target: 'skip-ar', sourceHandle: 'false' });
    first.target = 'not-ar';
    return def;
  })();
  const ctx = (ticket) => ({
    event: { type: 'ticket.created', source: 'test', occurredAt: '2026-11-24T18:00:00.000Z', extra: {} },
    workspace: { id: 2, name: 'Accounting', timezone: 'America/Vancouver' },
    ticket: { id: 100, workspaceId: 2, subject: 'Invoice 4411 overdue', status: 'Open', ...ticket },
    requester: { name: 'Vendor Billing', email: 'billing@vendor.example.com' },
    assignedAgent: null,
    previousAgent: null,
  });
  async function stepFor(ticket) {
    const result = await engine.executePreview({
      workflow: { id: 5, workspaceId: 2, triggerType: 'ticket.created', draftDefinition: definition, publishedVersion: 0, versions: [] },
      definition,
      eventContext: ctx(ticket),
    });
    return result.steps.find((s) => s.nodeId === 'not-ar');
  }

  test('AR mail stops; AP mail and a non-mail ticket go on', async () => {
    expect((await stepFor({ intakeMailbox: AR })).output.passed).toBe(false);
    expect((await stepFor({ intakeMailbox: AP })).output.passed).toBe(true);
    expect((await stepFor({ intakeMailbox: null })).output.passed).toBe(true);
  });

  test('a later event reads it from the ticket (no in-memory value)', async () => {
    prismaMock.ticketActivity.findFirst.mockResolvedValue({ details: { intakeMailbox: { connectionId: 8, address: AR } } });
    const step = await stepFor({});
    expect(step.output.passed).toBe(false);
    // The run explains the check (addresses are redacted in stored explanations).
    expect(step.output.explain.summary).toMatch(/^Intake mailbox is not /);
  });
});
