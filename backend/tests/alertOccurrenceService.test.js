import { jest } from '@jest/globals';

/** Sentinel integration (24 Sep 2026): one call per alert, decided server-side. */
const DAY = 24 * 3600 * 1000;
let tickets;
let refsRows;
let nextId;

const prismaMock = {
  ticket: {
    findFirst: jest.fn(async ({ where }) => tickets.find((t) => t.workspaceId === where.workspaceId && t.externalRef === where.externalRef) || null),
    findUnique: jest.fn(async ({ where }) => tickets.find((t) => t.id === where.id) || null),
    update: jest.fn(async ({ where, data }) => {
      const t = tickets.find((x) => x.id === where.id);
      for (const [k, v] of Object.entries(data)) t[k] = (v && typeof v === 'object' && 'increment' in v) ? (t[k] || 0) + v.increment : v;
      return t;
    }),
  },
  ticketTag: { findMany: jest.fn(async () => [{ id: 15, name: 'sentinel' }]) },
  ticketExternalReference: {
    findFirst: jest.fn(async ({ where }) => refsRows.find((r) => r.workspaceId === where.workspaceId && r.system === where.system && r.refKey === where.refKey) || null),
    createMany: jest.fn(async ({ data }) => {
      let count = 0;
      for (const d of data) if (!refsRows.some((r) => r.workspaceId === d.workspaceId && r.system === d.system && r.refKey === d.refKey)) { refsRows.push(d); count++; }
      return { count };
    }),
  },
  workspace: { findUnique: jest.fn(async () => ({ defaultTimezone: 'America/Vancouver' })) },
};
const ticketServiceMock = {
  createTicket: jest.fn(async (ws, input) => {
    if (tickets.some((t) => t.externalRef === input.externalRef)) {
      const e = new Error('exists'); e.code = 'external_ref_exists'; throw e;
    }
    const t = { id: nextId++, workspaceId: ws, externalRef: input.externalRef, status: 'Open', origin: 'ticketpulse', priority: input.priority, occurrenceCount: 0, resolvedAt: null, closedAt: null, updatedAt: new Date() };
    tickets.push(t);
    return t;
  }),
  changeStatus: jest.fn(async (id, ws, status) => { tickets.find((t) => t.id === id).status = status; }),
  updateTicketFields: jest.fn(async (id, ws, fields) => { Object.assign(tickets.find((t) => t.id === id), fields); }),
  addPrivateNote: jest.fn(async () => ({ entry: { id: 1 } })),
};
const linkMock = { link: jest.fn(async () => ({})) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/ticketLinkService.js', () => ({ default: linkMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: {
    baseStatusOf: jest.fn(async (_ws, s) => ({ Open: 'Open', Pending: 'Pending', Resolved: 'Resolved', Closed: 'Closed' }[s] || null)),
    statusNamesForBase: jest.fn(async () => ['Open']),
  },
}));

const { default: svc, normalizeAlertBody } = await import('../src/services/alertOccurrenceService.js');

const ACTOR = { name: 'Microsoft Sentinel', email: 'apikey:tpc_sen', role: 'api', trustedIntake: true };
const FP = 'sentinel:9f2c7d0b5a1e4c3f8e6d2b9a7c5e3f1d0b8a6c4e2f0d9b7a5c3e1f0d8b6a4e41a';
const alert = (over = {}) => ({
  fingerprint: FP, fingerprintDisplay: 'ftp-down|host:bgc-van-ftp01', title: '[Sentinel] FTP service down: BGC-VAN-FTP01',
  description: '<p>FTP down</p>', severity: 'Medium', requesterEmail: 'sentinel@bgcengineering.ca', tags: ['sentinel'],
  reference: { system: 'sentinel', incidentId: 'inc-1', incidentNumber: 48213, alertId: 'alert-1', url: 'https://portal.azure.com/#x', time: '2026-09-24T17:14:00Z' },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  tickets = []; refsRows = []; nextId = 100;
});

test('validation: fingerprint, title, requester; Informational is refused; severity maps to priority', () => {
  expect(() => normalizeAlertBody({ ...alert(), fingerprint: 'x' })).toThrow(/fingerprint/);
  expect(() => normalizeAlertBody({ ...alert(), title: '' })).toThrow(/title/);
  expect(() => normalizeAlertBody({ ...alert(), requesterEmail: '' })).toThrow(/requesterEmail/);
  expect(() => normalizeAlertBody({ ...alert(), severity: 'Informational' })).toThrow(expect.objectContaining({ code: 'informational_not_ticketed' }));
  expect(normalizeAlertBody(alert({ severity: 'High' })).priority).toBe(3);
  expect(normalizeAlertBody(alert({ severity: 'High', priority: 4 })).priority).toBe(4);
  expect(normalizeAlertBody(alert()).reopenWithinDays).toBe(7);
});

