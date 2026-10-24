/**
 * Confluence Cloud REST client (QA 10-23 #4, Confluence -> Knowledge).
 *
 * Read-only. Basic auth with an Atlassian account e-mail + API token (a
 * service account the team creates; the token is never logged). Uses the
 * v2 API for spaces, page trees and page bodies (storage format), and the v1
 * API only where v2 has nothing: CQL search and page read restrictions.
 *
 * Polite by default: one request at a time per client with at least
 * MIN_GAP_MS between them; a 429 (or 503) waits for Retry-After (capped)
 * and tries again, up to MAX_RETRIES. Lists follow the cursor in
 * `_links.next` until it runs out, bounded by maxItems; a list that hit the
 * bound says so (complete: false), so callers never treat it as the whole.
 *
 * fetchImpl and sleep are seams for tests.
 */
export const MIN_GAP_MS = 200;
export const MAX_RETRIES = 5;
export const MAX_RETRY_WAIT_MS = 60 * 1000;
export const REQUEST_TIMEOUT_MS = 30 * 1000;
export const PAGE_LIMIT = 250;
export const BODY_PAGE_LIMIT = 100;
export const MAX_LIST_ITEMS = 5000;

export class ConfluenceError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'ConfluenceError';
    this.status = status;
    this.code = code;
  }
}

/**
 * "https://example.atlassian.net/wiki/spaces/IT" -> "https://example.atlassian.net".
 * Only https; returns null for anything else.
 */
export function normalizeSiteUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  if (!/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes('.')) return null;
  return `https://${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}`;
}

