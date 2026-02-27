import axios from 'axios';
import { formatDateLocal } from '../utils/dateHelpers';

const API_BASE_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000') + '/api';

// Create axios instance
const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true, // Important for session cookies
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000, // 30 second timeout (default)
});

// Create a separate instance for long-running operations like sync
const apiLongTimeout = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 900000, // 15 minute timeout for sync operations (large historical syncs can take 8-10 minutes)
});

// Response interceptor for error handling
const errorInterceptor = (error) => {
  console.error('API Error:', error);

  if (error.response) {
    const status = error.response.status;
    const requestUrl = error.config?.url || '';

    if (status === 401 && requestUrl !== '/auth/session' && requestUrl !== '/auth/logout') {
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
export const dashboardAPI = {
  getDashboard: async (timezone = 'America/Los_Angeles', date = null) => {
    const params = { timezone };
    if (date) {
      // Format date as YYYY-MM-DD if it's a Date object
      const dateStr = typeof date === 'string' ? date : formatDateLocal(date);
      params.date = dateStr;
    }
    return await api.get('/dashboard', { params });
  },

  getTechnician: async (id, timezone = 'America/Los_Angeles', date = null) => {
    const params = { timezone };
    if (date) {
      const dateStr = typeof date === 'string' ? date : formatDateLocal(date);
      params.date = dateStr;
    }
    return await api.get(`/dashboard/technician/${id}`, { params });
  },

  getWeeklyStats: async (timezone = 'America/Los_Angeles', date = null) => {
    const params = { timezone };
    if (date) {
      const dateStr = typeof date === 'string' ? date : formatDateLocal(date);
      params.date = dateStr;
    }
    return await api.get('/dashboard/weekly-stats', { params });
  },

  getWeeklyDashboard: async (weekStart = null, timezone = 'America/Los_Angeles') => {
    const params = { timezone };
    if (weekStart) {
      // weekStart should be Monday of the week (YYYY-MM-DD)
      const dateStr = typeof weekStart === 'string' ? weekStart : formatDateLocal(weekStart);
      params.weekStart = dateStr;
    }
    return await api.get('/dashboard/weekly', { params });
  },

  getTechnicianWeekly: async (id, weekStart = null, timezone = 'America/Los_Angeles') => {
    const params = { timezone };
    if (weekStart) {
      // weekStart should be Monday of the week (YYYY-MM-DD)
      const dateStr = typeof weekStart === 'string' ? weekStart : formatDateLocal(weekStart);
      params.weekStart = dateStr;
    }
    return await api.get(`/dashboard/technician/${id}/weekly`, { params });
  },

  getTechnicianMonthly: async (id, month = null, timezone = 'America/Los_Angeles') => {
    const params = { timezone };
    if (month) params.month = month; // "YYYY-MM"
    return await api.get(`/dashboard/technician/${id}/monthly`, { params });
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
    return await api.get('/dashboard/timeline', { params });
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
    return await api.get('/dashboard/monthly', { params });
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

  getLogs: async (limit = 20) => {
    return await api.get('/sync/logs', { params: { limit } });
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
};

/**
 * SSE API
 */
export const sseAPI = {
  getEventSource: () => {
    return new EventSource(`${API_BASE_URL}/sse/events`, {
      withCredentials: true,
    });
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
 * Health check
 */
export const healthCheck = async () => {
  return await api.get('/health');
};

export default api;
