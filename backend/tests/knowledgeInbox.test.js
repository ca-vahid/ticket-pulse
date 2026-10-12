import { jest } from '@jest/globals';

/**
 * Knowledge inbox and contribution (plans/KNOWLEDGE_SIMPLIFY_PLAN.md, phase 3):
 *  - suggestions: one per topic, routed by skill to at most two people under
 *    their weekly cap, accepted only by someone with the skill, applied
 *    through the article service (versioned), expiring after four weeks
 *  - ask at close: only when it is worth asking, capped, "Not now" remembered
 *  - capture: a draft from the ticket plus "Check your draft" in the inbox
 *  - tidy: rough notes to a house-style proposal, nothing saved
 *  - reuse is review: two people judging answers good checks the article
 */
const prismaMock = {
  knowledgeSuggestion: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  knowledgeSettings: { findUnique: jest.fn(), upsert: jest.fn() },
  knowledgeSignal: { create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  knowledgeArticle: { findFirst: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
  knowledgeCategoryPolicy: { findMany: jest.fn() },
  ticket: { findFirst: jest.fn(), count: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
};
const articleMock = { get: jest.fn(), create: jest.fn(), update: jest.fn(), remove: jest.fn(), search: jest.fn(), markNeedsLook: jest.fn() };
const rightsMock = { profile: jest.fn(), rightsFor: jest.fn(), skilledPeople: jest.fn(), clearCache: jest.fn() };
const draftMock = { draftFromTickets: jest.fn(), existingDraftFor: jest.fn() };
const gatewayMock = { sendJson: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: gatewayMock }));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => false, embedQueryTexts: jest.fn(async () => null), cosineSimilarity: () => 0,
  nearestVerifiedSolutions: jest.fn(async () => ({ cosById: new Map(), topIds: [] })),
}));
const realArticles = await import('../src/services/knowledgeArticleService.js');
jest.unstable_mockModule('../src/services/knowledgeArticleService.js', () => ({ ...realArticles, default: articleMock }));
const realRights = await import('../src/services/knowledgeRights.js');
jest.unstable_mockModule('../src/services/knowledgeRights.js', () => ({ ...realRights, default: rightsMock }));
const realDrafts = await import('../src/services/articleDraftService.js');
jest.unstable_mockModule('../src/services/articleDraftService.js', () => ({ ...realDrafts, default: draftMock }));

const { default: suggestions, canDecide, EXPIRE_AFTER_MS, MAX_ASSIGNEES } = await import('../src/services/knowledgeSuggestionService.js');
const { default: capture, askDecision, askReason, ASK_MIN_SIMILAR, ASK_COVERED_SCORE, ASK_MIN_REPLY_CHARS } = await import('../src/services/knowledgeCaptureService.js');
const { default: signals, CHECKED_BY_REUSE_AFTER } = await import('../src/services/knowledgeSignals.js');
const { default: settingsService } = await import('../src/services/knowledgeSettingsService.js');

