import logger from '../utils/logger.js';
import prisma from './prisma.js';

/**
 * Requester Repository
 * Handles database operations for requesters (ticket submitters)
 */
class RequesterRepository {
  /**
   * Find requester by FreshService ID
   * @param {BigInt} freshserviceId - FreshService requester ID
   * @returns {Promise<Object|null>} Requester object or null
   */
  async findByFreshserviceId(freshserviceId) {
    try {
      return await prisma.requester.findUnique({
        where: { freshserviceId: BigInt(freshserviceId) },
      });
    } catch (error) {
      logger.error(`Error finding requester by FreshService ID ${freshserviceId}:`, error);
      throw error;
    }
  }

  /**
   * Find multiple requesters by FreshService IDs
   * @param {Array<BigInt>} freshserviceIds - Array of FreshService requester IDs
   * @returns {Promise<Array>} Array of requester objects
   */
  async findByFreshserviceIds(freshserviceIds) {
    try {
      const bigIntIds = freshserviceIds.map(id => BigInt(id));
      return await prisma.requester.findMany({
        where: {
          freshserviceId: { in: bigIntIds },
        },
      });
    } catch (error) {
      logger.error('Error finding requesters by FreshService IDs:', error);
      throw error;
    }
  }

  /**
   * Create or update a requester
   * @param {Object} requesterData - Requester data from FreshService
   * @returns {Promise<Object>} Created/updated requester
   */
  async upsert(requesterData, { embeddedName } = {}) {
    try {
      const {
        id: freshserviceId,
        first_name,
        last_name,
        primary_email,
        work_phone_number,
        mobile_phone_number,
        department_names,
        job_title,
        time_zone,
        language,
        active,
      } = requesterData;

      // Build name from first_name + last_name, but fall back to the embedded
      // display name from the ticket list API when it produces a fuller result.
      // FreshService sometimes has incomplete first_name/last_name for
      // auto-created requesters while the ticket-embedded name is correct.
      const apiName = [first_name, last_name].filter(Boolean).join(' ');
      const name = (embeddedName && embeddedName.length > apiName.length ? embeddedName : apiName) || 'Unknown';

      return await prisma.requester.upsert({
        where: { freshserviceId: BigInt(freshserviceId) },
        update: {
          name,
          email: primary_email || null,
          phone: work_phone_number || null,
          mobile: mobile_phone_number || null,
          department: Array.isArray(department_names) ? department_names.join(', ') : null,
          jobTitle: job_title || null,
          timeZone: time_zone || null,
          language: language || null,
          isActive: active !== undefined ? active : true,
          updatedAt: new Date(),
        },
        create: {
          freshserviceId: BigInt(freshserviceId),
          name,
          email: primary_email || null,
          phone: work_phone_number || null,
          mobile: mobile_phone_number || null,
          department: Array.isArray(department_names) ? department_names.join(', ') : null,
          jobTitle: job_title || null,
          timeZone: time_zone || null,
          language: language || null,
          isActive: active !== undefined ? active : true,
        },
      });
    } catch (error) {
      logger.error('Error upserting requester:', error);
      throw error;
    }
  }

  /**
   * Bulk upsert requesters
   * @param {Array<Object>} requestersData - Array of requester data from FreshService
   * @returns {Promise<Array>} Array of created/updated requesters
   */
  async bulkUpsert(requestersData, { embeddedNames } = {}) {
    try {
      logger.info(`Upserting ${requestersData.length} requesters`);
      const results = [];

      for (const requesterData of requestersData) {
        try {
          const embeddedName = embeddedNames?.get(BigInt(requesterData.id).toString());
          const requester = await this.upsert(requesterData, { embeddedName });
          results.push(requester);
        } catch (error) {
          logger.error(`Failed to upsert requester ${requesterData.id}:`, error);
        }
      }

      logger.info(`Successfully upserted ${results.length}/${requestersData.length} requesters`);
      return results;
    } catch (error) {
      logger.error('Error bulk upserting requesters:', error);
      throw error;
    }
  }

  /**
   * Fix requesters whose stored name is shorter than the embedded display name
   * from ticket payloads. This corrects incomplete first_name/last_name data.
   * @param {Map<string, string>} embeddedNames - Map of freshserviceId.toString() → display name
   * @returns {Promise<number>} Number of requesters updated
   */
  async fixIncompleteNames(embeddedNames) {
    let fixed = 0;
    try {
      const fsIds = [...embeddedNames.keys()].map(id => BigInt(id));
      const existing = await prisma.requester.findMany({
        where: { freshserviceId: { in: fsIds } },
        select: { id: true, freshserviceId: true, name: true },
      });

      for (const req of existing) {
        const betterName = embeddedNames.get(req.freshserviceId.toString());
        if (betterName && betterName.length > req.name.length) {
          await prisma.requester.update({
            where: { id: req.id },
            data: { name: betterName },
          });
          fixed++;
        }
      }
    } catch (error) {
      logger.error('Error fixing incomplete requester names:', error);
    }
    return fixed;
  }

  /**
   * Get all unique requester IDs from tickets that don't have cached requester data
   * @returns {Promise<Array<BigInt>>} Array of FreshService requester IDs
   */
  async getUncachedRequesterIds() {
    try {
      // Find all unique requester_freshservice_id from tickets
      // where we don't have a matching requester in the requesters table
      const result = await prisma.$queryRaw`
        SELECT DISTINCT t.requester_freshservice_id
        FROM tickets t
        LEFT JOIN requesters r ON t.requester_freshservice_id = r.freshservice_id
        WHERE t.requester_freshservice_id IS NOT NULL
          AND r.id IS NULL
      `;

      return result.map(row => row.requester_freshservice_id);
    } catch (error) {
      logger.error('Error getting uncached requester IDs:', error);
      throw error;
    }
  }

  /**
   * Link tickets to their cached requesters
   * Updates ticket.requesterId to point to the internal requester.id
   * @returns {Promise<number>} Number of tickets updated
   */
  async linkTicketsToRequesters() {
    try {
      logger.info('Linking tickets to cached requesters...');

      // Update all tickets that have a requester_freshservice_id
      // but don't have a requester_id set yet
      const result = await prisma.$executeRaw`
        UPDATE tickets t
        SET requester_id = r.id
        FROM requesters r
        WHERE t.requester_freshservice_id = r.freshservice_id
          AND t.requester_id IS NULL
      `;

      logger.info(`Linked ${result} tickets to requesters`);
      return result;
    } catch (error) {
      logger.error('Error linking tickets to requesters:', error);
      throw error;
    }
  }

  /**
   * Get requester statistics
   * @returns {Promise<Object>} Statistics about requesters
   */
  async getStats() {
    try {
      const [total, active, withTickets] = await Promise.all([
        prisma.requester.count(),
        prisma.requester.count({ where: { isActive: true } }),
        prisma.requester.count({
          where: {
            tickets: {
              some: {},
            },
          },
        }),
      ]);

      return {
        total,
        active,
        withTickets,
        inactive: total - active,
      };
    } catch (error) {
      logger.error('Error getting requester stats:', error);
      throw error;
    }
  }
}

export default new RequesterRepository();
