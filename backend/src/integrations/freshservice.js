import axios from 'axios';
import logger from '../utils/logger.js';
import { ExternalAPIError } from '../utils/errors.js';

/**
 * FreshService API Client
 * Handles all interactions with the FreshService API
 */
class FreshServiceClient {
  constructor(domain, apiKey) {
    if (!domain || !apiKey) {
      throw new Error('FreshService domain and API key are required');
    }

    this.domain = domain;
    this.apiKey = apiKey;
    // Handle both full domain (efusion.freshservice.com) and subdomain (efusion)
    const fullDomain = domain.includes('.freshservice.com') ? domain : `${domain}.freshservice.com`;
    this.baseURL = `https://${fullDomain}/api/v2`;

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

    // Add response interceptor for error handling
    // NOTE: Don't wrap 429 errors so retry logic can handle them
    this.client.interceptors.response.use(
      response => response,
      error => {
        const status = error.response?.status;

        // Let 429 errors pass through unwrapped for retry logic
        if (status === 429) {
          throw error;
        }

        // Log and wrap all other errors
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
   * Fetch all pages of a paginated API endpoint
   * @param {string} endpoint - API endpoint
   * @param {Object} params - Query parameters
   * @param {Function} onProgress - Optional callback for progress updates (page, itemCount)
   * @returns {Promise<Array>} Combined results from all pages
   */
  async fetchAllPages(endpoint, params = {}, onProgress = null) {
    const allResults = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await this._fetchWithRetry(endpoint, {
          params: {
            ...params,
            page,
            per_page: 100, // Maximum allowed by FreshService
          },
        });

        const data = response.data;
        const results = this._extractResults(data, endpoint);

        if (results && results.length > 0) {
          allResults.push(...results);
          page++;

          // Log progress every 10 pages to show sync progress
          if (page % 10 === 0) {
            logger.info(`Fetching ${endpoint}: ${allResults.length} items so far (page ${page})...`);

            // Call progress callback if provided
            if (onProgress) {
              onProgress(page, allResults.length);
            }
          }

          // Check if there are more pages
          // FreshService returns fewer results when we're on the last page
          if (results.length < 100) {
            hasMore = false;
          }
        } else {
          hasMore = false;
        }

        // Rate limiting: 1 second delay between requests (5000 req/hour limit)
        await this._sleep(1000);
      } catch (error) {
        logger.error(`Error fetching page ${page} of ${endpoint}:`, error);
        throw error;
      }
    }

    logger.info(`Fetched ${allResults.length} items from ${endpoint}`);
    return allResults;
  }

  /**
   * Fetch with retry logic for rate limiting (429 errors)
   * @param {string} endpoint - API endpoint
   * @param {Object} config - Axios request config
   * @param {number} maxRetries - Maximum number of retries
   * @returns {Promise<Object>} API response
   */
  async _fetchWithRetry(endpoint, config = {}, maxRetries = 3) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.client.get(endpoint, config);
      } catch (error) {
        lastError = error;
        const status = error.response?.status;

        // Only retry on 429 (rate limit) errors
        if (status === 429 && attempt < maxRetries) {
          // Exponential backoff: 5s, 10s, 20s
          const delayMs = 5000 * Math.pow(2, attempt - 1);
          logger.warn(
            `Rate limit hit (429) on ${endpoint} page ${config.params?.page || 1}. ` +
            `Retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxRetries})...`,
          );
          await this._sleep(delayMs);
          continue;
        }

        // Don't retry other errors or if max retries reached
        throw error;
      }
    }

    // If we get here, all retries failed
    throw lastError;
  }

  /**
   * Extract results from API response based on endpoint
   * @param {Object} data - Response data
   * @param {string} endpoint - API endpoint
   * @returns {Array} Extracted results
   */
  _extractResults(data, endpoint) {
    if (endpoint.includes('/tickets')) return data.tickets || [];
    if (endpoint.includes('/agents')) return data.agents || [];
    if (endpoint.includes('/requesters')) return data.requesters || [];
    if (endpoint.includes('/activities')) return data.activities || [];
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
      const response = await this.client.get(`/tickets/${ticketId}`);
      return response.data.ticket;
    } catch (error) {
      logger.error(`Error fetching ticket ${ticketId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch CSAT (Customer Satisfaction) response for a ticket
   * @param {number} ticketId - Ticket ID
   * @returns {Promise<Object|null>} CSAT response object or null if no response
   */
  async fetchCSATResponse(ticketId) {
    try {
      // Use retry logic to handle rate limiting (429 errors)
      const response = await this._fetchWithRetry(`/tickets/${ticketId}/csat_response`, {}, 3);
      return response.data.csat_response || null;
    } catch (error) {
      // 404 means no CSAT response exists for this ticket - this is normal
      if (error.response?.status === 404) {
        return null;
      }
      logger.error(`Error fetching CSAT for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch ticket activities (conversations, notes, etc.)
   * @param {number} ticketId - Ticket ID
   * @returns {Promise<Array>} Array of activities
   */
  async fetchTicketActivities(ticketId) {
    try {
      // Use retry logic to handle rate limiting (429 errors)
      const response = await this._fetchWithRetry(`/tickets/${ticketId}/activities`, {}, 3);
      return response.data.activities || [];
    } catch (error) {
      logger.error(`Error fetching activities for ticket ${ticketId}:`, error);
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
      const response = await this.client.get(`/agents/${agentId}`);
      return response.data.agent;
    } catch (error) {
      logger.error(`Error fetching agent ${agentId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch requester by ID
   * @param {number} requesterId - Requester ID
   * @returns {Promise<Object>} Requester object
   */
  async fetchRequester(requesterId) {
    try {
      const response = await this.client.get(`/requesters/${requesterId}`);
      return response.data.requester;
    } catch (error) {
      logger.error(`Error fetching requester ${requesterId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch multiple requesters by IDs with rate limiting
   * @param {Array<number>} requesterIds - Array of requester IDs
   * @returns {Promise<Array>} Array of requester objects
   */
  async fetchAllRequesters(requesterIds) {
    try {
      logger.info(`Fetching ${requesterIds.length} requesters from FreshService`);
      const requesters = [];
      const failed = [];

      for (const id of requesterIds) {
        try {
          // Rate limiting: 1.1 second delay between requests (well under 5000/hour limit)
          await this._sleep(1100);
          const requester = await this.fetchRequester(id);
          requesters.push(requester);

          // Log progress every 50 requesters
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

  /**
   * Test API connection
   * @returns {Promise<boolean>} True if connection successful
   */
  async testConnection() {
    try {
      logger.info('Testing FreshService API connection');
      await this.client.get('/agents', { params: { per_page: 1 } });
      logger.info('FreshService API connection successful');
      return true;
    } catch (error) {
      logger.error('FreshService API connection failed:', error);
      return false;
    }
  }

  /**
   * Get API rate limit information
   * @returns {Promise<Object>} Rate limit info
   */
  async getRateLimitInfo() {
    try {
      const response = await this.client.get('/agents', { params: { per_page: 1 } });

      return {
        limit: response.headers['x-ratelimit-total'],
        remaining: response.headers['x-ratelimit-remaining'],
        usedToday: response.headers['x-ratelimit-used-currentrequest'],
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
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Factory function to create FreshService client
 * @param {string} domain - FreshService domain
 * @param {string} apiKey - FreshService API key
 * @returns {FreshServiceClient} FreshService client instance
 */
export function createFreshServiceClient(domain, apiKey) {
  return new FreshServiceClient(domain, apiKey);
}

export default FreshServiceClient;