const PARENTS = new Map([[10, null], [101, 10], [20, null]]);
const profileOf = (email, { admin = false, levels = [] } = {}) => ({
  email, isAdmin: admin, isReviewer: false, technicianId: 1, levels: new Map(levels), parents: PARENTS, publishRank: 2, checkRank: 3,
});
const MID = { email: 'mid@example.com', name: 'Mid' };
const EXPERT = { email: 'expert@example.com', name: 'Expert' };
const OPEN = (over = {}) => ({
  id: 5, workspaceId: 1, kind: 'edit', status: 'open', articleId: 7, otherArticleId: null, categoryId: 10, subcategoryId: 101, title: 'Step 2 changed',
  why: 'Agents now say Software Center.', proposed: { bodyHtml: '<p>New text</p>' }, evidence: { ticketIds: [1, 2] }, impact: 4, source: 'steward',
  assignedTo: ['mid@example.com'], dedupeKey: 'drift:7', createdBy: null, createdAt: new Date('2026-10-10T00:00:00Z'), expiresAt: new Date('2026-11-07T00:00:00Z'), snoozedUntil: null, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  rightsMock.profile.mockImplementation(async (user) => (user?.email === 'expert@example.com' ? profileOf(user.email, { levels: [[10, 4]] })
    : user?.email === 'admin@example.com' ? profileOf(user.email, { admin: true })
      : user?.email === 'mid@example.com' ? profileOf(user.email, { levels: [[101, 2]] })
        : profileOf(user?.email || '', {})));
  rightsMock.rightsFor.mockImplementation(async (user, _ws, target) => realRights.rightsIn(await rightsMock.profile(user), target));
  rightsMock.skilledPeople.mockResolvedValue([
    { technicianId: 1, name: 'Ex Pert', email: 'expert@example.com', level: 4 },
    { technicianId: 2, name: 'Mid Level', email: 'mid@example.com', level: 2 },
    { technicianId: 3, name: 'Third', email: 'third@example.com', level: 2 },
  ]);
  prismaMock.knowledgeSettings.findUnique.mockResolvedValue(null);
  prismaMock.knowledgeSuggestion.findMany.mockResolvedValue([]);
  prismaMock.knowledgeSuggestion.findFirst.mockResolvedValue(null);
  prismaMock.knowledgeSuggestion.create.mockImplementation(async ({ data }) => ({ id: 9, createdAt: new Date(), ...data }));
  prismaMock.knowledgeSuggestion.update.mockImplementation(async ({ where, data }) => ({ ...OPEN(), id: where.id, ...data }));
  prismaMock.knowledgeSignal.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
  prismaMock.knowledgeSignal.findMany.mockResolvedValue([]);
  prismaMock.knowledgeSignal.count.mockResolvedValue(0);
  prismaMock.knowledgeCategoryPolicy.findMany.mockResolvedValue([]);
  articleMock.get.mockResolvedValue({ id: 7, title: 'OpenGround', bodyHtml: '<p>Old</p>', status: 'published', health: 'checked', version: 3, categoryId: 10, subcategoryId: 101 });
  articleMock.update.mockImplementation(async (_ws, id, data) => ({ id, ...data }));
  articleMock.create.mockImplementation(async (_ws, data) => ({ id: 30, ...data }));
  articleMock.remove.mockResolvedValue({ archived: true });
  articleMock.search.mockResolvedValue([]);
});

