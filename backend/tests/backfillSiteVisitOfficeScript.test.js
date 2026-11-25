import { jest } from '@jest/globals';

/**
 * scripts/backfill-site-visit-office.mjs (25 Nov 2026): dry run by default.
 * Sets the office a site visit's note names and refreshes its dashboard rows;
 * lists Vacation Tracker rows that repeat a Vacation Pulse row and, with
 * --apply, deletes those rows (never a request). Prisma mocked; invented
 * people and notes only.
 */
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { runBackfill, parseIds, describeTarget, redactConnection } = await import('../scripts/backfill-site-visit-office.mjs');
const { officeFromNote } = await import('../src/services/availability/siteVisit.js');
const { toDay } = await import('../src/services/availability/availabilityRules.js');

const OFFICES = [
  { id: 1, name: 'Vancouver', timezone: 'America/Vancouver', isActive: true },
  { id: 2, name: 'Toronto', timezone: 'America/Toronto', isActive: true },
  { id: 5, name: 'North Vancouver', timezone: 'America/Vancouver', isActive: true },
  { id: 9, name: 'Old Depot', timezone: 'America/Edmonton', isActive: false },
];

describe('which office a note names', () => {
  test('notes like the ones in the backlog name Toronto', () => {
    expect(officeFromNote('Toronto', OFFICES)?.name).toBe('Toronto');
    expect(officeFromNote('Toronto site visit with Quill Marrowby', OFFICES)?.name).toBe('Toronto');
    expect(officeFromNote('toronto office visit', OFFICES)?.name).toBe('Toronto');
  });

  test('whole words only, longest name wins, two unrelated offices are ambiguous', () => {
    expect(officeFromNote('Torontonian client lunch', OFFICES)).toBeNull();
    expect(officeFromNote('Visiting the North Vancouver office', OFFICES)?.name).toBe('North Vancouver');
    expect(officeFromNote('Toronto, then Vancouver', OFFICES)).toBeNull();
    expect(officeFromNote('', OFFICES)).toBeNull();
    expect(officeFromNote(null, OFFICES)).toBeNull();
  });
});

