import axios from 'axios';
import logger from '../utils/logger.js';

const BASE_URL = 'https://api.vacationtracker.io';
const DEFAULT_LIMIT = 300;
const V2_LIMIT = 100;

/** API v2 keys look like vt_live_… / vt_test_… and are sent as a Bearer token. */
export function isV2Key(key) {
  return /^vt_(live|test)_/i.test(String(key || '').trim());
}

class VacationTrackerClient {
  constructor(apiKey) {
    if (!apiKey) {
      throw new Error('Vacation Tracker API key is required');
    }

    // 4 Oct 2026: a v2 key saved in the main field took the v1 key's place.
    // v2 serves the same data, so the client follows the key it is given.
    this.v2 = isV2Key(apiKey);
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: this.v2
        ? { Authorization: `Bearer ${String(apiKey).trim()}`, 'Content-Type': 'application/json' }
        : { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      timeout: 30000,
    });

    this.client.interceptors.response.use(
      response => response,
      error => {
        const status = error.response?.status;
        const body = error.response?.data || {};
        const message = body.message || body.description || body.error?.description || error.message;
        logger.error('Vacation Tracker API error:', {
          url: error.config?.url,
          status,
          message,
        });
        throw new Error(`Vacation Tracker API error (${status}): ${message}`);
      },
    );
  }

  async testConnection() {
    if (this.v2) {
      const response = await this.client.get('/v2/users', { params: { limit: 1 } });
      return Array.isArray(response.data?.data);
    }
    const response = await this.client.get('/v1/departments');
    return response.data?.status === 'ok';
  }

  /** v2: every page of a list (same envelope as v1: { data, nextToken }). */
  async _v2All(path, params = {}) {
    const out = [];
    let nextToken = null;
    for (let page = 0; page < 200; page += 1) {
      const response = await this.client.get(path, { params: { ...params, limit: V2_LIMIT, ...(nextToken ? { nextToken } : {}) } });
      if (Array.isArray(response.data?.data)) out.push(...response.data.data);
      nextToken = response.data?.nextToken || null;
      if (!nextToken) break;
    }
    return out;
  }

  async fetchLeaveTypes() {
    if (this.v2) return this._v2All('/v2/leave-types');
    const response = await this.client.get('/v1/leave-types');
    return response.data?.data || [];
  }

  async fetchUsers() {
    if (this.v2) {
      const users = await this._v2All('/v2/users');
      return users.filter((u) => !u.status || String(u.status).toUpperCase() === 'ACTIVE');
    }
    const allUsers = [];
    let nextToken = null;

    do {
      const params = {
        status: 'ACTIVE',
        expand: 'location,department',
        limit: DEFAULT_LIMIT,
      };
      if (nextToken) params.nextToken = nextToken;

      const response = await this.client.get('/v1/users', { params });
      const data = response.data;
      if (data?.data) allUsers.push(...data.data);
      nextToken = data?.nextToken || null;
    } while (nextToken);

    return allUsers;
  }

  async fetchLeaves(startDate, endDate) {
    if (this.v2) {
      const leaves = await this._v2All('/v2/leaves', { startDate, endDate });
      return leaves.filter((l) => !l.status || String(l.status).toUpperCase() === 'APPROVED');
    }
    const allLeaves = [];
    let nextToken = null;

    do {
      const params = {
        startDate,
        endDate,
        status: 'APPROVED',
        expand: 'user,leaveType',
        limit: DEFAULT_LIMIT,
      };
      if (nextToken) params.nextToken = nextToken;

      const response = await this.client.get('/v1/leaves', { params });
      const data = response.data;
      if (data?.data) allLeaves.push(...data.data);
      nextToken = data?.nextToken || null;
    } while (nextToken);

    return allLeaves;
  }

  async fetchLocations() {
    if (this.v2) return this._v2All('/v2/locations');
    const response = await this.client.get('/v1/locations');
    return response.data?.data || [];
  }

  async fetchDepartments() {
    if (this.v2) return this._v2All('/v2/departments');
    const response = await this.client.get('/v1/departments');
    return response.data?.data || [];
  }
}

export default VacationTrackerClient;
