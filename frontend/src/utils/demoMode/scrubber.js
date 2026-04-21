// Recursive scrubber that anonymizes API response payloads in demo mode.
//
// The strategy is:
//   1. Walk every object/array in the payload.
//   2. When we recognize a key name (e.g. `requesterName`, `email`, `subject`),
//      route the value through the appropriate `mapXxx` from mappings.js.
//   3. When we encounter a free-text field like `subject` or `description`,
//      run it through scrubFreeText() which strips emails, computer names,
//      person names, and internal domains via a small regex pipeline.
//
// All mapping is deterministic-per-session (see mappings.js + state.js), so
// the same real value is always replaced with the same fake value during a
// given recording.

import {
  KNOWN_INTERNAL_TOKENS,
  KNOWN_BGC_LOCATIONS,
  COMPUTER_REGEX,
  EMAIL_REGEX,
  FAKE_EMAIL_DOMAIN,
} from './dictionaries.js';
import {
  mapName,
  mapEmail,
  mapLocation,
  mapComputerName,
  getDemoAvatar,
  getKnownRealNames,
} from './mappings.js';

// ---------- field-name classification -----------------------------------
// Keys whose VALUE is a person name (or comma list of names).
const NAME_KEYS = new Set([
  'name', 'fullName', 'displayName', 'requesterName', 'agentName',
  'assignedBy', 'performedByName', 'performerName', 'createdByName',
  'updatedByName', 'managerName', 'reviewerName', 'reporterName',
  'firstName', 'lastName',
]);

// Keys whose VALUE is an email address.
const EMAIL_KEYS = new Set([
  'email', 'requesterEmail', 'agentEmail', 'userEmail', 'contactEmail',
  'mail', 'upn', 'userPrincipalName',
]);

// Keys whose VALUE is a city / office / location string.
const LOCATION_KEYS = new Set([
  'location', 'city', 'office', 'site', 'workplace', 'workLocation',
]);

// Keys whose VALUE is a free-text string that may contain mixed sensitive data.
const FREE_TEXT_KEYS = new Set([
  'subject', 'description', 'descriptionText', 'body', 'note', 'notes',
  'comment', 'comments', 'reason', 'summary', 'detail', 'details',
  'shortDescription', 'longDescription', 'aiReasoning', 'aiSummary',
  'aiSuggestionRationale', 'rationale', 'message',
]);

// Keys whose VALUE is a photo / avatar URL.
const PHOTO_KEYS = new Set([
  'photoUrl', 'avatarUrl', 'avatar', 'picture', 'pictureUrl',
  '_techPhotoUrl', 'profilePhoto', 'profilePicture',
]);

// Keys whose VALUE is an IANA timezone string (e.g. 'America/Toronto'). The
// city portion may identify the person's office, so we replace just that
// segment while keeping a valid timezone shape so date math still works.
const TIMEZONE_KEYS = new Set(['timezone', 'tz']);

// Keys we leave untouched even if their content looks scrubbable.
const SAFE_KEYS = new Set([
  'id', 'role', 'status', 'priority', 'category', 'ticketCategory',
  'createdAt', 'updatedAt', 'closedAt', 'resolvedAt', 'firstAssignedAt',
  'date', 'startDate', 'endDate', 'weekStart', 'monthStart',
  'freshserviceTicketId', 'freshserviceId', 'workspaceId',
]);

// IANA timezone identifiers we map BGC-relevant cities to. These are all
// real, valid IANA names so any downstream date-fns / Intl call still works.
const TIMEZONE_REMAP = {
  'america/toronto': 'America/Halifax',
  'america/vancouver': 'America/Edmonton',
  'america/edmonton': 'America/Regina',
  'america/calgary': 'America/Regina',
  'america/winnipeg': 'America/Halifax',
  'america/montreal': 'America/Halifax',
  'america/los_angeles': 'America/Phoenix',
};

function scrubTimezone(value) {
  if (typeof value !== 'string') return value;
  const lower = value.toLowerCase();
  return TIMEZONE_REMAP[lower] || value;
}

