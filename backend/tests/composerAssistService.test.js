import { jest } from '@jest/globals';

const gateway = { sendJson: jest.fn() };
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: gateway }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: service, checkRate, resetRateForTests, ASSIST_ACTIONS } = await import('../src/services/composerAssistService.js');

beforeEach(() => {
  jest.clearAllMocks();
  resetRateForTests();
  gateway.sendJson.mockResolvedValue({ parsed: { text: 'Done.' }, provider: 'anthropic', model: 'claude-haiku-5-5' });
});

const base = { workspaceId: 1, actorEmail: 'Ada@X.io', action: 'improve', text: 'pls restart teh laptop' };

describe('composer writing help', () => {
  test('its own operation, economy call, and nothing but the text, subject and first name in the prompt', async () => {
    const out = await service.assist({ ...base, action: 'notes_to_reply', subject: 'Laptop will not wake', firstName: 'Priya Raman' });
    expect(out).toEqual({ text: 'Done.', action: 'notes_to_reply', provider: 'anthropic', model: 'claude-haiku-5-5' });
    const call = gateway.sendJson.mock.calls[0][0];
    expect(call.operation).toBe('composer_assist');
    expect(call.workspaceId).toBe(1);
    expect(call.userMessage).toContain('pls restart teh laptop');
    expect(call.userMessage).toContain('Requester\'s first name: Priya');
    expect(call.userMessage).not.toContain('Raman');
    expect(call.userMessage).not.toMatch(/ada@x\.io/i);
  });

  test('e-mail addresses and long numbers never leave: they travel as tokens and come back in place', async () => {
    gateway.sendJson.mockResolvedValue({ parsed: { text: 'Please call [[K1]] or write to [[K0]].' } });
    const out = await service.assist({ ...base, text: 'write priya.raman@example.org or call 6045550199 pls' });
    const sent = gateway.sendJson.mock.calls[0][0].userMessage;
    expect(sent).not.toContain('priya.raman@example.org');
    expect(sent).not.toContain('6045550199');
    expect(sent).toContain('[[K0]]');
    expect(out.text).toBe('Please call 6045550199 or write to priya.raman@example.org.');
  });

  test('refused before any AI call: unknown action, nothing to work on, too long', async () => {
    await expect(service.assist({ ...base, action: 'write_a_poem' })).rejects.toThrow(/writing actions/);
    await expect(service.assist({ ...base, text: '  ' })).rejects.toThrow(/select some text/);
    await expect(service.assist({ ...base, text: 'x'.repeat(6001) })).rejects.toThrow(/too long/);
    expect(gateway.sendJson).not.toHaveBeenCalled();
  });

  test('an empty answer is an error, not an empty suggestion', async () => {
    gateway.sendJson.mockResolvedValue({ parsed: { text: '  ' } });
    await expect(service.assist(base)).rejects.toMatchObject({ statusCode: 502 });
  });

  test('per-person rate limit: 12 a minute, 200 a day, by e-mail whatever its case', async () => {
    const t0 = Date.parse('2026-11-12T18:00:00Z');
    for (let i = 0; i < 12; i += 1) expect(checkRate('Ada@X.io', t0 + i).ok).toBe(true);
    expect(checkRate('ada@x.io', t0 + 20).ok).toBe(false);
    expect(checkRate('bo@x.io', t0 + 20).ok).toBe(true);
    expect(checkRate('ada@x.io', t0 + 61_000).ok).toBe(true);
    resetRateForTests();
    for (let i = 0; i < 200; i += 1) expect(checkRate('ada@x.io', t0 + i * 6000).ok).toBe(true);
    const over = checkRate('ada@x.io', t0 + 200 * 6000);
    expect(over.ok).toBe(false);
    expect(over.message).toMatch(/200/);
    await expect((async () => { for (let i = 0; i < 12; i += 1) checkRate('cy@x.io'); return service.assist({ ...base, actorEmail: 'cy@x.io' }); })()).rejects.toMatchObject({ statusCode: 429 });
  });

  test('every action has an instruction', () => {
    expect(Object.keys(ASSIST_ACTIONS)).toEqual(['improve', 'shorter', 'friendlier', 'formal', 'english', 'french', 'notes_to_reply']);
  });
});
