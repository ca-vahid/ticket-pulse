/**
 * Mail loop guard (24 Nov 2026), the wire: a workflow e-mail says it is
 * automatic, and intake can read that back.
 *   - SendGrid API / SMTP: `Auto-Submitted: auto-generated` (RFC 3834) and
 *     `X-Ticket-Pulse-Mail: workflow`; nothing extra on other mail.
 *   - Graph sendMail: only `X-` names are accepted, so `X-Ticket-Pulse-Mail`.
 *   - Graph intake mapping: `ticketPulseMail` from any `X-Ticket-Pulse-*` header.
 * Invented addresses only.
 */
import { jest } from '@jest/globals';

const axiosPostMock = jest.fn();
const sendMailMock = jest.fn();
const settingsRepositoryMock = { getSendGridConfig: jest.fn() };
const calls = [];
const fakeClient = {
  api: (path) => ({
    post: async (body) => { calls.push({ method: 'POST', path, body }); return {}; },
    filter() { return this; }, select() { return this; }, top() { return this; },
    get: async () => ({ value: [] }),
  }),
};

jest.unstable_mockModule('axios', () => ({ default: { post: axiosPostMock } }));
jest.unstable_mockModule('nodemailer', () => ({ default: { createTransport: jest.fn(() => ({ sendMail: sendMailMock })) } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/services/emailHealthService.js', () => ({ default: { recordSuccess: jest.fn(), recordFailure: jest.fn() } }));
jest.unstable_mockModule('@azure/identity', () => ({ ClientSecretCredential: class {} }));
jest.unstable_mockModule('@microsoft/microsoft-graph-client', () => ({ Client: { initWithMiddleware: () => fakeClient } }));
jest.unstable_mockModule('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js', () => ({ TokenCredentialAuthenticationProvider: class {} }));
jest.unstable_mockModule('../src/config/index.js', () => ({ default: { graph: { tenantId: 'tenant', clientId: 'client', clientSecret: 'secret' } } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { sendEmail } = await import('../src/services/sendgridNotificationService.js');
const { default: graphMailClient, mapGraphMessageForIngest } = await import('../src/integrations/graphMailClient.js');

const AUTOMATIC = { 'Auto-Submitted': 'auto-generated', 'X-Ticket-Pulse-Mail': 'workflow' };

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  axiosPostMock.mockResolvedValue({ headers: { 'x-message-id': 'sg-1' } });
  sendMailMock.mockResolvedValue({ messageId: '<smtp-1@ourco.example>' });
});

describe('SendGrid lane', () => {
  test('API: the automatic headers ride the payload beside the threading headers', async () => {
    settingsRepositoryMock.getSendGridConfig.mockResolvedValue({ apiKey: 'SG.test', fromEmail: 'ticketpulse@ourco.example' });
    await sendEmail({ to: 'jo.park@client.example', subject: 'Ticket received', text: 'Hello', headers: AUTOMATIC, ticketIdForMessageId: 3101 });
    const payload = axiosPostMock.mock.calls[0][1];
    expect(payload.headers).toMatchObject(AUTOMATIC);
    expect(payload.headers['Message-ID']).toMatch(/^<tp-3101-/);
  });

  test('API: other mail is unchanged (no headers at all without threading)', async () => {
    settingsRepositoryMock.getSendGridConfig.mockResolvedValue({ apiKey: 'SG.test', fromEmail: 'ticketpulse@ourco.example' });
    await sendEmail({ to: 'jo.park@client.example', subject: 'Hello', text: 'Hello' });
    expect(axiosPostMock.mock.calls[0][1].headers).toBeUndefined();
  });

  test('SMTP: the automatic headers join the delivery-id headers; unsafe names and line breaks are dropped', async () => {
    settingsRepositoryMock.getSendGridConfig.mockResolvedValue({
      smtpConfigured: true, smtpHost: 'smtp.example', smtpUser: 'u', smtpPassword: 'p', smtpFromEmail: 'ticketpulse@ourco.example',
    });
    await sendEmail({
      to: 'jo.park@client.example', subject: 'Ticket received', text: 'Hello', customArgs: { delivery_id: '701' },
      headers: { ...AUTOMATIC, 'Bad Name': 'x', 'X-Note': 'one\r\nBcc: evil@example.com' },
    });
    const { headers } = sendMailMock.mock.calls[0][0];
    expect(headers).toMatchObject({ ...AUTOMATIC, 'X-Ticket-Pulse-delivery-id': '701', 'X-Note': 'one Bcc: evil@example.com' });
    expect(headers['Bad Name']).toBeUndefined();
  });
});

describe('Graph lane', () => {
  test('sendMail carries X- headers only (Graph refuses others)', async () => {
    await graphMailClient.sendMailAsMailbox('ap@ourco.example', {
      to: ['jo.park@client.example'], subject: 'Ticket received', html: '<p>Hello</p>', headers: AUTOMATIC,
    });
    const send = calls.find((c) => c.path.endsWith('/sendMail'));
    expect(send.body.message.internetMessageHeaders).toEqual([{ name: 'X-Ticket-Pulse-Mail', value: 'workflow' }]);
  });

  test('no headers asked for: none sent (as before)', async () => {
    await graphMailClient.sendMailAsMailbox('ap@ourco.example', { to: ['jo.park@client.example'], subject: 'Hi', html: '<p>Hi</p>' });
    expect(calls.find((c) => c.path.endsWith('/sendMail')).body.message.internetMessageHeaders).toBeUndefined();
  });

  test('intake mapping reads our mark back', () => {
    const base = { id: 'g1', from: { emailAddress: { address: 'ar@ourco.example' } }, receivedDateTime: '2026-11-24T23:05:00Z' };
    expect(mapGraphMessageForIngest({ ...base, internetMessageHeaders: [{ name: 'X-Ticket-Pulse-Mail', value: 'workflow' }] }).ticketPulseMail).toBe('workflow');
    expect(mapGraphMessageForIngest({ ...base, internetMessageHeaders: [{ name: 'X-Ticket-Pulse-delivery-id', value: '701' }] }).ticketPulseMail).toBe('header');
    expect(mapGraphMessageForIngest({ ...base, internetMessageHeaders: [{ name: 'Auto-Submitted', value: 'auto-generated' }] })).toMatchObject({ ticketPulseMail: null, autoSubmitted: 'auto-generated' });
  });
});
