import { jest } from '@jest/globals';

/**
 * QA 11-23 item 2: one priority_changed history row for every priority change,
 * the "Why this priority" line, and the weekly "the requester raised it" list.
 */

const prismaMock = {
  ticketActivity: {
    create: jest.fn(),
    findFirst: jest.fn(),
  },
  urgentEscalationEvent: {
    findMany: jest.fn(),
  },
  assignmentPipelineRun: {
    findMany: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  recordPriorityChange,
  priorityReasonFrom,
  prioritySourceForActor,
  priorityLabelOf,
  listRequesterPriorityRaises,
  PRIORITY_CHANGE_SOURCES,
} = await import('../src/services/priorityHistoryService.js');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketActivity.findFirst.mockResolvedValue(null);
  prismaMock.ticketActivity.create.mockImplementation(({ data }) => Promise.resolve({ id: 900, ...data }));
});

describe('priorityLabelOf / prioritySourceForActor', () => {
  test('labels ids and words', () => {
    expect(priorityLabelOf(4)).toBe('Urgent');
    expect(priorityLabelOf('2')).toBe('Medium');
    expect(priorityLabelOf('high')).toBe('High');
    expect(priorityLabelOf(9)).toBeNull();
    expect(priorityLabelOf(null)).toBeNull();
  });

  test('maps actors to the contract sources', () => {
    expect(prioritySourceForActor({ name: 'Eli Park', email: 'eli.park@example.com', role: 'agent' })).toBe('agent');
    expect(prioritySourceForActor({ email: 'apikey:tp_abc', name: 'Monitor', role: 'api' })).toBe('api');
    expect(prioritySourceForActor({ name: 'Priya Nair', email: 'priya.nair@example.com', via: { kind: 'personal_key', keyId: 3 } })).toBe('personal_key');
    expect(prioritySourceForActor({ name: 'Notification workflow', role: 'workflow' })).toBe('workflow');
    expect(PRIORITY_CHANGE_SOURCES).toEqual(['requester_link', 'agent', 'ai_assessment', 'workflow', 'api', 'personal_key', 'repeat_report', 'sync']);
  });
});

describe('recordPriorityChange', () => {
  test('requester link: writes the contract details shape', async () => {
    const row = await recordPriorityChange({
      ticketId: 1042,
      from: 2,
      to: 4,
      source: 'requester_link',
      actorKind: 'human',
      actorName: 'Dana Fox',
      actorEmail: 'dana.fox@example.com',
      note: 'Raised the priority to Urgent from their status link.',
      details: { urgentEscalationEventId: 77 },
    });
    expect(row).toBeTruthy();
    const { data } = prismaMock.ticketActivity.create.mock.calls[0][0];
    expect(data).toEqual(expect.objectContaining({
      ticketId: 1042,
      activityType: 'priority_changed',
      performedBy: 'Dana Fox',
    }));
    expect(data.details).toEqual({
      urgentEscalationEventId: 77,
      from: 'Medium',
      to: 'Urgent',
      fromId: 2,
      toId: 4,
      source: 'requester_link',
      actorKind: 'human',
      actorName: 'Dana Fox',
      actorEmail: 'dana.fox@example.com',
      note: 'Raised the priority to Urgent from their status link.',
    });
  });

  test('agent edit through a personal key carries via', async () => {
    await recordPriorityChange({
      ticketId: 5,
      from: 'Medium',
      to: 'High',
      actor: { name: 'Eli Park', email: 'eli.park@example.com', via: { kind: 'personal_key', keyId: 12, keyName: 'laptop' } },
    });
    const { details, performedBy } = prismaMock.ticketActivity.create.mock.calls[0][0].data;
    expect(performedBy).toBe('Eli Park');
    expect(details).toEqual(expect.objectContaining({
      from: 'Medium', to: 'High', source: 'personal_key', actorKind: 'personal_key',
      via: { kind: 'personal_key', keyId: 12, keyName: 'laptop' },
    }));
  });

  test('AI and sync get their own names and kinds', async () => {
    await recordPriorityChange({ ticketId: 6, from: 2, to: 3, source: 'ai_assessment', note: 'Cannot sign in to Teams at all.' });
    await recordPriorityChange({ ticketId: 7, from: 3, to: 2, source: 'sync' });
    const [ai, sync] = prismaMock.ticketActivity.create.mock.calls.map((c) => c[0].data);
    expect(ai.performedBy).toBe('Ticket Pulse AI');
    expect(ai.details).toEqual(expect.objectContaining({ source: 'ai_assessment', actorKind: 'ai', note: 'Cannot sign in to Teams at all.' }));
    expect(sync.performedBy).toBe('FreshService');
    expect(sync.details).toEqual(expect.objectContaining({ source: 'sync', actorKind: 'freshservice_sync', from: 'High', to: 'Medium' }));
  });

  test('no row when nothing changed or the target is unknown', async () => {
    expect(await recordPriorityChange({ ticketId: 8, from: 3, to: 'High', source: 'agent' })).toBeNull();
    expect(await recordPriorityChange({ ticketId: 8, from: 3, to: 7, source: 'agent' })).toBeNull();
    expect(await recordPriorityChange({ ticketId: null, from: 2, to: 3, source: 'agent' })).toBeNull();
    expect(prismaMock.ticketActivity.create).not.toHaveBeenCalled();
  });

  test('the same change seen twice within two minutes is written once', async () => {
    prismaMock.ticketActivity.findFirst.mockResolvedValue({
      performedAt: new Date(Date.now() - 30 * 1000),
      details: { from: 'Medium', to: 'Urgent' },
    });
    expect(await recordPriorityChange({ ticketId: 9, from: 2, to: 4, source: 'sync' })).toBeNull();
    expect(prismaMock.ticketActivity.create).not.toHaveBeenCalled();
  });

  test('never throws: a failed write or a partial mock returns null', async () => {
    prismaMock.ticketActivity.findFirst.mockRejectedValue(new Error('db down'));
    prismaMock.ticketActivity.create.mockRejectedValue(new Error('db down'));
    await expect(recordPriorityChange({ ticketId: 10, from: 1, to: 2, source: 'agent' })).resolves.toBeNull();
  });
});

