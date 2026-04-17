import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import technicianRepository from '../services/technicianRepository.js';
import ticketRepository from '../services/ticketRepository.js';
import prisma from '../services/prisma.js';
import { getTodayRange, formatDateInTimezone } from '../utils/timezone.js';
import logger from '../utils/logger.js';
import { calculateWeeklyDashboard, calculateDailyDashboard, calculateTechnicianDetail, calculateTechnicianWeeklyStats, calculateTechnicianMonthlyStats, calculateMonthlyDashboard } from '../services/statsCalculator.js';
import { readCache } from '../services/dashboardReadCache.js';
import { computeDashboardAvoidance, computeWeeklyDashboardAvoidance, computeTechnicianAvoidanceDetail, computeTechnicianAvoidanceWeeklyDetail, computeTechnicianAvoidanceMonthlyDetail } from '../services/avoidanceAnalysisService.js';
import vtService from '../services/vacationTrackerService.js';
import settingsRepository from '../services/settingsRepository.js';

const router = express.Router();

// Protect all dashboard routes with authentication
router.use(requireAuth);

/**
 * Compute per-tech rejection counts (7d, 30d, lifetime) for a workspace.
 * Returns an object: { rej7d: { techId: count }, rej30d: ..., rejLifetime: ... }
 */
async function getRejectionCounts(workspaceId) {
  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 7);
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(now.getDate() - 30);

  try {
    const [r7, r30, rAll] = await Promise.all([
      prisma.ticketAssignmentEpisode.groupBy({
        by: ['technicianId'],
        where: { workspaceId, endMethod: 'rejected', endedAt: { gte: sevenDaysAgo } },
        _count: true,
      }),
      prisma.ticketAssignmentEpisode.groupBy({
        by: ['technicianId'],
        where: { workspaceId, endMethod: 'rejected', endedAt: { gte: thirtyDaysAgo } },
        _count: true,
      }),
      prisma.ticketAssignmentEpisode.groupBy({
        by: ['technicianId'],
        where: { workspaceId, endMethod: 'rejected' },
        _count: true,
      }),
    ]);
    return {
      rej7d: Object.fromEntries(r7.map((r) => [r.technicianId, r._count])),
      rej30d: Object.fromEntries(r30.map((r) => [r.technicianId, r._count])),
      rejLifetime: Object.fromEntries(rAll.map((r) => [r.technicianId, r._count])),
    };
  } catch {
    return { rej7d: {}, rej30d: {}, rejLifetime: {} };
  }
}

/**
 * Transform ticket to flatten requester object for frontend
 * Frontend expects requesterName and requesterEmail as flat fields
 * @param {Object} ticket - Ticket with nested requester object
 * @returns {Object} Ticket with flattened requester fields
 */
const transformTicket = (ticket) => {
  if (!ticket) return ticket;

  const transformed = {
    ...ticket,
    requesterName: ticket.requester?.name || null,
    requesterEmail: ticket.requester?.email || null,
  };

  // Remove the nested requester object to avoid confusion
  delete transformed.requester;

  return transformed;
};

/**
 * GET /api/dashboard
 * Get complete dashboard data
 */
router.get(
  '/',
  readCache(10_000),
  asyncHandler(async (req, res) => {
    const timezone = req.query.timezone || 'America/Los_Angeles';
    const dateParam = req.query.date; // Format: YYYY-MM-DD
    const excludeNoise = req.query.excludeNoise === 'true';
    const isViewingToday = !dateParam; // Determine if we're viewing today vs historical date

    logger.debug(`Fetching dashboard data for timezone: ${timezone}, date: ${dateParam || 'today'}, excludeNoise: ${excludeNoise}`);

    // Get date range for filtering
    let todayStart, todayEnd;
    if (dateParam) {
      const [year, month, day] = dateParam.split('-').map(Number);
      const selectedDate = new Date(year, month - 1, day, 12, 0, 0);
      const result = getTodayRange(timezone, selectedDate);
      todayStart = result.start;
      todayEnd = result.end;
    } else {
      const result = getTodayRange(timezone);
      todayStart = result.start;
      todayEnd = result.end;
    }

    // Fetch active technicians and service account names in parallel
    const [technicians, serviceAccountNames] = await Promise.all([
      technicianRepository.getAllActiveScoped(todayStart, todayEnd, { excludeNoise, workspaceId: req.workspaceId }),
      settingsRepository.getServiceAccountNames(),
    ]);

    // Compute the date string for leave lookup
    const dashDateStr = dateParam || formatDateInTimezone(null, timezone);

    // Run stats calculation (sync), avoidance analysis, and leave info in parallel
    const [dashboardData, avoidanceMap, leaveInfoMap] = await Promise.all([
      Promise.resolve(calculateDailyDashboard(technicians, todayStart, todayEnd, isViewingToday, serviceAccountNames)),
      computeDashboardAvoidance(technicians, todayStart, todayEnd, req.workspaceId).catch(err => {
        logger.error('Avoidance analysis failed for daily dashboard:', err);
        return {};
      }),
      vtService.getLeaveInfoForDashboard(req.workspaceId, dashDateStr, dashDateStr).catch(err => {
        logger.debug('VT leave info not available:', err.message);
        return {};
      }),
    ]);

    // Fetch per-tech rejection counts across multiple windows (7d, 30d, lifetime)
    const { rej7d, rej30d, rejLifetime } = await getRejectionCounts(req.workspaceId);

    // Transform tickets for frontend (flatten requester object)
    // Use ticketsToday for date-filtered view (tickets assigned on selected date)
    const techsWithTransformedTickets = dashboardData.technicians.map(tech => ({
      ...tech,
      tickets: (tech.ticketsToday || []).map(transformTicket),
      avoidance: avoidanceMap[tech.id] || null,
      leaveInfo: leaveInfoMap[tech.id] || {},
      rejected7d: rej7d[tech.id] || 0,
      rejected30d: rej30d[tech.id] || 0,
      rejectedLifetime: rejLifetime[tech.id] || 0,
    }));

    // Remove intermediate arrays from response (we use tickets instead)
    techsWithTransformedTickets.forEach(tech => {
      delete tech.openTickets;
      delete tech.ticketsToday;
    });

    res.json({
      success: true,
      data: {
        technicians: techsWithTransformedTickets,
        statistics: dashboardData.statistics,
        serviceAccountNames,
        timestamp: new Date().toISOString(),
      },
    });
  }),
);

