import axios from 'axios';
import { formatDateLocal } from '../utils/dateHelpers';
import { isDemoMode, maybeScrub } from '../utils/demoMode';

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

export function getAuthToken() {
  return _authToken;
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
    const isPublicSummitRequest = requestUrl.startsWith('/summit/public/');

    if (status === 401 && !isPublicSummitRequest && requestUrl !== '/auth/session' && requestUrl !== '/auth/logout' && requestUrl !== '/auth/sso' && !error.config?._speculative) {
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

// Demo mode: pass every response body through the scrubber when demo mode is
// on, so all components downstream see anonymized data without any per-call
// changes. No-op when demo mode is off.
const scrubResponseInterceptor = (response) => maybeScrub(response.data, isDemoMode());

api.interceptors.response.use(
  scrubResponseInterceptor,
  errorInterceptor,
);

apiLongTimeout.interceptors.response.use(
  scrubResponseInterceptor,
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

  /**
   * Fetch the list of tickets this tech has bounced (rejected back to the queue).
   * Accepts either a preset window ('7d' | '30d' | 'all') OR a custom date
   * range via { start, end } (YYYY-MM-DD strings). Custom range takes precedence.
   */
  getTechnicianBounced: async (id, { window = '7d', start, end } = {}) => {
    const params = {};
    if (start && end) {
      params.start = start;
      params.end = end;
    } else {
      params.window = window;
    }
    return await api.get(`/dashboard/technician/${id}/bounced`, { params });
  },

  /** Fetch a ticket's full ownership timeline (episodes + FS events). */
  getTicketHistory: async (idOrFsId) => {
    return await api.get(`/dashboard/ticket/${idOrFsId}/history`);
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

  /** Get the currently-running BackfillRun row for the workspace (or null). */
  getCurrentBackfill: async () => {
    return await api.get('/sync/backfill/current');
  },

  /** Get past backfill runs (most recent first). */
  getBackfillHistory: async (limit = 20) => {
    return await api.get('/sync/backfill/history', { params: { limit } });
  },

  /** Request cancellation of a running backfill. */
  cancelBackfill: async (id) => {
    return await api.post(`/sync/backfill/${id}/cancel`);
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
 * Shared mailbox calendar leave API
 */
export const calendarLeaveAPI = {
  getConfig: () => api.get('/calendar-leave/config'),
  updateConfig: (data) => api.put('/calendar-leave/config', data),
  seedDefaults: () => api.post('/calendar-leave/seed-defaults'),
  getRules: () => api.get('/calendar-leave/rules'),
  saveRule: (rule) => rule.id
    ? api.put(`/calendar-leave/rules/${rule.id}`, rule)
    : api.post('/calendar-leave/rules', rule),
  deleteRule: (id) => api.delete(`/calendar-leave/rules/${id}`),
  getAliases: () => api.get('/calendar-leave/aliases'),
  saveAlias: (alias) => api.post('/calendar-leave/aliases', alias),
  deleteAlias: (id) => api.delete(`/calendar-leave/aliases/${id}`),
  getReviewRows: (params = {}) => api.get('/calendar-leave/review', { params }),
  saveReviewDecision: (data) => api.post('/calendar-leave/review-decision', data),
  preview: (data) => apiLongTimeout.post('/calendar-leave/preview', data),
  sync: (data) => apiLongTimeout.post('/calendar-leave/sync', data),
};

/**
 * Assignment Pipeline API
 */
export const assignmentAPI = {
  getConfig: () => api.get('/assignment/config'),
  updateConfig: (data) => api.put('/assignment/config', data),
  getGroups: () => api.get('/assignment/groups'),

  getQueuedRuns: () => api.get('/assignment/queued'),
  pruneQueuedRuns: () => api.post('/assignment/queued/prune'),
  getQueueStatus: () => api.get('/assignment/queue-status'),
  runNow: (id) => api.post(`/assignment/runs/${id}/run-now`),
  // Returns the relative SSE path for streaming a queued run's promoted execution.
  // Pass to readSSEStream / LivePipelineView.streamPath. POST with stream=true.
  runNowStreamPath: (id) => `/assignment/runs/${id}/run-now?stream=true`,
  getQueue: (params) => api.get('/assignment/queue', { params }),
  getRuns: (params) => api.get('/assignment/runs', { params }),
  getRun: (id) => api.get(`/assignment/runs/${id}`),
  getLatestRunForTicket: (ticketId) => api.get(`/assignment/ticket/${ticketId}/latest-run`),
  decide: (id, data) => api.post(`/assignment/runs/${id}/decide`, data),
  reassignRun: (id, data) => api.post(`/assignment/runs/${id}/reassign`, data),
  deleteRun: (id) => api.delete(`/assignment/runs/${id}`),
  dismissRun: (id) => api.post(`/assignment/runs/${id}/dismiss`),
  bulkDeleteRuns: (data) => api.post('/assignment/runs/bulk-delete', data),
  syncRun: (id, force) => api.post(`/assignment/runs/${id}/sync${force ? '?force=true' : ''}`),
  syncPreview: (id) => api.post(`/assignment/runs/${id}/sync-preview`),
  getRunFreshness: (id) => api.get(`/assignment/runs/${id}/freshness`),
  rerunPipeline: (id) => api.post(`/assignment/runs/${id}/rerun`),
  triggerPipeline: (ticketId) => api.post(`/assignment/trigger/${ticketId}`),
  syncNow: (data = {}) => apiLongTimeout.post('/assignment/sync-now', data),
  getRecentTickets: (params) => api.get('/assignment/recent-tickets', { params }),

  emailTest: (mailbox) => api.post('/assignment/email/test', { mailbox }),
  emailStatus: () => api.get('/assignment/email/status'),
  emailPollNow: () => api.post('/assignment/email/poll-now'),

  getPrompts: () => api.get('/assignment/prompts'),
  getPrompt: (id) => api.get(`/assignment/prompts/${id}`),
  createPrompt: (data) => api.post('/assignment/prompts', data),
  publishPrompt: (id) => api.post(`/assignment/prompts/${id}/publish`),
  restorePrompt: (id) => api.post(`/assignment/prompts/${id}/restore`),
  deletePrompt: (id) => api.delete(`/assignment/prompts/${id}`),

  getTools: () => api.get('/assignment/tools'),

  getFreshServiceDomain: () => api.get('/assignment/freshservice-domain'),
  getCompetencyTechnicians: () => api.get('/assignment/competencies/technicians'),
  analyzeCompetency: (techId) => api.post(`/assignment/competencies/analyze/${techId}`),
  getCompetencyRuns: (params) => api.get('/assignment/competencies/runs', { params }),
  getCompetencyRun: (id) => api.get(`/assignment/competencies/runs/${id}`),
  rollbackCompetencyRun: (id) => api.post(`/assignment/competencies/runs/${id}/rollback`),
  cancelCompetencyRun: (id) => api.post(`/assignment/competencies/runs/${id}/cancel`),
  getCompetencyPrompts: () => api.get('/assignment/competency-prompts'),
  getCompetencyPrompt: (id) => api.get(`/assignment/competency-prompts/${id}`),
  createCompetencyPrompt: (data) => api.post('/assignment/competency-prompts', data),
  publishCompetencyPrompt: (id) => api.post(`/assignment/competency-prompts/${id}/publish`),
  restoreCompetencyPrompt: (id) => api.post(`/assignment/competency-prompts/${id}/restore`),
  getCompetencyTools: () => api.get('/assignment/competency-tools'),
  getCompetencyRequests: (params = {}) => api.get('/assignment/competency-requests', { params }),
  decideCompetencyRequest: (id, data) => api.post(`/assignment/competency-requests/${id}/decision`, data),
  detectDuplicateCategories: () => api.get('/assignment/competencies/duplicates'),
  mergeCategories: (data) => api.post('/assignment/competencies/merge', data),
  getCompetencies: () => api.get('/assignment/competencies'),
  createCategory: (data) => api.post('/assignment/competencies/categories', data),
  updateCategory: (id, data) => api.put(`/assignment/competencies/categories/${id}`, data),
  deleteCategory: (id) => api.delete(`/assignment/competencies/categories/${id}`),
  getTechCompetencies: (techId) => api.get(`/assignment/competencies/technician/${techId}`),
  updateTechCompetencies: (techId, competencies) =>
    api.put(`/assignment/competencies/technician/${techId}`, { competencies }),

  getDailyReviewRuns: (params) => api.get('/assignment/daily-review/runs', { params }),
  getDailyReviewRun: (id) => api.get(`/assignment/daily-review/runs/${id}`),
  getDailyReviewRecommendations: (params) => api.get('/assignment/daily-review/recommendations', { params }),
  updateDailyReviewRecommendationStatus: (id, data) => api.post(`/assignment/daily-review/recommendations/${id}/status`, data),
  bulkUpdateDailyReviewRecommendationStatus: (data) => api.post('/assignment/daily-review/recommendations/bulk-status', data),
  cancelDailyReviewRun: (id) => api.post(`/assignment/daily-review/runs/${id}/cancel`),
  deleteDailyReviewRun: (id) => api.delete(`/assignment/daily-review/runs/${id}`),
  rerunDailyReviewRun: (id) => api.post(`/assignment/daily-review/runs/${id}/rerun`),
  generateDailyReviewBriefing: (id, data = {}) => apiLongTimeout.post(`/assignment/daily-review/runs/${id}/meeting-briefing`, data),
  runDailyReview: (data) => api.post('/assignment/daily-review', data),
  getDailyReviewRunProgress: (id) => api.get(`/assignment/daily-review/runs/${id}/progress`),
  startDailyReviewConsolidation: () => api.post('/assignment/daily-review/consolidations'),
  getDailyReviewConsolidationActive: () => api.get('/assignment/daily-review/consolidations/active'),
  getDailyReviewConsolidationRun: (id) => api.get(`/assignment/daily-review/consolidations/runs/${id}`),
  getDailyReviewConsolidationRuns: (params) => api.get('/assignment/daily-review/consolidations/runs', { params }),
  cancelDailyReviewConsolidation: (id) => api.post(`/assignment/daily-review/consolidations/runs/${id}/cancel`),
  deleteDailyReviewConsolidation: (id) => api.delete(`/assignment/daily-review/consolidations/runs/${id}`),
  updateDailyReviewConsolidationItem: (id, data) => api.put(`/assignment/daily-review/consolidations/items/${id}`, data),
  applyDailyReviewConsolidation: (id, data) => api.post(`/assignment/daily-review/consolidations/runs/${id}/apply`, data),
};

/**
 * Agent self-service API
 */
export const agentAPI = {
  getMyCompetencies: (params = {}) => api.get('/agent/competencies', { params }),
  submitCompetencyChange: (data) => api.post('/agent/competencies/changes', data),
  cancelCompetencyChange: (id) => api.delete(`/agent/competencies/changes/${id}`),
};

/**
 * Analytics API
 */
export const analyticsAPI = {
  getOverview: (params = {}) => api.get('/analytics/overview', { params }),
  getDemandFlow: (params = {}) => api.get('/analytics/demand-flow', { params }),
  getTeamBalance: (params = {}) => api.get('/analytics/team-balance', { params }),
  getQuality: (params = {}) => api.get('/analytics/quality', { params }),
  getAutomationOps: (params = {}) => api.get('/analytics/automation-ops', { params }),
  getInsights: (params = {}) => api.get('/analytics/insights', { params }),
};

/**
 * IT Summit category workshop API
 */
export const summitAPI = {
  getWorkshop: () => api.get('/summit/workshop'),
  saveState: (state, { label = 'Manual save', snapshotType = 'manual' } = {}) =>
    api.put('/summit/workshop/state', { state, label, snapshotType }),
  restoreSnapshot: (id) => api.post(`/summit/workshop/snapshots/${id}/restore`),
  enableVoting: (durationMinutes = 120, regenerate = false) => api.post('/summit/workshop/voting', { durationMinutes, regenerate }),
  extendVoting: (extensionMinutes = 30) => api.post('/summit/workshop/voting/extend', { extensionMinutes }),
  resetParticipantVotes: (id) => api.post(`/summit/workshop/participants/${id}/reset`),
  getPublicWorkshop: (token) => api.get(`/summit/public/${token}`),
  joinPublicWorkshop: (token, data) => api.post(`/summit/public/${token}/join`, data),
  submitVote: (token, data) => api.post(`/summit/public/${token}/votes`, data),
  getPublicEventSource: (token) => new EventSource(`${API_BASE_URL}/summit/public/${token}/events`, { withCredentials: true }),
};

/**
 * Health check
 */
export const healthCheck = async () => {
  return await api.get('/health');
};

export default api;
