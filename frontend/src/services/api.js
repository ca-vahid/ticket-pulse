import axios from 'axios';
import { formatDateLocal } from '../utils/dateHelpers';

const API_BASE_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000') + '/api';

// JWT token stored in memory (never localStorage — cleared on tab close).
let _authToken = null;
let _workspaceId = null;

export function setAuthToken(token) {
  _authToken = token;
}

export function clearAuthToken() {
  _authToken = null;
}

export function setWorkspaceId(id) {
  _workspaceId = id;
}

export function getWorkspaceId() {
  return _workspaceId;
}

// Create axios instance
const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

// Create a separate instance for long-running operations like sync
const apiLongTimeout = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 900000,
});

// Attach JWT + workspace headers to every request
const authRequestInterceptor = (reqConfig) => {
  if (_authToken && !reqConfig.headers.Authorization) {
    reqConfig.headers.Authorization = `Bearer ${_authToken}`;
  }
  if (_workspaceId && !reqConfig.headers['X-Workspace-Id']) {
    reqConfig.headers['X-Workspace-Id'] = String(_workspaceId);
  }
  return reqConfig;
};
api.interceptors.request.use(authRequestInterceptor);
apiLongTimeout.interceptors.request.use(authRequestInterceptor);

// Response interceptor for error handling
const errorInterceptor = (error) => {
  if (error.response) {
    const status = error.response.status;
    const requestUrl = error.config?.url || '';

    if (status === 401 && requestUrl !== '/auth/session' && requestUrl !== '/auth/logout' && requestUrl !== '/auth/sso' && !error.config?._speculative) {
      window.dispatchEvent(new CustomEvent('auth:unauthorized', {
        detail: { url: requestUrl },
      }));
    }

    // Server responded with error status
    const errorMessage = error.response.data?.message || error.message;
    const enhancedError = new Error(errorMessage);
    enhancedError.status = status;
    throw enhancedError;
  } else if (error.request) {
    // Request made but no response
    throw new Error('Network error. Please check your connection.');
  } else {
    // Something else happened
    throw new Error(error.message);
  }
};

api.interceptors.response.use(
  response => response.data,
  errorInterceptor,
);

apiLongTimeout.interceptors.response.use(
  response => response.data,
  errorInterceptor,
);

/**
 * Authentication API
 */
export const authAPI = {
  ssoLogin: async (idToken) => {
    return await api.post('/auth/sso', { idToken });
  },

  logout: async () => {
    return await api.post('/auth/logout');
  },

  checkSession: async () => {
    return await api.get('/auth/session');
  },
};

/**
 * Dashboard API
 */
// Global noise filter state - read by all dashboard API calls
let _excludeNoise = localStorage.getItem('tp_excludeNoise') === 'true';

export function setGlobalExcludeNoise(value) {
  _excludeNoise = value;
  localStorage.setItem('tp_excludeNoise', value ? 'true' : 'false');
}

export function getGlobalExcludeNoise() {
  return _excludeNoise;
}

function applyNoiseParam(params) {
  if (_excludeNoise) params.excludeNoise = 'true';
  return params;
}

