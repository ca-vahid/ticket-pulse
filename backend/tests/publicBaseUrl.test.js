/**
 * 18 Sep 2026 — an approver received an e-mail whose Reply button opened
 * `localhost:5173` on his own PC. The message had been sent by a repair script run
 * from a developer machine against the PRODUCTION database; none of the public-URL
 * variables were set locally, and eight services each fell through, silently, to
 * localhost. The rule these tests pin: a localhost link is never produced
 * alongside a remote database.
 */
import { jest } from '@jest/globals';
import {
  PRODUCTION_PUBLIC_URL, databaseIsRemote, isLocalUrl, resolvePublicBaseUrl, _resetPublicBaseUrlWarning,
} from '../src/utils/publicBaseUrl.js';

const REMOTE_DB = 'postgresql://user:pw@ticket-pulse-db.postgres.database.azure.com:5432/tp?sslmode=require';
const LOCAL_DB = 'postgresql://postgres:pw@localhost:5432/ticketpulse';

beforeEach(() => _resetPublicBaseUrlWarning());

describe('resolvePublicBaseUrl', () => {
  test('the incident: nothing configured + production database → the production address, with one warning', () => {
    const warn = jest.fn();
    expect(resolvePublicBaseUrl({ env: { DATABASE_URL: REMOTE_DB }, warn })).toBe(PRODUCTION_PUBLIC_URL);
    expect(resolvePublicBaseUrl({ env: { DATABASE_URL: REMOTE_DB }, warn })).toBe(PRODUCTION_PUBLIC_URL);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/not configured while DATABASE_URL is remote/);
  });

  test('a localhost value configured locally is ALSO refused when the database is remote', () => {
    const warn = jest.fn();
    expect(resolvePublicBaseUrl({ env: { FRONTEND_URL: 'http://localhost:5173', DATABASE_URL: REMOTE_DB }, warn })).toBe(PRODUCTION_PUBLIC_URL);
    expect(warn.mock.calls[0][0]).toMatch(/is local \(http:\/\/localhost:5173\)/);
  });

  test('a fully local setup keeps localhost — development is unchanged', () => {
    const warn = jest.fn();
    expect(resolvePublicBaseUrl({ env: { DATABASE_URL: LOCAL_DB }, warn })).toBe('http://localhost:5173');
    expect(resolvePublicBaseUrl({ env: { FRONTEND_URL: 'http://127.0.0.1:5173/', DATABASE_URL: LOCAL_DB }, warn })).toBe('http://127.0.0.1:5173');
    expect(resolvePublicBaseUrl({ env: {}, warn })).toBe('http://localhost:5173');
    expect(warn).not.toHaveBeenCalled();
  });

  test('production: PUBLIC_APP_URL wins, trailing slashes trimmed, no warning', () => {
    const warn = jest.fn();
    const env = { PUBLIC_APP_URL: 'https://ticketpulse.bgcsaas.com//', CORS_ORIGIN: 'https://a.example,https://b.example', DATABASE_URL: REMOTE_DB };
    expect(resolvePublicBaseUrl({ env, warn })).toBe('https://ticketpulse.bgcsaas.com');
    expect(warn).not.toHaveBeenCalled();
  });

  test('precedence: PUBLIC_APP_URL > FRONTEND_PUBLIC_URL > FRONTEND_URL > APP_URL > first CORS origin > fallback', () => {
    const base = { DATABASE_URL: REMOTE_DB };
    expect(resolvePublicBaseUrl({ env: { ...base, FRONTEND_PUBLIC_URL: 'https://fp.example', FRONTEND_URL: 'https://f.example' } })).toBe('https://fp.example');
    expect(resolvePublicBaseUrl({ env: { ...base, FRONTEND_URL: 'https://f.example', APP_URL: 'https://app.example' } })).toBe('https://f.example');
    expect(resolvePublicBaseUrl({ env: { ...base, APP_URL: 'https://app.example', CORS_ORIGIN: 'https://c.example' } })).toBe('https://app.example');
    expect(resolvePublicBaseUrl({ env: base, fallback: 'https://from-request.example' })).toBe('https://from-request.example');
  });

  test('CORS_ORIGIN with several origins yields the FIRST one, never the raw comma list', () => {
    // agentAlertService and ticketTaskService used to read CORS_ORIGIN unsplit.
    const env = { CORS_ORIGIN: ' https://one.example , https://two.example ', DATABASE_URL: REMOTE_DB };
    expect(resolvePublicBaseUrl({ env })).toBe('https://one.example');
  });
});

describe('helpers', () => {
  test('isLocalUrl', () => {
    for (const u of ['http://localhost:5173', 'http://127.0.0.1', 'http://[::1]:3000', 'http://host.docker.internal:5173', '', 'not a url']) expect(isLocalUrl(u)).toBe(true);
    for (const u of ['https://ticketpulse.bgcsaas.com', 'https://localhost.example.com']) expect(isLocalUrl(u)).toBe(false);
  });
  test('databaseIsRemote', () => {
    expect(databaseIsRemote({ DATABASE_URL: REMOTE_DB })).toBe(true);
    expect(databaseIsRemote({ DATABASE_URL: LOCAL_DB })).toBe(false);
    expect(databaseIsRemote({ DATABASE_URL: 'postgres://u:p@127.0.0.1/db' })).toBe(false);
    expect(databaseIsRemote({})).toBe(false);
    expect(databaseIsRemote({ DATABASE_URL: 'garbage' })).toBe(false);
  });
});

describe('no service keeps its own localhost fallback', () => {
  test('services resolve the base through the shared helper', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/services');
    const offenders = [];
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.js')) continue;
      if ((await readFile(resolve(dir, f), 'utf8')).includes('localhost:5173')) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
