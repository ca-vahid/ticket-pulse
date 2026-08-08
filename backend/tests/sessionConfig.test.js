/**
 * Phase 2 (QA 08-07 #15) — 7-day sliding sessions.
 *
 * Users were signed out 2-3x/day because three independent ABSOLUTE 8h clocks
 * expired out of sync (session cookie, 3x JWT `expiresIn:'8h'` literals,
 * MSAL). These tests pin the fix: one 7d config value feeding the cookie AND
 * every JWT sign site, plus `rolling:true` so the cookie window slides.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import jwt from 'jsonwebtoken';
import config from '../src/config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_SEC = SEVEN_DAYS_MS / 1000;

describe('session config (7-day sliding window)', () => {
  test('cookie maxAge is 7 days', () => {
    expect(config.session.maxAge).toBe(SEVEN_DAYS_MS);
  });

  test('jwtExpiresIn is the single 7d source of truth and is a valid expiresIn', () => {
    expect(config.session.jwtExpiresIn).toBe('7d');
    const token = jwt.sign({ sub: 'test' }, 'test-secret', {
      algorithm: 'HS256',
      expiresIn: config.session.jwtExpiresIn,
    });
    const decoded = jwt.decode(token);
    expect(decoded.exp - decoded.iat).toBe(SEVEN_DAYS_SEC);
  });

  test('express-session is configured rolling (cookie re-issued per response)', () => {
    const appSrc = readSrc('app.js');
    expect(appSrc).toMatch(/rolling:\s*true/);
    // connect-pg-simple derives row expiry from the cookie; prune interval is
    // relaxed to hourly (seconds) — sane at a 7-day TTL.
    expect(appSrc).toMatch(/pruneSessionInterval:\s*60\s*\*\s*60/);
  });

  test('all three JWT sign sites use config.session.jwtExpiresIn (no 8h literals left)', () => {
    const authSrc = readSrc(path.join('routes', 'auth.routes.js'));
    const wsSrc = readSrc(path.join('routes', 'workspace.routes.js'));

    expect(authSrc).not.toMatch(/expiresIn:\s*'8h'/);
    expect(wsSrc).not.toMatch(/expiresIn:\s*'8h'/);

    const authSites = authSrc.match(/expiresIn:\s*config\.session\.jwtExpiresIn/g) || [];
    const wsSites = wsSrc.match(/expiresIn:\s*config\.session\.jwtExpiresIn/g) || [];
    expect(authSites).toHaveLength(2); // login + SSO exchange
    expect(wsSites).toHaveLength(1); // workspace select re-mint
  });
});
