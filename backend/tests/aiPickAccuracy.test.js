import { jest } from '@jest/globals';
import {
  PICK_RULES, computePickAccuracy, fetchPickInputs, isSystemActor, normaliseName, pickAccuracyExportRows, rate,
} from '../src/services/aiPickAccuracy.js';

/**
 * Analytics → Automation Ops, "How often the AI's pick stands" (QA 10-13
 * item 16). The counting rules, one fixture per rule: a ticket is counted
 * once by its first full run; what is left out; who "did the ticket"; the two
 * modes (the AI assigned / the AI only suggested); no rate under 20 tickets.
 */
const START = new Date('2026-09-14T07:00:00Z');
const END = new Date('2026-10-14T06:59:59Z');
const NOW = new Date('2026-10-13T20:00:00Z');
const NAMES = new Map([[1, 'Ada Byron'], [2, 'Ben Okri'], [3, 'Cy Twombly'], [4, 'Dee Rees']]);
const at = (iso) => new Date(iso);

let nextRunId = 100;
const run = (ticketId, over = {}) => ({
  id: nextRunId++, ticketId, decision: 'auto_assigned', triggerSource: 'webhook', isRebound: false,
  assignedTechId: 1, createdAt: at('2026-09-20T16:00:00Z'), pickIds: [1, 2, 3], ...over,
});
const ticket = (id, over = {}) => ({
  id, displayRef: `TP-${id}`, subject: `Ticket ${id}`, status: 'Closed', isNoise: false,
  assignedTechId: 1, assignedAt: at('2026-09-20T16:01:00Z'), category: 'Software', ...over,
});
const episode = (ticketId, technicianId, over = {}) => ({
  ticketId, technicianId, startedAt: at('2026-09-20T16:01:00Z'), endedAt: null, startMethod: 'coordinator_assigned',
  startAssignedByName: 'Ticket Pulse', endMethod: 'still_active', endActorName: null, ...over,
});
const compute = (inputs) => computePickAccuracy({
  techNames: NAMES, terminalStatuses: ['Resolved', 'Closed'], serviceAccountNames: ['Ticket Pulse'],
  start: START, end: END, now: NOW, ...inputs,
});

beforeEach(() => { nextRunId = 100; });

describe('helpers', () => {
  test('a rate is a count of N, with a percentage only from 20 tickets', () => {
    expect(rate(5, 19)).toEqual({ n: 5, of: 19, pct: null });
    expect(rate(5, 20)).toEqual({ n: 5, of: 20, pct: 25 });
    expect(rate(0, 0)).toEqual({ n: 0, of: 0, pct: null });
    expect(PICK_RULES.MIN_RATE_SAMPLE).toBe(20);
  });

  test('names compare without the FreshService suffix or a nickname in brackets', () => {
    expect(normaliseName('Reza Zaim (in FreshService)')).toBe('reza zaim');
    expect(normaliseName('Muhammad (Mo) Shahidullah')).toBe('muhammad shahidullah');
  });

  test('Ticket Pulse and its engines are not people', () => {
    expect(isSystemActor('Ticket Pulse', [])).toBe(true);
    expect(isSystemActor('Ticket Pulse (Onboarding)', [])).toBe(true);
    expect(isSystemActor('Ticket Pulse AI', [])).toBe(true);
    expect(isSystemActor('Helpdesk Bot', ['Helpdesk Bot'])).toBe(true);
    expect(isSystemActor('Andrew Fong', ['Ticket Pulse'])).toBe(false);
    expect(isSystemActor(null, ['Ticket Pulse'])).toBe(false);
  });
});

