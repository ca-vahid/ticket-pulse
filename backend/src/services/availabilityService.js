import { PrismaClient } from '@prisma/client';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import logger from '../utils/logger.js';
import llmConfigService from './llmConfigService.js';
import { getTodayRange } from '../utils/timezone.js';

const prisma = new PrismaClient();

/**
 * Availability Service
 * Manages business hours, holidays, and calculates ETA based on queue stats
 */
class AvailabilityService {
  /**
   * Initialize default business hours (Mon-Fri, 9am-5pm PST)
   */
  async initializeDefaultBusinessHours() {
    const existingHours = await prisma.businessHour.count();
    if (existingHours > 0) {
      logger.debug('Business hours already configured');
      return;
    }

    logger.info('Initializing default business hours');

    // Monday to Friday, 9am to 5pm
    const businessDays = [1, 2, 3, 4, 5];
    const defaultHours = businessDays.map(day => ({
      dayOfWeek: day,
      startTime: '09:00',
      endTime: '17:00',
      isEnabled: true,
      timezone: 'America/Los_Angeles',
    }));

    await prisma.businessHour.createMany({
      data: defaultHours,
    });

    logger.info('Default business hours created');
  }

  /**
   * Get all business hours
   */
  async getBusinessHours() {
    return await prisma.businessHour.findMany({
      orderBy: { dayOfWeek: 'asc' },
    });
  }

  /**
   * Update business hours
   */
  async updateBusinessHours(hours) {
    // Delete existing hours
    await prisma.businessHour.deleteMany();

    // Create new hours
    if (hours && hours.length > 0) {
      await prisma.businessHour.createMany({
        data: hours,
      });
    }

    logger.info('Business hours updated');
  }

  /**
   * Check if a given date/time falls within business hours
   * @param {Date} dateTime - The date/time to check
   * @param {string} timezone - The timezone to use (default: America/Los_Angeles)
   * @returns {Promise<{isBusinessHours: boolean, reason: string}>}
   */
  async isBusinessHours(dateTime = new Date(), timezone = 'America/Los_Angeles') {
    const date = new Date(dateTime);
    const zoned = toZonedTime(date, timezone);
    const dayOfWeek = zoned.getDay(); // 0=Sunday, 6=Saturday

    // Check if it's a holiday
    const isHoliday = await this.isHoliday(date, timezone);
    if (isHoliday.isHoliday) {
      return {
        isBusinessHours: false,
        reason: `Holiday: ${isHoliday.name}`,
      };
    }

    // Get business hours for this day of week
    const businessHour = await prisma.businessHour.findFirst({
      where: {
        dayOfWeek,
        isEnabled: true,
      },
    });

    if (!businessHour) {
      return {
        isBusinessHours: false,
        reason: 'No business hours configured for this day',
      };
    }

    // Parse time (HH:MM format)
    const currentHour = zoned.getHours();
    const currentMinute = zoned.getMinutes();
    const currentTimeMinutes = currentHour * 60 + currentMinute;

    const [startHour, startMinute] = businessHour.startTime.split(':').map(Number);
    const startTimeMinutes = startHour * 60 + startMinute;

    const [endHour, endMinute] = businessHour.endTime.split(':').map(Number);
    const endTimeMinutes = endHour * 60 + endMinute;

    const isWithinHours = currentTimeMinutes >= startTimeMinutes && currentTimeMinutes < endTimeMinutes;

    return {
      isBusinessHours: isWithinHours,
      reason: isWithinHours
        ? 'Within business hours'
        : `Outside business hours (${businessHour.startTime} - ${businessHour.endTime})`,
    };
  }

  /**
   * Get next business day/time
   * @param {Date} fromDate - Starting date
   * @param {string} timezone - The timezone to use (default: America/Los_Angeles)
   * @returns {Promise<{nextBusinessTime: Date, reason: string}>}
   */
  async getNextBusinessTime(fromDate = new Date(), timezone = 'America/Los_Angeles') {
    const date = new Date(fromDate);
    const maxDaysToCheck = 14; // Check up to 2 weeks ahead
    let daysChecked = 0;

    const businessHours = await this.getBusinessHours();
    const enabledDays = new Set(businessHours.filter(h => h.isEnabled).map(h => h.dayOfWeek));

    while (daysChecked < maxDaysToCheck) {
      const zoned = toZonedTime(date, timezone);
      const dayOfWeek = zoned.getDay();

      // Check if this day has business hours
      if (enabledDays.has(dayOfWeek)) {
        const isHoliday = await this.isHoliday(date, timezone);
        if (!isHoliday.isHoliday) {
          // Found a business day
          const businessHour = businessHours.find(h => h.dayOfWeek === dayOfWeek);
          const dateStr = formatInTimeZone(date, timezone, 'yyyy-MM-dd');
          const offset = formatInTimeZone(new Date(`${dateStr}T12:00:00Z`), timezone, 'XXX');

          const startLocalIso = `${dateStr}T${businessHour.startTime}:00${offset}`;
          const endLocalIso = `${dateStr}T${businessHour.endTime}:00${offset}`;

          const startUtc = new Date(startLocalIso);
          const endUtc = new Date(endLocalIso);

          // If we're checking "today", ensure nextBusinessTime is in the future.
          // - Before open: return today's open time
          // - After close: skip to next day
          const isSameLocalDay =
            formatInTimeZone(date, timezone, 'yyyy-MM-dd') === formatInTimeZone(fromDate, timezone, 'yyyy-MM-dd');

          if (isSameLocalDay && new Date(fromDate) >= endUtc) {
            // Past closing time for today in this timezone; continue to next day.
          } else {
            const nextBusinessTime = isSameLocalDay && new Date(fromDate) > startUtc ? startUtc : startUtc;
            return {
              nextBusinessTime,
              reason: `Next business hours start at ${businessHour.startTime}`,
            };
          }
        }
      }

      // Move to next day
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
      daysChecked++;
    }

    // Fallback
    return {
      nextBusinessTime: new Date(fromDate.getTime() + 24 * 60 * 60 * 1000),
      reason: 'Unable to determine next business time',
    };
  }

