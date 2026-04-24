import axios from 'axios';
import logger from '../utils/logger.js';
import { ExternalAPIError } from '../utils/errors.js';
import { FreshServiceRateLimiter } from './rateLimiter.js';

// Sentinel returned by fetchTicketSafe when FS replies 403 — the ticket
// exists but this API key can't see it (most commonly: ticket was moved
// to a workspace this key isn't authorized for). Reconciliation uses
// this to skip without marking the row as Deleted.
export const FORBIDDEN_TICKET = Object.freeze({ __forbidden: true });

// Shared per-process singleton rate limiter so ALL callsites and workspaces
// share a single budget against FreshService. Enterprise per-minute cap is
// typically 140/min on /agents — we cap at 110 to leave headroom and avoid
// burst-detection 429s.
let SHARED_RATE_LIMITER = null;
function getSharedRateLimiter() {
  if (!SHARED_RATE_LIMITER) {
    SHARED_RATE_LIMITER = new FreshServiceRateLimiter({
      maxRequestsPerMinute: 110,
      minDelayMs: 550,
    });
  }
  return SHARED_RATE_LIMITER;
}

/**
 * FreshService API Client
 * Handles all interactions with the FreshService API
 */
class FreshServiceClient {
  constructor(domain, apiKey, options = {}) {
    if (!domain || !apiKey) {
      throw new Error('FreshService domain and API key are required');
    }

    this.domain = domain;
    this.apiKey = apiKey;
    this.rateLimitPriority = options.priority || 'normal';
    this.rateLimitSource = options.source || null;
    // Handle both full domain (efusion.freshservice.com) and subdomain (efusion)
    const fullDomain = domain.includes('.freshservice.com') ? domain : `${domain}.freshservice.com`;
    this.baseURL = `https://${fullDomain}/api/v2`;

    // Shared rate limiter across the process
    this.limiter = getSharedRateLimiter();

    // Create axios instance with authentication
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Content-Type': 'application/json',
      },
      auth: {
        username: apiKey,
        password: 'X', // FreshService uses API key as username, password can be anything
      },
      timeout: 30000, // 30 second timeout
    });

    // Response interceptor — feed rate-limit headers back to limiter and let 429 bubble
    this.client.interceptors.response.use(
      (response) => {
        this.limiter.onResponse(response.headers);
        return response;
      },
      (error) => {
        const status = error.response?.status;

        if (status === 429) {
          this.limiter.on429(error.response?.headers);
          throw error;
        }
        if (status === 404 || status === 405) {
          throw error;
        }
        // 403 on /csat_response is expected when the API key lacks CSAT
        // scope or the module is disabled (common on dev). Let the caller
        // handle it (fetchCSATResponse swallows it) instead of logging
        // a full error + stack for every ticket in the sweep.
        if (status === 403 && /\/csat_response(\b|$)/.test(error.config?.url || '')) {
          throw error;
        }
        // 403 on a single-ticket fetch (/tickets/:id, optionally with a
        // ?include= querystring) means the ticket exists but the API key
        // can't see it — typically the ticket was moved to a workspace
        // this key isn't authorized for. Reconciliation handles this by
        // bumping updatedAt; logging it as an error here just produces
        // noise on every sweep.
        if (status === 403 && /\/tickets\/\d+(\?|$)/.test(error.config?.url || '')) {
          throw error;
        }

        logger.error('FreshService API error:', {
          url: error.config?.url,
          status,
          message: error.response?.data?.description || error.message,
        });

        throw new ExternalAPIError(
          'FreshService',
          error.response?.data?.description || error.message,
          error,
        );
      },
    );
  }

  /**
   * Route an axios method call through the shared rate limiter.
   * All HTTP calls should use this.
   */
  _throttledRequest(method, url, ...rest) {
    return this.limiter.enqueue(
      () => this.client[method](url, ...rest),
      { priority: this.rateLimitPriority, source: this.rateLimitSource },
    );
  }

  _get(url, config) { return this._throttledRequest('get', url, config); }
  _put(url, data, config) { return this._throttledRequest('put', url, data, config); }
  _post(url, data, config) { return this._throttledRequest('post', url, data, config); }

  /**
   * Fetch all pages of a paginated API endpoint.
   * Rate limiting is handled centrally by `this.limiter` via `_get()`.
   */
  async fetchAllPages(endpoint, params = {}, onProgress = null) {
    const allResults = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await this._fetchWithRetry(endpoint, {
          params: { ...params, page, per_page: 100 },
        });

        const data = response.data;
        const results = this._extractResults(data, endpoint);

        if (results && results.length > 0) {
          allResults.push(...results);
          page++;

          // Emit progress on every page so the UI reflects real motion.
          // Log output stays every 10 pages to avoid spam.
          if (onProgress) onProgress(page, allResults.length);
          if (page % 10 === 0) {
            logger.info(`Fetching ${endpoint}: ${allResults.length} items so far (page ${page})...`);
          }

          if (results.length < 100) hasMore = false;
        } else {
          hasMore = false;
        }
      } catch (error) {
        logger.error(`Error fetching page ${page} of ${endpoint}:`, error);
        throw error;
      }
    }

    logger.info(`Fetched ${allResults.length} items from ${endpoint}`);
    return allResults;
  }

  /**
   * Retry wrapper for 429 responses. The rate limiter already paces requests,
   * but if a 429 still slips through (e.g. endpoint-specific sub-limits),
   * honor the Retry-After header via limiter.on429() then retry.
   */
  async _fetchWithRetry(endpoint, config = {}, maxRetries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this._get(endpoint, config);
      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        if (status === 429 && attempt < maxRetries) {
          // limiter.on429 was already called in the interceptor; the queue is
          // now paused for Retry-After. Just re-enqueue.
          logger.warn(`Retrying ${endpoint} (attempt ${attempt + 1}/${maxRetries}) after 429`);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  /**
   * Extract results from API response based on endpoint
   * @param {Object} data - Response data
   * @param {string} endpoint - API endpoint
   * @returns {Array} Extracted results
   */
  _extractResults(data, endpoint) {
    // CHECK SUB-RESOURCES FIRST. The previous order matched `/tickets` on
    // any URL containing the word "tickets" — including `/tickets/:id/
    // conversations` and `/tickets/:id/activities` — and tried to pull
    // `data.tickets`, which doesn't exist on those responses, so every
    // call silently returned []. Daily review thread hydration relied on
    // this and got zero conversation bodies in prod.
    if (endpoint.includes('/conversations')) return data.conversations || [];
    if (endpoint.includes('/activities')) return data.activities || [];
    if (endpoint.includes('/notes')) return data.notes || [];
    if (endpoint.includes('/time_entries')) return data.time_entries || [];
    if (endpoint.includes('/tickets')) return data.tickets || [];
    if (endpoint.includes('/agents')) return data.agents || [];
    if (endpoint.includes('/requesters')) return data.requesters || [];
    if (endpoint.includes('/workspaces')) return data.workspaces || [];
    if (endpoint.includes('/groups')) return data.groups || [];
    return data;
  }

  /**
   * Fetch tickets with optional filters
   * @param {Object} filters - Query filters
   * @param {Function} onProgress - Optional callback for progress updates (page, itemCount)
   * @returns {Promise<Array>} Array of tickets
   */
  async fetchTickets(filters = {}, onProgress = null) {
    try {
      logger.info('Fetching tickets from FreshService', filters);

      const params = {};

      // Scope to a specific FreshService workspace
      if (filters.workspace_id) {
        params.workspace_id = filters.workspace_id;
      }

      // Apply filters
      if (filters.updated_since) {
        params.updated_since = filters.updated_since;
      }

      if (filters.status) {
        // FreshService uses numeric status codes
        // 2=Open, 3=Pending, 4=Resolved, 5=Closed
        params.filter = `status:${filters.status}`;
      }

      // Include related objects (e.g., requester, stats)
      if (filters.include) {
        params.include = filters.include;
      }

      const tickets = await this.fetchAllPages('/tickets', params, onProgress);
      logger.info(`Fetched ${tickets.length} tickets`);
      return tickets;
    } catch (error) {
      logger.error('Error fetching tickets:', error);
      throw error;
    }
  }

  /**
   * Fetch a single ticket by ID
   * @param {number} ticketId - Ticket ID
   * @returns {Promise<Object>} Ticket object
   */
  async fetchTicket(ticketId) {
    try {
      const response = await this._get(`/tickets/${ticketId}`);
      return response.data.ticket;
    } catch (error) {
      logger.error(`Error fetching ticket ${ticketId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch a single ticket, returning null if deleted (404). 429s are handled
   * by the shared limiter; we retry once. A 403 (ticket exists but the API
   * key can't see it — usually because it was moved to a workspace this
   * key isn't authorized for) returns a typed sentinel so reconciliation
   * can distinguish "gone" from "forbidden" without misclassifying the
   * ticket as Deleted.
   */
  async fetchTicketSafe(ticketId) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this._get(`/tickets/${ticketId}`);
        return response.data.ticket;
      } catch (error) {
        const status = error.response?.status || error.originalError?.response?.status;
        if (status === 404) return null;
        if (status === 403) return FORBIDDEN_TICKET;
        if (status === 429 && attempt < 3) continue;
        throw error;
      }
    }
    return null;
  }

  /**
   * Fetch CSAT (Customer Satisfaction) response for a ticket
   * @param {number} ticketId - Ticket ID
   * @returns {Promise<Object|null>} CSAT response object or null if no response
   */
  async fetchCSATResponse(ticketId) {
    try {
      const response = await this._fetchWithRetry(`/tickets/${ticketId}/csat_response`, {}, 3);
      return response.data.csat_response || null;
    } catch (error) {
      // FreshService returns:
      //   404 → ticket has no CSAT survey response
      //   403 → API key lacks CSAT scope, or CSAT module not enabled for the
      //         workspace (common on dev keys). Treat as "no CSAT" so we
      //         stamp csat_checked_at and stop re-hitting it every sweep
      //         instead of spamming error logs.
      const status = error.response?.status || error.originalError?.response?.status;
      if (status === 404 || status === 403) return null;
      logger.error(`Error fetching CSAT for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  async fetchTicketActivities(ticketId) {
    try {
      const response = await this._fetchWithRetry(`/tickets/${ticketId}/activities`, {}, 3);
      return response.data.activities || [];
    } catch (error) {
      logger.error(`Error fetching activities for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch all conversations (replies + notes, public + private) for a ticket.
   * This is the only endpoint that returns the actual body text of replies
   * and notes — `/activities` returns "added a private note" *events* but
   * not the note body. Daily review analysis needs the bodies to make sense
   * of why a ticket was rerouted, rejected, or escalated.
   *
   * Walks all pages because long-running tickets can have hundreds of
   * conversation entries (FS default page size = 30, max = 100).
   *
   * @param {number} ticketId
   * @param {object} [options]
   * @param {number} [options.maxEntries] - Optional cap on returned entries (oldest preserved). Defaults to no cap.
   * @returns {Promise<Array>} Array of conversation objects (body / body_text / private / incoming / user_id / created_at / id)
   */
  async fetchTicketConversations(ticketId, { maxEntries = null } = {}) {
    try {
      const all = await this.fetchAllPages(`/tickets/${ticketId}/conversations`, {});
      if (maxEntries && all.length > maxEntries) {
        return all.slice(-maxEntries);
      }
      return all;
    } catch (error) {
      logger.error(`Error fetching conversations for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch all workspaces from FreshService
   * @returns {Promise<Array>} Array of workspace objects
   */
  async fetchWorkspaces() {
    try {
      logger.info('Fetching workspaces from FreshService');
      const workspaces = await this.fetchAllPages('/workspaces', {});
      logger.info(`Fetched ${workspaces.length} workspaces`);
      return workspaces;
    } catch (error) {
      logger.error('Error fetching workspaces:', error);
      throw error;
    }
  }

  /**
   * Fetch all agents (technicians)
   * @param {Object} filters - Query filters
   * @returns {Promise<Array>} Array of agents
   */
  async fetchAgents(filters = {}) {
    try {
      logger.info('Fetching agents from FreshService', filters);

      const params = {};
      if (filters.workspace_id) {
        params.workspace_id = filters.workspace_id;
      }

      const agents = await this.fetchAllPages('/agents', params);
      logger.info(`Fetched ${agents.length} agents`);
      return agents;
    } catch (error) {
      logger.error('Error fetching agents:', error);
      throw error;
    }
  }

  /**
   * Fetch a single agent by ID
   * @param {number} agentId - Agent ID
   * @returns {Promise<Object>} Agent object
   */
  async fetchAgent(agentId) {
    try {
      const response = await this._get(`/agents/${agentId}`);
      return response.data.agent;
    } catch (error) {
      logger.error(`Error fetching agent ${agentId}:`, error);
      throw error;
    }
  }

  async fetchRequester(requesterId) {
    try {
      const response = await this._get(`/requesters/${requesterId}`);
      return response.data.requester;
    } catch (error) {
      logger.error(`Error fetching requester ${requesterId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch multiple requesters. Rate limiting is handled centrally.
   */
  async fetchAllRequesters(requesterIds) {
    try {
      logger.info(`Fetching ${requesterIds.length} requesters from FreshService`);
      const requesters = [];
      const failed = [];

      for (const id of requesterIds) {
        try {
          const requester = await this.fetchRequester(id);
          requesters.push(requester);
          if (requesters.length % 50 === 0) {
            logger.info(`Fetched ${requesters.length}/${requesterIds.length} requesters`);
          }
        } catch (error) {
          logger.warn(`Failed to fetch requester ${id}, skipping:`, error.message);
          failed.push(id);
        }
      }

      logger.info(`Successfully fetched ${requesters.length} requesters, ${failed.length} failed`);
      if (failed.length > 0) {
        logger.warn(`Failed requester IDs: ${failed.join(', ')}`);
      }

      return requesters;
    } catch (error) {
      logger.error('Error fetching requesters:', error);
      throw error;
    }
  }

  async testConnection() {
    try {
      logger.info('Testing FreshService API connection');
      await this._get('/agents', { params: { per_page: 1 } });
      logger.info('FreshService API connection successful');
      return true;
    } catch (error) {
      logger.error('FreshService API connection failed:', error);
      return false;
    }
  }

  async getRateLimitInfo() {
    try {
      const response = await this._get('/agents', { params: { per_page: 1 } });
      return {
        limit: response.headers['x-ratelimit-total'],
        remaining: response.headers['x-ratelimit-remaining'],
        usedToday: response.headers['x-ratelimit-used-currentrequest'],
        limiterStats: this.limiter.getStats(),
      };
    } catch (error) {
      logger.error('Error fetching rate limit info:', error);
      return null;
    }
  }

  /**
   * Sleep for a specified duration (for rate limiting)
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  /**
   * Assign a ticket to an agent (scaffolding for future ticket assignment feature)
   * @param {number} ticketId - FreshService ticket ID
   * @param {number} agentId - FreshService agent ID to assign to
   * @returns {Promise<Object>} Updated ticket object
   */
  async assignTicket(ticketId, agentId) {
    try {
      const response = await this._put(`/tickets/${ticketId}`, {
        ticket: { responder_id: agentId },
      });
      return response.data.ticket;
    } catch (error) {
      const detail = error.response?.data;
      const httpStatus = error.response?.status;
      logger.error(`Error assigning ticket ${ticketId} to agent ${agentId}:`, { status: httpStatus, detail });
      const wrapped = new Error(detail?.description || detail?.message || error.message);
      wrapped.freshserviceDetail = detail;
      wrapped.freshserviceStatus = httpStatus;
      throw wrapped;
    }
  }

  async getTicket(ticketId) {
    try {
      const response = await this._get(`/tickets/${ticketId}?include=stats`);
      return response.data.ticket;
    } catch (error) {
      logger.error(`Error fetching ticket ${ticketId}:`, error);
      throw error;
    }
  }

  async getGroup(groupId) {
    try {
      const response = await this._get(`/groups/${groupId}`);
      return response.data.group;
    } catch (error) {
      logger.error(`Error fetching group ${groupId}:`, error);
      return null;
    }
  }

  /**
   * List all FreshService groups in a workspace. Returns the full set
   * (paginated 100/page). Used by the assignment config UI to populate the
   * "exclude from auto-assign" picker.
   *
   * Response shape note: FreshService returns group members under `members`
   * (an array of agent IDs), plus separate `observers` and `leaders` arrays.
   * This differs from Freshdesk's `agent_ids` naming; callers should read
   * `members` for the list of regular agents in the group.
   *
   * @param {object}  [filters]
   * @param {number}  [filters.workspace_id]
   * @returns {Promise<Array<{id:number,name:string,description?:string,members?:number[],observers?:number[],leaders?:number[]}>>}
   */
  async listGroups(filters = {}) {
    try {
      const params = {};
      if (filters.workspace_id) {
        params.workspace_id = filters.workspace_id;
      }
      const groups = await this.fetchAllPages('/groups', params);
      return groups;
    } catch (error) {
      logger.error('Error listing groups:', error);
      throw error;
    }
  }

  async closeTicket(ticketId, status = 4) {
    try {
      const response = await this._put(`/tickets/${ticketId}`, { ticket: { status } });
      return response.data.ticket;
    } catch (error) {
      const httpStatus = error.response?.status || error.statusCode;
      if (httpStatus === 400 || httpStatus === 422) {
        logger.warn(`Ticket ${ticketId} close requires additional fields, retrying with defaults`);
        try {
          const response = await this._put(`/tickets/${ticketId}`, {
            ticket: { status, category: 'Other' },
          });
          return response.data.ticket;
        } catch (retryError) {
          logger.error(`Error closing ticket ${ticketId} (retry with defaults):`, retryError);
          throw retryError;
        }
      }
      if (httpStatus === 404 || httpStatus === 405) {
        logger.info(`Ticket ${ticketId} is deleted or in terminal state (${httpStatus}), skipping close`);
        return { id: ticketId, status, alreadyClosed: true };
      }
      logger.error(`Error closing ticket ${ticketId}:`, error);
      throw error;
    }
  }

  async addPrivateNote(ticketId, body) {
    try {
      const response = await this._post(`/tickets/${ticketId}/notes`, {
        body,
        private: true,
      });
      return response.data;
    } catch (error) {
      const httpStatus = error.response?.status || error.statusCode;
      if (httpStatus === 404 || httpStatus === 405) {
        logger.info(`Ticket ${ticketId} is deleted or in terminal state, skipping note`);
        return { ticketId, skipped: true, reason: 'ticket_deleted_or_terminal' };
      }
      logger.error(`Error adding note to ticket ${ticketId}:`, error);
      throw error;
    }
  }

  /**
   * Get current rate limiter stats (for diagnostics).
   */
  getLimiterStats() {
    return this.limiter.getStats();
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Factory function to create FreshService client
 * @param {string} domain - FreshService domain
 * @param {string} apiKey - FreshService API key
 * @param {Object} [options] - Rate-limit queue options
 * @returns {FreshServiceClient} FreshService client instance
 */
export function createFreshServiceClient(domain, apiKey, options = {}) {
  return new FreshServiceClient(domain, apiKey, options);
}

export default FreshServiceClient;
