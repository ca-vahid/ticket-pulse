import { describe, expect, test } from 'vitest';
import { buildHistoryItems, groupByActor, parseFsFeedLine, countMachine, friendlyDays, workflowRunSummary, aiAssignmentConfidence, isPreviewRun } from './ticketHistory';

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

  test('machine rows stay one line each (no bursts, QA 11-05 #9) and are counted for the header', () => {
    expect(items.some((i) => i.event === 'burst' || Array.isArray(i.items))).toBe(false);
    expect(countMachine(items)).toBe(items.filter((i) => i.machine).reduce((n, i) => n + (i.count || 1), 0));
    // Ticket Pulse's own write-back echoes are machine, the workflow lines are machine.
    expect(items.find((i) => i.event === 'category')).toMatchObject({ actor: 'Ticket Pulse', actorType: 'ticketpulse', machine: true });
    // FreshService's "executed … workflow" lines read as a FreshService workflow, by name.
    const fsWf = items.filter((i) => i.actorType === 'fs_workflow');
    expect(fsWf.length).toBeGreaterThanOrEqual(4);
    expect(fsWf.every((i) => i.machine && i.event === 'wfrun')).toBe(true);
    expect(items.find((i) => i.key === 'fs-917')).toMatchObject({ workflowName: 'Ticket Closed (06-13)', verb: 'ran', reason: 'on: Ticket is closed' });
    expect(items.find((i) => i.key === 'fs-902')).toMatchObject({ workflowName: 'Ticket Received (June 19, 2026)', verb: 'called a webhook', reason: 'webhook "Trigger webhook" · Success' });
  });

  test('a reopen is its own event', () => {
    const [it] = buildHistoryItems({ activities: [{ id: 9, activityType: 'status_changed', performedBy: 'Rita', performedAt: iso(0), details: { oldStatus: 'Resolved', newStatus: 'Open', actorKind: 'human' } }] });
    expect(it).toMatchObject({ event: 'reopen', from: 'Resolved', to: 'Open', importance: 3 });
  });
});

describe('groupByActor — one run per actor, every row its own line (QA 11-05 #9)', () => {
  const items = buildHistoryItems({ activities, assignmentEpisodes: episodes, thread, techNameById: new Map([[7, 'Anton Kuzmychev']]) });

  test('with machine activity hidden, consecutive actions by the same person become one run with the name once', () => {
    const runs = groupByActor(items.filter((i) => !i.machine));
    const anton = runs.filter((r) => r.actor === 'Anton Kuzmychev');
    expect(anton).toHaveLength(1);
    expect(anton[0].items.length).toBeGreaterThanOrEqual(5);
    // Names never repeat back-to-back on the rail.
    for (let i = 1; i < runs.length; i += 1) expect(runs[i].actor !== runs[i - 1].actor).toBe(true);
  });

  test('a machine row is never absorbed into a person\'s run; it splits the run and stands as its own line', () => {
    const mk = (k, at, actor, machine) => ({ key: k, at, actor, machine, actorType: machine ? 'fs_workflow' : 'person', count: 1, from_at: at, to_at: at, event: machine ? 'system' : 'note', kind: machine ? 'system' : 'human' });
    const inside = groupByActor([mk('a', 30, 'Ann', false), mk('m', 20, 'FreshService workflow', true), mk('b', 10, 'Ann', false)]);
    expect(inside.map((r) => r.items.map((i) => i.key))).toEqual([['a'], ['m'], ['b']]);
    const machines = groupByActor([mk('m1', 30, 'FreshService workflow', true), mk('m2', 20, 'FreshService workflow', true), mk('b', 10, 'Bob', false)]);
    expect(machines.map((r) => `${r.actor}|${r.items.length}`)).toEqual(['FreshService workflow|2', 'Bob|1']);
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
    // The episode's own start is the AI's assignment of Gaby (QA 11-05 #9) — a different moment.
    expect(flat.find((i) => i.key === 'ep-9')).toMatchObject({ actor: 'Ticket Pulse AI', actorType: 'ai', verb: 'assigned', to: 'Gaby Tonnova' });
    const reassign = flat.filter((i) => i.event === 'assignment' && !i.episode);
    expect(reassign).toHaveLength(1);
    expect(reassign[0]).toMatchObject({ verb: 'reassigned', from: 'Gaby Tonnova', to: 'Marcus Blackstock', actor: 'Gaby Tonnova', machine: false });
    expect(flat.some((i) => i.verb?.startsWith('ownership ended'))).toBe(false);
    expect(flat.some((i) => /fs write back/i.test(i.verb || ''))).toBe(false);
  });
});

