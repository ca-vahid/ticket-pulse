import { jest } from '@jest/globals';

/**
 * Auto-help P0: the playbook matcher (category / subcategory / keywords /
 * exclusions / priority), the shadow mode lock, follow-up defaults and the
 * version bump on change.
 */
const prismaMock = {
  autoHelpPlaybook: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  autoHelpRun: { groupBy: jest.fn(), findMany: jest.fn(async () => []) },
  autoHelpSettings: { findUnique: jest.fn(), upsert: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const {
  default: service,
  matchPlaybook,
  explainMatch,
  normalizePlaybookInput,
  normalizeFollowUp,
  DEFAULT_FOLLOW_UP,
  DEFAULT_DISCLOSURE_TEXT,
  AUTO_MODE_LOCKED_MESSAGE,
  APPROVE_OFF_MESSAGE,
  SENSITIVE_AUTO_MESSAGE,
  renderNudgeText,
  playbookView,
} = await import('../src/services/autoHelpPlaybookService.js');

const ticket = (over = {}) => ({
  id: 1, internalCategoryId: 10, internalSubcategoryId: 101,
  subject: 'Please install Bluebeam', descriptionText: 'I need Bluebeam Revu on my laptop', ...over,
});
const pb = (over = {}) => ({
  id: 1, name: 'Installs', enabled: true, categoryId: 10, subcategoryIds: [], match: {}, priority: 100, ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('matchPlaybook', () => {
  test('category must be equal', () => {
    expect(matchPlaybook(ticket(), [pb({ categoryId: 11 })])).toBeNull();
    expect(matchPlaybook(ticket(), [pb()])?.id).toBe(1);
  });

  test('disabled playbooks and playbooks without a category never match', () => {
    expect(matchPlaybook(ticket(), [pb({ enabled: false })])).toBeNull();
    expect(matchPlaybook(ticket(), [pb({ categoryId: null })])).toBeNull();
  });

  test('subcategory must be listed unless the list is empty', () => {
    expect(matchPlaybook(ticket(), [pb({ subcategoryIds: [102] })])).toBeNull();
    expect(matchPlaybook(ticket(), [pb({ subcategoryIds: [101, 102] })])?.id).toBe(1);
    expect(matchPlaybook(ticket({ internalSubcategoryId: null }), [pb({ subcategoryIds: [] })])?.id).toBe(1);
  });

  test('keywords are any-of over subject + description, case-insensitive', () => {
    expect(matchPlaybook(ticket(), [pb({ match: { keywords: ['uninstall', 'LAPTOP'] } })])?.id).toBe(1);
    expect(matchPlaybook(ticket(), [pb({ match: { keywords: ['printer'] } })])).toBeNull();
  });

  test('exclude keywords are none-of', () => {
    const out = explainMatch(pb({ match: { excludeKeywords: ['licence', 'bluebeam'] } }), ticket());
    expect(out).toEqual({ matches: false, reason: 'Excluded word "bluebeam" appears' });
  });

  test('keywords hear common word forms: "install" matches "installed" (QA 09-25), never a different word', () => {
    const t = ticket({ subject: 'Can I please get the BGC template app installed', descriptionText: '' });
    expect(explainMatch(pb({ match: { keywords: ['install'] } }), t).matches).toBe(true);
    expect(explainMatch(pb({ match: { keywords: ['app'] } }), ticket({ subject: 'Approval needed', descriptionText: '' })).matches).toBe(false);
  });

  test('a legal disclaimer under the signature never trips an exclude word (QA 09-25)', () => {
    const t = ticket({
      descriptionText: 'Hello!\nI am looking for assistance installing Bluebeam.\n\nAshley\nGeologist\n\nPrivacy Policy - The information transmitted herein is confidential. If you received this in error, please notify the sender.',
    });
    expect(explainMatch(pb({ match: { keywords: ['install', 'installing'], excludeKeywords: ['error', 'crash'] } }), t)).toEqual({ matches: true, reason: 'Matches' });
    // A real error in the request still excludes.
    const real = ticket({ descriptionText: 'Bluebeam shows an error on start.\n\nIf you have received this message in error, delete it.' });
    expect(explainMatch(pb({ match: { excludeKeywords: ['error'] } }), real).matches).toBe(false);
  });

  test('highest priority wins; ties go to the lower id', () => {
    const list = [pb({ id: 3, priority: 100 }), pb({ id: 2, priority: 150 }), pb({ id: 1, priority: 150 })];
    expect(matchPlaybook(ticket(), list).id).toBe(1);
    expect(matchPlaybook(ticket(), [pb({ id: 5, priority: 10 }), pb({ id: 6, priority: 20 })]).id).toBe(6);
  });

  test('keywords match whole words only: "app" never matches "approval"', () => {
    const t = ticket({ subject: 'Approval needed for new laptop', descriptionText: 'Please approve' });
    expect(explainMatch(pb({ match: { keywords: ['app'] } }), t).matches).toBe(false);
    expect(explainMatch(pb({ match: { keywords: ['app'] } }), ticket({ subject: 'The App crashed' })).matches).toBe(true);
    expect(explainMatch(pb({ match: { excludeKeywords: ['app'] } }), t).matches).toBe(true);
    expect(explainMatch(pb({ match: { keywords: ['c++', 'company portal'] } }), ticket({ subject: 'Open company  portal' })).matches).toBe(true);
  });

  test('explainMatch can ignore the enabled switch (test runs)', () => {
    expect(explainMatch(pb({ enabled: false }), ticket(), { ignoreEnabled: true }).matches).toBe(true);
  });
});

describe('normalizePlaybookInput', () => {
  test('mode defaults to shadow and is only shape-checked here (P1: the service enforces the rules)', () => {
    expect(normalizePlaybookInput({ name: 'x' }).mode).toBe('shadow');
    expect(normalizePlaybookInput({ name: 'x', mode: 'approve' }).mode).toBe('approve');
    expect(normalizePlaybookInput({ name: 'x', mode: 'auto' }).mode).toBe('auto');
    expect(() => normalizePlaybookInput({ name: 'x', mode: 'yolo' })).toThrow(/mode must be one of/);
    expect(normalizePlaybookInput({ name: 'x', sensitive: true }).sensitive).toBe(true);
    // A partial update without a mode leaves the mode alone.
    expect(normalizePlaybookInput({ enabled: true, categoryId: 10 }, { partial: true }).mode).toBeUndefined();
  });

  test('follow-up defaults: 2 + 2 business days, resolve on silence', () => {
    const out = normalizePlaybookInput({ name: 'x' });
    expect(out.followUp).toEqual(DEFAULT_FOLLOW_UP);
    expect(normalizeFollowUp({ nudgeAfterBusinessDays: 5, onSilence: 'leave_open' })).toMatchObject({
      nudgeAfterBusinessDays: 5, closeAfterBusinessDays: 2, onSilence: 'leave_open',
    });
  });

  test('instructionsAreSource is an explicit opt-in, default off', () => {
    expect(normalizePlaybookInput({ name: 'x' }).instructionsAreSource).toBe(false);
    expect(normalizePlaybookInput({ name: 'x', instructionsAreSource: 'yes' }).instructionsAreSource).toBe(false);
    expect(normalizePlaybookInput({ name: 'x', instructionsAreSource: true }).instructionsAreSource).toBe(true);
    expect(playbookView({ id: 1 }).instructionsAreSource).toBe(false);
  });

  test('the default check-in text renders {{days}} from closeAfterBusinessDays', () => {
    expect(DEFAULT_FOLLOW_UP.nudgeText).toContain('{{days}}');
    expect(renderNudgeText({ closeAfterBusinessDays: 3 })).toContain('close this ticket in 3 business days');
    expect(renderNudgeText({ closeAfterBusinessDays: 1 })).toContain('in 1 business day ');
  });

  test('unknown tools are dropped; enabling needs a category', () => {
    expect(normalizePlaybookInput({ name: 'x', allowedTools: ['search_knowledge', 'send_email'] }).allowedTools).toEqual(['search_knowledge']);
    expect(() => normalizePlaybookInput({ name: 'x', enabled: true })).toThrow(/category/);
  });
});

describe('service', () => {
  test('update bumps the version only when a versioned field changes', async () => {
    const row = { id: 4, workspaceId: 1, name: 'A', enabled: false, mode: 'shadow', categoryId: 10, subcategoryIds: [], match: { keywords: [], excludeKeywords: [] }, instructions: 'x', allowedTools: [], kbScope: null, minConfidence: 0.8, followUp: null, onHelp: 'assign_normally', priority: 100, version: 3 };
    prismaMock.autoHelpPlaybook.findFirst.mockResolvedValue(row);
    prismaMock.autoHelpPlaybook.update.mockImplementation(async ({ data }) => ({ ...row, ...data }));

    await service.update(1, 4, { instructions: 'new words' }, { email: 'a@x' });
    expect(prismaMock.autoHelpPlaybook.update.mock.calls[0][0].data.version).toBe(4);

    await service.update(1, 4, { enabled: true }, { email: 'a@x' });
    expect(prismaMock.autoHelpPlaybook.update.mock.calls[1][0].data.version).toBeUndefined();
  });

  test('settings default: off, disclosure on with the default wording', async () => {
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue(null);
    const s = await service.getSettings(1);
    expect(s).toMatchObject({ enabled: false, disclosureEnabled: true, disclosureText: DEFAULT_DISCLOSURE_TEXT, mode: 'shadow' });
  });

  test('settings: modes are per playbook, and auto cannot be switched on from the API', async () => {
    await expect(service.updateSettings(1, { mode: 'auto' })).rejects.toThrow(/per playbook/);
    await expect(service.updateSettings(1, { autoModeAllowed: true })).rejects.toThrow(AUTO_MODE_LOCKED_MESSAGE);
    expect(prismaMock.autoHelpSettings.upsert).not.toHaveBeenCalled();
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue(null);
    const s = await service.getSettings(1);
    expect(s).toMatchObject({ approveModeEnabled: false, monthlyCostCapUsd: null, thankOnConfirm: false, autoModeAllowed: false, autoModeLockedMessage: AUTO_MODE_LOCKED_MESSAGE });
  });

  test('settings: approve switch, cost cap (validated, rounded) and thank-you are saved', async () => {
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, enabled: true, approveModeEnabled: true, monthlyCostCapUsd: 25.5, thankOnConfirm: true });
    await service.updateSettings(1, { approveModeEnabled: true, monthlyCostCapUsd: '25.499', thankOnConfirm: true }, { email: 'a@x' });
    expect(prismaMock.autoHelpSettings.upsert.mock.calls[0][0].update).toMatchObject({ approveModeEnabled: true, monthlyCostCapUsd: 25.5, thankOnConfirm: true });
    await service.updateSettings(1, { monthlyCostCapUsd: '' });
    expect(prismaMock.autoHelpSettings.upsert.mock.calls[1][0].update.monthlyCostCapUsd).toBeNull();
    await expect(service.updateSettings(1, { monthlyCostCapUsd: -1 })).rejects.toThrow(/cost cap/);
  });
});

describe('mode rules (P1)', () => {
  const row = { id: 4, workspaceId: 1, name: 'A', enabled: false, mode: 'shadow', sensitive: false, categoryId: 10, subcategoryIds: [], match: null, instructions: 'x', allowedTools: [], kbScope: null, minConfidence: 0.8, followUp: null, onHelp: 'assign_normally', priority: 100, version: 1 };
  beforeEach(() => {
    prismaMock.autoHelpPlaybook.findFirst.mockResolvedValue(row);
    prismaMock.autoHelpPlaybook.update.mockImplementation(async ({ data }) => ({ ...row, ...data }));
    prismaMock.autoHelpPlaybook.create.mockImplementation(async ({ data }) => ({ id: 9, ...data }));
  });

  test('approve needs the workspace approve switch', async () => {
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, enabled: true, approveModeEnabled: false });
    await expect(service.update(1, 4, { mode: 'approve' })).rejects.toThrow(APPROVE_OFF_MESSAGE);
    await expect(service.create(1, { name: 'B', mode: 'approve' })).rejects.toThrow(APPROVE_OFF_MESSAGE);
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, enabled: true, approveModeEnabled: true });
    const saved = await service.update(1, 4, { mode: 'approve' });
    expect(saved.mode).toBe('approve');
  });

  test('auto is refused in this build even when everything else is fine', async () => {
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, enabled: true, approveModeEnabled: true });
    await expect(service.update(1, 4, { mode: 'auto' })).rejects.toThrow(AUTO_MODE_LOCKED_MESSAGE);
    expect(prismaMock.autoHelpPlaybook.update).not.toHaveBeenCalled();
  });

  test('sensitive blocks auto first, and a sensitive playbook can never sit in auto', async () => {
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, enabled: true, approveModeEnabled: true });
    await expect(service.update(1, 4, { mode: 'auto', sensitive: true })).rejects.toThrow(SENSITIVE_AUTO_MESSAGE);
    prismaMock.autoHelpPlaybook.findFirst.mockResolvedValue({ ...row, mode: 'auto' });
    await expect(service.update(1, 4, { sensitive: true })).rejects.toThrow(SENSITIVE_AUTO_MESSAGE);
  });

  test('with the build switch stubbed on, auto still needs the readiness gate', async () => {
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, enabled: true, approveModeEnabled: true });
    const spy = jest.spyOn(service, 'autoModeAllowed').mockReturnValue(true);
    try {
      prismaMock.autoHelpRun.findMany.mockResolvedValue([]);
      await expect(service.update(1, 4, { mode: 'auto' })).rejects.toMatchObject({ code: 'auto_help_not_ready' });
      // 30 good reviews, 20 unchanged approve sends, no reopen → met.
      const at = (i) => new Date(Date.UTC(2026, 8, 1, 0, i));
      prismaMock.autoHelpRun.findMany.mockResolvedValue([
        // Evidence of the playbook's CURRENT version from real (categorized) runs.
        ...Array.from({ length: 30 }, (_, i) => ({ reviewVerdict: 'good', reviewedAt: at(i), decision: null, outcome: null, trigger: 'categorized', playbookVersion: row.version ?? 1 })),
        ...Array.from({ length: 20 }, () => ({ reviewVerdict: null, reviewedAt: null, decision: 'agent_sent', outcome: 'resolved_silence', trigger: 'categorized', playbookVersion: row.version ?? 1 })),
      ]);
      const saved = await service.update(1, 4, { mode: 'auto' });
      expect(saved.mode).toBe('auto');
      // The runtime mode follows the same rules; sensitive falls back to approve.
      expect(await service.effectiveMode(1, { ...row, mode: 'auto' })).toBe('auto');
      expect(await service.effectiveMode(1, { ...row, mode: 'auto', sensitive: true })).toBe('approve');
    } finally {
      spy.mockRestore();
    }
  });

  test('effective mode: approve switch off → shadow; auto locked → approve', async () => {
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, enabled: true, approveModeEnabled: false });
    expect(await service.effectiveMode(1, { ...row, mode: 'approve' })).toBe('shadow');
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, enabled: true, approveModeEnabled: true });
    expect(await service.effectiveMode(1, { ...row, mode: 'approve' })).toBe('approve');
    expect(await service.effectiveMode(1, { ...row, mode: 'auto' })).toBe('approve');
    expect(await service.effectiveMode(1, { ...row, mode: 'shadow' })).toBe('shadow');
  });
});

