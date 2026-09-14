/**
 * Integration identities in the conversation thread.
 *
 * A note written through the public API carries the credential's name as
 * its author ("Simorgh") and, since v3.8.62, the stage that wrote it in
 * rawPayload ({ stage: 'tier2', agent: 'Rostam' }) — rendered as
 * "Simorgh · Tier 2 (Rostam)". That string is right for the audit trail but
 * the thread showed it with "S·" initials. The Simorgh application has real
 * avatars for both voices; use them, and name the voice the way the
 * security team does: Simorgh for the application, Rostam for its tier-2.
 *
 * Keyed on data (rawPayload.agent / stage) first; the author-name pattern is
 * the fallback for notes mirrored before the stage fields existed.
 */
const AVATARS = {
  simorgh: '/brand/integrations/simorgh.png',
  simorghDark: '/brand/integrations/simorgh-dark.png',
  rostam: '/brand/integrations/rostam.png',
};

/** Requester records that belong to an integration, keyed on the address. */
const INTEGRATION_REQUESTERS = {
  'simorgh@bgcengineering.ca': 'simorgh',
};

/**
 * The requester card: the Simorgh mailbox is an application, not a person —
 * give it the phoenix instead of "S·" initials.
 */
export function requesterIntegrationIdentity(requester) {
  if (!requester) return null;
  const email = String(requester.email || '').trim().toLowerCase();
  const key = INTEGRATION_REQUESTERS[email] || (/^Simorgh\b/i.test(String(requester.name || '')) ? 'simorgh' : null);
  if (key !== 'simorgh') return null;
  return { key: 'simorgh', name: 'Simorgh', subtitle: 'Security agent', avatarUrl: AVATARS.simorgh, avatarDarkUrl: AVATARS.simorghDark, tone: 'simorgh' };
}

export function integrationIdentity(entry) {
  if (!entry) return null;
  const actor = String(entry.actorName || '');
  const raw = entry.rawPayload && typeof entry.rawPayload === 'object' ? entry.rawPayload : {};
  const agent = String(raw.agent || '').trim();
  const stage = String(raw.stage || '').trim().toLowerCase();
  const tierFromName = actor.match(/Tier\s*(\d)/i)?.[1] || null;
  const tier = stage.startsWith('tier') ? stage.slice(4) : tierFromName;

  if (/^rostam$/i.test(agent) || /\(Rostam\)/i.test(actor)) {
    return {
      key: 'rostam',
      name: 'Rostam',
      subtitle: `Simorgh · Tier ${tier || '2'}`,
      avatarUrl: AVATARS.rostam,
      tone: 'rostam',
    };
  }
  if (/^Simorgh\b/i.test(actor)) {
    return {
      key: 'simorgh',
      name: agent || 'Simorgh',
      subtitle: tier ? `Simorgh · Tier ${tier}` : 'Security agent',
      avatarUrl: AVATARS.simorgh,
      avatarDarkUrl: AVATARS.simorghDark,
      tone: 'simorgh',
    };
  }
  return null;
}

export default integrationIdentity;
