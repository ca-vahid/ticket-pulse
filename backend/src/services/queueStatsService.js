import { PrismaClient } from '@prisma/client';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import availabilityService from './availabilityService.js';

const prisma = new PrismaClient();

function buildZonedLocalInstantUtc({ referenceDate, timezone, hhmm }) {
  const dateStr = formatInTimeZone(referenceDate, timezone, 'yyyy-MM-dd');
  const offset = formatInTimeZone(new Date(`${dateStr}T12:00:00Z`), timezone, 'XXX');
  return new Date(`${dateStr}T${hhmm}:00${offset}`);
}

/**
 * Queue Stats Service
 * Provides DB-backed stats for ETA calculations without scanning all tickets.
 */
class QueueStatsService {
  /**
   * Get queue stats used for ETA-to-first-response.
   * Hybrid model wants:
   * - ticketsArrivedSoFarToday: tickets created since business-day start (today's open time) until now (clamped to close)
   * - recentOpenBacklog: open tickets updated/created within last N days (stale-filtered)
   * - activeAgentCount: distinct assigned techs with recent open tickets
   */
  async getQueueStats(options = {}) {
    const timezone = options.timezone || config.sync.defaultTimezone;
    const staleDays = options.staleDays ?? 3;
    const openStatuses = options.openStatuses || ['Open', 'Pending', 'In Progress'];

    const now = new Date();

    try {
      // Determine today's business-hour window (start/end) in the configured timezone
      const zonedNow = toZonedTime(now, timezone);
      const dayOfWeek = zonedNow.getDay();

      const businessHour = await prisma.businessHour.findFirst({
        where: { dayOfWeek, isEnabled: true },
      });

      let businessStart = null;
      let businessEnd = null;

      if (businessHour) {
        businessStart = buildZonedLocalInstantUtc({
          referenceDate: now,
          timezone,
          hhmm: businessHour.startTime,
        });
        businessEnd = buildZonedLocalInstantUtc({
          referenceDate: now,
          timezone,
          hhmm: businessHour.endTime,
        });
      }

      // Clamp the effective "so far today" end to businessEnd if present
      const effectiveSoFarEnd = businessEnd ? new Date(Math.min(now.getTime(), businessEnd.getTime())) : now;

      // If before businessStart, "so far today" count should be 0
      const hasStartedBusinessDay = businessStart ? now >= businessStart : true;
      const minutesSinceBusinessStart =
        businessStart && now >= businessStart ? Math.floor((now.getTime() - businessStart.getTime()) / (1000 * 60)) : 0;

      const ticketsArrivedSoFarToday = hasStartedBusinessDay
        ? await prisma.ticket.count({
          where: {
            createdAt: {
              gte: businessStart || now, // if no businessStart configured, treat as started
              lte: effectiveSoFarEnd,
            },
          },
        })
        : 0;

      const cutoffRecent = new Date(now);
      cutoffRecent.setDate(cutoffRecent.getDate() - staleDays);

      const recentOpenWhere = {
        status: { in: openStatuses },
        OR: [{ updatedAt: { gte: cutoffRecent } }, { createdAt: { gte: cutoffRecent } }],
      };

      const [recentOpenBacklog, openTicketCountAll, activeAgents] = await Promise.all([
        prisma.ticket.count({ where: recentOpenWhere }),
        prisma.ticket.count({ where: { status: { in: openStatuses } } }),
        prisma.ticket.groupBy({
          by: ['assignedTechId'],
          where: {
            ...recentOpenWhere,
            assignedTechId: { not: null },
          },
        }),
      ]);

      // In case business hours are not configured, availabilityService may still provide after-hours behavior.
      // We include it here to let ETA logic explain state.
      const availability = await availabilityService.isBusinessHours(now, timezone);

      return {
        timezone,
        now,
        availability,
        businessStart,
        businessEnd,
        minutesSinceBusinessStart,
        staleDays,
        openStatuses,
        // New-model inputs
        ticketsArrivedSoFarToday,
        recentOpenBacklog,
        openTicketCountAll,
        activeAgentCount: Math.max(1, activeAgents.length),
        // Backward-compatible fields (used by existing calculateETA until we swap models)
        openTicketCount: recentOpenBacklog,
        todayTicketCount: ticketsArrivedSoFarToday,
      };
    } catch (error) {
      logger.error('QueueStatsService.getQueueStats failed', { error: error.message });
      return {
        timezone,
        now,
        availability: { isBusinessHours: true, reason: 'unknown' },
        businessStart: null,
        businessEnd: null,
        minutesSinceBusinessStart: 0,
        staleDays,
        openStatuses,
        ticketsArrivedSoFarToday: 0,
        recentOpenBacklog: 0,
        openTicketCountAll: 0,
        activeAgentCount: 1,
        openTicketCount: 0,
        todayTicketCount: 0,
      };
    }
  }
}

export default new QueueStatsService();


