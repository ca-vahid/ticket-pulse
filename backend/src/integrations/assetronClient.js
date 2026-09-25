/**
 * Assetron external API client (Sam Khadem's guide, 24 Sep 2026 — Part B).
 *
 * Auth: Microsoft Entra app-to-app. Ticket Pulse's system-assigned managed
 * identity (ticket-pulse-app, object id 47faa7a4-3ba4-4b98-a13f-6e68354bb4ad)
 * gets a token for `ASSETRON_API_SCOPE` (api://<Assetron API client id>/.default).
 * No secret exists. Tokens are cached until ~5 minutes before expiry.
 *
 * Config (App Service settings):
 *   ASSETRON_API_BASE_URL  e.g. https://assetron-api-…azurewebsites.net/api/v1
 *   ASSETRON_API_SCOPE     api://<client id>/.default   (sent by Assetron with the role grant)
 * Both unset → isConfigured() false and every caller degrades gracefully.
 *
 * Errors: Assetron's envelope { error: { code, message, details[] } } becomes
 * AssetronError { status, code, reason (details[0].message), field, message }.
 * `message` is a sentence Assetron says is safe to show an agent.
 */
import logger from '../utils/logger.js';

const TIMEOUT_MS = 10_000;
const TOKEN_SKEW_MS = 5 * 60 * 1000;
let tokenCache = null; // { token, expiresAt }
let credential = null;
let fetchImpl = (...a) => fetch(...a);

export class AssetronError extends Error {
  constructor({ status = null, code = 'ASSETRON_ERROR', reason = null, field = null, message }) {
    super(message || 'Assetron did not answer');
    this.name = 'AssetronError';
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.field = field;
  }

  /** Network, timeout, 429 or 5xx — worth retrying later. 401/403 need a config fix. */
  get retryable() {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

export function assetronConfig() {
  const baseUrl = String(process.env.ASSETRON_API_BASE_URL || '').trim().replace(/\/+$/, '');
  const scope = String(process.env.ASSETRON_API_SCOPE || '').trim();
  return { baseUrl, scope };
}

export function isConfigured() {
  const { baseUrl, scope } = assetronConfig();
  return Boolean(baseUrl && scope);
}

async function getToken() {
  const { scope } = assetronConfig();
  if (tokenCache && tokenCache.expiresAt - TOKEN_SKEW_MS > Date.now()) return tokenCache.token;
  if (!credential) {
    const identity = await import('@azure/identity');
    // In App Service the managed identity endpoint exists; locally fall back to
    // the developer's Azure CLI login (which Assetron will refuse without the role).
    credential = process.env.IDENTITY_ENDPOINT
      ? new identity.ManagedIdentityCredential()
      : new identity.DefaultAzureCredential();
  }
  const t = await credential.getToken(scope);
  if (!t?.token) throw new AssetronError({ status: 401, code: 'UNAUTHORIZED', message: 'Could not get a token for Assetron' });
  tokenCache = { token: t.token, expiresAt: t.expiresOnTimestamp || Date.now() + 50 * 60 * 1000 };
  return t.token;
}

async function request(method, path, { query = null, body = null, retries = 0 } = {}) {
  if (!isConfigured()) throw new AssetronError({ status: 503, code: 'NOT_CONFIGURED', message: 'Assetron is not connected to Ticket Pulse yet' });
  const { baseUrl } = assetronConfig();
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1) + Math.random() * 200));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const token = await getToken();
      const res = await fetchImpl(`${baseUrl}${path}${qs}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      let json = null;
      try { json = await res.json(); } catch { json = null; }
      if (res.ok) return { status: res.status, json: json || {} };
      if (res.status === 401) tokenCache = null;
      const e = json?.error || {};
      const d = Array.isArray(e.details) && e.details[0] ? e.details[0] : {};
      lastErr = new AssetronError({ status: res.status, code: e.code || `HTTP_${res.status}`, reason: d.message || null, field: d.field || null, message: e.message || `Assetron answered ${res.status}` });
      if (!lastErr.retryable) throw lastErr;
    } catch (err) {
      if (err instanceof AssetronError && !err.retryable) throw err;
      lastErr = err instanceof AssetronError ? err : new AssetronError({ status: null, code: err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', message: err.name === 'AbortError' ? 'Assetron did not answer in time' : `Could not reach Assetron (${err.message})` });
    } finally {
      clearTimeout(timer);
    }
  }
  logger.warn(`Assetron ${method} ${path} failed: ${lastErr.code} ${lastErr.status ?? ''} ${lastErr.message}`);
  throw lastErr;
}

// Filter keys Assetron documents; unknown keys from filter-options pass through too.
const RESERVED_QUERY = new Set(['page', 'pageSize', 'sort']);

const assetronClient = {
  isConfigured,

  async filterOptions() {
    const { json } = await request('GET', '/assets/filter-options', { retries: 2 });
    return json.data || {};
  },

  /**
   * filters: { key: [values] } — comma = OR within a key. `status` is forced to
   * NEW (new laptops only, Vahid 24 Sep 2026; spares come later).
   */
  async searchAssets(filters = {}, { page = 1, pageSize = 50, sort = null } = {}) {
    const query = {};
    for (const [k, v] of Object.entries(filters || {})) {
      if (RESERVED_QUERY.has(k) || k === 'status') continue;
      const values = (Array.isArray(v) ? v : [v]).map((x) => String(x)).filter((x) => x !== '');
      if (values.length) query[k] = values.join(',');
    }
    query.status = 'NEW';
    query.page = String(Math.max(1, Number(page) || 1));
    query.pageSize = String(Math.min(100, Math.max(1, Number(pageSize) || 50)));
    if (sort) query.sort = String(sort);
    const { json } = await request('GET', '/assets', { query, retries: 2 });
    return { items: Array.isArray(json.data) ? json.data : [], pagination: json.pagination || null };
  },

  async getAsset(id) {
    const { json } = await request('GET', `/assets/${encodeURIComponent(id)}`, { retries: 2 });
    return json.data || null;
  },

  /** Retry-safe on Assetron's side: the same ticket.ref + assetId returns the same PENDING reservation. */
  async createReservation(body) {
    const { status, json } = await request('POST', '/reservations', { body, retries: 2 });
    return { status, data: json.data || {} };
  },

  /** status: APPROVED | REJECTED | CANCELLED. Retry-safe (same status twice = 200). */
  async decideReservation(reservationId, body) {
    const { json } = await request('PATCH', `/reservations/${encodeURIComponent(reservationId)}`, { body, retries: 1 });
    return json.data || {};
  },

  _setFetch(fn) { fetchImpl = fn; },
  _setCredential(c) { credential = c; tokenCache = null; },
  _reset() { tokenCache = null; credential = null; fetchImpl = (...a) => fetch(...a); },
};

export default assetronClient;