/**
 * GET /api/dashboard/weekly-stats
 * Get daily ticket counts for a week
 * Query params:
 *   - date: Any date in the week (YYYY-MM-DD)
 *   - timezone: Timezone for date calculations
 */
router.get(
  '/weekly-stats',
  readCache(15_000),
  asyncHandler(async (req, res) => {
    const timezone = req.query.timezone || 'America/Los_Angeles';
    const dateParam = req.query.date || formatDateInTimezone(null, timezone);

    // Calculate Monday of the week
    const [year, month, day] = dateParam.split('-').map(Number);
    const selectedDate = new Date(year, month - 1, day, 12, 0, 0);
    const currentDay = (selectedDate.getDay() + 6) % 7; // Convert to Monday=0
    const monday = new Date(selectedDate);
    monday.setDate(selectedDate.getDate() - currentDay);

    // Calculate week range using timezone-aware boundaries
    const weekStartRange = getTodayRange(timezone, monday);
    const weekStart = weekStartRange.start;
    const fridayDate = new Date(monday);
    fridayDate.setDate(monday.getDate() + 6);
    const weekEndRange = getTodayRange(timezone, fridayDate);
    const weekEnd = weekEndRange.end;

    logger.debug(`Fetching weekly stats: ${weekStart.toISOString()} to ${weekEnd.toISOString()}`);

    const excludeNoise = req.query.excludeNoise === 'true';

    // Fetch all tickets in the week range (by either createdAt or firstAssignedAt)
    // This matches the statsCalculator logic exactly
    const weeklyTicketWhere = {
      OR: [
        { createdAt: { gte: weekStart, lte: weekEnd } },
        { firstAssignedAt: { gte: weekStart, lte: weekEnd } },
      ],
      workspaceId: req.workspaceId,
      assignedTech: { isActive: true },
    };
    if (excludeNoise) {
      weeklyTicketWhere.isNoise = false;
    }

    const tickets = await prisma.ticket.findMany({
      where: weeklyTicketWhere,
      select: {
        id: true,
        createdAt: true,
        firstAssignedAt: true,
      },
    });

    logger.debug(`Found ${tickets.length} tickets in week range`);

    const dailyCounts = [];

    // Count tickets for each day using firstAssignedAt with createdAt fallback
    // This matches statsCalculator.js logic exactly (lines 206-209)
    for (let i = 0; i < 7; i++) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + i);
      date.setHours(12, 0, 0, 0);

      const result = getTodayRange(timezone, date);
      const { start, end } = result;

      // Use same logic as statsCalculator: prefer firstAssignedAt, fallback to createdAt
      const count = tickets.filter(ticket => {
        const assignDate = ticket.firstAssignedAt
          ? new Date(ticket.firstAssignedAt)
          : new Date(ticket.createdAt);
        return assignDate >= start && assignDate <= end;
      }).length;

      dailyCounts.push({
        date: formatDateInTimezone(date, timezone),
        count,
        dayOfWeek: i, // 0=Monday, 6=Sunday
      });
    }

    res.json({
      success: true,
      data: {
        dailyCounts,
        weekStart: dailyCounts[0].date,
        weekEnd: dailyCounts[6].date,
      },
    });
  }),
);

/**
 * GET /api/dashboard/weekly
 * Get weekly aggregated dashboard data for all technicians
 * Query params:
 *   - weekStart: Monday of the week (YYYY-MM-DD, optional - defaults to current week)
 *   - timezone: Timezone for date calculations (default: America/Los_Angeles)
 */
