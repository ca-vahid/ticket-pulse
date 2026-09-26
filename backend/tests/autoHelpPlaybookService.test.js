import { jest } from '@jest/globals';

/**
 * Auto-help P0: the playbook matcher (category / subcategory / keywords /
 * exclusions / priority), the shadow mode lock, follow-up defaults and the
 * version bump on change.
 */
const prismaMock = {
  autoHelpPlaybook: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  autoHelpRun: { groupBy: jest.fn() },
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
  MODE_LOCKED_MESSAGE,
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
  test('mode is forced to shadow; approve/auto are refused with the P0 message', () => {
    expect(normalizePlaybookInput({ name: 'x' }).mode).toBe('shadow');
    expect(() => normalizePlaybookInput({ name: 'x', mode: 'approve' })).toThrow(MODE_LOCKED_MESSAGE);
    expect(() => normalizePlaybookInput({ name: 'x', mode: 'auto' })).toThrow(MODE_LOCKED_MESSAGE);
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

  test('settings refuse a non-shadow mode', async () => {
    await expect(service.updateSettings(1, { mode: 'auto' })).rejects.toThrow(MODE_LOCKED_MESSAGE);
    expect(prismaMock.autoHelpSettings.upsert).not.toHaveBeenCalled();
  });
});
