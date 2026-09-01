import { jest } from '@jest/globals';

// Mega 08-31 Phase PA — deriveExternalRef fallbacks for senders that do NOT
// send externalRef yet: the workspace custom-field bridge (ws5's
// powerAppRecordId → 'pa-<id>') and the DEPRECATED requester+subject heuristic
// (flag-gated, window-bounded, same API key, ambiguity-fatal). prisma is
// mocked; the service's query shapes are asserted directly.

const prismaMock = {
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  ticketActivity: { findMany: jest.fn() },
};
const requesterRepositoryMock = { findByEmail: jest.fn() };
const statusServiceMock = {
  baseStatusOf: jest.fn(),
  statusNamesForBase: jest.fn(async () => ['Open', 'Pending', 'Waiting on vendor']),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({ default: statusServiceMock }));
jest.unstable_mockModule('../src/services/ticketTypeService.js', () => ({ default: { normalizeTypeName: jest.fn() } }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: requesterRepositoryMock }));
jest.unstable_mockModule('../src/services/categoryNameResolver.js', () => ({ resolveCategoryNames: jest.fn(), default: {} }));

const { default: service } = await import('../src/services/ticketResubmissionService.js');

const WS = 5;
const actor = { email: 'apikey:tp_live_x', name: 'Coreshack intake', role: 'api', technicianId: null };
const PA_BODY = {
  subject: 'Coyote Landslide', description: 'Created from Power Automate', priority: 2,
  requesterEmail: 'jdoe@bgcengineering.ca', requesterName: 'Jane Doe', runAiTriage: false,
  category: 'Project Setup', subcategory: 'Quebec',
  customFields: {
    clientName: 'ACME Inc', clientLocation: 'Quebec', projectOrProposalName: 'Coyote Landslide',
    powerAppRecordId: '1260', sourceSystem: 'Power App / Coreshack', sourceRequestType: 'Project Setup',
  },
};
const existing = (over = {}) => ({
  id: 480, workspaceId: WS, origin: 'ticketpulse', nativeNumber: 1001, subject: 'Coyote Landslide',
  status: 'Open', requesterId: 40, createdAt: new Date(), externalRef: null, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findFirst.mockResolvedValue(null);
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticketActivity.findMany.mockResolvedValue([]);
  requesterRepositoryMock.findByEmail.mockResolvedValue({ id: 40, email: 'jdoe@bgcengineering.ca' });
});

describe('explicit externalRef wins', () => {
  test('body.externalRef → lookup by ref; match reports matchedBy external_ref, miss still returns the ref to persist', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(existing({ externalRef: 'sp-projectrequests-1260' }));
    const hit = await service.deriveExternalRef(WS, { ...PA_BODY, externalRef: ' sp-projectrequests-1260 ' }, { externalRefCustomFieldKey: 'power_app_record_id' }, { actor });
    expect(hit).toMatchObject({ ref: 'sp-projectrequests-1260', matchedBy: 'external_ref', ticket: expect.objectContaining({ id: 480 }) });
    expect(prismaMock.ticket.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS, externalRef: 'sp-projectrequests-1260' } }));

    const miss = await service.deriveExternalRef(WS, { ...PA_BODY, externalRef: 'sp-projectrequests-9' }, {}, { actor });
    expect(miss).toMatchObject({ ref: 'sp-projectrequests-9', matchedBy: null, ticket: null, ambiguous: false });
  });
});

describe('custom-field bridge (zero Power Apps change)', () => {
  test('ws key power_app_record_id + the real PA payload → ref pa-1260 (camelCase spelling accepted)', async () => {
    const res = await service.deriveExternalRef(WS, PA_BODY, { externalRefCustomFieldKey: 'power_app_record_id' }, { actor });
    expect(res).toMatchObject({ ref: 'pa-1260', matchedBy: null, ticket: null });
    expect(prismaMock.ticket.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS, externalRef: 'pa-1260' } }));
  });

  test('a backfilled ticket with pa-1260 is matched → matchedBy custom_field_key', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(existing({ externalRef: 'pa-1260' }));
    const res = await service.deriveExternalRef(WS, PA_BODY, { externalRefCustomFieldKey: 'power_app_record_id' }, { actor });
    expect(res).toMatchObject({ ref: 'pa-1260', matchedBy: 'custom_field_key', ticket: expect.objectContaining({ id: 480 }) });
  });

  test('snake_case spelling and numeric values derive the same ref; a configured key that is absent/empty derives nothing', async () => {
    const snake = await service.deriveExternalRef(WS, { ...PA_BODY, customFields: { power_app_record_id: 1260 } }, { externalRefCustomFieldKey: 'powerAppRecordId' }, { actor });
    expect(snake.ref).toBe('pa-1260');
    const absent = await service.deriveExternalRef(WS, { ...PA_BODY, customFields: { clientName: 'ACME' } }, { externalRefCustomFieldKey: 'power_app_record_id' }, { actor });
    expect(absent).toMatchObject({ ref: null, matchedBy: null, ticket: null });
    const empty = await service.deriveExternalRef(WS, { ...PA_BODY, customFields: { powerAppRecordId: '  ' } }, { externalRefCustomFieldKey: 'power_app_record_id' }, { actor });
    expect(empty.ref).toBeNull();
  });

  test('no key configured → the field is just a custom field (no ref, no lookup)', async () => {
    const res = await service.deriveExternalRef(WS, PA_BODY, { externalRefCustomFieldKey: null, apiResubmissionMatchEnabled: false }, { actor });
    expect(res).toMatchObject({ ref: null, matchedBy: null, ticket: null, ambiguous: false });
    expect(prismaMock.ticket.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });
});