router.get(
  '/weekly',
  readCache(15_000),
  asyncHandler(async (req, res) => {
    const timezone = req.query.timezone || 'America/Los_Angeles';
    const weekStartParam = req.query.weekStart; // Format: YYYY-MM-DD

    const excludeNoise = req.query.excludeNoise === 'true';

    logger.debug(`Fetching weekly dashboard for timezone: ${timezone}, weekStart: ${weekStartParam || 'current week'}, excludeNoise: ${excludeNoise}`);

    // Calculate week start (Monday) and end (Sunday)
    let weekStartDate;
    if (weekStartParam) {
      // Use provided week start
      const [year, month, day] = weekStartParam.split('-').map(Number);
      weekStartDate = new Date(year, month - 1, day, 12, 0, 0);
    } else {
      // Calculate current week's Monday
      const now = new Date();
      const currentDay = (now.getDay() + 6) % 7; // Convert Sunday=0 to Monday=0
      weekStartDate = new Date(now);
      weekStartDate.setDate(now.getDate() - currentDay);
      weekStartDate.setHours(12, 0, 0, 0);
    }

    // Calculate week end (Sunday)
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekStartDate.getDate() + 6);
    weekEndDate.setHours(12, 0, 0, 0);

    logger.debug(`Week range: ${formatDateInTimezone(weekStartDate, timezone)} to ${formatDateInTimezone(weekEndDate, timezone)}`);

    // Get timezone-aware UTC boundaries for the scoped query
    const weekStartRange = getTodayRange(timezone, weekStartDate);
    const weekEndRange = getTodayRange(timezone, weekEndDate);

    // Fetch active technicians and service account names in parallel
    const [technicians, serviceAccountNames] = await Promise.all([
      technicianRepository.getAllActiveScoped(weekStartRange.start, weekEndRange.end, { excludeNoise, workspaceId: req.workspaceId }),
      settingsRepository.getServiceAccountNames(),
    ]);

    const weekStartStr = formatDateInTimezone(weekStartDate, timezone);
    const weekEndStr = formatDateInTimezone(weekEndDate, timezone);

    // Run stats calculation (sync), avoidance analysis, and leave info in parallel
    const [dashboardData, avoidanceMap, leaveInfoMap] = await Promise.all([
      Promise.resolve(calculateWeeklyDashboard(technicians, weekStartDate, weekEndDate, timezone, serviceAccountNames)),
      computeWeeklyDashboardAvoidance(technicians, weekStartDate, weekEndDate, timezone, req.workspaceId).catch(err => {
        logger.error('Avoidance analysis failed for weekly dashboard:', err);
        return {};
      }),
      vtService.getLeaveInfoForDashboard(req.workspaceId, weekStartStr, weekEndStr).catch(err => {
        logger.debug('VT leave info not available:', err.message);
        return {};
      }),
    ]);

    // Fetch per-tech rejection counts (same windows as daily — rejection is a rolling metric)
    const { rej7d: w_rej7d, rej30d: w_rej30d, rejLifetime: w_rejLifetime } = await getRejectionCounts(req.workspaceId);

    // Transform technicians to include weeklyTickets array for frontend filtering
    const techsWithTickets = dashboardData.technicians.map(tech => ({
      ...tech,
      weeklyTickets: (tech.weeklyTickets || []).map(transformTicket),
      avoidance: avoidanceMap[tech.id] || null,
      leaveInfo: leaveInfoMap[tech.id] || {},
      rejected7d: w_rej7d[tech.id] || 0,
      rejected30d: w_rej30d[tech.id] || 0,
      rejectedLifetime: w_rejLifetime[tech.id] || 0,
    }));

    res.json({
      success: true,
      data: {
        weekStart: formatDateInTimezone(weekStartDate, timezone),
        weekEnd: formatDateInTimezone(weekEndDate, timezone),
        technicians: techsWithTickets,
        statistics: dashboardData.statistics,
        serviceAccountNames,
        timestamp: new Date().toISOString(),
      },
    });
  }),
);

/**
 * GET /api/dashboard/technician/:id
 * Get detailed technician data with optional date filtering
 */
