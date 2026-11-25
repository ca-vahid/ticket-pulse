import { useEffect, useState } from 'react';

/**
 * A requester's department and city, kept apart (QA 11-24, item 1).
 *
 * Mirror of backend/src/utils/requesterDepartment.js — same table, same rules;
 * requesterDepartment.test.js holds the two to the same answers. In short:
 *   requesters.department (FreshService) is the office CITY in this tenant;
 *   requesters.entra_department is the job class plus a level ("Contracts III").
 * departmentOf() → the job class without its level, renamed through the table.
 * cityOf()       → Entra city, then Entra office, then the FreshService value
 *                  when it reads as a place.
 *
 * Admins can override the table with the app_settings key `department_map`;
 * useDepartmentMap() loads the table in force once per session (GET
 * /tickets/department-map) and re-renders its caller when it lands. Until then,
 * and if the read fails, the defaults below apply.
 */

export const PROFESSIONAL_LADDER_LABEL = 'Geoscience & Engineering';
export const UNKNOWN_DEPARTMENT = 'Unknown';

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

const NOT_A_PLACE = [/non-bgc/i, /bgc europe/i, /\blab\b/i];

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

export function stripLevel(value) {
  const text = clean(value);
  if (!text) return '';
  const stripped = text.replace(/\s+(?:VI|IV|V|I{1,3}|\d+)$/, '').trim();
  return stripped || text;
}

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

function knownLabels(map) {
  const out = new Set();
  for (const [k, label] of Object.entries(map || {})) {
    out.add(clean(label).toLowerCase());
    if (!k.endsWith('*')) out.add(clean(k).toLowerCase());
  }
  return out;
}

export function normalizeDepartment(value, map = currentMap) {
  const base = stripLevel(value);
  if (!base) return null;
  return lookup(base, map) || base;
}

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

/** The requester's department (job class, no level), or null. */
export function departmentOf(requester, map = currentMap) {
  if (!requester) return null;
  const fromEntra = normalizeDepartment(requester.entraDepartment, map);
  if (fromEntra) return fromEntra;
  const fs = clean(requester.department);
  if (!fs || NOT_A_PLACE.some((re) => re.test(fs))) return null;
  const { rest } = splitFsDepartment(fs);
  if (rest) return normalizeDepartment(rest, map);
  return isRecognizedDepartment(fs, map) ? normalizeDepartment(fs, map) : null;
}

/** The requester's city, or null. */
export function cityOf(requester, map = currentMap) {
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

/**
 * The ticket's requester with the ticket's own FreshService department filled
 * in when the requester row has none (tickets.department holds the same value).
 */
export function ticketRequesterPlace(ticket) {
  const r = ticket?.requester || {};
  return { ...r, department: r.department || ticket?.department || null };
}

// ---- the table in force (defaults + admin override), loaded once ----------

let currentMap = DEFAULT_DEPARTMENT_MAP;
let loadPromise = null;
const listeners = new Set();

/** Test hook / sign-out: back to the defaults. */
export function resetDepartmentMap() {
  currentMap = DEFAULT_DEPARTMENT_MAP;
  loadPromise = null;
}

/** Install a table (the API's `effective` map). */
export function setDepartmentMap(effective) {
  currentMap = effective && typeof effective === 'object' ? { ...effective } : DEFAULT_DEPARTMENT_MAP;
  for (const fn of listeners) fn(currentMap);
}

export function loadDepartmentMap() {
  if (!loadPromise) {
    loadPromise = import('../services/api')
      .then(({ ticketsAPI }) => ticketsAPI.getDepartmentMap())
      .then((res) => { if (res?.data?.effective) setDepartmentMap(res.data.effective); return currentMap; })
      .catch(() => currentMap);
  }
  return loadPromise;
}

/** The table in force; re-renders the caller once the admin override loads. */
export function useDepartmentMap() {
  const [map, setMap] = useState(currentMap);
  useEffect(() => {
    listeners.add(setMap);
    loadDepartmentMap();
    return () => { listeners.delete(setMap); };
  }, []);
  return map;
}