describe('suggestions', () => {
  test('routing: at most two people with the skill, never the author, fewest this week first, nobody over the weekly cap', async () => {
    expect(MAX_ASSIGNEES).toBe(2);
    prismaMock.knowledgeSuggestion.findMany.mockResolvedValue([
      ...Array.from({ length: 5 }, () => ({ assignedTo: ['expert@example.com'] })),
      { assignedTo: ['mid@example.com'] },
    ]);
    expect(await suggestions.route(1, { categoryId: 10 })).toEqual(['third@example.com', 'mid@example.com']);
    expect(await suggestions.route(1, { categoryId: 10 }, { exclude: ['Third@Example.com'] })).toEqual(['mid@example.com']);
    rightsMock.skilledPeople.mockResolvedValue([]);
    expect(await suggestions.route(1, { categoryId: 10 })).toEqual([]);
  });

  test('one suggestion per topic: more evidence refreshes the open one; a decided one is not raised again unless reopened', async () => {
    prismaMock.knowledgeSuggestion.findFirst.mockResolvedValue(OPEN());
    const again = await suggestions.create(1, { kind: 'edit', title: 'Step 2 changed', dedupeKey: 'drift:7', impact: 9, evidence: { ticketIds: [1, 2, 3] } });
    expect(again.created).toBe(false);
    expect(prismaMock.knowledgeSuggestion.create).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeSuggestion.update.mock.calls[0][0].data).toMatchObject({ impact: 9, evidence: { ticketIds: [1, 2, 3] } });

    prismaMock.knowledgeSuggestion.findFirst.mockResolvedValue(OPEN({ status: 'dismissed' }));
    expect((await suggestions.create(1, { kind: 'edit', title: 'Step 2 changed', dedupeKey: 'drift:7' })).created).toBe(false);
    const reopened = await suggestions.create(1, { kind: 'edit', title: 'Step 2 changed', dedupeKey: 'drift:7', reopen: true, categoryId: 10 });
    expect(reopened.created).toBe(true);
    expect(prismaMock.knowledgeSuggestion.create.mock.calls[0][0].data).toMatchObject({ dedupeKey: 'drift:7', status: 'open' });
  });

  test('a new suggestion expires in four weeks and is validated', async () => {
    const before = Date.now();
    await suggestions.create(1, { kind: 'gap', title: '  Docking stations   ', categoryId: 20, impact: -3 });
    const data = prismaMock.knowledgeSuggestion.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ title: 'Docking stations', impact: 0, status: 'open', source: 'person' });
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + EXPIRE_AFTER_MS - 1000);
    await expect(suggestions.create(1, { kind: 'nonsense', title: 'x' })).rejects.toThrow(/kind must be one of/);
    await expect(suggestions.create(1, { kind: 'gap', title: '  ' })).rejects.toThrow(/needs a title/);
    prismaMock.knowledgeSuggestion.updateMany.mockResolvedValue({ count: 3 });
    expect(await suggestions.expireOld(1)).toBe(3);
    expect(prismaMock.knowledgeSuggestion.updateMany.mock.calls[0][0]).toMatchObject({ where: { workspaceId: 1, status: 'open' }, data: { status: 'expired' } });
  });

  test('the inbox: mine, my categories, everything (admins); each item says whether I may decide it', async () => {
    prismaMock.knowledgeSuggestion.findMany.mockResolvedValue([
      OPEN({ id: 1 }),
      OPEN({ id: 2, kind: 'retire', assignedTo: [] }),
      OPEN({ id: 3, categoryId: 20, subcategoryId: null, assignedTo: [] }),
    ]);
    const mid = await suggestions.list(1, MID, {});
    expect(mid.items.map((i) => [i.id, i.mine, i.canDecide])).toEqual([[1, true, true]]);
    expect(mid.counts).toEqual({ mine: 1, categories: 1, all: null });
    expect(mid.items[0].proposed).toBeUndefined();
    const expert = await suggestions.list(1, EXPERT, {});
    expect(expert.items.map((i) => [i.id, i.canDecide])).toEqual([[1, true], [2, true]]);
    const admin = await suggestions.list(1, { email: 'admin@example.com' }, { scope: 'all' });
    expect(admin.total).toBe(3);
    expect(admin.counts.all).toBe(3);
  });

  test('who may decide: writing rights for most kinds, checking rights to merge or retire', () => {
    expect(canDecide({ write: true, check: false }, 'edit')).toBe(true);
    expect(canDecide({ write: true, check: false }, 'merge')).toBe(false);
    expect(canDecide({ write: true, check: true }, 'retire')).toBe(true);
    expect(canDecide(null, 'edit')).toBe(false);
  });

  test('accepting an edit applies it through the article service, with the suggestion as the version note', async () => {
    prismaMock.knowledgeSuggestion.findFirst.mockResolvedValue(OPEN());
    const done = await suggestions.accept(1, 5, MID);
    expect(articleMock.update).toHaveBeenCalledWith(1, 7, { bodyHtml: '<p>New text</p>' }, expect.objectContaining({ email: 'mid@example.com' }), expect.objectContaining({ canCheck: false, changeNote: 'Step 2 changed', suggestionId: 5 }));
    expect(done).toMatchObject({ status: 'accepted', decidedBy: 'mid@example.com' });
  });

  test('edit and accept: the person\'s text replaces the proposal', async () => {
    prismaMock.knowledgeSuggestion.findFirst.mockResolvedValue(OPEN());
    await suggestions.accept(1, 5, EXPERT, { bodyHtml: '<p>My wording</p>' });
    expect(articleMock.update.mock.calls[0][2]).toEqual({ bodyHtml: '<p>My wording</p>' });
    expect(articleMock.update.mock.calls[0][4]).toMatchObject({ canCheck: true });
  });

  test('each kind does its own thing: publish a draft, add a section, merge, retire, answer a question', async () => {
    prismaMock.knowledgeSuggestion.findFirst.mockResolvedValue(OPEN({ kind: 'review', proposed: null }));
    await suggestions.accept(1, 5, MID);
    expect(articleMock.update.mock.calls.at(-1)[2]).toEqual({ status: 'published' });

    prismaMock.knowledgeSuggestion.findFirst.mockResolvedValue(OPEN({ kind: 'new_article', articleId: null, proposed: { title: 'DT Logger', bodyHtml: '<p>Steps</p>', tags: ['dt'] } }));
    const made = await suggestions.accept(1, 5, MID);
    expect(articleMock.create.mock.calls[0][1]).toMatchObject({ title: 'DT Logger', status: 'published', categoryId: 10, subcategoryId: 101 });
    expect(made.resultArticleId).toBe(30);

    prismaMock.knowledgeSuggestion.findFirst.mockResolvedValue(OPEN({ kind: 'add_section', proposed: { sectionHtml: '<h2>New</h2><script>x</script>' } }));
    await suggestions.accept(1, 5, MID);
    expect(articleMock.update.mock.calls.at(-1)[2]).toEqual({ bodyHtml: '<p>Old</p><h2>New</h2>' });

    prismaMock.knowledgeSuggestion.findFirst.mockResolvedValue(OPEN({ kind: 'merge', otherArticleId: 8, proposed: { bodyHtml: '<p>Both</p>' } }));
    await expect(suggestions.accept(1, 5, MID)).rejects.toMatchObject({ code: 'knowledge_suggestion_rights' });
    await suggestions.accept(1, 5, EXPERT);
    expect(articleMock.update.mock.calls.at(-1)[2]).toEqual({ bodyHtml: '<p>Both</p>' });
    expect(articleMock.remove).toHaveBeenLastCalledWith(1, 8, expect.anything());

    prismaMock.knowledgeSuggestion.findFirst.mockResolvedValue(OPEN({ kind: 'retire' }));
    await suggestions.accept(1, 5, EXPERT);
    expect(articleMock.remove).toHaveBeenLastCalledWith(1, 7, expect.anything());

    prismaMock.knowledgeSuggestion.findFirst.mockResolvedValue(OPEN({ kind: 'question', proposed: null }));
    await expect(suggestions.accept(1, 5, MID)).rejects.toThrow(/Type the answer first/);
    const answered = await suggestions.accept(1, 5, MID, { answer: 'Yes, still CAD only.' });
    expect(answered.decisionNote).toBe('Yes, still CAD only.');
  });

  test('no skill, no accept; an item already dealt with cannot be decided twice; the person it was sent to can dismiss or put it off', async () => {
    prismaMock.knowledgeSuggestion.findFirst.mockResolvedValue(OPEN({ categoryId: 20, subcategoryId: null }));
    await expect(suggestions.accept(1, 5, MID)).rejects.toMatchObject({ code: 'knowledge_suggestion_rights' });
    expect(articleMock.update).not.toHaveBeenCalled();
    // Sent to Mid, so Mid may dismiss it even without the skill there.
    expect(await suggestions.dismiss(1, 5, MID, { note: 'Not ours' })).toMatchObject({ status: 'dismissed', decisionNote: 'Not ours' });
    const snoozed = await suggestions.snooze(1, 5, MID, { days: 99 });
    expect(snoozed.snoozedUntil.getTime()).toBeLessThanOrEqual(Date.now() + 28 * 86400e3 + 1000);
    prismaMock.knowledgeSuggestion.findFirst.mockResolvedValue(OPEN({ status: 'accepted' }));
    await expect(suggestions.accept(1, 5, EXPERT)).rejects.toThrow(/already dealt with/);
  });
});

