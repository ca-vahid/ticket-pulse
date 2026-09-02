import { jest } from '@jest/globals';
import jsonLogic from 'json-logic-js';

/**
 * Phase RL (RL-6) — `ticket.createdVia` in the condition model and in the
 * lifecycle event context (explicit value from createTicket wins; otherwise
 * derived from dispatch source + arrival channel), plus the
 * "internal group members" recipient token resolving through group_members.
 */

const prismaMock = {
  ticket: { findUnique: jest.fn() },
  technician: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
  groupMember: { findMany: jest.fn() },
  ticketAssignmentEpisode: { groupBy: jest.fn() },
};
const executeForEventMock = jest.fn().mockResolvedValue({ status: 'completed' });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/notificationWorkflowEngine.js', () => ({ default: { executeForEvent: executeForEventMock } }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { resolveBaseStatus: jest.fn().mockResolvedValue('Open'), listStatuses: jest.fn().mockResolvedValue([]) },
  TERMINAL_BASE_STATUSES: new Set(['Resolved', 'Closed']),
}));
jest.unstable_mockModule('../src/services/webhookDispatchService.js', () => ({ default: {}, dispatchWebhookEvent: jest.fn() }));
jest.unstable_mockModule('../src/services/ticketSentimentService.js', () => ({ default: { refreshForTicket: jest.fn(), maybeRefresh: jest.fn() } }));

const { CONDITION_FIELDS, compileConditionGroup, validateConditionGroup } = await import('../src/services/notificationConditionModel.js');
const lifecycle = await import('../src/services/ticketLifecycleNotificationService.js');
const { buildEventContext, deriveCreatedVia, TICKET_CREATED_VIA, emitTicketLifecycleNotifications } = lifecycle;
const { resolveInternalGroupEmails } = await import('../src/services/notificationWorkflowActionNodes.js');

beforeEach(() => jest.clearAllMocks());

describe('condition model', () => {
  test('ticket.createdVia is an enum field with the full vocabulary', () => {
    expect(CONDITION_FIELDS['ticket.createdVia']).toEqual({
      label: 'Created via', type: 'enum', path: 'ticket.createdVia',
      options: ['app', 'email', 'api', 'freshservice_sync', 'held_reply', 'agent_cc', 'forward'],
    });
    expect(TICKET_CREATED_VIA).toEqual(CONDITION_FIELDS['ticket.createdVia'].options);
  });

  test('"created via is not held_reply AND origin is ticketpulse" compiles and evaluates', () => {
    const group = {
      logic: 'all',
      conditions: [
        { field: 'ticket.origin', operator: 'is', value: 'ticketpulse' },
        { field: 'ticket.createdVia', operator: 'not_in', value: ['held_reply', 'freshservice_sync'] },
      ],
    };
    expect(validateConditionGroup(group).errors ?? []).toEqual([]);
    const rule = compileConditionGroup(group);
    expect(jsonLogic.apply(rule, { ticket: { origin: 'ticketpulse', createdVia: 'email' } })).toBe(true);
    expect(jsonLogic.apply(rule, { ticket: { origin: 'ticketpulse', createdVia: 'held_reply' } })).toBe(false);
    expect(jsonLogic.apply(rule, { ticket: { origin: 'freshservice', createdVia: 'freshservice_sync' } })).toBe(false);
  });
});

const baseTicket = {
  id: 42, workspaceId: 5, origin: 'ticketpulse', nativeNumber: 1204, subject: 'Invoice', status: 'Open', priority: 2,
  source: 1, requester: { id: 1, name: 'Susan', email: 'susan@vendor.example' }, workspace: { id: 5, name: 'PA' }, tagLinks: [],
};

describe('deriveCreatedVia / buildEventContext', () => {
  test('explicit createdVia wins; otherwise derived from source + channel', () => {
    expect(deriveCreatedVia(baseTicket, { source: 'ticketpulse_native', createdVia: 'agent_cc' })).toBe('agent_cc');
    expect(deriveCreatedVia({ ...baseTicket, createdVia: 'held_reply' }, { source: 'ticketpulse_native' })).toBe('held_reply');
    expect(deriveCreatedVia(baseTicket, { source: 'ticketpulse_native' })).toBe('email'); // source channel 1
    expect(deriveCreatedVia({ ...baseTicket, source: 100 }, { source: 'ticketpulse_native' })).toBe('api');
    expect(deriveCreatedVia({ ...baseTicket, source: 103 }, { source: 'ticketpulse_native' })).toBe('app');
    expect(deriveCreatedVia({ ...baseTicket, origin: 'freshservice', source: 1 }, { source: 'freshservice_sync' })).toBe('freshservice_sync');
    expect(deriveCreatedVia({ ...baseTicket, origin: 'freshservice' }, { source: 'ticketpulse_native' })).toBe('freshservice_sync');
    expect(deriveCreatedVia(baseTicket, { createdVia: 'nonsense' })).toBe('email'); // unknown labels are ignored
  });

  test('the engine context exposes ticket.createdVia next to ticket.origin', () => {
    const ctx = buildEventContext({ event: { type: 'ticket.created' }, ticket: baseTicket, previousAgent: null, source: 'ticketpulse_native', createdVia: 'held_reply' });
    expect(ctx.ticket).toMatchObject({ origin: 'ticketpulse', createdVia: 'held_reply' });
    const synced = buildEventContext({ event: { type: 'ticket.created' }, ticket: { ...baseTicket, origin: 'freshservice', freshserviceTicketId: 240116 }, previousAgent: null, source: 'freshservice_sync' });
    expect(synced.ticket.createdVia).toBe('freshservice_sync');
  });

  test('emitTicketLifecycleNotifications carries the in-memory createdVia stamp through re-hydration into the engine', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(baseTicket); // hydrateTicket drops the in-memory field
    await emitTicketLifecycleNotifications({
      existingTicket: null,
      upsertedTicket: { ...baseTicket, createdVia: 'agent_cc' },
      source: 'ticketpulse_native',
      allowNotificationWorkflows: true,
    });
    expect(executeForEventMock).toHaveBeenCalledTimes(1);
    const [ctx] = executeForEventMock.mock.calls[0];
    expect(ctx.event.type).toBe('ticket.created');
    expect(ctx.ticket.createdVia).toBe('agent_cc');
  });
});

describe('internal group members recipient (engine resolver)', () => {
  test('internal_group:<id> resolves to ACTIVE member emails only; non-group tokens are ignored', async () => {
    prismaMock.groupMember.findMany.mockResolvedValue([
      { technician: { email: 'a@bgc.example', isActive: true } },
      { technician: { email: 'gone@bgc.example', isActive: false } },
      { technician: { email: null, isActive: true } },
    ]);
    const emails = await resolveInternalGroupEmails(['requester', 'internal_group:3458', 'custom_emails']);
    expect(emails).toEqual(['a@bgc.example']);
    expect(prismaMock.groupMember.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { groupId: { in: [3458] } } }));
  });
  test('no group tokens → no query, empty list', async () => {
    expect(await resolveInternalGroupEmails(['requester'])).toEqual([]);
    expect(prismaMock.groupMember.findMany).not.toHaveBeenCalled();
  });
});