describe('priorityReasonFrom', () => {
  const at = new Date('2026-11-23T18:17:00.000Z');

  test('the latest priority_changed row that matches the current priority', () => {
    const reason = priorityReasonFrom({ priority: 4, priorityRationale: 'AI said Medium' }, [
      { activityType: 'priority_changed', performedAt: new Date('2026-11-22T10:00:00Z'), details: { to: 'High', source: 'agent', actorName: 'Eli Park' } },
      { activityType: 'priority_changed', performedAt: at, details: { to: 'Urgent', source: 'requester_link', actorName: 'Dana Fox', note: 'Raised the priority to Urgent from their status link.' } },
      { activityType: 'fields_updated', performedAt: new Date(), details: {} },
    ]);
    expect(reason).toEqual({
      level: 'Urgent', source: 'requester_link', actorName: 'Dana Fox', at: at.toISOString(),
      note: 'Raised the priority to Urgent from their status link.',
    });
  });

  test('falls back to the assessment rationale when it describes the current priority', () => {
    expect(priorityReasonFrom({
      priority: 3, assessedPriority: 'High', priorityRationale: 'One person cannot sign in to Outlook.', priorityAssessedAt: at,
    }, [])).toEqual({ level: 'High', source: 'ai_assessment', actorName: 'Ticket Pulse AI', at: at.toISOString(), note: 'One person cannot sign in to Outlook.' });
  });

  test('a requester raise stored only as rationale reads as the requester link', () => {
    expect(priorityReasonFrom({
      priority: 4, assessedPriority: 'Urgent', priorityConfidence: 'requester', priorityRationale: 'Requester raised it.', requester: { name: 'Dana Fox' },
    }, [])).toEqual(expect.objectContaining({ source: 'requester_link', actorName: 'Dana Fox' }));
  });

  test('null rather than a reason for a level the ticket no longer has', () => {
    expect(priorityReasonFrom({ priority: 2, assessedPriority: 'High', priorityRationale: 'High because…' }, [
      { activityType: 'priority_changed', performedAt: at, details: { to: 'High', source: 'agent' } },
    ])).toBeNull();
    expect(priorityReasonFrom({ priority: 2 }, [])).toBeNull();
    expect(priorityReasonFrom(null)).toBeNull();
  });
});

