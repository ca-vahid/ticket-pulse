import { describe, expect, test } from '@jest/globals';
import { assignerKind, assignerNamesOf, countAssignerKinds } from '../src/utils/assignerKind.js';
import { calculateTechnicianWeeklyStats, calculateWeeklyDashboard } from '../src/services/statsCalculator.js';
import { assignmentSource } from '../src/services/analyticsService.js';

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
    expect(countAssignerKinds(tickets, 'Anton Kuzmychev', names)).toEqual({ self: 1, ai: 2, automation: 1, person: 1, app: 3, routed: 4 });
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
