// On/Offboarding → People: client-side sort and filters for the families table (QA 11-10 #2).
// The kind and status tabs stay server-side; everything here works on the rows already loaded.

import { FAMILY_STATUS, KIND_LABEL } from './onboardingFormat';

export const SORT_KEY = 'tp.onboarding.people.sort';
export const FILTERS_KEY = 'tp.onboarding.people.filters';
export const NO_OWNER = '__none';
export const EMPTY_FILTERS = { q: '', agent: '', location: '' };

const COLLATOR = { sensitivity: 'base' };
const cmpText = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, COLLATOR);

/** Lower case with the accents taken off, so "Zoe" finds "Zoë". */
export function fold(value) {
  return String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The status word the row shows (Shadow rows read "Shadow"). */
export function familyStatus(f) {
  if (f?.shadow) return { tone: 'amber', label: f.status === 'cancelled' ? 'Shadow · cancelled' : 'Shadow' };
  return FAMILY_STATUS[f?.status] || FAMILY_STATUS.open;
}

/** The people holding a family's tickets; Shadow rows have nobody yet. */
export function ownersOf(f) {
  return f?.shadow ? [] : (Array.isArray(f?.assignees) ? f.assignees : []);
}

const dateValue = (f) => {
  if (!f?.effectiveDate) return null;
  const t = Date.parse(String(f.effectiveDate).length === 10 ? `${f.effectiveDate}T12:00:00Z` : f.effectiveDate);
  return Number.isNaN(t) ? null : t;
};

const doneValue = (f) => (f?.progress?.total ? (f.progress.done || 0) / f.progress.total : null);

/**
 * Per column: the value to compare and how. A null value has nothing to sort
 * by (no date, no owner, no children) and goes last whichever way the column runs.
 */
const COLUMNS = {
  person: { value: (f) => f.personName || null, cmp: cmpText },
  kind: { value: (f) => KIND_LABEL[f.kind] || f.kind || null, cmp: cmpText },
  date: { value: dateValue, cmp: (a, b) => a - b },
  children: { value: doneValue, cmp: (a, b) => a - b },
  owner: { value: (f) => ownersOf(f)[0]?.name || null, cmp: cmpText },
  status: { value: (f) => familyStatus(f).label, cmp: cmpText },
};

export const SORTABLE = Object.keys(COLUMNS);

function compareBy(key, a, b, dir = 1) {
  const col = COLUMNS[key];
  const va = col.value(a);
  const vb = col.value(b);
  if (va == null && vb == null) return 0;
  if (va == null) return 1;
  if (vb == null) return -1;
  return dir * col.cmp(va, vb);
}

/**
 * Sorted copy of the rows. `sort` is { key, dir: 'asc' | 'desc' } or null
 * (null keeps the server's order). Ties: Date, then Person, then the server's order.
 */
export function sortFamilies(rows, sort) {
  const list = Array.isArray(rows) ? rows : [];
  if (!sort || !COLUMNS[sort.key]) return list;
  const dir = sort.dir === 'desc' ? -1 : 1;
  return list
    .map((f, i) => ({ f, i }))
    .sort((x, y) => compareBy(sort.key, x.f, y.f, dir)
      || (sort.key !== 'date' ? compareBy('date', x.f, y.f) : 0)
      || (sort.key !== 'person' ? compareBy('person', x.f, y.f) : 0)
      || x.i - y.i)
    .map((x) => x.f);
}

/** Next sort after a header click: ascending, then descending, then the server's order. */
export function nextSort(sort, key) {
  if (!sort || sort.key !== key) return { key, dir: 'asc' };
  if (sort.dir === 'asc') return { key, dir: 'desc' };
  return null;
}

export function filterFamilies(rows, filters = EMPTY_FILTERS) {
  const list = Array.isArray(rows) ? rows : [];
  const q = fold(filters.q).trim();
  return list.filter((f) => {
    if (q && !fold(f.personName).includes(q) && !fold(f.office).includes(q)) return false;
    if (filters.agent) {
      const owners = ownersOf(f);
      if (filters.agent === NO_OWNER ? owners.length > 0 : !owners.some((o) => String(o.id) === filters.agent)) return false;
    }
    if (filters.location && f.office !== filters.location) return false;
    return true;
  });
}

/** The owners present in the rows, by name, each once; `none` says a row has no owner. */
export function agentOptions(rows) {
  const byId = new Map();
  let none = false;
  for (const f of rows || []) {
    const owners = ownersOf(f);
    if (!owners.length) none = true;
    for (const o of owners) if (o?.id != null && !byId.has(String(o.id))) byId.set(String(o.id), o.name || `Technician ${o.id}`);
  }
  const people = [...byId].map(([value, label]) => ({ value, label })).sort((a, b) => cmpText(a.label, b.label));
  return { people, none };
}

export function locationOptions(rows) {
  return [...new Set((rows || []).map((f) => f.office).filter(Boolean))].sort(cmpText);
}

export function filtersActive(filters) {
  return Boolean(filters?.q?.trim() || filters?.agent || filters?.location);
}

// ---------------------------------------------------------------- remembered per browser

export function readStored(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key, value) {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private window or blocked storage: the page works without it.
  }
}

export function readSort() {
  const s = readStored(SORT_KEY, null);
  return s && COLUMNS[s.key] && (s.dir === 'asc' || s.dir === 'desc') ? { key: s.key, dir: s.dir } : null;
}

export function readFilters() {
  const f = readStored(FILTERS_KEY, null);
  if (!f || typeof f !== 'object') return EMPTY_FILTERS;
  return {
    q: typeof f.q === 'string' ? f.q : '',
    agent: typeof f.agent === 'string' ? f.agent : '',
    location: typeof f.location === 'string' ? f.location : '',
  };
}
