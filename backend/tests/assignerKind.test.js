import { describe, expect, test } from '@jest/globals';
import { assignerKind, assignerNamesOf, countAssignerKinds } from '../src/utils/assignerKind.js';
import { calculateTechnicianWeeklyStats, calculateWeeklyDashboard } from '../src/services/statsCalculator.js';
import { assignmentSource, isLoggedByAssignee } from '../src/services/analyticsService.js';

/** 21 Oct 2026: the IT week behind the 62 % gauge, by assigner shape. */
const names = { serviceAccountNames: ['Ticket Pulse'], automationNames: ['ContinuIT'] };

describe('assignerKind', () => {
  test.each([
    [{ assignedBy: 'Ticket Pulse' }, 'Anton Kuzmychev', 'ai'],
    [{ assignedBy: 'ticket pulse' }, 'Anton Kuzmychev', 'ai'],
    [{ assignedBy: 'Ticket Pulse alert bundling' }, 'Anton Kuzmychev', 'automation'],
    [{ assignedBy: 'Ticket Pulse (Onboarding)' }, 'Andrew Fong', 'automation'],
    [{ assignedBy: 'ContinuIT' }, 'Anton Kuzmychev', 'automation'],
    [{ assignedBy: 'Mehdi Abbaspour (in FreshService)' }, 'Mehdi Abbaspour', 'self'],
    [{ assignedBy: 'Mehdi Abbaspour (in FreshService)' }, 'Reza Zaim', 'person'],
    [{ assignedBy: 'Vahid Haeri' }, 'Adrian Lo', 'person'],
    [{ assignedBy: 'Ticket Pulse', isSelfPicked: true }, 'Adrian Lo', 'self'],
    [{ assignedBy: null }, 'Adrian Lo', 'person'],
  ])('%j on %s is %s', (ticket, tech, kind) => {
    expect(assignerKind(ticket, tech, names)).toBe(kind);
  });

  test('an empty service-account setting still knows the AI by its default name', () => {
    expect(assignerKind({ assignedBy: 'Ticket Pulse' }, 'Adrian Lo', [])).toBe('ai');
    expect(assignerNamesOf([]).ai).toEqual(['ticket pulse']);
  });

  test('counts: app = ai + automation; routed leaves the rule-routed tickets out', () => {
    const tickets = [
      { assignedBy: 'Ticket Pulse' }, { assignedBy: 'Ticket Pulse' }, { assignedBy: 'ContinuIT' },
      { assignedBy: 'Vahid Haeri' }, { isSelfPicked: true },
    ];
    expect(countAssignerKinds(tickets, 'Anton Kuzmychev', names)).toEqual({ logged: 0, self: 1, ai: 2, automation: 1, person: 1, app: 3, routed: 4 });
  });
});

describe('weekly dashboard stats', () => {
  const at = '2026-10-20T17:00:00Z';
  const tech = {
    id: 1,
    name: 'Anton Kuzmychev',
    tickets: [
      { status: 'Open', createdAt: at, firstAssignedAt: at, assignedBy: 'Ticket Pulse' },
      { status: 'Open', createdAt: at, firstAssignedAt: at, assignedBy: 'ContinuIT' },
      { status: 'Open', createdAt: at, firstAssignedAt: at, assignedBy: 'Ticket Pulse alert bundling' },
      { status: 'Open', createdAt: at, firstAssignedAt: at, assignedBy: 'Anton Kuzmychev (in FreshService)' },
      { status: 'Open', createdAt: at, firstAssignedAt: at, assignedBy: 'Vahid Haeri' },
    ],
  };
  const weekStart = new Date('2026-10-19T12:00:00Z');
  const weekEnd = new Date('2026-10-25T12:00:00Z');

  test('App counts rules and integrations, Assigned counts only people, and AI is split out', () => {
    const s = calculateTechnicianWeeklyStats(tech, weekStart, weekEnd, 'America/Vancouver', names);
    expect(s).toMatchObject({
      weeklyTotalCreated: 5,
      weeklySelfPicked: 1,
      weeklyAppAssigned: 3,
      weeklyAiAssigned: 1,
      weeklyAutomationAssigned: 2,
      weeklyAssigned: 1,
    });
    expect(s.assigners).toEqual([{ name: 'Vahid Haeri', count: 1 }]);
    const day = s.dailyBreakdown.find((d) => d.date === '2026-10-20');
    expect(day).toMatchObject({ total: 5, self: 1, appAssigned: 3, assigned: 1 });
  });

  test('the team line carries the AI and rule counts for the gauge', () => {
    const { statistics } = calculateWeeklyDashboard([tech], weekStart, weekEnd, 'America/Vancouver', names);
    expect(statistics).toMatchObject({ weeklyTotalCreated: 5, weeklyAiAssigned: 1, weeklyAutomationAssigned: 2 });
  });
});

