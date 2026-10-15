import { jest } from '@jest/globals';
import { createFakePrisma } from './helpers/fakePrismaStore.js';

/**
 * "When a requester replies" (14 Oct 2026): reading a reply to a ticket a
 * PERSON closed, with the Auto-help pieces (not its wrapper):
 *  - classifyReply reader 'person': neutral prompt, bare-thanks fast path,
 *    its own operation and its own budget — Auto-help's cap is never read;
 *  - Auto-help's own reader is unchanged;
 *  - over the limit / failed / timed out → 'help' (the ticket reopens);
 *  - out-of-office on FreshService-born replies (no headers, no subject).
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
const { isAutoReplyEntry, isOutOfOfficeReply, classifyThanksFast, classifyReplyFast } = await import('../src/services/autoHelpOutcomes.js');
const { default: replyReopen, REPLY_CHECK_OPERATION } = await import('../src/services/requesterReplyReopenService.js');
const { default: autoHelpRunner } = await import('../src/services/autoHelpRunner.js');
const runnerMock = { budgetState: jest.spyOn(autoHelpRunner, 'budgetState') };

beforeEach(() => {
  jest.clearAllMocks();
  db = createFakePrisma({});
  gatewayMock.sendJson.mockResolvedValue({ parsed: { verdict: 'thanks', reason: 'only thanks' }, usage: { inputTokens: 300, outputTokens: 20 }, provider: 'anthropic', model: 'claude-haiku-4-5-20251001' });
  runnerMock.budgetState.mockResolvedValue({ exhausted: true }); // Auto-help off / at its cap: must not matter here
});

const ownBudget = (state) => jest.fn(async () => state);

describe('classifyReply, reader "person"', () => {
  test('neutral prompt, own operation, own budget — Auto-help\'s cap is never read', async () => {
    const budget = ownBudget({ exhausted: false });
    const read = await followUp.classifyReply(1, 'Thank you for sorting the dock out yesterday, all good on my side now.', {
      subject: 'Dock', reader: 'person', operation: REPLY_CHECK_OPERATION, budgetState: budget, timeoutMs: 5000,
    });
    expect(read).toMatchObject({ verdict: 'confirmed', via: 'model' });
    expect(budget).toHaveBeenCalledWith(1);
    expect(runnerMock.budgetState).not.toHaveBeenCalled();
    const call = gatewayMock.sendJson.mock.calls[0][0];
    expect(call.operation).toBe('requester_reply_check');
    expect(call.attemptTimeoutMs).toBe(5000);
    expect(call.systemPrompt).not.toMatch(/automated first answer/);
    expect(call.systemPrompt).toMatch(/Someone on a helpdesk answered/);
    expect(call.extra.jsonSchema.properties.verdict.enum).toEqual(['thanks', 'needs_reply', 'unclear']);
  });

  test('only an explicit "thanks" stays closed: unclear / needs_reply / odd output → help', async () => {
    const opts = { reader: 'person', operation: REPLY_CHECK_OPERATION, budgetState: ownBudget({ exhausted: false }) };
    for (const parsed of [{ verdict: 'unclear' }, { verdict: 'needs_reply' }, { verdict: 'resolved' }, null]) {
      gatewayMock.sendJson.mockResolvedValueOnce({ parsed });
      expect((await followUp.classifyReply(1, 'Thank you, I will check it tomorrow morning when I am in', opts)).verdict).toBe('help');
    }
  });

  test('a bare thank-you never reaches the model (person reader only)', async () => {
    const opts = { reader: 'person', operation: REPLY_CHECK_OPERATION, budgetState: ownBudget({ exhausted: false }) };
    expect(await followUp.classifyReply(1, 'Thanks!', opts)).toMatchObject({ verdict: 'confirmed', via: 'keywords' });
    expect(gatewayMock.sendJson).not.toHaveBeenCalled();
  });

  test('over its own limit → help (reopen), no model call', async () => {
    const read = await followUp.classifyReply(1, 'Thank you all for your patience with me on this one', {
      reader: 'person', operation: REPLY_CHECK_OPERATION, budgetState: ownBudget({ exhausted: true, capUsd: 10, spentUsd: 10.2 }),
    });
    expect(read).toMatchObject({ verdict: 'help', via: 'budget_cap' });
    expect(gatewayMock.sendJson).not.toHaveBeenCalled();
  });

  test('a budget that cannot be read → help', async () => {
    const read = await followUp.classifyReply(1, 'Thank you all for your patience with me on this one', {
      reader: 'person', operation: REPLY_CHECK_OPERATION, budgetState: jest.fn(async () => { throw new Error('db down'); }),
    });
    expect(read).toMatchObject({ verdict: 'help', via: 'budget_cap' });
  });

  test('timed out → help (the abort fires at timeoutMs)', async () => {
    gatewayMock.sendJson.mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')));
    }));
    const read = await followUp.classifyReply(1, 'Thank you all for your patience with me on this one', {
      reader: 'person', operation: REPLY_CHECK_OPERATION, budgetState: ownBudget({ exhausted: false }), timeoutMs: 30,
    });
    expect(read).toMatchObject({ verdict: 'help', via: 'fallback' });
  });
});

describe('Auto-help\'s own reader is unchanged', () => {
  test('same prompt, operation auto_help, Auto-help\'s budget; a bare "Thanks!" still goes to the model', async () => {
    runnerMock.budgetState.mockResolvedValue({ exhausted: false });
    gatewayMock.sendJson.mockResolvedValue({ parsed: { verdict: 'resolved' } });
    expect((await followUp.classifyReply(1, 'Thanks!', { subject: 'VPN' })).verdict).toBe('confirmed');
    const call = gatewayMock.sendJson.mock.calls[0][0];
    expect(call.operation).toBe('auto_help');
    expect(call.attemptTimeoutMs).toBe(20000);
    expect(call.systemPrompt.split('\n')[0]).toBe('A requester got an automated first answer to their support request and has now replied. Decide whether the reply says the problem is solved.');
    expect(call.extra.jsonSchema.properties.verdict.enum).toEqual(['resolved', 'needs_help', 'unclear']);
    expect(runnerMock.budgetState).toHaveBeenCalledWith(1);
  });

  test('"thanks" from the model is not a "resolved" for Auto-help', async () => {
    runnerMock.budgetState.mockResolvedValue({ exhausted: false });
    gatewayMock.sendJson.mockResolvedValue({ parsed: { verdict: 'thanks' } });
    expect((await followUp.classifyReply(1, 'Thank you, will give it a go tonight')).verdict).toBe('help');
  });
});

describe('out-of-office on FreshService-born replies', () => {
  // What FreshService gives us: the conversation object as rawPayload (no mail
  // headers), no subject, author_type NULL on the synced row.
  const fsEntry = (body) => ({
    eventType: 'customer_reply', authorType: null, title: null, bodyText: body,
    rawPayload: { id: 1043270001, body_text: body, incoming: true, private: false, source: 0, from_email: 'rita@example.com', to_emails: ['it@example.com'], user_id: 5 },
  });

  test.each([
    'Thank you for your email. I am currently out of the office until Monday, October 20 with limited access to email. For urgent matters, please contact the IT helpdesk. Kind regards, Rita',
    'I am out of the office and will return on Monday, October 20.',
    'I am currently out of the office and will be back on 20 October. Regards, Rita',
    'Automatic reply: I am out of the office until Monday.',
    'I am on vacation until Oct 20.\nI will return on Monday.',
  ])('recognised: %s', (body) => {
    expect(isOutOfOfficeReply(fsEntry(body))).toBe(true);
  });

  test.each([
    'I am out of the office until Monday, can someone test it?',
    'I am out of the office and will return on Monday. The printer is still broken.',
    'Thanks, but the second monitor still flickers.',
    'Back in the office now and the dock works, thanks!',
  ])('a real reply is never an out-of-office: %s', (body) => {
    expect(isOutOfOfficeReply(fsEntry(body))).toBe(false);
  });

  test('Auto-help keeps isAutoReplyEntry exactly as it was (the new wording is not added there)', () => {
    expect(isAutoReplyEntry(fsEntry('I am out of the office and will return on Monday, October 20.'))).toBe(false);
    expect(isAutoReplyEntry({ title: 'Automatic reply: VPN', bodyText: '' })).toBe(true);
  });

  test('the service reads an FS-born out-of-office as auto_reply without a model call', async () => {
    db = createFakePrisma({
      ticketThreadEntry: [{ id: 9, ticketId: 70, externalEntryId: 'fs-conversation:1043270001', isPrivate: false, ...fsEntry('I am out of the office and will return on Monday, October 20.') }],
    });
    const read = await replyReopen.readReply({ id: 70, workspaceId: 1, subject: 'Dock' }, { externalEntryId: 'fs-conversation:1043270001' });
    expect(read).toEqual({ verdict: 'auto_reply', via: 'auto_reply', entryId: 9 });
    expect(gatewayMock.sendJson).not.toHaveBeenCalled();
  });
});

describe('keyword fast paths', () => {
  test.each([
    ['Thanks!', 'confirmed'], ['Thank you so much!', 'confirmed'], ['ok thanks', 'confirmed'], ['Cheers', 'confirmed'],
    ['That worked, thanks!', 'confirmed'],
    ['Thanks, will try', null], ['Thanks but no', null], ['Thanks for your help', null], ['Thanks?', null],
  ])('classifyThanksFast(%p) → %p', (text, want) => {
    expect(classifyThanksFast(text)).toBe(want);
  });

  test('Auto-help\'s fast path still needs a confirmation, not a bare thanks', () => {
    expect(classifyReplyFast('Thanks!')).toBeNull();
    expect(classifyReplyFast('That worked, thanks!')).toBe('confirmed');
  });
});
