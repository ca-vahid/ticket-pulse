import { jest } from '@jest/globals';

/** SLA policies, macros, custom fields, ticket links — the enterprise staples. */

const prismaMock = {
  slaPolicy: { findMany: jest.fn(), findFirst: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
  // Calendar-aware SLAs (Phase SLA): workspace flag + business calendar rows.
  workspace: { findUnique: jest.fn() },
  businessHour: { findMany: jest.fn() },
  holiday: { findMany: jest.fn() },
  ticketMacro: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  customFieldDefinition: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  ticket: { findFirst: jest.fn(), update: jest.fn(), findUnique: jest.fn().mockResolvedValue(null) },
  ticketLink: { findMany: jest.fn(), findFirst: jest.fn(), upsert: jest.fn(), delete: jest.fn() },
};
const ticketServiceMock = {
  assignTicket: jest.fn().mockResolvedValue({}),
  updateTicketFields: jest.fn().mockResolvedValue({}),
  addPrivateNote: jest.fn().mockResolvedValue({}),
  addReply: jest.fn().mockResolvedValue({}),
  changeStatus: jest.fn().mockResolvedValue({}),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({
  default: { create: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// setValues (Phase 2) fire-and-forgets a ticket.custom_fields_changed dispatch
// after the audit write; mocked so the dynamic import resolves from the
// registry instead of loading the outbox machinery mid-teardown.
jest.unstable_mockModule('../src/services/webhookDispatchService.js', () => ({
  default: { dispatchWebhookEvent: jest.fn() },
  dispatchWebhookEvent: jest.fn(),
  WEBHOOK_EVENTS: ['ticket.custom_fields_changed'],
}));

const { default: slaPolicyService } = await import('../src/services/slaPolicyService.js');
const { default: ticketMacroService } = await import('../src/services/ticketMacroService.js');
const { default: customFieldService } = await import('../src/services/customFieldService.js');

beforeEach(() => {
  jest.clearAllMocks();
  // The workspace calendar flag is TTL-cached inside the service — reset it so
  // each test's workspace.findUnique mock is authoritative.
  slaPolicyService.clearCalendarFlagCache();
  prismaMock.workspace.findUnique.mockResolvedValue({ slaCalendarAware: false });
  prismaMock.businessHour.findMany.mockResolvedValue([]);
  prismaMock.holiday.findMany.mockResolvedValue([]);
});

// Mon–Fri 09:00–17:00 Pacific (the seeded default calendar).
const WEEKDAYS_9_5 = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
  dayOfWeek, startTime: '09:00', endTime: '17:00', isEnabled: true, timezone: 'America/Los_Angeles',
}));

describe('SLA policies', () => {
  test('dueDatesFor computes clocks from the active policy', async () => {
    prismaMock.slaPolicy.findFirst.mockResolvedValue({ firstResponseMinutes: 60, resolveMinutes: 480 });
    const from = new Date('2026-07-07T10:00:00.000Z');
    const dates = await slaPolicyService.dueDatesFor(1, 3, from);
    expect(dates.frDueBy.toISOString()).toBe('2026-07-07T11:00:00.000Z');
    expect(dates.dueBy.toISOString()).toBe('2026-07-07T18:00:00.000Z');
  });

  test('no policy → no clocks (nulls, never throws)', async () => {
    prismaMock.slaPolicy.findFirst.mockResolvedValue(null);
    expect(await slaPolicyService.dueDatesFor(1, 2)).toEqual({ frDueBy: null, dueBy: null });
  });

  test('upsert validates priority and window bounds', async () => {
    await expect(slaPolicyService.upsert(1, { priority: 9, resolveMinutes: 60 })).rejects.toThrow(/1–4/);
    await expect(slaPolicyService.upsert(1, { priority: 2 })).rejects.toThrow(/at least one/i);
    await expect(slaPolicyService.upsert(1, { priority: 2, resolveMinutes: 2 })).rejects.toThrow(/between/i);
  });

  test('upsert rejects unknown calendarMode values', async () => {
    await expect(slaPolicyService.upsert(1, { priority: 2, resolveMinutes: 60, calendarMode: '24-7' }))
      .rejects.toThrow(/calendarMode/);
  });
});

// Phase SLA (QA 08-17 #9): effective-mode matrix — per-policy calendarMode
// override × workspace slaCalendarAware flag. Friday 2026-08-21 16:00 PDT
// (23:00Z) + 120m resolve: wall-clock → Fri 18:00 PDT (Sat 01:00Z); calendar
// → 60m Fri + 60m Mon = Mon 2026-08-24 10:00 PDT (17:00Z).
describe('SLA policies — calendar-aware mode matrix', () => {
  const FROM = new Date('2026-08-21T23:00:00.000Z');
  const WALL = '2026-08-22T01:00:00.000Z';
  const CAL = '2026-08-24T17:00:00.000Z';
  const policy = (calendarMode) => ({ firstResponseMinutes: null, resolveMinutes: 120, calendarMode });
  const withCalendarRows = () => prismaMock.businessHour.findMany.mockResolvedValue(WEEKDAYS_9_5);

  test('inherit + workspace OFF → wall-clock', async () => {
    prismaMock.slaPolicy.findFirst.mockResolvedValue(policy('inherit'));
    withCalendarRows();
    expect((await slaPolicyService.dueDatesFor(1, 3, FROM)).dueBy.toISOString()).toBe(WALL);
  });

  test('inherit + workspace ON → business calendar (weekend skipped)', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ slaCalendarAware: true });
    prismaMock.slaPolicy.findFirst.mockResolvedValue(policy('inherit'));
    withCalendarRows();
    expect((await slaPolicyService.dueDatesFor(1, 3, FROM)).dueBy.toISOString()).toBe(CAL);
  });

  test('always_on + workspace ON → wall-clock (the 24/7 escape hatch)', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ slaCalendarAware: true });
    prismaMock.slaPolicy.findFirst.mockResolvedValue(policy('always_on'));
    withCalendarRows();
    expect((await slaPolicyService.dueDatesFor(1, 4, FROM)).dueBy.toISOString()).toBe(WALL);
  });

  test('calendar + workspace OFF → business calendar (per-policy force-on)', async () => {
    prismaMock.slaPolicy.findFirst.mockResolvedValue(policy('calendar'));
    withCalendarRows();
    expect((await slaPolicyService.dueDatesFor(1, 3, FROM)).dueBy.toISOString()).toBe(CAL);
  });

  test('workspace ON but zero enabled business-hour days → wall-clock fallback', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ slaCalendarAware: true });
    prismaMock.slaPolicy.findFirst.mockResolvedValue(policy('inherit'));
    // businessHour.findMany stays [] from beforeEach.
    expect((await slaPolicyService.dueDatesFor(1, 3, FROM)).dueBy.toISOString()).toBe(WALL);
  });

  test('both clocks share one calendar and both skip the weekend', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ slaCalendarAware: true });
    prismaMock.slaPolicy.findFirst.mockResolvedValue({ firstResponseMinutes: 30, resolveMinutes: 120, calendarMode: 'inherit' });
    withCalendarRows();
    const dates = await slaPolicyService.dueDatesFor(1, 3, FROM);
    expect(dates.frDueBy.toISOString()).toBe('2026-08-21T23:30:00.000Z'); // fits inside Friday
    expect(dates.dueBy.toISOString()).toBe(CAL);
    // One calendar load for the pair of targets.
    expect(prismaMock.businessHour.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('macros', () => {
  test('apply runs each configured action through the normal service paths, status LAST', async () => {
    prismaMock.ticketMacro.findFirst.mockResolvedValue({
      id: 5, name: 'Resolve as no-fault',
      actions: { setStatus: 'Resolved', addNote: 'No fault found', setPriority: 1 },
    });

    const result = await ticketMacroService.apply(501, 1, 5, { email: 'agent@x.io' });

    expect(result.ok).toBe(true);
    expect(ticketServiceMock.updateTicketFields).toHaveBeenCalledWith(501, 1, { priority: 1 }, { email: 'agent@x.io' });
    expect(ticketServiceMock.addPrivateNote).toHaveBeenCalledWith(501, 1, { bodyText: 'No fault found' }, { email: 'agent@x.io' });
    expect(ticketServiceMock.changeStatus).toHaveBeenCalledWith(501, 1, 'Resolved', { email: 'agent@x.io' });
    // Status change is the LAST step so it can't race the other writes.
    expect(result.steps.at(-1).label).toBe('status');
  });

  test('a failing step is reported, not silently swallowed', async () => {
    prismaMock.ticketMacro.findFirst.mockResolvedValue({
      id: 6, name: 'x', actions: { setStatus: 'Resolved', addNote: 'y' },
    });
    ticketServiceMock.addPrivateNote.mockRejectedValueOnce(new Error('storage down'));

    const result = await ticketMacroService.apply(501, 1, 6, { email: 'a@x.io' });

    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.label === 'note')).toEqual(expect.objectContaining({ ok: false, error: 'storage down' }));
    // The status step still ran (partial application is visible in steps).
    expect(result.steps.find((s) => s.label === 'status')?.ok).toBe(true);
  });

  test('action validation rejects empty and malformed bundles', async () => {
    await expect(ticketMacroService.create(1, { name: 'x', actions: {} }, null)).rejects.toThrow(/at least one action/i);
    await expect(ticketMacroService.create(1, { name: 'x', actions: { setStatus: 'Nope' } }, null)).rejects.toThrow(/status must be/i);
  });

  test('setStatus validates against the WORKSPACE status registry and canonicalizes casing (Phase 8a)', async () => {
    const { invalidateStatusCache } = await import('../src/services/statusService.js');
    invalidateStatusCache(77);
    prismaMock.ticketStatusDefinition = {
      findMany: jest.fn().mockResolvedValue([
        { id: 1, workspaceId: 77, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
        { id: 2, workspaceId: 77, name: 'Waiting on vendor', baseStatus: 'Pending', sortOrder: 1, isSystem: false, isActive: true },
        { id: 3, workspaceId: 77, name: 'Needs Rework', baseStatus: 'Open', sortOrder: 2, isSystem: false, isActive: false },
      ]),
    };
    prismaMock.ticketMacro.create.mockImplementation(({ data }) => Promise.resolve({ id: 9, ...data }));

    const macro = await ticketMacroService.create(77, { name: 'Park it', actions: { setStatus: 'waiting ON vendor' } }, null);
    expect(macro.actions.setStatus).toBe('Waiting on vendor');

    // Retired statuses can't be chosen for new changes.
    await expect(ticketMacroService.create(77, { name: 'y', actions: { setStatus: 'Needs Rework' } }, null))
      .rejects.toThrow(/status must be one of this workspace's statuses: Open, Waiting on vendor/i);
  });
});

describe('thread summary prompt safety', () => {
  test('summarize refuses an empty thread instead of hallucinating', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({
      id: 501, workspaceId: 1, subject: 'x', status: 'Open', priority: 2,
      descriptionText: null, requester: null, assignedTech: null,
    });
    const threadMock = { findMany: jest.fn().mockResolvedValue([]) };
    prismaMock.ticketThreadEntry = threadMock;
    const { default: ticketSummaryService } = await import('../src/services/ticketSummaryService.js');
    await expect(ticketSummaryService.summarize(501, 1)).rejects.toThrow(/nothing to summarize/i);
  });
});

