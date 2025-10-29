/**
 * Centralized Statistics Calculator Service
 *
 * This service provides a single source of truth for all ticket statistics calculations
 * across daily, weekly, and technician-specific views. This ensures consistency and
 * prevents discrepancies between different endpoints.
 */

import { getTodayRange } from '../utils/timezone.js';
import { getLoadLevel } from '../config/constants.js';
import logger from '../utils/logger.js';

/**
 * Calculate statistics for a single technician for a given date range
 * @param {Object} technician - Technician object with tickets array
 * @param {Date} rangeStart - Start of date range
 * @param {Date} rangeEnd - End of date range
 * @param {boolean} isViewingToday - Whether we're viewing current day
 * @returns {Object} Calculated statistics for the technician
 */
export function calculateTechnicianDailyStats(technician, rangeStart, rangeEnd, isViewingToday = true) {
  const tech = technician;

  // Calculate open tickets based on viewing mode
  let openTickets;

  if (isViewingToday) {
    // All currently open tickets
    openTickets = tech.tickets.filter(ticket =>
      ['Open', 'Pending'].includes(ticket.status)
    );
  } else {
    // Historical approximation: tickets assigned before/on date that are still open
    // PLUS tickets assigned on date that are now closed
    const ticketsAssignedBeforeOrOnDate = tech.tickets.filter(ticket => {
      const assignDate = ticket.firstAssignedAt
        ? new Date(ticket.firstAssignedAt)
        : new Date(ticket.createdAt);
      return assignDate <= rangeEnd;
    });

    const stillOpen = ticketsAssignedBeforeOrOnDate.filter(ticket =>
      ['Open', 'Pending'].includes(ticket.status)
    );

    const assignedOnDateNowClosed = tech.tickets.filter(ticket => {
      const assignDate = ticket.firstAssignedAt
        ? new Date(ticket.firstAssignedAt)
        : new Date(ticket.createdAt);
      const isAssignedOnDate = assignDate >= rangeStart && assignDate <= rangeEnd;
      const isClosed = ['Closed', 'Resolved'].includes(ticket.status);
      return isAssignedOnDate && isClosed;
    });

    openTickets = [...stillOpen, ...assignedOnDateNowClosed];
  }

  // Tickets assigned on the selected date
  // Use firstAssignedAt if available, otherwise fall back to createdAt
  const ticketsToday = tech.tickets.filter(ticket => {
    const assignDate = ticket.firstAssignedAt
      ? new Date(ticket.firstAssignedAt)
      : new Date(ticket.createdAt);
    return assignDate >= rangeStart && assignDate <= rangeEnd;
  });

  // Self-picked tickets today
  // IMPORTANT: Also treat tickets as self-picked if assignedBy equals the technician's name
  const selfPickedToday = ticketsToday.filter(ticket =>
    ticket.isSelfPicked || ticket.assignedBy === tech.name
  ).length;

  // Assigned tickets today (not self-picked and not assigned by themselves)
  const assignedTicketsToday = ticketsToday.filter(ticket =>
    !ticket.isSelfPicked && ticket.assignedBy !== tech.name
  );
  const assignedToday = assignedTicketsToday.length;

  // Get list of coordinators who assigned tickets (with counts)
  const assignerCounts = {};
  assignedTicketsToday.forEach(ticket => {
    if (ticket.assignedBy && ticket.assignedBy !== tech.name) {
      assignerCounts[ticket.assignedBy] = (assignerCounts[ticket.assignedBy] || 0) + 1;
    }
  });

  const assigners = Object.entries(assignerCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // Closed tickets assigned on the selected date
  const closedToday = tech.tickets.filter(ticket => {
    const assignDate = ticket.firstAssignedAt
      ? new Date(ticket.firstAssignedAt)
      : new Date(ticket.createdAt);
    return ['Resolved', 'Closed'].includes(ticket.status) &&
           assignDate >= rangeStart &&
           assignDate <= rangeEnd;
  }).length;

  // Breakdown of open tickets by status
  const openOnlyCount = openTickets.filter(t => t.status === 'Open').length;
  const pendingCount = openTickets.filter(t => t.status === 'Pending').length;

  // Load level based on current open tickets
  const loadLevel = isViewingToday ? getLoadLevel(openTickets.length) : 'light';

  return {
    openTicketCount: openTickets.length,
    openOnlyCount,
    pendingCount,
    totalTicketsToday: ticketsToday.length,
    selfPickedToday,
    assignedToday,
    assigners,
    closedToday,
    loadLevel,
    openTickets,
  };
}

/**
 * Calculate weekly aggregated statistics for a single technician
 * @param {Object} technician - Technician object with tickets array
 * @param {Date} weekStart - Monday of the week
 * @param {Date} weekEnd - Sunday of the week
 * @param {string} timezone - Timezone for date calculations
 * @returns {Object} Weekly statistics for the technician
 */
export function calculateTechnicianWeeklyStats(technician, weekStart, weekEnd, timezone) {
  const tech = technician;

  // Current open tickets (snapshot, not time-bound)
  const openTickets = tech.tickets.filter(ticket =>
    ['Open', 'Pending'].includes(ticket.status)
  );

  const openOnlyCount = openTickets.filter(t => t.status === 'Open').length;
  const pendingCount = openTickets.filter(t => t.status === 'Pending').length;

  // Tickets assigned during the week
  // Use firstAssignedAt if available, otherwise fall back to createdAt
  const weeklyTickets = tech.tickets.filter(ticket => {
    const assignDate = ticket.firstAssignedAt
      ? new Date(ticket.firstAssignedAt)
      : new Date(ticket.createdAt);
    return assignDate >= weekStart && assignDate <= weekEnd;
  });

  // Self-picked tickets created this week
  const weeklySelfPicked = weeklyTickets.filter(ticket =>
    ticket.isSelfPicked || ticket.assignedBy === tech.name
  ).length;

  // Assigned tickets created this week
  const assignedTicketsThisWeek = weeklyTickets.filter(ticket =>
    !ticket.isSelfPicked && ticket.assignedBy !== tech.name
  );
  const weeklyAssigned = assignedTicketsThisWeek.length;

  // Get list of coordinators who assigned tickets this week (with counts)
  const assignerCounts = {};
  assignedTicketsThisWeek.forEach(ticket => {
    if (ticket.assignedBy && ticket.assignedBy !== tech.name) {
      assignerCounts[ticket.assignedBy] = (assignerCounts[ticket.assignedBy] || 0) + 1;
    }
  });

  const assigners = Object.entries(assignerCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // Closed tickets during the week (based on when they were actually closed)
  const weeklyClosed = tech.tickets.filter(ticket => {
    const closeDate = ticket.closedAt || ticket.resolvedAt;
    if (!closeDate) return false;
    const closeDateObj = new Date(closeDate);
    return closeDateObj >= weekStart && closeDateObj <= weekEnd;
  }).length;

  // Weekly totals
  const weeklyTotalCreated = weeklyTickets.length;
  const weeklyNewTickets = weeklyTotalCreated;
  const weeklyNetChange = weeklyNewTickets - weeklyClosed;

  // Daily averages (over 7 days)
  const avgTicketsPerDay = parseFloat((weeklyTotalCreated / 7).toFixed(1));
  const avgSelfPickedPerDay = parseFloat((weeklySelfPicked / 7).toFixed(1));
  const avgClosedPerDay = parseFloat((weeklyClosed / 7).toFixed(1));

  // Daily breakdown
  const dailyBreakdown = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + i);

    const result = getTodayRange(timezone, date);
    const dayStart = result.start;
    const dayEnd = result.end;

    const dayTickets = tech.tickets.filter(ticket => {
      const assignDate = ticket.firstAssignedAt
        ? new Date(ticket.firstAssignedAt)
        : new Date(ticket.createdAt);
      return assignDate >= dayStart && assignDate <= dayEnd;
    });

    const daySelf = dayTickets.filter(ticket =>
      ticket.isSelfPicked || ticket.assignedBy === tech.name
    ).length;

    const dayAssigned = dayTickets.filter(ticket =>
      !ticket.isSelfPicked && ticket.assignedBy !== tech.name
    ).length;

    // Count tickets closed on this specific day
    const dayClosed = tech.tickets.filter(ticket => {
      const closeDate = ticket.closedAt || ticket.resolvedAt;
      if (!closeDate) return false;
      const closeDateObj = new Date(closeDate);
      return closeDateObj >= dayStart && closeDateObj <= dayEnd;
    }).length;

    dailyBreakdown.push({
      date: date.toISOString().split('T')[0],
      total: dayTickets.length,
      self: daySelf,
      assigned: dayAssigned,
      closed: dayClosed,
    });
  }

  return {
    // Current snapshot
    openTicketCount: openTickets.length,
    openOnlyCount,
    pendingCount,

    // Weekly totals
    weeklyTotalCreated,
    weeklySelfPicked,
    weeklyAssigned,
    weeklyClosed,
    assigners, // Array of { name, count } for coordinators who assigned tickets

    // Weekly trends
    weeklyNewTickets,
    weeklyNetChange,

    // Daily averages
    avgTicketsPerDay,
    avgSelfPickedPerDay,
    avgClosedPerDay,

    // Breakdown
    dailyBreakdown,

    // Weekly tickets array (for filtering/search on frontend)
    weeklyTickets,

    loadLevel: getLoadLevel(openTickets.length),
  };
}

