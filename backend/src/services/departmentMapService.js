import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';
import {
  DEFAULT_DEPARTMENT_MAP, PROFESSIONAL_LADDER_LABEL, mergeDepartmentMap, departmentOf, cityOf,
} from '../utils/requesterDepartment.js';

/**
 * The department table in force (QA 11-24, item 1): the code defaults in
 * utils/requesterDepartment.js with the admin override from app_settings
 * `department_map` merged over them.
 *
 * The override is a JSON object, job class (no level) → department label:
 *   {"Senior": "Engineering", "Health and Safety*": "HSE", "CAD": "Drafting"}
 * A key ending in "*" matches every job class starting with it; a value of ""
 * or null removes a default (that job class keeps its own name). Requesters are
 * shared by every workspace, so the table is app-wide, not per workspace.
 *
 * Read through a 60-second cache; a bad or missing value falls back to the
 * defaults and never fails a page.
 */
export const DEPARTMENT_MAP_SETTING = 'department_map';
const TTL_MS = 60_000;

let cached = { at: 0, overrides: null, map: DEFAULT_DEPARTMENT_MAP };
let inflight = null;

function parseOverrides(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    logger.warn(`app_settings ${DEPARTMENT_MAP_SETTING} is not valid JSON; using the default department table (${err.message})`);
    return null;
  }
}

/** The effective table. Cached; never throws. */
export async function getDepartmentMap({ fresh = false } = {}) {
  if (!fresh && Date.now() - cached.at < TTL_MS) return cached.map;
  if (inflight) return inflight;
  inflight = Promise.resolve()
    .then(() => settingsRepository.get(DEPARTMENT_MAP_SETTING))
    .catch(() => null)
    .then((raw) => {
      const overrides = parseOverrides(raw);
      cached = { at: Date.now(), overrides, map: mergeDepartmentMap(overrides) };
      return cached.map;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * The table as last read, for synchronous callers (payload builders). Starts
 * as the defaults; a stale cache kicks off a background re-read.
 */
export function currentDepartmentMap() {
  if (Date.now() - cached.at >= TTL_MS && !inflight) getDepartmentMap().catch(() => {});
  return cached.map;
}

/** Defaults, override and the merged result, for the read-only views. */
export async function describeDepartmentMap() {
  const map = await getDepartmentMap();
  return {
    settingKey: DEPARTMENT_MAP_SETTING,
    professionalLadderLabel: PROFESSIONAL_LADDER_LABEL,
    defaults: DEFAULT_DEPARTMENT_MAP,
    overrides: cached.overrides || {},
    effective: map,
  };
}

/** Test hook. */
export function resetDepartmentMapCache() {
  cached = { at: 0, overrides: null, map: DEFAULT_DEPARTMENT_MAP };
  inflight = null;
}

/** departmentOf / cityOf against the table in force. */
export async function requesterPlaceAndDepartment(requester) {
  const map = await getDepartmentMap();
  return { department: departmentOf(requester, map), city: cityOf(requester, map) };
}

export default { getDepartmentMap, currentDepartmentMap, describeDepartmentMap, resetDepartmentMapCache, requesterPlaceAndDepartment, DEPARTMENT_MAP_SETTING };
