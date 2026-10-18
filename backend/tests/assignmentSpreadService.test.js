import { jest } from '@jest/globals';

/**
 * Assignment spread — the service (QA 10-13 item 17): settings in app_settings,
 * what was just assigned (table + the in-process ledger), the guard on one
 * automatic assignment, the staggered release, and the results page.
 */
const prismaMock = {
  assignmentPipelineRun: { findMany: jest.fn() },
  ticket: { findUnique: jest.fn(), findMany: jest.fn() },
  technician: { findFirst: jest.fn() },
  hrLifecycleFamilyMember: { findMany: jest.fn() },
  ticketAssignmentEpisode: { findMany: jest.fn() },
  workspace: { findUnique: jest.fn() },
  $queryRaw: jest.fn(),
};
const store = new Map();
const settingsRepositoryMock = {
  get: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
  set: jest.fn(async (key, value) => { store.set(key, value); }),
};
const urgentMock = {
  _context: jest.fn(async () => ({})),
  _person: jest.fn(),
  _state: jest.fn(),
  pickResponder: jest.fn(),
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/urgentResponse/urgentResponseService.js', () => ({ default: urgentMock }));

const { default: spread, settingsKey } = await import('../src/services/assignmentSpread/spreadService.js');

const NOW = new Date('2026-10-14T16:00:00Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000);
const PEOPLE = {
  5: { id: 5, name: 'Dana', isActive: true, freshserviceId: 105n, origin: 'freshservice' },
  6: { id: 6, name: 'Eli', isActive: true, freshserviceId: 106n, origin: 'freshservice' },
  7: { id: 7, name: 'Fay', isActive: true, freshserviceId: 107n, origin: 'freshservice' },
  8: { id: 8, name: 'Gus', isActive: true, freshserviceId: null, origin: 'local' },
};
let atWork;
const runRow = (id, techId, minutes, extra = {}) => ({
  id, ticketId: 1000 + id, assignedTechId: techId, decidedAt: minutesAgo(minutes), syncStatus: 'synced', ticket: { assignedTechId: techId }, ...extra,
});
const REC = { internalCategoryId: 10, internalSubcategoryId: 101, recommendations: [{ rank: 1, techId: 5, techName: 'Dana' }, { rank: 2, techId: 6, techName: 'Eli' }, { rank: 3, techId: 7, techName: 'Fay' }] };
const guard = (extra = {}) => spread.guardAutoAssignment({ workspaceId: 1, ticketId: 42, runId: 900, techId: 5, techName: 'Dana', recommendation: REC, now: NOW, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  spread._reset();
  atWork = new Set([5, 6, 7, 8]);
  prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([]);
  prismaMock.ticket.findUnique.mockResolvedValue({ id: 42, workspaceId: 1, origin: 'freshservice', internalCategoryId: null, internalSubcategoryId: null });
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.technician.findFirst.mockImplementation(async ({ where }) => PEOPLE[where.id] || null);
  prismaMock.hrLifecycleFamilyMember.findMany.mockResolvedValue([]);
  prismaMock.ticketAssignmentEpisode.findMany.mockResolvedValue([]);
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver' });
  prismaMock.$queryRaw.mockResolvedValue([]);
  urgentMock._person.mockImplementation(async (_ctx, id) => PEOPLE[id] || null);
  urgentMock._state.mockImplementation((_ctx, tech) => ({ atWork: atWork.has(tech.id) }));
  urgentMock.pickResponder.mockResolvedValue({ chosen: null, ranked: [], considered: [] });
});

describe('settings', () => {
  test('no row: on for IT, off elsewhere; reading never writes', async () => {
    expect((await spread.getSettings(1)).enabled).toBe(true);
    expect((await spread.getSettings(2)).enabled).toBe(false);
    expect(settingsRepositoryMock.set).not.toHaveBeenCalled();
  });

  test('a save is stored per workspace with who and what, and is read back at once', async () => {
    const out = await spread.saveSettings(5, { enabled: true, capCount: 2 }, { by: 'Vahid', now: NOW });
    expect(out.errors).toEqual([]);
    expect(out.changes).toEqual([{ field: 'enabled', from: false, to: true }, { field: 'capCount', from: 3, to: 2 }]);
    expect(settingsRepositoryMock.set).toHaveBeenCalledWith(settingsKey(5), expect.any(String));
    expect(settingsKey(5)).toBe('assignment_spread_ws5');
    const stored = JSON.parse(store.get('assignment_spread_ws5'));
    expect(stored).toMatchObject({ enabled: true, capCount: 2, updatedBy: 'Vahid', enabledSince: NOW.toISOString() });
    expect((await spread.getSettings(5)).capCount).toBe(2);
    expect((await spread.getSettings(1)).capCount).toBe(3);
  });

  test('a bad number saves nothing', async () => {
    const out = await spread.saveSettings(1, { capCount: 0 }, { by: 'Vahid' });
    expect(out.errors).toEqual(['capCount must be a whole number from 1 to 20']);
    expect(settingsRepositoryMock.set).not.toHaveBeenCalled();
  });

  test('settings that cannot be read mean "off for this decision", never the default-on', async () => {
    settingsRepositoryMock.get.mockRejectedValueOnce(new Error('pool timeout'));
    expect(await spread.getSettings(1)).toMatchObject({ enabled: false, unreadable: true });
    // not cached: the next read works
    expect((await spread.getSettings(1)).enabled).toBe(true);
  });
});

describe('what was just assigned', () => {
  const since = minutesAgo(10);

  test('automatic assignments only, and never a ticket that has left the person', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([
      runRow(1, 5, 1),
      runRow(2, 5, 2, { syncStatus: 'pending', ticket: { assignedTechId: null } }), // still being saved
      runRow(3, 5, 3, { ticket: { assignedTechId: 6 } }), // moved on by a person
      runRow(4, 5, 4, { ticket: { assignedTechId: null } }), // handed back
      runRow(5, 5, 5, { syncStatus: 'dry_run', ticket: { assignedTechId: null } }),
      runRow(6, 5, 6, { syncStatus: 'failed', ticket: { assignedTechId: null } }),
    ]);
    const events = await spread.recentEvents(1, { since });
    expect(events.map((e) => [e.ticketId, e.saved])).toEqual([[1001, true], [1002, false]]);
    const where = prismaMock.assignmentPipelineRun.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ workspaceId: 1, decision: 'auto_assigned', decidedAt: { gte: since } });
  });

  test('a decision made in this process counts before it is in the table, then the table takes over', async () => {
    await guard();
    let events = await spread.recentEvents(1, { since });
    expect(events).toEqual([expect.objectContaining({ techId: 5, ticketId: 42, saved: false, source: 'ledger' })]);
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([runRow(900, 5, 0, { ticketId: 42, syncStatus: 'pending', ticket: { assignedTechId: null } })]);
    events = await spread.recentEvents(1, { since });
    expect(events).toEqual([expect.objectContaining({ ticketId: 42, source: 'run' })]);
    // handed back afterwards: the ledger does not keep it alive
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([runRow(900, 5, 0, { ticketId: 42, ticket: { assignedTechId: null }, syncStatus: 'synced' })]);
    expect(await spread.recentEvents(1, { since })).toEqual([]);
  });

  test('a new hire\'s set given by the onboarding engine counts once; other engine work does not', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([
      { id: 201, assignedTechId: 5, assignedAt: minutesAgo(1) },
      { id: 202, assignedTechId: 5, assignedAt: minutesAgo(1) },
      { id: 203, assignedTechId: 5, assignedAt: minutesAgo(1) }, // an accounts child: not a set
    ]);
    prismaMock.hrLifecycleFamilyMember.findMany.mockResolvedValue([{ ticketId: 201, familyId: 7 }, { ticketId: 202, familyId: 7 }]);
    const events = await spread.recentEvents(1, { since });
    expect(events.map((e) => [e.ticketId, e.unitKey, e.source])).toEqual([[201, 'set:7', 'onboarding'], [202, 'set:7', 'onboarding']]);
    expect(prismaMock.ticket.findMany.mock.calls[0][0].where).toMatchObject({ assignedBy: { startsWith: 'Ticket Pulse' } });
    expect(prismaMock.hrLifecycleFamilyMember.findMany.mock.calls[0][0].where).toMatchObject({ family: { kind: 'onboarding' } });
  });

  test('the AI\'s candidate list: recent assignments shown, added to the load the score uses, and the cap flagged', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([
      runRow(1, 5, 1), runRow(2, 5, 2), runRow(3, 5, 3, { syncStatus: 'pending', ticket: { assignedTechId: null } }), runRow(4, 6, 4),
    ]);
    const rows = [{ techId: 5, openTickets: 4 }, { techId: 6, openTickets: 4 }, { techId: 7, openTickets: 4 }];
    const note = await spread.annotateCandidates(1, rows, { now: NOW });
    expect(rows[0]).toMatchObject({ assignedByAutomationRecently: { count: 3, minutes: 10, notYetInOpenTickets: 1 }, loadForScore: 8, atAssignmentCap: true });
    expect(rows[1]).toMatchObject({ assignedByAutomationRecently: { count: 1, minutes: 10, notYetInOpenTickets: 0 }, loadForScore: 5 });
    expect(rows[1].atAssignmentCap).toBeUndefined();
    expect(rows[2]).toMatchObject({ assignedByAutomationRecently: { count: 0 }, loadForScore: 4 });
    expect(note).toContain('atAssignmentCap');
  });

  test('rules off, or a failing read: the candidate list is exactly as before', async () => {
    const rows = [{ techId: 5, openTickets: 4 }];
    expect(await spread.annotateCandidates(2, rows, { now: NOW })).toBeNull();
    expect(rows).toEqual([{ techId: 5, openTickets: 4 }]);
    prismaMock.assignmentPipelineRun.findMany.mockRejectedValue(new Error('down'));
    expect(await spread.annotateCandidates(1, rows, { now: NOW })).not.toBeNull();
    expect(rows[0].loadForScore).toBe(4);
  });
});