describe('the AI assigned (auto-assign)', () => {
  test('first choice kept: the assignee at close is the first choice', () => {
    const r = compute({ runs: [run(1)], tickets: [ticket(1)], episodes: [episode(1, 1, { endMethod: 'closed', endedAt: at('2026-09-21T16:00:00Z') })] });
    expect(r.leadMode).toBe('auto');
    expect(r.auto.tickets).toBe(1);
    expect(r.auto.firstChoice).toEqual({ n: 1, of: 1, pct: null });
    expect(r.auto.inList.n).toBe(1);
    expect(r.auto.changed.n).toBe(0);
    expect(r.auto.overrides).toEqual([]);
    expect(r.suggest).toBeNull();
  });

  test('handed back by the assignee within the hour, then done by someone on the list after a rebound', () => {
    const r = compute({
      runs: [run(1), run(1, { triggerSource: 'rebound', isRebound: true, assignedTechId: 2, createdAt: at('2026-09-20T16:20:00Z') })],
      tickets: [ticket(1, { assignedTechId: 2 })],
      episodes: [
        episode(1, 1, { endMethod: 'rejected', endedAt: at('2026-09-20T16:13:00Z'), endActorName: 'Ada Byron' }),
        episode(1, 2, { startedAt: at('2026-09-20T16:21:00Z'), endMethod: 'closed', endedAt: at('2026-09-22T16:00:00Z') }),
      ],
    });
    expect(r.auto.tickets).toBe(1); // counted once, by its first full run
    expect(r.auto.firstChoice.n).toBe(0);
    expect(r.auto.inList.n).toBe(1);
    expect(r.auto.changed.n).toBe(1);
    expect(r.auto.changes).toEqual({ handedBack: 1, movedByOther: 0, unknown: 0, withinHour: 1, later: 0, timeUnknown: 0, rebounded: 1, movedByTicketPulse: 0 });
    expect(r.auto.overrides).toEqual([expect.objectContaining({
      ticketId: 1, displayRef: 'TP-1', category: 'Software', aiFirstChoice: 'Ada Byron', tookIt: 'Ben Okri', inList: true, how: 'handed_back', by: 'Ada Byron', minutes: 12, rebounded: true,
    })]);
  });

  test('moved by someone else, later than an hour, to a person off the list', () => {
    const r = compute({
      runs: [run(1)],
      tickets: [ticket(1, { assignedTechId: 4 })],
      episodes: [
        episode(1, 1, { endMethod: 'reassigned', endedAt: at('2026-09-20T19:01:00Z'), endActorName: 'Cy Twombly (in FreshService)' }),
        episode(1, 4, { startedAt: at('2026-09-20T19:01:00Z'), startAssignedByName: 'Cy Twombly', endMethod: 'closed', endedAt: at('2026-09-22T16:00:00Z') }),
      ],
    });
    expect(r.auto.firstChoice.n).toBe(0);
    expect(r.auto.inList.n).toBe(0);
    expect(r.auto.changes).toMatchObject({ handedBack: 0, movedByOther: 1, withinHour: 0, later: 1 });
    expect(r.auto.overrides[0]).toMatchObject({ how: 'moved_by_other', by: 'Cy Twombly', minutes: 180, tookIt: 'Dee Rees', inList: false });
  });

  test('the assignee cleared by another person is a move, not a hand-back', () => {
    const r = compute({
      runs: [run(1)],
      tickets: [ticket(1, { assignedTechId: 2 })],
      episodes: [episode(1, 1, { endMethod: 'rejected', endedAt: at('2026-09-20T16:05:00Z'), endActorName: 'Dee Rees' })],
    });
    expect(r.auto.changes).toMatchObject({ handedBack: 0, movedByOther: 1 });
  });

  test('a move made by Ticket Pulse itself is not a change by a person', () => {
    const r = compute({
      runs: [run(1)],
      tickets: [ticket(1, { assignedTechId: 2 })],
      episodes: [episode(1, 1, { endMethod: 'reassigned', endedAt: at('2026-09-20T16:30:00Z'), endActorName: 'Ticket Pulse' })],
    });
    expect(r.auto.firstChoice.n).toBe(0);
    expect(r.auto.changed.n).toBe(0);
    expect(r.auto.changes.movedByTicketPulse).toBe(1);
    expect(r.auto.overrides).toEqual([]);
  });

  test('no record of the AI assignment: a different assignee still counts as changed, how not recorded', () => {
    const r = compute({ runs: [run(1)], tickets: [ticket(1, { assignedTechId: 3 })], episodes: [] });
    expect(r.auto.changed.n).toBe(1);
    expect(r.auto.changes).toMatchObject({ unknown: 1, timeUnknown: 1 });
  });

  test('a ticket with several runs is counted once, by its first full run', () => {
    const r = compute({
      runs: [
        run(1, { decision: 'priority_only', pickIds: [3], createdAt: at('2026-09-20T03:00:00Z') }), // after hours: not a full run
        run(1, { pickIds: [1, 2] }),
        run(1, { triggerSource: 'priority_changed', pickIds: [2, 1], assignedTechId: 2, createdAt: at('2026-09-21T16:00:00Z') }),
      ],
      tickets: [ticket(1)],
      episodes: [episode(1, 1, { endMethod: 'closed', endedAt: at('2026-09-22T16:00:00Z') })],
    });
    expect(r.counts.considered).toBe(1);
    expect(r.auto.tickets).toBe(1);
    expect(r.auto.firstChoice.n).toBe(1);
  });
});

