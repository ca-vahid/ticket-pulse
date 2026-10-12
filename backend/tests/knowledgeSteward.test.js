import { jest } from '@jest/globals';

/**
 * The nightly Knowledge review (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 9):
 * it reads the library and raises suggestions with evidence; it never edits
 * an article. One broken check never stops the others; a finding is raised
 * once (dedupe key); the model is asked only where agents rewrote answers.
 */
const prismaMock = {
  knowledgeArticle: { findMany: jest.fn() },
  knowledgeSignal: { findMany: jest.fn() },
  knowledgeSuggestion: { findFirst: jest.fn(), create: jest.fn() },
  autoHelpRun: { findMany: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
};
const suggestionMock = { create: jest.fn(), expireOld: jest.fn(async () => 0) };
const settingsMock = { record: jest.fn(async () => null), enabledWorkspaces: jest.fn() };
const gapMock = { gaps: jest.fn() };
const gatewayMock = { sendJson: jest.fn() };
const articleServiceMock = { timesQuoted: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: gatewayMock }));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => false, embedQueryTexts: jest.fn(async () => null),
  cosineSimilarity: (a, b) => { let d = 0; let x = 0; let y = 0; for (let i = 0; i < a.length; i += 1) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return x && y ? d / Math.sqrt(x * y) : 0; },
  nearestVerifiedSolutions: jest.fn(async () => ({ cosById: new Map(), topIds: [] })),
}));
const realArticles = await import('../src/services/knowledgeArticleService.js');
jest.unstable_mockModule('../src/services/knowledgeArticleService.js', () => ({ ...realArticles, default: articleServiceMock }));
jest.unstable_mockModule('../src/services/knowledgeSuggestionService.js', () => ({ default: suggestionMock }));
jest.unstable_mockModule('../src/services/knowledgeSettingsService.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/knowledgeGapService.js', () => ({ default: gapMock }));

const { default: steward, overlapPairs, houseRuleFindings, OVERLAP_COSINE, GAP_MIN_TICKETS } = await import('../src/services/knowledgeStewardService.js');

const NOW = new Date('2026-10-12T09:00:00Z');
const long = (word) => `${word} `.repeat(60);
const art = (id, over = {}) => ({
  id, title: `Article ${id}`, bodyHtml: '<h2>Steps</h2><ol><li>Open Company Portal.</li><li>Install the app.</li></ol>', categoryId: 10, subcategoryId: 101, sections: [],
  confidence: 'checked', source: 'tp', status: 'published', lastVerifiedAt: new Date('2026-10-01T00:00:00Z'), reviewEveryDays: 180,
  createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'), ...over,
});
const raised = () => suggestionMock.create.mock.calls.map((c) => c[1]);

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.knowledgeArticle.findMany.mockResolvedValue([]);
  prismaMock.knowledgeSignal.findMany.mockResolvedValue([]);
  prismaMock.knowledgeSuggestion.findFirst.mockResolvedValue(null);
  prismaMock.knowledgeSuggestion.create.mockResolvedValue({});
  prismaMock.autoHelpRun.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  suggestionMock.create.mockImplementation(async (_ws, input) => ({ suggestion: { id: 1, ...input }, created: true }));
  articleServiceMock.timesQuoted.mockResolvedValue(new Map());
  gapMock.gaps.mockResolvedValue({ playbooks: [] });
});

describe('pure checks', () => {
  test('overlap: sections of DIFFERENT articles that say the same; the best pair per article pair; short sections ignored', () => {
    const a = art(1, { sections: [{ heading: 'Adobe Acrobat', text: long('acrobat'), embedding: [1, 0, 0] }, { heading: 'Other', text: long('other'), embedding: [0, 1, 0] }] });
    const b = art(2, { sections: [{ heading: 'Acrobat and Creative Cloud', text: long('acrobat'), embedding: [0.98, 0.05, 0] }, { heading: 'Tiny', text: 'short', embedding: [1, 0, 0] }] });
    const c = art(3, { sections: [{ heading: 'Unrelated', text: long('vpn'), embedding: [0, 0, 1] }] });
    const pairs = overlapPairs([a, b, c]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: { articleId: 1, heading: 'Adobe Acrobat' }, b: { articleId: 2, heading: 'Acrobat and Creative Cloud' } });
    expect(pairs[0].alike).toBeGreaterThanOrEqual(OVERLAP_COSINE);
    // Two alike sections inside ONE article are not an overlap.
    expect(overlapPairs([art(4, { sections: [{ heading: 'A', text: long('x'), embedding: [1, 0] }, { heading: 'B', text: long('x'), embedding: [1, 0] }] })])).toEqual([]);
  });

  test('house rules: no numbered steps, a price, a server address, too long', () => {
    expect(houseRuleFindings(art(1))).toEqual([]);
    const bad = art(2, { bodyHtml: `<p>${long('Ask IT for a licence, it costs $450 per year, then map \\\\\\\\fileserver01\\\\projects or 10.20.30.40.')}</p>` });
    expect(houseRuleFindings(bad).map((f) => f.key)).toEqual(['no_steps', 'price', 'address']);
    expect(houseRuleFindings(art(3, { bodyHtml: `<ol><li>${'word '.repeat(2500)}</li></ol>` })).map((f) => f.key)).toEqual(['too_long']);
    // A short note without steps is fine.
    expect(houseRuleFindings(art(4, { bodyHtml: '<p>Ask the GIS team.</p>' }))).toEqual([]);
  });
});

