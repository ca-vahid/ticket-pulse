import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import technicianRepository from '../services/technicianRepository.js';
import { getLoadLevel } from '../config/constants.js';
import { getTodayRange } from '../utils/timezone.js';
import logger from '../utils/logger.js';
import { calculateWeeklyDashboard, calculateDailyDashboard, calculateTechnicianDetail, calculateTechnicianWeeklyStats } from '../services/statsCalculator.js';

const router = express.Router();

// Protect all dashboard routes with authentication
router.use(requireAuth);

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
  asyncHandler(async (req, res) => {
    const timezone = req.query.timezone || 'America/Los_Angeles';
    const dateParam = req.query.date; // Format: YYYY-MM-DD
    const isViewingToday = !dateParam; // Determine if we're viewing today vs historical date

    logger.debug(`Fetching dashboard data for timezone: ${timezone}, date: ${dateParam || 'today'}`);

    // Fetch all active technicians with their tickets
    const technicians = await technicianRepository.getAllActive();

    // Get date range for filtering
    let todayStart, todayEnd;
    if (dateParam) {
      // Use provided date - interpret the date string as being in the target timezone
      // Create a date at noon in the target timezone to avoid edge cases
      const [year, month, day] = dateParam.split('-').map(Number);
      const selectedDate = new Date(year, month - 1, day, 12, 0, 0);
      const result = getTodayRange(timezone, selectedDate);
      todayStart = result.start;
      todayEnd = result.end;
    } else {
      // Use today
      const result = getTodayRange(timezone);
      todayStart = result.start;
      todayEnd = result.end;
    }

    // Use statsCalculator for consistent calculations across all endpoints
    const dashboardData = calculateDailyDashboard(
      technicians,
      todayStart,
      todayEnd,
      isViewingToday
    );

    // Transform tickets for frontend (flatten requester object)
    // Use ticketsToday for date-filtered view (tickets assigned on selected date)
    const techsWithTransformedTickets = dashboardData.technicians.map(tech => ({
      ...tech,
      tickets: (tech.ticketsToday || []).map(transformTicket),
    }));

    // Remove intermediate arrays from response (we use tickets instead)
    techsWithTransformedTickets.forEach(tech => {
      delete tech.openTickets;
      delete tech.ticketsToday;
    });

    const statistics = dashboardData.statistics;

    res.json({
      success: true,
      data: {
        technicians: techsWithTransformedTickets,
        statistics,
        timestamp: new Date().toISOString(),
      },
    });
  })
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
  asyncHandler(async (req, res) => {
    const timezone = req.query.timezone || 'America/Los_Angeles';
    const dateParam = req.query.date || new Date().toISOString().split('T')[0];

    // Calculate Monday of the week
    const [year, month, day] = dateParam.split('-').map(Number);
    const selectedDate = new Date(year, month - 1, day, 12, 0, 0);
    const currentDay = (selectedDate.getDay() + 6) % 7; // Convert to Monday=0
    const monday = new Date(selectedDate);
    monday.setDate(selectedDate.getDate() - currentDay);

    // Calculate week range
    const weekStart = new Date(monday);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(monday);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    logger.debug(`Fetching weekly stats: ${weekStart.toISOString()} to ${weekEnd.toISOString()}`);

    // Fetch all tickets in the week range (by either createdAt or firstAssignedAt)
    // This matches the statsCalculator logic exactly
    const { PrismaClient} = await import('@prisma/client');
    const prisma = new PrismaClient();

    const tickets = await prisma.ticket.findMany({
      where: {
        OR: [
          {
            createdAt: {
              gte: weekStart,
              lte: weekEnd,
            },
          },
          {
            firstAssignedAt: {
              gte: weekStart,
              lte: weekEnd,
            },
          },
        ],
        // Only count tickets assigned to active technicians
        assignedTech: {
          isActive: true,
        },
      },
      select: {
        id: true,
        createdAt: true,
        firstAssignedAt: true,
      },
    });

    await prisma.$disconnect();

    logger.debug(`Found ${tickets.length} tickets in week range`);

    const dailyCounts = [];

    // Count tickets for each day using firstAssignedAt with createdAt fallback
    // This matches statsCalculator.js logic exactly (lines 206-209)
    for (let i = 0; i < 7; i++) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + i);

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
        date: date.toISOString().split('T')[0],
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
  })
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
  asyncHandler(async (req, res) => {
    const timezone = req.query.timezone || 'America/Los_Angeles';
    const weekStartParam = req.query.weekStart; // Format: YYYY-MM-DD

    logger.debug(`Fetching weekly dashboard for timezone: ${timezone}, weekStart: ${weekStartParam || 'current week'}`);

    // Calculate week start (Monday) and end (Sunday)
    let weekStartDate;
    if (weekStartParam) {
      // Use provided week start
      const [year, month, day] = weekStartParam.split('-').map(Number);
      weekStartDate = new Date(year, month - 1, day, 0, 0, 0);
    } else {
      // Calculate current week's Monday
      const now = new Date();
      const currentDay = (now.getDay() + 6) % 7; // Convert Sunday=0 to Monday=0
      weekStartDate = new Date(now);
      weekStartDate.setDate(now.getDate() - currentDay);
      weekStartDate.setHours(0, 0, 0, 0);
    }

    // Calculate week end (Sunday 23:59:59)
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekStartDate.getDate() + 6);
    weekEndDate.setHours(23, 59, 59, 999);

    logger.debug(`Week range: ${weekStartDate.toISOString()} to ${weekEndDate.toISOString()}`);

    // Fetch all active technicians with their tickets
    const technicians = await technicianRepository.getAllActive();

    // Use statsCalculator for consistent calculations
    const dashboardData = calculateWeeklyDashboard(
      technicians,
      weekStartDate,
      weekEndDate,
      timezone
    );

    // Transform technicians to include weeklyTickets array for frontend filtering
    const techsWithTickets = dashboardData.technicians.map(tech => ({
      ...tech,
      // Add weeklyTickets field for frontend to filter (transform like daily tickets)
      weeklyTickets: (tech.weeklyTickets || []).map(transformTicket),
    }));

    res.json({
      success: true,
      data: {
        weekStart: weekStartDate.toISOString().split('T')[0],
        weekEnd: weekEndDate.toISOString().split('T')[0],
        technicians: techsWithTickets,
        statistics: dashboardData.statistics,
        timestamp: new Date().toISOString(),
      },
    });
  })
);