describe('the AI only suggested', () => {
  const suggestion = (ticketId, over = {}) => run(ticketId, { decision: 'pending_review', assignedTechId: null, triggerSource: 'app_native', ...over });

  test('the first choice, someone on the list, and someone else took it', () => {
    const r = compute({
      runs: [suggestion(1), suggestion(2), suggestion(3)],
      tickets: [ticket(1, { assignedTechId: 1 }), ticket(2, { assignedTechId: 3 }), ticket(3, { assignedTechId: 4, category: 'Hardware' })],
      episodes: [
        episode(1, 1, { startMethod: 'self_picked', startAssignedByName: null, endMethod: 'closed', endedAt: at('2026-09-21T16:00:00Z') }),
        episode(2, 3, { startMethod: 'self_picked', startAssignedByName: null, endMethod: 'closed', endedAt: at('2026-09-21T16:00:00Z') }),
        episode(3, 4, { startMethod: 'coordinator_assigned', startAssignedByName: 'Ben Okri', endMethod: 'closed', endedAt: at('2026-09-21T16:00:00Z') }),
      ],
    });
    expect(r.leadMode).toBe('suggest');
    expect(r.auto).toBeNull();
    expect(r.suggest.tickets).toBe(3);
    expect(r.suggest.firstChoice.n).toBe(1);
    expect(r.suggest.inList.n).toBe(2);
    expect(r.suggest.changed.n).toBe(1); // not on the list at all
    expect(r.suggest.review).toEqual({ of: 3, approvedAsIs: 0, changedInReview: 0, rejected: 0, notAnswered: 3 });
    expect(r.suggest.taken).toEqual({ pickedUp: 2, assignedBy: 1, unknown: 0 });
    // Every ticket not done by the first choice is listed, newest run first.
    expect(r.suggest.overrides.map((o) => [o.ticketId, o.how, o.by, o.inList])).toEqual(expect.arrayContaining([
      [2, 'picked_up', null, true],
      [3, 'assigned_by', 'Ben Okri', false],
    ]));
    expect(r.suggest.overrides).toHaveLength(2);
    expect(r.suggest.categories).toEqual([
      expect.objectContaining({ name: 'Software', tickets: 2 }),
      expect.objectContaining({ name: 'Hardware', tickets: 1 }),
    ]);
  });

  test('approved as is, changed in review and rejected come from the review queue', () => {
    const r = compute({
      runs: [
        suggestion(1, { decision: 'approved', assignedTechId: 1 }),
        suggestion(2, { decision: 'modified', assignedTechId: 4 }),
        suggestion(3, { decision: 'rejected' }),
      ],
      tickets: [ticket(1), ticket(2, { assignedTechId: 4 }), ticket(3, { assignedTechId: 2 })],
      episodes: [],
    });
    expect(r.suggest.review).toEqual({ of: 3, approvedAsIs: 1, changedInReview: 1, rejected: 1, notAnswered: 0 });
    expect(r.suggest.overrides.find((o) => o.ticketId === 2).how).toBe('changed_in_review');
  });
});