/** Retry-After (seconds or an HTTP date) -> milliseconds, capped. */
export function retryAfterMs(value, attempt = 0, now = Date.now()) {
  const fallback = Math.min(MAX_RETRY_WAIT_MS, 2000 * 2 ** attempt);
  if (value === undefined || value === null || value === '') return fallback;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(MAX_RETRY_WAIT_MS, Math.max(0, secs * 1000));
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.min(MAX_RETRY_WAIT_MS, Math.max(0, at - now)) : fallback;
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

function friendly(status) {
  if (status === 401) return 'Confluence did not accept the e-mail and API token. Check both, and that the token has not expired.';
  if (status === 403) return 'The Confluence account can sign in but may not read this. Give it read access to the spaces.';
  if (status === 404) return 'Confluence did not find that page or space.';
  if (status === 429) return 'Confluence asked us to slow down and kept refusing. Try again later.';
  return `Confluence answered ${status}.`;
}

/** One page of a v2 page list -> the fields Ticket Pulse keeps. */
export function pageSummary(p) {
  const storage = p?.body?.storage?.value;
  return {
    id: String(p?.id ?? ''),
    title: String(p?.title || '').slice(0, 300),
    parentId: p?.parentId ? String(p.parentId) : null,
    parentType: p?.parentType || null,
    spaceId: p?.spaceId ? String(p.spaceId) : null,
    status: p?.status || null,
    version: Number(p?.version?.number) || 1,
    updatedAt: p?.version?.createdAt || p?.createdAt || null,
    createdAt: p?.createdAt || null,
    webui: p?._links?.webui || null,
    ...(typeof storage === 'string' ? { storage } : {}),
  };
}

export function createConfluenceClient({
  siteUrl, email, apiToken, fetchImpl = globalThis.fetch, sleep = defaultSleep, minGapMs = MIN_GAP_MS,
} = {}) {
  const base = normalizeSiteUrl(siteUrl);
  if (!base) throw new ConfluenceError('The Confluence site address must be an https address, like https://example.atlassian.net', { code: 'bad_site' });
  if (!email || !apiToken) throw new ConfluenceError('Confluence needs an account e-mail and an API token', { code: 'no_credentials' });
  const auth = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
  let lastAt = 0;
  let chain = Promise.resolve();

  /** Absolute URL for a path or a `_links.next` value; never another host. */
  const urlFor = (pathOrUrl, params = null) => {
    const raw = String(pathOrUrl || '');
    let url;
    if (/^https?:\/\//i.test(raw)) url = new URL(raw);
    else if (raw.startsWith('/wiki/')) url = new URL(`${base}${raw}`);
    else url = new URL(`${base}/wiki${raw.startsWith('/') ? '' : '/'}${raw}`);
    if (`${url.protocol}//${url.host}` !== base) throw new ConfluenceError('Confluence pointed a page list at another site; stopped.', { code: 'foreign_link' });
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    return url.toString();
  };

  const once = async (url) => {
    const wait = lastAt + minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
    return fetchImpl(url, { method: 'GET', headers: { Authorization: auth, Accept: 'application/json' }, ...(signal ? { signal } : {}) });
  };

  /** GET with throttle + Retry-After. Requests are serialized per client. */
  const get = (pathOrUrl, params = null) => {
    const run = async () => {
      const url = urlFor(pathOrUrl, params);
      for (let attempt = 0; ; attempt += 1) {
        let res;
        try {
          res = await once(url);
        } catch (err) {
          if (attempt >= 2) throw new ConfluenceError(`Could not reach Confluence (${err.message})`, { code: 'network' });
          await sleep(retryAfterMs(null, attempt));
          continue;
        }
        if (res.status === 429 || res.status === 503 || (res.status >= 500 && attempt < 2)) {
          if (attempt >= MAX_RETRIES) throw new ConfluenceError(friendly(res.status), { status: res.status });
          const header = typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : res.headers?.['retry-after'];
          await sleep(retryAfterMs(header, attempt));
          continue;
        }
        if (!res.ok) throw new ConfluenceError(friendly(res.status), { status: res.status });
        return res.json();
      }
    };
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  };

  /** Every item of a cursor-paged list (bounded). { items, complete } */
  const list = async (path, params, { maxItems = MAX_LIST_ITEMS } = {}) => {
    const items = [];
    let data = await get(path, params);
    for (;;) {
      items.push(...(Array.isArray(data?.results) ? data.results : []));
      const next = data?._links?.next;
      if (!next) return { items, complete: true };
      if (items.length >= maxItems) return { items: items.slice(0, maxItems), complete: false };
      data = await get(next);
    }
  };

  return {
    siteUrl: base,
    get,
    list,

    /** Spaces this account can read. */
    async listSpaces({ maxItems = 1000 } = {}) {
      const { items, complete } = await list('/wiki/api/v2/spaces', { limit: PAGE_LIMIT, status: 'current' }, { maxItems });
      return {
        complete,
        spaces: items.map((s) => ({ id: String(s.id), key: s.key || '', name: s.name || s.key || `Space ${s.id}`, type: s.type || null, homepageId: s.homepageId ? String(s.homepageId) : null })),
      };
    },

    /**
     * Every current page of a space with its parent, title, version and
     * update date; withBody adds the storage body (smaller pages per call).
     */
    async listSpacePages(spaceId, { withBody = false, maxItems = MAX_LIST_ITEMS } = {}) {
      const params = { limit: withBody ? BODY_PAGE_LIMIT : PAGE_LIMIT, status: 'current', depth: 'all', ...(withBody ? { 'body-format': 'storage' } : {}) };
      const { items, complete } = await list(`/wiki/api/v2/spaces/${encodeURIComponent(spaceId)}/pages`, params, { maxItems });
      return { complete, pages: items.map(pageSummary).filter((p) => p.id) };
    },

    /** One page with its storage body. */
    async getPage(pageId) {
      const p = await get(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`, { 'body-format': 'storage' });
      return pageSummary(p);
    },

    /** True when the page itself limits who may view it (v1; inherited limits come from the tree). */
    async hasViewRestriction(pageId) {
      const data = await get(`/wiki/rest/api/content/${encodeURIComponent(pageId)}/restriction/byOperation/read`);
      const r = data?.restrictions || {};
      const n = (x) => (Array.isArray(x?.results) ? x.results.length : Number(x?.size) || 0);
      return n(r.user) + n(r.group) > 0;
    },

    /** Pages in these spaces changed since a date (v1 CQL). [{ id, title, version, spaceKey }] */
    async searchUpdatedSince(spaceKeys, since, { maxItems = MAX_LIST_ITEMS } = {}) {
      const keys = (spaceKeys || []).map((k) => String(k).replace(/[^A-Za-z0-9_~-]/g, '')).filter(Boolean);
      if (!keys.length) return { items: [], complete: true };
      const d = new Date(since);
      const pad = (n) => String(n).padStart(2, '0');
      const when = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      const cql = `type = page AND space in (${keys.map((k) => `"${k}"`).join(',')}) AND lastmodified >= "${when}"`;
      const { items, complete } = await list('/wiki/rest/api/content/search', { cql, limit: 100, expand: 'version,space' }, { maxItems });
      return { complete, items: items.map((c) => ({ id: String(c.id), title: c.title || '', version: Number(c.version?.number) || 1, spaceKey: c.space?.key || null })) };
    },

    /** Can we sign in and read at least the space list? */
    async testConnection() {
      const data = await get('/wiki/api/v2/spaces', { limit: 1 });
      return { ok: true, canListSpaces: Array.isArray(data?.results) };
    },
  };
}

export default createConfluenceClient;
