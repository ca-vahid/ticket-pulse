import { describe, expect, test } from 'vitest';
import { buildHistoryItems, foldBursts, parseFsFeedLine, countMachine } from './ticketHistory';

const T0 = Date.parse('2026-09-14T11:37:50Z');
const iso = (ms) => new Date(T0 + ms).toISOString();

// The real feed of TP-… #242161 (14 Sep 2026): 4 audit rows + 24 FreshService
// feed lines, which the old tab showed as 31 near-identical lines.
const activities = [
  { id: 1, activityType: 'group_changed', performedBy: 'Anne-Marie Dagenais', performedAt: iso(0), details: { via: 'freshservice', actorKind: 'freshservice_sync', groupName: 'Everyone IT' } },
  { id: 2, activityType: 'coordinator_assigned', performedBy: 'Andrew Fong', performedAt: iso(16 * 60e3), details: { via: 'freshservice', actorKind: 'freshservice_sync', agentName: 'Anton Kuzmychev' } },
  { id: 3, activityType: 'assigned', performedBy: 'FreshService', performedAt: iso(110 * 60e3), details: { via: 'freshservice', note: 'Assignee reconciled from FreshService on open: Anton Kuzmychev', toTechId: 7, actorKind: 'reconcile' } },
  { id: 4, activityType: 'status_changed', performedBy: 'Anton Kuzmychev (FreshService)', performedAt: iso(165 * 60e3 + 24e3), details: { via: 'freshservice', oldStatus: 'Open', newStatus: 'Closed', actorKind: 'freshservice_sync', actorName: 'Anton Kuzmychev' } },
];
const fs = (id, ms, eventType, actorName, content) => ({ id, source: 'freshservice_activity', eventType, actorName, content, bodyText: content, occurredAt: iso(ms) });
const thread = [
  fs(900, 0, 'group_event', 'Anne-Marie Dagenais', 'created ticket, set workspace as IT Team, set Status as Open, set Urgency as Low, set Priority as Low, set Department as Montreal, QC, set Source as Email, set Group as Everyone IT, set Type as Incident and set Impact as Low'),
  fs(901, 1e3, 'activity', 'Ticket Workflow', 'executed Ticket Received (June 19, 2026) workflow from Ticket is raised or updated event'),
  fs(902, 2e3, 'activity', 'Ticket Workflow', 'executed webhook in Ticket Received (June 19, 2026) workflow. Node name - Trigger webhook . Result - Success'),
  fs(903, 3e3, 'activity', 'Ticket Workflow', 'executed Ticket Received (June 19, 2026) workflow from Web Request Response event'),
  fs(904, 75e3, 'activity', 'Ticket Pulse', 'set Priority as High'),
  fs(905, 78e3, 'activity', 'Ticket Pulse', 'set Ticket Pulse Category as Security and set Ticket Pulse Subcategory as Endpoint Threat / C2 Detection'),
  fs(906, 326e3, 'activity', 'Sam Khadem', 'set Priority as Urgent'),
  fs(907, 327e3, 'activity', 'Ticket Workflow', 'executed Ticket Urgent Priority workflow from Priority is changed from any to Urgent event'),
  fs(908, 16 * 60e3, 'assignment_event', 'Andrew Fong', 'set Agent as Anton Kuzmychev'),
  fs(909, 16 * 60e3 + 1e3, 'activity', 'Ticket Workflow', 'executed Ticket Auto Accept if Self-assigned or After 30min workflow from Ticket is assigned event'),
  fs(910, 21 * 60e3, 'activity', 'Sam Khadem', 'set Ticket Accepted as true'),
  fs(911, 123 * 60e3, 'activity', 'Anton Kuzmychev', 'added a private note'),
  fs(912, 123 * 60e3 + 8e3, 'status_event', 'Anton Kuzmychev', 'set Status as Pending response'),
  fs(913, 126 * 60e3, 'activity', 'Anton Kuzmychev', 'added a private note'),
  fs(914, 131 * 60e3, 'activity', 'Anton Kuzmychev', 'added a private note'),
  fs(915, 131 * 60e3 + 2e3, 'status_event', 'Anton Kuzmychev', 'set Status as Open'),
  fs(916, 165 * 60e3, 'status_event', 'Anton Kuzmychev', 'set Status as Closed'),
  fs(917, 165 * 60e3 + 1e3, 'activity', 'Ticket Workflow', 'executed Ticket Closed (06-13) workflow from Ticket is closed event'),
  fs(918, 170 * 60e3, 'activity', 'Anton Kuzmychev', 'updated a note'),
];
const episodes = [{ id: 50, startMethod: 'coordinator_assigned', startedAt: iso(16 * 60e3), startAssignedByName: 'Andrew Fong', technician: { name: 'Anton Kuzmychev' } }];

