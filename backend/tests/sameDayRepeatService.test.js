import { jest } from '@jest/globals';

/**
 * QA 11-23 items 4–5, the TP-1042 shape: at 9:47 AM Pacific the requester
 * opened TP-1042 ("can't sign into Teams"), which went to Eli Park. At
 * 10:15 AM the same person opened TP-1043 ("Lost access to Teams again") and
 * the AI picked Dana Fox. TP-1043 should go to Eli (Live), or say so (Shadow),
 * and its priority goes one level above what the AI chose.
 */
const settingsStore = new Map();
const settingsRepositoryMock = {
  get: jest.fn(async (key) => settingsStore.get(key) ?? null),
  set: jest.fn(async (key, value) => { settingsStore.set(key, value); }),
};
const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { findUnique: jest.fn(), findMany: jest.fn() },
  ticketEmbedding: { findMany: jest.fn() },
  ticketActivity: { findMany: jest.fn(), create: jest.fn() },
  technician: { findFirst: jest.fn() },
  technicianLeave: { findMany: jest.fn() },
  ticketAssignmentEpisode: { findFirst: jest.fn() },
};
const awayMock = { forTechnician: jest.fn() };
const addPrivateNote = jest.fn();
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentTools.js', () => ({ openWorkloadStatuses: jest.fn(async () => ['Open', 'Pending']) }));
jest.unstable_mockModule('../src/services/assigneeAwayService.js', () => ({ default: awayMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { addPrivateNote } }));
const isBusinessHours = jest.fn();
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({ default: { isBusinessHours } }));

const { default: service, settingsKey } = await import('../src/services/assignmentFollowUp/sameDayRepeatService.js');

const WS = 1;
const ELI = 12;
const DANA = 11;
const pst = (hhmm) => new Date(`2026-11-23T${hhmm}:00.000-08:00`);
const NOW = pst('10:16');

const NEW_TICKET = {
  id: 2001, workspaceId: WS, requesterId: 77, createdAt: pst('10:15'), subject: 'Lost access to Teams again', triageMode: null, origin: 'ticketpulse',
  internalCategoryId: null, internalSubcategoryId: null,
};
const FIRST = {
  id: 2000, subject: "can't sign into Teams", createdAt: pst('09:47'), status: 'Open', origin: 'ticketpulse', nativeNumber: 1042, freshserviceTicketId: null,
  internalCategoryId: 10, internalSubcategoryId: 101, assignedTechId: ELI, assignedTech: { id: ELI, name: 'Eli Park' },
};
const REC = () => ({
  internalCategoryId: 10, internalSubcategoryId: 101, assessedPriority: 'Medium', assessedPriorityId: 2, priorityRationale: 'One person blocked.',
  recommendations: [{ techId: DANA, techName: 'Dana Fox' }],
});

beforeEach(() => {
  jest.clearAllMocks();
  settingsStore.clear();
  service._reset();
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver' });
  prismaMock.ticket.findUnique.mockResolvedValue({ ...NEW_TICKET });
  prismaMock.ticket.findMany.mockResolvedValue([FIRST]);
  prismaMock.ticketEmbedding.findMany.mockResolvedValue([]);
  prismaMock.ticketActivity.findMany.mockResolvedValue([]);
  prismaMock.ticketActivity.create.mockResolvedValue({ id: 1 });
  prismaMock.technician.findFirst.mockResolvedValue({
    id: ELI, name: 'Eli Park', isActive: true, timezone: 'America/Vancouver', workStartTime: '08:00', workEndTime: '17:00', freshserviceId: BigInt(55),
  });
  prismaMock.technicianLeave.findMany.mockResolvedValue([]);
  prismaMock.ticketAssignmentEpisode.findFirst.mockResolvedValue(null);
  awayMock.forTechnician.mockResolvedValue(null);
  addPrivateNote.mockResolvedValue({});
  isBusinessHours.mockResolvedValue({ isBusinessHours: true });
});

