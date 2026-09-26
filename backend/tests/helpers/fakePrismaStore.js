/**
 * A tiny in-memory stand-in for the Prisma client, enough for the Auto-help
 * follow-up timeline tests to run the REAL park service, business calendar
 * and delivery/follow-up services against rows they can read back.
 *
 * Supported: findFirst / findMany / findUnique / create / update / updateMany /
 * upsert / count / aggregate(_sum) / groupBy(no) with where filters: equality,
 * null, { not, in, notIn, gt, gte, lt, lte, contains, startsWith, equals },
 * OR / AND / NOT; orderBy (one or more fields), take, skip; data values with
 * { increment, decrement }. `select` / `include` return the full row (rows
 * that need relations store them inline, e.g. ticket.requester).
 */
const OPS = new Set(['not', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'equals', 'mode']);

function val(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).getTime();
  return v;
}

function condMatch(actual, cond) {
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date || typeof cond !== 'object' || Array.isArray(cond)) return val(actual) === val(cond);
  const keys = Object.keys(cond);
  if (!keys.some((k) => OPS.has(k))) return true; // relation filters etc.: not modelled
  for (const [op, v] of Object.entries(cond)) {
    const a = val(actual);
    if (op === 'mode') continue;
    if (op === 'equals' && !(typeof a === 'string' && typeof v === 'string' ? a.toLowerCase() === v.toLowerCase() : a === val(v))) return false;
    if (op === 'not') {
      if (v === null) { if (actual === null || actual === undefined) return false; continue; }
      if (typeof v === 'object' && !(v instanceof Date)) { if (condMatch(actual, v)) return false; continue; }
      if (a === val(v)) return false;
    }
    if (op === 'in' && !v.map(val).includes(a)) return false;
    if (op === 'notIn' && v.map(val).includes(a)) return false;
    if (op === 'gt' && !(a !== null && a !== undefined && a > val(v))) return false;
    if (op === 'gte' && !(a !== null && a !== undefined && a >= val(v))) return false;
    if (op === 'lt' && !(a !== null && a !== undefined && a < val(v))) return false;
    if (op === 'lte' && !(a !== null && a !== undefined && a <= val(v))) return false;
    if (op === 'contains' && !String(actual ?? '').toLowerCase().includes(String(v).toLowerCase())) return false;
    if (op === 'startsWith' && !String(actual ?? '').startsWith(String(v))) return false;
  }
  return true;
}

export function matches(row, where = {}) {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'OR') { if (!cond.some((w) => matches(row, w))) return false; continue; }
    if (key === 'AND') { if (!(Array.isArray(cond) ? cond : [cond]).every((w) => matches(row, w))) return false; continue; }
    if (key === 'NOT') { if ((Array.isArray(cond) ? cond : [cond]).some((w) => matches(row, w))) return false; continue; }
    if (!condMatch(row[key], cond)) return false;
  }
  return true;
}

function applyData(row, data) {
  const out = { ...row };
  for (const [k, v] of Object.entries(data || {})) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && ('increment' in v || 'decrement' in v)) {
      out[k] = (Number(out[k]) || 0) + (v.increment ?? 0) - (v.decrement ?? 0);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function sortRows(rows, orderBy) {
  const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  if (!list.length) return rows;
  return [...rows].sort((x, y) => {
    for (const o of list) {
      const [k, dir] = Object.entries(o)[0];
      const a = val(x[k]); const b = val(y[k]);
      if (a === b) continue;
      if (a === null || a === undefined) return 1;
      if (b === null || b === undefined) return -1;
      return (a < b ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

const clone = (r) => (r ? { ...r } : null);

export function createFakePrisma(seed = {}) {
  const tables = {};
  const nextId = {};
  const table = (name) => {
    if (!tables[name]) { tables[name] = []; nextId[name] = 1; }
    return tables[name];
  };
  const model = (name) => ({
    findMany: async ({ where, orderBy, take, skip } = {}) => {
      let rows = table(name).filter((r) => matches(r, where));
      rows = sortRows(rows, orderBy);
      if (skip) rows = rows.slice(skip);
      if (take !== undefined) rows = rows.slice(0, take);
      return rows.map(clone);
    },
    findFirst: async ({ where, orderBy } = {}) => clone(sortRows(table(name).filter((r) => matches(r, where)), orderBy)[0] || null),
    findUnique: async ({ where } = {}) => clone(table(name).find((r) => matches(r, where)) || null),
    count: async ({ where } = {}) => table(name).filter((r) => matches(r, where)).length,
    create: async ({ data }) => {
      const t = table(name);
      const row = { id: data.id ?? nextId[name]++, createdAt: new Date(), ...data };
      if (row.id >= nextId[name]) nextId[name] = row.id + 1;
      t.push(row);
      return clone(row);
    },
    update: async ({ where, data }) => {
      const t = table(name);
      const i = t.findIndex((r) => matches(r, where));
      if (i < 0) throw new Error(`${name} not found for update`);
      t[i] = applyData(t[i], data);
      return clone(t[i]);
    },
    updateMany: async ({ where, data }) => {
      const t = table(name);
      let count = 0;
      t.forEach((r, i) => { if (matches(r, where)) { t[i] = applyData(r, data); count += 1; } });
      return { count };
    },
    deleteMany: async ({ where } = {}) => {
      const t = table(name);
      const keep = t.filter((r) => !matches(r, where));
      const count = t.length - keep.length;
      t.splice(0, t.length, ...keep);
      return { count };
    },
    upsert: async ({ where, create, update }) => {
      const t = table(name);
      const i = t.findIndex((r) => matches(r, where));
      if (i < 0) { t.push({ ...create }); return clone(t[t.length - 1]); }
      t[i] = applyData(t[i], update);
      return clone(t[i]);
    },
    aggregate: async ({ where, _sum = {} } = {}) => {
      const rows = table(name).filter((r) => matches(r, where));
      const sum = {};
      for (const k of Object.keys(_sum)) sum[k] = rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
      return { _sum: sum };
    },
  });
  const models = new Map();
  const client = new Proxy({}, {
    get(_t, prop) {
      if (prop === '$transaction') return async (arg) => (typeof arg === 'function' ? arg(client) : Promise.all(arg));
      if (prop === '_tables') return tables;
      if (prop === '_rows') return (name) => table(name);
      if (prop === 'then') return undefined;
      if (typeof prop !== 'string') return undefined;
      if (!models.has(prop)) models.set(prop, model(prop));
      return models.get(prop);
    },
  });
  for (const [name, rows] of Object.entries(seed)) {
    for (const r of rows) table(name).push({ ...r });
    nextId[name] = Math.max(1, ...table(name).map((r) => (Number(r.id) || 0) + 1));
  }
  return client;
}
