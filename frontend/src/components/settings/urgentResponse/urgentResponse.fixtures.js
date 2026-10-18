// Shared test data for the Urgent Response settings tests: the shapes are the
// API contract in plans/URGENT_RESPONSE_PLAN.md.

// 17:00 in Vancouver after 1 Nov 2026, as the server computes it: 00:00Z on runtimes
// that know BC's permanent UTC-7 (tzdata 2026b+), 01:00Z on older ones.
const bcPermanent = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hour: 'numeric', hourCycle: 'h23' })
  .format(new Date('2026-11-03T00:00:00Z')) === '17';
const after1Nov = (day) => `2026-11-${day}T0${bcPermanent ? 0 : 1}:00:00Z`;

const person = (id, name, extra = {}) => ({
  id, name, email: `${name.split(' ')[0].toLowerCase()}@x.ca`, isActive: true, timezone: 'America/Vancouver', workStartTime: '09:00', workEndTime: '17:00', ...extra,
});

export const TECHS = [
  person(1, 'David Zapata'),
  person(2, 'Andrew Fong'),
  person(3, 'Maria Lee'),
  person(4, 'Susan Xu'),
  person(5, 'Gone Person', { isActive: false }),
];

export const SETTINGS = {
  mode: 'observe',
  assignEnabled: true, assignPriorities: [4, 3], assignGraceMinutes: 30,
  raiseEnabled: true, raisePriorities: [4], raiseManualAction: 'notify',
  clockEnabled: true, clockPriorities: [4], clockNotifyMinutes: 15, clockMoveMinutes: 30,
  notifyAudience: 'on_shift', notifyTechnicianIds: [], notifyChannels: ['teams', 'email'],
  nobodyMode: 'hold', nobodyContactTechnicianId: 4, coordinatorTechnicianId: null, maxMoves: 2,
  onCallOrder: [1, 2, 3], onCallHandoverDay: 1, onCallHandoverTime: '17:00', onCallAnchorDate: '2026-10-05',
  updatedBy: 'vahid@x.ca', updatedAt: '2026-10-09T18:00:00Z',
};

export const SETTINGS_DATA = { settings: SETTINGS, technicians: TECHS, teamsEnabled: true, onCallOrderSuggested: false };

export const PREVIEW = {
  days: 30, estimate: true, inScopeTickets: 41,
  assign: { redirected: 12, held: 0 }, raise: { moved: 3, told: 0 }, clock: { teamTold: 5, moved: 1, coordinator: 0 },
};

// Handover Monday 17:00 Vancouver time: 00:00Z in summer, 01:00Z after 1 Nov.
export const ON_CALL = {
  timezone: 'America/Vancouver',
  handoverDay: 1,
  handoverTime: '17:00',
  current: { technician: { id: 1, name: 'David Zapata' }, scheduled: { id: 1, name: 'David Zapata' }, cover: null, until: '2026-10-20T00:00:00Z' },
  weeks: [
    { index: 0, startsAt: '2026-10-13T00:00:00Z', endsAt: '2026-10-20T00:00:00Z', scheduled: { id: 1, name: 'David Zapata' }, covers: [], leaveDays: [], needsCover: false, openRequest: null },
    { index: 1, startsAt: '2026-10-20T00:00:00Z', endsAt: '2026-10-27T00:00:00Z', scheduled: { id: 2, name: 'Andrew Fong' }, covers: [], leaveDays: ['2026-10-22', '2026-10-23'], needsCover: true, openRequest: null },
    {
      index: 2, startsAt: '2026-10-27T00:00:00Z', endsAt: after1Nov('03'), scheduled: { id: 3, name: 'Maria Lee' }, leaveDays: [], needsCover: false, openRequest: null,
      covers: [{ id: 7, technician: { id: 1, name: 'David Zapata' }, startsAt: '2026-10-29T16:00:00Z', endsAt: after1Nov('03'), note: '', source: 'admin' }],
    },
    {
      index: 3, startsAt: after1Nov('03'), endsAt: after1Nov('10'), scheduled: { id: 1, name: 'David Zapata' }, covers: [], leaveDays: ['2026-11-05'], needsCover: true,
      openRequest: { id: 11, status: 'open', askedCount: 4, declinedCount: 1 },
    },
  ],
  me: { technicianId: 1 },
};

export const ok = (data) => ({ success: true, data });
