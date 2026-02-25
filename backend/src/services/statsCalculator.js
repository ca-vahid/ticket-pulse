/**
 * Centralized Statistics Calculator Service
 *
 * This service provides a single source of truth for all ticket statistics calculations
 * across daily, weekly, and technician-specific views. This ensures consistency and
 * prevents discrepancies between different endpoints.
 */

import { getTodayRange, formatDateInTimezone } from '../utils/timezone.js';
import { getLoadLevel } from '../config/constants.js';

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
      ['Open', 'Pending'].includes(ticket.status),
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
      ['Open', 'Pending'].includes(ticket.status),
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
    ticket.isSelfPicked || ticket.assignedBy === tech.name,
  ).length;

  // Assigned tickets today (not self-picked and not assigned by themselves)
  const assignedTicketsToday = ticketsToday.filter(ticket =>
    !ticket.isSelfPicked && ticket.assignedBy !== tech.name,
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

  // CSAT statistics for the date range
  const csatTickets = tech.tickets.filter(ticket =>
    ticket.csatScore !== null &&
    ticket.csatSubmittedAt &&
    new Date(ticket.csatSubmittedAt) >= rangeStart &&
    new Date(ticket.csatSubmittedAt) <= rangeEnd,
  );

  const csatCount = csatTickets.length;
  const csatAverage = csatCount > 0
    ? csatTickets.reduce((sum, t) => sum + (t.csatScore || 0), 0) / csatCount
    : null;

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
    ticketsToday, // Tickets assigned on the selected date (for daily view filtering)
    csatCount,
    csatAverage,
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
    ['Open', 'Pending'].includes(ticket.status),
  );

  const openOnlyCount = openTickets.filter(t => t.status === 'Open').length;
  const pendingCount = openTickets.filter(t => t.status === 'Pending').length;

  // Build timezone-aware week boundaries (Monday 00:00:00 to Sunday 23:59:59.999)
  const weekStartRange = getTodayRange(timezone, weekStart);
  const weekEndRange = getTodayRange(timezone, weekEnd);
  const tzWeekStart = weekStartRange.start; // Monday 00:00:00 in target timezone
  const tzWeekEnd = weekEndRange.end;       // Sunday 23:59:59.999 in target timezone

  // Tickets assigned during the week (timezone-aware, consistent with dailyBreakdown)
  const weeklyTickets = tech.tickets.filter(ticket => {
    const assignDate = ticket.firstAssignedAt
      ? new Date(ticket.firstAssignedAt)
      : new Date(ticket.createdAt);
    return assignDate >= tzWeekStart && assignDate <= tzWeekEnd;
  });

  // Self-picked tickets created this week
  const weeklySelfPicked = weeklyTickets.filter(ticket =>
    ticket.isSelfPicked || ticket.assignedBy === tech.name,
  ).length;

  // Assigned tickets created this week
  const assignedTicketsThisWeek = weeklyTickets.filter(ticket =>
    !ticket.isSelfPicked && ticket.assignedBy !== tech.name,
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

  // Closed tickets assigned during the week (filter weeklyTickets by status)
  // Note: We filter by assignment date (consistent with daily view), not close date
  // because closedAt/resolvedAt fields may be null
  const weeklyClosed = weeklyTickets.filter(ticket =>
    ['Resolved', 'Closed'].includes(ticket.status),
  ).length;

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
    date.setHours(12, 0, 0, 0);

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
      ticket.isSelfPicked || ticket.assignedBy === tech.name,
    ).length;

    const dayAssigned = dayTickets.filter(ticket =>
      !ticket.isSelfPicked && ticket.assignedBy !== tech.name,
    ).length;

    // Count tickets assigned on this day that are now closed
    // Note: Filter by assignment date + status (not close date) because closedAt may be null
    const dayClosed = dayTickets.filter(ticket =>
      ['Resolved', 'Closed'].includes(ticket.status),
    ).length;

    // CSAT for this day
    const dayCSAT = tech.tickets.filter(ticket =>
      ticket.csatScore !== null &&
      ticket.csatSubmittedAt &&
      new Date(ticket.csatSubmittedAt) >= dayStart &&
      new Date(ticket.csatSubmittedAt) <= dayEnd,
    ).length;

    dailyBreakdown.push({
      date: formatDateInTimezone(date, timezone),
      total: dayTickets.length,
      self: daySelf,
      assigned: dayAssigned,
      closed: dayClosed,
      csatCount: dayCSAT,
    });
  }

  // CSAT statistics for the week
  const weeklyCSATTickets = tech.tickets.filter(ticket =>
    ticket.csatScore !== null &&
    ticket.csatSubmittedAt &&
    new Date(ticket.csatSubmittedAt) >= weekStart &&
    new Date(ticket.csatSubmittedAt) <= weekEnd,
  );

  const weeklyCSATCount = weeklyCSATTickets.length;
  const weeklyCSATAverage = weeklyCSATCount > 0
    ? weeklyCSATTickets.reduce((sum, t) => sum + (t.csatScore || 0), 0) / weeklyCSATCount
    : null;

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

    // CSAT statistics
    weeklyCSATCount,
    weeklyCSATAverage,
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
    ['Open', 'Pending'].includes(ticket.status),
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
    ['Resolved', 'Closed'].includes(ticket.status),
  );

  // Self-picked tickets assigned on the selected date (open + closed)
  const selfPickedTicketsToday = ticketsOnDate.filter(ticket =>
    ticket.isSelfPicked || ticket.assignedBy === technician.name,
  );

  // Assigned tickets (by coordinator) on the selected date (open + closed)
  const assignedTicketsToday = ticketsOnDate.filter(ticket =>
    !ticket.isSelfPicked && ticket.assignedBy !== technician.name,
  );

  // Currently open tickets separated by type
  const selfPickedOpenTickets = openTickets.filter(ticket =>
    ticket.isSelfPicked || ticket.assignedBy === technician.name,
  );

  const assignedOpenTickets = openTickets.filter(ticket =>
    !ticket.isSelfPicked && ticket.assignedBy !== technician.name,
  );

  return {
    // Basic info
    id: technician.id,
    name: technician.name,
    email: technician.email,
    photoUrl: technician.photoUrl,
    timezone: technician.timezone,
    workStartTime: technician.workStartTime || null,
    workEndTime: technician.workEndTime || null,
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

/**
 * Calculate monthly dashboard statistics with daily breakdown
 * @param {Array} technicians - Array of technicians with tickets
 * @param {Date} monthStartDate - First day of the month (Date object)
 * @param {Date} monthEndDate - Last day of the month (Date object)
 * @param {string} timezone - Timezone identifier (e.g. America/Los_Angeles)
 * @returns {Object} Monthly dashboard data with daily breakdown & aggregates
 */
export function calculateMonthlyDashboard(technicians, monthStartDate, monthEndDate, timezone) {
  const daysInMonth = new Date(monthStartDate.getFullYear(), monthStartDate.getMonth() + 1, 0).getDate();

  const monthStartString = formatDateInTimezone(monthStartDate, timezone);
  const monthEndString = formatDateInTimezone(monthEndDate, timezone);

  const dailyBreakdown = [];

  let monthTotal = 0;
  let monthSelfPicked = 0;
  let monthAssigned = 0;
  let monthClosed = 0;
  let monthCSAT = 0;

  for (let dayOffset = 0; dayOffset < daysInMonth; dayOffset += 1) {
    const currentDate = new Date(monthStartDate);
    currentDate.setDate(monthStartDate.getDate() + dayOffset);
    currentDate.setHours(12, 0, 0, 0);

    const { start: dayStart, end: dayEnd } = getTodayRange(timezone, currentDate);

    let dayTotal = 0;
    let daySelf = 0;
    let dayAssigned = 0;
    let dayClosed = 0;
    let dayCSAT = 0;

    const techniciansForDay = [];

    technicians.forEach((tech) => {
      const stats = calculateTechnicianDailyStats(tech, dayStart, dayEnd, false);

      if (stats.totalTicketsToday > 0) {
        techniciansForDay.push({
          technicianId: tech.id,
          technicianName: tech.name,
          total: stats.totalTicketsToday,
          selfPicked: stats.selfPickedToday,
          assigned: stats.assignedToday,
          closed: stats.closedToday,
          csatCount: stats.csatCount || 0,
        });
      }

      dayTotal += stats.totalTicketsToday;
      daySelf += stats.selfPickedToday;
      dayAssigned += stats.assignedToday;
      dayClosed += stats.closedToday;
      dayCSAT += stats.csatCount || 0;
    });

    monthTotal += dayTotal;
    monthSelfPicked += daySelf;
    monthAssigned += dayAssigned;
    monthClosed += dayClosed;
    monthCSAT += dayCSAT;

    dailyBreakdown.push({
      date: formatDateInTimezone(dayStart, timezone),
      dayOfMonth: dayOffset + 1,
      dayOfWeek: dayStart.getDay(),
      total: dayTotal,
      selfPicked: daySelf,
      assigned: dayAssigned,
      closed: dayClosed,
      csatCount: dayCSAT,
      technicians: techniciansForDay,
    });
  }

  const statistics = {
    monthTotal,
    monthSelfPicked,
    monthAssigned,
    monthClosed,
    monthCSAT,
  };

  return {
    monthStart: monthStartString,
    monthEnd: monthEndString,
    daysInMonth,
    statistics,
    dailyBreakdown,
  };
}

export default {
  calculateTechnicianDailyStats,
  calculateTechnicianWeeklyStats,
  calculateDailyDashboard,
  calculateWeeklyDashboard,
  calculateTechnicianDetail,
  calculateMonthlyDashboard,
};