test('first alert → created, count 1, reference stored, fingerprint is the externalRef, tag resolved by name', async () => {
  const r = await svc.record(1, alert(), ACTOR);
  expect(r).toMatchObject({ action: 'created', occurrenceCount: 1, priorityRaised: false });
  expect(ticketServiceMock.createTicket).toHaveBeenCalledWith(1, expect.objectContaining({ externalRef: FP, priority: 2, tagIds: [15], customFields: { alert_fingerprint: 'ftp-down|host:bgc-van-ftp01' } }), ACTOR, expect.any(Object));
  expect(refsRows).toHaveLength(1);
  expect(refsRows[0]).toMatchObject({ system: 'sentinel', externalId: 'inc-1', alertId: 'alert-1', refKey: 'alert:alert-1' });
});

test('repeat on an open ticket → occurrence: count 2, note, reference added, no new ticket', async () => {
  await svc.record(1, alert(), ACTOR);
  const r = await svc.record(1, alert({ reference: { incidentId: 'inc-2', incidentNumber: 48260, alertId: 'alert-2' } }), ACTOR);
  expect(r).toMatchObject({ action: 'occurrence', occurrenceCount: 2 });
  expect(ticketServiceMock.createTicket).toHaveBeenCalledTimes(1);
  expect(ticketServiceMock.addPrivateNote).toHaveBeenCalledWith(100, 1, expect.objectContaining({ bodyText: expect.stringContaining('Repeat occurrence #2') }), ACTOR);
  expect(refsRows).toHaveLength(2);
});

test('a more severe repeat raises priority; a milder one never lowers it', async () => {
  await svc.record(1, alert({ severity: 'Medium' }), ACTOR);
  const up = await svc.record(1, alert({ severity: 'High', reference: { incidentId: 'inc-2', alertId: 'a2' } }), ACTOR);
  expect(up.priorityRaised).toBe(true);
  expect(ticketServiceMock.updateTicketFields).toHaveBeenCalledWith(100, 1, { priority: 3 }, ACTOR);
  const down = await svc.record(1, alert({ severity: 'Low', reference: { incidentId: 'inc-3', alertId: 'a3' } }), ACTOR);
  expect(down.priorityRaised).toBe(false);
  expect(tickets[0].priority).toBe(3);
});

test('retrying the same alert id changes nothing (duplicate)', async () => {
  await svc.record(1, alert(), ACTOR);
  const again = await svc.record(1, alert(), ACTOR);
  expect(again).toMatchObject({ action: 'duplicate', ticketId: 100, occurrenceCount: 1 });
  expect(ticketServiceMock.addPrivateNote).not.toHaveBeenCalled();
});

test('resolved within the window → reopened to the default open status, with a note', async () => {
  await svc.record(1, alert(), ACTOR);
  Object.assign(tickets[0], { status: 'Resolved', resolvedAt: new Date(Date.now() - 2 * DAY) });
  const r = await svc.record(1, alert({ reference: { incidentId: 'inc-9', alertId: 'a9' } }), ACTOR);
  expect(r).toMatchObject({ action: 'reopened', ticketId: 100, occurrenceCount: 2 });
  expect(ticketServiceMock.changeStatus).toHaveBeenCalledWith(100, 1, 'Open', ACTOR);
  expect(ticketServiceMock.addPrivateNote.mock.calls[0][2].bodyText).toMatch(/^Reopened/);
});

test('closed before the window → a NEW ticket takes the fingerprint and is linked to the old one', async () => {
  await svc.record(1, alert(), ACTOR);
  Object.assign(tickets[0], { status: 'Closed', closedAt: new Date(Date.now() - 10 * DAY) });
  const r = await svc.record(1, alert({ reference: { incidentId: 'inc-10', alertId: 'a10' } }), ACTOR);
  expect(r).toMatchObject({ action: 'created', ticketId: 101, previousTicketId: 100, occurrenceCount: 1 });
  expect(tickets[0].externalRef).toBeNull();
  expect(tickets[1].externalRef).toBe(FP);
  expect(linkMock.link).toHaveBeenCalledWith(101, 1, { relatedTicketId: 100, kind: 'related_to' }, ACTOR);
});

test('reopenWithinDays: 0 never reopens', async () => {
  await svc.record(1, alert(), ACTOR);
  Object.assign(tickets[0], { status: 'Resolved', resolvedAt: new Date() });
  const r = await svc.record(1, alert({ reopenWithinDays: 0, reference: { incidentId: 'inc-11', alertId: 'a11' } }), ACTOR);
  expect(r.action).toBe('created');
  expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
});

test('two simultaneous first calls make ONE ticket: the second becomes an occurrence', async () => {
  const [a, b] = await Promise.all([
    svc.record(1, alert(), ACTOR),
    svc.record(1, alert({ reference: { incidentId: 'inc-2', alertId: 'alert-2' } }), ACTOR),
  ]);
  expect([a.action, b.action].sort()).toEqual(['created', 'occurrence']);
  expect(tickets).toHaveLength(1);
  expect(tickets[0].occurrenceCount).toBe(2);
});
