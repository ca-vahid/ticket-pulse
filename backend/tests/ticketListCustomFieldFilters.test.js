import { jest } from '@jest/globals';

/**
 * Custom Fields Activation Phase 2 — queue cf_* filter grammar in
 * ticketService.buildListWhere:
 *   cf_<key>=<value>      equals (select/boolean/number), contains (text),
 *                         whole-day (date-only value on date fields)
 *   cf_<key>_gte / _lte   ranges (number/date only)
 * Unknown keys are ignored silently; defs are fetched once per request and
 * only when a cf_ param is present; text/date string compares run through a
 * single parameterized $queryRaw id-prefilter (ILIKE / >= / <=).
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  customFieldDefinition: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', color: 'blue', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', color: 'amber', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', color: 'emerald', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', color: 'slate', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  ticketTypeDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  $queryRaw: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: { emitTicketLifecycleNotifications: jest.fn() } }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: { getClient: jest.fn(), getInteractiveClient: jest.fn(), enqueueTicketCreate: jest.fn(), enqueueFieldSync: jest.fn(), enqueueThreadEntry: jest.fn(), resolveDepartmentId: jest.fn() },
}));

const { default: ticketService } = await import('../src/services/ticketService.js');

const DEFS = [
  { id: 1, workspaceId: 1, key: 'client_name', label: 'Client Name', type: 'text', options: [], isActive: true, sortOrder: 1 },
  { id: 2, workspaceId: 1, key: 'source_system', label: 'Source System', type: 'select', options: ['Power App', 'SharePoint'], isActive: true, sortOrder: 2 },
  { id: 3, workspaceId: 1, key: 'expedite', label: 'Expedite', type: 'boolean', options: [], isActive: true, sortOrder: 3 },
  { id: 4, workspaceId: 1, key: 'amount', label: 'Amount', type: 'number', options: [], isActive: true, sortOrder: 4 },
  { id: 5, workspaceId: 1, key: 'needed_by', label: 'Needed By', type: 'date', options: [], isActive: true, sortOrder: 5 },
  // Retired definitions still own their key — stored values stay filterable.
  { id: 6, workspaceId: 1, key: 'legacy_ref', label: 'Legacy Ref', type: 'select', options: ['A'], isActive: false, sortOrder: 6 },
];

const cfConditions = (where) => (where.AND || []).filter((c) => c.customFields);
const idCondition = (where) => (where.AND || []).find((c) => c.id);

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.customFieldDefinition.findMany.mockResolvedValue(DEFS);
  prismaMock.$queryRaw.mockResolvedValue([]);
});

describe('buildListWhere cf_* grammar', () => {
  test('select → native JSONB path equals', async () => {
    const where = await ticketService.buildListWhere(1, { cf_source_system: 'Power App' });
    expect(cfConditions(where)).toEqual([{ customFields: { path: ['source_system'], equals: 'Power App' } }]);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  test('boolean → equals true/false (case-insensitive param)', async () => {
    const yes = await ticketService.buildListWhere(1, { cf_expedite: 'True' });
    expect(cfConditions(yes)).toEqual([{ customFields: { path: ['expedite'], equals: true } }]);
    const no = await ticketService.buildListWhere(1, { cf_expedite: 'false' });
    expect(cfConditions(no)).toEqual([{ customFields: { path: ['expedite'], equals: false } }]);
  });

  test('number → numeric equals plus gte/lte ranges; non-numeric ignored', async () => {
    const eq = await ticketService.buildListWhere(1, { cf_amount: '42' });
    expect(cfConditions(eq)).toEqual([{ customFields: { path: ['amount'], equals: 42 } }]);

    const range = await ticketService.buildListWhere(1, { cf_amount_gte: '10', cf_amount_lte: '99.5' });
    expect(cfConditions(range)).toEqual(expect.arrayContaining([
      { customFields: { path: ['amount'], gte: 10 } },
      { customFields: { path: ['amount'], lte: 99.5 } },
    ]));

    const junk = await ticketService.buildListWhere(1, { cf_amount: 'lots' });
    expect(cfConditions(junk)).toEqual([]);
  });

  test('text → case-insensitive contains via the raw id-prefilter lane', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: 7 }, { id: 9 }]);
    const where = await ticketService.buildListWhere(1, { cf_client_name: 'acme' });
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    // Parameterized: workspace id + the ILIKE fragment ride as bind values.
    const [, ...values] = prismaMock.$queryRaw.mock.calls[0];
    expect(values).toContain(1);
    expect(JSON.stringify(values)).toContain('%acme%');
    expect(idCondition(where)).toEqual({ id: { in: [7, 9] } });
  });

  test('text contains with no matches pins the where to an impossible id', async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);
    const where = await ticketService.buildListWhere(1, { cf_client_name: 'nobody' });
    expect(idCondition(where)).toEqual({ id: { in: [-1] } });
  });

  test('ILIKE wildcards in the value are escaped to match literally', async () => {
    await ticketService.buildListWhere(1, { cf_client_name: '50%_done' });
    const [, ...values] = prismaMock.$queryRaw.mock.calls[0];
    expect(JSON.stringify(values)).toContain('%50\\\\%\\\\_done%');
  });

  test('date ranges + date-only equals run through the raw lane (whole-day match)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: 3 }]);
    const where = await ticketService.buildListWhere(1, { cf_needed_by: '2026-08-10' });
    const [, ...values] = prismaMock.$queryRaw.mock.calls[0];
    const flat = JSON.stringify(values);
    expect(flat).toContain('2026-08-10');
    expect(flat).toContain('2026-08-10T23:59:59.999Z'); // inclusive upper bound
    expect(idCondition(where)).toEqual({ id: { in: [3] } });

    prismaMock.$queryRaw.mockClear();
    await ticketService.buildListWhere(1, { cf_needed_by_gte: '2026-08-01', cf_needed_by_lte: '2026-08-31' });
    const flat2 = JSON.stringify(prismaMock.$queryRaw.mock.calls[0].slice(1));
    expect(flat2).toContain('2026-08-01');
    expect(flat2).toContain('2026-08-31T23:59:59.999Z');
  });

  test('ranges on text/select/boolean fields are ignored (number/date only)', async () => {
    const where = await ticketService.buildListWhere(1, { cf_client_name_gte: 'a', cf_expedite_lte: 'true', cf_source_system_gte: 'A' });
    expect(cfConditions(where)).toEqual([]);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  test('unknown keys are ignored silently — no error, no condition', async () => {
    const where = await ticketService.buildListWhere(1, { cf_no_such_field: 'x', cf_no_such_field_gte: '1' });
    expect(cfConditions(where)).toEqual([]);
    expect(idCondition(where)).toBeUndefined();
  });

  test('retired definitions still own their key (values remain filterable)', async () => {
    const where = await ticketService.buildListWhere(1, { cf_legacy_ref: 'A' });
    expect(cfConditions(where)).toEqual([{ customFields: { path: ['legacy_ref'], equals: 'A' } }]);
  });

  test('defs are validated against THIS workspace and fetched once per request', async () => {
    await ticketService.buildListWhere(1, { cf_amount: '5', cf_expedite: 'true' });
    expect(prismaMock.customFieldDefinition.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.customFieldDefinition.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: 1 }),
    }));
  });

  test('workspace isolation: the raw text lane is scoped to the workspace id', async () => {
    await ticketService.buildListWhere(42, { cf_client_name: 'acme' });
    const [, ...values] = prismaMock.$queryRaw.mock.calls[0];
    expect(values).toContain(42);
  });

  test('no cf_ params → the defs are never fetched', async () => {
    await ticketService.buildListWhere(1, { status: 'Open' });
    expect(prismaMock.customFieldDefinition.findMany).not.toHaveBeenCalled();
  });

  test('empty values are skipped like every other empty filter param', async () => {
    const where = await ticketService.buildListWhere(1, { cf_amount: '', cf_client_name: '  ' });
    expect(cfConditions(where)).toEqual([]);
    expect(prismaMock.customFieldDefinition.findMany).not.toHaveBeenCalled();
  });
});

describe('listTickets inheritance (queue / CSV / bulk-by-query / v1 API)', () => {
  test('listTickets forwards cf_* query params into the shared where', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, internalDomains: [] });
    prismaMock.ticket.count.mockResolvedValue(0);
    prismaMock.ticket.findMany.mockResolvedValue([]);
    await ticketService.listTickets(1, { cf_source_system: 'Power App' });
    const { where } = prismaMock.ticket.findMany.mock.calls[0][0];
    expect(cfConditions(where)).toEqual([{ customFields: { path: ['source_system'], equals: 'Power App' } }]);
  });

  test('cursor pagination (public API default) inherits the same cf_* filter', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, internalDomains: [] });
    prismaMock.ticket.count.mockResolvedValue(0);
    prismaMock.ticket.findMany.mockResolvedValue([]);
    await ticketService.listTickets(1, { useCursor: true, cf_expedite: 'true' });
    const { where } = prismaMock.ticket.findMany.mock.calls[0][0];
    expect(cfConditions(where)).toEqual([{ customFields: { path: ['expedite'], equals: true } }]);
  });
});
