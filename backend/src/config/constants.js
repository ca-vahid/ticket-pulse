// Workload thresholds for color coding
export const LOAD_LEVELS = {
  LIGHT: {
    name: 'light',
    maxTickets: 4,
    color: '#10b981', // green-500
  },
  MEDIUM: {
    name: 'medium',
    maxTickets: 6,
    color: '#f59e0b', // amber-500
  },
  HEAVY: {
    name: 'heavy',
    maxTickets: Infinity,
    color: '#ef4444', // red-500
  },
};

// Ticket statuses
export const TICKET_STATUS = {
  OPEN: 'open',
  PENDING: 'pending',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
  IN_PROGRESS: 'in_progress',
};

// Priority levels (matches FreshService)
export const PRIORITY = {
  URGENT: 1,
  HIGH: 2,
  MEDIUM: 3,
  LOW: 4,
};

// Priority labels for display
export const PRIORITY_LABELS = {
  1: 'P1',
  2: 'P2',
  3: 'P3',
  4: 'P4',
};

// Ticket activity types
export const ACTIVITY_TYPE = {
  ASSIGNED: 'assigned',
  STATUS_CHANGED: 'status_changed',
  RESOLVED: 'resolved',
  PICKED: 'picked',
  REASSIGNED: 'reassigned',
};

// Sync types
export const SYNC_TYPE = {
  TICKETS: 'tickets',
  TECHNICIANS: 'technicians',
};

// Sync status
export const SYNC_STATUS = {
  SUCCESS: 'success',
  ERROR: 'error',
  PARTIAL: 'partial',
};

// Timezone mappings for different office locations
export const TIMEZONE_MAP = {
  Halifax: 'America/Halifax',
  Toronto: 'America/Toronto',
  Vancouver: 'America/Vancouver',
  'Los Angeles': 'America/Los_Angeles',
  'San Francisco': 'America/Los_Angeles',
  Default: 'America/Los_Angeles',
};

// API rate limits
export const RATE_LIMITS = {
  FRESHSERVICE_HOURLY: 5000, // FreshService Enterprise plan
  DASHBOARD_PER_MINUTE: 60, // Our API rate limit per user
};

/**
 * Get load level based on open ticket count
 */
export function getLoadLevel(openTicketCount) {
  if (openTicketCount <= LOAD_LEVELS.LIGHT.maxTickets) {
    return LOAD_LEVELS.LIGHT.name;
  }
  if (openTicketCount <= LOAD_LEVELS.MEDIUM.maxTickets) {
    return LOAD_LEVELS.MEDIUM.name;
  }
  return LOAD_LEVELS.HEAVY.name;
}

/**
 * Get timezone from location string
 */
export function getTimezoneFromLocation(location) {
  if (!location) return TIMEZONE_MAP.Default;
  return TIMEZONE_MAP[location] || TIMEZONE_MAP.Default;
}

/**
 * Check if ticket is "open" (open or in_progress)
 */
export function isTicketOpen(status) {
  return status === TICKET_STATUS.OPEN || status === TICKET_STATUS.IN_PROGRESS;
}
