// Deterministic real -> fake mappings for demo mode.
//
// Once a real value (name, email, location, computer name) is seen during a
// session, it is locked to a single fake replacement so the same person /
// machine looks consistent across every page, list, and SSE update.
//
// All assignments are derived from the session seed (state.getDemoSeed) so
// reshuffleIdentities() simply clears the caches and a new seed produces a
// fresh roster of fake identities.

import {
  FIRST_NAMES,
  LAST_NAMES,
  FAKE_LOCATIONS,
  FAKE_COMPANY_PREFIXES,
  FAKE_DEVICE_KINDS,
  FAKE_EMAIL_DOMAIN,
} from './dictionaries.js';
import { getDemoSeed, onSeedReset, arePhotosEnabled } from './state.js';
import { hashString, mulberry32 } from './rng.js';

// Per-session caches. Cleared whenever the seed is reshuffled.
const nameCache = new Map();      // realName (norm) -> fakeName
const emailLocalCache = new Map(); // realLocalPart -> fakeLocalPart
const locationCache = new Map();  // realLocation -> fakeLocation
const computerCache = new Map();  // realComputer -> fakeComputer
const avatarIndexCache = new Map(); // realKey -> avatarIndex

const usedFakeNames = new Set();
const usedFakeLocations = new Set();
const usedFakeComputers = new Set();
const usedAvatarIndices = new Set();

// Roster used as the pool to draw fake names from. We pre-shuffle it once
// per seed so that .pop() gives us collision-free, on-demand picks.
let nameRoster = null;       // string[]
let locationRoster = null;   // string[]
let computerCounter = 0;

// ---------- avatar pool ---------------------------------------------------
// Lazily loaded from /demo-avatars/manifest.json. Until the manifest is
// available (or if it 404s — script not yet run) we fall back to the same
// initials-circle UI the app already uses.
let avatarManifest = null;
let avatarManifestPromise = null;

function ensureAvatarManifest() {
  if (avatarManifest || avatarManifestPromise) return avatarManifestPromise || Promise.resolve(avatarManifest);
  avatarManifestPromise = fetch('/demo-avatars/manifest.json', { cache: 'force-cache' })
    .then(r => (r.ok ? r.json() : null))
    .then(json => {
      if (json && Array.isArray(json.files) && json.files.length > 0) {
        avatarManifest = json;
      } else {
        avatarManifest = { files: [] };
      }
      return avatarManifest;
    })
    .catch(() => {
      avatarManifest = { files: [] };
      return avatarManifest;
    });
  return avatarManifestPromise;
}

// Kick off the fetch as soon as the module loads — it's cheap and avoids the
// first-paint flash where photoUrls are empty strings.
ensureAvatarManifest();

export function getAvatarManifest() {
  return avatarManifest;
}

