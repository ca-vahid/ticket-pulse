import axios from 'axios';
import logger from '../utils/logger.js';

/**
 * Vacation Tracker REST API v2 (read + write; scoped keys "vt_live_…", sent as
 * a Bearer token). Used for Availability's two-way sync (Oct 2026); the v1
 * client (vacationTracker.js, x-api-key) keeps the hourly read-only sync.
 * Docs: https://vacationtracker.io/developers/api-v2
 */
const BASE_URL = 'https://api.vacationtracker.io/v2';

export function looksLikeV2Key(key) {
  return /^vt_(live|test)_/i.test(String(key || '').trim());
}

/** VT v2 errors share one envelope: { code, name, description, resolution, requestId }. */
export function describeV2Error(err) {
  const status = err?.response?.status;
  const body = err?.response?.data || {};
  const e = body.error || body;
  const parts = [e.description || e.name || e.code || err?.message || 'Request failed', e.resolution].filter(Boolean);
  return `${status ? `${status} ` : ''}${parts.join(' — ')}`.trim();
}

class VacationTrackerV2Client {
  constructor(apiKey, { baseURL = BASE_URL } = {}) {
    this.client = axios.create({
      baseURL,
      timeout: 30000,
      headers: { Authorization: `Bearer ${String(apiKey || '').trim()}`, 'Content-Type': 'application/json' },
    });
  }

  /** A cheap authenticated read: one user. */
  async testConnection() {
    const res = await this.client.get('/users', { params: { limit: 1 } });
    return Array.isArray(res.data?.data) || Boolean(res.data);
  }

  async listUsers() {
    return this._all('/users');
  }

  async listLeaveTypes() {
    return this._all('/leave-types');
  }

  async listLeaves(params = {}) {
    return this._all('/leaves', params);
  }

  async _all(path, params = {}) {
    const out = [];
    let nextToken;
    for (let page = 0; page < 50; page += 1) {
      const res = await this.client.get(path, { params: { ...params, limit: 100, ...(nextToken ? { nextToken } : {}) } });
      const data = res.data?.data;
      if (Array.isArray(data)) out.push(...data);
      nextToken = res.data?.nextToken;
      if (!nextToken) break;
    }
    if (out.length === 0) logger.debug(`VT v2 ${path}: no rows`);
    return out;
  }
}

export default VacationTrackerV2Client;