router.get(
  '/technician/:id',
  readCache(10_000),
  asyncHandler(async (req, res) => {
    const techId = parseInt(req.params.id, 10);
    const timezone = req.query.timezone || 'America/Los_Angeles';
    const dateParam = req.query.date; // Format: YYYY-MM-DD
    const excludeNoise = req.query.excludeNoise === 'true';
    const isViewingToday = !dateParam;

    if (isNaN(techId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid technician ID',
      });
    }

    // Fetch technician and service account names in parallel
    const [technician, serviceAccountNames] = await Promise.all([
      technicianRepository.getById(techId, { excludeNoise }),
      settingsRepository.getServiceAccountNames(),
    ]);

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: 'Technician not found',
      });
    }

    if (technician.workspaceId !== req.workspaceId) {
      return res.status(404).json({ success: false, message: 'Technician not found' });
    }

    // Get date range for filtering (if viewing historical date)
    let todayStart, todayEnd;
    if (dateParam) {
      const [year, month, day] = dateParam.split('-').map(Number);
      const selectedDate = new Date(year, month - 1, day, 12, 0, 0);
      const result = getTodayRange(timezone, selectedDate);
      todayStart = result.start;
      todayEnd = result.end;
    } else {
      const result = getTodayRange(timezone);
      todayStart = result.start;
      todayEnd = result.end;
    }

    // Use statsCalculator for consistent calculations
    const technicianData = calculateTechnicianDetail(
      technician,
      todayStart,
      todayEnd,
      isViewingToday,
      serviceAccountNames,
    );

    // Compute avoidance analysis for this technician
    let avoidance = null;
    try {
      avoidance = await computeTechnicianAvoidanceDetail(technician, todayStart, todayEnd, req.workspaceId, { excludeNoise });
    } catch (err) {
      logger.error(`Avoidance analysis failed for technician ${techId}:`, err);
    }

    // Transform tickets for frontend (flatten requester object)
    res.json({
      success: true,
      data: {
        ...technicianData,
        openTickets: technicianData.openTickets.map(transformTicket),
        ticketsOnDate: technicianData.ticketsOnDate.map(transformTicket),
        closedTicketsOnDate: technicianData.closedTicketsOnDate.map(transformTicket),
        selfPickedTickets: technicianData.selfPickedTickets.map(transformTicket),
        assignedTickets: technicianData.assignedTickets.map(transformTicket),
        selfPickedOpenTickets: technicianData.selfPickedOpenTickets.map(transformTicket),
        assignedOpenTickets: technicianData.assignedOpenTickets.map(transformTicket),
        avoidance,
      },
    });
  }),
);

/**
 * GET /api/dashboard/technician/:id/weekly
 * Get weekly stats for a specific technician
 * Query params:
 *   - weekStart: Monday of the week (YYYY-MM-DD, optional - defaults to current week)
 *   - timezone: Timezone for date calculations (default: America/Los_Angeles)
 */
router.get(
  '/technician/:id/weekly',
  readCache(15_000),
  asyncHandler(async (req, res) => {
    const techId = parseInt(req.params.id, 10);
    const timezone = req.query.timezone || 'America/Los_Angeles';
    const weekStartParam = req.query.weekStart;

    if (isNaN(techId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid technician ID',
      });
    }

    const excludeNoise = req.query.excludeNoise === 'true';

    logger.debug(`Fetching weekly stats for technician ${techId}, weekStart: ${weekStartParam || 'current week'}`);

    // Fetch technician and service account names in parallel
    const [technician, serviceAccountNames] = await Promise.all([
      technicianRepository.getById(techId, { excludeNoise }),
      settingsRepository.getServiceAccountNames(),
    ]);

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: 'Technician not found',
      });
    }

    if (technician.workspaceId !== req.workspaceId) {
      return res.status(404).json({ success: false, message: 'Technician not found' });
    }

    // Calculate week start (Monday) and end (Sunday)
    let weekStartDate;
    if (weekStartParam) {
      const [year, month, day] = weekStartParam.split('-').map(Number);
      weekStartDate = new Date(year, month - 1, day, 12, 0, 0);
    } else {
      const now = new Date();
      const currentDay = (now.getDay() + 6) % 7;
      weekStartDate = new Date(now);
      weekStartDate.setDate(now.getDate() - currentDay);
      weekStartDate.setHours(12, 0, 0, 0);
    }

    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekStartDate.getDate() + 6);
    weekEndDate.setHours(12, 0, 0, 0);

    logger.debug(`Week range for technician: ${formatDateInTimezone(weekStartDate, timezone)} to ${formatDateInTimezone(weekEndDate, timezone)}`);

    // Use statsCalculator for weekly stats
    const weeklyStats = calculateTechnicianWeeklyStats(
      technician,
      weekStartDate,
      weekEndDate,
      timezone,
      serviceAccountNames,
    );

    // Get tickets assigned during the week for display (timezone-aware boundaries)
    const weekStartRange = getTodayRange(timezone, weekStartDate);
    const weekEndRange = getTodayRange(timezone, weekEndDate);
    const weeklyTickets = technician.tickets.filter(ticket => {
      const assignDate = ticket.firstAssignedAt
        ? new Date(ticket.firstAssignedAt)
        : new Date(ticket.createdAt);
      return assignDate >= weekStartRange.start && assignDate <= weekEndRange.end;
    });

    // Categorize weekly tickets
    const selfPickedTickets = weeklyTickets.filter(ticket =>
      ticket.isSelfPicked || ticket.assignedBy === technician.name,
    );

    const assignedTickets = weeklyTickets.filter(ticket =>
      !ticket.isSelfPicked && ticket.assignedBy !== technician.name,
    );

    // Closed tickets = tickets ASSIGNED during the week that are now closed
    // Note: Filter by assignment date + status (not close date) because closedAt/resolvedAt may be null
    const closedTickets = weeklyTickets.filter(ticket =>
      ['Resolved', 'Closed'].includes(ticket.status),
    );

    // Currently open tickets (snapshot)
    const openTickets = technician.tickets.filter(ticket =>
      ['Open', 'Pending'].includes(ticket.status),
    );

    // Compute avoidance analysis for this technician's week
    let avoidance = null;
    try {
      avoidance = await computeTechnicianAvoidanceWeeklyDetail(
        technician, weekStartDate, weekEndDate, timezone, req.workspaceId, { excludeNoise },
      );
    } catch (err) {
      logger.error(`Weekly avoidance analysis failed for technician ${techId}:`, err);
    }

    res.json({
      success: true,
      data: {
        id: technician.id,
        name: technician.name,
        email: technician.email,
        photoUrl: technician.photoUrl,
        timezone: technician.timezone,
        workStartTime: technician.workStartTime || null,
        workEndTime: technician.workEndTime || null,
        isActive: technician.isActive,
        weekStart: formatDateInTimezone(weekStartDate, timezone),
        weekEnd: formatDateInTimezone(weekEndDate, timezone),

        ...weeklyStats,

        openTickets: openTickets.map(transformTicket),
        weeklyTickets: weeklyTickets.map(transformTicket),
        selfPickedTickets: selfPickedTickets.map(transformTicket),
        assignedTickets: assignedTickets.map(transformTicket),
        closedTickets: closedTickets.map(transformTicket),
        avoidance,
      },
    });
  }),
);