function prismaWith() {
  const day = new Date('2026-11-27T00:00:00Z');
  return {
    avOffice: { findMany: jest.fn().mockResolvedValue(OFFICES) },
    avLeaveType: {
      findMany: jest.fn().mockResolvedValue([
        { id: 4, name: 'Site visit', availability: 'ONSITE', vtLeaveTypeNames: ['site visit', 'business trip'] },
        { id: 1, name: 'Vacation', availability: 'OFF', vtLeaveTypeNames: ['vacation'] },
      ]),
    },
    avRequest: {
      findMany: jest.fn(async ({ where }) => {
        if (where.leaveTypeId) {
          return [
            { id: 9101, email: 'ari.stone@example.com', note: 'Toronto', startDate: toDay('2026-11-27'), endDate: toDay('2026-11-27'), source: 'app', externalId: null },
            { id: 9102, email: 'bo.reyes@example.com', note: 'Toronto site visit with Quill Marrowby', startDate: toDay('2026-12-02'), endDate: toDay('2026-12-03'), source: 'vacation_tracker', externalId: 'vt:leaveRequest-b9' },
            { id: 9103, email: 'cy.nolan@example.com', note: 'toronto office visit', startDate: toDay('2026-12-08'), endDate: toDay('2026-12-08'), source: 'app', externalId: 'vt:leaveRequest-c1' },
            { id: 9104, email: 'dee.park@example.com', note: 'Client plant', startDate: toDay('2026-12-10'), endDate: toDay('2026-12-10'), source: 'app', externalId: null },
          ];
        }
        const base = { email: 'ari.stone@example.com', leaveTypeId: 4, startDate: toDay('2026-11-27'), endDate: toDay('2026-11-27'), dayPart: 'full', status: 'approved' };
        if (where.source === 'vacation_tracker') return [{ ...base, id: 9110, source: 'vacation_tracker', externalId: 'vt:leaveRequest-a7' }];
        return [{ ...base, id: 9101, source: 'app', externalId: null }];
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    technicianLeave: {
      count: jest.fn().mockResolvedValue(1),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([
        { id: 71, workspaceId: 1, technicianId: 11, leaveDate: day, leaveTypeName: 'Site visit', category: 'OTHER', vtLeaveId: 'av:9101:w1' },
        { id: 72, workspaceId: 1, technicianId: 11, leaveDate: day, leaveTypeName: 'Site Visit', category: 'OTHER', vtLeaveId: 'leaveRequest-a7' },
        { id: 73, workspaceId: 1, technicianId: 12, leaveDate: day, leaveTypeName: 'Site Visit', category: 'OTHER', vtLeaveId: 'leaveRequest-b9' },
        // A morning booked here and a full day in Vacation Tracker: not the same leave, kept.
        { id: 74, workspaceId: 1, technicianId: 13, leaveDate: day, leaveTypeName: 'Vacation', category: 'OFF', vtLeaveId: 'av:9105:w1', isFullDay: false, halfDayPart: 'AM', startMinute: 0, endMinute: 720 },
        { id: 75, workspaceId: 1, technicianId: 13, leaveDate: day, leaveTypeName: 'Vacation', category: 'OFF', vtLeaveId: 'leaveRequest-d4', isFullDay: true, halfDayPart: null, startMinute: null, endMinute: null },
      ]),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

test('dry run: lists the offices to set, the duplicate rows and the request pairs; writes nothing', async () => {
  const prisma = prismaWith();
  const lines = [];
  const out = await runBackfill({ prisma, now: new Date('2026-11-25T18:00:00Z'), log: (l) => lines.push(l) });
  expect(out.offices.map((o) => [o.requestId, o.officeName])).toEqual([[9101, 'Toronto'], [9102, 'Toronto'], [9103, 'Toronto']]);
  expect(out.duplicateRows.map((p) => [p.vtRow.id, p.appRow.id])).toEqual([[72, 71]]);
  expect(out.requestPairs.map((p) => [p.imported.id, p.booked.id])).toEqual([[9110, 9101]]);
  expect(prisma.avRequest.update).not.toHaveBeenCalled();
  expect(prisma.technicianLeave.updateMany).not.toHaveBeenCalled();
  expect(prisma.technicianLeave.deleteMany).not.toHaveBeenCalled();
  const text = lines.join('\n');
  expect(text).toContain('DRY-RUN');
  expect(text).toContain('#9104 dee.park@example.com');
  expect(text).toContain('no office named, left alone');
  expect(text).toContain("row 72 'leaveRequest-a7' \"Site Visit\" repeats 'av:9101:w1'");
  expect(text).toContain('Dry run: 3 office(s) to set, 1 duplicate row(s) to delete');
  // The rows refreshed for an imported visit include the leave sync's own rows.
  expect(prisma.technicianLeave.count.mock.calls[1][0].where.OR).toEqual([{ vtLeaveId: { startsWith: 'av:9102:' } }, { vtLeaveId: 'leaveRequest-b9' }]);
  // The scan starts 30 days back by default, and reads the part of the day.
  const scan = prisma.technicianLeave.findMany.mock.calls[0][0];
  expect(scan.where.leaveDate.gte.toISOString().slice(0, 10)).toBe('2026-10-26');
  expect(scan.select).toMatchObject({ isFullDay: true, halfDayPart: true, startMinute: true, endMinute: true });
  expect(text).toContain('--apply --ids');
});

test('--apply --ids: only the chosen bookings are written, and only their duplicate rows deleted', async () => {
  const prisma = prismaWith();
  const lines = [];
  const out = await runBackfill({ prisma, apply: true, ids: new Set([9102]), from: '2026-11-01', log: (l) => lines.push(l) });
  expect(prisma.avRequest.update).toHaveBeenCalledTimes(1);
  expect(prisma.avRequest.update.mock.calls[0][0].where).toEqual({ id: 9102 });
  // Row 72 repeats booking 9101, which was not chosen: kept.
  expect(prisma.technicianLeave.deleteMany).not.toHaveBeenCalled();
  expect(out).toMatchObject({ officesSet: 1, rowsDeleted: 0 });
  const text = lines.join('\n');
  expect(text).toContain('#9101 ari.stone@example.com');
  expect(text).toContain('not in --ids, not written');
  expect(text).toContain('booking not in --ids, kept');
});

test('--ids parsing: a comma list of ids; anything else is refused', () => {
  expect([...parseIds('9001, 9002')]).toEqual([9001, 9002]);
  expect(parseIds(null)).toBeNull();
  expect(() => parseIds('')).toThrow('--ids needs');
  expect(() => parseIds('9001,abc')).toThrow('--ids needs');
});

test('the target is said in words; addresses and hosts are never printed', () => {
  const prod = 'postgresql://u:secret@db-prod.example.com:5432/tp?sslmode=require';
  expect(describeTarget({ url: `${prod}&connection_limit=1`, source: 'scripts/.env.prod', prodUrl: prod })).toBe('PRODUCTION database (scripts/.env.prod)');
  // The environment pointing at production without --prod still says PRODUCTION.
  expect(describeTarget({ url: prod, source: 'DATABASE_URL from the environment', prodUrl: prod })).toBe('PRODUCTION database (DATABASE_URL from the environment)');
  expect(describeTarget({ url: 'postgresql://u:p@localhost:5432/tp', source: 'backend/.env' })).toBe('a local database (backend/.env)');
  expect(describeTarget({ url: 'postgresql://u:p@db-dev.example.com/tp', source: 'backend/.env' })).toBe('a remote database (backend/.env)');
  expect(describeTarget({ url: undefined, source: 'backend/.env' })).toBe('no database configured (backend/.env)');
  for (const s of [describeTarget({ url: prod, source: 'x', prodUrl: prod })]) expect(s).not.toMatch(/example\.com|secret|5432/);
  const msg = redactConnection("Can't reach database server at `db-prod.example.com:5432` (postgresql://u:secret@db-prod.example.com:5432/tp), 10.0.0.4:5432");
  expect(msg).not.toMatch(/example\.com|secret|10\.0\.0\.4|5432/);
  expect(msg).toContain('<host>');
});

test('--apply: sets the offices, refreshes their rows, deletes the duplicate rows only', async () => {
  const prisma = prismaWith();
  const out = await runBackfill({ prisma, apply: true, from: '2026-11-01', log: () => {} });
  expect(prisma.avRequest.update).toHaveBeenCalledTimes(3);
  expect(prisma.avRequest.update.mock.calls[0][0]).toMatchObject({
    where: { id: 9101 },
    data: { siteOfficeId: 2, events: { create: { kind: 'site_office_set', details: { officeId: 2, officeName: 'Toronto', from: 'note' } } } },
  });
  expect(prisma.technicianLeave.updateMany.mock.calls[0][0]).toEqual({
    where: { OR: [{ vtLeaveId: { startsWith: 'av:9101:' } }] },
    data: { siteLocation: 'Toronto', siteTimezone: 'America/Toronto' },
  });
  expect(prisma.technicianLeave.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [72] } } });
  expect(out).toMatchObject({ officesSet: 3, rowsRefreshed: 3, rowsDeleted: 1 });
  expect(prisma.technicianLeave.findMany.mock.calls[0][0].where.leaveDate.gte.toISOString().slice(0, 10)).toBe('2026-11-01');
});
