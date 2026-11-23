import { describe, expect, test } from 'vitest';
import { activityActorKind, isMachineActivity } from '../tickets/activityKind.jsx';
import {
  abilitiesOf, abilitySentence, agoWords, expiryParts, expiryShort, expiryWords, formatDayShort, keySummaryLine,
  lastUsedParts, lastUsedPhrase, lastUsedWords, parseIpList, personalKeyNameOf, rotationExpiry,
} from './personalKeyText';

const NOW = Date.parse('2026-11-22T18:00:00.000Z');
const HOUR = 3600e3;

describe('personal key words', () => {
  test('abilities: read is always there; scopes map too; display order is fixed', () => {
    expect(abilitiesOf({ abilities: [] })).toEqual(['read']);
    expect(abilitiesOf({ abilities: ['tasks', 'reply'] })).toEqual(['read', 'reply', 'tasks']);
    expect(abilitiesOf({ scopes: ['tickets:read', 'conversations:write', 'tickets:write', 'timeentries:write'] }))
      .toEqual(['read', 'reply', 'update', 'tasks']);
    expect(abilitySentence({ abilities: ['read'] })).toBe('Read tickets only');
    expect(abilitySentence({ abilities: ['read', 'reply', 'update', 'tasks'] }))
      .toBe('Read tickets · Reply and add notes · Update tickets · Tasks and time');
  });

  test('last used: "2 hours ago from 10.1.2.3"', () => {
    expect(lastUsedWords({ lastUsedAt: new Date(NOW - 2 * HOUR).toISOString(), lastUsedIp: '10.1.2.3' }, NOW)).toBe('2 hours ago from 10.1.2.3');
    expect(lastUsedWords({ lastUsedAt: new Date(NOW - 60e3).toISOString() }, NOW)).toBe('1 minute ago');
    expect(lastUsedWords({ lastUsedAt: null }, NOW)).toBe('Not used yet');
    expect(agoWords(new Date(NOW - 10e3).toISOString(), NOW)).toBe('just now');
    expect(agoWords(new Date(NOW - 3 * 24 * HOUR).toISOString(), NOW)).toBe('3 days ago');
  });

  test('expiry in Pacific time, with days left or "Expired"', () => {
    expect(expiryWords({ expiresAt: new Date(NOW + 90 * 24 * HOUR).toISOString(), status: 'active' }, NOW)).toBe('Expires Feb 20, 2027 (in 90 days)');
    expect(expiryWords({ expiresAt: '2026-11-01T07:30:00.000Z', status: 'expired' }, NOW)).toBe('Expired Nov 1, 2026');
    // A switched-off key past its date reads "Expired", never "Expires Expired".
    expect(expiryWords({ expiresAt: '2026-11-01T07:30:00.000Z', status: 'disabled' }, NOW)).toBe('Expired Nov 1, 2026');
    // 00:30 UTC on 1 Dec is still 30 Nov in Vancouver.
    expect(expiryWords({ expiresAt: '2026-12-01T00:30:00.000Z', status: 'active' }, NOW)).toMatch(/^Expires Nov 30, 2026/);
    expect(expiryShort({ expiresAt: new Date(NOW + 90 * 24 * HOUR).toISOString(), status: 'active' }, NOW)).toBe('Expires Feb 20, 2027');
  });

  test('last used as a whole phrase; "made" dates drop this year', () => {
    expect(lastUsedPhrase({ lastUsedAt: new Date(NOW - 2 * HOUR).toISOString(), lastUsedIp: '10.1.2.3' }, NOW)).toBe('Last used 2 hours ago from 10.1.2.3');
    expect(lastUsedPhrase({ lastUsedAt: null }, NOW)).toBe('Not used yet');
    // Older than a month: the date, without a stray "on".
    expect(lastUsedPhrase({ lastUsedAt: '2026-10-09T19:00:00.000Z' }, NOW)).toBe('Last used Oct 9, 2026');
    expect(formatDayShort('2026-11-22T17:00:00.000Z', NOW)).toBe('Nov 22');
    expect(formatDayShort('2025-03-04T20:00:00.000Z', NOW)).toBe('Mar 4, 2025');
  });

  test('table cells: whole phrases on their own lines', () => {
    const live = { expiresAt: new Date(NOW + 90 * 24 * HOUR).toISOString(), status: 'active' };
    expect(expiryParts(live, NOW)).toEqual({ date: 'Feb 20, 2027', note: 'in 90 days' });
    expect(expiryParts({ expiresAt: '2026-11-01T07:30:00.000Z', status: 'expired' }, NOW)).toEqual({ date: 'Nov 1, 2026', note: null });
    expect(expiryParts({ ...live, status: 'revoked' }, NOW)).toEqual({ date: 'Feb 20, 2027', note: null });
    expect(expiryParts({ expiresAt: '2026-11-01T07:30:00.000Z', status: 'disabled' }, NOW)).toEqual({ date: 'Nov 1, 2026', note: 'Expired' });
    expect(expiryParts({ expiresAt: null }, NOW)).toEqual({ date: 'No end date', note: null });
    expect(lastUsedParts({ lastUsedAt: new Date(NOW - 2 * HOUR).toISOString(), lastUsedIp: '203.0.113.24' }, NOW)).toEqual({ when: '2 hours ago', from: 'from 203.0.113.24' });
    expect(lastUsedParts({ lastUsedAt: '2026-10-09T19:00:00.000Z' }, NOW)).toEqual({ when: 'Oct 9, 2026', from: null });
    expect(lastUsedParts({ lastUsedAt: null }, NOW)).toEqual({ when: 'Not used yet', from: null });
  });

  test('stacked status line says each word once', () => {
    const used = { lastUsedAt: new Date(NOW - 2 * HOUR).toISOString(), lastUsedIp: '203.0.113.24' };
    const ends = new Date(NOW + 90 * 24 * HOUR).toISOString();
    expect(keySummaryLine({ ...used, status: 'active', expiresAt: ends }, NOW)).toBe('On · Expires Feb 20, 2027 · Last used 2 hours ago from 203.0.113.24');
    expect(keySummaryLine({ ...used, status: 'disabled', expiresAt: ends }, NOW)).toBe('Switched off · Expires Feb 20, 2027 · Last used 2 hours ago from 203.0.113.24');
    expect(keySummaryLine({ status: 'expired', expiresAt: '2026-10-24T19:00:00.000Z', lastUsedAt: '2026-10-09T19:00:00.000Z', lastUsedIp: '203.0.113.9' }, NOW))
      .toBe('Expired Oct 24, 2026 · Last used Oct 9, 2026 from 203.0.113.9');
    expect(keySummaryLine({ status: 'revoked', revokedAt: '2026-11-02T19:00:00.000Z', expiresAt: ends, lastUsedAt: null }, NOW)).toBe('Revoked Nov 2, 2026 · Not used yet');
    expect(keySummaryLine({ status: 'revoked', expiresAt: ends, lastUsedAt: null }, NOW)).toBe('Revoked · Not used yet');
  });

  test('rotation restarts the same length from today', () => {
    const key = { createdAt: '2026-11-12T18:00:00.000Z', expiresAt: '2027-02-10T18:00:00.000Z' }; // 90 days
    expect(rotationExpiry(key, NOW)).toEqual({ days: 90, until: 'Feb 20, 2027' });
    expect(rotationExpiry({ createdAt: null, expiresAt: null }, NOW)).toBeNull();
  });

  test('IP box: one per line, commas tolerated, blanks dropped', () => {
    expect(parseIpList(' 10.1.2.3 \n\n203.0.113.0/24, 198.51.100.7\n')).toEqual(['10.1.2.3', '203.0.113.0/24', '198.51.100.7']);
    expect(parseIpList('')).toEqual([]);
  });

  test('history rows from a personal key are the person, not machine activity', () => {
    const row = { activityType: 'status_changed', performedBy: 'Dana Fox', details: { actorKind: 'personal_key', via: { kind: 'personal_key', keyId: 7, keyName: 'Reply assistant' } } };
    expect(activityActorKind(row)).toBe('personal_key');
    expect(isMachineActivity(row)).toBe(false);
  });

  test('thread marker name: only for personal keys', () => {
    expect(personalKeyNameOf({ rawPayload: { sentWithApiKey: { id: 7, name: ' Reply assistant ' } } })).toBe('Reply assistant');
    expect(personalKeyNameOf({ rawPayload: { sentWithApiKey: { id: 7, name: '' } } })).toBeNull();
    expect(personalKeyNameOf({ via: { kind: 'personal_key', keyName: 'Reply assistant' } })).toBe('Reply assistant');
    expect(personalKeyNameOf({ rawPayload: { via: { kind: 'personal_key', keyName: 'Night script' } } })).toBe('Night script');
    expect(personalKeyNameOf({ via: { keyName: 'No kind given' } })).toBe('No kind given');
    expect(personalKeyNameOf({ via: { kind: 'integration', keyName: 'X' } })).toBeNull();
    expect(personalKeyNameOf({})).toBeNull();
  });
});