describe('deprecated requester+subject heuristic', () => {
  const flagOn = { externalRefCustomFieldKey: null, apiResubmissionMatchEnabled: true, apiResubmissionMatchWindowDays: 7 };

  test('flag off → never consulted (always a plain create)', async () => {
    const res = await service.deriveExternalRef(WS, PA_BODY, { apiResubmissionMatchEnabled: false }, { actor });
    expect(res.ticket).toBeNull();
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
    expect(requesterRepositoryMock.findByEmail).not.toHaveBeenCalled();
  });

  test('one candidate inside the window, same key, identical normalized subject → subject_heuristic match', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([existing({ subject: 'RE: Coyote  landslide!' })]);
    prismaMock.ticketActivity.findMany.mockResolvedValueOnce([{ ticketId: 480, details: { actorEmail: 'apikey:tp_live_x' } }]);
    const before = Date.now();
    const res = await service.deriveExternalRef(WS, PA_BODY, flagOn, { actor });
    expect(res).toMatchObject({ ref: null, matchedBy: 'subject_heuristic', ticket: expect.objectContaining({ id: 480 }), ambiguous: false });

    // Query shape: same ws + requester, API-born TP tickets, Open/Pending-base
    // statuses, created within the window (7 days), newest first.
    const { where, orderBy } = prismaMock.ticket.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ workspaceId: WS, requesterId: 40, origin: 'ticketpulse', source: 100, isNoise: false, status: { in: ['Open', 'Pending', 'Waiting on vendor'] } });
    const gte = where.createdAt.gte.getTime();
    expect(before - gte).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(before - gte).toBeLessThan(7.1 * 24 * 3600 * 1000);
    expect(orderBy).toEqual({ createdAt: 'desc' });
  });

  test('window days honoured (30) — the lower bound moves accordingly', async () => {
    await service.deriveExternalRef(WS, PA_BODY, { ...flagOn, apiResubmissionMatchWindowDays: 30 }, { actor });
    const { where } = prismaMock.ticket.findMany.mock.calls[0][0];
    expect(Date.now() - where.createdAt.gte.getTime()).toBeGreaterThan(29.9 * 24 * 3600 * 1000);
  });

  test('out of window / no candidate rows → no match (the DB filter returns nothing)', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([]);
    const res = await service.deriveExternalRef(WS, PA_BODY, flagOn, { actor });
    expect(res).toMatchObject({ ticket: null, ambiguous: false, matchedBy: null });
  });

  test('subject differs after normalization → no match', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([existing({ subject: 'Coyote Landslide phase 2' })]);
    const res = await service.deriveExternalRef(WS, PA_BODY, flagOn, { actor });
    expect(res.ticket).toBeNull();
  });

  test('two candidates → NO match, resubmissionAmbiguous with the candidate refs', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([
      existing({ id: 481, nativeNumber: 1002, subject: 'Coyote Landslide' }),
      existing({ id: 480, nativeNumber: 1001, subject: 'coyote landslide' }),
    ]);
    prismaMock.ticketActivity.findMany.mockResolvedValueOnce([
      { ticketId: 481, details: { actorEmail: 'apikey:tp_live_x' } },
      { ticketId: 480, details: { actorEmail: 'apikey:tp_live_x' } },
    ]);
    const res = await service.deriveExternalRef(WS, PA_BODY, flagOn, { actor });
    expect(res).toMatchObject({ ticket: null, matchedBy: null, ambiguous: true });
    expect(res.candidates).toEqual(['TP-1002', 'TP-1001']);
  });

  test('a candidate created by a DIFFERENT API key is never ours to update', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([existing()]);
    prismaMock.ticketActivity.findMany.mockResolvedValueOnce([{ ticketId: 480, details: { actorEmail: 'apikey:tp_live_other' } }]);
    const res = await service.deriveExternalRef(WS, PA_BODY, flagOn, { actor });
    expect(res.ticket).toBeNull();
    expect(res.ambiguous).toBe(false);
  });

  test('unknown requester or generic subject → no probe at all', async () => {
    requesterRepositoryMock.findByEmail.mockResolvedValueOnce(null);
    expect((await service.deriveExternalRef(WS, PA_BODY, flagOn, { actor })).ticket).toBeNull();
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
    expect((await service.deriveExternalRef(WS, { ...PA_BODY, subject: 'help' }, flagOn, { actor })).ticket).toBeNull();
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });

  test('explicit externalRef / bridge key short-circuit the heuristic even when the flag is on', async () => {
    await service.deriveExternalRef(WS, PA_BODY, { ...flagOn, externalRefCustomFieldKey: 'power_app_record_id' }, { actor });
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });
});