describe('findSameDayRelatedOpenTicket', () => {
  test('finds the requester\'s open ticket from earlier today about the same problem', async () => {
    const found = await service.findSameDayRelatedOpenTicket({ ...NEW_TICKET, internalCategoryId: 10, internalSubcategoryId: 101 }, { now: NOW });
    expect(found).toMatchObject({ ticketId: 2000, ref: 'TP-1042', matchedOn: 'subcategory', owner: { techId: ELI, techName: 'Eli Park' } });
    const where = prismaMock.ticket.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ workspaceId: WS, requesterId: 77, id: { not: 2001 }, isNoise: false, status: { in: ['Open', 'Pending'] } });
    expect(where.createdAt.gte.toISOString()).toBe('2026-11-23T08:00:00.000Z'); // Pacific midnight
    expect(where.createdAt.lt).toEqual(pst('10:15')); // earlier than this ticket only
  });

  test('a different problem from the same requester is not related', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([{ ...FIRST, internalSubcategoryId: 102, subject: 'Need a second monitor' }]);
    expect(await service.findSameDayRelatedOpenTicket({ ...NEW_TICKET, internalCategoryId: 10, internalSubcategoryId: 101 })).toBeNull();
  });

  test('a close subject is enough when the categories are missing', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([{ ...FIRST, internalCategoryId: null, internalSubcategoryId: null, subject: 'Teams sign in failing' }]);
    const found = await service.findSameDayRelatedOpenTicket({ ...NEW_TICKET, subject: 'RE: Teams sign in failing' });
    expect(found).toMatchObject({ ticketId: 2000, matchedOn: 'subject' });
  });

  test('loads the ticket when only the id is given; no requester means nothing', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ ...NEW_TICKET, internalCategoryId: 10, internalSubcategoryId: 101 });
    expect(await service.findSameDayRelatedOpenTicket({ id: 2001 })).toMatchObject({ ticketId: 2000 });
    prismaMock.ticket.findUnique.mockResolvedValue({ ...NEW_TICKET, requesterId: null });
    expect(await service.findSameDayRelatedOpenTicket({ id: 2001 })).toBeNull();
  });

  test('a database error answers null', async () => {
    prismaMock.ticket.findMany.mockRejectedValue(new Error('db down'));
    expect(await service.findSameDayRelatedOpenTicket({ ...NEW_TICKET, internalSubcategoryId: 101 })).toBeNull();
  });
});

describe('evaluate: the repeat raises priority one level (item 5)', () => {
  test('Medium from the AI becomes High, with the reason on the run', async () => {
    const rec = REC();
    const out = await service.evaluate({ workspaceId: WS, ticketId: 2001, runId: 9, recommendation: rec, now: NOW });
    expect(out.bump).toEqual({ from: 'Medium', to: 'High' });
    expect(rec).toMatchObject({ assessedPriority: 'High', assessedPriorityId: 3 });
    expect(rec.priorityRationale).toMatch(/^One person blocked\. Raised from Medium to High/);
    expect(rec.repeatReport).toMatchObject({
      relatedTicketId: 2000, relatedRef: 'TP-1042', matchedOn: 'subcategory', aiPriority: 'Medium', raisedTo: 'High', raised: true,
      owner: { techId: ELI, techName: 'Eli Park' }, sentence: 'Raised to High: same problem reported again today (TP-1042).',
    });
  });

  test('the AI\'s category for this run is the one compared', async () => {
    await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: REC(), now: NOW });
    // NEW_TICKET has no category yet; the match came from the recommendation's subcategory 101.
    expect(prismaMock.ticket.findMany).toHaveBeenCalled();
  });

  test('Urgent stays Urgent; no AI priority, priority assessment off or trusted intake raise nothing', async () => {
    const urgent = { ...REC(), assessedPriority: 'Urgent', assessedPriorityId: 4 };
    expect((await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: urgent })).bump).toBeNull();
    expect(urgent.assessedPriority).toBe('Urgent');
    expect(urgent.repeatReport).toMatchObject({ raised: false, notRaisedReason: 'already_urgent' });

    const none = { ...REC(), assessedPriority: undefined };
    expect((await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: none })).record.notRaisedReason).toBe('no_ai_priority');

    const off = REC();
    expect((await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: off, priorityAssessmentEnabled: false })).bump).toBeNull();
    expect(off.assessedPriority).toBe('Medium');

    prismaMock.ticket.findUnique.mockResolvedValue({ ...NEW_TICKET, triageMode: 'trusted' });
    const trusted = REC();
    expect((await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: trusted })).record.notRaisedReason).toBe('trusted_intake');
    expect(trusted.assessedPriority).toBe('Medium');
  });

  test('business hours: a High repeat becomes Urgent', async () => {
    const rec = { ...REC(), assessedPriority: 'High', assessedPriorityId: 3 };
    const out = await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: rec, now: NOW });
    expect(isBusinessHours).toHaveBeenCalledWith(NOW, 'America/Vancouver', WS);
    expect(out.bump).toEqual({ from: 'High', to: 'Urgent' });
    expect(rec).toMatchObject({ assessedPriority: 'Urgent', assessedPriorityId: 4 });
  });

  test('after hours: a High repeat stays High and says why (never pages on-call)', async () => {
    isBusinessHours.mockResolvedValue({ isBusinessHours: false });
    const rec = { ...REC(), assessedPriority: 'High', assessedPriorityId: 3 };
    const out = await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: rec, now: pst('22:30') });
    expect(out.bump).toBeNull();
    expect(rec).toMatchObject({ assessedPriority: 'High', assessedPriorityId: 3 });
    expect(rec.repeatReport).toMatchObject({
      raised: false, raisedTo: null, aiPriority: 'High', notRaisedReason: 'after_hours',
      sentence: 'Kept at High: after hours, a repeat report doesn\'t page on-call.',
    });
  });

  test('after hours a Medium repeat still becomes High; an unreadable calendar counts as after hours', async () => {
    isBusinessHours.mockResolvedValue({ isBusinessHours: false });
    const medium = REC();
    expect((await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: medium })).bump).toEqual({ from: 'Medium', to: 'High' });
    expect(isBusinessHours).not.toHaveBeenCalled();
    isBusinessHours.mockRejectedValue(new Error('calendar down'));
    const high = { ...REC(), assessedPriority: 'High' };
    expect((await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: high })).record.notRaisedReason).toBe('after_hours');
    expect(high.assessedPriority).toBe('High');
  });

  test('no related ticket: nothing recorded, nothing changed', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([]);
    const rec = REC();
    expect(await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: rec })).toBeNull();
    expect(rec.assessedPriority).toBe('Medium');
    expect(rec.repeatReport).toBeUndefined();
  });
});