describe('custom fields', () => {
  test('definition keys and types are validated', async () => {
    await expect(customFieldService.createDefinition(1, { key: 'Bad Key', label: 'X' })).rejects.toThrow(/lowercase/i);
    await expect(customFieldService.createDefinition(1, { key: 'ok_key', label: 'X', type: 'wat' })).rejects.toThrow(/type must be/i);
    await expect(customFieldService.createDefinition(1, { key: 'ok_key', label: 'X', type: 'select', options: [] })).rejects.toThrow(/at least one option/i);
  });

  test('setValues coerces types, rejects unknown keys, and merges', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 501, workspaceId: 1, customFields: { existing: 'kept' } });
    prismaMock.customFieldDefinition.findMany.mockResolvedValue([
      { key: 'cost_centre', label: 'Cost centre', type: 'select', options: ['ENG', 'OPS'] },
      { key: 'seats', label: 'Seats', type: 'number', options: [] },
      { key: 'existing', label: 'Existing', type: 'text', options: [] },
    ]);
    prismaMock.ticket.update.mockResolvedValue({});

    const result = await customFieldService.setValues(501, 1, { cost_centre: 'ENG', seats: '4' }, { email: 'a@x.io' });

    expect(result.customFields).toEqual({ existing: 'kept', cost_centre: 'ENG', seats: 4 });
    await expect(customFieldService.setValues(501, 1, { nope: 1 }, null)).rejects.toThrow(/unknown custom field/i);
    await expect(customFieldService.setValues(501, 1, { cost_centre: 'HR' }, null)).rejects.toThrow(/must be one of/i);

    // Let the fire-and-forget webhook chain settle inside the test lifetime.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
