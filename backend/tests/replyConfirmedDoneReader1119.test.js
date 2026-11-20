import { jest } from '@jest/globals';
import { createFakePrisma } from './helpers/fakePrismaStore.js';

/**
 * "Resolve when the requester confirms it's done (waiting tickets)" —
 * 19 Nov 2026, the reading: classifyReply reader 'confirm_done' (the stricter
 * question, no keyword shortcut, high confidence only) and readReply's
 * waiting-ticket path. The model is mocked at the provider gateway, as the
 * other reply-reading tests do. Invented names and example.com only.
 */
let db;
const prismaProxy = new Proxy({}, { get: (_t, prop) => db[prop] });
const gatewayMock = { runToolTurn: jest.fn(), sendJson: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaProxy }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: gatewayMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { addReply: jest.fn(), addPrivateNote: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ emitTicketEvent: jest.fn(), default: { emitTicketEvent: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { get: jest.fn(async () => null), set: jest.fn() } }));

const { default: followUp } = await import('../src/services/autoHelpFollowUpService.js');
const { default: replyReopen, REPLY_CHECK_OPERATION, REPLY_VERDICTS } = await import('../src/services/requesterReplyReopenService.js');

const answer = (verdict, confidence = 'high') => ({ parsed: { verdict, confidence, reason: 'test' }, usage: { inputTokens: 300, outputTokens: 20 }, provider: 'anthropic', model: 'claude-haiku-4-5-20251001' });
const ownBudget = (state) => jest.fn(async () => state);
const opts = (more = {}) => ({ reader: 'confirm_done', operation: REPLY_CHECK_OPERATION, budgetState: ownBudget({ exhausted: false }), ...more });

beforeEach(() => {
  jest.clearAllMocks();
  db = createFakePrisma({});
  gatewayMock.sendJson.mockResolvedValue(answer('confirmed_done'));
});

describe('classifyReply, reader "confirm_done"', () => {
  test('the stricter question, its own schema with confidence, the reply-check operation and limit', async () => {
    const budget = ownBudget({ exhausted: false });
    const read = await followUp.classifyReply(1, 'All working now, thanks!', opts({ subject: 'Printer', budgetState: budget, timeoutMs: 5000 }));
    expect(read).toMatchObject({ verdict: 'confirmed', via: 'model', modelVerdict: 'confirmed_done', confidence: 'high' });
    expect(budget).toHaveBeenCalledWith(1);
    const call = gatewayMock.sendJson.mock.calls[0][0];
    expect(call.operation).toBe('requester_reply_check');
    expect(call.attemptTimeoutMs).toBe(5000);
    expect(call.systemPrompt).toMatch(/Did the requester confirm the request is done and no further action is needed\?/);
    expect(call.systemPrompt).toMatch(/untrusted data/);
    expect(call.extra.jsonSchema.properties.verdict.enum).toEqual(['confirmed_done', 'next_step', 'auto_reply', 'still_broken', 'new_request', 'question', 'unclear']);
    expect(call.extra.jsonSchema.properties.confidence.enum).toEqual(['high', 'medium', 'low']);
    expect(call.extra.jsonSchema.required).toEqual(['verdict', 'confidence']);
  });

  test('no keyword shortcut: a bare thank-you on a waiting ticket goes to the model', async () => {
    for (const text of ['Thanks!', 'Yep, much appreciated!', 'That worked, thanks!']) {
      gatewayMock.sendJson.mockClear();
      await followUp.classifyReply(1, text, opts());
      expect(gatewayMock.sendJson).toHaveBeenCalledTimes(1);
    }
    // The closed-ticket reader keeps its shortcut.
    gatewayMock.sendJson.mockClear();
    expect(await followUp.classifyReply(1, 'Thanks!', opts({ reader: 'person' }))).toMatchObject({ verdict: 'confirmed', via: 'keywords' });
    expect(gatewayMock.sendJson).not.toHaveBeenCalled();
  });

  test('only confirmed_done at HIGH confidence confirms; medium / low / missing confidence or any other answer does not', async () => {
    for (const parsed of [
      { verdict: 'confirmed_done', confidence: 'medium' },
      { verdict: 'confirmed_done', confidence: 'low' },
      { verdict: 'confirmed_done' },
      { verdict: 'next_step', confidence: 'high' },
      { verdict: 'unclear', confidence: 'high' },
      null,
    ]) {
      gatewayMock.sendJson.mockResolvedValueOnce({ parsed });
      expect((await followUp.classifyReply(1, 'Thanks for the recommendation; we will follow it', opts())).verdict).toBe('help');
    }
  });

  test('the spend limit and a timeout are "help": no confirmation', async () => {
    expect(await followUp.classifyReply(1, 'Perfect, all sorted', opts({ budgetState: ownBudget({ exhausted: true, capUsd: 10, spentUsd: 10.4 }) })))
      .toMatchObject({ verdict: 'help', via: 'budget_cap' });
    expect(gatewayMock.sendJson).not.toHaveBeenCalled();
    gatewayMock.sendJson.mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')));
    }));
    expect(await followUp.classifyReply(1, 'Perfect, all sorted', opts({ timeoutMs: 30 }))).toMatchObject({ verdict: 'help', via: 'fallback' });
  });
});