describe('who did the ticket', () => {
  test('an open ticket counts once its owner has held it for a day; before that it is too early', () => {
    const r = compute({
      runs: [run(1, { createdAt: at('2026-10-10T16:00:00Z') }), run(2, { createdAt: at('2026-10-13T15:00:00Z') })],
      tickets: [ticket(1, { status: 'Open' }), ticket(2, { status: 'Pending' })],
      episodes: [
        episode(1, 1, { startedAt: at('2026-10-10T16:01:00Z') }),
        episode(2, 1, { startedAt: at('2026-10-13T15:01:00Z') }),
      ],
    });
    expect(r.auto.tickets).toBe(1);
    expect(r.auto.eligible).toBe(2);
    expect(r.auto.notYet).toEqual({ tooEarly: 1, nobodyHasIt: 0, closedWithNoOwner: 0 });
    expect(r.counts.notYet.tooEarly).toBe(1);
  });

  test('nobody has it, or closed with no owner: not judged', () => {
    const r = compute({
      runs: [run(1), run(2)],
      tickets: [ticket(1, { status: 'Open', assignedTechId: null }), ticket(2, { assignedTechId: null })],
      episodes: [],
    });
    expect(r.auto.tickets).toBe(0);
    expect(r.counts.notYet).toEqual({ tooEarly: 0, nobodyHasIt: 1, closedWithNoOwner: 1 });
  });

  test('custom status names of the workspace count as closed', () => {
    const r = compute({
      terminalStatuses: ['Resolved', 'Closed', 'Completed'],
      runs: [run(1, { createdAt: at('2026-10-13T19:00:00Z') })],
      tickets: [ticket(1, { status: 'Completed' })],
      episodes: [],
    });
    expect(r.auto.tickets).toBe(1);
  });
});

describe('what is left out, and counted', () => {
  test('noise, deleted, copies, onboarding, owned before the AI ran, named nobody, earlier period', () => {
    const r = compute({
      runs: [
        run(1), // noise
        run(2), // deleted
        run(3), // copy closed into another ticket (link)
        run(4), run(4, { decision: 'duplicate_dismissed', pickIds: [] }), // copy (decision)
        run(5), // onboarding family member
        run(6), // onboarding by subject
        run(7), // a person had it before the AI ran
        run(8, { triggerSource: 'rebound', isRebound: true }), // first run is a rebound: a person had it
        run(9, { decision: 'pending_review', pickIds: [] }), // named nobody
        run(10, { createdAt: at('2026-09-01T16:00:00Z') }), run(10, { createdAt: at('2026-09-20T16:00:00Z') }), // counted in an earlier period
        run(11), // counted
        run(12, { decision: 'noise_dismissed', pickIds: [] }), // never an assignment decision: not considered at all
        run(13), run(13, { decision: 'duplicate_dismissed', pickIds: [] }), run(13, { decision: 'duplicate_reverted', pickIds: [] }), // copy undone: counted
      ],
      tickets: [
        ticket(1, { isNoise: true }), ticket(2, { status: 'Deleted' }), ticket(3), ticket(4), ticket(5),
        ticket(6, { subject: 'Child Ticket: laptop for Sam' }), ticket(7), ticket(8), ticket(9), ticket(10), ticket(11), ticket(12, { isNoise: true }), ticket(13),
      ],
      episodes: [episode(7, 2, { startedAt: at('2026-09-20T15:00:00Z'), startMethod: 'self_picked' })],
      duplicateTicketIds: [3],
      onboardingTicketIds: [5],
    });
    expect(r.counts.excluded).toEqual({ noise: 1, removed: 1, duplicates: 2, onboarding: 2, ownedBeforeAi: 2, namedNobody: 1, earlierPeriod: 1 });
    expect(r.counts.excludedTotal).toBe(9);
    expect(r.counts.considered).toBe(11); // 13 tickets, less the earlier-period one and the never-decided one
    expect(r.counts.eligible).toBe(2);
    expect(r.auto.tickets).toBe(2);
  });

  test('a ticket outside the page category filter (not returned) is simply not there', () => {
    const r = compute({ runs: [run(1), run(2)], tickets: [ticket(1)], episodes: [] });
    expect(r.counts.considered).toBe(1);
  });
});