describe('the guard on one automatic assignment', () => {
  const threeForDana = () => prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([runRow(1, 5, 1), runRow(2, 5, 4), runRow(3, 5, 8)]);

  test('under the cap: unchanged, remembered, and a record for the results page', async () => {
    const out = await guard();
    expect(out).toMatchObject({ techId: 5, changed: false, rule: 'none', sentence: null, step: null });
    expect(out.record).toMatchObject({ rule: 'none', unit: 'ticket:42', recent: 0, cap: { count: 3, minutes: 10 } });
  });

  test('the fourth in ten minutes goes to the run\'s next candidate who is at work', async () => {
    threeForDana();
    const out = await guard();
    expect(out).toMatchObject({ techId: 6, techName: 'Eli', changed: true, moved: true, rule: 'cap' });
    expect(out.sentence).toBe('Given to Eli instead of Dana: Dana already got 3 tickets from automation in the last 10 minutes (the cap is 3).');
    expect(out.step).toMatchObject({
      stepName: 'assignment_spread', status: 'completed',
      output: { kind: 'assignment_spread', rule: 'cap', fromTechId: 5, fromTechName: 'Dana', toTechId: 6, toTechName: 'Eli', recentCount: 3 },
    });
    expect(out.record).toMatchObject({ rule: 'cap', from: { techId: 5, name: 'Dana' }, to: { techId: 6, name: 'Eli' } });
  });

  test('the next candidate is away: the one after; someone who handed this ticket back is never chosen', async () => {
    threeForDana();
    atWork.delete(6);
    expect(await guard()).toMatchObject({ techId: 7, rule: 'cap' });
    spread._reset();
    atWork.add(6);
    prismaMock.ticketAssignmentEpisode.findMany.mockResolvedValue([{ technicianId: 6 }]);
    expect(await guard()).toMatchObject({ techId: 7 });
    spread._reset();
    prismaMock.ticketAssignmentEpisode.findMany.mockResolvedValue([]);
    expect(await guard({ reboundFrom: { previousTechId: 6 } })).toMatchObject({ techId: 7 });
  });

  test('a FreshService ticket never goes to someone without a FreshService seat', async () => {
    threeForDana();
    const rec = { ...REC, recommendations: [{ rank: 1, techId: 5, techName: 'Dana' }, { rank: 2, techId: 8, techName: 'Gus' }, { rank: 3, techId: 7, techName: 'Fay' }] };
    const out = await guard({ recommendation: rec });
    expect(out.techId).toBe(7);
    expect(out.record.considered[0]).toMatchObject({ techId: 8, whyNot: 'no FreshService seat' });
    // a Ticket Pulse ticket can
    spread._reset();
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 42, workspaceId: 1, origin: 'ticketpulse' });
    expect((await guard({ recommendation: rec })).techId).toBe(8);
  });

  test('the run named nobody else: someone at work with the skill takes it', async () => {
    threeForDana();
    urgentMock.pickResponder.mockResolvedValue({ ranked: [{ id: 9, name: 'Hal', skill: 'none' }, { id: 7, name: 'Fay', skill: 'category' }] });
    const out = await guard({ recommendation: { ...REC, recommendations: [{ rank: 1, techId: 5, techName: 'Dana' }] } });
    expect(out).toMatchObject({ techId: 7, rule: 'cap' });
    expect(out.record.considered).toEqual([{ techId: 7, name: 'Fay', whyNot: null, source: 'skill' }]);
    expect(urgentMock.pickResponder).toHaveBeenCalledWith(1, expect.objectContaining({ internalCategoryId: 10, internalSubcategoryId: 101 }), expect.objectContaining({ exclude: [5] }));
  });

  test('nobody else qualified is at work: the cap gives way and the run says so', async () => {
    threeForDana();
    atWork = new Set([5]);
    const out = await guard();
    expect(out).toMatchObject({ techId: 5, changed: true, moved: false, rule: 'cap_gave_way' });
    expect(out.sentence).toContain('the cap gave way');
    expect(out.step.output).toMatchObject({ rule: 'cap_gave_way', toTechId: null });
  });

  test('two runs finishing together cannot both see "2 so far": the second one is moved', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([runRow(1, 5, 1), runRow(2, 5, 4)]);
    const [a, b] = await Promise.all([guard({ ticketId: 42, runId: 900 }), guard({ ticketId: 43, runId: 901 })]);
    expect([a.rule, b.rule].sort()).toEqual(['cap', 'none']);
    expect([a.techId, b.techId].sort()).toEqual([5, 6]);
  });

  test('a new hire\'s Workstation follows the Laptop to the same person, and is not a fourth', async () => {
    prismaMock.hrLifecycleFamilyMember.findMany.mockImplementation(async ({ where }) => {
      if (where.familyId) return [{ ticketId: 41 }];
      return (where.ticketId?.in || []).filter((id) => [41, 42].includes(id)).map((ticketId) => ({ ticketId, familyId: 7 }));
    });
    prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where.id?.in ? [{ assignedTechId: 6, assignedAt: minutesAgo(2) }] : []));
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([runRow(1, 6, 1), runRow(2, 6, 2), runRow(3, 6, 3, { ticketId: 41 })]);
    const out = await guard();
    expect(out).toMatchObject({ techId: 6, techName: 'Eli', rule: 'new_hire_set', moved: true });
    expect(out.record.unit).toBe('set:7');
    expect(out.sentence).toContain('Kept with Eli');
  });

  test('the other half was decided a moment ago and is not saved yet: still kept together', async () => {
    prismaMock.hrLifecycleFamilyMember.findMany.mockImplementation(async ({ where }) => {
      if (where.familyId) return [{ ticketId: where.ticketId.not === 41 ? 42 : 41 }];
      return (where.ticketId?.in || []).filter((id) => [41, 42].includes(id)).map((ticketId) => ({ ticketId, familyId: 7 }));
    });
    expect(await guard({ ticketId: 41, runId: 899, techId: 6, techName: 'Eli' })).toMatchObject({ techId: 6, rule: 'none' });
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 42, workspaceId: 1, origin: 'freshservice' });
    expect(await guard({ ticketId: 42, runId: 900 })).toMatchObject({ techId: 6, rule: 'new_hire_set' });
  });

  test('a person the urgent rule chose is counted, never moved', async () => {
    threeForDana();
    expect(await guard({ locked: true })).toMatchObject({ techId: 5, changed: false, rule: 'none' });
    expect(urgentMock._context).not.toHaveBeenCalled();
  });

  test('off for the workspace, a dry run, a sandbox: untouched and nothing read', async () => {
    for (const args of [{ workspaceId: 2 }, { dryRun: true }, { workspaceId: 7 }]) {
      const out = await guard(args);
      expect(out).toMatchObject({ techId: 5, changed: false, record: null, step: null });
    }
    expect(prismaMock.assignmentPipelineRun.findMany).not.toHaveBeenCalled();
  });

  test('any failure inside leaves the assignment as it was', async () => {
    threeForDana();
    urgentMock._context.mockRejectedValue(new Error('calendar down'));
    const out = await guard();
    expect(out).toMatchObject({ techId: 5, changed: false, rule: 'none', record: null });
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('the guard failed'), expect.any(Object));
    // and the next decision is not stuck behind it
    urgentMock._context.mockResolvedValue({});
    expect((await guard({ ticketId: 43 })).rule).toBe('cap');
  });
});