/**
 * Calculate daily dashboard statistics
 * @param {Array} technicians - Array of technicians with tickets
 * @param {Date} dateStart - Start of date range
 * @param {Date} dateEnd - End of date range
 * @param {boolean} isViewingToday - Whether viewing current day
 * @returns {Object} Dashboard data with technician stats and totals
 */
export function calculateDailyDashboard(technicians, dateStart, dateEnd, isViewingToday = true) {
  const techsWithLoad = technicians.map(tech => {
    const stats = calculateTechnicianDailyStats(tech, dateStart, dateEnd, isViewingToday);

    return {
      id: tech.id,
      name: tech.name,
      email: tech.email,
      photoUrl: tech.photoUrl,
      timezone: tech.timezone,
      ...stats,
    };
  });

  // Sort by load level and ticket count
  techsWithLoad.sort((a, b) => {
    const loadOrder = { light: 1, medium: 2, heavy: 3 };
    const loadDiff = loadOrder[a.loadLevel] - loadOrder[b.loadLevel];
    if (loadDiff !== 0) return loadDiff;
    return a.openTicketCount - b.openTicketCount;
  });

  // Calculate aggregate statistics
  const statistics = {
    totalTechnicians: techsWithLoad.length,
    totalTicketsToday: techsWithLoad.reduce((sum, t) => sum + t.totalTicketsToday, 0),
    openTicketsToday: techsWithLoad.reduce((sum, t) => sum + (t.openTicketCount || 0), 0),
    openOnlyCount: techsWithLoad.reduce((sum, t) => sum + (t.openOnlyCount || 0), 0),
    pendingCount: techsWithLoad.reduce((sum, t) => sum + (t.pendingCount || 0), 0),
    closedTicketsToday: techsWithLoad.reduce((sum, t) => sum + t.closedToday, 0),
    selfPickedToday: techsWithLoad.reduce((sum, t) => sum + t.selfPickedToday, 0),
    lightLoad: techsWithLoad.filter(t => t.loadLevel === 'light').length,
    mediumLoad: techsWithLoad.filter(t => t.loadLevel === 'medium').length,
    heavyLoad: techsWithLoad.filter(t => t.loadLevel === 'heavy').length,
  };

  return {
    technicians: techsWithLoad,
    statistics,
  };
}