describe('rates, categories, weeks and the spread', () => {
  const many = (count, mapper) => Array.from({ length: count }, (_, i) => mapper(i + 1));

  test('a rate appears from 20 tickets; categories by volume; weeks in order; the spread alphabetical', () => {
    // 24 Software tickets in week one (18 kept), 5 Hardware in week two (0 kept).
    const runs = [
      ...many(24, (i) => run(i)),
      ...many(5, (i) => run(100 + i, { createdAt: at('2026-09-29T16:00:00Z') })),
    ];
    const tickets = [
      ...many(24, (i) => ticket(i, { assignedTechId: i <= 18 ? 1 : 2 })),
      ...many(5, (i) => ticket(100 + i, { assignedTechId: 4, category: 'Hardware' })),
    ];
    const r = compute({ runs, tickets, episodes: [], weekKeyOf: (d) => (d < at('2026-09-28T07:00:00Z') ? '2026-09-14' : '2026-09-28') });
    expect(r.auto.tickets).toBe(29);
    expect(r.auto.firstChoice).toEqual({ n: 18, of: 29, pct: 62 });
    expect(r.auto.inList).toEqual({ n: 24, of: 29, pct: 83 });
    expect(r.auto.categories).toEqual([
      { name: 'Software', tickets: 24, firstChoice: { n: 18, of: 24, pct: 75 }, inList: { n: 24, of: 24, pct: 100 }, changed: { n: 6, of: 24, pct: 25 } },
      { name: 'Hardware', tickets: 5, firstChoice: { n: 0, of: 5, pct: null }, inList: { n: 0, of: 5, pct: null }, changed: { n: 5, of: 5, pct: null } },
    ]);
    expect(r.auto.weeks.map((w) => [w.week, w.tickets, w.firstChoice.pct])).toEqual([['2026-09-14', 24, 75], ['2026-09-28', 5, null]]);
    expect(r.auto.spread).toEqual([
      { name: 'Ada Byron', firstChoice: 29, didIt: 18 },
      { name: 'Ben Okri', firstChoice: 0, didIt: 6 },
      { name: 'Dee Rees', firstChoice: 0, didIt: 5 },
    ]);
    expect(r.auto.overrides).toHaveLength(11);
  });

  test('the override list is capped at 25, newest first', () => {
    const runs = many(30, (i) => run(i, { createdAt: new Date(at('2026-09-20T16:00:00Z').getTime() + i * 60000) }));
    const tickets = many(30, (i) => ticket(i, { assignedTechId: 2 }));
    const r = compute({ runs, tickets, episodes: [] });
    expect(r.auto.overrides).toHaveLength(25);
    expect(r.auto.overrides[0].ticketId).toBe(30);
  });

  test('nothing in the range: no modes, zero counts', () => {
    const r = compute({ runs: [], tickets: [], episodes: [] });
    expect(r).toMatchObject({ leadMode: null, auto: null, suggest: null, counts: { considered: 0, eligible: 0, judged: 0, excludedTotal: 0 } });
  });
});

