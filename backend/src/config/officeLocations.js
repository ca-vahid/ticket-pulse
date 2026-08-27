/**
 * Office / city coordinate table for the Agent Map (Visuals) — QA 08-24 #1.
 *
 * MIRRORED from frontend/src/utils/officeLocations.js (the PATCH
 * /visuals/agents/:id/location route resolves server-side with the same
 * table so the response can say whether a value will pin). Keep the two
 * files byte-identical in their data + helpers; officeLocations.test.js
 * deep-compares them.
 *
 * Rules:
 *  - MAP_DEFAULT_VIEW is a VIEWPORT (where the empty map centers). It is
 *    never a marker coordinate — the old `OFFICE_LOCATIONS.Default` entry
 *    was used as a pin and put every unresolved agent in rural Saskatchewan.
 *  - resolveLocation() returns null on a miss. Callers decide what to do
 *    with unresolved people (Visuals shows them in a sidebar tray).
 *  - A free-text "lat,lng" value (e.g. "-33.4489,-70.6693") resolves as
 *    exact coordinates, so any spot outside the table can still be pinned
 *    without a schema change.
 */

export const MAP_DEFAULT_VIEW = Object.freeze({ lat: 54.5, lng: -105.0, zoom: 4 });

export const OFFICE_LOCATIONS = Object.freeze({
  // British Columbia
  Vancouver: { lat: 49.2827, lng: -123.1207, zoom: 10 },
  Victoria: { lat: 48.4284, lng: -123.3656, zoom: 10 },
  Kamloops: { lat: 50.6745, lng: -120.3273, zoom: 10 },
  Kelowna: { lat: 49.8880, lng: -119.4960, zoom: 10 },
  'Prince George': { lat: 53.9171, lng: -122.7497, zoom: 10 },
  Nanaimo: { lat: 49.1659, lng: -123.9401, zoom: 10 },
  Burnaby: { lat: 49.2488, lng: -122.9805, zoom: 10 },
  Surrey: { lat: 49.1913, lng: -122.8490, zoom: 10 },
  Richmond: { lat: 49.1666, lng: -123.1336, zoom: 10 },
  // Alberta
  Calgary: { lat: 51.0447, lng: -114.0719, zoom: 10 },
  Edmonton: { lat: 53.5461, lng: -113.4938, zoom: 10 },
  'Red Deer': { lat: 52.2681, lng: -113.8112, zoom: 10 },
  Lethbridge: { lat: 49.6942, lng: -112.8328, zoom: 10 },
  // Saskatchewan & Manitoba
  Saskatoon: { lat: 52.1332, lng: -106.6700, zoom: 10 },
  Regina: { lat: 50.4452, lng: -104.6189, zoom: 10 },
  Winnipeg: { lat: 49.8951, lng: -97.1384, zoom: 10 },
  // Ontario
  Toronto: { lat: 43.6532, lng: -79.3832, zoom: 10 },
  Ottawa: { lat: 45.4215, lng: -75.6972, zoom: 10 },
  Mississauga: { lat: 43.5890, lng: -79.6441, zoom: 10 },
  Hamilton: { lat: 43.2557, lng: -79.8711, zoom: 10 },
  London: { lat: 42.9849, lng: -81.2453, zoom: 10 },
  Kitchener: { lat: 43.4516, lng: -80.4925, zoom: 10 },
  Waterloo: { lat: 43.4643, lng: -80.5204, zoom: 10 },
  Sudbury: { lat: 46.4917, lng: -80.9930, zoom: 10 },
  'Thunder Bay': { lat: 48.3809, lng: -89.2477, zoom: 10 },
  // Quebec
  Montreal: { lat: 45.5017, lng: -73.5673, zoom: 10 },
  'Quebec City': { lat: 46.8139, lng: -71.2080, zoom: 10 },
  // Atlantic
  Halifax: { lat: 44.6488, lng: -63.5752, zoom: 10 },
  'St. John\'s': { lat: 47.5615, lng: -52.7126, zoom: 10 },
  Fredericton: { lat: 45.9636, lng: -66.6431, zoom: 10 },
  Moncton: { lat: 46.0878, lng: -64.7782, zoom: 10 },
  Charlottetown: { lat: 46.2382, lng: -63.1311, zoom: 10 },
  // Territories
  Whitehorse: { lat: 60.7212, lng: -135.0568, zoom: 10 },
  Yellowknife: { lat: 62.4540, lng: -114.3718, zoom: 10 },
  // United States
  Denver: { lat: 39.7392, lng: -104.9903, zoom: 10 },
  Golden: { lat: 39.7555, lng: -105.2211, zoom: 10 },
  Anchorage: { lat: 61.2181, lng: -149.9003, zoom: 10 },
  Seattle: { lat: 47.6062, lng: -122.3321, zoom: 10 },
  'Salt Lake City': { lat: 40.7608, lng: -111.8910, zoom: 10 },
  Reno: { lat: 39.5296, lng: -119.8138, zoom: 10 },
  Tucson: { lat: 32.2226, lng: -110.9747, zoom: 10 },
  Sacramento: { lat: 38.5816, lng: -121.4944, zoom: 10 },
  // South America
  Santiago: { lat: -33.4489, lng: -70.6693, zoom: 10 },
  Lima: { lat: -12.0464, lng: -77.0428, zoom: 10 },
  // Australia
  Brisbane: { lat: -27.4705, lng: 153.0260, zoom: 10 },
  Perth: { lat: -31.9523, lng: 115.8613, zoom: 10 },
  Sydney: { lat: -33.8688, lng: 151.2093, zoom: 10 },
  Melbourne: { lat: -37.8136, lng: 144.9631, zoom: 10 },
});