describe('requester Teams chat from the urgency page (QA 10-15 #5)', () => {
  test('reads as the requester opening a chat with the agent, never folded as machine chatter', () => {
    const items = buildHistoryItems({
      activities: [
        { id: 1, activityType: 'requester_teams_chat', performedBy: 'Priya Nair', performedAt: '2026-10-15T17:00:00.000Z', details: { via: 'urgency_page', actorKind: 'human', agentName: 'Sam Okafor' } },
      ],
    });
    const flat = items.flatMap((i) => (i.items ? i.items : [i]));
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({ verb: 'opened a Teams chat from the urgency page', detail: 'With Sam Okafor', actor: 'Priya Nair', machine: false });
  });
});

describe('merge rows say which ticket and what came over (18 Oct 2026)', () => {
  test('merged_from names the merged ticket, the person, and what was copied', () => {
    const items = buildHistoryItems({
      activities: [{
        id: 77,
        activityType: 'merged_from',
        performedBy: 'vhaeri@bgcengineering.ca',
        performedAt: iso(0),
        details: { srcRef: '#247711', tgtRef: 'TP-10179', sourceSubject: 'Re: anyone working today?', copied: 0, descriptionCopied: true, attachmentsLeft: 1, swept: { tasks: 0, children: 0, approvals: 0 }, actorName: 'Vahid Haeri' },
      }],
    });
    const flat = items.flatMap((i) => (i.items ? i.items : [i]));
    expect(flat[0]).toMatchObject({
      event: 'merge',
      verb: 'merged in',
      to: '#247711',
      actor: 'Vahid Haeri',
      machine: false,
      detail: '"Re: anyone working today?" · Opening e-mail copied in · 0 messages copied in · 1 attachment left on #247711',
    });
  });

  test('merged_into points at the surviving ticket', () => {
    const items = buildHistoryItems({
      activities: [{ id: 78, activityType: 'merged_into', performedBy: 'a@b.c', performedAt: iso(0), details: { srcRef: '#247711', tgtRef: 'TP-10179', targetSubject: 'anyone working today?' } }],
    });
    const flat = items.flatMap((i) => (i.items ? i.items : [i]));
    expect(flat[0]).toMatchObject({ event: 'merge', verb: 'merged this ticket into', to: 'TP-10179', actor: 'a@b.c' });
    expect(flat[0].detail).toContain('The conversation continues there');
  });
});

