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

const { runBackfill } = await import('../scripts/backfill-site-visit-office.mjs');
const { officeFromNote } = await import('../src/services/availability/siteVisit.js');
const { toDay } = await import('../src/services/availability/availabilityRules.js');

const OFFICES = [
  { id: 1, name: 'Vancouver', timezone: 'America/Vancouver', isActive: true },
  { id: 2, name: 'Toronto', timezone: 'America/Toronto', isActive: true },
  { id: 5, name: 'North Vancouver', timezone: 'America/Vancouver', isActive: true },
  { id: 9, name: 'Old Depot', timezone: 'America/Edmonton', isActive: false },
];

describe('which office a note names', () => {
  test('the three production notes all name Toronto', () => {
    expect(officeFromNote('Toronto', OFFICES)?.name).toBe('Toronto');
    expect(officeFromNote('Toronto site visit with Sam Ortiz', OFFICES)?.name).toBe('Toronto');
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
            { id: 601, email: 'ari.stone@example.com', note: 'Toronto', startDate: toDay('2026-11-27'), endDate: toDay('2026-11-27'), source: 'app', externalId: null },
            { id: 602, email: 'bo.reyes@example.com', note: 'Toronto site visit with Sam Ortiz', startDate: toDay('2026-12-02'), endDate: toDay('2026-12-03'), source: 'vacation_tracker', externalId: 'vt:leaveRequest-b9' },
            { id: 603, email: 'cy.nolan@example.com', note: 'toronto office visit', startDate: toDay('2026-12-08'), endDate: toDay('2026-12-08'), source: 'app', externalId: 'vt:leaveRequest-c1' },
            { id: 604, email: 'dee.park@example.com', note: 'Client plant', startDate: toDay('2026-12-10'), endDate: toDay('2026-12-10'), source: 'app', externalId: null },
          ];
        }
        const base = { email: 'ari.stone@example.com', leaveTypeId: 4, startDate: toDay('2026-11-27'), endDate: toDay('2026-11-27'), dayPart: 'full', status: 'approved' };
        if (where.source === 'vacation_tracker') return [{ ...base, id: 610, source: 'vacation_tracker', externalId: 'vt:leaveRequest-a7' }];
        return [{ ...base, id: 601, source: 'app', externalId: null }];
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    technicianLeave: {
      count: jest.fn().mockResolvedValue(1),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([
        { id: 71, workspaceId: 1, technicianId: 11, leaveDate: day, leaveTypeName: 'Site visit', category: 'OTHER', vtLeaveId: 'av:601:w1' },
        { id: 72, workspaceId: 1, technicianId: 11, leaveDate: day, leaveTypeName: 'Site Visit', category: 'OTHER', vtLeaveId: 'leaveRequest-a7' },
        { id: 73, workspaceId: 1, technicianId: 12, leaveDate: day, leaveTypeName: 'Site Visit', category: 'OTHER', vtLeaveId: 'leaveRequest-b9' },
      ]),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

test('dry run: lists the offices to set, the duplicate rows and the request pairs; writes nothing', async () => {
  const prisma = prismaWith();
  const lines = [];
  const out = await runBackfill({ prisma, now: new Date('2026-11-25T18:00:00Z'), log: (l) => lines.push(l) });
  expect(out.offices.map((o) => [o.requestId, o.officeName])).toEqual([[601, 'Toronto'], [602, 'Toronto'], [603, 'Toronto']]);
  expect(out.duplicateRows.map((p) => [p.vtRow.id, p.appRow.id])).toEqual([[72, 71]]);
  expect(out.requestPairs.map((p) => [p.imported.id, p.booked.id])).toEqual([[610, 601]]);
  expect(prisma.avRequest.update).not.toHaveBeenCalled();
  expect(prisma.technicianLeave.updateMany).not.toHaveBeenCalled();
  expect(prisma.technicianLeave.deleteMany).not.toHaveBeenCalled();
  const text = lines.join('\n');
  expect(text).toContain('DRY-RUN');
  expect(text).toContain('#604 dee.park@example.com');
  expect(text).toContain('no office named, left alone');
  expect(text).toContain("row 72 'leaveRequest-a7' \"Site Visit\" repeats 'av:601:w1'");
  expect(text).toContain('Dry run: 3 office(s) to set, 1 duplicate row(s) to delete');
  // The rows refreshed for an imported visit include the leave sync's own rows.
  expect(prisma.technicianLeave.count.mock.calls[1][0].where.OR).toEqual([{ vtLeaveId: { startsWith: 'av:602:' } }, { vtLeaveId: 'leaveRequest-b9' }]);
  // The scan starts 30 days back by default.
  expect(prisma.technicianLeave.findMany.mock.calls[0][0].where.leaveDate.gte.toISOString().slice(0, 10)).toBe('2026-10-26');
});

test('--apply: sets the offices, refreshes their rows, deletes the duplicate rows only', async () => {
  const prisma = prismaWith();
  const out = await runBackfill({ prisma, apply: true, from: '2026-11-01', log: () => {} });
  expect(prisma.avRequest.update).toHaveBeenCalledTimes(3);
  expect(prisma.avRequest.update.mock.calls[0][0]).toMatchObject({
    where: { id: 601 },
    data: { siteOfficeId: 2, events: { create: { kind: 'site_office_set', details: { officeId: 2, officeName: 'Toronto', from: 'note' } } } },
  });
  expect(prisma.technicianLeave.updateMany.mock.calls[0][0]).toEqual({
    where: { OR: [{ vtLeaveId: { startsWith: 'av:601:' } }] },
    data: { siteLocation: 'Toronto', siteTimezone: 'America/Toronto' },
  });
  expect(prisma.technicianLeave.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [72] } } });
  expect(out).toMatchObject({ officesSet: 3, rowsRefreshed: 3, rowsDeleted: 1 });
  expect(prisma.technicianLeave.findMany.mock.calls[0][0].where.leaveDate.gte.toISOString().slice(0, 10)).toBe('2026-11-01');
});