/**
 * GET /api/dashboard/technician/:id/monthly
 * Get monthly stats for a single technician
 * Query params:
 *   - month: "YYYY-MM" (optional, defaults to current month)
 *   - timezone: Timezone for date calculations (default: America/Los_Angeles)
 */
router.get(
  '/technician/:id/monthly',
  readCache(15_000),
  asyncHandler(async (req, res) => {
    const techId = parseInt(req.params.id, 10);
    const timezone = req.query.timezone || 'America/Los_Angeles';
    const monthParam = req.query.month; // Format: "YYYY-MM"

    if (isNaN(techId)) {
      return res.status(400).json({ success: false, message: 'Invalid technician ID' });
    }

    const excludeNoise = req.query.excludeNoise === 'true';

    logger.debug(`Fetching monthly stats for technician ${techId}, month: ${monthParam || 'current'}`);

    // Parse month into first-of-month and last-of-month dates
    let monthStartDate;
    if (monthParam) {
      const [year, month] = monthParam.split('-').map(Number);
      monthStartDate = new Date(year, month - 1, 1, 12, 0, 0);
    } else {
      const now = new Date();
      monthStartDate = new Date(now.getFullYear(), now.getMonth(), 1, 12, 0, 0);
    }
    const monthEndDate = new Date(monthStartDate.getFullYear(), monthStartDate.getMonth() + 1, 0, 12, 0, 0);

    // Fetch technician and service account names in parallel
    const [technician, serviceAccountNames] = await Promise.all([
      technicianRepository.getById(techId, { excludeNoise }),
      settingsRepository.getServiceAccountNames(),
    ]);
    if (!technician) {
      return res.status(404).json({ success: false, message: 'Technician not found' });
    }

    if (technician.workspaceId !== req.workspaceId) {
      return res.status(404).json({ success: false, message: 'Technician not found' });
    }

    // Calculate monthly stats
    const monthlyStats = calculateTechnicianMonthlyStats(
      technician,
      monthStartDate,
      monthEndDate,
      timezone,
      serviceAccountNames,
    );

    // Get tickets assigned during the month for display
    const monthStartRange = getTodayRange(timezone, monthStartDate);
    const monthEndRange = getTodayRange(timezone, monthEndDate);
    const monthlyTickets = technician.tickets.filter(ticket => {
      const assignDate = ticket.firstAssignedAt
        ? new Date(ticket.firstAssignedAt)
        : new Date(ticket.createdAt);
      return assignDate >= monthStartRange.start && assignDate <= monthEndRange.end;
    });

    const selfPickedTickets = monthlyTickets.filter(ticket =>
      ticket.isSelfPicked || ticket.assignedBy === technician.name,
    );
    const assignedTickets = monthlyTickets.filter(ticket =>
      !ticket.isSelfPicked && ticket.assignedBy !== technician.name,
    );
    const closedTickets = monthlyTickets.filter(ticket =>
      ['Resolved', 'Closed'].includes(ticket.status),
    );
    const openTickets = technician.tickets.filter(ticket =>
      ['Open', 'Pending'].includes(ticket.status),
    );

    // Compute avoidance analysis for the month
    let avoidance = null;
    try {
      avoidance = await computeTechnicianAvoidanceMonthlyDetail(
        technician, monthStartDate, monthEndDate, timezone, req.workspaceId, { excludeNoise },
      );
    } catch (err) {
      logger.error(`Monthly avoidance analysis failed for technician ${techId}:`, err);
    }

    const monthStr = monthStartDate.toLocaleDateString('en-CA').slice(0, 7); // "YYYY-MM"

    res.json({
      success: true,
      data: {
        id: technician.id,
        name: technician.name,
        email: technician.email,
        photoUrl: technician.photoUrl,
        timezone: technician.timezone,
        workStartTime: technician.workStartTime || null,
        workEndTime: technician.workEndTime || null,
        isActive: technician.isActive,
        monthStart: formatDateInTimezone(monthStartDate, timezone),
        monthEnd: formatDateInTimezone(monthEndDate, timezone),
        month: monthStr,

        ...monthlyStats,

        openTickets: openTickets.map(transformTicket),
        monthlyTickets: monthlyTickets.map(transformTicket),
        selfPickedTickets: selfPickedTickets.map(transformTicket),
        assignedTickets: assignedTickets.map(transformTicket),
        closedTickets: closedTickets.map(transformTicket),
        avoidance,
      },
    });
  }),
);