describe('readReply on a waiting ticket (confirmDone)', () => {
  const entry = (bodyText) => ({ id: 31, ticketId: 80, eventType: 'reply', authorType: 'requester', incoming: true, isPrivate: false, bodyText, content: bodyText, title: null, rawPayload: null, occurredAt: new Date() });
  const read = async (bodyText, more = {}) => {
    db = createFakePrisma({ ticketThreadEntry: [entry(bodyText)] });
    return replyReopen.readReply({ id: 80, workspaceId: 1, subject: 'Monitor' }, { entryId: 31 }, { allowThanks: false, confirmDone: true, ...more });
  };

  test('confirmed_done (high) → CONFIRMED_DONE with confidence and the first 160 characters of the reply', async () => {
    const long = `That fixed it, thank you. ${'x'.repeat(300)}`;
    const out = await read(long);
    expect(out).toMatchObject({ verdict: REPLY_VERDICTS.CONFIRMED_DONE, via: 'model', entryId: 31, confirmDone: { confidence: 'high', modelVerdict: 'confirmed_done' } });
    expect(out.confirmDone.snippet).toHaveLength(160);
    expect(out.confirmDone.snippet.startsWith('That fixed it, thank you.')).toBe(true);
    expect(gatewayMock.sendJson.mock.calls[0][0].systemPrompt).toMatch(/waiting for the requester/);
  });

  test('the quoted history is not part of the quote', async () => {
    const out = await read('Perfect, all sorted\n\nOn Mon, 16 Nov 2026 at 09:12, Eli Park <eli@example.com> wrote:\n> Could you try restarting?');
    expect(out.confirmDone.snippet).toBe('Perfect, all sorted');
  });

  test.each([
    ['confirmed_done', 'medium', 'reply'],
    ['next_step', 'high', 'reply'],
    ['unclear', 'high', 'reply'],
    ['still_broken', 'high', 'still_broken'],
    ['question', 'high', 'question'],
    ['new_request', 'high', 'new_request'],
    ['auto_reply', 'high', 'auto_reply'],
  ])('a workflow reads "Reply reads as": the model says %p (%p) → %p', async (verdict, confidence, want) => {
    gatewayMock.sendJson.mockResolvedValue(answer(verdict, confidence));
    expect((await read('Thanks - I will be in the office Wednesday, I can stop by', { rich: true })).verdict).toBe(want);
  });

  test('no "Reply reads as": anything but a confident confirmation is "reply", as a waiting ticket\'s reply was before', async () => {
    for (const verdict of ['next_step', 'still_broken', 'question', 'new_request', 'auto_reply', 'unclear']) {
      gatewayMock.sendJson.mockResolvedValue(answer(verdict));
      const out = await read('Thanks - I will be in the office Wednesday, I can stop by');
      expect(out.verdict).toBe('reply');
      expect(out.confirmDone.modelVerdict).toBe(verdict);
    }
    gatewayMock.sendJson.mockResolvedValue(answer('confirmed_done'));
    expect((await read('Perfect, all sorted')).verdict).toBe('confirmed_done');
  });

  test('timeout, spend limit and a model error all read as "reply" (the ticket reopens)', async () => {
    gatewayMock.sendJson.mockImplementation(() => new Promise(() => {}));
    expect(await read('All working now, thanks!', { timeoutMs: 20 })).toMatchObject({ verdict: 'reply', via: 'timeout' });
    gatewayMock.sendJson.mockRejectedValue(new Error('provider down'));
    expect(await read('All working now, thanks!')).toMatchObject({ verdict: 'reply', via: 'fallback' });
    // Spend over the limit: budgetState reads requester_reply_check attempts this month.
    db = createFakePrisma({
      ticketThreadEntry: [entry('All working now, thanks!')],
      aiProviderAttempt: [{ workspaceId: 1, operation: 'requester_reply_check', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputTokens: 50_000_000, outputTokens: 0, startedAt: new Date() }],
    });
    gatewayMock.sendJson.mockReset();
    gatewayMock.sendJson.mockResolvedValue(answer('confirmed_done'));
    const capped = await replyReopen.readReply({ id: 80, workspaceId: 1 }, { entryId: 31 }, { allowThanks: false, confirmDone: true, rules: { replyCheckMonthlyCapUsd: 5 } });
    expect(capped).toMatchObject({ verdict: 'reply', via: 'budget_cap' });
    expect(gatewayMock.sendJson).not.toHaveBeenCalled();
  });

  test('without "Use AI" (the editor\'s try-it) there is no reading at all, not even keywords', async () => {
    expect(await read('Thanks!', { useAi: false })).toMatchObject({ verdict: 'reply', via: 'no_ai' });
    expect(gatewayMock.sendJson).not.toHaveBeenCalled();
  });
});