describe('the staggered release', () => {
  test('off: the drain is told to run as before', async () => {
    expect(await spread.beginRelease(2)).toMatchObject({ staggered: false, wait: false });
    await spread.saveSettings(1, { staggerEnabled: false }, { by: 'A' });
    expect((await spread.beginRelease(1)).staggered).toBe(false);
  });

  test('on: two per two minutes, one release at a time, and only runs that really started use it up', async () => {
    const first = await spread.beginRelease(1, { now: NOW });
    expect(first).toMatchObject({ staggered: true, wait: false, allowance: 2, fetchLimit: 50 });
    // a second tick while the first is still deciding waits
    expect(await spread.beginRelease(1, { now: NOW })).toMatchObject({ staggered: true, wait: true });
    first.started(2);
    first.done();
    expect(await spread.beginRelease(1, { now: new Date() })).toMatchObject({ staggered: true, wait: true });
    const later = await spread.beginRelease(1, { now: new Date(Date.now() + 2 * 60000) });
    expect(later).toMatchObject({ wait: false, allowance: 2 });
    later.done();
  });

  test('a release that started nothing (only stale runs swept away) leaves the allowance whole', async () => {
    const first = await spread.beginRelease(1, { now: NOW });
    first.done();
    const again = await spread.beginRelease(1, { now: new Date() });
    expect(again).toMatchObject({ wait: false, allowance: 2 });
    again.done();
  });

  test('the order handed to the drain is most urgent, then oldest', async () => {
    const release = await spread.beginRelease(1, { now: NOW });
    const order = release.order([
      { id: 1, queuedAt: minutesAgo(300), ticket: { priority: 2 } },
      { id: 2, queuedAt: minutesAgo(10), ticket: { priority: 4 } },
      { id: 3, queuedAt: minutesAgo(500), ticket: { priority: 2 } },
    ]).map((r) => r.id);
    expect(order).toEqual([2, 3, 1]);
    release.done();
  });
});