// ---------- free-text pipeline ------------------------------------------
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const INTERNAL_TOKEN_REGEX = (() => {
  const parts = KNOWN_INTERNAL_TOKENS
    .slice() // copy
    .sort((a, b) => b.length - a.length) // longest first
    .map(escapeRegex);
  return new RegExp(`\\b(?:${parts.join('|')})\\b`, 'g');
})();

const KNOWN_LOCATION_REGEX = (() => {
  const parts = KNOWN_BGC_LOCATIONS
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex);
  return new RegExp(`\\b(?:${parts.join('|')})\\b`, 'gi');
})();

export function scrubFreeText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;

  // 1. Emails (so the local part isn't matched again as a name token).
  out = out.replace(EMAIL_REGEX, (m) => mapEmail(m));

  // 2. Computer names (BGC-EDM-HV01 etc).
  out = out.replace(COMPUTER_REGEX, (m) => mapComputerName(m));

  // 3. Internal company tokens (BGC, BGC Engineering, bgcsaas.com etc).
  out = out.replace(INTERNAL_TOKEN_REGEX, () => 'Acme');
  // Catch lower-case "bgc" too for things like "bgcsaas".
  out = out.replace(/bgcsaas/gi, 'acmesaas');
  out = out.replace(/bgcengineering\.ca/gi, FAKE_EMAIL_DOMAIN);

  // 4. Known BGC office locations inside subjects.
  out = out.replace(KNOWN_LOCATION_REGEX, (m) => mapLocation(m));

  // 5. Known person names — every real name we've ever mapped (via the
  //    structured-key pass in collectPeople OR via direct mapName() calls
  //    from useDemoLabel hooks) becomes a candidate for free-text scrubbing.
  const dynamic = buildDynamicNameRegex();
  if (dynamic) {
    out = out.replace(dynamic, (m) => mapName(m));
  }

  // 6. Trigger-based name sweep. We only scrub a generic Title-Case sequence
  //    when it appears immediately after a clear name-introducing trigger:
  //      - prepositions: "for", "by", "from", "with", "involving", "to"
  //      - "Hire" (handles "New Hire: X" and "New Hire X")
  //      - any colon (so "New Hire: Mahmoud Al-Riffai" works)
  //    This avoids false positives on tech jargon like "Significant Anomaly"
  //    or "Model Breach" that don't follow a person trigger.
  out = out.replace(TRIGGERED_PERSON_REGEX, (_, prefix, name) => {
    if (PERSON_NAME_STOPLIST.has(name.toLowerCase())) return prefix + name;
    return prefix + mapName(name);
  });

  return out;
}

// (?<prefix>trigger) (?<name>2-3 Title-Case tokens). The minimum of 2
// tokens prevents false positives on single capitalized words like
// "Transfer", "Application", or "Acme" when they happen to follow a trigger.
// Person names in real free text almost always come as First + Last.
const TRIGGERED_PERSON_REGEX = new RegExp(
  // Trigger group
  String.raw`((?:\b(?:for|by|from|with|involving|to|Hire|hire|Re|RE|Hi|Hello|Dear)\b[\s:]+|:\s+))` +
  // Name group (2-3 capitalized tokens, with surname connectors).
  // Connector alternatives come FIRST so the regex prefers "Al-Riffai"
  // over the greedy single-token "Al" that would leave "-Riffai" behind.
  String.raw`((?:Al-[A-Z][a-z]+|El-[A-Z][a-z]+|(?:Mc|Mac|O')[A-Z][a-z]+|[A-Z][a-z]+-[A-Z][a-z]+|[A-Z][a-z]{2,})` +
  String.raw`(?:\s+(?:Al-[A-Z][a-z]+|El-[A-Z][a-z]+|(?:Mc|Mac|O')[A-Z][a-z]+|[A-Z][a-z]+-[A-Z][a-z]+|[A-Z][a-z]+)){1,2})`,
  'g',
);

// Common phrases that look like names but aren't. Lower-cased.
const PERSON_NAME_STOPLIST = new Set([
  'help desk', 'service desk', 'help center', 'training video',
  'cybersecurity questionnaire', 'federal contract', 'access denied',
  'all users', 'all employees', 'all techs',
]);

// Person names accumulate as we walk API payloads (every requesterName etc.
// gets registered). The regex is rebuilt lazily when the set changes.
const knownPeople = new Set();
let dynamicNameRegex = null;
let dynamicNameRegexSize = 0;