describe('runForWorkspace', () => {
  test('raises one suggestion per finding, each with evidence and a dedupe key; never touches an article', async () => {
    const overlapA = art(1, { sections: [{ heading: 'Adobe Acrobat', text: long('acrobat'), embedding: [1, 0] }] });
    const overlapB = art(2, { sections: [{ heading: 'Acrobat', text: long('acrobat'), embedding: [1, 0.01] }] });
    const unused = art(3, { createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-05T00:00:00Z') });
    const doubtful = art(4, { confidence: 'needs_look' });
    const stale = art(5, { lastVerifiedAt: new Date('2025-01-01T00:00:00Z') });
    const staleUnused = art(6, { lastVerifiedAt: new Date('2025-01-01T00:00:00Z'), createdAt: new Date('2026-08-01T00:00:00Z') });
    const priced = art(7, { bodyHtml: '<ol><li>Pay $120 for the licence.</li></ol>' });
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([overlapA, overlapB, unused, doubtful, stale, staleUnused, priced]);
    articleServiceMock.timesQuoted.mockResolvedValue(new Map([[1, 9], [2, 2], [4, 3], [5, 6], [7, 1]]));
    gapMock.gaps.mockResolvedValue({ playbooks: [{ categoryId: 30, clusters: [
      { key: 'c30:55', title: 'Docking station shows no display', count: 6, resolvedCount: 4, ticketIds: [55, 56], keywords: ['dock'], article: null, lastSeenAt: NOW },
      { key: 'c30:60', title: 'One-off', count: GAP_MIN_TICKETS - 1, resolvedCount: 0, ticketIds: [60], article: null },
      { key: 'c30:70', title: 'Already drafted', count: 9, resolvedCount: 2, ticketIds: [70], article: { id: 99 } },
    ] }] });

    const state = await steward.runForWorkspace(1, { withModel: false, now: NOW });

    const byKey = new Map(raised().map((r) => [r.dedupeKey, r]));
    expect(byKey.get('overlap:1:2')).toMatchObject({ kind: 'merge', articleId: 1, otherArticleId: 2, impact: 11, source: 'steward', evidence: { alike: 100 } });
    expect(byKey.get('unused:3')).toMatchObject({ kind: 'retire', articleId: 3 });
    expect(byKey.get('flag:article:4')).toMatchObject({ kind: 'flag', impact: 3 });
    expect(byKey.get('review:article:5')).toMatchObject({ kind: 'flag', articleId: 5 });
    // Past its review date but never used: nobody is asked to review it (review by use, not by calendar).
    expect(byKey.has('review:article:6')).toBe(false);
    expect(byKey.get('rules:7:price')).toMatchObject({ kind: 'flag', evidence: { rules: ['price'] } });
    expect(byKey.get('gap:c30:55')).toMatchObject({ kind: 'gap', categoryId: 30, impact: 6, reopen: true, evidence: expect.objectContaining({ ticketIds: [55, 56], resolved: 4 }) });
    expect(byKey.has('gap:c30:60')).toBe(false);
    expect(byKey.has('gap:c30:70')).toBe(false);
    expect(state.counts).toMatchObject({ overlap: 1, unused: 1, needsLook: 1, outOfDate: 1, houseRules: 1, gaps: 1 });
    expect(settingsMock.record).toHaveBeenCalledWith(1, { stewardState: expect.objectContaining({ scanned: 7, withModel: false }) });
    expect(gatewayMock.sendJson).not.toHaveBeenCalled();
  });

  test('a finding that already has an open item is not counted again; one broken check does not stop the others', async () => {
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([art(4, { confidence: 'needs_look' })]);
    suggestionMock.create.mockResolvedValue({ suggestion: { id: 1 }, created: false });
    gapMock.gaps.mockRejectedValue(new Error('gap finder down'));
    const state = await steward.runForWorkspace(1, { withModel: false, now: NOW });
    expect(state.counts).toEqual({ failed: 1 });
    expect(settingsMock.record).toHaveBeenCalled();
  });
});

describe('drift (the model check)', () => {
  const ARTICLE = art(7, { title: 'Installing software', bodyHtml: '<h2>Install</h2><ol><li>Open Company Portal.</li></ol>' });
  const evidence = () => {
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([ARTICLE]);
    prismaMock.knowledgeSignal.findMany.mockResolvedValue([{ articleId: 7, ticketId: 1 }]);
    prismaMock.autoHelpRun.findMany.mockResolvedValue([{ ticketId: 2, sources: [{ type: 'article', id: 7, cited: true }] }, { ticketId: 3, sources: [{ type: 'article', id: 8, cited: false }] }]);
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([
      { ticketId: 1, bodyText: `Hi, please open Software Center, not Company Portal, and search for the app there. ${'It is the new place for installs. '.repeat(3)}` },
      { ticketId: 2, bodyText: `Use Software Center from the Start menu now; Company Portal was retired last month. ${'Then choose Install. '.repeat(4)}` },
    ]);
  };
  const DRAFT = { title: 'Installing software', summary: '', sections: [{ heading: 'Install', intro: '', steps: ['Open Software Center.'] }], doesNotApply: [], usedTicketIds: [], reviewerNotes: '' };

  test('agents consistently say something else: an edit is proposed, with the tickets behind it, for a person to accept', async () => {
    evidence();
    gatewayMock.sendJson.mockResolvedValue({ parsed: { verdict: 'edit', why: 'Two replies say Software Center replaced Company Portal.', question: '', article: DRAFT } });
    const state = await steward.runForWorkspace(1, { withModel: true, now: NOW });
    const edit = raised().find((r) => r.kind === 'edit');
    expect(edit).toMatchObject({ articleId: 7, evidence: { ticketIds: [1, 2] }, dedupeKey: 'drift:7:1-2' });
    expect(edit.proposed.bodyHtml).toContain('<li>Open Software Center.</li>');
    expect(edit.why).toContain('Software Center replaced Company Portal');
    expect(state.counts.edits).toBe(1);
    const call = gatewayMock.sendJson.mock.calls[0][0];
    expect(call.userMessage).toContain('<reply>');
    expect(call.systemPrompt).toContain('Never add anything that is in neither the article nor the replies');
  });

  test('the replies disagree: one concrete question; found fine: remembered so the same evidence is not paid for twice', async () => {
    evidence();
    gatewayMock.sendJson.mockResolvedValue({ parsed: { verdict: 'question', why: 'One reply says Software Center, one says Company Portal.', question: 'Is Company Portal still the place to install apps?', article: DRAFT } });
    await steward.runForWorkspace(1, { withModel: true, now: NOW });
    expect(raised().find((r) => r.kind === 'question')).toMatchObject({ title: 'Is Company Portal still the place to install apps?', articleId: 7 });

    jest.clearAllMocks();
    suggestionMock.create.mockImplementation(async (_ws, input) => ({ suggestion: input, created: true }));
    articleServiceMock.timesQuoted.mockResolvedValue(new Map());
    gapMock.gaps.mockResolvedValue({ playbooks: [] });
    evidence();
    gatewayMock.sendJson.mockResolvedValue({ parsed: { verdict: 'fine', why: 'No difference.', question: '', article: DRAFT } });
    await steward.runForWorkspace(1, { withModel: true, now: NOW });
    expect(raised().filter((r) => ['edit', 'question'].includes(r.kind))).toEqual([]);
    expect(prismaMock.knowledgeSuggestion.create.mock.calls[0][0].data).toMatchObject({ status: 'dismissed', dedupeKey: 'drift:7:1-2', decidedBy: 'steward' });

    // Next night, same evidence: no model call.
    jest.clearAllMocks();
    evidence();
    prismaMock.knowledgeSuggestion.findFirst.mockResolvedValue({ id: 5 });
    articleServiceMock.timesQuoted.mockResolvedValue(new Map());
    gapMock.gaps.mockResolvedValue({ playbooks: [] });
    await steward.runForWorkspace(1, { withModel: true, now: NOW });
    expect(gatewayMock.sendJson).not.toHaveBeenCalled();
  });

  test('too little evidence, or a model failure: nothing is raised and the run goes on', async () => {
    evidence();
    prismaMock.autoHelpRun.findMany.mockResolvedValue([]);
    await steward.runForWorkspace(1, { withModel: true, now: NOW });
    expect(gatewayMock.sendJson).not.toHaveBeenCalled();
    evidence();
    gatewayMock.sendJson.mockRejectedValue(new Error('timeout'));
    const state = await steward.runForWorkspace(1, { withModel: true, now: NOW });
    expect(raised().filter((r) => r.kind === 'edit')).toEqual([]);
    expect(state.scanned).toBe(1);
  });
});

describe('the nightly run', () => {
  test('only workspaces with the review switched on; old items expire first; one failing workspace does not stop the next', async () => {
    settingsMock.enabledWorkspaces.mockResolvedValue([{ workspaceId: 1 }, { workspaceId: 2 }]);
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([]);
    settingsMock.record.mockRejectedValueOnce(new Error('db down'));
    const out = await steward.runAll({ now: NOW });
    expect(settingsMock.enabledWorkspaces).toHaveBeenCalledWith('stewardEnabled');
    expect(suggestionMock.expireOld).toHaveBeenCalledTimes(2);
    expect(out.map((o) => o.workspaceId)).toEqual([1, 2]);
    expect(out[0].error).toBe('db down');
    expect(out[1].scanned).toBe(0);
  });
});