/** Dropdown presets: the common BGC offices first, then the rest of the table. */
export const PRESET_LOCATIONS = Object.freeze([
  'Vancouver', 'Calgary', 'Edmonton', 'Ottawa', 'Toronto',
  'Halifax', 'Kamloops', 'Kelowna', 'Montreal', 'Winnipeg',
  'Victoria', 'Saskatoon', 'Regina', 'Fredericton', 'Sudbury',
  'Santiago', 'Lima', 'Denver', 'Golden', 'Anchorage', 'Seattle',
  'Salt Lake City', 'Reno', 'Tucson', 'Sacramento',
  'Brisbane', 'Perth', 'Sydney', 'Melbourne',
]);

const LOOKUP = new Map(Object.entries(OFFICE_LOCATIONS).map(([key, value]) => [normalizeKey(key), { key, ...value }]));

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[’`]/g, '\'')
    .replace(/\s+/g, ' ');
}

/**
 * "lat,lng" (or "lat, lng" / "lat lng") → { lat, lng }; null when the text
 * isn't two finite numbers inside [-90,90] × [-180,180].
 */
export function parseLatLng(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** Canonical stored form for a coordinate pair: "lat,lng" with ≤ 6 decimals. */
export function formatLatLng({ lat, lng }) {
  const trim = (n) => String(Number(Number(n).toFixed(6)));
  return `${trim(lat)},${trim(lng)}`;
}

/**
 * Resolve a free-text location to map coordinates.
 * Tolerant: case-insensitive, trims, collapses whitespace, and strips a
 * trailing ", Country/Province" suffix ("Santiago, Chile" → Santiago,
 * "Calgary, AB, Canada" → Calgary). "lat,lng" text resolves as exact
 * coordinates (zoom 10). Returns null on a miss — never a fallback pin.
 *
 * @returns {{ lat:number, lng:number, zoom:number, key:string, kind:'city'|'coords' } | null}
 */
export function resolveLocation(locationStr) {
  if (locationStr === null || locationStr === undefined) return null;
  const raw = String(locationStr).trim();
  if (!raw) return null;

  const coords = parseLatLng(raw);
  if (coords) return { ...coords, zoom: 10, key: formatLatLng(coords), kind: 'coords' };

  const direct = LOOKUP.get(normalizeKey(raw));
  if (direct) return { ...direct, kind: 'city' };

  // "City, Region, Country" → try progressively shorter prefixes.
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  for (let n = parts.length - 1; n >= 1; n -= 1) {
    const hit = LOOKUP.get(normalizeKey(parts.slice(0, n).join(', ')));
    if (hit) return { ...hit, kind: 'city' };
  }
  return null;
}

/** Human-readable "why" for an unresolved value (shared copy for warnings). */
export const UNRESOLVED_LOCATION_HINT = 'We don\'t know where that is — pick a nearby city or enter lat,lng (e.g. -33.4489,-70.6693).';