/**
 * Calculate weekly dashboard statistics
 * @param {Array} technicians - Array of technicians with tickets
 * @param {Date} weekStart - Monday of the week
 * @param {Date} weekEnd - Sunday of the week (end of day)
 * @param {string} timezone - Timezone for calculations
 * @returns {Object} Weekly dashboard data with aggregated stats
 */
export function calculateWeeklyDashboard(technicians, weekStart, weekEnd, timezone) {
  const techsWithWeeklyStats = technicians.map(tech => {
    const stats = calculateTechnicianWeeklyStats(tech, weekStart, weekEnd, timezone);

    return {
      id: tech.id,
      name: tech.name,
      email: tech.email,
      photoUrl: tech.photoUrl,
      timezone: tech.timezone,
      ...stats,
    };
  });

  // Sort by load level and ticket count
  techsWithWeeklyStats.sort((a, b) => {
    const loadOrder = { light: 1, medium: 2, heavy: 3 };
    const loadDiff = loadOrder[a.loadLevel] - loadOrder[b.loadLevel];
    if (loadDiff !== 0) return loadDiff;
    return a.openTicketCount - b.openTicketCount;
  });

  // Calculate aggregate statistics
  const statistics = {
    totalTechnicians: techsWithWeeklyStats.length,
    weeklyTotalCreated: techsWithWeeklyStats.reduce((sum, t) => sum + t.weeklyTotalCreated, 0),
    weeklyOpen: techsWithWeeklyStats.reduce((sum, t) => sum + t.openTicketCount, 0),
    weeklyOpenOnly: techsWithWeeklyStats.reduce((sum, t) => sum + t.openOnlyCount, 0),
    weeklyPending: techsWithWeeklyStats.reduce((sum, t) => sum + t.pendingCount, 0),
    weeklyClosed: techsWithWeeklyStats.reduce((sum, t) => sum + t.weeklyClosed, 0),
    weeklySelfPicked: techsWithWeeklyStats.reduce((sum, t) => sum + t.weeklySelfPicked, 0),
    weeklyAssigned: techsWithWeeklyStats.reduce((sum, t) => sum + t.weeklyAssigned, 0),
    weeklyNetChange: techsWithWeeklyStats.reduce((sum, t) => sum + t.weeklyNetChange, 0),
    avgTicketsPerTech: parseFloat((techsWithWeeklyStats.reduce((sum, t) => sum + t.weeklyTotalCreated, 0) / techsWithWeeklyStats.length).toFixed(1)),
    avgTicketsPerDay: parseFloat((techsWithWeeklyStats.reduce((sum, t) => sum + t.weeklyTotalCreated, 0) / 7).toFixed(1)),
    lightLoad: techsWithWeeklyStats.filter(t => t.loadLevel === 'light').length,
    mediumLoad: techsWithWeeklyStats.filter(t => t.loadLevel === 'medium').length,
    heavyLoad: techsWithWeeklyStats.filter(t => t.loadLevel === 'heavy').length,
  };

  return {
    technicians: techsWithWeeklyStats,
    statistics,
  };
}