// ---------- seed-driven helpers -----------------------------------------
function shuffleWithSeed(arr, seed) {
  // Fisher-Yates with a seeded RNG. Returns a new array.
  const rand = mulberry32(seed);
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildNameRoster(seed) {
  // Cartesian product first name x last name, shuffled. Long enough that we
  // will never run out within a single demo session (80 x 80 = 6400 unique
  // pairs, vs. tens of techs + hundreds of requesters).
  const out = [];
  for (const first of FIRST_NAMES) {
    for (const last of LAST_NAMES) {
      out.push(`${first} ${last}`);
    }
  }
  return shuffleWithSeed(out, seed);
}

function buildLocationRoster(seed) {
  return shuffleWithSeed(FAKE_LOCATIONS, seed ^ 0x9E3779B9);
}

function ensureRosters() {
  if (nameRoster && locationRoster) return;
  const seed = getDemoSeed();
  nameRoster = buildNameRoster(seed);
  locationRoster = buildLocationRoster(seed);
}

function resetCaches() {
  nameCache.clear();
  emailLocalCache.clear();
  locationCache.clear();
  computerCache.clear();
  avatarIndexCache.clear();
  usedFakeNames.clear();
  usedFakeLocations.clear();
  usedFakeComputers.clear();
  usedAvatarIndices.clear();
  nameRoster = null;
  locationRoster = null;
  computerCounter = 0;
}

// Hook the reset into the seed-reshuffle event so the next request after
// "Reshuffle identities" gets a clean slate.
onSeedReset(resetCaches);

// ---------- public mapping API ------------------------------------------
function normalizeName(name) {
  return String(name).trim().toLowerCase();
}

export function mapName(realName) {
  if (!realName || typeof realName !== 'string') return realName;
  const trimmed = realName.trim();
  if (!trimmed) return realName;
  const key = normalizeName(trimmed);

  const cached = nameCache.get(key);
  if (cached) return cached;

  ensureRosters();

  // Pull from the shuffled roster, advancing past anything already used (the
  // roster is huge so this is effectively O(1) per call).
  let pick = null;
  while (nameRoster.length > 0) {
    const candidate = nameRoster.pop();
    if (!usedFakeNames.has(candidate)) {
      pick = candidate;
      break;
    }
  }
  if (!pick) {
    // Extremely unlikely (>6000 unique pairs already used). Synthesize a
    // numbered fallback so the demo never crashes.
    pick = `Demo User ${nameCache.size + 1}`;
  }

  usedFakeNames.add(pick);
  nameCache.set(key, pick);
  return pick;
}

export function mapEmail(realEmail) {
  if (!realEmail || typeof realEmail !== 'string') return realEmail;
  const at = realEmail.indexOf('@');
  if (at < 0) return realEmail;
  const local = realEmail.slice(0, at);
  // Use the name mapping so 'andrew.fong' -> 'daniel.carter' aligns with
  // however we mapped the human's name. We translate dots/underscores to
  // spaces, look up the name, then re-join.
  const normalized = local.replace(/[._-]+/g, ' ').trim();
  let fakeLocal;
  const cached = emailLocalCache.get(local.toLowerCase());
  if (cached) {
    fakeLocal = cached;
  } else {
    const fakeName = mapName(normalized || local);
    fakeLocal = fakeName.toLowerCase().replace(/\s+/g, '.');
    emailLocalCache.set(local.toLowerCase(), fakeLocal);
  }
  return `${fakeLocal}@${FAKE_EMAIL_DOMAIN}`;
}

export function mapLocation(realLocation) {
  if (!realLocation || typeof realLocation !== 'string') return realLocation;
  const trimmed = realLocation.trim();
  if (!trimmed) return realLocation;
  const key = trimmed.toLowerCase();
  const cached = locationCache.get(key);
  if (cached) return cached;

  ensureRosters();

  let pick = null;
  while (locationRoster.length > 0) {
    const candidate = locationRoster.pop();
    if (!usedFakeLocations.has(candidate)) {
      pick = candidate;
      break;
    }
  }
  if (!pick) {
    pick = FAKE_LOCATIONS[(locationCache.size) % FAKE_LOCATIONS.length];
  }
  usedFakeLocations.add(pick);
  locationCache.set(key, pick);
  return pick;
}

export function mapComputerName(realComputer) {
  if (!realComputer || typeof realComputer !== 'string') return realComputer;
  const key = realComputer.toUpperCase();
  const cached = computerCache.get(key);
  if (cached) return cached;

  const seed = getDemoSeed();
  // Pick a deterministic prefix + kind from the seed + real value so that the
  // SAME real machine always becomes the same fake machine, but different
  // machines get a varied mix of prefixes.
  const h = (hashString(realComputer) ^ seed) >>> 0;
  const prefix = FAKE_COMPANY_PREFIXES[h % FAKE_COMPANY_PREFIXES.length];
  const kind = FAKE_DEVICE_KINDS[(h >>> 8) % FAKE_DEVICE_KINDS.length];

  // Find a free slot. Almost always succeeds on the first attempt.
  let n = (h >>> 16) % 999;
  let candidate = '';
  for (let i = 0; i < 1000; i++) {
    candidate = `${prefix}-${kind}-${String(((n + i) % 999) + 1).padStart(3, '0')}`;
    if (!usedFakeComputers.has(candidate)) break;
  }
  if (!candidate) {
    computerCounter += 1;
    candidate = `${prefix}-${kind}-${String(computerCounter).padStart(3, '0')}`;
  }
  usedFakeComputers.add(candidate);
  computerCache.set(key, candidate);
  return candidate;
}

// Returns a path to a bundled stock photo, or null when the avatar pool
// hasn't been generated yet (script not run). Callers should fall back to
// the existing initials UI in that case.
export function getDemoAvatar(realKey) {
  if (!arePhotosEnabled()) return null;
  if (!avatarManifest) {
    // Manifest still loading; hide the photo for now so we don't show the
    // real face for one frame. Callers fall back to initials.
    return '';
  }
  const files = avatarManifest.files || [];
  if (files.length === 0) return null;

  const key = String(realKey || '').toLowerCase();
  const cached = avatarIndexCache.get(key);
  if (cached != null) return `/demo-avatars/${files[cached]}`;

  const seed = getDemoSeed();
  // CRITICAL: `>>> 0` forces unsigned 32-bit. Without it, the XOR returns a
  // signed int that can be negative, which makes `% files.length` produce a
  // negative remainder in JS — and then `files[-X]` is undefined, yielding
  // the URL "/demo-avatars/undefined" that 404s and shows a broken image
  // with the alt-text leaking the (real or fake) name.
  const startIdx = ((hashString(key) ^ seed) >>> 0) % files.length;
  let idx = startIdx;
  // Avoid duplicate avatars for different people while we still have unused
  // slots in the pool.
  if (usedAvatarIndices.size < files.length) {
    for (let step = 0; step < files.length; step++) {
      const candidate = (startIdx + step) % files.length;
      if (!usedAvatarIndices.has(candidate)) {
        idx = candidate;
        break;
      }
    }
  }
  usedAvatarIndices.add(idx);
  avatarIndexCache.set(key, idx);
  return `/demo-avatars/${files[idx]}`;
}

// Exposed for the scrubber when it needs to look up "is this string a real
// person we already know about?" (built lazily as we see the data).
export function getKnownRealNames() {
  return Array.from(nameCache.keys());
}
