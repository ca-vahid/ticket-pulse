import { describe, expect, test } from '@jest/globals';
import { resolveApiPublicBase, apiPublicOrigin, isKnownApiHost, PRODUCTION_API_ORIGIN } from '../src/utils/apiPublicBase.js';

// A minimal Express-like request: headers are matched case-insensitively.
function req(headers = {}, protocol = 'http') {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { protocol, get: (name) => h[String(name).toLowerCase()] };
}

const PROD = { NODE_ENV: 'production', PUBLIC_APP_URL: 'https://tickets.example.com' };
const API_HOST = /^https?:\/\/(api\.ticketpulse\.bgcsaas\.com|api\.ticketpulse\.bgcsi\.com|ticket-pulse-app\.azurewebsites\.net|localhost(:\d+)?|127\.0\.0\.1(:\d+)?|api\.example\.com)$/;

describe('resolveApiPublicBase', () => {
  test.each([
    'api.ticketpulse.bgcsaas.com',
    'api.ticketpulse.bgcsi.com',
    'ticket-pulse-app.azurewebsites.net',
  ])('a known API host (%s) is used as-is, always https', (host) => {
    expect(resolveApiPublicBase(req({ host }, 'http'), { env: PROD })).toBe(`https://${host}`);
  });

  test('host matching ignores case and a default port', () => {
    expect(resolveApiPublicBase(req({ host: 'API.TicketPulse.bgcsi.com' }), { env: PROD })).toBe('https://api.ticketpulse.bgcsi.com');
    expect(resolveApiPublicBase(req({ host: 'api.ticketpulse.bgcsi.com:443' }), { env: PROD })).toBe('https://api.ticketpulse.bgcsi.com');
  });

  test('x-forwarded-host wins over Host when it is a known API host', () => {
    const r = req({ host: 'ticket-pulse-app.azurewebsites.net', 'x-forwarded-host': 'api.ticketpulse.bgcsi.com', 'x-forwarded-proto': 'https' });
    expect(resolveApiPublicBase(r, { env: PROD })).toBe('https://api.ticketpulse.bgcsi.com');
  });

  test('a list of forwarded hosts uses the first', () => {
    const r = req({ host: '10.0.0.4', 'x-forwarded-host': 'api.ticketpulse.bgcsaas.com, 10.0.0.4' });
    expect(resolveApiPublicBase(r, { env: PROD })).toBe('https://api.ticketpulse.bgcsaas.com');
  });

  test('a spoofed x-forwarded-host is ignored and the real Host is used', () => {
    const r = req({ host: 'api.ticketpulse.bgcsaas.com', 'x-forwarded-host': 'evil.example.com' });
    expect(resolveApiPublicBase(r, { env: PROD })).toBe('https://api.ticketpulse.bgcsaas.com');
  });

  test.each([
    'evil.example.com',
    'api.ticketpulse.bgcsaas.com.evil.example.com',
    'api.ticketpulse.bgcsaas.com@evil.example.com',
    'evil.example.com/api.ticketpulse.bgcsaas.com',
    'tickets.example.com',
  ])('a spoofed or unknown host (%s) falls back to the configured API', (host) => {
    expect(resolveApiPublicBase(req({ host, 'x-forwarded-host': host }), { env: PROD })).toBe(PRODUCTION_API_ORIGIN);
  });

  test('the web host (PUBLIC_APP_URL) is never returned', () => {
    const r = req({ host: 'tickets.example.com', 'x-forwarded-host': 'tickets.example.com', 'x-forwarded-proto': 'https' });
    const base = resolveApiPublicBase(r, { env: PROD });
    expect(base).not.toBe(PROD.PUBLIC_APP_URL);
    expect(base).toMatch(API_HOST);
  });

  test('API_PUBLIC_URL is accepted as a request host and is the fallback', () => {
    const env = { ...PROD, API_PUBLIC_URL: 'https://api.example.com/' };
    expect(resolveApiPublicBase(req({ host: 'api.example.com' }), { env })).toBe('https://api.example.com');
    expect(resolveApiPublicBase(req({ host: 'evil.example.com' }), { env })).toBe('https://api.example.com');
    expect(resolveApiPublicBase(null, { env })).toBe('https://api.example.com');
  });

  test('localhost is accepted in development with the request protocol, never in production', () => {
    const dev = { NODE_ENV: 'development' };
    expect(resolveApiPublicBase(req({ host: 'localhost:3000' }), { env: dev })).toBe('http://localhost:3000');
    expect(resolveApiPublicBase(req({ host: '127.0.0.1:3000', 'x-forwarded-proto': 'https' }), { env: dev })).toBe('https://127.0.0.1:3000');
    expect(resolveApiPublicBase(req({ host: 'localhost:3000' }), { env: PROD })).toBe(PRODUCTION_API_ORIGIN);
  });

  test('no request and no settings falls back to the production API, not the web app', () => {
    expect(resolveApiPublicBase(null, { env: { PUBLIC_APP_URL: 'https://tickets.example.com' } })).toBe(PRODUCTION_API_ORIGIN);
    expect(resolveApiPublicBase(req({}), { env: PROD })).toBe(PRODUCTION_API_ORIGIN);
  });
});

describe('apiPublicOrigin', () => {
  test('explicit settings first, production API in production, empty otherwise', () => {
    expect(apiPublicOrigin({ PUBLIC_API_URL: 'https://api.example.com/' })).toBe('https://api.example.com');
    expect(apiPublicOrigin({ GRAPH_NOTIFICATION_BASE_URL: 'https://graph.example.com' })).toBe('https://graph.example.com');
    expect(apiPublicOrigin({ NODE_ENV: 'production' })).toBe(PRODUCTION_API_ORIGIN);
    expect(apiPublicOrigin({ NODE_ENV: 'test', PUBLIC_APP_URL: 'https://tickets.example.com' })).toBe('');
  });
});

describe('isKnownApiHost', () => {
  test('known hosts and URLs pass, web and foreign hosts do not', () => {
    expect(isKnownApiHost('api.ticketpulse.bgcsi.com', PROD)).toBe(true);
    expect(isKnownApiHost('https://ticket-pulse-app.azurewebsites.net', PROD)).toBe(true);
    expect(isKnownApiHost('tickets.example.com', PROD)).toBe(false);
    expect(isKnownApiHost('evil.example.com', PROD)).toBe(false);
  });
});
