import prisma from './prisma.js';
import availabilityService from './availabilityService.js';
import logger from '../utils/logger.js';

/**
 * Holiday auto-load (Phase HD4, QA 08-25 #3).
 *
 * The SLA calendar (businessCalendarService) and the auto-responder read the
 * `holidays` table — so a year whose floating holidays were never loaded
 * treats Labour Day / Thanksgiving / Good Friday as working days. Before
 * this, "Load Canadian" was a manual, single-year button; prod held 2025
 * only. This service keeps the CURRENT and NEXT year loaded, company-wide
 * (one shared row per holiday, workspaceId null — 1 Oct 2026: every
 * workspace is the same company and closes on the same days; per-workspace
 * loads had left five copies of each holiday), whenever at least one active
 * workspace has business hours configured:
 *   - at boot (a server down on Jan 1 self-heals on its next start), and
 *   - on the Jan-1 cron in scheduledSyncService.
 * Idempotent (the loader dedupes by name+date / name+recurring among the
 * company-wide rows). Workspace-only holidays (e.g. an Accounting Summit)
 * are still added by hand in Settings.
 * Kill switch: HOLIDAY_AUTOLOAD=false.
 */
export function isHolidayAutoloadEnabled(env = process.env) {
  return String(env.HOLIDAY_AUTOLOAD ?? 'true').trim().toLowerCase() !== 'false';
}

class HolidayAutoloadService {
  /**
   * @param {{years?: number[]|null, reason?: string}} options
   * @returns {Promise<{skipped: boolean, years: number[], workspaceCount: number, created: number, skippedRows?: number, error?: string}>}
   */
  async ensureHolidaysLoaded({ years = null, reason = 'manual' } = {}) {
    if (!isHolidayAutoloadEnabled()) {
      logger.info('Holiday auto-load disabled by HOLIDAY_AUTOLOAD=false', { reason });
      return { skipped: true, years: [], workspaceCount: 0, created: 0 };
    }

    // "Workspaces with business hours configured" — app boot seeds Mon–Fri
    // 9–5 for every active workspace, so in practice this is every active
    // workspace; the join keeps it honest if a workspace's hours are cleared.
    const rows = await prisma.businessHour.findMany({
      where: { workspace: { isActive: true } },
      distinct: ['workspaceId'],
      select: { workspaceId: true },
    });
    const workspaceCount = rows.map((row) => row.workspaceId).filter((id) => Number.isInteger(id)).length;
    if (workspaceCount === 0) {
      logger.info(`Holiday auto-load (${reason}): no active workspace has business hours — nothing to load`);
      return { skipped: false, years: [], workspaceCount: 0, created: 0 };
    }

    try {
      const result = await availabilityService.loadCanadianHolidaysForYears(years, null);
      logger.info(`Holiday auto-load (${reason}): ${result.created} company-wide holiday(s) created for ${result.years.join(', ')}`);
      return { skipped: false, years: result.years, workspaceCount, created: result.created, skippedRows: result.skipped };
    } catch (error) {
      logger.warn(`Holiday auto-load (${reason}) failed (non-fatal): ${error.message}`);
      return { skipped: false, years: [], workspaceCount, created: 0, error: error.message };
    }
  }
}

export default new HolidayAutoloadService();
