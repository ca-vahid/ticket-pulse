import { jest } from '@jest/globals';

/**
 * Reply greeting + sign-off (QA 09-18 #4): per-workspace wording in
 * app_settings, placeholders filled from the ticket and the agent, unknown
 * tokens dropped rather than mailed literally, reads that fail closed.
 */

const store = new Map();
const settingsRepositoryMock = {
  get: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
  set: jest.fn(async (key, value) => { store.set(key, value); }),
};
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const svc = await import('../src/services/replyGreetingService.js');

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  svc.clearReplyGreetingCache();
});

describe('replyGreetingService', () => {
  test('defaults: off, FreshService-style greeting, a sign-off with the agent name', async () => {
    const cfg = await svc.getReplyGreetingSettings(1);
    expect(cfg).toEqual({ enabled: false, greeting: 'Hi {{requester.firstName}},', signoff: 'Thank you,\n{{agent.firstName}}' });
  });

  test('set merges a partial patch, stores JSON under reply_greeting_ws<N>, and the next read sees it', async () => {
    await svc.setReplyGreetingSettings(4, { enabled: true });
    expect(settingsRepositoryMock.set).toHaveBeenCalledWith('reply_greeting_ws4', expect.stringContaining('"enabled":true'));
    const after = await svc.setReplyGreetingSettings(4, { greeting: 'Hello {{requester.name}},' });
    expect(after).toEqual({ enabled: true, greeting: 'Hello {{requester.name}},', signoff: 'Thank you,\n{{agent.firstName}}' });
    expect(await svc.getReplyGreetingSettings(4)).toEqual(after);
  });

  test('a broken settings read is treated as off, never thrown', async () => {
    settingsRepositoryMock.get.mockRejectedValueOnce(new Error('db down'));
    const cfg = await svc.getReplyGreetingSettings(2);
    expect(cfg.enabled).toBe(false);
  });

  test('lines are capped and CRLF normalized', () => {
    const cfg = svc.normalizeGreetingSettings({ enabled: 'yes', greeting: 'a\r\nb', signoff: 'x'.repeat(500) });
    expect(cfg.enabled).toBe(false);
    expect(cfg.greeting).toBe('a\nb');
    expect(cfg.signoff).toHaveLength(400);
  });

  test('placeholders fill from the ticket and the agent; unknown tokens vanish; no requester name falls back to "there"', () => {
    const ctx = { requester: { name: 'Jenny Kolada-Tran', email: 'jkoladatran@x.io' }, agent: { name: 'Andrii Grynik' }, ticket: { displayRef: 'TP-1560', subject: 'Rental queries' } };
    expect(svc.fillGreetingPlaceholders('Hi {{requester.firstName}}, re {{ticket.ref}} ({{ ticket.subject }}) — {{agent.name}} / {{agent.firstName}}', ctx))
      .toBe('Hi Jenny, re TP-1560 (Rental queries) — Andrii Grynik / Andrii');
    expect(svc.fillGreetingPlaceholders('Hi {{requester.firstName}} {{nope.token}}!', { requester: { email: 'roger.hsu@x.io' } })).toBe('Hi Roger !');
    expect(svc.fillGreetingPlaceholders('Hi {{requester.firstName}},', {})).toBe('Hi there,');
  });
});