describe('ask at close', () => {
  const WORTH = { enabled: true, canWrite: true, categoryId: 10, similar: 6, replyChars: 400, bestScore: 0.3, askedToday: 0, dailyCap: 1 };

  test('asks only when it is worth asking, and says why not', () => {
    expect(askDecision(WORTH)).toEqual({ ask: true, why: null });
    expect(askDecision({ ...WORTH, enabled: false }).why).toBe('off');
    expect(askDecision({ ...WORTH, canWrite: false }).why).toBe('no_skill');
    expect(askDecision({ ...WORTH, noise: true }).why).toBe('not_a_person_request');
    expect(askDecision({ ...WORTH, security: true }).why).toBe('not_a_person_request');
    expect(askDecision({ ...WORTH, alreadyAsked: true }).why).toBe('asked_for_this_ticket');
    expect(askDecision({ ...WORTH, hasDraft: true }).why).toBe('already_drafted');
    expect(askDecision({ ...WORTH, askedToday: 1 }).why).toBe('daily_cap');
    expect(askDecision({ ...WORTH, notNowRecently: true }).why).toBe('not_now');
    expect(askDecision({ ...WORTH, replyChars: ASK_MIN_REPLY_CHARS - 1 }).why).toBe('no_real_answer');
    expect(askDecision({ ...WORTH, bestScore: ASK_COVERED_SCORE }).why).toBe('already_written');
    expect(askDecision({ ...WORTH, similar: ASK_MIN_SIMILAR - 1 }).why).toBe('rare');
    expect(askDecision({}).ask).toBe(false);
    expect(askReason({ similar: 6, place: 'Devices › Docking' })).toBe('6 requests like this came in over the last 90 days (Devices › Docking), and nothing in the Library covers it.');
  });

  const TICKET = {
    id: 55, subject: 'Docking station shows no display', descriptionText: 'My dock stopped working.', isNoise: false, triageMode: null,
    internalCategoryId: 10, internalSubcategoryId: 101, internalCategory: { name: 'Devices & Hardware' }, internalSubcategory: { name: 'Docking Stations' },
  };
  const worthAsking = () => {
    prismaMock.knowledgeSettings.findUnique.mockResolvedValue({ askAtClose: true, askDailyCap: 1 });
    prismaMock.ticket.findFirst.mockResolvedValue(TICKET);
    prismaMock.ticket.count.mockResolvedValue(6);
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([{ bodyText: 'x'.repeat(300) }]);
    draftMock.existingDraftFor.mockResolvedValue(null);
  };

  test('a ticket worth asking about: the ask is recorded (so the daily cap counts) and the reason carries the count', async () => {
    worthAsking();
    const out = await capture.shouldAsk(1, 55, MID);
    expect(out).toMatchObject({ ask: true, similar: 6 });
    expect(out.reason).toContain('6 requests like this');
    expect(prismaMock.knowledgeSignal.create.mock.calls[0][0].data).toMatchObject({ kind: 'ask_shown', ticketId: 55, actor: 'mid@example.com', categoryId: 101 });
  });

  test('switched off, already asked today, or a broken read: never asks, never records', async () => {
    worthAsking();
    prismaMock.knowledgeSettings.findUnique.mockResolvedValue({ askAtClose: false });
    expect(await capture.shouldAsk(1, 55, MID)).toEqual({ ask: false, why: 'off' });
    worthAsking();
    prismaMock.knowledgeSignal.count.mockImplementation(async ({ where }) => (where.kind === 'ask_shown' ? 1 : 0));
    expect((await capture.shouldAsk(1, 55, MID)).why).toBe('daily_cap');
    worthAsking();
    prismaMock.knowledgeSignal.count.mockRejectedValue(new Error('db down'));
    expect((await capture.shouldAsk(1, 55, MID)).ask).toBe(false);
    expect(prismaMock.knowledgeSignal.create).not.toHaveBeenCalled();
  });

  test('"Yes" drafts from the ticket and puts "Check your draft" in the agent\'s inbox; "Not now" is remembered', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 55, subject: 'Docking station', internalCategoryId: 10, internalSubcategoryId: 101 });
    draftMock.existingDraftFor.mockResolvedValue(null);
    draftMock.draftFromTickets.mockResolvedValue({ article: { id: 31, title: 'Fix a docking station with no display' }, used: 1 });
    const out = await capture.capture(1, 55, MID, { decision: 'yes' });
    expect(draftMock.draftFromTickets).toHaveBeenCalledWith(1, [55], expect.objectContaining({ email: 'mid@example.com' }), expect.objectContaining({ kind: 'promote' }));
    expect(out).toMatchObject({ saved: true, article: { id: 31 } });
    expect(prismaMock.knowledgeSuggestion.create.mock.calls[0][0].data).toMatchObject({
      kind: 'review', articleId: 31, assignedTo: ['mid@example.com'], dedupeKey: 'review:article:31', source: 'agent_close', title: 'Check your draft: Fix a docking station with no display',
    });
    jest.clearAllMocks();
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 55, subject: 'Docking station', internalCategoryId: 10, internalSubcategoryId: 101 });
    expect(await capture.capture(1, 55, MID, { decision: 'not_now' })).toEqual({ saved: false });
    expect(prismaMock.knowledgeSignal.create.mock.calls[0][0].data).toMatchObject({ kind: 'ask_not_now', categoryId: 101 });
    expect(draftMock.draftFromTickets).not.toHaveBeenCalled();
  });

  test('a ticket that already has a draft reuses it; no skill in the category is refused', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 55, subject: 'x', internalCategoryId: 10, internalSubcategoryId: 101 });
    draftMock.existingDraftFor.mockResolvedValue({ id: 31, title: 'Existing draft', status: 'draft' });
    expect(await capture.capture(1, 55, MID)).toMatchObject({ saved: true, reused: true, article: { id: 31 } });
    expect(draftMock.draftFromTickets).not.toHaveBeenCalled();
    await expect(capture.capture(1, 55, { email: 'nobody@example.com' })).rejects.toThrow(/needs a skill/);
  });
});

