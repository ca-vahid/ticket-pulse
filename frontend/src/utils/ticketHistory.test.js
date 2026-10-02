import { describe, expect, test } from 'vitest';
import { buildHistoryItems, foldBursts, groupByActor, parseFsFeedLine, countMachine, friendlyDays } from './ticketHistory';

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

describe('groupByActor — one run per person, machine rows absorbed only mid-run', () => {
  const items = buildHistoryItems({ activities, assignmentEpisodes: episodes, thread, techNameById: new Map([[7, 'Anton Kuzmychev']]) });
  const runs = groupByActor(items);

  test('consecutive actions by the same person become one run with the name once', () => {
    const anton = runs.filter((r) => r.actor === 'Anton Kuzmychev' && !r.machine);
    expect(anton).toHaveLength(1);
    expect(anton[0].items.filter((i) => !i.machine).length).toBeGreaterThanOrEqual(5);
    // Names never repeat back-to-back on the rail.
    for (let i = 1; i < runs.length; i += 1) expect(runs[i].machine || runs[i - 1].machine || runs[i].actor !== runs[i - 1].actor).toBe(true);
  });

  test('a machine row between two people stands on its own; one inside a run is absorbed', () => {
    const mk = (k, at, actor, machine) => ({ key: k, at, actor, machine, count: 1, from_at: at, to_at: at, event: machine ? 'system' : 'note', kind: machine ? 'system' : 'human' });
    const inside = groupByActor([mk('a', 30, 'Ann', false), mk('m', 20, 'Ticket Workflow', true), mk('b', 10, 'Ann', false)]);
    expect(inside).toHaveLength(1);
    expect(inside[0].items.map((i) => i.key)).toEqual(['a', 'm', 'b']);
    const between = groupByActor([mk('a', 30, 'Ann', false), mk('m', 20, 'Ticket Workflow', true), mk('b', 10, 'Bob', false)]);
    expect(between.map((r) => `${r.actor}|${r.machine}`)).toEqual(['Ann|false', 'Ticket Workflow|true', 'Bob|false']);
  });
});

describe('Auto-help P1 lines', () => {
  test('every step of the answer → check-in → close loop reads as a visible sentence', () => {
    const rows = [
      { id: 61, activityType: 'auto_help_sent', performedBy: 'Dana Agent', performedAt: iso(0), details: { decision: 'agent_edited_sent', note: 'Sent the Auto-help answer, edited first' } },
      { id: 62, activityType: 'auto_help_nudged', performedBy: 'Ticket Pulse (Auto-help)', performedAt: iso(2 * 86400e3), details: { note: 'Auto-help checked in with the requester — closing 2026-10-16 if there is no reply' } },
      { id: 63, activityType: 'auto_help_closed', performedBy: 'Ticket Pulse (Auto-help)', performedAt: iso(4 * 86400e3), details: { note: 'Resolved after no reply to the Auto-help answer' } },
    ];
    const items = buildHistoryItems({ activities: rows });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey['a-61']).toMatchObject({ event: 'autohelp', verb: 'sent the Auto-help answer, edited', machine: false });
    expect(byKey['a-62']).toMatchObject({ event: 'autohelp', verb: 'checked in with the requester', machine: false });
    expect(byKey['a-63']).toMatchObject({ event: 'autohelp', verb: 'resolved it after no reply', detail: 'Resolved after no reply to the Auto-help answer' });
    // Machine dates in the note read as days, never ISO.
    expect(byKey['a-62'].detail).toBe('Auto-help checked in with the requester — closing Fri 16 Oct if there is no reply');
  });
});

describe('30 Sep 2026 lines', () => {
  test('assignee told, answered overnight, and "Ticket ready" read as sentences', () => {
    const rows = [
      { id: 71, activityType: 'auto_help_assignee_told', performedBy: 'Ticket Pulse (Auto-help)', performedAt: iso(0), details: { note: 'Auto-help told Dana Agent an answer is waiting' } },
      { id: 72, activityType: 'auto_help_sent_overnight', performedBy: 'Ticket Pulse (Auto-help)', performedAt: iso(60e3), details: { note: 'Answered by Auto-help overnight (Software)' } },
      { id: 73, activityType: 'ticket_ready', performedBy: 'Ticket Pulse', performedAt: iso(120e3), details: { reason: 'timeout', note: 'Ticket ready — 3 minutes passed' } },
    ];
    const byKey = Object.fromEntries(buildHistoryItems({ activities: rows }).map((i) => [i.key, i]));
    expect(byKey['a-71']).toMatchObject({ event: 'autohelp', verb: 'told the assignee an answer is waiting' });
    expect(byKey['a-72']).toMatchObject({ event: 'autohelp', verb: 'answered by itself overnight (outside business hours)' });
    expect(byKey['a-73']).toMatchObject({ event: 'system', verb: 'marked the ticket ready for "Ticket ready" workflows', machine: true });
    const pending = buildHistoryItems({ activities: [{ id: 74, activityType: 'ticket_ready', performedBy: 'Ticket Pulse', performedAt: iso(0), details: { pending: true, note: 'x' } }] })[0];
    expect(pending).toMatchObject({ verb: 'is waiting for the ticket to be sorted before "Ticket ready" workflows run', detail: null });
  });
});

describe('friendlyDays', () => {
  test('bare ISO days become short days; full stamps too; other text untouched', () => {
    expect(friendlyDays('closing 2026-10-16 if there is no reply')).toBe('closing Fri 16 Oct if there is no reply');
    expect(friendlyDays('until 2026-10-14T17:00:00.000Z')).toMatch(/^until (Wed|Thu) 1[45] Oct$/);
    expect(friendlyDays('No dates here, ref 12-34')).toBe('No dates here, ref 12-34');
    expect(friendlyDays(null)).toBeNull();
  });
});

describe('a reassignment made in Ticket Pulse reads as one line (2 Oct 2026, #245218)', () => {
  test('fs_write_back → "reassigned Gaby → Marcus"; the FS echo and the "ownership ended → Unassigned" episode are dropped', () => {
    const at = '2026-10-02T22:37:45.000Z';
    const items = buildHistoryItems({
      activities: [
        { id: 1, activityType: 'fs_write_back', performedBy: 'Gaby Tonnova', performedAt: '2026-10-02T22:37:45.674Z', details: { source: 'ticketpulse_native', actorKind: 'human', changes: { assignee: { from: 'Gaby Tonnova', to: 'Marcus Blackstock' } } } },
        { id: 2, activityType: 'coordinator_assigned', performedBy: 'Ticket Pulse', performedAt: at, details: { via: 'freshservice', actorKind: 'freshservice_sync', agentName: 'Marcus Blackstock' } },
      ],
      assignmentEpisodes: [
        { id: 9, technician: { name: 'Gaby Tonnova' }, startMethod: 'ai_auto', startedAt: '2026-10-02T22:19:00.000Z', endedAt: at, endMethod: 'reassigned', endActorName: 'Ticket Pulse' },
      ],
    });
    const flat = items.flatMap((i) => (i.items ? i.items : [i]));
    const reassign = flat.filter((i) => i.event === 'assignment');
    expect(reassign).toHaveLength(1);
    expect(reassign[0]).toMatchObject({ verb: 'reassigned', from: 'Gaby Tonnova', to: 'Marcus Blackstock', actor: 'Gaby Tonnova', machine: false });
    expect(flat.some((i) => i.verb?.startsWith('ownership ended'))).toBe(false);
    expect(flat.some((i) => /fs write back/i.test(i.verb || ''))).toBe(false);
  });
});