export const dashboardAPI = {
  getDashboard: async (timezone = 'America/Los_Angeles', date = null) => {
    const params = { timezone };
    if (date) {
      const dateStr = typeof date === 'string' ? date : formatDateLocal(date);
      params.date = dateStr;
    }
    return await api.get('/dashboard', { params: applyNoiseParam(params) });
  },

  getTechnician: async (id, timezone = 'America/Los_Angeles', date = null) => {
    const params = { timezone };
    if (date) {
      const dateStr = typeof date === 'string' ? date : formatDateLocal(date);
      params.date = dateStr;
    }
    return await api.get(`/dashboard/technician/${id}`, { params: applyNoiseParam(params) });
  },

  getWeeklyStats: async (timezone = 'America/Los_Angeles', date = null) => {
    const params = { timezone };
    if (date) {
      const dateStr = typeof date === 'string' ? date : formatDateLocal(date);
      params.date = dateStr;
    }
    return await api.get('/dashboard/weekly-stats', { params: applyNoiseParam(params) });
  },

  getWeeklyDashboard: async (weekStart = null, timezone = 'America/Los_Angeles') => {
    const params = { timezone };
    if (weekStart) {
      const dateStr = typeof weekStart === 'string' ? weekStart : formatDateLocal(weekStart);
      params.weekStart = dateStr;
    }
    return await api.get('/dashboard/weekly', { params: applyNoiseParam(params) });
  },

  getTechnicianWeekly: async (id, weekStart = null, timezone = 'America/Los_Angeles') => {
    const params = { timezone };
    if (weekStart) {
      const dateStr = typeof weekStart === 'string' ? weekStart : formatDateLocal(weekStart);
      params.weekStart = dateStr;
    }
    return await api.get(`/dashboard/technician/${id}/weekly`, { params: applyNoiseParam(params) });
  },

  getTechnicianMonthly: async (id, month = null, timezone = 'America/Los_Angeles') => {
    const params = { timezone };
    if (month) params.month = month; // "YYYY-MM"
    return await api.get(`/dashboard/technician/${id}/monthly`, { params: applyNoiseParam(params) });
  },

  /**
   * Fetch full timeline/coverage data for one or more technicians.
   * Used by Timeline Explorer. Specify exactly one of date/weekStart/month.
   *
   * @param {number[]} techIds  - array of technician IDs
   * @param {object}   period   - { type: 'daily'|'weekly'|'monthly', date?, weekStart?, month? }
   * @param {string}   timezone
   */
  getTimeline: async (techIds, period = {}, timezone = 'America/Los_Angeles') => {
    const params = { techIds: techIds.join(','), timezone };
    if (period.date)      params.date      = period.date;
    if (period.weekStart) params.weekStart  = period.weekStart;
    if (period.month)     params.month      = period.month;
    return await api.get('/dashboard/timeline', { params: applyNoiseParam(params) });
  },

  getTechnicianCSAT: async (id) => {
    return await api.get(`/dashboard/technician/${id}/csat`);
  },

  getMonthlyDashboard: async (monthStart = null, timezone = 'America/Los_Angeles') => {
    const params = { timezone };
    if (monthStart) {
      // monthStart should be first day of the month (YYYY-MM-DD)
      const dateStr = typeof monthStart === 'string' ? monthStart : formatDateLocal(monthStart);
      params.monthStart = dateStr;
    }
    return await api.get('/dashboard/monthly', { params: applyNoiseParam(params) });
  },
};

/**
 * Settings API
 */
export const settingsAPI = {
  getAll: async () => {
    return await api.get('/settings');
  },

  update: async (settings) => {
    return await api.put('/settings', { settings });
  },

  updateSingle: async (key, value) => {
    return await api.put(`/settings/${key}`, { value });
  },

  testConnection: async () => {
    return await api.post('/settings/test-connection');
  },

  initialize: async () => {
    return await api.post('/settings/initialize');
  },

  getAdmins: async () => {
    return await api.get('/settings/admins');
  },

  updateAdmins: async (emails) => {
    return await api.put('/settings/admins', { emails });
  },

  getTechnicians: () => api.get('/settings/technicians'),
  setTechnicianActive: (id, isActive) => api.put(`/settings/technicians/${id}/active`, { isActive }),
};

/**
 * Sync API
 */
export const syncAPI = {
  trigger: async () => {
    return await apiLongTimeout.post('/sync/trigger');
  },

  syncWeek: async ({ startDate, endDate }) => {
    return await apiLongTimeout.post('/sync/week', { startDate, endDate });
  },

  getStatus: async () => {
    return await api.get('/sync/status');
  },

  getLogs: async ({ limit = 50, offset = 0, status = null, startDate = null, endDate = null, search = null } = {}) => {
    const params = { limit, offset };
    if (status) params.status = status;
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;
    if (search) params.search = search;
    return await api.get('/sync/logs', { params });
  },

  getStats: async () => {
    return await api.get('/sync/stats');
  },

  startSchedule: async () => {
    return await api.post('/sync/start-schedule');
  },

  stopSchedule: async () => {
    return await api.post('/sync/stop-schedule');
  },

  resetSync: async () => {
    return await api.post('/sync/reset');
  },

  /**
   * Start a historical backfill with SSE progress.
   * Returns an EventSource that emits backfill-progress, backfill-complete, backfill-error events.
   */
  startBackfill: ({ startDate, endDate, skipExisting = true, activityConcurrency = 3 }) => {
    const url = `${API_BASE_URL}/sync/backfill`;
    const body = JSON.stringify({ startDate, endDate, skipExisting, activityConcurrency });

    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(_authToken ? { Authorization: `Bearer ${_authToken}` } : {}),
        ...(_workspaceId ? { 'X-Workspace-Id': String(_workspaceId) } : {}),
      },
      credentials: 'include',
      body,
    });
  },

  getBackfillStatus: async () => {
    return await api.get('/sync/backfill/status');
  },
};

