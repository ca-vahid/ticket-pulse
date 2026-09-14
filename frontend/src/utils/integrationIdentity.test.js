import { describe, expect, test } from 'vitest';
import { integrationIdentity } from './integrationIdentity';

describe('integrationIdentity — Simorgh and Rostam get their own avatars and names', () => {
  test('a tier-2 note keyed on rawPayload is Rostam', () => {
    const id = integrationIdentity({ actorName: 'Simorgh · Tier 2 (Rostam)', rawPayload: { stage: 'tier2', agent: 'Rostam' } });
    expect(id).toMatchObject({ key: 'rostam', name: 'Rostam', subtitle: 'Simorgh · Tier 2', avatarUrl: '/brand/integrations/rostam.png' });
  });

  test('a note mirrored before the stage fields existed still resolves from the author string', () => {
    expect(integrationIdentity({ actorName: 'Simorgh · Tier 2 (Rostam)', rawPayload: null }).key).toBe('rostam');
  });

  test('a plain Simorgh note is Simorgh, with the tier when one is given', () => {
    expect(integrationIdentity({ actorName: 'Simorgh', rawPayload: null })).toMatchObject({ key: 'simorgh', name: 'Simorgh', subtitle: 'Security agent' });
    expect(integrationIdentity({ actorName: 'Simorgh · Tier 1', rawPayload: { stage: 'tier1', agent: null } })).toMatchObject({ key: 'simorgh', subtitle: 'Simorgh · Tier 1' });
  });

  test('people and other systems are untouched', () => {
    expect(integrationIdentity({ actorName: 'Anton Kuzmychev', rawPayload: null })).toBeNull();
    expect(integrationIdentity({ actorName: 'Ticket Pulse', authorType: 'system' })).toBeNull();
    expect(integrationIdentity({ actorName: 'Simorghian Ltd' })).toBeNull();
    expect(integrationIdentity(null)).toBeNull();
  });
});
