import { jest } from '@jest/globals';

/**
 * 25 Nov 2026: a site visit that names one of our offices puts the person in
 * that office for the day — location, time zone and local time in
 * get_agent_availability, and location matching in find_matching_agents.
 * Without an office the 4.4.17 note stays. The same visit booked in Vacation
 * Tracker and in Vacation Pulse (two leave rows) counts once.
 * Invented people only (example.com).
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn(), findUnique: jest.fn().mockResolvedValue({ origin: 'freshservice' }), groupBy: jest.fn() },
  technician: { findMany: jest.fn() },
  technicianCompetency: { findMany: jest.fn() },
  technicianLeave: { findMany: jest.fn() },
  ticketAssignmentEpisode: { findMany: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
  assignmentConfig: { findUnique: jest.fn() },
  competencyCategory: { findMany: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { getFreshServiceConfigForWorkspace: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn(() => ({ getGroup: jest.fn() })) }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: { isConfigured: jest.fn(() => false), getUserProfile: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() } }));

const { executeTool } = await import('../src/services/assignmentTools.js');

const people = [
  { id: 1, name: 'Ari Stone', email: 'ari@example.com', location: 'Vancouver', timezone: 'America/Vancouver', workStartTime: '09:00', workEndTime: '17:00', freshserviceId: BigInt(101) },
  { id: 2, name: 'Bo Reyes', email: 'bo@example.com', location: 'Vancouver', timezone: 'America/Vancouver', workStartTime: '09:00', workEndTime: '17:00', freshserviceId: BigInt(102) },
  { id: 3, name: 'Cy Nolan', email: 'cy@example.com', location: 'Toronto', timezone: 'America/Toronto', workStartTime: '09:00', workEndTime: '17:00', freshserviceId: BigInt(103) },
];
const day = new Date('2026-05-22T00:00:00.000Z');
const row = (technicianId, extra) => ({
  technicianId, leaveDate: day, status: 'APPROVED', category: 'OTHER', leaveTypeName: 'Site visit',
  isFullDay: true, halfDayPart: null, startMinute: null, endMinute: null, siteLocation: null, siteTimezone: null, ...extra,
});
const TORONTO = { siteLocation: 'Toronto', siteTimezone: 'America/Toronto' };

beforeEach(() => {
  // Fri 22 May 2026, 12:00 in Vancouver = 15:00 in Toronto.
  jest.useFakeTimers().setSystemTime(new Date('2026-05-22T19:00:00.000Z'));
  jest.clearAllMocks();
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver' });
  prismaMock.technician.findMany.mockResolvedValue(people);
  prismaMock.technicianCompetency.findMany.mockResolvedValue([]);
  prismaMock.assignmentConfig.findUnique.mockResolvedValue(null);
  prismaMock.ticket.groupBy.mockResolvedValue([]);
  prismaMock.ticketAssignmentEpisode.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.competencyCategory.findMany.mockResolvedValue([]);
});
afterEach(() => jest.useRealTimers());

describe('get_agent_availability: the visit names an office', () => {
  test('full day in Toronto: location, time zone and local time are Toronto, with the office note', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([row(1, { vtLeaveId: 'av:574:w1', ...TORONTO })]);
    const out = await executeTool('get_agent_availability', {}, { workspaceId: 1 });
    const ari = out.inOffice.find((p) => p.techId === 1);
    expect(ari).toMatchObject({
      siteVisit: true,
      leaveType: 'Site visit',
      location: 'Toronto',
      homeLocation: 'Vancouver',
      siteLocation: 'Toronto',
      timezone: 'America/Toronto',
      localTime: '15:00',
      onShift: true,
      note: 'On a site visit in Toronto today — in the office there; good for on-site work in Toronto',
    });
    // Everyone else unchanged.
    expect(out.inOffice.find((p) => p.techId === 2)).toMatchObject({ location: 'Vancouver', timezone: 'America/Vancouver', localTime: '12:00' });
    expect(out.summary).toMatchObject({ inOffice: 3, off: 0 });
  });

  test('the Toronto local clock decides the shift: 08:00 in Vancouver is already on shift in Toronto', async () => {
    jest.setSystemTime(new Date('2026-05-22T15:00:00.000Z')); // 08:00 PT, 11:00 ET
    prismaMock.technicianLeave.findMany.mockResolvedValue([row(1, { vtLeaveId: 'av:574:w1', ...TORONTO })]);
    const out = await executeTool('get_agent_availability', {}, { workspaceId: 1 });
    expect(out.inOffice.find((p) => p.techId === 1)).toMatchObject({ localTime: '11:00', onShift: true });
    expect(out.inOffice.find((p) => p.techId === 2)).toMatchObject({ localTime: '08:00', onShift: false });
  });

  test('half day: the note names the window', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([
      row(1, { vtLeaveId: 'av:575:w1', ...TORONTO, isFullDay: false, halfDayPart: 'PM', startMinute: 720, endMinute: 1440 }),
    ]);
    const out = await executeTool('get_agent_availability', {}, { workspaceId: 1 });
    expect(out.inOffice.find((p) => p.techId === 1)).toMatchObject({
      siteVisit: true,
      location: 'Toronto',
      timezone: 'America/Toronto',
      leaveWindow: '12:00-24:00',
      note: 'On a site visit in Toronto 12:00-24:00 — in the office there; good for on-site work in Toronto during that window',
    });
    expect(out.halfDayOff).toEqual([]);
  });

  test('no office: the 4.4.17 note, own location; an "Other site" text rides along', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([
      row(1, { vtLeaveId: 'leaveRequest-a1' }),
      row(2, { vtLeaveId: 'av:576:w1', siteLocation: 'Client plant, Kamloops' }),
    ]);
    const out = await executeTool('get_agent_availability', {}, { workspaceId: 1 });
    const ari = out.inOffice.find((p) => p.techId === 1);
    expect(ari).toMatchObject({ siteVisit: true, location: 'Vancouver', timezone: 'America/Vancouver', note: 'On a site visit today — working, available for assignment (may be at another office)' });
    expect(ari.siteLocation).toBeUndefined();
    expect(out.inOffice.find((p) => p.techId === 2)).toMatchObject({
      location: 'Vancouver', siteLocation: 'Client plant, Kamloops', note: 'On a site visit today — working, available for assignment (may be at another office)',
    });
  });

  test('the same visit booked in Vacation Tracker and in Vacation Pulse counts once (the Vacation Pulse row wins)', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([
      row(1, { vtLeaveId: 'leaveRequest-b2', leaveTypeName: 'Site Visit', isFullDay: false, halfDayPart: 'PM', startMinute: 780, endMinute: 1020 }),
      row(1, { vtLeaveId: 'av:577:w1', ...TORONTO, isFullDay: false, halfDayPart: 'PM', startMinute: 780, endMinute: 1020 }),
    ]);
    const out = await executeTool('get_agent_availability', {}, { workspaceId: 1 });
    const ari = out.inOffice.filter((p) => p.techId === 1);
    expect(ari).toHaveLength(1);
    expect(ari[0]).toMatchObject({ location: 'Toronto', leaveWindow: '13:00-17:00' });
    expect(out.summary.inOffice).toBe(3);
  });

  test('two different leaves of one day are not collapsed (half-day off + half-day site visit)', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([
      row(1, { vtLeaveId: 'leaveRequest-c3', category: 'OFF', leaveTypeName: 'Vacation', isFullDay: false, halfDayPart: 'AM', startMinute: 0, endMinute: 720 }),
      row(1, { vtLeaveId: 'av:578:w1', ...TORONTO, isFullDay: false, halfDayPart: 'PM', startMinute: 720, endMinute: 1440 }),
    ]);
    const out = await executeTool('get_agent_availability', {}, { workspaceId: 1 });
    expect(out.halfDayOff.map((p) => p.techId)).toEqual([1]);
    expect(out.inOffice.find((p) => p.techId === 1)).toMatchObject({ siteVisit: true, location: 'Toronto' });
  });
});

describe('find_matching_agents: on-site work matches where the person is today', () => {
  test('a Vancouver person visiting Toronto matches a Toronto ticket and no longer matches Vancouver', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([row(1, { vtLeaveId: 'av:574:w1', ...TORONTO })]);
    const toronto = await executeTool('find_matching_agents', { preferred_location: 'Toronto', requires_physical_presence: true }, { workspaceId: 1, ticketId: 900 });
    const byName = Object.fromEntries(toronto.matches.map((m) => [m.techName, m]));
    expect(byName['Ari Stone']).toMatchObject({ locationMatch: true, location: 'Toronto', homeLocation: 'Vancouver', siteVisit: true, timezone: 'America/Toronto' });
    expect(byName['Cy Nolan']).toMatchObject({ locationMatch: true, location: 'Toronto' });
    expect(byName['Bo Reyes']).toMatchObject({ locationMatch: false, location: 'Vancouver' });

    const vancouver = await executeTool('find_matching_agents', { preferred_location: 'Vancouver', requires_physical_presence: true }, { workspaceId: 1, ticketId: 900 });
    const v = Object.fromEntries(vancouver.matches.map((m) => [m.techName, m]));
    expect(v['Ari Stone'].locationMatch).toBe(false);
    expect(v['Bo Reyes'].locationMatch).toBe(true);
  });

  test('a visit with no office leaves location matching on the home office', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([row(1, { vtLeaveId: 'leaveRequest-a1' })]);
    const out = await executeTool('find_matching_agents', { preferred_location: 'Vancouver' }, { workspaceId: 1, ticketId: 900 });
    const ari = out.matches.find((m) => m.techName === 'Ari Stone');
    expect(ari).toMatchObject({ locationMatch: true, location: 'Vancouver' });
    expect(ari.siteVisit).toBeUndefined();
  });
});