/**
 * GET /api/dashboard/technician/:id
 * Get detailed technician data with optional date filtering
 */
router.get(
  '/technician/:id',
  asyncHandler(async (req, res) => {
    const techId = parseInt(req.params.id, 10);
    const timezone = req.query.timezone || 'America/Los_Angeles';
    const dateParam = req.query.date; // Format: YYYY-MM-DD
    const isViewingToday = !dateParam;

    if (isNaN(techId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid technician ID',
      });
    }

    // Fetch technician with all tickets
    const technician = await technicianRepository.getById(techId);

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: 'Technician not found',
      });
    }

    // Get date range for filtering (if viewing historical date)
    let todayStart, todayEnd;
    if (dateParam) {
      // Use provided date - interpret the date string as being in the target timezone
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
      isViewingToday
    );

    // Transform tickets for frontend (flatten requester object)
    res.json({
      success: true,
      data: {
        ...technicianData,
        // Ticket lists (arrays) - transformed for frontend
        openTickets: technicianData.openTickets.map(transformTicket),
        ticketsOnDate: technicianData.ticketsOnDate.map(transformTicket),
        closedTicketsOnDate: technicianData.closedTicketsOnDate.map(transformTicket),
        selfPickedTickets: technicianData.selfPickedTickets.map(transformTicket),
        assignedTickets: technicianData.assignedTickets.map(transformTicket),
        selfPickedOpenTickets: technicianData.selfPickedOpenTickets.map(transformTicket),
        assignedOpenTickets: technicianData.assignedOpenTickets.map(transformTicket),
      },
    });
  })
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

    logger.debug(`Fetching weekly stats for technician ${techId}, weekStart: ${weekStartParam || 'current week'}`);

    // Fetch technician with all tickets
    const technician = await technicianRepository.getById(techId);

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: 'Technician not found',
      });
    }

    // Calculate week start (Monday) and end (Sunday)
    let weekStartDate;
    if (weekStartParam) {
      const [year, month, day] = weekStartParam.split('-').map(Number);
      weekStartDate = new Date(year, month - 1, day, 0, 0, 0);
    } else {
      // Calculate current week's Monday
      const now = new Date();
      const currentDay = (now.getDay() + 6) % 7;
      weekStartDate = new Date(now);
      weekStartDate.setDate(now.getDate() - currentDay);
      weekStartDate.setHours(0, 0, 0, 0);
    }

    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekStartDate.getDate() + 6);
    weekEndDate.setHours(23, 59, 59, 999);

    logger.debug(`Week range for technician: ${weekStartDate.toISOString()} to ${weekEndDate.toISOString()}`);

    // Use statsCalculator for weekly stats
    const weeklyStats = calculateTechnicianWeeklyStats(
      technician,
      weekStartDate,
      weekEndDate,
      timezone
    );

    // Get tickets assigned during the week for display
    const weeklyTickets = technician.tickets.filter(ticket => {
      const assignDate = ticket.firstAssignedAt
        ? new Date(ticket.firstAssignedAt)
        : new Date(ticket.createdAt);
      return assignDate >= weekStartDate && assignDate <= weekEndDate;
    });

    // Categorize weekly tickets
    const selfPickedTickets = weeklyTickets.filter(ticket =>
      ticket.isSelfPicked || ticket.assignedBy === technician.name
    );

    const assignedTickets = weeklyTickets.filter(ticket =>
      !ticket.isSelfPicked && ticket.assignedBy !== technician.name
    );

    // Closed tickets = tickets ASSIGNED during the week that are now closed
    // Note: Filter by assignment date + status (not close date) because closedAt/resolvedAt may be null
    const closedTickets = weeklyTickets.filter(ticket =>
      ['Resolved', 'Closed'].includes(ticket.status)
    );

    // Currently open tickets (snapshot)
    const openTickets = technician.tickets.filter(ticket =>
      ['Open', 'Pending'].includes(ticket.status)
    );

    res.json({
      success: true,
      data: {
        id: technician.id,
        name: technician.name,
        email: technician.email,
        photoUrl: technician.photoUrl,
        timezone: technician.timezone,
        isActive: technician.isActive,
        weekStart: weekStartDate.toISOString().split('T')[0],
        weekEnd: weekEndDate.toISOString().split('T')[0],

        // Weekly stats
        ...weeklyStats,

        // Ticket lists (transformed for frontend)
        openTickets: openTickets.map(transformTicket),
        weeklyTickets: weeklyTickets.map(transformTicket),
        selfPickedTickets: selfPickedTickets.map(transformTicket),
        assignedTickets: assignedTickets.map(transformTicket),
        closedTickets: closedTickets.map(transformTicket),
      },
    });
  })
);

export default router;