describe('a grouping close names both tickets (QA 10-20 #2, #248018 into TP-10294)', () => {
  test('the closed copy reads "Reason: Duplicate — Combined into TP-10294: …"', () => {
    const items = buildHistoryItems({
      activities: [
        { id: 1, activityType: 'fs_write_back', performedBy: 'Ticket Pulse grouping', performedAt: '2026-10-20T15:10:05.000Z', details: { source: 'ticketpulse_native', actorKind: 'system', changes: { status: { from: 'Open', to: 'Resolved' } }, resolutionReason: 'duplicate', resolutionNote: 'Combined into TP-10294: the same request.', relatedRef: 'TP-10294', relatedTicketId: 64185 } },
      ],
    });
    const flat = items.flatMap((i) => (i.items ? i.items : [i]));
    const status = flat.find((i) => i.event === 'status');
    expect(status).toMatchObject({ from: 'Open', to: 'Resolved', detail: 'Reason: Duplicate — Combined into TP-10294: the same request.' });
  });

  test('the kept ticket reads "combined in a duplicate #248018"', () => {
    const items = buildHistoryItems({
      activities: [
        { id: 2, activityType: 'grouped_in', performedBy: 'Ticket Pulse grouping', performedAt: '2026-10-20T15:10:06.000Z', details: { actorKind: 'system', fromTicketId: 64193, fromRef: '#248018', fromSubject: 'Re: URGENT HELP NEEDED', relation: 'same_request', reason: 'The same request.' } },
      ],
    });
    const flat = items.flatMap((i) => (i.items ? i.items : [i]));
    expect(flat[0]).toMatchObject({ event: 'merge', verb: 'combined in a duplicate', to: '#248018', machine: false });
    expect(flat[0].detail).toBe('"Re: URGENT HELP NEEDED" · The same request.');
  });
});