describe('recordPriorityBump: the history row through the shared helper', () => {
  test('one priority_changed row, source repeat_report, by the RULES.md contract', async () => {
    const spy = jest.spyOn(service, '_recordPriorityChange').mockResolvedValue({ id: 5 });
    const ok = await service.recordPriorityBump({
      ticketId: 2001, workspaceId: WS, runId: 9, bump: { from: 'Medium', to: 'High' }, related: { ticketId: 2000, ref: 'TP-1042' }, now: NOW,
    });
    expect(ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: 2001, from: 'Medium', to: 'High', source: 'repeat_report', actorKind: 'system', actorName: 'Ticket Pulse', actorEmail: null,
      via: { kind: 'assignment_pipeline', runId: 9 }, note: 'Same problem reported again today (TP-1042)',
      details: expect.objectContaining({ runId: 9, relatedTicketId: 2000, relatedRef: 'TP-1042' }),
    }));
    spy.mockRestore();
  });

  test('the row lands through priorityHistoryService.recordPriorityChange', async () => {
    prismaMock.ticketActivity.findFirst = jest.fn().mockResolvedValue(null); // the helper's own duplicate check
    await service.recordPriorityBump({
      ticketId: 2001, workspaceId: WS, runId: 9, bump: { from: 'Medium', to: 'High' }, related: { ticketId: 2000, ref: 'TP-1042' }, now: NOW,
    });
    expect(prismaMock.ticketActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ticketId: 2001,
        activityType: 'priority_changed',
        performedBy: 'Ticket Pulse',
        details: expect.objectContaining({ from: 'Medium', to: 'High', source: 'repeat_report', actorKind: 'system', note: 'Same problem reported again today (TP-1042)' }),
      }),
    });
  });

  test('a re-run raising to the same level writes nothing more; a failure never throws', async () => {
    const spy = jest.spyOn(service, '_recordPriorityChange').mockResolvedValue({ id: 5 });
    prismaMock.ticketActivity.findMany.mockResolvedValue([{ details: { source: 'repeat_report', to: 'High' } }]);
    expect(await service.recordPriorityBump({ ticketId: 2001, workspaceId: WS, bump: { from: 'Medium', to: 'High' }, related: { ref: 'TP-1042' } })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    prismaMock.ticketActivity.findMany.mockResolvedValue([]);
    spy.mockRejectedValue(new Error('db down'));
    expect(await service.recordPriorityBump({ ticketId: 2001, workspaceId: WS, bump: { from: 'Medium', to: 'High' }, related: { ref: 'TP-1042' } })).toBe(false);
    spy.mockRestore();
  });
});