describe('the CSV rows', () => {
  test('one line per counted ticket, plain words, no scores', () => {
    const r = compute({
      runs: [run(1), run(2, { decision: 'pending_review', assignedTechId: null })],
      tickets: [ticket(1, { assignedTechId: 2 }), ticket(2, { assignedTechId: 1 })],
      episodes: [
        episode(1, 1, { endMethod: 'rejected', endedAt: at('2026-09-20T16:11:00Z'), endActorName: 'Ada Byron' }),
        episode(2, 1, { startMethod: 'self_picked', startAssignedByName: null }),
      ],
    });
    const rows = pickAccuracyExportRows(r);
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.Ticket === 'TP-1')).toMatchObject({
      Mode: 'AI assigned', "AI's first choice": 'Ada Byron', "AI's list": 'Ada Byron; Ben Okri; Cy Twombly', 'Who did it': 'Ben Okri',
      'First choice kept': 'No', 'In the list': 'Yes', 'Changed by a person': 'Yes', How: 'Handed back by the assignee', By: 'Ada Byron', 'Minutes until changed': 10,
    });
    expect(rows.find((x) => x.Ticket === 'TP-2')).toMatchObject({
      Mode: 'AI suggested', 'First choice kept': 'Yes', 'Changed by a person': '', How: 'Picked up by the person',
    });
  });
});

describe('fetchPickInputs', () => {
  const db = () => ({
    $queryRaw: jest.fn().mockResolvedValue([{ id: 7n, ticketId: 1, decision: 'auto_assigned', triggerSource: 'webhook', isRebound: false, assignedTechId: 1, createdAt: START, pickIds: [1, 2] }]),
    ticket: { findMany: jest.fn().mockResolvedValue([{ id: 1, status: 'Closed', assignedTechId: 4 }]) },
    ticketAssignmentEpisode: { findMany: jest.fn().mockResolvedValue([]) },
    ticketLink: { findMany: jest.fn().mockResolvedValue([{ ticketId: 1 }]) },
    hrLifecycleFamilyMember: { findMany: jest.fn().mockResolvedValue([]) },
    technician: { findMany: jest.fn().mockResolvedValue([{ id: 1, name: 'Ada Byron' }]) },
  });

  test('reads names only (never a photo), scoped to the workspace and the page category filter', async () => {
    const client = db();
    const out = await fetchPickInputs(client, { workspaceId: 5, start: START, end: END, ticketWhere: { internalCategoryId: { in: [3] } }, ticketSelect: { tpSkill: true } });
    expect(out.runs[0]).toMatchObject({ id: 7, ticketId: 1, pickIds: [1, 2] });
    expect(out.duplicateTicketIds).toEqual([1]);
    expect(out.techNames.get(1)).toBe('Ada Byron');
    expect(client.ticket.findMany.mock.calls[0][0].where).toEqual({ AND: [{ workspaceId: 5, id: { in: [1] } }, { internalCategoryId: { in: [3] } }] });
    expect(client.ticket.findMany.mock.calls[0][0].select).toMatchObject({ assignedTechId: true, tpSkill: true });
    expect(client.ticket.findMany.mock.calls[0][0].select.assignedTech).toBeUndefined();
    expect(client.technician.findMany).toHaveBeenCalledWith({ where: { id: { in: [1, 2, 4] } }, select: { id: true, name: true } });
    expect(client.ticketLink.findMany.mock.calls[0][0].where).toEqual({ workspaceId: 5, ticketId: { in: [1] }, kind: { in: ['duplicate_of', 'merged_into'] } });
  });

  test('no runs in the range: no further reads; a failed read degrades to empty', async () => {
    const client = db();
    client.$queryRaw.mockRejectedValue(new Error('relation missing'));
    const out = await fetchPickInputs(client, { workspaceId: 5, start: START, end: END });
    expect(out).toEqual({ runs: [], tickets: [], episodes: [], duplicateTicketIds: [], onboardingTicketIds: [], techNames: new Map() });
    expect(client.ticket.findMany).not.toHaveBeenCalled();
  });
});