function rememberPerson(name) {
  if (typeof name !== 'string') return;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length < 3) return;
  if (knownPeople.has(trimmed)) return;
  knownPeople.add(trimmed);
  // Invalidate the cached regex; it'll be rebuilt on next read.
  dynamicNameRegex = null;
}

function buildDynamicNameRegex() {
  // Combine names from in-text discovery (collectPeople) AND every name the
  // mapping cache has seen (via direct mapName() calls from useDemoLabel and
  // structured-field scrubs). The cache keys are lower-cased; we recover
  // proper-case from `knownPeople` when available, otherwise fall back to
  // the lower-cased form (regex is case-sensitive but we generate both).
  const fromCache = getKnownRealNames();
  const total = knownPeople.size + fromCache.length;
  if (total === 0) return null;
  if (dynamicNameRegex && dynamicNameRegexSize === total) return dynamicNameRegex;

  const set = new Set();
  for (const n of knownPeople) set.add(n);
  for (const n of fromCache) set.add(n);

  const parts = Array.from(set)
    .filter(n => n && n.length >= 3)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex);
  dynamicNameRegex = new RegExp(`\\b(?:${parts.join('|')})\\b`, 'gi');
  dynamicNameRegexSize = total;
  return dynamicNameRegex;
}

// ---------- recursive walker --------------------------------------------
// Mutates the payload in place. The axios interceptor already gives us a
// freshly-parsed object, so mutation is safe and cheaper than deep cloning.

const MAX_DEPTH = 30; // protection against pathological payloads / cycles

export function scrubResponse(data) {
  if (data == null) return data;
  // First pass: register people we know from structured fields, so the
  // free-text scrubber catches them inside subjects too.
  collectPeople(data, 0);
  scrubInPlace(data, null, 0);
  return data;
}

function collectPeople(node, depth) {
  if (depth > MAX_DEPTH || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectPeople(item, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (typeof v === 'string') {
      if (NAME_KEYS.has(key)) rememberPerson(v);
    } else if (v && typeof v === 'object') {
      collectPeople(v, depth + 1);
    }
  }
}

function scrubInPlace(node, parentKey, depth) {
  if (depth > MAX_DEPTH || node == null) return node;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      node[i] = scrubInPlace(node[i], parentKey, depth + 1);
    }
    return node;
  }
  if (typeof node !== 'object') return node;

  for (const key of Object.keys(node)) {
    const v = node[key];

    if (SAFE_KEYS.has(key)) continue;

    if (v == null) continue;

    if (typeof v === 'string') {
      if (NAME_KEYS.has(key)) {
        node[key] = mapName(v);
      } else if (EMAIL_KEYS.has(key)) {
        node[key] = mapEmail(v);
      } else if (LOCATION_KEYS.has(key)) {
        node[key] = mapLocation(v);
      } else if (TIMEZONE_KEYS.has(key)) {
        node[key] = scrubTimezone(v);
      } else if (PHOTO_KEYS.has(key)) {
        // Build the avatar key from the sibling name when possible so a
        // person keeps the same face across pages. Falls back to the raw URL
        // if no name is present.
        const siblingName =
          node.name || node.requesterName || node.agentName || node.fullName ||
          node.email || node.requesterEmail || v;
        const fake = getDemoAvatar(siblingName);
        // null = photos disabled OR pool empty -> drop the URL entirely so
        // the existing initials-circle fallback in the components renders.
        node[key] = fake == null ? '' : fake;
      } else if (FREE_TEXT_KEYS.has(key)) {
        node[key] = scrubFreeText(v);
      }
      continue;
    }

    if (typeof v === 'object') {
      scrubInPlace(v, key, depth + 1);
    }
  }
  return node;
}

// Convenience entry-point for response interceptors and SSE handlers. Any
// non-object payload is returned as-is.
export function maybeScrub(data, isDemo) {
  if (!isDemo) return data;
  try {
    return scrubResponse(data);
  } catch (err) {
    // Never break the app because scrubbing failed.
    if (typeof console !== 'undefined') {
      // eslint-disable-next-line no-console
      console.warn('[demoMode] scrub error:', err);
    }
    return data;
  }
}