/**
 * Calculate detailed technician statistics with categorized ticket lists
 * @param {Object} technician - Technician object with tickets array
 * @param {Date} rangeStart - Start of date range
 * @param {Date} rangeEnd - End of date range
 * @param {boolean} isViewingToday - Whether we're viewing current day
 * @returns {Object} Detailed statistics with categorized ticket lists
 */
export function calculateTechnicianDetail(technician, rangeStart, rangeEnd, isViewingToday = true) {
  // Get basic daily stats
  const stats = calculateTechnicianDailyStats(technician, rangeStart, rangeEnd, isViewingToday);

  // All currently open tickets (regardless of viewing mode)
  const openTickets = technician.tickets.filter(ticket =>
    ['Open', 'Pending'].includes(ticket.status)
  );

  // Tickets assigned on the selected date (use firstAssignedAt)
  const ticketsOnDate = technician.tickets.filter(ticket => {
    const assignDate = ticket.firstAssignedAt
      ? new Date(ticket.firstAssignedAt)
      : new Date(ticket.createdAt);
    return assignDate >= rangeStart && assignDate <= rangeEnd;
  });

  // Closed tickets assigned on the selected date
  const closedTicketsOnDate = ticketsOnDate.filter(ticket =>
    ['Resolved', 'Closed'].includes(ticket.status)
  );

  // Self-picked tickets assigned on the selected date (open + closed)
  const selfPickedTicketsToday = ticketsOnDate.filter(ticket =>
    ticket.isSelfPicked || ticket.assignedBy === technician.name
  );

  // Assigned tickets (by coordinator) on the selected date (open + closed)
  const assignedTicketsToday = ticketsOnDate.filter(ticket =>
    !ticket.isSelfPicked && ticket.assignedBy !== technician.name
  );

  // Currently open tickets separated by type
  const selfPickedOpenTickets = openTickets.filter(ticket =>
    ticket.isSelfPicked || ticket.assignedBy === technician.name
  );

  const assignedOpenTickets = openTickets.filter(ticket =>
    !ticket.isSelfPicked && ticket.assignedBy !== technician.name
  );

  return {
    // Basic info
    id: technician.id,
    name: technician.name,
    email: technician.email,
    photoUrl: technician.photoUrl,
    timezone: technician.timezone,
    isActive: technician.isActive,

    // Counts from daily stats
    openTicketCount: stats.openTicketCount,
    totalTicketsOnDate: ticketsOnDate.length,
    closedTicketsOnDateCount: closedTicketsOnDate.length,
    selfPickedOnDate: stats.selfPickedToday,
    assignedOnDate: stats.assignedToday,
    loadLevel: stats.loadLevel,

    // Categorized ticket lists
    openTickets,
    ticketsOnDate,
    closedTicketsOnDate,
    selfPickedTickets: selfPickedTicketsToday,
    assignedTickets: assignedTicketsToday,
    selfPickedOpenTickets,
    assignedOpenTickets,
  };
}

export default {
  calculateTechnicianDailyStats,
  calculateTechnicianWeeklyStats,
  calculateDailyDashboard,
  calculateWeeklyDashboard,
  calculateTechnicianDetail,
};
