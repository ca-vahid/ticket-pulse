import { jest } from '@jest/globals';

/**
 * The dial (plans/KNOWLEDGE_SIMPLIFY_PLAN.md sections 5 and 6): inheritance,
 * the confidence band from observable evidence, "down the dial, never up",
 * and "Send when sure" as something a category earns.
 */
const prismaMock = {
  knowledgeCategoryPolicy: { findMany: jest.fn(), upsert: jest.fn() },
  competencyCategory: { findMany: jest.fn(), findFirst: jest.fn() },
  knowledgeArticle: { groupBy: jest.fn() },
  autoHelpRun: { findMany: jest.fn(), groupBy: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const {
  default: service, resolvePolicy, confidenceBand, decideAction, applyBand, stepDown, normalizePolicyInput,
  LEVELS, DEFAULT_BAR, STRONG_MATCH_SCORE, SEND_LOCKED_MESSAGE, SEND_ALWAYS_CHECKED_MESSAGE,
} = await import('../src/services/knowledgeAnswerPolicy.js');

const row = (categoryId, over = {}) => ({ workspaceId: 1, categoryId, dayLevel: null, nightLevel: null, bar: null, alwaysChecked: null, notes: null, stayQuietWhen: [], ...over });
const SURE = {
  sufficient: 'yes', droppedSteps: 0, gateDecision: 'shadow_recorded', modelConfidence: 0.92, bar: 0.85,
  citedArticles: [{ id: 12, score: 0.7, stale: false, checked: true }], citedTickets: 0, triage: 'yes', researchOnly: false,
};
const reviewed = (n, verdict = 'good') => Array.from({ length: n }, (_, i) => ({
  reviewVerdict: verdict, reviewedAt: new Date(Date.UTC(2026, 9, 1, 0, i)), decision: null, outcome: null, trigger: 'categorized', playbookVersion: 1,
}));
const sends = (n) => Array.from({ length: n }, () => ({ reviewVerdict: null, reviewedAt: null, decision: 'agent_sent', outcome: 'resolved_silence', trigger: 'categorized', playbookVersion: 3 }));

beforeEach(() => {
  jest.clearAllMocks();
  service.clearCache();
  prismaMock.knowledgeCategoryPolicy.findMany.mockResolvedValue([]);
  prismaMock.knowledgeCategoryPolicy.upsert.mockResolvedValue({});
  prismaMock.competencyCategory.findMany.mockResolvedValue([
    { id: 10, name: 'Software & Apps', parentId: null, sortOrder: 0 },
    { id: 101, name: 'OpenGround', parentId: 10, sortOrder: 0 },
    { id: 20, name: 'Account & Access', parentId: null, sortOrder: 1 },
  ]);
  prismaMock.competencyCategory.findFirst.mockImplementation(async ({ where }) => ({ 10: { id: 10, parentId: null }, 101: { id: 101, parentId: 10 }, 20: { id: 20, parentId: null } }[where.id] || null));
  prismaMock.knowledgeArticle.groupBy.mockResolvedValue([{ categoryId: 10, _count: 5 }]);
  prismaMock.autoHelpRun.groupBy.mockResolvedValue([{ categoryId: 10, status: 'drafted', _count: 4 }, { categoryId: 10, status: 'no_match', _count: 6 }]);
  prismaMock.autoHelpRun.findMany.mockResolvedValue([]);
});

describe('resolvePolicy', () => {
  test('nothing set anywhere: draft by day and by night, the built-in bar, not always checked', () => {
    expect(resolvePolicy([], { categoryId: 10, subcategoryId: 101 })).toMatchObject({
      dayLevel: 'draft', nightLevel: 'draft', bar: DEFAULT_BAR, alwaysChecked: false, notes: [], stayQuietWhen: [],
      from: { dayLevel: 'builtin', nightLevel: 'builtin' },
    });
  });

  test('each field comes from the nearest row that sets it', () => {
    const rows = [
      row(0, { dayLevel: 'draft', nightLevel: 'off', bar: 0.8 }),
      row(10, { dayLevel: 'suggest' }),
      row(101, { nightLevel: 'suggest', alwaysChecked: true }),
    ];
    expect(resolvePolicy(rows, { categoryId: 10, subcategoryId: 101 })).toMatchObject({
      dayLevel: 'suggest', nightLevel: 'suggest', bar: 0.8, alwaysChecked: true,
      from: { dayLevel: 'category', nightLevel: 'subcategory', bar: 'default', alwaysChecked: 'subcategory' },
    });
    // Another subcategory of the same category does not see 101's row.
    expect(resolvePolicy(rows, { categoryId: 10, subcategoryId: 102 })).toMatchObject({ dayLevel: 'suggest', nightLevel: 'off', alwaysChecked: false });
    // A category with no row falls to the workspace default.
    expect(resolvePolicy(rows, { categoryId: 20 })).toMatchObject({ dayLevel: 'draft', nightLevel: 'off' });
    // An uncategorised ticket too.
    expect(resolvePolicy(rows, {})).toMatchObject({ dayLevel: 'draft', nightLevel: 'off' });
  });

  test('notes and stay-quiet rules add up from the general to the specific, without repeats', () => {
    const rows = [
      row(0, { notes: 'Keep it short.', stayQuietWhen: ['Anything about pay'] }),
      row(10, { notes: 'Use app names as Company Portal spells them.', stayQuietWhen: ['anything about pay', 'A licence server address is asked for'] }),
      row(101, { notes: '  ' }),
    ];
    const p = resolvePolicy(rows, { categoryId: 10, subcategoryId: 101 });
    expect(p.notes).toEqual(['Keep it short.', 'Use app names as Company Portal spells them.']);
    expect(p.stayQuietWhen).toEqual(['Anything about pay', 'A licence server address is asked for']);
  });

  test('a junk level in a row reads as draft, never as something stronger', () => {
    expect(resolvePolicy([row(10, { dayLevel: 'AUTO', nightLevel: 'everything' })], { categoryId: 10 })).toMatchObject({ dayLevel: 'draft', nightLevel: 'draft' });
  });
});

describe('confidenceBand', () => {
  test('every signal good: high', () => {
    expect(confidenceBand(SURE)).toEqual({ band: 'high', misses: [] });
  });

  test('one miss is medium, two are low', () => {
    expect(confidenceBand({ ...SURE, modelConfidence: 0.8 }).band).toBe('medium');
    expect(confidenceBand({ ...SURE, triage: 'unclear' })).toMatchObject({ band: 'medium', misses: [{ key: 'triage_unclear' }] });
    expect(confidenceBand({ ...SURE, modelConfidence: 0.8, triage: 'unclear' }).band).toBe('low');
  });

  test('the model\'s own score alone never makes an answer sure', () => {
    const judged = confidenceBand({ ...SURE, modelConfidence: 0.99, citedArticles: [{ id: 12, score: STRONG_MATCH_SCORE - 0.1, stale: false, checked: false }] });
    expect(judged.band).toBe('low');
    expect(judged.misses.map((m) => m.key)).toEqual(['weak_match', 'not_checked']);
  });

  test('partial answers, review-overdue articles and answers from solved tickets only each count', () => {
    expect(confidenceBand({ ...SURE, sufficient: 'partial' }).misses.map((m) => m.key)).toEqual(['partial']);
    expect(confidenceBand({ ...SURE, droppedSteps: 1 }).misses.map((m) => m.key)).toEqual(['partial']);
    expect(confidenceBand({ ...SURE, citedArticles: [{ id: 1, score: 0.9, stale: true, checked: true }] }).misses.map((m) => m.key)).toEqual(['review_overdue']);
    expect(confidenceBand({ ...SURE, citedArticles: [], citedTickets: 2 }).misses.map((m) => m.key)).toEqual(['no_article']);
    expect(confidenceBand({ ...SURE, researchOnly: true }).misses.map((m) => m.key)).toEqual(['research_only']);
    expect(confidenceBand({ ...SURE, stayQuietConfirmedTwice: false }).misses.map((m) => m.key)).toEqual(['stay_quiet_once']);
    expect(confidenceBand({ ...SURE, stayQuietConfirmedTwice: true }).band).toBe('high');
  });

  test('a missing confidence is under the bar; an answer from the playbook\'s own words is always low', () => {
    expect(confidenceBand({ ...SURE, modelConfidence: null }).misses.map((m) => m.key)).toEqual(['below_bar']);
    expect(confidenceBand({ ...SURE, gateDecision: 'playbook_only' }).band).toBe('low');
    expect(confidenceBand({}).band).toBe('low');
  });
});

describe('down the dial, never up', () => {
  test('stepDown and applyBand', () => {
    expect(LEVELS).toEqual(['off', 'draft', 'suggest', 'send']);
    expect(['send', 'suggest', 'draft', 'off'].map(stepDown)).toEqual(['suggest', 'draft', 'draft', 'off']);
    expect(applyBand('send', 'high')).toBe('send');
    expect(applyBand('send', 'medium')).toBe('suggest');
    expect(applyBand('send', 'low')).toBe('draft');
    expect(applyBand('suggest', 'medium')).toBe('draft');
    expect(applyBand('draft', 'high')).toBe('draft');
    expect(applyBand('off', 'high')).toBe('off');
    expect(applyBand('nonsense', 'high')).toBe('draft');
  });

  test('decideAction: day and night levels, and the three locks on sending', () => {
    const policy = { dayLevel: 'suggest', nightLevel: 'send', bar: 0.85, alwaysChecked: false };
    expect(decideAction({ policy, afterHours: false, band: 'high', ready: true, eligible: true })).toMatchObject({ level: 'suggest', mode: 'approve', ceiling: 'suggest' });
    expect(decideAction({ policy, afterHours: true, band: 'high', ready: true, eligible: true })).toMatchObject({ level: 'send', mode: 'auto', ceiling: 'send', reason: 'as_set' });
    expect(decideAction({ policy, afterHours: true, band: 'medium', ready: true, eligible: true })).toMatchObject({ level: 'suggest', reason: 'one_step_down' });
    expect(decideAction({ policy, afterHours: true, band: 'low', ready: true, eligible: true })).toMatchObject({ level: 'draft', mode: 'shadow', reason: 'recorded_only' });
    // Not earned, not eligible, always checked: suggested to an agent instead.
    expect(decideAction({ policy, afterHours: true, band: 'high', ready: false, eligible: true })).toMatchObject({ level: 'suggest', reason: 'not_earned' });
    expect(decideAction({ policy, afterHours: true, band: 'high', ready: true, eligible: false })).toMatchObject({ level: 'suggest', reason: 'not_eligible' });
    expect(decideAction({ policy: { ...policy, alwaysChecked: true }, afterHours: true, band: 'high', ready: true, eligible: true })).toMatchObject({ level: 'suggest', reason: 'always_checked' });
    expect(decideAction({ policy: { ...policy, dayLevel: 'off' }, afterHours: false, band: 'high' })).toMatchObject({ level: 'off', mode: null });
  });
});

describe('normalizePolicyInput', () => {
  test('null clears a field back to "inherit"; junk is refused', () => {
    expect(normalizePolicyInput({ dayLevel: null, nightLevel: '', bar: null, alwaysChecked: null, notes: '  ' })).toEqual({ dayLevel: null, nightLevel: null, bar: null, alwaysChecked: null, notes: null });
    expect(normalizePolicyInput({ bar: '0.9', stayQuietWhen: [' A ', 'a', '', 'B'] })).toEqual({ bar: 0.9, stayQuietWhen: ['A', 'B'] });
    expect(() => normalizePolicyInput({ dayLevel: 'auto' })).toThrow(/dayLevel must be one of/);
    expect(() => normalizePolicyInput({ bar: 1.2 })).toThrow(/bar must be between/);
    expect(normalizePolicyInput({})).toEqual({});
  });
});

describe('service', () => {
  test('reads fail soft to the built-in default: a broken table can never make Auto-help send', async () => {
    prismaMock.knowledgeCategoryPolicy.findMany.mockRejectedValue(new Error('relation does not exist'));
    expect(await service.resolveForTicket(1, { internalCategoryId: 10 })).toMatchObject({ dayLevel: 'draft', nightLevel: 'draft', alwaysChecked: false });
  });

  test('categoryReadiness counts the category\'s own reviews and sends, never test or backtest runs', async () => {
    prismaMock.autoHelpRun.findMany.mockResolvedValue([
      ...reviewed(30), ...sends(20),
      ...reviewed(40, 'wrong').map((r) => ({ ...r, trigger: 'backtest' })),
    ]);
    const ready = await service.categoryReadiness(1, 10);
    expect(ready.met).toBe(true);
    expect(prismaMock.autoHelpRun.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: 1, categoryId: 10 });
    // Always-checked categories never meet it.
    expect((await service.categoryReadiness(1, 10, { alwaysChecked: true })).met).toBe(false);
    // No category, no evidence.
    expect((await service.categoryReadiness(1, null)).met).toBe(false);
  });

  test('"Send when sure" is refused until the category earned it, and never for the default row or an always-checked category', async () => {
    await expect(service.upsert(1, 0, { nightLevel: 'send' })).rejects.toMatchObject({ code: 'knowledge_send_default' });
    await expect(service.upsert(1, 10, { nightLevel: 'send' })).rejects.toMatchObject({ code: 'knowledge_send_not_earned', message: SEND_LOCKED_MESSAGE });
    prismaMock.knowledgeCategoryPolicy.findMany.mockResolvedValue([row(20, { alwaysChecked: true })]);
    await expect(service.upsert(1, 20, { dayLevel: 'send' })).rejects.toMatchObject({ code: 'knowledge_send_always_checked', message: SEND_ALWAYS_CHECKED_MESSAGE });
    expect(prismaMock.knowledgeCategoryPolicy.upsert).not.toHaveBeenCalled();

    // Earned: saved. A subcategory is judged on its top category's evidence.
    prismaMock.knowledgeCategoryPolicy.findMany.mockResolvedValue([]);
    prismaMock.autoHelpRun.findMany.mockResolvedValue([...reviewed(30), ...sends(20)]);
    await service.upsert(1, 101, { nightLevel: 'send' }, { email: 'admin@example.com' });
    expect(prismaMock.autoHelpRun.findMany.mock.calls.at(-2)[0].where).toMatchObject({ categoryId: 10 });
    expect(prismaMock.knowledgeCategoryPolicy.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_categoryId: { workspaceId: 1, categoryId: 101 } },
      create: expect.objectContaining({ nightLevel: 'send', updatedBy: 'admin@example.com' }),
    }));
  });

  test('marking a category always checked pulls an existing "send" back to "suggest"', async () => {
    prismaMock.knowledgeCategoryPolicy.findMany.mockResolvedValue([row(10, { dayLevel: 'suggest', nightLevel: 'send' })]);
    await service.upsert(1, 10, { alwaysChecked: true });
    expect(prismaMock.knowledgeCategoryPolicy.upsert.mock.calls[0][0].update).toMatchObject({ alwaysChecked: true, nightLevel: 'suggest' });
  });

  test('a category from another workspace is refused', async () => {
    prismaMock.competencyCategory.findFirst.mockResolvedValue(null);
    await expect(service.upsert(1, 999, { dayLevel: 'suggest' })).rejects.toThrow(/Category not found/);
  });

  test('list: the default row, every top category with its own row, the resolved dial, evidence and counts', async () => {
    prismaMock.knowledgeCategoryPolicy.findMany.mockResolvedValue([row(0, { nightLevel: 'off' }), row(10, { dayLevel: 'suggest' }), row(101, { dayLevel: 'draft' })]);
    const out = await service.list(1);
    expect(out.default.resolved).toMatchObject({ dayLevel: 'draft', nightLevel: 'off' });
    expect(out.levels.map((l) => l.label)).toEqual(['Off', 'Draft only', 'Suggest to agent', 'Send when sure']);
    const software = out.categories.find((c) => c.id === 10);
    expect(software).toMatchObject({ name: 'Software & Apps', own: { dayLevel: 'suggest' }, resolved: { dayLevel: 'suggest', nightLevel: 'off' }, articles: 5, runs30: { total: 10, answered: 4 } });
    expect(software.readiness.met).toBe(false);
    expect(software.subcategories[0]).toMatchObject({ id: 101, own: { dayLevel: 'draft' }, resolved: { dayLevel: 'draft', nightLevel: 'off' } });
    expect(out.categories.find((c) => c.id === 20)).toMatchObject({ own: null, resolved: { dayLevel: 'draft', nightLevel: 'off' }, articles: 0 });
  });
});
