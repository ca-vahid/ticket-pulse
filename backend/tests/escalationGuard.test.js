import { jest } from '@jest/globals';

/**
 * QA 10-16 item 1 - Escalate: the pure rules and the guard service.
 *  - the level in a ticket's scope (subcategory first, then category);
 *  - higher pick kept; a pick that is not higher swapped for the best eligible
 *    person who is (the AI's order first, then level / load);
 *  - nobody higher at work: the pick is kept as a suggestion only;
 *  - no category: the AI's pick stands and the run says so;
 *  - away / handed it back / no FreshService seat are never chosen.
 */

const prismaMock = {
  ticket: { findUnique: jest.fn(), groupBy: jest.fn() },
  technician: { findMany: jest.fn(), findUnique: jest.fn() },
  technicianCompetency: { findMany: jest.fn() },
  competencyCategory: { findMany: jest.fn() },
  ticketAssignmentEpisode: { findMany: jest.fn() },
  technicianLeave: { findMany: jest.fn() },
};
const atWork = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/urgentResponse/rules.js', () => ({ atWork }));
jest.unstable_mockModule('../src/services/businessCalendarService.js', () => ({ default: { loadCalendar: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { statusNamesForBase: jest.fn().mockResolvedValue(['Open', 'Pending']) },
}));

const rules = await import('../src/services/escalation/rules.js');
const { default: escalationService } = await import('../src/services/escalation/escalationService.js');

const SCOPE = { categoryId: 40, subcategoryId: 41 };
const ESC = { fromTechId: 7, fromTechName: 'Alex Doe', rank: 2, level: 'intermediate', ...SCOPE, scope: 'Networking / VPN' };

describe('rules', () => {
  test('levelIn: subcategory row first, then the category row, else no skill', () => {
    const skills = [{ categoryId: 40, level: 'expert' }, { categoryId: 41, level: 'basic' }];
    expect(rules.levelIn(skills, SCOPE)).toEqual({ level: 'basic', rank: 1, matchedOn: 'subcategory' });
    expect(rules.levelIn([{ categoryId: 40, level: 'advanced' }], SCOPE)).toEqual({ level: 'advanced', rank: 3, matchedOn: 'category' });
    expect(rules.levelIn([], SCOPE)).toEqual({ level: null, rank: 0, matchedOn: null });
  });

  test('a pick already more advanced is kept', () => {
    const out = rules.decideEscalation({
      escalation: ESC,
      ranked: [{ techId: 5, techName: 'Dana Fox' }],
      candidates: [{ techId: 5, name: 'Dana Fox', rank: 3, eligible: true }],
    });
    expect(out).toMatchObject({ outcome: 'kept', techId: 5 });
    expect(out.sentence).toContain('Dana Fox is advanced in Networking / VPN, above Alex Doe (intermediate)');
  });

  test('a pick at the same level is swapped: the AI\'s next higher person first', () => {
    const out = rules.decideEscalation({
      escalation: ESC,
      ranked: [{ techId: 5, techName: 'Dana Fox' }, { techId: 6, techName: 'Eli Park' }],
      candidates: [
        { techId: 5, name: 'Dana Fox', rank: 2, eligible: true },
        { techId: 6, name: 'Eli Park', rank: 3, eligible: true },
        { techId: 8, name: 'Kim Roe', rank: 4, eligible: true },
      ],
    });
    expect(out).toMatchObject({ outcome: 'swapped', techId: 6, techName: 'Eli Park' });
  });

  test('outside the AI\'s list: highest level, then lightest load', () => {
    const out = rules.decideEscalation({
      escalation: ESC,
      ranked: [{ techId: 5, techName: 'Dana Fox' }],
      candidates: [
        { techId: 5, name: 'Dana Fox', rank: 1, eligible: true },
        { techId: 8, name: 'Kim Roe', rank: 4, eligible: true, openCount: 9 },
        { techId: 9, name: 'Sam Lee', rank: 4, eligible: true, openCount: 2 },
        { techId: 10, name: 'Max Ray', rank: 3, eligible: true, openCount: 0 },
      ],
    });
    expect(out).toMatchObject({ outcome: 'swapped', techId: 9 });
  });

  test('nobody higher and eligible: keep the pick, suggestion only', () => {
    const out = rules.decideEscalation({
      escalation: ESC,
      ranked: [{ techId: 5, techName: 'Dana Fox' }],
      candidates: [
        { techId: 5, name: 'Dana Fox', rank: 2, eligible: true },
        { techId: 8, name: 'Kim Roe', rank: 4, eligible: false, why: 'on_leave' },
      ],
    });
    expect(out).toMatchObject({ outcome: 'none_higher', techId: 5 });
    expect(out.sentence).toContain('no one more advanced than Alex Doe (intermediate) in Networking / VPN is available');
  });

  test('no category: the AI\'s pick stands and says so', () => {
    const out = rules.decideEscalation({ escalation: { ...ESC, categoryId: null, subcategoryId: null }, ranked: [{ techId: 5, techName: 'Dana Fox' }], candidates: [] });
    expect(out).toMatchObject({ outcome: 'no_category', techId: 5 });
    expect(out.sentence).toContain('no category');
  });

  test('promote puts the chosen person first and renumbers', () => {
    const list = rules.promote([{ techId: 5, techName: 'Dana Fox', rank: 1 }, { techId: 6, techName: 'Eli Park', rank: 2 }], { techId: 6, techName: 'Eli Park' }, 'why');
    expect(list.map((r) => [r.techId, r.rank])).toEqual([[6, 1], [5, 2]]);
    const added = rules.promote([{ techId: 5, rank: 1 }], { techId: 9, name: 'Sam Lee' }, 'why');
    expect(added[0]).toMatchObject({ techId: 9, techName: 'Sam Lee', rank: 1, escalationPromoted: true });
  });

  test('escalationNote reads like the ticket line', () => {
    expect(rules.escalationNote(ESC)).toBe('Escalated by Alex Doe: needs someone more advanced in Networking / VPN');
  });
});

describe('escalationService', () => {
  const TEAM = [
    { id: 5, name: 'Dana Fox', isActive: true, assignableOnly: false, origin: 'freshservice', freshserviceId: BigInt(5005) },
    { id: 6, name: 'Eli Park', isActive: true, assignableOnly: false, origin: 'freshservice', freshserviceId: BigInt(6006) },
    { id: 7, name: 'Alex Doe', isActive: true, assignableOnly: false, origin: 'freshservice', freshserviceId: BigInt(7007) },
    { id: 8, name: 'Kim Roe', isActive: true, assignableOnly: false, origin: 'local', freshserviceId: null },
    { id: 9, name: 'Sam Lee', isActive: true, assignableOnly: false, origin: 'freshservice', freshserviceId: BigInt(9009) },
  ];
  const LEVELS = [
    { technicianId: 5, competencyCategoryId: 41, proficiencyLevel: 'intermediate' },
    { technicianId: 6, competencyCategoryId: 40, proficiencyLevel: 'advanced' },
    { technicianId: 7, competencyCategoryId: 41, proficiencyLevel: 'intermediate' },
    { technicianId: 8, competencyCategoryId: 41, proficiencyLevel: 'expert' },
    { technicianId: 9, competencyCategoryId: 41, proficiencyLevel: 'expert' },
  ];
  const recommendation = { recommendations: [{ techId: 5, techName: 'Dana Fox' }, { techId: 6, techName: 'Eli Park' }] };

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 601, origin: 'freshservice', internalCategoryId: 40, internalSubcategoryId: 41 });
    prismaMock.technician.findMany.mockResolvedValue(TEAM);
    prismaMock.technicianCompetency.findMany.mockImplementation(({ where }) => Promise.resolve(
      LEVELS.filter((l) => where.technicianId.in.includes(l.technicianId)),
    ));
    prismaMock.competencyCategory.findMany.mockResolvedValue([{ id: 40, name: 'Networking' }, { id: 41, name: 'VPN' }]);
    prismaMock.ticketAssignmentEpisode.findMany.mockResolvedValue([{ technicianId: 7 }]);
    prismaMock.technicianLeave.findMany.mockResolvedValue([]);
    prismaMock.ticket.groupBy.mockResolvedValue([]);
    atWork.mockReturnValue({ atWork: true, reason: 'at_work' });
  });

  test('contextFor snapshots the level in the subcategory', async () => {
    const ctx = await escalationService.contextFor({ workspaceId: 1, ticketId: 601, technicianId: 7, technicianName: 'Alex Doe' });
    expect(ctx).toMatchObject({ fromTechId: 7, level: 'intermediate', rank: 2, categoryName: 'Networking', subcategoryName: 'VPN', scope: 'Networking / VPN' });
  });

  test('a pick at the same level is swapped for the more advanced person at work (Eli: advanced via the category)', async () => {
    const out = await escalationService.guard({ workspaceId: 1, ticketId: 601, recommendation, escalation: ESC });
    expect(out).toMatchObject({ outcome: 'swapped', techId: 6 });
    expect(out.recommendations[0]).toMatchObject({ techId: 6, rank: 1 });
    expect(out.record).toMatchObject({ outcome: 'swapped', aiPickTechId: 5, chosenTechId: 6, chosenLevel: 'advanced', fromLevel: 'intermediate' });
    expect(out.step).toMatchObject({ stepName: 'escalation_guard', output: { kind: 'escalation_guard' } });
  });

  test('away people, people without a FreshService seat and the escalating person are never chosen', async () => {
    atWork.mockImplementation((tech) => (tech.id === 6 ? { atWork: false, reason: 'on_leave' } : { atWork: true }));
    const out = await escalationService.guard({ workspaceId: 1, ticketId: 601, recommendation, escalation: ESC });
    // Eli away, Kim local on an FS-born ticket -> Sam (expert, at work).
    expect(out).toMatchObject({ outcome: 'swapped', techId: 9, techName: 'Sam Lee' });
    const considered = Object.fromEntries(out.record.considered.map((c) => [c.techId, c.why]));
    expect(considered[6]).toBe('on_leave');
    expect(considered[8]).toBe('no FreshService seat');
  });

  test('nobody more advanced at work: suggestion only, the AI pick kept', async () => {
    atWork.mockImplementation((tech) => (tech.id === 5 ? { atWork: true } : { atWork: false, reason: 'off_shift' }));
    const out = await escalationService.guard({ workspaceId: 1, ticketId: 601, recommendation, escalation: ESC });
    expect(out).toMatchObject({ outcome: 'none_higher', techId: 5 });
    expect(out.record.suggestionOnly).toBe(true);
    expect(out.recommendations[0]).toMatchObject({ techId: 5 });
  });

  test('no category on the snapshot nor on the AI\'s answer: the pick stands and says so', async () => {
    const out = await escalationService.guard({
      workspaceId: 1, ticketId: 601, recommendation, escalation: { ...ESC, categoryId: null, subcategoryId: null, scope: null },
    });
    expect(out).toMatchObject({ outcome: 'no_category', techId: 5 });
    expect(prismaMock.technician.findMany).not.toHaveBeenCalled();
  });

  test('a snapshot without a category uses the AI\'s category and re-reads the level there', async () => {
    const out = await escalationService.guard({
      workspaceId: 1,
      ticketId: 601,
      recommendation: { ...recommendation, internalCategoryId: 40, internalSubcategoryId: 41 },
      escalation: { ...ESC, categoryId: null, subcategoryId: null, scope: null, rank: 0 },
    });
    expect(out).toMatchObject({ outcome: 'swapped', techId: 6 });
    expect(out.record).toMatchObject({ fromLevel: 'intermediate', scope: 'Networking / VPN' });
  });

  test('a sandbox workspace or an empty list: nothing to do', async () => {
    expect(await escalationService.guard({ workspaceId: 7, ticketId: 601, recommendation, escalation: ESC })).toBeNull();
    expect(await escalationService.guard({ workspaceId: 1, ticketId: 601, recommendation: { recommendations: [] }, escalation: ESC })).toBeNull();
  });

  test('a read that blows up never throws out of the guard', async () => {
    prismaMock.technician.findMany.mockRejectedValue(new Error('db down'));
    const out = await escalationService.guard({ workspaceId: 1, ticketId: 601, recommendation, escalation: ESC });
    // No candidates could be read: nobody is shown to be more advanced.
    expect(out).toMatchObject({ outcome: 'none_higher' });
  });
});