describe('parseFsFeedLine', () => {
  test('recognises the FreshService feed vocabulary', () => {
    expect(parseFsFeedLine({ eventType: 'status_event', content: 'set Status as Closed' })).toEqual({ event: 'status', to: 'Closed' });
    expect(parseFsFeedLine({ eventType: 'assignment_event', content: 'set Agent as None' })).toEqual({ event: 'assignment', to: null });
    expect(parseFsFeedLine({ eventType: 'activity', content: 'set Priority as Urgent' })).toEqual({ event: 'priority', to: 'Urgent' });
    expect(parseFsFeedLine({ eventType: 'activity', content: 'added a private note' })).toEqual({ event: 'note', updated: false, priv: true });
    expect(parseFsFeedLine({ eventType: 'activity', content: 'updated a note' })).toEqual({ event: 'note', updated: true, priv: false });
    expect(parseFsFeedLine(thread[0])).toMatchObject({ event: 'created', group: 'Everyone IT', priority: 'Low', source: 'Email' });
    expect(parseFsFeedLine({ eventType: 'activity', content: 'executed X workflow from Y event' })).toMatchObject({ event: 'workflow' });
    expect(parseFsFeedLine({ eventType: 'activity', content: 'set GPT Agent Matched as 1' })).toBeNull();
  });
});

describe('buildHistoryItems — one story, deduplicated, machine chatter folded', () => {
  const items = buildHistoryItems({ activities, assignmentEpisodes: episodes, thread, techNameById: new Map([[7, 'Anton Kuzmychev']]) });
  const human = items.filter((i) => !i.machine);

  test('the close is told once, attributed to the person, with the transition', () => {
    const closes = items.filter((i) => i.event === 'status' && i.to === 'Closed');
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ actor: 'Anton Kuzmychev', from: 'Open', to: 'Closed', source: 'freshservice', machine: false, importance: 3 });
  });

  test('the assignment is told once — audit row, FS feed line and episode collapse to one', () => {
    const assigns = items.filter((i) => (i.event === 'assignment' || i.event === 'ownership') && /anton/i.test(i.to || ''));
    // The reconcile row at +110 min is a different moment (machine); the
    // human assignment at +16 min appears exactly once.
    const humanAssigns = assigns.filter((i) => !i.machine);
    expect(humanAssigns).toHaveLength(1);
    expect(humanAssigns[0]).toMatchObject({ actor: 'Andrew Fong', to: 'Anton Kuzmychev' });
  });

  test('people-only view keeps the moves that matter, in order, and nothing from workflows', () => {
    const seq = human.map((i) => `${i.actor}|${i.event}|${i.to || ''}`);
    expect(seq).toEqual([
      'Anton Kuzmychev|note|',
      'Anton Kuzmychev|status|Closed',
      'Anton Kuzmychev|status|Open',
      'Anton Kuzmychev|note|',
      'Anton Kuzmychev|status|Pending response',
      'Anton Kuzmychev|note|',
      'Sam Khadem|accepted|',
      'Andrew Fong|assignment|Anton Kuzmychev',
      'Sam Khadem|priority|Urgent',
      'Anne-Marie Dagenais|group|Everyone IT',
      'Anne-Marie Dagenais|created|Everyone IT',
    ]);
    // Two consecutive notes by the same person fold to ×2.
    expect(human.find((i) => i.event === 'note' && i.count === 2)).toBeTruthy();
  });

  test('machine rows fold into bursts and are counted for the header', () => {
    const bursts = items.filter((i) => i.event === 'burst');
    expect(bursts.length).toBeGreaterThanOrEqual(1);
    // A lone machine row between people stays a plain row, not a one-item burst.
    expect(items.some((i) => i.machine && i.event !== 'burst')).toBe(true);
    expect(bursts.every((b) => b.items.every((i) => i.machine))).toBe(true);
    expect(countMachine(items)).toBe(items.filter((i) => i.machine).reduce((n, i) => n + (i.count || 1), 0));
    // Ticket Pulse's own write-back echoes are machine, the workflow lines are machine.
    const echo = bursts.flatMap((b) => b.items).find((i) => i.event === 'category');
    expect(echo).toMatchObject({ actor: 'Ticket Pulse', machine: true });
  });

  test('a reopen is its own event', () => {
    const [it] = buildHistoryItems({ activities: [{ id: 9, activityType: 'status_changed', performedBy: 'Rita', performedAt: iso(0), details: { oldStatus: 'Resolved', newStatus: 'Open', actorKind: 'human' } }] });
    expect(it).toMatchObject({ event: 'reopen', from: 'Resolved', to: 'Open', importance: 3 });
  });
});

describe('foldBursts', () => {
  test('a single machine row stays a row; two or more within five minutes become a burst', () => {
    const mk = (k, at, machine) => ({ key: k, at, machine, count: 1, from_at: at, to_at: at, actor: 'x', event: 'system' });
    const single = foldBursts([mk('a', 1000, true), mk('b', 0, false)]);
    expect(single.map((i) => i.event)).toEqual(['system', 'system']);
    const two = foldBursts([mk('a', 60e3, true), mk('b', 0, true)]);
    expect(two).toHaveLength(1);
    expect(two[0]).toMatchObject({ event: 'burst', count: 2 });
    const far = foldBursts([mk('a', 20 * 60e3, true), mk('b', 0, true)]);
    expect(far).toHaveLength(2);
  });
});
