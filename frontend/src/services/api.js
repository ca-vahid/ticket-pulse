import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

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
  timeout: 300000, // 5 minute timeout for sync operations (FreshService rate limiting can be slow)
});

// Response interceptor for error handling
const errorInterceptor = (error) => {
  console.error('API Error:', error);

  if (error.response) {
    // Server responded with error status
    const errorMessage = error.response.data?.message || error.message;
    throw new Error(errorMessage);
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
  errorInterceptor
);

apiLongTimeout.interceptors.response.use(
  response => response.data,
  errorInterceptor
);

/**
 * Authentication API
 */
export const authAPI = {
  login: async (username, password) => {
    return await api.post('/auth/login', { username, password });
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
      const dateStr = typeof date === 'string' ? date : date.toISOString().split('T')[0];
      params.date = dateStr;
    }
    return await api.get('/dashboard', { params });
  },

  getTechnician: async (id, timezone = 'America/Los_Angeles', date = null) => {
    const params = { timezone };
    if (date) {
      const dateStr = typeof date === 'string' ? date : date.toISOString().split('T')[0];
      params.date = dateStr;
    }
    return await api.get(`/dashboard/technician/${id}`, { params });
  },

  getWeeklyStats: async (timezone = 'America/Los_Angeles', date = null) => {
    const params = { timezone };
    if (date) {
      const dateStr = typeof date === 'string' ? date : date.toISOString().split('T')[0];
      params.date = dateStr;
    }
    return await api.get('/dashboard/weekly-stats', { params });
  },

  getWeeklyDashboard: async (weekStart = null, timezone = 'America/Los_Angeles') => {
    const params = { timezone };
    if (weekStart) {
      // weekStart should be Monday of the week (YYYY-MM-DD)
      const dateStr = typeof weekStart === 'string' ? weekStart : weekStart.toISOString().split('T')[0];
      params.weekStart = dateStr;
    }
    return await api.get('/dashboard/weekly', { params });
  },

  getTechnicianWeekly: async (id, weekStart = null, timezone = 'America/Los_Angeles') => {
    const params = { timezone };
    if (weekStart) {
      // weekStart should be Monday of the week (YYYY-MM-DD)
      const dateStr = typeof weekStart === 'string' ? weekStart : weekStart.toISOString().split('T')[0];
      params.weekStart = dateStr;
    }
    return await api.get(`/dashboard/technician/${id}/weekly`, { params });
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
 * Health check
 */
export const healthCheck = async () => {
  return await api.get('/health');
};

export default api;