describe('route: follow-up routing (item 4)', () => {
  const related = () => ({ ticketId: 2000, ref: 'TP-1042', subject: "can't sign into Teams", matchedOn: 'subcategory', owner: { techId: ELI, techName: 'Eli Park' } });
  const go = (over = {}) => service.route({
    workspaceId: WS, ticketId: 2001, runId: 9, decision: 'auto_assigned', related: related(), pickId: DANA, pickName: 'Dana Fox', now: NOW, ...over,
  });

  test('off by default: nothing at all', async () => {
    expect(await go()).toBeNull();
    expect(settingsRepositoryMock.get).toHaveBeenCalledWith('followup_routing_ws1');
  });

  test('Shadow: records "Would send to Eli Park", keeps Dana', async () => {
    settingsStore.set(settingsKey(WS), 'shadow');
    const out = await go();
    expect(out).toMatchObject({ techId: DANA, applied: false, sentence: null });
    expect(out.record).toMatchObject({
      mode: 'shadow', outcome: 'would_route', applied: false, notAppliedReason: 'shadow', relatedTicketId: 2000, relatedRef: 'TP-1042',
      matchedOn: 'subcategory', from: { techId: DANA, techName: 'Dana Fox' }, to: { techId: ELI, techName: 'Eli Park' },
      sentence: 'Would send to Eli Park: same problem as TP-1042 reported today.',
    });
    expect(out.step).toMatchObject({ stepName: 'followup_routing', output: { kind: 'followup_routing', outcome: 'would_route' } });
  });

  test('Live: Eli gets it when at work and not away', async () => {
    settingsStore.set(settingsKey(WS), JSON.stringify({ mode: 'live' }));
    const out = await go();
    expect(out).toMatchObject({ techId: ELI, applied: true, sentence: 'Sent to Eli Park: same problem as TP-1042 reported today.' });
    expect(out.record).toMatchObject({ mode: 'live', outcome: 'routed', notAppliedReason: null });
  });

  test('Live never acts when locked, suggest-only or dry-run', async () => {
    settingsStore.set(settingsKey(WS), 'live');
    expect((await go({ locked: true })).record).toMatchObject({ applied: false, notAppliedReason: 'locked', outcome: 'would_route' });
    expect((await go({ decision: 'pending_review' })).record).toMatchObject({ applied: false, notAppliedReason: 'suggest_only' });
    expect((await go({ dryRun: true })).record).toMatchObject({ mode: 'shadow', applied: false, notAppliedReason: 'dry_run' });
  });

  test('the owner away, on leave, off shift, or who handed it back: not sent, said why', async () => {
    settingsStore.set(settingsKey(WS), 'live');
    awayMock.forTechnician.mockResolvedValueOnce({ backOn: '2026-11-30' });
    expect((await go()).record).toMatchObject({ outcome: 'owner_unavailable', unavailableReason: 'away', applied: false });
    prismaMock.technicianLeave.findMany.mockResolvedValueOnce([{ category: 'OFF' }]);
    expect((await go()).record.unavailableReason).toBe('away today');
    prismaMock.technician.findFirst.mockResolvedValueOnce({ id: ELI, isActive: true, timezone: 'America/Vancouver', workStartTime: '12:00', workEndTime: '20:00' });
    expect((await go()).record.unavailableReason).toBe('not at work now');
    prismaMock.ticketAssignmentEpisode.findFirst.mockResolvedValueOnce({ id: 1 });
    expect((await go()).record.unavailableReason).toBe('handed this ticket back');
    const out = await go();
    expect(out.applied).toBe(true);
  });

  test('a local person cannot take a FreshService-born ticket', async () => {
    settingsStore.set(settingsKey(WS), 'live');
    prismaMock.technician.findFirst.mockResolvedValueOnce({ id: ELI, isActive: true, timezone: 'America/Vancouver', freshserviceId: null });
    expect((await go({ ticketOrigin: 'freshservice' })).record.unavailableReason).toBe('cannot hold FreshService tickets');
  });

  test('the AI already picked the owner, or the first ticket has nobody: recorded, no step', async () => {
    settingsStore.set(settingsKey(WS), 'shadow');
    const same = await go({ pickId: ELI });
    expect(same.record.outcome).toBe('already_there');
    expect(same.step).toBeNull();
    const nobody = await go({ related: { ...related(), owner: null } });
    expect(nobody.record.outcome).toBe('no_owner');
  });

  test('saveSettings validates and keeps a history line', async () => {
    expect((await service.saveSettings(WS, { mode: 'maybe' }, { by: 'Dana Fox' })).errors.length).toBe(1);
    const ok = await service.saveSettings(WS, { mode: 'shadow' }, { by: 'Dana Fox' });
    expect(ok.settings.mode).toBe('shadow');
    expect(JSON.parse(settingsStore.get('followup_routing_ws1'))).toMatchObject({ mode: 'shadow', updatedBy: 'Dana Fox' });
  });
});

describe('addMergeNote', () => {
  test('a private system note on the new ticket suggesting the merge', async () => {
    const ok = await service.addMergeNote({ ticketId: 2001, workspaceId: WS, related: { ref: 'TP-1042', subject: "can't sign into Teams", owner: { techName: 'Eli Park' } } });
    expect(ok).toBe(true);
    const [ticketId, ws, body, actor, files, opts] = addPrivateNote.mock.calls[0];
    expect([ticketId, ws, files, opts]).toEqual([2001, WS, [], { systemNote: true }]);
    expect(actor).toMatchObject({ name: 'Ticket Pulse' });
    expect(body.bodyText).toMatch(/TP-1042 \("can't sign into Teams"\) is still open with Eli Park.*Consider merging this ticket into TP-1042\./);
  });
});
