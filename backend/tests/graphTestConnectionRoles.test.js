import { jest } from '@jest/globals';

/**
 * Phase RL (RL-7) — the mailbox Test proves SEND capability: the app token's
 * `roles` claim decides canRead / canSend / canThread; unknown roles are
 * reported as null (never a tick); a Mail.Send-less token fails the test in
 * send/both mode.
 */

let inboxFails = false;
const fakeClient = {
  api: (path) => ({
    top() { return this; },
    select() { return this; },
    get: async () => {
      if (inboxFails) { const e = new Error('Access is denied'); e.statusCode = 403; e.code = 'ErrorAccessDenied'; throw e; }
      return { value: [{ id: 'm1', subject: 'Latest', receivedDateTime: '2026-09-01T15:00:00Z' }], path };
    },
  }),
};

function jwtWithRoles(roles) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64({ aud: 'https://graph.microsoft.com', roles })}.sig`;
}
let tokenRoles = ['Mail.Read', 'Mail.Send'];
let tokenBroken = false;

class FakeCredential {
  async getToken() {
    if (tokenBroken) throw new Error('AADSTS7000215');
    return { token: jwtWithRoles(tokenRoles) };
  }
}

jest.unstable_mockModule('@azure/identity', () => ({ ClientSecretCredential: FakeCredential }));
jest.unstable_mockModule('@microsoft/microsoft-graph-client', () => ({ Client: { initWithMiddleware: () => fakeClient } }));
jest.unstable_mockModule('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js', () => ({ TokenCredentialAuthenticationProvider: class {} }));
jest.unstable_mockModule('../src/config/index.js', () => ({ default: { graph: { tenantId: 't', clientId: 'c', clientSecret: 's' } } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: graphMailClient, decodeTokenRoles, capabilitiesFromRoles, mintInternetMessageId } = await import('../src/integrations/graphMailClient.js');

beforeEach(() => {
  inboxFails = false;
  tokenBroken = false;
  tokenRoles = ['Mail.Read', 'Mail.Send'];
});

describe('helpers', () => {
  test('decodeTokenRoles reads the roles claim (base64url) and returns null for garbage', () => {
    expect(decodeTokenRoles(jwtWithRoles(['Mail.ReadWrite', 'Mail.Send']))).toEqual(['Mail.ReadWrite', 'Mail.Send']);
    expect(decodeTokenRoles('not-a-jwt')).toBeNull();
    expect(decodeTokenRoles(null)).toBeNull();
  });
  test('capabilitiesFromRoles: Mail.Read|ReadWrite → read, Mail.Send → send, Mail.ReadWrite → thread; unknown → nulls', () => {
    expect(capabilitiesFromRoles(['Mail.Read', 'Mail.Send'])).toEqual({ canRead: true, canSend: true, canThread: false });
    expect(capabilitiesFromRoles(['Mail.ReadWrite', 'Mail.Send'])).toEqual({ canRead: true, canSend: true, canThread: true });
    expect(capabilitiesFromRoles(['Mail.ReadWrite'])).toEqual({ canRead: true, canSend: false, canThread: true });
    expect(capabilitiesFromRoles(null)).toEqual({ canRead: null, canSend: null, canThread: null });
  });
  test('mintInternetMessageId uses the mailbox domain and the RFC angle-bracket form', () => {
    expect(mintInternetMessageId('patickets@bgcengineering.ca')).toMatch(/^<tp-\d+-[a-z0-9]+@bgcengineering\.ca>$/);
  });
});

describe('testConnection (RL-7)', () => {
  test('Mail.Read + Mail.Send → success, canThread false (no ReadWrite) in both mode', async () => {
    const r = await graphMailClient.testConnection('patickets@bgcengineering.ca', { mode: 'both' });
    expect(r).toMatchObject({ success: true, canRead: true, canSend: true, canThread: false, roles: ['Mail.Read', 'Mail.Send'], recentCount: 1, latestSubject: 'Latest', mode: 'both' });
    expect(r.message).toMatch(/replies cannot be header-threaded — Mail.ReadWrite is not granted/);
  });
  test('Mail.Read only in send/both mode → success:false, canSend:false with the exact reason', async () => {
    tokenRoles = ['Mail.Read'];
    const r = await graphMailClient.testConnection('patickets@bgcengineering.ca', { mode: 'both' });
    expect(r).toMatchObject({ success: false, canRead: true, canSend: false, canThread: false });
    expect(r.message).toMatch(/cannot SEND from it — Mail.Send is not granted/);
    // ingest-only mailboxes do not need Mail.Send
    const ingest = await graphMailClient.testConnection('patickets@bgcengineering.ca', { mode: 'ingest' });
    expect(ingest.success).toBe(true);
  });
  test('all three roles → clean success', async () => {
    tokenRoles = ['Mail.Read', 'Mail.ReadWrite', 'Mail.Send'];
    const r = await graphMailClient.testConnection('patickets@bgcengineering.ca', { mode: 'send' });
    expect(r).toMatchObject({ success: true, canRead: true, canSend: true, canThread: true, message: 'Connected successfully to patickets@bgcengineering.ca' });
  });
  test('token cannot be decoded → capabilities null (unknown), the inbox read still decides success', async () => {
    tokenBroken = true;
    const r = await graphMailClient.testConnection('patickets@bgcengineering.ca', { mode: 'both' });
    expect(r).toMatchObject({ success: true, canRead: true, canSend: null, canThread: null, roles: null });
  });
  test('inbox read refused → success:false, canRead:false, roles still reported', async () => {
    inboxFails = true;
    const r = await graphMailClient.testConnection('patickets@bgcengineering.ca', { mode: 'both' });
    expect(r).toMatchObject({ success: false, canRead: false, canSend: true, canThread: false, roles: ['Mail.Read', 'Mail.Send'] });
  });
});
