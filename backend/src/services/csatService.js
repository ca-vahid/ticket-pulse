import logger from '../utils/logger.js';
import { DatabaseError } from '../utils/errors.js';

/**
 * CSAT (Customer Satisfaction) Service
 * Handles syncing and managing CSAT responses for tickets
 */
class CSATService {
  /**
   * Transform FreshService CSAT response to our database format
   * @param {Object} csatResponse - FreshService CSAT response object
   * @returns {Object} Transformed CSAT data
   */
  transformCSATResponse(csatResponse) {
    if (!csatResponse) {
      return null;
    }

    try {
      // Extract the main feedback comment from questionnaire responses
      let feedback = null;
      if (csatResponse.questionnaire_responses && csatResponse.questionnaire_responses.length > 0) {
        // Look for the feedback question (usually the second question)
        const feedbackQuestion = csatResponse.questionnaire_responses.find(qr =>
          qr.question?.question_text?.toLowerCase().includes('feedback') ||
          qr.question?.question_text?.toLowerCase().includes('thoughts') ||
          qr.question?.question_text?.toLowerCase().includes('comment'),
        );

        if (feedbackQuestion && feedbackQuestion.answers && feedbackQuestion.answers.length > 0) {
          feedback = feedbackQuestion.answers[0].answer_text;
        }

        // If no specific feedback question found, use the last question's answer
        if (!feedback && csatResponse.questionnaire_responses.length > 1) {
          const lastQuestion = csatResponse.questionnaire_responses[csatResponse.questionnaire_responses.length - 1];
          if (lastQuestion.answers && lastQuestion.answers.length > 0) {
            feedback = lastQuestion.answers[0].answer_text;
          }
        }
      }

      return {
        csatResponseId: csatResponse.id ? BigInt(csatResponse.id) : null,
        csatScore: csatResponse.score?.acquired_score || null,
        csatTotalScore: csatResponse.score?.total_score || 4, // Default to 4
        csatRatingText: csatResponse.overall_rating_text || null,
        csatOverallRating: csatResponse.overall_rating || null,
        csatFeedback: feedback,
        csatSubmittedAt: csatResponse.created_at ? new Date(csatResponse.created_at) : null,
      };
    } catch (error) {
      logger.error('Error transforming CSAT response:', error);
      return null;
    }
  }

  /**
   * Fetch and update CSAT response for a single ticket
   * @param {Object} freshserviceClient - FreshService API client instance
   * @param {Object} ticketRepository - Ticket repository instance
   * @param {number} ticketId - FreshService ticket ID
   * @returns {Promise<boolean>} True if CSAT was found and updated, false otherwise
   */
  async syncTicketCSAT(freshserviceClient, ticketRepository, ticketId) {
    try {
      // Fetch CSAT response from FreshService
      const csatResponse = await freshserviceClient.fetchCSATResponse(ticketId);

      if (!csatResponse) {
        // No CSAT response for this ticket (normal for most tickets)
        return false;
      }

      // Transform CSAT data
      const csatData = this.transformCSATResponse(csatResponse);

      if (!csatData) {
        logger.warn(`Failed to transform CSAT response for ticket ${ticketId}`);
        return false;
      }

      // Update ticket with CSAT data
      await ticketRepository.updateByFreshserviceId(ticketId, csatData);

      logger.info(`Updated CSAT for ticket ${ticketId}: Score ${csatData.csatScore}/${csatData.csatTotalScore}`);
      return true;
    } catch (error) {
      // Simplified error logging to avoid circular reference issues
      const errorMsg = error.response?.status
        ? `HTTP ${error.response.status}`
        : error.message || 'Unknown error';
      // Don't pass the error object to logger to avoid circular refs
      logger.error(`Error syncing CSAT for ticket ${ticketId}: ${errorMsg}`);
      // Throw simple error message only
      const simpleError = new Error(errorMsg);
      simpleError.ticketId = ticketId;
      throw simpleError;
    }
  }

  /**
   * Sync CSAT responses for multiple tickets
   * @param {Object} freshserviceClient - FreshService API client instance
   * @param {Object} ticketRepository - Ticket repository instance
   * @param {Array<number>} ticketIds - Array of FreshService ticket IDs
   * @param {Function} onProgress - Optional callback for progress updates (current, total, csatFound)
   * @returns {Promise<Object>} Summary of sync results
   */
  async syncMultipleTicketsCSAT(freshserviceClient, ticketRepository, ticketIds, onProgress = null) {
    const results = {
      total: ticketIds.length,
      csatFound: 0,
      updated: 0,
      errors: 0,
    };

    logger.info(`Starting CSAT sync for ${ticketIds.length} tickets`);

    for (let i = 0; i < ticketIds.length; i++) {
      const ticketId = ticketIds[i];

      try {
        const found = await this.syncTicketCSAT(freshserviceClient, ticketRepository, ticketId);

        if (found) {
          results.csatFound++;
          results.updated++;
        }

        if (onProgress) {
          onProgress(i + 1, results.total, results.csatFound);
        }

        // Rate limiting: Add small delay between requests
        if (i < ticketIds.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
        }
      } catch (error) {
        results.errors++;
        logger.error(`Failed to sync CSAT for ticket ${ticketId}:`, error.message);
      }
    }

    logger.info(`CSAT sync complete: ${results.csatFound} CSAT responses found out of ${results.total} tickets`);
    return results;
  }

  /**
   * Sync CSAT for recently closed tickets (tickets that might have received CSAT responses)
   * @param {Object} freshserviceClient - FreshService API client instance
   * @param {Object} ticketRepository - Ticket repository instance
   * @param {number} daysBack - Number of days to look back (default 30)
   * @param {Function} onProgress - Optional callback for progress updates
   * @returns {Promise<Object>} Summary of sync results
   */
  async syncRecentCSAT(freshserviceClient, ticketRepository, daysBack = 30, onProgress = null) {
    try {
      logger.info(`Syncing CSAT for tickets from last ${daysBack} days`);

      // Get closed/resolved tickets from last N days that don't have CSAT yet
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysBack);

      const tickets = await ticketRepository.getRecentClosedWithoutCSAT(cutoffDate);
      logger.info(`Found ${tickets.length} closed tickets without CSAT from last ${daysBack} days`);

      if (tickets.length === 0) {
        return { total: 0, csatFound: 0, updated: 0, errors: 0 };
      }

      // Extract FreshService ticket IDs
      const ticketIds = tickets.map(t => Number(t.freshserviceTicketId));

      // Sync CSAT for these tickets
      return await this.syncMultipleTicketsCSAT(
        freshserviceClient,
        ticketRepository,
        ticketIds,
        onProgress,
      );
    } catch (error) {
      logger.error('Error syncing recent CSAT:', error);
      throw new DatabaseError('Failed to sync recent CSAT', error);
    }
  }
}

export default new CSATService();