describe('enabled_at + the cached switch (audit, 26 Sep 2026)', () => {
  test('switching Auto-help ON stamps enabledAt; saving other settings (or re-saving on) does not move it', async () => {
    service._enabledCache.clear();
    prismaMock.autoHelpSettings.upsert.mockClear();
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, enabled: false });
    await service.updateSettings(1, { enabled: true });
    expect(prismaMock.autoHelpSettings.upsert.mock.calls[0][0].update.enabledAt).toBeInstanceOf(Date);
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, enabled: true, enabledAt: new Date('2026-09-20T00:00:00Z') });
    await service.updateSettings(1, { enabled: true });
    await service.updateSettings(1, { thankOnConfirm: true });
    expect(prismaMock.autoHelpSettings.upsert.mock.calls[1][0].update).not.toHaveProperty('enabledAt');
    expect(prismaMock.autoHelpSettings.upsert.mock.calls[2][0].update).not.toHaveProperty('enabledAt');
  });

  test('enabledState is cached for 60 s and dropped when the settings change', async () => {
    service._enabledCache.clear();
    prismaMock.autoHelpSettings.findUnique.mockClear();
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, enabled: true, enabledAt: new Date('2026-09-20T00:00:00Z') });
    const t0 = Date.now();
    expect(await service.enabledState(1, { now: t0 })).toMatchObject({ enabled: true });
    await service.enabledState(1, { now: t0 + 59e3 });
    expect(prismaMock.autoHelpSettings.findUnique).toHaveBeenCalledTimes(1);
    await service.enabledState(1, { now: t0 + 61e3 });
    expect(prismaMock.autoHelpSettings.findUnique).toHaveBeenCalledTimes(2);
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, enabled: false, enabledAt: new Date('2026-09-20T00:00:00Z') });
    await service.updateSettings(1, { enabled: false });
    expect(await service.enabledState(1, { now: t0 + 62e3 })).toMatchObject({ enabled: false });
  });
});