  /**
   * Get all holidays
   */
  async getHolidays() {
    return await prisma.holiday.findMany({
      orderBy: { date: 'asc' },
    });
  }

  /**
   * Add a holiday
   */
  async addHoliday(holiday) {
    return await prisma.holiday.create({
      data: holiday,
    });
  }

  /**
   * Update a holiday
   */
  async updateHoliday(id, holiday) {
    return await prisma.holiday.update({
      where: { id },
      data: holiday,
    });
  }

  /**
   * Delete a holiday
   */
  async deleteHoliday(id) {
    return await prisma.holiday.delete({
      where: { id },
    });
  }

  /**
   * Check if a given date is a holiday
   * @param {Date} date - The date to check
   * @param {string} timezone - The timezone to use (default: America/Los_Angeles)
   * @returns {Promise<{isHoliday: boolean, name: string|null}>}
   */
  async isHoliday(date, timezone = 'America/Los_Angeles') {
    const checkDate = new Date(date);

    // Determine the start/end of the local day in the given timezone and query by range.
    const { start, end } = getTodayRange(timezone, checkDate);

    // Check for exact date match (non-recurring holidays stored as a DATE)
    const exactHoliday = await prisma.holiday.findFirst({
      where: {
        isEnabled: true,
        isRecurring: false,
        date: {
          gte: start,
          lte: end,
        },
      },
      orderBy: { date: 'asc' },
    });

    if (exactHoliday) {
      return { isHoliday: true, name: exactHoliday.name };
    }

    // Check for recurring holidays (same month and day in the target timezone)
    const targetMonthDay = formatInTimeZone(checkDate, timezone, 'MM-dd');
    const recurringHolidays = await prisma.holiday.findMany({
      where: {
        isEnabled: true,
        isRecurring: true,
      },
      select: {
        name: true,
        date: true,
      },
    });

    const matchedRecurring = recurringHolidays.find((h) => {
      const holidayMonthDay = formatInTimeZone(new Date(h.date), timezone, 'MM-dd');
      return holidayMonthDay === targetMonthDay;
    });

    if (matchedRecurring) {
      return { isHoliday: true, name: matchedRecurring.name };
    }

    return { isHoliday: false, name: null };
  }