/**
 * GET /api/dashboard/timeline
 * Fetch full coverage timeline data for one or more technicians.
 * Used by the Timeline Explorer page for multi-technician views.
 *
 * Query params:
 *   - techIds:    comma-separated technician IDs (required, e.g. "3,5,8")
 *   - date:       daily mode — YYYY-MM-DD (default: today)
 *   - weekStart:  weekly mode — Monday YYYY-MM-DD
 *   - month:      monthly mode — YYYY-MM
 *   - timezone:   IANA timezone (default: America/Los_Angeles)
 *
 * Response: { technicians: [{ id, name, photoUrl, timezone, workStartTime, workEndTime, avoidance }] }
 */
router.get(
  '/timeline',
  readCache(30_000),
  asyncHandler(async (req, res) => {
    const timezone = req.query.timezone || 'America/Los_Angeles';
    const excludeNoise = req.query.excludeNoise === 'true';
    const rawIds = req.query.techIds || '';
    const techIds = rawIds.split(',').map(Number).filter((n) => !isNaN(n) && n > 0);

    if (techIds.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one techId is required' });
    }

    // Determine period type and date range
    let periodType = 'daily';
    let rangeStart, rangeEnd;

    if (req.query.month) {
      periodType = 'monthly';
      const [year, month] = req.query.month.split('-').map(Number);
      rangeStart = new Date(year, month - 1, 1, 12, 0, 0);
      rangeEnd   = new Date(year, month, 0, 12, 0, 0); // last day of month
    } else if (req.query.weekStart) {
      periodType = 'weekly';
      const [y, m, d] = req.query.weekStart.split('-').map(Number);
      rangeStart = new Date(y, m - 1, d, 12, 0, 0);
      rangeEnd   = new Date(y, m - 1, d + 6, 12, 0, 0);
    } else {
      periodType = 'daily';
      if (req.query.date) {
        const [y, m, d] = req.query.date.split('-').map(Number);
        rangeStart = new Date(y, m - 1, d, 12, 0, 0);
      } else {
        rangeStart = new Date();
        rangeStart.setHours(12, 0, 0, 0);
      }
      rangeEnd = rangeStart;
    }

    logger.debug(`Timeline endpoint: periodType=${periodType}, techIds=${techIds.join(',')}, range=${rangeStart.toISOString()} – ${rangeEnd.toISOString()}`);

    // Fetch avoidance data for all techs in parallel
    const techResults = await Promise.all(
      techIds.map(async (techId) => {
        const tech = await technicianRepository.getById(techId, { excludeNoise });
        if (!tech) {
          logger.warn(`Timeline: technician ${techId} not found`);
          return null;
        }

        if (tech.workspaceId !== req.workspaceId) {
          logger.warn(`Timeline: technician ${techId} not in workspace ${req.workspaceId}`);
          return null;
        }

        let avoidance = null;
        try {
          if (periodType === 'monthly') {
            avoidance = await computeTechnicianAvoidanceMonthlyDetail(tech, rangeStart, rangeEnd, timezone, req.workspaceId, { excludeNoise });
          } else if (periodType === 'weekly') {
            avoidance = await computeTechnicianAvoidanceWeeklyDetail(tech, rangeStart, rangeEnd, timezone, req.workspaceId, { excludeNoise });
          } else {
            avoidance = await computeTechnicianAvoidanceDetail(tech, rangeStart, rangeEnd, req.workspaceId, { excludeNoise });
          }
        } catch (err) {
          logger.error(`Timeline avoidance failed for tech ${techId}:`, err);
        }

        return {
          id: tech.id,
          name: tech.name,
          email: tech.email,
          photoUrl: tech.photoUrl,
          timezone: tech.timezone,
          workStartTime: tech.workStartTime || null,
          workEndTime: tech.workEndTime || null,
          isActive: tech.isActive,
          avoidance,
        };
      }),
    );

    const technicians = techResults.filter(Boolean);

    res.json({
      success: true,
      data: {
        technicians,
        periodType,
        periodStart: formatDateInTimezone(rangeStart, timezone),
        periodEnd: formatDateInTimezone(rangeEnd, timezone),
      },
    });
  }),
);