describe('QA 11-05 #9 — the right actor, workflow runs, one line per action', () => {
  const T = Date.parse('2026-10-22T16:12:00Z');
  const at = (min) => new Date(T + min * 60e3).toISOString();
  const aiEpisode = { id: 41, technician: { name: 'Jordan Lee' }, startMethod: 'workflow_assigned', startAssignedByName: 'Ticket Pulse AI', startedAt: at(0) };

  test('a workflow-assigned episode is the AI\'s action, not the assignee\'s, and "by …" is never printed', () => {
    const [it] = buildHistoryItems({ assignmentEpisodes: [aiEpisode] });
    expect(it).toMatchObject({ event: 'assignment', actor: 'Ticket Pulse AI', actorType: 'ai', verb: 'assigned', to: 'Jordan Lee', reason: 'auto-assign', machine: false });
    expect(it.detail).toBeNull();
    expect(JSON.stringify(it)).not.toMatch(/by Ticket Pulse AI/);
    expect(it.actorBy).toBeUndefined();
  });

  test('a self-pick stays the technician\'s own; a FreshService assigner is named and placed', () => {
    const items = buildHistoryItems({ assignmentEpisodes: [
      { id: 1, technician: { name: 'Sam Ortiz' }, startMethod: 'self_picked', startedAt: at(0) },
      { id: 2, technician: { name: 'Alex Rivera' }, startMethod: 'coordinator_assigned', startAssignedByName: 'Riley Chen (in FreshService)', startedAt: at(60) },
    ] });
    expect(items.find((i) => i.key === 'ep-1')).toMatchObject({ actor: 'Sam Ortiz', event: 'ownership', verb: 'picked this up' });
    expect(items.find((i) => i.key === 'ep-2')).toMatchObject({ actor: 'Riley Chen', actorType: 'person', to: 'Alex Rivera', reason: 'in FreshService', source: 'freshservice' });
  });

  test('"ownership ended" is the ender\'s action; a hand-back folds into the unassign row with its reason', () => {
    const items = buildHistoryItems({
      activities: [{ id: 5, activityType: 'assigned', performedBy: 'Jordan Lee', performedAt: at(30), actorKind: 'human', details: { fromTechId: 9, toTechId: null, handBack: { label: 'Access / permission limited' }, actorKind: 'human' } }],
      assignmentEpisodes: [{ ...aiEpisode, endedAt: at(30), endMethod: 'rejected', endActorName: 'Jordan Lee' }],
      techNameById: new Map([[9, 'Jordan Lee']]),
    });
    expect(items.find((i) => i.key === 'ep-end-41')).toBeUndefined();
    expect(items.find((i) => i.key === 'a-5')).toMatchObject({ actor: 'Jordan Lee', verb: 'unassigned', from: 'Jordan Lee', reason: 'Access / permission limited' });
    const ended = buildHistoryItems({ assignmentEpisodes: [{ ...aiEpisode, endedAt: at(90), endMethod: 'reassigned', endActorName: 'Casey Park' }] });
    expect(ended.find((i) => i.key === 'ep-end-41')).toMatchObject({ actor: 'Casey Park', from: 'Jordan Lee', reason: 'reassigned' });
  });

  test('the AI\'s own pipeline-run row folds into its assignment line', () => {
    const items = buildHistoryItems({
      assignmentEpisodes: [aiEpisode],
      pipelineRuns: [{ id: 3301, status: 'completed', decision: 'auto_assigned', triggerSource: 'webhook', createdAt: at(-1), decidedAt: at(-0.2) }],
    });
    expect(items).toHaveLength(1);
    expect(items[0].extra).toEqual([expect.stringMatching(/^AI run #3301 · via webhook/)]);
  });

  const liveRun = {
    id: 900, workflowId: 3, workflowName: 'Reopen on requester reply', eventType: 'ticket.reply_received', status: 'completed', executionMode: 'live', shadow: false,
    startedAt: at(120), durationMs: 104, outcome: 'acted', stopReason: null,
    actions: [{ type: 'update', fields: ['status'], status: { from: 'Pending Response', to: 'Open' }, assignedTo: null }],
    steps: [{ nodeId: 'trigger', nodeType: 'trigger', status: 'completed' }, { nodeId: 'reopen', nodeType: 'update_ticket', status: 'completed' }],
  };

  test('a workflow run with no audit row still shows a line, people-visible when live', () => {
    const [it] = buildHistoryItems({ workflowRuns: [{ ...liveRun, id: 901, actions: [{ type: 'email', to: 1, cc: 0, sent: true }] }] });
    expect(it).toMatchObject({ event: 'wfrun', actor: 'Workflow', actorType: 'workflow', workflowName: 'Reopen on requester reply', verb: 'ran', reason: 'e-mailed 1 person', machine: false, duration: '0.1 s' });
  });

  test('a run and its own workflow_updated_ticket row fold into one line', () => {
    const items = buildHistoryItems({
      workflowRuns: [liveRun],
      activities: [{ id: 77, activityType: 'workflow_updated_ticket', performedBy: 'Notification workflow', performedAt: at(120.01), details: { note: 'Reopened automatically — the requester replied.', changes: { status: { from: 'Pending Response', to: 'Open' } }, actorKind: 'workflow', eventType: 'ticket.reply_received' } }],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'wf-900', reason: 'set status Pending Response → Open' });
    expect(items[0].extra).toEqual(['changed status Pending Response → Open · Reopened automatically — the requester replied.']);
  });

  test('a Shadow run is labelled and counts as machine activity; a skipped run says why', () => {
    const items = buildHistoryItems({ workflowRuns: [
      { ...liveRun, id: 902, executionMode: 'mock', shadow: true, actions: [{ type: 'email', to: 1, cc: 0, sent: false, reason: 'Shadow - email not sent' }] },
      { ...liveRun, id: 903, startedAt: at(10), outcome: 'stopped', stopReason: 'Noise ticket skipped', actions: [] },
      { ...liveRun, id: 904, startedAt: at(5), outcome: 'stopped', stopReason: 'Workflow stopped', stopCause: 'Did not pass: Ticket status is one of Resolved, Closed', actions: [] },
    ] });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey['wf-902']).toMatchObject({ verb: 'Shadow — nothing sent', reason: 'would e-mail 1 person', machine: true, shadow: true });
    expect(byKey['wf-903']).toMatchObject({ verb: 'skipped', reason: 'Noise ticket skipped', machine: true });
    expect(byKey['wf-904']).toMatchObject({ reason: 'Did not pass: Ticket status is one of Resolved, Closed' });
    expect(countMachine(items)).toBe(3);
  });

  test('a run that assigned someone takes the episode it started as a detail', () => {
    const items = buildHistoryItems({
      workflowRuns: [{ ...liveRun, id: 905, startedAt: at(0), actions: [{ type: 'update', fields: [], status: null, assignedTo: 'Jordan Lee' }] }],
      assignmentEpisodes: [{ ...aiEpisode, startAssignedByName: 'Workflow', startedAt: at(0.05) }],
    });
    expect(items.map((i) => i.key)).toEqual(['wf-905']);
    expect(items[0].reason).toBe('assigned Jordan Lee');
    expect(items[0].extra).toEqual(['assigned Jordan Lee']);
  });

  test('with machine activity, every machine row is its own line', () => {
    const items = buildHistoryItems({ activities: [
      { id: 1, activityType: 'mirror_conflict', performedBy: 'Mirror reconciliation', performedAt: at(0), details: { note: 'a' } },
      { id: 2, activityType: 'mirror_conflict', performedBy: 'Mirror reconciliation', performedAt: at(1), details: { note: 'b' } },
      { id: 3, activityType: 'ai_triage', performedBy: 'Ticket Pulse AI', performedAt: at(2), details: { note: 'c' } },
    ] });
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.machine && !i.items)).toBe(true);
    expect(groupByActor(items).map((r) => r.items.length)).toEqual([1, 2]);
  });

  test('workflowRunSummary reads the actions in plain words', () => {
    expect(workflowRunSummary({ actions: [{ type: 'email', to: 2, cc: 1, sent: true }, { type: 'note' }] })).toBe('e-mailed 3 people, added a note');
    expect(workflowRunSummary({ actions: [{ type: 'update', fields: ['priority', 'internalCategoryId'], status: null }] })).toBe('set priority, category');
    expect(workflowRunSummary({})).toBe('');
  });
});
describe('macro_applied (lane D macros, QA 11-05)', () => {
  test('one people-visible line by the person who applied it; the steps go to the details', () => {
    const [it] = buildHistoryItems({ activities: [{
      id: 81, activityType: 'macro_applied', performedBy: 'Alex Rivera', performedAt: '2026-11-05T18:00:00.000Z',
      details: {
        source: 'ticketpulse_native', actorKind: 'human', macroId: 4, macroName: 'Laptop handover',
        note: 'Applied macro “Laptop handover”: set priority to High; added a note',
        steps: [
          { type: 'priority', summary: 'Set priority to High', ok: true },
          { type: 'note', summary: 'Added a note', ok: true },
          { type: 'status', summary: 'Set status to Pending', ok: true, skipped: true, reason: 'A later status step in this macro wins' },
          { type: 'assign', summary: 'Assigned to Sam Ortiz', ok: false, error: 'Sam Ortiz is away' },
        ],
      },
    }] });
    expect(it).toMatchObject({ event: 'macro', actor: 'Alex Rivera', actorType: 'person', machine: false, verb: 'applied macro “Laptop handover”', reason: '1 step failed', detail: null });
    expect(it.extra).toEqual([
      'Set priority to High',
      'Added a note',
      'Set status to Pending · skipped: A later status step in this macro wins',
      'Assigned to Sam Ortiz · failed: Sam Ortiz is away',
    ]);
    const [clean] = buildHistoryItems({ activities: [{ id: 82, activityType: 'macro_applied', performedBy: 'Alex Rivera', performedAt: '2026-11-05T18:00:00.000Z', details: { actorKind: 'human', macroName: 'Close as duplicate', steps: [{ type: 'status', summary: 'Set status to Closed', ok: true }] } }] });
    expect(clean).toMatchObject({ reason: '1 step', machine: false });
  });
});
describe('QA 11-05b #3 — AI confidence in the details, preview runs hidden', () => {
  const T = Date.parse('2026-10-22T16:12:00Z');
  const at = (min) => new Date(T + min * 60e3).toISOString();
  const aiEpisode = { id: 41, technician: { name: 'Jordan Lee' }, startMethod: 'workflow_assigned', startAssignedByName: 'Ticket Pulse AI', startedAt: at(0) };
  const recommendation = {
    confidence: 'medium',
    recommendations: [
      { rank: 1, score: 0.74, techId: 3, techName: 'Casey Park' },
      { rank: 2, score: 0.82, techId: 7, techName: 'Jordan Lee' },
      { rank: 3, score: 0.6, techId: 9, techName: 'Sam Ortiz' },
    ],
  };
  const aiRun = { id: 3301, status: 'completed', decision: 'auto_assigned', triggerSource: 'webhook', assignedTechId: 7, recommendation, createdAt: at(-1), decidedAt: at(-0.2) };

  test('(a) the AI assignment line carries "Confidence 82 % · 3 people considered" in its details only', () => {
    const items = buildHistoryItems({ assignmentEpisodes: [aiEpisode], pipelineRuns: [aiRun] });
    expect(items).toHaveLength(1);
    const [line] = items;
    expect(line.extra).toEqual(['Confidence 82 % · 3 people considered', expect.stringMatching(/^AI run #3301 · via webhook/)]);
    // Never on the line itself.
    for (const field of ['verb', 'reason', 'to', 'detail']) expect(String(line[field] ?? '')).not.toMatch(/Confidence|%/);
  });

  test('(a) the assigned person\'s score is used; rank 1 when they are not in the list', () => {
    expect(aiAssignmentConfidence(aiRun)).toBe('Confidence 82 % · 3 people considered');
    expect(aiAssignmentConfidence({ ...aiRun, assignedTechId: 99 })).toBe('Confidence 74 % · 3 people considered');
    expect(aiAssignmentConfidence({ ...aiRun, assignedTechId: null })).toBe('Confidence 74 % · 3 people considered');
  });

  test('(a) omitted when the run carries no recommendation or score', () => {
    expect(aiAssignmentConfidence({ id: 1 })).toBeNull();
    expect(aiAssignmentConfidence({ id: 1, recommendation: { confidence: 'high' } })).toBeNull();
    expect(aiAssignmentConfidence({ id: 1, recommendation: { recommendations: [{ rank: 1, techId: 3 }] } })).toBe('1 person considered');
    const items = buildHistoryItems({ assignmentEpisodes: [aiEpisode], pipelineRuns: [{ ...aiRun, recommendation: null }] });
    expect(items[0].extra).toEqual([expect.stringMatching(/^AI run #3301/)]);
  });

  test('(c) a workflow preview run never shows, even with machine activity on; Shadow and skipped still do', () => {
    const base = { workflowId: 3, workflowName: 'Ticket arrived', eventType: 'ticket.created', status: 'completed', durationMs: 90, actions: [], steps: [] };
    const items = buildHistoryItems({ workflowRuns: [
      { ...base, id: 950, executionMode: 'preview', shadow: true, startedAt: at(30), outcome: 'nothing', actions: [{ type: 'email', to: 1, cc: 0, sent: false }] },
      { ...base, id: 951, executionMode: 'mock', shadow: true, startedAt: at(20), outcome: 'nothing', actions: [{ type: 'email', to: 1, cc: 0, sent: false }] },
      { ...base, id: 952, executionMode: 'live', shadow: false, startedAt: at(10), outcome: 'stopped', stopReason: 'Noise ticket skipped' },
    ] });
    expect(items.map((i) => i.key)).toEqual(['wf-951', 'wf-952']);
    expect(items.some((i) => /preview/i.test(i.verb))).toBe(false);
    expect(countMachine(items)).toBe(2);
    expect(isPreviewRun({ executionMode: 'preview' })).toBe(true);
    expect(isPreviewRun({ executionMode: 'mock' })).toBe(false);
  });
});