describe('tidy', () => {
  test('rough notes become a house-style proposal built from the model\'s structure; nothing is saved', async () => {
    gatewayMock.sendJson.mockResolvedValue({ parsed: {
      title: 'Fix a docking station with no display', summary: 'For laptops on a Dell dock.',
      sections: [{ heading: 'Steps', intro: '', steps: ['Unplug the dock for 30 seconds.', 'Plug it back in <b>firmly</b>.'] }],
      doesNotApply: [], usedTicketIds: [], reviewerNotes: 'The notes do not say which dock models.',
    } });
    const out = await capture.tidy(1, { text: 'dock no display. unplug it 30 sec then plug back. email me at jo@example.com if stuck', title: 'dock' });
    expect(out.title).toBe('Fix a docking station with no display');
    expect(out.bodyHtml).toContain('<ol><li>Unplug the dock for 30 seconds.</li><li>Plug it back in firmly.</li></ol>');
    expect(out.bodyHtml).not.toContain('When this doesn');
    expect(out.reviewerNotes).toContain('which dock models');
    // The notes reach the model fenced, with the address scrubbed.
    const call = gatewayMock.sendJson.mock.calls[0][0];
    expect(call.userMessage).toContain('<notes>');
    expect(call.userMessage).not.toContain('jo@example.com');
    expect(articleMock.create).not.toHaveBeenCalled();
  });

  test('too little to work with, a model failure, or no steps: said plainly', async () => {
    await expect(capture.tidy(1, { text: 'dock' })).rejects.toThrow(/Write a few lines first/);
    gatewayMock.sendJson.mockRejectedValue(new Error('timeout'));
    await expect(capture.tidy(1, { text: 'x'.repeat(60) })).rejects.toThrow(/could not be tidied right now/);
    gatewayMock.sendJson.mockResolvedValue({ parsed: { title: 'x', summary: '', sections: [], doesNotApply: [], usedTicketIds: [], reviewerNotes: '' } });
    await expect(capture.tidy(1, { text: 'x'.repeat(60) })).rejects.toThrow(/did not have enough in them/);
  });
});