/**
 * SSE API
 */
export const sseAPI = {
  getEventSource: () => {
    const params = new URLSearchParams();
    if (_authToken) params.set('token', _authToken);
    if (_workspaceId) params.set('workspaceId', String(_workspaceId));
    const qs = params.toString();
    const url = qs ? `${API_BASE_URL}/sse/events?${qs}` : `${API_BASE_URL}/sse/events`;
    return new EventSource(url, { withCredentials: true });
  },

  getStatus: async () => {
    return await api.get('/sse/status');
  },
};

/**
 * Visuals API
 */
export const visualsAPI = {
  getAgents: async ({ includeInactive = false } = {}) => {
    const params = includeInactive ? { includeInactive: 'true' } : {};
    return await api.get('/visuals/agents', { params });
  },

  updateAgentLocation: async (agentId, location) => {
    return await api.patch(`/visuals/agents/${agentId}/location`, { location });
  },

  batchUpdateVisibility: async (selectedIds, managerId) => {
    return await api.post('/visuals/agents/batch-visibility', { selectedIds, managerId });
  },

  updateAgentSchedule: async (agentId, { workStartTime, workEndTime, timezone } = {}) => {
    const body = { workStartTime, workEndTime };
    if (timezone) body.timezone = timezone;
    return await api.patch(`/visuals/agents/${agentId}/schedule`, body);
  },
};

/**
 * Noise Rules API
 */
export const noiseRulesAPI = {
  getAll: async () => {
    return await api.get('/noise-rules');
  },

  getStats: async () => {
    return await api.get('/noise-rules/stats');
  },

  create: async (rule) => {
    return await api.post('/noise-rules', rule);
  },

  update: async (id, data) => {
    return await api.put(`/noise-rules/${id}`, data);
  },

  delete: async (id) => {
    return await api.delete(`/noise-rules/${id}`);
  },

  test: async (pattern) => {
    return await api.post('/noise-rules/test', { pattern });
  },

  backfill: async () => {
    return await apiLongTimeout.post('/noise-rules/backfill');
  },

  seed: async () => {
    return await api.post('/noise-rules/seed');
  },
};

/**
 * Workspace API
 */
export const workspaceAPI = {
  getAll: async () => {
    return await api.get('/workspaces');
  },

  getById: async (id) => {
    return await api.get(`/workspaces/${id}`);
  },

  select: async (workspaceId) => {
    return await api.post('/workspaces/select', { workspaceId });
  },

  create: async (data) => {
    return await api.post('/workspaces', data);
  },

  update: async (id, data) => {
    return await api.put(`/workspaces/${id}`, data);
  },

  discover: async () => {
    return await api.get('/workspaces/discover');
  },

  activate: async (data) => {
    return await api.post('/workspaces/activate', data);
  },

  getAccess: async (workspaceId) => {
    return await api.get(`/workspaces/${workspaceId}/access`);
  },

  grantAccess: async (workspaceId, email, role = 'viewer') => {
    return await api.post(`/workspaces/${workspaceId}/access`, { email, role });
  },

  revokeAccess: async (workspaceId, email) => {
    return await api.delete(`/workspaces/${workspaceId}/access/${encodeURIComponent(email)}`);
  },

  searchUsers: async (query) => {
    return await api.get('/workspaces/users/search', { params: { q: query } });
  },
};

/**
 * Vacation Tracker API
 */
export const vacationTrackerAPI = {
  getConfig: () => api.get('/vacation-tracker/config'),
  updateConfig: (data) => api.put('/vacation-tracker/config', data),
  testConnection: (apiKey) => api.post('/vacation-tracker/config/test', { apiKey }),

  getLeaveTypes: () => api.get('/vacation-tracker/leave-types'),
  syncLeaveTypes: () => api.post('/vacation-tracker/leave-types/sync'),
  updateLeaveTypeMappings: (mappings) => api.put('/vacation-tracker/leave-types', { mappings }),

  getUsers: () => api.get('/vacation-tracker/users'),
  syncUsers: () => api.post('/vacation-tracker/users/sync'),
  matchUser: (id, technicianId) => api.put(`/vacation-tracker/users/${id}/match`, { technicianId }),

  triggerSync: () => api.post('/vacation-tracker/sync'),
  getSyncStatus: () => api.get('/vacation-tracker/sync/status'),
};

/**
 * Health check
 */
export const healthCheck = async () => {
  return await api.get('/health');
};

export default api;
