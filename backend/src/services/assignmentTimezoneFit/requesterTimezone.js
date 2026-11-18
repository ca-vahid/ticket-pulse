/**
 * Where is the requester, in time-zone terms? (QA 11-17 item 1)
 *
 * The FreshService requester time zone is the account default ("Pacific Time")
 * for almost everyone, so it says next to nothing. The directory (Entra) city
 * and country are what people actually filled in. Order:
 *   1. Entra city (with the country when a city name exists in two places),
 *   2. a known city named in the Entra office location,
 *   3. Entra state / province,
 *   4. Entra country, when the whole country keeps one time zone,
 *   5. the FreshService time zone, except Pacific,
 *   6. FreshService "Pacific Time" as a weak last resort (low confidence).
 *
 * Pure: no database, no clock.
 * @returns {{ timezone: string, source: string, confidence: 'high'|'medium'|'low', place: string } | null}
 */

const norm = (v) => String(v ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();

const COUNTRY_ALIASES = {
  ca: 'canada', can: 'canada', canada: 'canada',
  us: 'united states', usa: 'united states', 'united states': 'united states', 'united states of america': 'united states', america: 'united states',
  uk: 'united kingdom', gb: 'united kingdom', 'great britain': 'united kingdom', 'united kingdom': 'united kingdom', england: 'united kingdom', scotland: 'united kingdom', wales: 'united kingdom',
  cl: 'chile', chile: 'chile',
  do: 'dominican republic', 'dominican republic': 'dominican republic', 'republica dominicana': 'dominican republic',
  au: 'australia', australia: 'australia',
  jm: 'jamaica', jamaica: 'jamaica',
  ie: 'ireland', ireland: 'ireland',
};
const countryOf = (v) => COUNTRY_ALIASES[norm(v)] || norm(v) || null;

/** Countries that keep one time zone everywhere (enough for our people). */
const SINGLE_ZONE_COUNTRIES = {
  chile: 'America/Santiago',
  'dominican republic': 'America/Santo_Domingo',
  'united kingdom': 'Europe/London',
  ireland: 'Europe/Dublin',
  jamaica: 'America/Jamaica',
  'puerto rico': 'America/Puerto_Rico',
  colombia: 'America/Bogota',
  peru: 'America/Lima',
  argentina: 'America/Argentina/Buenos_Aires',
  'costa rica': 'America/Costa_Rica',
  germany: 'Europe/Berlin',
  france: 'Europe/Paris',
  spain: 'Europe/Madrid',
  netherlands: 'Europe/Amsterdam',
  india: 'Asia/Kolkata',
  philippines: 'Asia/Manila',
  'new zealand': 'Pacific/Auckland',
  japan: 'Asia/Tokyo',
  singapore: 'Asia/Singapore',
};

/**
 * City → zone. A city that exists in more than one place is keyed with its
 * country (`city|country`); the bare name is its usual meaning for us, or
 * missing when there is no safe guess (Washington, Montrose).
 */
const CITIES = {
  // British Columbia
  vancouver: 'America/Vancouver', 'north vancouver': 'America/Vancouver', 'west vancouver': 'America/Vancouver',
  burnaby: 'America/Vancouver', richmond: 'America/Vancouver', surrey: 'America/Vancouver', coquitlam: 'America/Vancouver',
  langley: 'America/Vancouver', delta: 'America/Vancouver', 'new westminster': 'America/Vancouver', abbotsford: 'America/Vancouver',
  victoria: 'America/Vancouver', nanaimo: 'America/Vancouver', kamloops: 'America/Vancouver', kelowna: 'America/Vancouver',
  vernon: 'America/Vancouver', 'prince george': 'America/Vancouver', squamish: 'America/Vancouver', whistler: 'America/Vancouver',
  // Golden BC keeps Mountain time.
  golden: 'America/Edmonton', cranbrook: 'America/Edmonton',
  // Prairies and north
  calgary: 'America/Edmonton', edmonton: 'America/Edmonton', 'red deer': 'America/Edmonton', lethbridge: 'America/Edmonton', canmore: 'America/Edmonton',
  regina: 'America/Regina', saskatoon: 'America/Regina', winnipeg: 'America/Winnipeg',
  whitehorse: 'America/Whitehorse', yellowknife: 'America/Yellowknife',
  // Ontario / Quebec
  toronto: 'America/Toronto', ottawa: 'America/Toronto', kingston: 'America/Toronto', sudbury: 'America/Toronto', 'greater sudbury': 'America/Toronto',
  mississauga: 'America/Toronto', hamilton: 'America/Toronto', waterloo: 'America/Toronto', markham: 'America/Toronto', 'thunder bay': 'America/Toronto',
  montreal: 'America/Toronto', 'quebec city': 'America/Toronto', quebec: 'America/Toronto', gatineau: 'America/Toronto', laval: 'America/Toronto',
  // Atlantic
  fredericton: 'America/Moncton', moncton: 'America/Moncton', 'saint john': 'America/Moncton',
  halifax: 'America/Halifax', dartmouth: 'America/Halifax', charlottetown: 'America/Halifax',
  "st john's": 'America/St_Johns', 'st johns': 'America/St_Johns',
  // United States
  seattle: 'America/Los_Angeles', portland: 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles', 'los angeles': 'America/Los_Angeles',
  denver: 'America/Denver', colorado: 'America/Denver', boulder: 'America/Denver', 'salt lake city': 'America/Denver', phoenix: 'America/Phoenix',
  nashville: 'America/Chicago', chicago: 'America/Chicago', dallas: 'America/Chicago', houston: 'America/Chicago', austin: 'America/Chicago',
  'new york': 'America/New_York', boston: 'America/New_York', atlanta: 'America/New_York', miami: 'America/New_York',
  virginia: 'America/New_York', 'washington dc': 'America/New_York', 'washington d c': 'America/New_York',
  // Elsewhere
  santiago: 'America/Santiago', 'santo domingo': 'America/Santo_Domingo',
  london: 'Europe/London', manchester: 'Europe/London', edinburgh: 'Europe/London', dublin: 'Europe/Dublin',
  brisbane: 'Australia/Brisbane', sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne', perth: 'Australia/Perth',
};

const CITY_IN_COUNTRY = {
  'london|canada': 'America/Toronto',
  'kingston|jamaica': 'America/Jamaica',
  'santiago|dominican republic': 'America/Santo_Domingo',
  'victoria|australia': 'Australia/Melbourne',
  'richmond|united states': 'America/New_York',
  'portland|united states|maine': 'America/New_York',
  'montrose|canada': 'America/Vancouver',
  'montrose|united states': 'America/Denver',
  'montrose|united kingdom': 'Europe/London',
  'washington|united states': null, // DC or the state: decided by the state below
};

const STATES = {
  // Canada
  'british columbia': 'America/Vancouver', bc: 'America/Vancouver',
  alberta: 'America/Edmonton', ab: 'America/Edmonton',
  saskatchewan: 'America/Regina', sk: 'America/Regina',
  manitoba: 'America/Winnipeg', mb: 'America/Winnipeg',
  ontario: 'America/Toronto', on: 'America/Toronto',
  quebec: 'America/Toronto', qc: 'America/Toronto',
  'new brunswick': 'America/Moncton', nb: 'America/Moncton',
  'nova scotia': 'America/Halifax', ns: 'America/Halifax',
  'prince edward island': 'America/Halifax', pe: 'America/Halifax', pei: 'America/Halifax',
  'newfoundland and labrador': 'America/St_Johns', nl: 'America/St_Johns',
  yukon: 'America/Whitehorse', yt: 'America/Whitehorse',
  'northwest territories': 'America/Yellowknife', nt: 'America/Yellowknife',
  // United States (only states in one zone, or nearly)
  washington: 'America/Los_Angeles', wa: 'America/Los_Angeles',
  oregon: 'America/Los_Angeles', california: 'America/Los_Angeles',
  colorado: 'America/Denver', co: 'America/Denver', utah: 'America/Denver', arizona: 'America/Phoenix',
  tennessee: 'America/Chicago', tn: 'America/Chicago', illinois: 'America/Chicago', texas: 'America/Chicago',
  virginia: 'America/New_York', va: 'America/New_York', 'new york': 'America/New_York', ny: 'America/New_York',
  maine: 'America/New_York', massachusetts: 'America/New_York', georgia: 'America/New_York',
  'district of columbia': 'America/New_York', dc: 'America/New_York',
};

/** FreshService (Rails) zone names. "Pacific Time" is handled apart: it is the default. */
const FS_ZONES = [
  ['mountain time', 'America/Edmonton'],
  ['central time', 'America/Winnipeg'],
  ['eastern time', 'America/Toronto'],
  ['atlantic time', 'America/Halifax'],
  ['newfoundland', 'America/St_Johns'],
  ['saskatchewan', 'America/Regina'],
  ['arizona', 'America/Phoenix'],
  ['santiago', 'America/Santiago'],
  ['brisbane', 'Australia/Brisbane'],
  ['sydney', 'Australia/Sydney'],
  ['melbourne', 'Australia/Melbourne'],
  ['perth', 'Australia/Perth'],
  ['london', 'Europe/London'],
  ['edinburgh', 'Europe/London'],
  ['dublin', 'Europe/Dublin'],
  ['bogota', 'America/Bogota'],
  ['lima', 'America/Lima'],
  ['buenos aires', 'America/Argentina/Buenos_Aires'],
];

const titleCase = (s) => String(s || '').trim().replace(/\s+/g, ' ');

/** "America/Santo_Domingo" → "Santo Domingo". */
export function placeOfZone(timezone) {
  const last = String(timezone || '').split('/').pop() || '';
  return last.replace(/_/g, ' ');
}

function cityZone(city, country, state) {
  const c = norm(city);
  if (!c) return undefined;
  const ctry = countryOf(country);
  const st = norm(state);
  if (ctry && st && Object.prototype.hasOwnProperty.call(CITY_IN_COUNTRY, `${c}|${ctry}|${st}`)) return CITY_IN_COUNTRY[`${c}|${ctry}|${st}`];
  if (ctry && Object.prototype.hasOwnProperty.call(CITY_IN_COUNTRY, `${c}|${ctry}`)) return CITY_IN_COUNTRY[`${c}|${ctry}`];
  return CITIES[c];
}

/** A known city named inside an office location ("Calgary Office", "Toronto - King St"). */
function officeZone(office) {
  const text = ` ${norm(office)} `;
  if (!text.trim()) return null;
  let best = null;
  for (const [name, tz] of Object.entries(CITIES)) {
    if (text.includes(` ${name} `) && (!best || name.length > best.name.length)) best = { name, tz };
  }
  return best;
}

export function resolveRequesterTimezone(requester) {
  if (!requester || typeof requester !== 'object') return null;
  const { entraCity, entraCountry, entraState, entraOfficeLocation, timeZone } = requester;

  const fromCity = cityZone(entraCity, entraCountry, entraState);
  if (fromCity) return { timezone: fromCity, source: 'entra_city', confidence: 'high', place: titleCase(entraCity) };

  const office = officeZone(entraOfficeLocation);
  if (office) return { timezone: office.tz, source: 'entra_office', confidence: 'high', place: office.name.replace(/\b\w/g, (ch) => ch.toUpperCase()) };

  const ctry = countryOf(entraCountry);
  const st = norm(entraState);
  if (st && (!ctry || ctry === 'canada' || ctry === 'united states') && STATES[st]) {
    return { timezone: STATES[st], source: 'entra_state', confidence: 'medium', place: titleCase(entraCity) || titleCase(entraState) };
  }

  if (ctry && SINGLE_ZONE_COUNTRIES[ctry]) {
    return { timezone: SINGLE_ZONE_COUNTRIES[ctry], source: 'entra_country', confidence: 'medium', place: titleCase(entraCity) || titleCase(entraCountry) };
  }

  const fs = norm(timeZone);
  if (fs) {
    const hit = FS_ZONES.find(([name]) => fs.startsWith(name) || fs.includes(name));
    if (hit) return { timezone: hit[1], source: 'freshservice', confidence: 'medium', place: placeOfZone(hit[1]) };
    if (fs.startsWith('pacific time')) return { timezone: 'America/Vancouver', source: 'freshservice_default', confidence: 'low', place: 'Vancouver' };
  }
  return null;
}

/** Minutes east of UTC for a zone at `at` (e.g. Santiago in November → -180). Null when unknown. */
export function utcOffsetMinutes(timeZone, at = new Date()) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(at).find((p) => p.type === 'timeZoneName')?.value || '';
    if (part === 'GMT' || part === 'UTC') return 0;
    const m = part.match(/([+−-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return null;
    const sign = m[1] === '+' ? 1 : -1;
    return sign * (Number(m[2]) * 60 + Number(m[3] || 0));
  } catch {
    return null;
  }
}

/** "UTC−3", "UTC+10", "UTC−3:30" (a real minus sign). */
export function formatUtcOffset(minutes) {
  if (!Number.isFinite(minutes)) return null;
  if (minutes === 0) return 'UTC';
  const sign = minutes < 0 ? '−' : '+';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}