/**
 * GET /api/dashboard/monthly
 * Get monthly aggregated dashboard data with daily breakdown
 * Query params:
 *   - monthStart: First day of the month (YYYY-MM-DD, optional - defaults to current month)
 *   - timezone: Timezone for date calculations (default: America/Los_Angeles)
 */
router.get(
  '/monthly',
  readCache(15_000),
  asyncHandler(async (req, res) => {
    const timezone = req.query.timezone || 'America/Los_Angeles';
    const monthStartParam = req.query.monthStart; // Format: YYYY-MM-DD

    const excludeNoise = req.query.excludeNoise === 'true';

    logger.debug(`Fetching monthly dashboard for timezone: ${timezone}, monthStart: ${monthStartParam || 'current month'}, excludeNoise: ${excludeNoise}`);

    // Calculate month start and end
    let monthStartDate;
    if (monthStartParam) {
      // Use provided month start (first day of the month)
      const [year, month, day] = monthStartParam.split('-').map(Number);
      monthStartDate = new Date(year, month - 1, day, 12, 0, 0);
    } else {
      // Calculate current month's first day
      const now = new Date();
      monthStartDate = new Date(now.getFullYear(), now.getMonth(), 1, 12, 0, 0);
    }

    // Calculate month end (last day of the month)
    const monthEndDate = new Date(monthStartDate.getFullYear(), monthStartDate.getMonth() + 1, 0, 12, 0, 0);

    logger.debug(`Month range: ${monthStartDate.toISOString()} to ${monthEndDate.toISOString()}`);

    // Get timezone-aware UTC boundaries for the scoped query
    const monthStartRange = getTodayRange(timezone, monthStartDate);
    const monthEndRange = getTodayRange(timezone, monthEndDate);

    // Fetch active technicians and service account names in parallel
    const [technicians, serviceAccountNames] = await Promise.all([
      technicianRepository.getAllActiveScoped(monthStartRange.start, monthEndRange.end, { excludeNoise, workspaceId: req.workspaceId }),
      settingsRepository.getServiceAccountNames(),
    ]);

    // Use statsCalculator for consistent calculations
    const monthlyData = calculateMonthlyDashboard(
      technicians,
      monthStartDate,
      monthEndDate,
      timezone,
      serviceAccountNames,
    );

    // Fetch leave info for the month
    const monthStartStr = formatDateInTimezone(monthStartDate, timezone);
    const monthEndStr = formatDateInTimezone(monthEndDate, timezone);
    let leaveInfoMap = {};
    try {
      leaveInfoMap = await vtService.getLeaveInfoForDashboard(req.workspaceId, monthStartStr, monthEndStr);
    } catch (err) {
      logger.debug('VT leave info not available for monthly:', err.message);
    }

    // Fetch per-tech rejection counts (rolling windows; same data as daily/weekly)
    const { rej7d: m_rej7d, rej30d: m_rej30d, rejLifetime: m_rejLifetime } = await getRejectionCounts(req.workspaceId);

    // Also return technicians with their tickets filtered by month for frontend filtering
    const techniciansWithMonthTickets = technicians.map(tech => {
      const monthTickets = tech.tickets.filter(ticket => {
        const assignDate = ticket.firstAssignedAt
          ? new Date(ticket.firstAssignedAt)
          : new Date(ticket.createdAt);
        return assignDate >= monthStartDate && assignDate <= monthEndDate;
      });

      // Calculate CSAT stats for this technician for the month
      const csatTickets = tech.tickets.filter(ticket =>
        ticket.csatScore !== null &&
        ticket.csatSubmittedAt &&
        new Date(ticket.csatSubmittedAt) >= monthStartDate &&
        new Date(ticket.csatSubmittedAt) <= monthEndDate,
      );

      const csatCount = csatTickets.length;
      const csatAverage = csatCount > 0
        ? csatTickets.reduce((sum, t) => sum + (t.csatScore || 0), 0) / csatCount
        : null;

      return {
        id: tech.id,
        name: tech.name,
        email: tech.email,
        photoUrl: tech.photoUrl,
        timezone: tech.timezone,
        tickets: monthTickets.map(transformTicket),
        monthlyCSATCount: csatCount,
        monthlyCSATAverage: csatAverage,
        leaveInfo: leaveInfoMap[tech.id] || {},
        rejected7d: m_rej7d[tech.id] || 0,
        rejected30d: m_rej30d[tech.id] || 0,
        rejectedLifetime: m_rejLifetime[tech.id] || 0,
      };
    });

    res.json({
      success: true,
      data: {
        ...monthlyData,
        technicians: techniciansWithMonthTickets,
        serviceAccountNames,
        timestamp: new Date().toISOString(),
      },
    });
  }),
);

