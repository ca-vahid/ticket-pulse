import { describe, expect, test } from 'vitest';
import { vi } from 'vitest';
import { integrationIdentity, integrationRequesterAvatar, isOfficeRequester, requesterIntegrationIdentity } from './integrationIdentity';

vi.mock('../services/api', () => ({ ticketsAPI: { requesterPhoto: () => { throw new Error('no network for integrations'); } } }));

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

  test('the Simorgh requester mailbox gets the phoenix; people do not', () => {
    expect(requesterIntegrationIdentity({ name: 'Simorgh · Security Operations', email: 'simorgh@bgcengineering.ca' })).toMatchObject({ key: 'simorgh', avatarUrl: '/brand/integrations/simorgh.png', avatarDarkUrl: '/brand/integrations/simorgh-dark.png' });
    expect(requesterIntegrationIdentity({ name: 'Rita Example', email: 'rita@example.com' })).toBeNull();
    expect(requesterIntegrationIdentity(null)).toBeNull();
  });

  test('people and other systems are untouched', () => {
    expect(integrationIdentity({ actorName: 'Anton Kuzmychev', rawPayload: null })).toBeNull();
    expect(integrationIdentity({ actorName: 'Ticket Pulse', authorType: 'system' })).toBeNull();
    expect(integrationIdentity({ actorName: 'Simorghian Ltd' })).toBeNull();
    expect(integrationIdentity(null)).toBeNull();
  });
});

describe('Microsoft Sentinel requester (29 Sep 2026)', () => {
  test('the Sentinel service address gets its own mark and name', () => {
    expect(requesterIntegrationIdentity({ name: 'Microsoft Sentinel', email: 'Sentinel@bgcengineering.ca' }))
      .toMatchObject({ key: 'sentinel', name: 'Microsoft Sentinel', avatarUrl: '/brand/integrations/sentinel.png' });
    expect(integrationRequesterAvatar('sentinel@bgcengineering.ca')).toBe('/brand/integrations/sentinel.png');
    // ContinuIT itself (8 Oct 2026): its own mark; its office plus-addresses stay offices.
    expect(requesterIntegrationIdentity({ name: 'ContinuIT', email: 'ContinuIT@bgcengineering.ca' }))
      .toMatchObject({ key: 'continuit', name: 'ContinuIT', subtitle: 'Meeting follow-ups', avatarUrl: '/brand/integrations/continuit.png' });
    expect(integrationRequesterAvatar('continuit@bgcengineering.ca')).toBe('/brand/integrations/continuit.png');
    expect(integrationRequesterAvatar('continuit+van@bgcengineering.ca')).toBe('/brand/offices/van.jpg');
    expect(integrationIdentity({ actorName: 'ContinuIT', rawPayload: {} })).toMatchObject({ key: 'continuit' });
  });

  test('a real vendor called "Sentinel Storage" keeps its initials; Simorgh is unchanged', () => {
    expect(requesterIntegrationIdentity({ name: 'Sentinel Storage - 355 MacAlpine Crescent', email: '355macalpine@sentinel.ca' })).toBeNull();
    expect(integrationRequesterAvatar('355macalpine@sentinel.ca')).toBeNull();
    expect(requesterIntegrationIdentity({ name: 'Simorgh · Security Operations', email: 'simorgh@bgcengineering.ca' }).key).toBe('simorgh');
  });

  test('the shared photo lookup answers integrations without a network call', async () => {
    const { fetchRequesterPhoto } = await import('../hooks/useRequesterPhoto');
    await expect(fetchRequesterPhoto('sentinel@bgcengineering.ca')).resolves.toBe('/brand/integrations/sentinel.png');
  });
});

describe('ContinuIT office requesters (8 Oct 2026)', () => {
  test('continuit+<code>@ is an office: building mark, the record name, "BGC office"', () => {
    expect(isOfficeRequester('Continuit+BRI@bgcengineering.ca')).toBe(true);
    expect(requesterIntegrationIdentity({ name: 'Brisbane Office', email: 'continuit+bri@bgcengineering.ca' }))
      .toMatchObject({ key: 'office', name: 'Brisbane Office', subtitle: 'BGC office', avatarUrl: '/brand/offices/bri.jpg', photo: true });
    expect(integrationRequesterAvatar('continuit+cal@bgcengineering.ca')).toBe('/brand/offices/cal.jpg');
    // A new office without a photo yet falls back to the building mark.
    expect(integrationRequesterAvatar('continuit+yyz@bgcengineering.ca')).toBe('/brand/integrations/office.png');
  });
  test('plain continuit@ and other plus-addresses are not offices', () => {
    expect(isOfficeRequester('continuit@bgcengineering.ca')).toBe(false);
    expect(isOfficeRequester('vhaeri+test@bgcengineering.ca')).toBe(false);
    expect(isOfficeRequester('continuit+bri@example.com')).toBe(false);
  });
});