describe('Knowledge v2: scope, then let the AI judge (28 Sep 2026)', () => {
  test('normalizeMatch: whenToHelp trimmed + capped; useWords explicit, else inferred from legacy words', async () => {
    const { normalizeMatch, MAX_WHEN_TO_HELP } = await import('../src/services/autoHelpPlaybookService.js');
    expect(normalizeMatch({})).toEqual({ keywords: [], excludeKeywords: [], whenToHelp: '', useWords: false });
    expect(normalizeMatch({ keywords: ['install'] }).useWords).toBe(true);
    expect(normalizeMatch({ excludeKeywords: ['mac'] }).useWords).toBe(true);
    expect(normalizeMatch({ keywords: ['install'], useWords: false }).useWords).toBe(false);
    expect(normalizeMatch({ useWords: true }).useWords).toBe(true);
    expect(normalizeMatch({ whenToHelp: '  Software   installs\n and updates  ' }).whenToHelp).toBe('Software installs and updates');
    expect(normalizeMatch({ whenToHelp: 'x'.repeat(900) }).whenToHelp).toHaveLength(MAX_WHEN_TO_HELP);
    expect(playbookView(pb({ match: { whenToHelp: 'Installs', useWords: false } })).match).toMatchObject({ whenToHelp: 'Installs', useWords: false });
  });

  test('useWords false: scope only (category + subcategories), words ignored', () => {
    const p = pb({ subcategoryIds: [101], match: { keywords: ['printer'], excludeKeywords: ['bluebeam'], useWords: false } });
    expect(explainMatch(p, ticket())).toEqual({ matches: true, reason: 'Matches' });
    expect(explainMatch(p, ticket({ internalSubcategoryId: 102 })).matches).toBe(false);
    expect(explainMatch(p, ticket({ internalCategoryId: 11 })).matches).toBe(false);
  });

  test('legacy rows (words, no useWords) keep their word gate', () => {
    expect(explainMatch(pb({ match: { keywords: ['printer'] } }), ticket()).matches).toBe(false);
  });

  test('word rules hear spelling variants and one typo when they apply', () => {
    const lic = pb({ match: { keywords: ['bluebeam'], excludeKeywords: ['licence'] } });
    expect(explainMatch(lic, ticket({ subject: 'Bluebeam license expired' }))).toEqual({ matches: false, reason: 'Excluded word "licence" appears' });
    const gm = pb({ match: { keywords: ['global'] } });
    expect(explainMatch(gm, ticket({ subject: 'Globbal Mapper Update', descriptionText: '' })).matches).toBe(true);
    const setup = pb({ match: { keywords: ['setup'] } });
    expect(explainMatch(setup, ticket({ subject: 'Please set up my new laptop', descriptionText: '' })).matches).toBe(true);
  });

  test('previewMatch: draft vs saved on 30 days of tickets, examples capped, no AI fit check', async () => {
    const saved = pb({ id: 7, match: { keywords: ['bluebeam'] } });
    prismaMock.autoHelpPlaybook.findFirst.mockResolvedValue(saved);
    prismaMock.ticket = {
      findMany: jest.fn(async () => [
        { id: 1, origin: 'freshservice', freshserviceTicketId: 501, internalCategoryId: 10, internalSubcategoryId: 101, subject: 'Bluebeam please', descriptionText: '' },
        { id: 2, origin: 'ticketpulse', nativeNumber: 12, internalCategoryId: 10, internalSubcategoryId: 101, subject: 'Leapfrog Viewer', descriptionText: '' },
        { id: 3, origin: 'ticketpulse', nativeNumber: 13, internalCategoryId: 10, internalSubcategoryId: 102, subject: 'RocScience', descriptionText: '' },
        { id: 4, origin: 'ticketpulse', nativeNumber: 14, internalCategoryId: 11, internalSubcategoryId: 111, subject: 'Other category', descriptionText: '' },
      ]),
    };
    const now = Date.parse('2026-09-28T12:00:00Z');
    const out = await service.previewMatch(1, { id: 7, draft: { match: { whenToHelp: 'Software installs', useWords: false }, subcategoryIds: [101] }, now });
    expect(out).toMatchObject({ days: 30, aiFitCheckNotRun: true, inScope: 2, draftTakes: 2, savedTakes: 1, scanned: 4, capped: false });
    expect(out.gained).toEqual([{ id: 2, ref: 'TP-12', subject: 'Leapfrog Viewer' }]);
    expect(out.lost).toEqual([]);
    const args = prismaMock.ticket.findMany.mock.calls.at(-1)[0];
    expect(args.where).toMatchObject({ workspaceId: 1, isNoise: false, internalCategoryId: { in: [10] } });
    expect(args.where.createdAt.gte.toISOString()).toBe('2026-08-29T12:00:00.000Z');
    expect(args.take).toBe(4000);
    expect(Object.keys(args.select).sort()).toEqual(['descriptionText', 'freshserviceTicketId', 'id', 'internalCategoryId', 'internalSubcategoryId', 'nativeNumber', 'origin', 'subject']);

    // Switching a draft on without a category never throws in a preview.
    await expect(service.previewMatch(1, { id: 7, draft: { enabled: true, subcategoryIds: [] }, now })).resolves.toMatchObject({ aiFitCheckNotRun: true });

    // A new, unsaved playbook: nothing saved to compare with.
    const fresh = await service.previewMatch(1, { draft: { categoryId: 10, match: { keywords: ['bluebeam'] } }, now });
    expect(fresh).toMatchObject({ draftTakes: 1, savedTakes: 0, inScope: 3 });
    expect(fresh.gained.map((g) => g.id)).toEqual([1]);

    // No category anywhere: no ticket read.
    prismaMock.ticket.findMany.mockClear();
    expect(await service.previewMatch(1, { draft: {}, now })).toMatchObject({ inScope: 0, draftTakes: 0 });
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
    delete prismaMock.ticket;
  });

  test('list: summary per playbook from one article read (no N+1)', async () => {
    prismaMock.autoHelpPlaybook.findMany.mockResolvedValue([
      pb({ id: 1, subcategoryIds: [101, 102], stayQuietWhen: ['Macs'], match: { whenToHelp: 'Installs' } }),
      pb({ id: 2, categoryId: 20 }),
    ]);
    prismaMock.autoHelpRun.groupBy.mockResolvedValue([]);
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, alwaysStayQuietWhen: ['a', 'b', 'c'] });
    prismaMock.knowledgeArticle = {
      findMany: jest.fn(async () => [{ id: 5, title: 'Installing', categoryId: 10 }, { id: 6, title: 'Licences', categoryId: 10 }]),
      count: jest.fn(async () => 9),
    };
    const rows = await service.list(1);
    expect(prismaMock.knowledgeArticle.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.knowledgeArticle.findMany.mock.calls[0][0].where).toEqual({ workspaceId: 1, status: 'published', categoryId: { in: [10, 20] } });
    expect(rows[0].summary).toEqual({
      subcategoryCount: 2, whenToHelp: 'Installs', useWords: false, stayQuietCount: 1, workspaceRuleCount: 3,
      articles: [{ id: 5, title: 'Installing' }, { id: 6, title: 'Licences' }], articleCount: 2, articleTotalPublished: 9,
    });
    expect(rows[1].summary).toMatchObject({ articles: [], articleCount: 0, articleTotalPublished: 9 });
    delete prismaMock.knowledgeArticle;
  });

  test('summary degrades when articles cannot be read', async () => {
    prismaMock.autoHelpPlaybook.findFirst.mockResolvedValue(pb({ id: 3 }));
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue(null);
    const view = await service.getWithSummary(1, 3);
    expect(view.summary).toMatchObject({ articles: [], articleTotalPublished: 0, workspaceRuleCount: 3 });
  });
});