describe('how the rules have worked', () => {
  test('counts per rule and per day, the recent changes as a plain list, and only the small record leaves the database', async () => {
    const day = new Date('2026-10-14T15:00:00Z');
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        { id: 1, ticketId: 11, techId: 5, at: day, spread: { rule: 'none', unit: 'ticket:11' } },
        { id: 2, ticketId: 12, techId: 6, at: new Date(day.getTime() + 60000), spread: { rule: 'cap', unit: 'ticket:12', recent: 3, from: { techId: 5, name: 'Dana' }, to: { techId: 6, name: 'Eli' }, why: 'Given to Eli instead of Dana.' } },
        { id: 3, ticketId: 13, techId: 5, at: new Date(day.getTime() + 120000), spread: { rule: 'cap_gave_way', unit: 'ticket:13', recent: 3, from: { techId: 5, name: 'Dana' }, to: { techId: 5, name: 'Dana' }, why: 'The cap gave way.' } },
      ])
      .mockResolvedValueOnce([{ queuedAt: new Date(day.getTime() - 7200000), claimedAt: new Date(day.getTime() - 3600000) }]);
    prismaMock.ticket.findMany.mockResolvedValue([
      { id: 12, origin: 'ticketpulse', nativeNumber: 1900, freshserviceTicketId: null, subject: 'Printer' },
      { id: 13, origin: 'ticketpulse', nativeNumber: 1901, freshserviceTicketId: null, subject: 'VPN' },
    ]);
    const out = await spread.results(1, { days: 7, now: new Date('2026-10-14T20:00:00Z') });
    expect(out.days).toBe(7);
    expect(out.perDay).toHaveLength(7);
    expect(out.totals).toEqual({ assignments: 3, moved: 1, keptTogether: 0, gaveWay: 1, guarded: 3 });
    expect(out.settings).toMatchObject({ enabled: true, capCount: 3 });
    expect(out.events).toEqual([
      expect.objectContaining({ runId: 3, rule: 'cap_gave_way', wouldHaveGoneTo: 'Dana', wentTo: 'Dana', ticket: expect.objectContaining({ displayRef: 'TP-1901', subject: 'VPN' }) }),
      expect.objectContaining({ runId: 2, rule: 'cap', wouldHaveGoneTo: 'Dana', wentTo: 'Eli', ticket: expect.objectContaining({ displayRef: 'TP-1900' }) }),
    ]);
    const sql = prismaMock.$queryRaw.mock.calls[0][0];
    expect(sql.strings.join('?')).toContain("r.recommendation -> 'spread'");
    expect(sql.strings.join('?')).not.toContain('full_transcript');
  });

  test('an odd period falls back to 30 days; a failing read gives an empty page, not an error', async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error('down'));
    const out = await spread.results(1, { days: 999, now: NOW });
    expect(out.days).toBe(30);
    expect(out.totals.assignments).toBe(0);
    expect(out.events).toEqual([]);
  });
});
