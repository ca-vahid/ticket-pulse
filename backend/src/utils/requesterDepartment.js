/**
 * A requester's department and city, kept apart (QA 11-24, item 1).
 *
 * The data mixes two things under "department":
 *   - requesters.department (and tickets.department) is FreshService's
 *     department, which in this tenant is the office CITY: "Vancouver",
 *     "Calgary", "Montreal, QC", and a few odd ones ("Vancouver - Software",
 *     "Non-BGC Email").
 *   - requesters.entra_department is Entra's department, which holds the job
 *     class plus a level: "Senior I", "Accountant I", "Contracts III".
 *
 * departmentOf() answers "which department": the Entra job class without its
 * level, renamed through one table (DEFAULT_DEPARTMENT_MAP). cityOf() answers
 * "which city": Entra's city, then Entra's office, then the FreshService
 * department when it reads as a place.
 *
 * Pure module (no imports): the frontend keeps a mirror in
 * frontend/src/utils/requesterDepartment.js and a parity test holds the two to
 * the same answers. Admins can change the table without a release through the
 * app_settings key `department_map` (services/departmentMapService.js); that
 * override merges over these defaults.
 */

/**
 * The professional ladder (Junior … Principal, interns, consultants) is the
 * engineering and geoscience staff. The label is a product decision; change it
 * here (and in the frontend mirror) or override it per key in `department_map`.
 */
export const PROFESSIONAL_LADDER_LABEL = 'Geoscience & Engineering';

/** The label for a requester with no department anywhere. */
export const UNKNOWN_DEPARTMENT = 'Unknown';

/**
 * Job class (level already stripped, compared without case) → department.
 * A key ending in "*" matches any job class that starts with it
 * ("Health and Safety Coordinator"). A job class with no entry keeps its own
 * name: Software, CAD, Admin, HR, GIS, Technician, Library, Documents,
 * Contracts, Project Controls, Data Management, Information Management.
 */
export const DEFAULT_DEPARTMENT_MAP = Object.freeze({
  Junior: PROFESSIONAL_LADDER_LABEL,
  Intermediate: PROFESSIONAL_LADDER_LABEL,
  Senior: PROFESSIONAL_LADDER_LABEL,
  Principal: PROFESSIONAL_LADDER_LABEL,
  'Student Intern': PROFESSIONAL_LADDER_LABEL,
  'Junior Intern': PROFESSIONAL_LADDER_LABEL,
  Consultant: PROFESSIONAL_LADDER_LABEL,
  Accountant: 'Accounting',
  'Project Accountant': 'Project Accounting',
  'Information Technology': 'IT',
  HS: 'Health & Safety',
  'Health and Safety*': 'Health & Safety',
  'Health & Safety*': 'Health & Safety',
  FE: 'Field Equipment',
  Marcom: 'Marketing & Communications',
  Payroll: 'Payroll',
  'Payroll Manager': 'Payroll',
  'Financial Controller': 'Finance',
  'Finance Manager': 'Finance',
  'Regional Controller': 'Finance',
});

// FreshService "departments" that are neither a city nor a department.
const NOT_A_PLACE = [/non-bgc/i, /bgc europe/i, /\blab\b/i];

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * "Contracts III" → "Contracts", "Senior I" → "Senior", "Data Management V" →
 * "Data Management", "Level 2" → "Level". Roman numerals I–VI (upper case only,
 * so a word ending in "v" is never cut) or digits, after a space.
 */
export function stripLevel(value) {
  const text = clean(value);
  if (!text) return '';
  const stripped = text.replace(/\s+(?:VI|IV|V|I{1,3}|\d+)$/, '').trim();
  return stripped || text;
}

/**
 * The effective table: defaults with the admin override merged over them.
 * An override value of null or "" removes that key (the job class then keeps
 * its own name).
 */
export function mergeDepartmentMap(overrides = null, defaults = DEFAULT_DEPARTMENT_MAP) {
  const merged = { ...defaults };
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    for (const [key, label] of Object.entries(overrides)) {
      const k = clean(key);
      if (!k) continue;
      const v = clean(label);
      if (v) merged[k] = v;
      else delete merged[k];
    }
  }
  return merged;
}

function lookup(jobClass, map) {
  const key = clean(jobClass).toLowerCase();
  if (!key) return null;
  let prefixHit = null;
  let prefixLen = -1;
  for (const [k, label] of Object.entries(map || {})) {
    const lk = k.toLowerCase();
    if (lk.endsWith('*')) {
      const stem = lk.slice(0, -1).trim();
      if (stem && key.startsWith(stem) && stem.length > prefixLen) { prefixHit = label; prefixLen = stem.length; }
    } else if (lk === key) {
      return label;
    }
  }
  return prefixHit;
}

/** Department labels the table produces, compared without case. */
function knownLabels(map) {
  const out = new Set();
  for (const [k, label] of Object.entries(map || {})) {
    out.add(clean(label).toLowerCase());
    if (!k.endsWith('*')) out.add(clean(k).toLowerCase());
  }
  return out;
}

/** One Entra/FS department value → the department label, or null. */
export function normalizeDepartment(value, map = DEFAULT_DEPARTMENT_MAP) {
  const base = stripLevel(value);
  if (!base) return null;
  return lookup(base, map) || base;
}

/** "Vancouver - Software" → { place: "Vancouver", rest: "Software" }. */
function splitFsDepartment(value) {
  const text = clean(value);
  if (!text) return { place: '', rest: '' };
  const m = /^(.+?)\s+[-–]\s+(.+)$/.exec(text);
  return m ? { place: m[1].trim(), rest: m[2].trim() } : { place: text, rest: '' };
}

function isRecognizedDepartment(value, map) {
  const base = stripLevel(value);
  if (!base) return false;
  if (lookup(base, map)) return true;
  return knownLabels(map).has(base.toLowerCase());
}

/**
 * The requester's department: Entra's job class without its level, renamed
 * through the table. With no Entra department, the department half of a
 * FreshService value like "Vancouver - Software", or a FreshService value that
 * is itself a known department. Null when there is none (a city is not one).
 */
export function departmentOf(requester, map = DEFAULT_DEPARTMENT_MAP) {
  if (!requester) return null;
  const fromEntra = normalizeDepartment(requester.entraDepartment, map);
  if (fromEntra) return fromEntra;
  const fs = clean(requester.department);
  if (!fs || NOT_A_PLACE.some((re) => re.test(fs))) return null;
  const { rest } = splitFsDepartment(fs);
  if (rest) return normalizeDepartment(rest, map);
  return isRecognizedDepartment(fs, map) ? normalizeDepartment(fs, map) : null;
}

/**
 * The requester's city: Entra's city, then Entra's office location, then the
 * FreshService department when it reads as a place ("Vancouver - Software" →
 * "Vancouver"; "Non-BGC Email" is not a place, nor is a known department).
 */
export function cityOf(requester, map = DEFAULT_DEPARTMENT_MAP) {
  if (!requester) return null;
  const entraCity = clean(requester.entraCity);
  if (entraCity) return entraCity;
  const office = clean(requester.entraOfficeLocation);
  if (office) return office;
  const fs = clean(requester.department);
  if (!fs || NOT_A_PLACE.some((re) => re.test(fs))) return null;
  const { place, rest } = splitFsDepartment(fs);
  if (rest) return place || null;
  return isRecognizedDepartment(fs, map) ? null : fs;
}

export default { departmentOf, cityOf, stripLevel, normalizeDepartment, mergeDepartmentMap, DEFAULT_DEPARTMENT_MAP, PROFESSIONAL_LADDER_LABEL, UNKNOWN_DEPARTMENT };
