import { describe, expect, test } from 'vitest';
import { aiAssignedShare, appColumnTitle, assignerKind, assignerNamesOf } from './assignerKind';

/** 21 Oct 2026: same rule as backend/src/utils/assignerKind.js. */
describe('assignerKind (frontend twin)', () => {
  const names = assignerNamesOf({ serviceAccountNames: ['Ticket Pulse'], automationNames: ['ContinuIT'] });

  test.each([
    ['Ticket Pulse', 'Adrian Lo', 'ai'],
    ['Ticket Pulse alert bundling', 'Anton Kuzmychev', 'automation'],
    ['Ticket Pulse (Onboarding)', 'Andrew Fong', 'automation'],
    ['ContinuIT', 'Anton Kuzmychev', 'automation'],
    ['Mehdi Abbaspour (in FreshService)', 'Mehdi Abbaspour', 'self'],
    ['Vahid Haeri', 'Adrian Lo', 'person'],
  ])('%s on %s is %s', (assignedBy, tech, kind) => {
    expect(assignerKind({ assignedBy }, tech, names)).toBe(kind);
  });

  test('the gauge leaves rule-routed tickets out: this week in IT was 62 %, is 71 %', () => {
    // 204 tickets: 125 AI, 28 rule or integration, the rest people.
    expect(aiAssignedShare({ total: 204, ai: 125, automation: 28 })).toEqual({ routed: 176, pct: 71 });
    expect(aiAssignedShare({ total: 0, ai: 0, automation: 0 })).toEqual({ routed: 0, pct: 0 });
  });

  test('App hover text splits the AI from rules and integrations', () => {
    expect(appColumnTitle(0, 0)).toBe('No app-assigned tickets');
    expect(appColumnTitle(9, 9)).toBe('9 assigned by the AI (Ticket Pulse)');
    expect(appColumnTitle(15, 9)).toMatch(/9 by the AI, 6 by a rule or an integration/);
  });
});