/**
 * GET /api/dashboard/technician/:id/csat
 * Get all CSAT responses for a specific technician
 */
router.get(
  '/technician/:id/csat',
  readCache(15_000),
  asyncHandler(async (req, res) => {
    const techId = parseInt(req.params.id, 10);

    if (isNaN(techId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid technician ID',
      });
    }

    // Fetch technician
    const technician = await technicianRepository.getById(techId);

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: 'Technician not found',
      });
    }

    if (technician.workspaceId !== req.workspaceId) {
      return res.status(404).json({ success: false, message: 'Technician not found' });
    }

    // Get all tickets with CSAT for this technician
    const csatTickets = await ticketRepository.getTicketsWithCSATByTechnician(techId, req.workspaceId);

    logger.debug(`Found ${csatTickets.length} CSAT responses for technician ${techId}`);

    res.json({
      success: true,
      data: {
        id: technician.id,
        name: technician.name,
        email: technician.email,
        csatTickets: csatTickets.map(transformTicket),
        totalCSAT: csatTickets.length,
        averageScore: csatTickets.length > 0
          ? (csatTickets.reduce((sum, t) => sum + (t.csatScore || 0), 0) / csatTickets.length).toFixed(2)
          : null,
      },
    });
  }),
);

/**
 * GET /api/dashboard/technician/:id/bounced
 * Return tickets this technician picked up and then rejected back to the queue.
 * Query params:
 *   - window: '7d' | '30d' | 'all' (default '7d')
 */
router.get(
  '/technician/:id/bounced',
  asyncHandler(async (req, res) => {
    const techId = parseInt(req.params.id, 10);
    const window = req.query.window === '30d' || req.query.window === 'all' ? req.query.window : '7d';

    const where = {
      technicianId: techId,
      workspaceId: req.workspaceId,
      endMethod: 'rejected',
    };
    if (window !== 'all') {
      const daysAgo = window === '30d' ? 30 : 7;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - daysAgo);
      where.endedAt = { gte: cutoff };
    }

    const rejections = await prisma.ticketAssignmentEpisode.findMany({
      where,
      orderBy: { endedAt: 'desc' },
      include: {
        ticket: {
          select: {
            id: true,
            freshserviceTicketId: true,
            subject: true,
            status: true,
            priority: true,
            ticketCategory: true,
            assignedTechId: true,
            assignedTech: { select: { id: true, name: true } },
            requester: { select: { name: true, email: true } },
          },
        },
      },
    });

    const rows = rejections.map((r) => ({
      episodeId: r.id,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      startMethod: r.startMethod,
      endActorName: r.endActorName,
      ticket: r.ticket ? { ...r.ticket, freshserviceTicketId: r.ticket.freshserviceTicketId?.toString() } : null,
    }));

    res.json({ success: true, data: { window, rejections: rows } });
  }),
);

/**
 * GET /api/dashboard/ticket/:id/history
 * Return the full ownership timeline for a ticket (all episodes + FS-sourced events).
 * Used by the run-detail handoff strip and the ticket detail drawer.
 */
router.get(
  '/ticket/:id/history',
  asyncHandler(async (req, res) => {
    // Accept either our internal id or a FreshService ticket id
    const idParam = req.params.id;
    const ticket = await prisma.ticket.findFirst({
      where: {
        workspaceId: req.workspaceId,
        OR: [
          { id: /^\d+$/.test(idParam) ? parseInt(idParam, 10) : -1 },
          { freshserviceTicketId: /^\d+$/.test(idParam) ? BigInt(idParam) : BigInt(0) },
        ],
      },
      select: { id: true, freshserviceTicketId: true, subject: true, assignedTechId: true },
    });
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    const [episodes, activities] = await Promise.all([
      prisma.ticketAssignmentEpisode.findMany({
        where: { ticketId: ticket.id },
        orderBy: { startedAt: 'asc' },
        include: { technician: { select: { id: true, name: true } } },
      }),
      prisma.ticketActivity.findMany({
        where: {
          ticketId: ticket.id,
          activityType: { in: ['self_picked', 'coordinator_assigned', 'rejected', 'reassigned', 'group_changed'] },
        },
        orderBy: { performedAt: 'asc' },
      }),
    ]);

    res.json({
      success: true,
      data: {
        ticket: { ...ticket, freshserviceTicketId: ticket.freshserviceTicketId?.toString() },
        episodes: episodes.map((e) => ({
          id: e.id,
          techId: e.technicianId,
          techName: e.technician?.name || null,
          startedAt: e.startedAt,
          endedAt: e.endedAt,
          startMethod: e.startMethod,
          startAssignedByName: e.startAssignedByName,
          endMethod: e.endMethod,
          endActorName: e.endActorName,
        })),
        events: activities.map((a) => ({
          id: a.id,
          type: a.activityType,
          at: a.performedAt,
          by: a.performedBy,
          details: a.details,
        })),
      },
    });
  }),
);

export default router;