describe('listRequesterPriorityRaises', () => {
  const NOW = new Date('2026-11-23T20:00:00.000Z');
  const ticket = (id, nativeNumber, extra = {}) => ({
    id, workspaceId: 1, origin: 'ticketpulse', nativeNumber, freshserviceTicketId: null,
    subject: `Subject ${id}`, requester: { name: 'Dana Fox', email: 'dana.fox@example.com' }, ...extra,
  });

  test('workspace-scoped, AI Medium/Low only, one row per ticket (earliest qualifying raise), newest first', async () => {
    prismaMock.urgentEscalationEvent.findMany.mockResolvedValue([
      { id: 3, ticketId: 11, source: 'business_urgency', createdAt: new Date('2026-11-23T18:17:00Z'), payload: { fromAssessedPriority: 'Medium', toPriorityLabel: 'Urgent' }, ticket: ticket(11, 1042) },
      { id: 2, ticketId: 11, source: 'business_urgency', createdAt: new Date('2026-11-22T18:00:00Z'), payload: { fromAssessedPriority: 'Low' }, ticket: ticket(11, 1042) },
      { id: 1, ticketId: 12, source: 'self_service', createdAt: new Date('2026-11-21T03:00:00Z'), payload: { fromAssessedPriority: 'High' }, ticket: ticket(12, 1043) },
      { id: 0, ticketId: 13, source: 'business_urgency', createdAt: new Date('2026-11-20T16:00:00Z'), payload: {}, ticket: ticket(13, null, { origin: 'freshservice', freshserviceTicketId: 250003, requester: { name: null, email: 'eli.park@example.com' } }) },
    ]);
    // Older event without the stored level: the last completed AI run before the raise decides.
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([
      { ticketId: 13, createdAt: new Date('2026-11-20T17:00:00Z'), recommendation: { assessedPriority: 'Urgent' } },
      { ticketId: 13, createdAt: new Date('2026-11-20T15:00:00Z'), recommendation: { assessedPriority: 'Low' } },
    ]);

    const rows = await listRequesterPriorityRaises({ workspaceId: 1, days: 7, now: NOW });

    const where = prismaMock.urgentEscalationEvent.findMany.mock.calls[0][0].where;
    expect(where.workspaceId).toBe(1);
    expect(where.source).toEqual({ in: ['business_urgency', 'self_service'] });
    expect(where.createdAt.gte.toISOString()).toBe('2026-11-16T20:00:00.000Z');
    expect(prismaMock.assignmentPipelineRun.findMany.mock.calls[0][0].where).toEqual(expect.objectContaining({ workspaceId: 1, ticketId: { in: [13] } }));
    expect(rows).toEqual([
      // Ticket 11 was raised twice: its earliest raise against the AI level counts.
      { ticketId: 11, displayRef: 'TP-1042', subject: 'Subject 11', aiPriority: 'Low', raisedTo: 'Urgent', raisedAt: '2026-11-22T18:00:00.000Z', requesterName: 'Dana Fox' },
      { ticketId: 13, displayRef: '#250003', subject: 'Subject 13', aiPriority: 'Low', raisedTo: 'Urgent', raisedAt: '2026-11-20T16:00:00.000Z', requesterName: 'eli.park@example.com' },
    ]);
  });

  test('a second raise of the same ticket does not drop it: the earliest raise against the AI level counts', async () => {
    prismaMock.urgentEscalationEvent.findMany.mockResolvedValue([
      // Second raise (newest): assessedPriority was already Urgent, written by the first raise.
      { id: 21, ticketId: 14, source: 'business_urgency', createdAt: new Date('2026-11-23T19:00:00Z'), payload: { fromAssessedPriority: 'Urgent', fromAssessedBy: 'requester' }, ticket: ticket(14, 1044) },
      // Older payload without fromAssessedBy, already Urgent: not the AI's level either.
      { id: 20, ticketId: 14, source: 'business_urgency', createdAt: new Date('2026-11-22T19:00:00Z'), payload: { fromAssessedPriority: 'Urgent' }, ticket: ticket(14, 1044) },
      { id: 19, ticketId: 14, source: 'business_urgency', createdAt: new Date('2026-11-21T19:00:00Z'), payload: { fromAssessedPriority: 'Medium', fromAssessedBy: 'ai' }, ticket: ticket(14, 1044) },
    ]);
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([
      { ticketId: 14, createdAt: new Date('2026-11-21T10:00:00Z'), recommendation: { assessedPriority: 'Medium' } },
    ]);

    const rows = await listRequesterPriorityRaises({ workspaceId: 1, days: 7, now: NOW });

    expect(rows).toEqual([
      expect.objectContaining({ ticketId: 14, displayRef: 'TP-1044', aiPriority: 'Medium', raisedAt: '2026-11-21T19:00:00.000Z' }),
    ]);
  });

  test('clamps days and refuses a missing workspace', async () => {
    prismaMock.urgentEscalationEvent.findMany.mockResolvedValue([]);
    await listRequesterPriorityRaises({ workspaceId: 1, days: 500, now: NOW });
    expect(prismaMock.urgentEscalationEvent.findMany.mock.calls[0][0].where.createdAt.gte.toISOString()).toBe('2026-08-25T20:00:00.000Z');
    expect(await listRequesterPriorityRaises({ workspaceId: null })).toEqual([]);
  });
});
