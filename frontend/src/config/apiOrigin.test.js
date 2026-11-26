import { describe, expect, test } from 'vitest';
import { PRIMARY_API_ORIGIN, currentApiOrigin, resolveApiOrigin } from './apiOrigin';

describe('resolveApiOrigin (25 Nov 2026: ticketpulse.bgcsi.com is the main address)', () => {
  test('the new web host always calls the API on the same site', () => {
    expect(resolveApiOrigin({ hostname: 'ticketpulse.bgcsi.com', envUrl: 'https://api.ticketpulse.bgcsaas.com' }))
      .toBe('https://api.ticketpulse.bgcsi.com');
    expect(resolveApiOrigin({ hostname: 'TicketPulse.BGCSI.com' })).toBe(PRIMARY_API_ORIGIN);
  });

  test('every other host keeps the build-time VITE_API_URL', () => {
    const envUrl = 'https://api.ticketpulse.bgcsaas.com';
    for (const hostname of ['ticketpulse.bgcsaas.com', 'localhost', 'brave-dune-056d0421e.azurestaticapps.net', 'evil.ticketpulse.bgcsi.com.example']) {
      expect(resolveApiOrigin({ hostname, envUrl })).toBe(envUrl);
    }
  });

  test('look-alike hosts do not get the new API', () => {
    expect(resolveApiOrigin({ hostname: 'x.ticketpulse.bgcsi.com', envUrl: 'https://api.example.test' })).toBe('https://api.example.test');
    expect(resolveApiOrigin({ hostname: 'ticketpulse.bgcsi.com.example', envUrl: '' })).toBe('http://localhost:3000');
  });

  test('trims trailing slashes and falls back when VITE_API_URL is unset', () => {
    expect(resolveApiOrigin({ hostname: 'localhost', envUrl: 'http://localhost:3000///' })).toBe('http://localhost:3000');
    expect(resolveApiOrigin({ hostname: 'localhost', envUrl: '' })).toBe('http://localhost:3000');
    expect(resolveApiOrigin({ hostname: 'localhost', envUrl: undefined, fallback: '' })).toBe('');
    expect(resolveApiOrigin({ hostname: 'localhost', fallback: 'https://web.example.test/' })).toBe('https://web.example.test');
    expect(resolveApiOrigin()).toBe('http://localhost:3000');
  });

  test('currentApiOrigin reads the test page host (not the new host)', () => {
    const env = String(import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
    expect(currentApiOrigin()).toBe(env || 'http://localhost:3000');
    expect(currentApiOrigin({ fallback: '' })).toBe(env);
  });
});
