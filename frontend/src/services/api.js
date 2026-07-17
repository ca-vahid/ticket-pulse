import axios from 'axios';
import { formatDateLocal } from '../utils/dateHelpers';
import { isDemoMode, maybeScrub } from '../utils/demoMode';

const API_BASE_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000') + '/api';
const AUTH_TOKEN_STORAGE_KEY = 'tp_authToken';

function readSessionStorage(key) {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeSessionStorage(key, value) {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(key, value);
    }
  } catch { /* sessionStorage unavailable */ }
}

function removeSessionStorage(key) {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(key);
    }
  } catch { /* sessionStorage unavailable */ }
}

// JWT token is tab-scoped: memory for speed, sessionStorage for page refreshes.
// It is intentionally not stored in localStorage.
let _authToken = readSessionStorage(AUTH_TOKEN_STORAGE_KEY);
let _workspaceId = null;

export function setAuthToken(token) {
  _authToken = token || null;
  if (_authToken) {
    writeSessionStorage(AUTH_TOKEN_STORAGE_KEY, _authToken);
  } else {
    removeSessionStorage(AUTH_TOKEN_STORAGE_KEY);
  }
}

export function clearAuthToken() {
  _authToken = null;
  removeSessionStorage(AUTH_TOKEN_STORAGE_KEY);
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

const apiAnalytics = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 90000,
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
apiAnalytics.interceptors.request.use(authRequestInterceptor);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const analyticsRetryInterceptor = async (error) => {
  const config = error.config || {};
  const status = error.response?.status;
  const retryableNetworkError = !error.response || error.code === 'ECONNABORTED' || error.code === 'ERR_NETWORK';
  const retryableServerError = status === 502 || status === 503 || status === 504;
  // Only idempotent requests may retry — a timed-out POST (e.g. report
  // generation) that gets re-fired duplicates its side effects.
  const idempotent = ['get', 'head', 'options'].includes(String(config.method || 'get').toLowerCase());

  if (idempotent && (retryableNetworkError || retryableServerError) && (config._analyticsRetryCount || 0) < 3) {
    config._analyticsRetryCount = (config._analyticsRetryCount || 0) + 1;
    const backoffMs = [1500, 3500, 7000][config._analyticsRetryCount - 1] || 7000;
    await delay(backoffMs);
    return apiAnalytics(config);
  }

  return Promise.reject(error);
};

// Response interceptor for error handling
const errorInterceptor = (error) => {
  if (error.response) {
    const status = error.response.status;
    const requestUrl = error.config?.url || '';
    const isPublicSummitRequest = requestUrl.startsWith('/summit/public/');
    const isPublicTicketStatusRequest = requestUrl.startsWith('/ticket-status/public/');

    if (status === 401 && !isPublicSummitRequest && !isPublicTicketStatusRequest && requestUrl !== '/auth/session' && requestUrl !== '/auth/logout' && requestUrl !== '/auth/sso' && requestUrl !== '/auth/dev-login' && !error.config?._speculative) {
      window.dispatchEvent(new CustomEvent('auth:unauthorized', {
        detail: { url: requestUrl },
      }));
    }

    // Server responded with error status
    const errorMessage = error.response.data?.message || error.message;
    const enhancedError = new Error(errorMessage);
    enhancedError.status = status;
    // Validation errors carry a details array (e.g. workflow definition
    // issues) — keep it so UIs can show the specific problems.
    if (error.response.data?.details) enhancedError.details = error.response.data.details;
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

apiAnalytics.interceptors.response.use(
  scrubResponseInterceptor,
  analyticsRetryInterceptor,
);

apiAnalytics.interceptors.response.use(
  (response) => response,
  errorInterceptor,
);

/**
 * Authentication API
 */
export const authAPI = {
  ssoLogin: async (idToken) => {
    return await api.post('/auth/sso', { idToken });
  },

  devLogin: async (workspaceId = null) => {
    return await api.post('/auth/dev-login', workspaceId ? { workspaceId } : {});
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

  getTechnicianFeedback: async (id) => {
    return await api.get(`/dashboard/technician/${id}/feedback`);
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

  testNotificationProvider: async (data) => {
    return await api.post('/settings/notification-providers/test', data);
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
  searchDirectory: (q) => api.get('/settings/directory/search', { params: { q } }),
  createLocalAgent: (data) => api.post('/settings/technicians', data),
  updateTechnician: (id, data) => api.patch(`/settings/technicians/${id}`, data),
  getGroups: () => api.get('/settings/groups'),
  createInternalGroup: (data) => api.post('/settings/groups', data),
  updateGroup: (id, data) => api.patch(`/settings/groups/${id}`, data),
  getGroupMembers: (id) => api.get(`/settings/groups/${id}/members`),
  setGroupMembers: (id, technicianIds) => api.put(`/settings/groups/${id}/members`, { technicianIds }),
  // Ticket tags — workspace palette admin (gap plan P1)
  getTicketTags: () => api.get('/settings/ticket-tags'),
  createTicketTag: (data) => api.post('/settings/ticket-tags', data),
  updateTicketTag: (id, data) => api.patch(`/settings/ticket-tags/${id}`, data),
  mergeTicketTag: (id, targetTagId) => api.post(`/settings/ticket-tags/${id}/merge`, { targetTagId }),
  deleteTicketTag: (id) => api.delete(`/settings/ticket-tags/${id}`),
  // Quick notes — canned internal notes per top category (QA 07-06 #12)
  getQuickNotes: () => api.get('/settings/quick-notes'),
  createQuickNote: (data) => api.post('/settings/quick-notes', data),
  updateQuickNote: (id, data) => api.patch(`/settings/quick-notes/${id}`, data),
  deleteQuickNote: (id) => api.delete(`/settings/quick-notes/${id}`),
  // Approval categories (per-workspace; managers via GAL)
  getApprovalCategories: () => api.get('/settings/approval-categories'),
  createApprovalCategory: (data) => api.post('/settings/approval-categories', data),
  updateApprovalCategory: (id, data) => api.patch(`/settings/approval-categories/${id}`, data),
  deleteApprovalCategory: (id) => api.delete(`/settings/approval-categories/${id}`),
  // Ticket ops (enterprise): SLA policies, macros, custom field definitions
  getSlaPolicies: () => api.get('/settings/sla-policies'),
  upsertSlaPolicy: (data) => api.put('/settings/sla-policies', data),
  deleteSlaPolicy: (priority, ticketTypeId = null) => api.delete(`/settings/sla-policies/${priority}`, {
    params: ticketTypeId ? { ticketTypeId } : {},
  }),
  // Ticket-type registry (per-workspace type catalogue)
  getTicketTypes: () => api.get('/settings/ticket-types'),
  createTicketType: (data) => api.post('/settings/ticket-types', data),
  updateTicketType: (id, data) => api.patch(`/settings/ticket-types/${id}`, data),
  retireTicketType: (id) => api.delete(`/settings/ticket-types/${id}`),
  syncTicketTypes: () => api.post('/settings/ticket-types/sync'),
  getMacros: () => api.get('/settings/macros'),
  createMacro: (data) => api.post('/settings/macros', data),
  updateMacro: (id, data) => api.patch(`/settings/macros/${id}`, data),
  deleteMacro: (id) => api.delete(`/settings/macros/${id}`),
  getTicketTemplates: () => api.get('/settings/ticket-templates'),
  createTicketTemplate: (data) => api.post('/settings/ticket-templates', data),
  updateTicketTemplate: (id, data) => api.patch(`/settings/ticket-templates/${id}`, data),
  deleteTicketTemplate: (id) => api.delete(`/settings/ticket-templates/${id}`),
  getCustomFields: () => api.get('/settings/custom-fields'),
  createCustomField: (data) => api.post('/settings/custom-fields', data),
  updateCustomField: (id, data) => api.patch(`/settings/custom-fields/${id}`, data),
  deleteCustomField: (id) => api.delete(`/settings/custom-fields/${id}`),
  getPublicTicketStatusSettings: (config = {}) => api.get('/settings/public-ticket-status', config),
  updatePublicTicketStatusSettings: (data, config = {}) => api.put('/settings/public-ticket-status', data, config),
  getFeedbackSettings: (config = {}) => api.get('/settings/feedback-settings', config),
  updateFeedbackSettings: (data, config = {}) => api.put('/settings/feedback-settings', data, config),
  listFeedbackSubmissions: (config = {}) => api.get('/settings/feedback-submissions', config),
  deleteFeedbackSubmission: (id, config = {}) => api.delete(`/settings/feedback-submissions/${id}`, config),
  getPublicTicketStatusTickets: (params = {}, config = {}) => api.get('/settings/public-ticket-status/tickets', { ...config, params }),
  previewPublicTicketStatus: (ticketId, config = {}) => api.get(`/settings/public-ticket-status/tickets/${ticketId}/preview`, config),
  ensurePublicTicketStatusLink: (ticketId, config = {}) => api.post(`/settings/public-ticket-status/tickets/${ticketId}/ensure-link`, undefined, config),
  resetPublicTicketStatusLink: (ticketId, config = {}) => api.post(`/settings/public-ticket-status/tickets/${ticketId}/reset-link`, undefined, config),
  revokePublicTicketStatusLink: (ticketId, config = {}) => api.post(`/settings/public-ticket-status/tickets/${ticketId}/revoke-link`, undefined, config),
  resetPublicTicketStatusLinkByNumber: (ticketNumber, config = {}) => api.post(`/settings/public-ticket-status/tickets/by-number/${encodeURIComponent(ticketNumber)}/reset-link`, undefined, config),
  revokePublicTicketStatusLinkByNumber: (ticketNumber, config = {}) => api.post(`/settings/public-ticket-status/tickets/by-number/${encodeURIComponent(ticketNumber)}/revoke-link`, undefined, config),
  getUrgentEscalationPolicy: (config = {}) => api.get('/settings/urgent-escalation', config),
  updateUrgentEscalationPolicy: (data, config = {}) => api.put('/settings/urgent-escalation', data, config),
  getUrgentEscalationCandidates: (config = {}) => api.get('/settings/urgent-escalation/candidates', config),
};

/**
 * Sync API
 */
export const aiUsageAPI = {
  report: async (params = {}) => {
    const response = await api.get('/ai-usage', { params });
    return response.data;
  },
  setUsdCadRate: async (rate) => {
    const response = await api.put('/ai-usage/usd-cad-rate', { rate });
    return response.data;
  },
};

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

/** JSON for plain replies; FormData (browser-set boundary) when files are attached. */
function buildThreadPayload(body = {}) {
  const { files, cc, ...rest } = body;
  if (files && files.length > 0) {
    const form = new FormData();
    if (rest.bodyText) form.append('bodyText', rest.bodyText);
    if (rest.bodyHtml) form.append('bodyHtml', rest.bodyHtml);
    if (cc && cc.length) form.append('cc', cc.join(','));
    for (const file of files) form.append('files', file);
    return [form, { headers: { 'Content-Type': undefined }, timeout: 120000 }];
  }
  return [{ ...rest, ...(cc && cc.length ? { cc } : {}) }, undefined];
}

/**
 * Native ticketing API (/api/tickets) — tickets born inside Ticket Pulse plus
 * read access to FS-born tickets. All methods return the {success, data} envelope.
 */
export const ticketsAPI = {
  // Note: the shared response interceptor already unwraps to the
  // {success, data} envelope — return it directly like the other APIs.
  list: async (params = {}) => {
    return await api.get('/tickets', { params });
  },

  // `reconcile:false` skips the live FreshService deletion/closure check — use
  // it for the lightweight peek preview so rapid stepping doesn't fire a FS API
  // call per ticket. `signal` lets callers cancel a stale in-flight request.
  get: async (id, { reconcile = true, signal } = {}) => {
    return await api.get(`/tickets/${id}`, {
      ...(reconcile ? {} : { params: { reconcile: 0 } }),
      ...(signal ? { signal } : {}),
    });
  },

  meta: async () => {
    return await api.get('/tickets/meta');
  },

  stats: async () => {
    return await api.get('/tickets/stats');
  },

  clone: async (id) => {
    return await api.post(`/tickets/${id}/clone`);
  },

  remove: async (id) => {
    return await api.delete(`/tickets/${id}`);
  },

  // Saved filter views (per-user, workspace-scoped)
  listSavedViews: () => api.get('/tickets/saved-views'),
  createSavedView: (data) => api.post('/tickets/saved-views', data),
  updateSavedView: (id, data) => api.patch(`/tickets/saved-views/${id}`, data),
  deleteSavedView: (id) => api.delete(`/tickets/saved-views/${id}`),

  /** Download the current filtered queue as CSV (auth-aware). */
  exportCsv: async (params = {}) => {
    const response = await axios.get(`${API_BASE_URL}/tickets/export.csv`, {
      params,
      responseType: 'blob',
      withCredentials: true,
      headers: {
        ...(_authToken ? { Authorization: `Bearer ${_authToken}` } : {}),
        ...(_workspaceId ? { 'X-Workspace-Id': String(_workspaceId) } : {}),
      },
    });
    const url = URL.createObjectURL(response.data);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `tickets-export-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  },

  create: async (payload) => {
    return await api.post('/tickets', payload);
  },

  update: async (id, payload) => {
    return await api.patch(`/tickets/${id}`, payload);
  },

  setStatus: async (id, status) => {
    return await api.post(`/tickets/${id}/status`, { status });
  },

  assign: async (id, technicianId) => {
    return await api.post(`/tickets/${id}/assign`, { technicianId });
  },

  // Reply/note bodies: plain JSON normally; multipart when files ride along.
  reply: async (id, body) => {
    const [payload, config] = buildThreadPayload(body);
    return await api.post(`/tickets/${id}/replies`, payload, config);
  },

  note: async (id, body) => {
    const [payload, config] = buildThreadPayload(body);
    return await api.post(`/tickets/${id}/notes`, payload, config);
  },

  deleteNote: async (id, entryId) => {
    return await api.delete(`/tickets/${id}/notes/${entryId}`);
  },

  retryMirror: async (id) => {
    return await api.post(`/tickets/${id}/mirror/retry`);
  },

  // AI-proposed replies (draft→approve)
  proposedReplies: async (id) => {
    return await api.get(`/tickets/${id}/proposed-replies`);
  },

  // AI thread summary (on-demand, read-only)
  summarize: async (id) => await apiLongTimeout.post(`/tickets/${id}/summarize`),

  // Time tracking

  // Create-form presets
  createTemplates: async () => await api.get('/tickets/create-templates'),

  // Explicit ticket links + duplicate-close
  links: async (id) => await api.get(`/tickets/${id}/links`),
  // relatedTicketRef accepts what users see: TP-1042, #231164, or a bare number.
  addLink: async (id, relatedTicketRef, kind = 'related_to') => await api.post(`/tickets/${id}/links`, { relatedTicketRef, kind }),
  removeLink: async (id, linkId) => await api.delete(`/tickets/${id}/links/${linkId}`),
  markDuplicateOf: async (id, targetRef) => await api.post(`/tickets/${id}/duplicate-of/${encodeURIComponent(targetRef)}`),
  mergeTicket: async (id, targetTicketRef, notifyRequester = false) => await api.post(`/tickets/${id}/merge`, { targetTicketRef, notifyRequester }),
  // Multi-merge (QA 07-13 #1): primaryId survives; ticketIds fold into it.
  mergeMany: async (primaryId, ticketIds, notifyRequester = false) => await api.post(`/tickets/${primaryId}/merge-many`, { ticketIds, notifyRequester }),

  // Parent / child tickets (QA 07-16 #4). Refs accept TP-1042 / #231164 / bare number.
  family: async (id) => await api.get(`/tickets/${id}/family`),
  setParent: async (id, parentTicketRef) => await api.post(`/tickets/${id}/parent`, { parentTicketRef }),
  removeParent: async (id) => await api.delete(`/tickets/${id}/parent`),
  addChild: async (id, childTicketRef) => await api.post(`/tickets/${id}/children`, { childTicketRef }),

  // Ticket tasks (QA 07-16 #3).
  tasks: async (id) => await api.get(`/tickets/${id}/tasks`),
  addTask: async (id, payload) => await api.post(`/tickets/${id}/tasks`, payload),
  updateTask: async (id, taskId, patch) => await api.patch(`/tickets/${id}/tasks/${taskId}`, patch),
  removeTask: async (id, taskId) => await api.delete(`/tickets/${id}/tasks/${taskId}`),

  // Macros (quick-action bundles)
  macros: async () => await api.get('/tickets/macros'),
  applyMacro: async (id, macroId) => await api.post(`/tickets/${id}/macros/${macroId}/apply`),

  // Tags (gap plan P1) — TP-side layer, both origins, never written to FS
  listTags: async () => await api.get('/tickets/tags'),
  setTags: async (id, tagIds) => await api.put(`/tickets/${id}/tags`, { tagIds }),

  // Bulk edit by query (gap plan P2.2) — long timeout: applies up to 500 tickets
  bulkByQuery: async (payload) => await apiLongTimeout.post('/tickets/bulk-by-query', payload),

  // Category↔group affinity (gap plan P2.3)
  categoryGroupLinks: async () => await api.get('/tickets/category-group-links'),
  setCategoryGroupLinks: async (links) => await api.put('/tickets/category-group-links', { links }),

  // Presence (gap plan 2 P4.1) — in-memory "also viewing", nothing stored
  presenceHeartbeat: async (id, leaving = false) => await api.post(`/tickets/${id}/presence`, leaving ? { leaving: true } : {}),
  presenceSnapshot: async () => await api.get('/tickets/presence'),

  // Outbound webhooks (admin; gap plan 2 P3)
  listWebhooks: async () => await api.get('/tickets/webhook-subscriptions'),
  createWebhook: async ({ url, events }) => await api.post('/tickets/webhook-subscriptions', { url, events }),
  updateWebhook: async (id, data) => await api.patch(`/tickets/webhook-subscriptions/${id}`, data),
  deleteWebhook: async (id) => await api.delete(`/tickets/webhook-subscriptions/${id}`),
  testWebhook: async (id) => await api.post(`/tickets/webhook-subscriptions/${id}/test`),

  // Integration API keys (admin; gap plan P3.1)
  listApiKeys: async () => await api.get('/tickets/api-keys'),
  createApiKey: async ({ name, scopes }) => await api.post('/tickets/api-keys', { name, scopes }),
  updateApiKey: async (keyId, data) => await api.patch(`/tickets/api-keys/${keyId}`, data),
  deleteApiKey: async (keyId) => await api.delete(`/tickets/api-keys/${keyId}`),

  // Custom fields
  customFieldDefinitions: async () => await api.get('/tickets/custom-fields/definitions'),
  setCustomFields: async (id, values) => await api.patch(`/tickets/${id}/custom-fields`, { values }),

  sendProposedReply: async (id, proposalId, body = {}) => {
    return await api.post(`/tickets/${id}/proposed-replies/${proposalId}/send`, body);
  },

  dismissProposedReply: async (id, proposalId) => {
    return await api.post(`/tickets/${id}/proposed-replies/${proposalId}/dismiss`);
  },

  requesterSearch: async (q) => {
    return await api.get('/tickets/requester-search', { params: { q } });
  },

  requesterPhoto: async (email) => {
    return await api.get('/tickets/requester-photo', { params: { email } });
  },

  requesterStats: async (requesterId) => {
    return await api.get('/tickets/requester-stats', { params: { requesterId } });
  },

  /** Fire the AI assignment pipeline for this ticket (semi-manual assign). */
  triage: async (id) => {
    return await api.post(`/tickets/${id}/triage`);
  },

  /** FS-born write-back: FreshService is updated (and verified) FIRST. */
  fsUpdate: async (id, changes) => {
    // FS write-backs run on the high-priority interactive FS lane with a
    // bounded queue wait, so the server answers (success or an honest 503
    // "busy — nothing changed") well inside 2 minutes. Category changes are
    // the slow path (custom-field lookup resolution = several FS calls).
    return await apiLongTimeout.post(`/tickets/${id}/fs-update`, changes, { timeout: 120000 });
  },

  setNoise: async (id, { noise = true, resolve = false } = {}) => {
    return await api.post(`/tickets/${id}/noise`, { noise, resolve });
  },

  related: async (id) => {
    return await api.get(`/tickets/${id}/related`);
  },

  forward: async (id, { to, note }) => {
    return await api.post(`/tickets/${id}/forward`, { to, note });
  },

  // Reply templates (canned reply snippets)
  listTemplates: async () => {
    return await api.get('/tickets/templates');
  },

  // Quick notes — canned INTERNAL notes for the composer's note mode (QA 07-06 #12)
  listQuickNotes: async () => {
    return await api.get('/tickets/quick-notes');
  },

  createTemplate: async ({ name, bodyText, bodyHtml = null, categoryId = null }) => {
    return await api.post('/tickets/templates', { name, bodyText, bodyHtml, categoryId });
  },

  removeTemplate: async (templateId) => {
    return await api.delete(`/tickets/templates/${templateId}`);
  },

  // Category/group watch subscriptions
  listWatchSubscriptions: async () => {
    return await api.get('/tickets/watch-subscriptions');
  },

  setWatchSubscription: async ({ scopeType, categoryId = null, groupId = null, watch = true, notifyRequesterReply = false }) => {
    return await api.post('/tickets/watch-subscriptions', { scopeType, categoryId, groupId, watch, notifyRequesterReply });
  },

  // Scheduled tickets (created later through the normal create path)
  listScheduled: async () => {
    return await api.get('/tickets/scheduled');
  },

  scheduleCreate: async (payload, scheduledForAt, { recurrence = 'none', endAt = null } = {}) => {
    return await api.post('/tickets/scheduled', { payload, scheduledForAt, recurrence, endAt });
  },

  activateScheduled: async (scheduledId) => {
    return await api.post(`/tickets/scheduled/${scheduledId}/activate`);
  },

  cancelScheduled: async (scheduledId) => {
    return await api.delete(`/tickets/scheduled/${scheduledId}`);
  },

  // Staged attachments on a schedule (gap plan 2 P2) — adopted at activation
  uploadScheduledAttachments: async (scheduledId, files) => {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    return await apiLongTimeout.post(`/tickets/scheduled/${scheduledId}/attachments`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  // Attachments
  listAttachments: async (id) => {
    return await api.get(`/tickets/${id}/attachments`);
  },

  // onProgress(percent 0-100) fires as the file bytes upload (big attachments
  // can take a while, so the UI shows real progress instead of a bare spinner).
  uploadAttachments: async (id, files, onProgress) => {
    const form = new FormData();
    for (const file of files) form.append('files', file);
    // Let the browser set the multipart boundary
    return await api.post(`/tickets/${id}/attachments`, form, {
      headers: { 'Content-Type': undefined },
      timeout: 120000,
      onUploadProgress: onProgress
        ? (e) => { if (e.total) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100))); }
        : undefined,
    });
  },

  removeAttachment: async (id, attachmentId) => {
    return await api.delete(`/tickets/${id}/attachments/${attachmentId}`);
  },

  /** Authenticated download: fetches the blob through the API and saves it. */
  // Fetch an attachment as an object URL (for inline preview, not forced download).
  // Caller is responsible for URL.revokeObjectURL when done.
  attachmentObjectUrl: async (id, attachmentId) => {
    const response = await axios.get(
      `${API_BASE_URL}/tickets/${id}/attachments/${attachmentId}/download`,
      {
        responseType: 'blob',
        withCredentials: true,
        headers: {
          ...(_authToken ? { Authorization: `Bearer ${_authToken}` } : {}),
          ...(_workspaceId ? { 'X-Workspace-Id': String(_workspaceId) } : {}),
        },
      },
    );
    return { url: URL.createObjectURL(response.data), type: response.data.type || '' };
  },

  downloadAttachment: async (id, attachmentId, fileName) => {
    const response = await axios.get(
      `${API_BASE_URL}/tickets/${id}/attachments/${attachmentId}/download`,
      {
        responseType: 'blob',
        withCredentials: true,
        headers: {
          ...(_authToken ? { Authorization: `Bearer ${_authToken}` } : {}),
          ...(_workspaceId ? { 'X-Workspace-Id': String(_workspaceId) } : {}),
        },
      },
    );
    const url = URL.createObjectURL(response.data);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName || 'attachment';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  },

  // Approvals
  requestApproval: async (id, payload) => {
    return await api.post(`/tickets/${id}/approvals`, payload);
  },

  decideApproval: async (id, approvalId, decision, note = null) => {
    return await api.post(`/tickets/${id}/approvals/${approvalId}/decide`, { decision, note });
  },

  clarifyApproval: async (id, approvalId, note) => {
    return await api.post(`/tickets/${id}/approvals/${approvalId}/clarify`, { note });
  },

  resubmitApproval: async (id, approvalId, { note = null } = {}) => {
    return await api.post(`/tickets/${id}/approvals/${approvalId}/resubmit`, { note });
  },

  cancelApproval: async (id, approvalId) => {
    return await api.post(`/tickets/${id}/approvals/${approvalId}/cancel`);
  },

  changeApprovalDecision: async (id, approvalId, decision, note = null) => {
    return await api.post(`/tickets/${id}/approvals/${approvalId}/change`, { decision, note });
  },

  deleteApproval: async (id, approvalId) => {
    return await api.delete(`/tickets/${id}/approvals/${approvalId}`);
  },

  // Cross-ticket approver inbox (Approvals page + nav badge)
  approvalInbox: async () => {
    const res = await api.get('/tickets/approvals/inbox');
    return res.data;
  },
  approvalInboxCount: async () => {
    const res = await api.get('/tickets/approvals/inbox/count');
    return res.data?.count || 0;
  },
  approvalsNeedingMyInfo: async () => {
    const res = await api.get('/tickets/approvals/mine');
    return res.data;
  },
  approvalsOverview: async (params = {}) => {
    const res = await api.get('/tickets/approvals/all', { params });
    return res.data;
  },

  // Mailbox connections (admin)
  listMailboxes: async () => {
    return await api.get('/tickets/mailboxes');
  },

  createMailbox: async (payload) => {
    return await api.post('/tickets/mailboxes', payload);
  },

  updateMailbox: async (id, payload) => {
    return await api.patch(`/tickets/mailboxes/${id}`, payload);
  },

  removeMailbox: async (id) => {
    return await api.delete(`/tickets/mailboxes/${id}`);
  },

  testMailbox: async (id) => {
    return await api.post(`/tickets/mailboxes/${id}/test`);
  },
};

/**
 * Public approval magic-link API (no auth — the token is the credential).
 */
export const publicApprovalAPI = {
  get: async (token) => {
    const response = await api.get(`/ticket-approvals/public/${encodeURIComponent(token)}`);
    return response;
  },

  decide: async (token, decision, note = null, noteHtml = null) => {
    const response = await api.post(`/ticket-approvals/public/${encodeURIComponent(token)}/decide`, { decision, note, noteHtml });
    return response;
  },

  // Approver bounces it back to the requester for more info (decision='clarify').
  clarify: async (token, note) => {
    const response = await api.post(`/ticket-approvals/public/${encodeURIComponent(token)}/decide`, { decision: 'clarify', note });
    return response;
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
  getReviewSummary: () => api.get('/calendar-leave/review-summary'),
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
  getWebhookConfig: () => api.get('/assignment/webhook-config'),
  updateWebhookConfig: (data) => api.put('/assignment/webhook-config', data),
  rotateWebhookSecret: () => api.post('/assignment/webhook-config/rotate'),
  testWebhookConfig: () => api.post('/assignment/webhook-config/test'),

  getQueuedRuns: () => api.get('/assignment/queued'),
  pruneQueuedRuns: () => api.post('/assignment/queued/prune'),
  getQueueStatus: () => api.get('/assignment/queue-status'),
  runNow: (id) => api.post(`/assignment/runs/${id}/run-now`),
  // Returns the relative SSE path for streaming a queued run's promoted execution.
  // Pass to readSSEStream / LivePipelineView.streamPath. POST with stream=true.
  runNowStreamPath: (id) => `/assignment/runs/${id}/run-now?stream=true`,
  getQueue: (params) => api.get('/assignment/queue', { params }),
  getRuns: (params) => api.get('/assignment/runs', { params }),
  getPriorityAlertAudit: (params) => api.get('/assignment/audit/priority-alerts', { params }),
  getRun: (id) => api.get(`/assignment/runs/${id}`),
  getLatestRunForTicket: (ticketId) => api.get(`/assignment/ticket/${ticketId}/latest-run`),
  getTicketRuns: (ticketId) => api.get(`/assignment/ticket/${ticketId}/runs`),
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
  priorityAssessmentBackfill: (data = {}) => api.post('/assignment/priority-assessment/backfill', data),
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
  decideCompetencyRequestGroup: (groupId, data) => api.post(`/assignment/competency-requests/groups/${encodeURIComponent(groupId)}/decision`, data),
  detectDuplicateCategories: () => api.get('/assignment/competencies/duplicates'),
  mergeCategories: (data) => api.post('/assignment/competencies/merge', data),
  getSkillDraft: () => api.get('/assignment/skills/draft'),
  saveSkillDraft: (data) => api.post('/assignment/skills/draft', data),
  importSummitSkills: () => api.post('/assignment/skills/import-summit'),
  publishSkillDraft: () => api.post('/assignment/skills/publish'),
  getSkillMappings: () => api.get('/assignment/skills/mappings'),
  updateSkillMappings: (mappings) => api.put('/assignment/skills/mappings', { mappings }),
  getFreshserviceSkillFields: () => api.get('/assignment/skills/freshservice-fields'),
  getFreshserviceSkillDrift: () => api.get('/assignment/skills/freshservice-drift'),
  syncFreshserviceSkillObjects: (data = {}) => api.post('/assignment/skills/freshservice-sync', data),
  reclassifyTickets: (data = {}) => apiLongTimeout.post('/assignment/tickets/reclassify', data),
  getReclassificationRuns: (params = {}) => api.get('/assignment/tickets/reclassify/runs', { params }),
  rollbackReclassificationRun: (id) => api.post(`/assignment/tickets/reclassify/runs/${id}/rollback`),
  getCompetencies: () => api.get('/assignment/competencies'),
  getCategorySuggestions: () => api.get('/assignment/competencies/category-suggestions'),
  reviewCategorySuggestion: (id, data) => api.post(`/assignment/competencies/category-suggestions/${id}/review`, data),
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

export const aiProviderAPI = {
  getModels: (params = {}) => api.get('/ai-providers/models', { params }),
  getSettings: () => api.get('/ai-providers/settings'),
  updateSettings: (settings) => api.put('/ai-providers/settings', { settings }),
  getHealth: (params = {}) => api.get('/ai-providers/health', { params }),
  testProvider: (data) => api.post('/ai-providers/test', data),
};

export const notificationWorkflowAPI = {
  list: () => api.get('/notification-workflows'),
  health: () => api.get('/notification-workflows/health'),
  listTemplates: () => api.get('/notification-workflows/templates'),
  installTemplate: (key) => api.post(`/notification-workflows/templates/${key}/install`),
  runForTicket: (id, ticketId) => api.post(`/notification-workflows/${id}/run-for-ticket/${ticketId}`),
  variables: () => api.get('/notification-workflows/variables'),
  getSignature: () => api.get('/notification-workflows/signature'),
  updateSignature: (data) => api.put('/notification-workflows/signature', data),
  getEmailBlocks: () => api.get('/notification-workflows/email-blocks'),
  createEmailBlock: (data) => api.post('/notification-workflows/email-blocks', data),
  updateEmailBlock: (id, data) => api.put(`/notification-workflows/email-blocks/${id}`, data),
  deleteEmailBlock: (id) => api.delete(`/notification-workflows/email-blocks/${id}`),
  setDefaultEmailBlock: (id) => api.post(`/notification-workflows/email-blocks/${id}/default`),
  getAfterHoursPolicy: () => api.get('/notification-workflows/after-hours-policy'),
  updateAfterHoursPolicy: (data) => api.put('/notification-workflows/after-hours-policy', data),
  previewAfterHoursPolicy: (data = {}) => api.post('/notification-workflows/after-hours-policy/preview', data),
  getLlmToolCatalog: () => api.get('/notification-workflows/llm-tools/catalog'),
  getLlmToolPolicy: () => api.get('/notification-workflows/llm-tools/policy'),
  updateLlmToolPolicy: (data) => api.put('/notification-workflows/llm-tools/policy', data),
  previewLlmContext: (data) => apiLongTimeout.post('/notification-workflows/llm-tools/context-preview', data),
  testLlmTools: (data) => apiLongTimeout.post('/notification-workflows/llm-tools/test-run', data),
  get: (id) => api.get(`/notification-workflows/${id}`),
  saveDraft: (id, data) => api.put(`/notification-workflows/${id}/draft`, data),
  publish: (id, data = {}) => api.post(`/notification-workflows/${id}/publish`, data),
  setEnabled: (id, enabled) => api.put(`/notification-workflows/${id}/enabled`, { enabled }),
  setMockMode: (id, enabled) => api.put(`/notification-workflows/${id}/mock-mode`, { enabled }),
  getPreviewTickets: (params = {}) => api.get('/notification-workflows/preview-tickets', { params }),
  getRoutingMetadata: (params = {}) => api.get('/notification-workflows/routing/metadata', { params }),
  previewRouting: (data) => api.post('/notification-workflows/routing/preview', data),
  test: (data) => apiLongTimeout.post('/notification-workflows/test', data),
  sendTestEmail: (data) => api.post('/notification-workflows/test-email', data),
  sendAuditTestEmail: (auditId) => api.post(`/notification-workflows/audits/${encodeURIComponent(auditId)}/send-test-email`),
  getAuditRunEmail: (auditId) => api.get(`/notification-workflows/audits/${encodeURIComponent(auditId)}/rendered-email`),
  getAudit: (auditId) => api.get(`/notification-workflows/audits/${encodeURIComponent(auditId)}`),
  getAuditRuns: (params = {}) => api.get('/notification-workflows/runs', { params }),
  getAuditDepartments: () => api.get('/notification-workflows/runs/departments'),
  createVariant: (data) => api.post('/notification-workflows', data),
  duplicateVariant: (id, data = {}) => api.post(`/notification-workflows/${id}/duplicate`, data),
  updateRouting: (id, data) => api.put(`/notification-workflows/${id}/routing`, data),
  changeTrigger: (id, triggerType) => api.put(`/notification-workflows/${id}/trigger`, { triggerType }),
  setArchived: (id, archived) => api.put(`/notification-workflows/${id}/archive`, { archived }),
  deleteArchived: (id) => api.delete(`/notification-workflows/${id}`),
  getRuns: (id, params = {}) => api.get(`/notification-workflows/${id}/runs`, { params }),
  retryDelivery: (id) => api.post(`/notification-workflows/deliveries/${id}/retry`),
};

/**
 * Agent self-service API
 */
export const agentAPI = {
  getMyCompetencies: (params = {}) => api.get('/agent/competencies', { params }),
  submitCompetencyChange: (data) => api.post('/agent/competencies/changes', data),
  submitCompetencyChangesBulk: (data) => api.post('/agent/competencies/changes/bulk', data),
  cancelCompetencyChange: (id) => api.delete(`/agent/competencies/changes/${id}`),
  getNotificationPreferences: (params = {}) => api.get('/agent/notifications/preferences', { params }),
  saveNotificationPreferences: (data) => api.put('/agent/notifications/preferences', data),
  requestPhoneVerification: (data) => api.post('/agent/notifications/phone-verification', data),
  confirmPhoneVerification: (data) => api.post('/agent/notifications/phone-verification/confirm', data),
  // Custom agent alerts
  getAlerts: (params = {}) => api.get('/agent/alerts', { params }),
  getAlertOptions: (params = {}) => api.get('/agent/alerts-options', { params }),
  createAlert: (data) => api.post('/agent/alerts', data),
  updateAlert: (id, data) => api.patch(`/agent/alerts/${id}`, data),
  deleteAlert: (id, params = {}) => api.delete(`/agent/alerts/${id}`, { params }),
  saveAlertQuietHours: (data) => api.put('/agent/alerts-quiet-hours', data),
  getSummitWorkshop: () => api.get('/agent/summit-2026/workshop'),
  voteSummitCategory: (data) => api.post('/agent/summit-2026/votes', data),
  getSummitWorkshopEventSource: () => new EventSource(`${API_BASE_URL}/agent/summit-2026/workshop/events${_authToken ? `?token=${encodeURIComponent(_authToken)}` : ''}`, { withCredentials: true }),
  getSummitFeedback: () => api.get('/agent/summit-2026/feedback'),
  submitSummitFeedback: (data) => api.post('/agent/summit-2026/feedback/items', data),
  voteSummitFeedback: (itemId, data) => api.post(`/agent/summit-2026/feedback/items/${encodeURIComponent(itemId)}/vote`, data),
  commentSummitFeedback: (itemId, data) => api.post(`/agent/summit-2026/feedback/items/${encodeURIComponent(itemId)}/comments`, data),
  getSummitEventSource: () => new EventSource(`${API_BASE_URL}/agent/summit-2026/events${_authToken ? `?token=${encodeURIComponent(_authToken)}` : ''}`, { withCredentials: true }),
};

/**
 * Analytics API
 */
export const analyticsAPI = {
  getCategories: () => apiAnalytics.get('/analytics/categories'),
  getOverview: (params = {}) => apiAnalytics.get('/analytics/overview', { params }),
  getDemandFlow: (params = {}) => apiAnalytics.get('/analytics/demand-flow', { params }),
  getCategoryIntelligence: (params = {}) => apiAnalytics.get('/analytics/category-intelligence', { params }),
  getTeamBalance: (params = {}) => apiAnalytics.get('/analytics/team-balance', { params }),
  getQuality: (params = {}) => apiAnalytics.get('/analytics/quality', { params }),
  getAutomationOps: (params = {}) => apiAnalytics.get('/analytics/automation-ops', { params }),
  getInsights: (params = {}) => apiAnalytics.get('/analytics/insights', { params }),
  // Reports (feedback 07-14): saved snapshots; generation runs the LLM (10-20s)
  listReports: () => apiAnalytics.get('/analytics/reports'),
  getReport: (id) => apiAnalytics.get(`/analytics/reports/${id}`),
  generateReport: (payload) => apiAnalytics.post('/analytics/reports', payload, { timeout: 90000 }),
  renameReport: (id, title) => apiAnalytics.patch(`/analytics/reports/${id}`, { title }),
  deleteReport: (id) => apiAnalytics.delete(`/analytics/reports/${id}`),
};

/**
 * IT Summit category workshop API
 */
export const summitAPI = {
  getWorkshop: () => api.get('/summit/workshop'),
  getWorkshopEventSource: () => new EventSource(`${API_BASE_URL}/summit/workshop/events${_authToken ? `?token=${encodeURIComponent(_authToken)}` : ''}`, { withCredentials: true }),
  getFeedback: () => api.get('/summit/workshop/feedback'),
  submitFeedback: (data) => api.post('/summit/workshop/feedback/items', data),
  voteFeedback: (itemId, data) => api.post(`/summit/workshop/feedback/items/${encodeURIComponent(itemId)}/vote`, data),
  commentFeedback: (itemId, data) => api.post(`/summit/workshop/feedback/items/${encodeURIComponent(itemId)}/comments`, data),
  updateFeedbackItem: (itemId, data) => api.put(`/summit/workshop/feedback/items/${encodeURIComponent(itemId)}`, data),
  deleteFeedbackItem: (itemId) => api.delete(`/summit/workshop/feedback/items/${encodeURIComponent(itemId)}`),
  deleteFeedbackComment: (commentItemId) => api.delete(`/summit/workshop/feedback/comments/${encodeURIComponent(commentItemId)}`),
  resetFeedback: () => api.post('/summit/workshop/feedback/reset'),
  saveState: (state, { label = 'Manual save', snapshotType = 'manual' } = {}) =>
    api.put('/summit/workshop/state', { state, label, snapshotType }),
  restoreSnapshot: (id) => api.post(`/summit/workshop/snapshots/${id}/restore`),
  enableVoting: (durationMinutes = 120, regenerate = false) => api.post('/summit/workshop/voting', { durationMinutes, regenerate }),
  extendVoting: (extensionMinutes = 30) => api.post('/summit/workshop/voting/extend', { extensionMinutes }),
  resetParticipantVotes: (id) => api.post(`/summit/workshop/participants/${id}/reset`),
  resetStaleParticipants: () => api.post('/summit/workshop/participants/reset-stale'),
  getPublicWorkshop: (token, participantKey = null) => api.get(`/summit/public/${token}`, {
    params: participantKey ? { participantKey } : undefined,
  }),
  getPublicReport: (token) => api.get(`/summit/public/${token}/report`),
  joinPublicWorkshop: (token, data) => api.post(`/summit/public/${token}/join`, data),
  submitVote: (token, data) => api.post(`/summit/public/${token}/votes`, data),
  submitPublicFeedback: (token, data) => api.post(`/summit/public/${token}/feedback/items`, data),
  votePublicFeedback: (token, itemId, data) => api.post(`/summit/public/${token}/feedback/items/${encodeURIComponent(itemId)}/vote`, data),
  commentPublicFeedback: (token, itemId, data) => api.post(`/summit/public/${token}/feedback/items/${encodeURIComponent(itemId)}/comments`, data),
  getPublicEventSource: (token) => new EventSource(`${API_BASE_URL}/summit/public/${token}/events`, { withCredentials: true }),
};

export const publicTicketStatusAPI = {
  get: (token) => api.get(`/ticket-status/public/${encodeURIComponent(token)}`),
};

export const publicTicketEscalationAPI = {
  get: (token) => api.get(`/ticket-status/public/${encodeURIComponent(token)}/escalation`),
  submit: (token) => api.post(`/ticket-status/public/${encodeURIComponent(token)}/escalation`),
};

export const publicTicketUrgencyAPI = {
  get: (token) => api.get(`/ticket-status/public/${encodeURIComponent(token)}/urgency`),
  submit: (token) => api.post(`/ticket-status/public/${encodeURIComponent(token)}/urgency`),
};

export const publicTicketFeedbackAPI = {
  get: (token) => api.get(`/ticket-status/public/${encodeURIComponent(token)}/feedback`),
  submit: (token, body) => api.post(`/ticket-status/public/${encodeURIComponent(token)}/feedback`, body),
};

/**
 * Health check
 */
export const healthCheck = async () => {
  return await api.get('/health');
};

export default api;
