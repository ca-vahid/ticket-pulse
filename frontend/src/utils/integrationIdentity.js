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
  // Microsoft Sentinel (29 Sep 2026): an original shield-and-eye mark in the
  // app's pictogram style — not Microsoft's logo.
  sentinel: '/brand/integrations/sentinel.png',
  // ContinuIT office requesters (8 Oct 2026): one building mark for every office.
  office: '/brand/integrations/office.png',
  // ContinuIT itself (8 Oct 2026, Vahid): a calendar page with a follow-up
  // loop around a check — meetings whose IT actions keep moving.
  continuit: '/brand/integrations/continuit.png',
};

// Each BGC office's own city photo (8 Oct 2026, Vahid via ContinuIT): the
// cover photos from bgcengineering.ca, centre-cropped to 192 px squares in
// public/brand/offices/<code>.jpg. A code without a photo gets the building mark.
const OFFICE_PHOTOS = new Set(['bri', 'cal', 'edm', 'fred', 'col', 'hfx', 'kam', 'kel', 'mtl', 'ott', 'chi', 'dr', 'sud', 'sur', 'tor', 'van', 'vic', 'wht']);
function officeAvatar(email) {
  const code = String(email || '').trim().toLowerCase().split('@')[0].split('+')[1] || '';
  return OFFICE_PHOTOS.has(code) ? { url: `/brand/offices/${code}.jpg`, photo: true } : { url: AVATARS.office, photo: false };
}

/** Requester records that belong to an integration, keyed on the address. */
const INTEGRATION_REQUESTERS = {
  'simorgh@bgcengineering.ca': 'simorgh',
  // Exact address only: "Sentinel Storage" is a real vendor and keeps its initials.
  'sentinel@bgcengineering.ca': 'sentinel',
  // Plain continuit@ only; continuit+<office>@ is an office (isOfficeRequester).
  'continuit@bgcengineering.ca': 'continuit',
};

const REQUESTER_IDENTITIES = {
  simorgh: { key: 'simorgh', name: 'Simorgh', subtitle: 'Security agent', avatarUrl: AVATARS.simorgh, avatarDarkUrl: AVATARS.simorghDark, tone: 'simorgh' },
  sentinel: { key: 'sentinel', name: 'Microsoft Sentinel', subtitle: 'Monitoring alerts', avatarUrl: AVATARS.sentinel, tone: 'sentinel' },
  continuit: { key: 'continuit', name: 'ContinuIT', subtitle: 'Meeting follow-ups', avatarUrl: AVATARS.continuit, tone: 'continuit' },
};

/**
 * The picture for an integration's requester address, or null. The shared
 * photo lookup (hooks/useRequesterPhoto) uses it, so every requester avatar —
 * queue, search, approvals, requester pages — shows it with no network call.
 */
export function integrationRequesterAvatar(email) {
  const addr = String(email || '').trim().toLowerCase();
  if (isOfficeRequester(addr)) return officeAvatar(addr).url;
  const key = INTEGRATION_REQUESTERS[addr];
  return key ? REQUESTER_IDENTITIES[key]?.avatarUrl || null : null;
}

/** continuit+<office code>@bgcengineering.ca — a BGC office as the requester (ContinuIT). */
export function isOfficeRequester(email) {
  return /^continuit[+][a-z0-9-]{1,40}@bgcengineering[.]ca$/.test(String(email || '').trim().toLowerCase());
}

/**
 * The requester card: the Simorgh mailbox is an application, not a person —
 * give it the phoenix instead of "S·" initials.
 */
export function requesterIntegrationIdentity(requester) {
  if (!requester) return null;
  const email = String(requester.email || '').trim().toLowerCase();
  if (isOfficeRequester(email)) {
    const av = officeAvatar(email);
    return { key: 'office', name: requester.name || 'Office', subtitle: 'BGC office', avatarUrl: av.url, photo: av.photo, tone: 'office' };
  }
  const key = INTEGRATION_REQUESTERS[email] || (/^Simorgh\b/i.test(String(requester.name || '')) ? 'simorgh' : null);
  return key ? REQUESTER_IDENTITIES[key] || null : null;
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
  // Notes ContinuIT writes through the API carry its credential name.
  if (/^ContinuIT\b/i.test(actor)) return REQUESTER_IDENTITIES.continuit;
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