describe('Analytics assignmentSource', () => {
  test('rules and integrations land in the no-person bucket, not with coordinators', () => {
    const t = (assignedBy, techName = 'Anton Kuzmychev') => ({ assignedBy, assignedTech: { name: techName } });
    expect(assignmentSource(t('Ticket Pulse'), names)).toBe('appAssigned');
    expect(assignmentSource(t('ContinuIT'), names)).toBe('workflowAssigned');
    expect(assignmentSource(t('Ticket Pulse alert bundling'), names)).toBe('workflowAssigned');
    expect(assignmentSource(t('Anton Kuzmychev (in FreshService)'), names)).toBe('selfPicked');
    expect(assignmentSource(t('Vahid Haeri'), names)).toBe('coordinatorAssigned');
    // The old array argument still works.
    expect(assignmentSource(t('Ticket Pulse'), ['ticket pulse'])).toBe('appAssigned');
  });
});

/** 22 Oct 2026 (Vahid): a ticket a technician wrote and took is Logged, not Self. */
describe('Logged: written by the technician who took it', () => {
  const mine = { isSelfPicked: true, assignedBy: 'Gaby Tonnova', assignedTechId: 20, createdByTechId: 20 };

  test('own ticket assigned at creation is logged; a queue pick stays self', () => {
    expect(assignerKind(mine, 'Gaby Tonnova', names)).toBe('logged');
    // Created unassigned, then "Assign to me" a few seconds later.
    expect(assignerKind({ ...mine, isSelfPicked: false }, 'Gaby Tonnova', names)).toBe('logged');
    // Mail ticket picked from the queue: no creator.
    expect(assignerKind({ ...mine, createdByTechId: null }, 'Gaby Tonnova', names)).toBe('self');
  });

  test('only when the creator is the assignee and they took it', () => {
    // Someone else wrote it and Gaby picked it up.
    expect(assignerKind({ ...mine, createdByTechId: 7 }, 'Gaby Tonnova', names)).toBe('self');
    // Gaby wrote it unassigned and the AI gave it back to her.
    expect(assignerKind({ ...mine, isSelfPicked: false, assignedBy: 'Ticket Pulse' }, 'Gaby Tonnova', names)).toBe('ai');
    // Gaby wrote it and a coordinator assigned it to her.
    expect(assignerKind({ ...mine, isSelfPicked: false, assignedBy: 'Marcus Blackstock' }, 'Gaby Tonnova', names)).toBe('person');
  });

  test('logged is its own count and leaves the gauge denominator', () => {
    const c = countAssignerKinds([
      mine,
      { ...mine, createdByTechId: null },
      { assignedBy: 'Ticket Pulse' },
      { assignedBy: 'Marcus Blackstock' },
    ], 'Gaby Tonnova', names);
    expect(c).toMatchObject({ logged: 1, self: 1, ai: 1, person: 1, routed: 3 });
  });

  test('weekly stats split Self and Logged', () => {
    const at = '2026-10-21T16:00:00Z';
    const tech = {
      id: 20,
      name: 'Gaby Tonnova',
      tickets: [
        { status: 'Open', createdAt: at, firstAssignedAt: at, ...mine },
        { status: 'Open', createdAt: at, firstAssignedAt: at, ...mine, createdByTechId: null },
        { status: 'Open', createdAt: at, firstAssignedAt: at, assignedBy: 'Ticket Pulse', assignedTechId: 20 },
      ],
    };
    const s = calculateTechnicianWeeklyStats(tech, new Date('2026-10-19T12:00:00Z'), new Date('2026-10-25T12:00:00Z'), 'America/Vancouver', names);
    expect(s).toMatchObject({ weeklyTotalCreated: 3, weeklySelfPicked: 1, weeklyLogged: 1, weeklyAppAssigned: 1 });
    const day = s.dailyBreakdown.find((d) => d.date === '2026-10-21');
    expect(day).toMatchObject({ total: 3, self: 1, logged: 1 });
  });

  test('Analytics keeps logged under selfPicked; Team Balance splits it out', () => {
    const t = { ...mine, assignedTech: { name: 'Gaby Tonnova' } };
    expect(assignmentSource(t, names)).toBe('selfPicked');
    expect(isLoggedByAssignee(t, names)).toBe(true);
    expect(isLoggedByAssignee({ ...t, createdByTechId: null }, names)).toBe(false);
  });
});