describe('reuse is review', () => {
  const NOT_CHECKED = { id: 7, status: 'published', confidence: 'not_checked', updatedAt: new Date('2026-10-01T00:00:00Z') };

  test('two different people judging its answers good checks a "Not checked yet" article; one person twice does not', async () => {
    expect(CHECKED_BY_REUSE_AFTER).toBe(2);
    prismaMock.knowledgeArticle.findFirst.mockResolvedValue(NOT_CHECKED);
    prismaMock.knowledgeArticle.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.knowledgeSignal.findMany.mockResolvedValue([{ id: 1, kind: 'good', actor: 'a@x.com', ticketId: 1 }, { id: 2, kind: 'good', actor: 'A@x.com', ticketId: 2 }]);
    expect(await signals.promoteIfReused(1, 7)).toBe(false);
    prismaMock.knowledgeSignal.findMany.mockResolvedValue([{ id: 1, kind: 'good', actor: 'a@x.com', ticketId: 1 }, { id: 2, kind: 'good', actor: 'b@x.com', ticketId: 2 }]);
    expect(await signals.promoteIfReused(1, 7)).toBe(true);
    expect(prismaMock.knowledgeArticle.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 7, confidence: 'not_checked' }, data: { confidence: 'checked', checkedBy: 'reuse' } });
    // Only signals since the text last changed count.
    expect(prismaMock.knowledgeSignal.findMany.mock.calls.at(-1)[0].where.createdAt.gte).toEqual(NOT_CHECKED.updatedAt);
  });

  test('a bad signal in the same period blocks it; a doubtful or already checked article is left to people', async () => {
    prismaMock.knowledgeArticle.findFirst.mockResolvedValue(NOT_CHECKED);
    prismaMock.knowledgeSignal.findMany.mockResolvedValue([{ id: 1, kind: 'good', actor: 'a@x.com' }, { id: 2, kind: 'good', actor: 'b@x.com' }, { id: 3, kind: 'flagged', actor: 'c@x.com' }]);
    expect(await signals.promoteIfReused(1, 7)).toBe(false);
    prismaMock.knowledgeArticle.findFirst.mockResolvedValue({ ...NOT_CHECKED, confidence: 'needs_look' });
    expect(await signals.promoteIfReused(1, 7)).toBe(false);
    expect(prismaMock.knowledgeArticle.updateMany).not.toHaveBeenCalled();
  });
});

describe('contribution settings', () => {
  test('defaults, and the rule that checking never needs less skill than writing', async () => {
    expect(await settingsService.get(1)).toMatchObject({ publishLevel: 'intermediate', checkLevel: 'advanced', askAtClose: false, askDailyCap: 1, inboxWeeklyCap: 5, stewardEnabled: false });
    prismaMock.knowledgeSettings.upsert.mockImplementation(async ({ update }) => ({ workspaceId: 1, ...update }));
    await expect(settingsService.update(1, { publishLevel: 'expert' })).rejects.toThrow(/cannot be lower/);
    await expect(settingsService.update(1, { askDailyCap: 9 })).rejects.toThrow(/whole number from 1 to 5/);
    await expect(settingsService.update(1, { checkLevel: 'guru' })).rejects.toThrow(/must be one of/);
    const saved = await settingsService.update(1, { askAtClose: true, askDailyCap: 2, publishLevel: 'advanced', checkLevel: 'expert' }, { email: 'admin@example.com' });
    expect(saved).toMatchObject({ askAtClose: true, askDailyCap: 2, publishLevel: 'advanced', checkLevel: 'expert' });
  });
});
