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
 * only. This service keeps the CURRENT and NEXT year loaded for every
 * active workspace with business hours configured:
 *   - at boot (a server down on Jan 1 self-heals on its next start), and
 *   - on the Jan-1 cron in scheduledSyncService.
 * Idempotent (the loader dedupes by name+date / name+recurring in scope).
 * Kill switch: HOLIDAY_AUTOLOAD=false.
 */
export function isHolidayAutoloadEnabled(env = process.env) {
  return String(env.HOLIDAY_AUTOLOAD ?? 'true').trim().toLowerCase() !== 'false';
}

class HolidayAutoloadService {
  /**
   * @param {{years?: number[]|null, reason?: string}} options
   * @returns {Promise<{skipped: boolean, years: number[], workspaces: Array<{workspaceId:number, created:number, skipped:number}>, created: number}>}
   */
  async ensureHolidaysLoaded({ years = null, reason = 'manual' } = {}) {
    if (!isHolidayAutoloadEnabled()) {
      logger.info('Holiday auto-load disabled by HOLIDAY_AUTOLOAD=false', { reason });
      return { skipped: true, years: [], workspaces: [], created: 0 };
    }

    // "Workspaces with business hours configured" — app boot seeds Mon–Fri
    // 9–5 for every active workspace, so in practice this is every active
    // workspace; the join keeps it honest if a workspace's hours are cleared.
    const rows = await prisma.businessHour.findMany({
      where: { workspace: { isActive: true } },
      distinct: ['workspaceId'],
      select: { workspaceId: true },
    });
    const workspaceIds = rows.map((row) => row.workspaceId).filter((id) => Number.isInteger(id));

    const workspaces = [];
    let created = 0;
    let loadedYears = [];
    for (const workspaceId of workspaceIds) {
      try {
        const result = await availabilityService.loadCanadianHolidaysForYears(years, workspaceId);
        loadedYears = result.years;
        workspaces.push({ workspaceId, created: result.created, skipped: result.skipped });
        created += result.created;
        if (result.created > 0) {
          logger.info(`Holiday auto-load (${reason}): workspace ${workspaceId} +${result.created} for ${result.years.join(', ')}`);
        }
      } catch (error) {
        logger.warn(`Holiday auto-load (${reason}) failed for workspace ${workspaceId} (non-fatal): ${error.message}`);
        workspaces.push({ workspaceId, created: 0, skipped: 0, error: error.message });
      }
    }

    logger.info(`Holiday auto-load (${reason}): ${workspaceIds.length} workspace(s), ${created} holiday(s) created`, { years: loadedYears });
    return { skipped: false, years: loadedYears, workspaces, created };
  }
}

export default new HolidayAutoloadService();
