import { describe, expect, test } from 'vitest';
import { activityActorKind, isMachineActivity } from '../tickets/activityKind.jsx';
import {
  abilitiesOf, abilitySentence, agoWords, expiryWords, lastUsedWords, parseIpList, personalKeyNameOf,
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
    expect(expiryWords({ expiresAt: new Date(NOW + 90 * 24 * HOUR).toISOString(), status: 'active' }, NOW)).toMatch(/^Feb 20, 2027 \(in 90 days\)$/);
    expect(expiryWords({ expiresAt: '2026-11-01T07:30:00.000Z', status: 'expired' }, NOW)).toBe('Expired Nov 1, 2026');
    // 00:30 UTC on 1 Dec is still 30 Nov in Vancouver.
    expect(expiryWords({ expiresAt: '2026-12-01T00:30:00.000Z', status: 'active' }, NOW)).toMatch(/^Nov 30, 2026/);
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