  /**
   * Calculate ETA based on queue stats and availability
   * @param {Object} stats - Queue statistics
   * @returns {Promise<{estimatedMinutes: number, reason: string}>}
   */
  async calculateETA(stats = {}) {
    const now = new Date();
    const timezone = stats.timezone || 'America/Los_Angeles';
    const ticketsArrivedSoFarToday = stats.ticketsArrivedSoFarToday ?? stats.todayTicketCount ?? 0;
    const recentOpenBacklog = stats.recentOpenBacklog ?? stats.openTicketCount ?? 0;
    const activeAgentCount = stats.activeAgentCount ?? 1;
    const minutesSinceBusinessStart = stats.minutesSinceBusinessStart ?? 0;

    // Get ETA configuration
    const llmConfig = await llmConfigService.getPublishedConfig();
    const baseMinutes = llmConfig.baseResponseMinutes || 30;
    const perTicketDelay = llmConfig.perTicketDelayMinutes || 10;

    // Check if we're in business hours
    const availabilityCheck = await this.isBusinessHours(now, timezone);

    if (!availabilityCheck.isBusinessHours) {
      const nextBusiness = await this.getNextBusinessTime(now, timezone);
      const minutesUntilOpen = Math.ceil((nextBusiness.nextBusinessTime - now) / (1000 * 60));

      return {
        estimatedMinutes: minutesUntilOpen + baseMinutes,
        reason: `Outside business hours. ${nextBusiness.reason}. Base response time after opening: ~${baseMinutes} minutes`,
        isAfterHours: true,
        nextBusinessTime: nextBusiness.nextBusinessTime,
      };
    }

    // Hybrid intraday-first model:
    // - Primary: tickets arrived so far this business day (intraday pressure)
    // - Secondary: recent open backlog (stale-filtered upstream; we cap/weight it)
    // - Early-day fallback: blend towards observed baseline from recent tickets (if available)
    const agentFactor = Math.max(1, activeAgentCount);

    const intradayPerAgent = ticketsArrivedSoFarToday / agentFactor;
    const intradayMinutes = baseMinutes + intradayPerAgent * perTicketDelay;

    const backlogPerAgent = recentOpenBacklog / agentFactor;
    const backlogWeight = 0.25;
    const backlogCapTicketsPerAgent = 10;
    const backlogMinutes = Math.min(backlogPerAgent, backlogCapTicketsPerAgent) * perTicketDelay * backlogWeight;

    const currentEstimate = intradayMinutes + backlogMinutes;

    // Baseline median time-to-first-public-agent-reply (minutes) from last ~14 days.
    // If unavailable, fall back to baseMinutes.
    const baselineMinutes = await this._getBaselineFirstPublicReplyMinutes({
      lookbackDays: 14,
    });

    const minMinutesSinceOpenForIntraday = 60;
    const minTicketsForIntraday = 5;
    const sampleIsSparse = minutesSinceBusinessStart < minMinutesSinceOpenForIntraday || ticketsArrivedSoFarToday < minTicketsForIntraday;

    const blended = sampleIsSparse
      ? 0.6 * baselineMinutes + 0.4 * currentEstimate
      : currentEstimate;

    const estimatedMinutes = Math.max(
      1,
      Math.ceil(blended),
    );

    return {
      estimatedMinutes,
      reason: sampleIsSparse
        ? `Early-day blend. Today arrivals: ${ticketsArrivedSoFarToday}, recent open backlog (<=3d): ${recentOpenBacklog}, agents: ${activeAgentCount}, baseline: ~${Math.round(baselineMinutes)}m`
        : `Today arrivals: ${ticketsArrivedSoFarToday}, recent open backlog (<=3d): ${recentOpenBacklog}, agents: ${activeAgentCount}`,
      isAfterHours: false,
      nextBusinessTime: null,
    };
  }

  async _getBaselineFirstPublicReplyMinutes({ lookbackDays = 14 } = {}) {
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - lookbackDays);

    try {
      // Postgres: compute median minutes between created_at and first_public_agent_reply_at.
      const rows = await prisma.$queryRaw`
        SELECT
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM ("first_public_agent_reply_at" - "created_at")) / 60.0
          ) AS median_minutes
        FROM "tickets"
        WHERE
          "first_public_agent_reply_at" IS NOT NULL
          AND "created_at" >= ${cutoff}
          AND "first_public_agent_reply_at" >= "created_at"
      `;

      const median = rows?.[0]?.median_minutes;
      const parsed = typeof median === 'number' ? median : median ? Number(median) : null;
      if (!parsed || Number.isNaN(parsed) || parsed <= 0) return 30;

      // Keep baseline within sane bounds to avoid weird spikes
      return Math.max(5, Math.min(240, parsed));
    } catch (error) {
      logger.debug('Baseline query failed; falling back to defaults', { error: error.message });
      return 30;
    }
  }

  /**
   * Load common Canadian holidays
   */
  async loadCanadianHolidays(year = new Date().getFullYear()) {
    const holidays = [
      { name: 'New Year\'s Day', date: new Date(year, 0, 1), isRecurring: true, country: 'CA' },
      { name: 'Canada Day', date: new Date(year, 6, 1), isRecurring: true, country: 'CA' },
      { name: 'Labour Day', date: this.getNthDayOfMonth(year, 8, 1, 1), isRecurring: false, country: 'CA' },
      { name: 'Thanksgiving', date: this.getNthDayOfMonth(year, 9, 1, 2), isRecurring: false, country: 'CA' },
      { name: 'Christmas Day', date: new Date(year, 11, 25), isRecurring: true, country: 'CA' },
      { name: 'Boxing Day', date: new Date(year, 11, 26), isRecurring: true, country: 'CA' },
    ];

    for (const holiday of holidays) {
      const existing = await prisma.holiday.findFirst({
        where: {
          name: holiday.name,
          date: holiday.date,
        },
      });

      if (!existing) {
        await this.addHoliday(holiday);
      }
    }

    logger.info(`Loaded Canadian holidays for ${year}`);
  }

  /**
   * Helper: Get nth occurrence of a day in a month
   * @param {number} year
   * @param {number} month - 0-indexed
   * @param {number} dayOfWeek - 0=Sunday
   * @param {number} occurrence - 1st, 2nd, etc.
   */
  getNthDayOfMonth(year, month, dayOfWeek, occurrence) {
    const date = new Date(year, month, 1);
    let count = 0;

    while (date.getMonth() === month) {
      if (date.getDay() === dayOfWeek) {
        count++;
        if (count === occurrence) {
          return new Date(date);
        }
      }
      date.setDate(date.getDate() + 1);
    }

    return null;
  }
}

export default new AvailabilityService();

