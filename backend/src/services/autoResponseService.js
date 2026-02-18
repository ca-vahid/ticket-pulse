import llmService from './llmService.js';
import availabilityService from './availabilityService.js';
import emailService from './emailService.js';
import autoResponseRepository from './autoResponseRepository.js';
import llmConfigService from './llmConfigService.js';
import queueStatsService from './queueStatsService.js';
import logger from '../utils/logger.js';

/**
 * Auto Response Service
 * Orchestrates the complete auto-response workflow
 */
class AutoResponseService {
  /**
   * Process an incoming ticket webhook and generate auto-response
   * @param {Object} webhookPayload - Raw webhook payload
   * @param {boolean} dryRun - If true, collects execution trace and skips email send
   * @returns {Promise<Object>} Processing result (with executionTrace if dryRun=true)
   */
  async processIncomingTicket(webhookPayload, dryRun = false) {
    const startTime = Date.now();
    let autoResponseRecord = null;
    const executionTrace = dryRun ? { steps: [], payload: webhookPayload } : null;

    const addStep = (stepNum, name, duration, input, output) => {
      if (dryRun && executionTrace) {
        executionTrace.steps.push({ step: stepNum, name, duration, input, output });
      }
    };

    try {
      logger.info(`Processing ${dryRun ? 'dry-run' : 'incoming'} ticket for auto-response`, {
        ticketId: webhookPayload.ticketId,
        senderEmail: webhookPayload.senderEmail,
      });

      // Extract ticket data
      const {
        ticketId,
        freshserviceTicketId,
        subject,
        body,
        senderEmail,
        senderName,
      } = webhookPayload;

      // STEP 0: Get current config version for tracking
      const stepStartConfig = Date.now();
      const llmConfig = await llmConfigService.getPublishedConfig();
      const configVersion = llmConfig.version || 1;

      addStep(0, 'Load Configuration', Date.now() - stepStartConfig,
        { configStatus: 'published' },
        {
          version: llmConfig.version,
          status: llmConfig.status,
          baseResponseMinutes: llmConfig.baseResponseMinutes,
          perTicketDelayMinutes: llmConfig.perTicketDelayMinutes,
          model: llmConfig.model,
          reasoningEffort: llmConfig.reasoningEffort,
          verbosity: llmConfig.verbosity,
          maxOutputTokens: llmConfig.maxOutputTokens,
          hasSignature: !!llmConfig.signatureBlock,
          hasFallback: !!llmConfig.fallbackMessage,
        },
      );

      // STEP 1: Domain & Override Filtering (before creating record in dry-run)
      const stepStartFilter = Date.now();
      const isDomainAllowed = llmConfigService.isDomainAllowed(
        senderEmail,
        llmConfig.domainWhitelist,
        llmConfig.domainBlacklist,
      );
      const overrideResult = llmConfigService.applyOverrideRules(
        { subject, body, senderEmail, senderName },
        llmConfig.overrideRules,
      );

      addStep(1, 'Domain & Override Check', Date.now() - stepStartFilter,
        {
          senderEmail,
          domainWhitelist: llmConfig.domainWhitelist,
          domainBlacklist: llmConfig.domainBlacklist,
          overrideRules: llmConfig.overrideRules,
        },
        {
          isDomainAllowed,
          overrideMatched: !!overrideResult,
          overrideClassification: overrideResult,
        },
      );

      // Create initial auto-response record (skip in dry-run to avoid DB pollution)
      if (!dryRun) {
        autoResponseRecord = await autoResponseRepository.create({
          ticketId,
          freshserviceTicketId: freshserviceTicketId ? BigInt(freshserviceTicketId) : null,
          senderEmail,
          senderName,
          rawEmailBody: body,
          webhookPayload: webhookPayload,
          classification: 'pending',
          responseSent: false,
          configVersionUsed: configVersion,
        });
      }

      // STEP 2: Classify the ticket using LLM
      const stepStartClassify = Date.now();
      logger.info('Classifying ticket with LLM');

      // Get the filled classification prompt for trace
      const classificationPromptFilled = llmConfigService.replacePlaceholders(
        llmConfig.classificationPrompt,
        {
          senderName: senderName || 'Unknown',
          senderEmail,
          subject: subject || 'No subject',
          body: body || 'No content',
        },
      );

      const classificationResult = await llmService.classifyTicket({
        subject,
        body,
        senderEmail,
        senderName,
      });

      const classification = classificationResult.classification;

      addStep(2, 'AI Classification', Date.now() - stepStartClassify,
        {
          prompt: classificationPromptFilled,
          model: classificationResult.model,
          senderName,
          senderEmail,
          subject,
          bodyPreview: body?.substring(0, 200) + '...',
        },
        {
          classification: classificationResult.classification,
          tokensUsed: classificationResult.tokensUsed,
          model: classificationResult.model,
          duration: classificationResult.duration,
        },
      );

      // STEP 3: Check availability (business hours, holidays)
      const stepStartAvailability = Date.now();
      const now = new Date();
      const availabilityCheck = await availabilityService.isBusinessHours(now);
      const isAfterHours = !availabilityCheck.isBusinessHours;

      const holidayCheck = await availabilityService.isHoliday(now);
      const isHoliday = holidayCheck.isHoliday;

      addStep(3, 'Availability Check', Date.now() - stepStartAvailability,
        {
          currentTime: now.toISOString(),
          timezone: 'America/Los_Angeles',
        },
        {
          isBusinessHours: !isAfterHours,
          reason: availabilityCheck.reason,
          isHoliday,
          holidayName: holidayCheck.name,
        },
      );

      // STEP 4: Calculate ETA
      const stepStartEta = Date.now();
      logger.info('Calculating ETA');
      const queueStats = await queueStatsService.getQueueStats();
      const etaInfo = await availabilityService.calculateETA(queueStats);

      addStep(4, 'ETA Calculation', Date.now() - stepStartEta,
        {
          queueStats,
          baseResponseMinutes: llmConfig.baseResponseMinutes,
          perTicketDelayMinutes: llmConfig.perTicketDelayMinutes,
          isAfterHours,
          isHoliday,
        },
        {
          estimatedMinutes: etaInfo.estimatedMinutes,
          reason: etaInfo.reason,
          isAfterHours: etaInfo.isAfterHours,
          nextBusinessTime: etaInfo.nextBusinessTime,
        },
      );

      // Update auto-response record with analysis results (skip in dry-run)
      if (!dryRun && autoResponseRecord) {
        await autoResponseRepository.update(autoResponseRecord.id, {
          classification: classification.sourceType,
          severity: classification.severity,
          isAfterHours,
          isHoliday,
          estimatedWaitMinutes: etaInfo.estimatedMinutes,
          queueLength: queueStats.openTicketCount,
          activeAgentCount: queueStats.activeAgentCount,
        });
      }

      // STEP 5: Build Response Context
      const stepStartContext = Date.now();
      const contextParts = [];

      if (isHoliday) {
        const holidayMsg = llmConfig.holidayMessage || `Today is ${holidayCheck.name}, a holiday. The office is closed.`;
        contextParts.push(holidayMsg);
      } else if (isAfterHours) {
        const afterHoursMsg = llmConfig.afterHoursMessage || 'This message was received outside of business hours.';
        contextParts.push(afterHoursMsg);
      } else {
        contextParts.push('This message was received during business hours.');
      }

      if (etaInfo) {
        if (etaInfo.isAfterHours) {
          contextParts.push(`Business hours resume at ${etaInfo.nextBusinessTime?.toLocaleString() || 'the next business day'}.`);
          contextParts.push(`Estimated response time after opening: ${etaInfo.estimatedMinutes} minutes.`);
        } else {
          contextParts.push(`Current estimated response time: ${etaInfo.estimatedMinutes} minutes.`);
          contextParts.push(`Queue status: ${etaInfo.reason}`);
        }
      }

      const context = contextParts.join(' ');
      const tonePreset = llmConfig.tonePresets?.[classification.sourceType] || llmConfig.tonePresets?.['human_request'];
      const responseInstructions = tonePreset?.instructions || 'Generate a professional auto-response acknowledging receipt.';

      addStep(5, 'Build Response Context', Date.now() - stepStartContext,
        {
          isHoliday,
          isAfterHours,
          holidayMessage: llmConfig.holidayMessage,
          afterHoursMessage: llmConfig.afterHoursMessage,
          tonePreset,
        },
        {
          context,
          instructions: responseInstructions,
          tone: tonePreset?.tone,
        },
      );

      // STEP 6: Generate response using LLM
      const stepStartResponse = Date.now();
      logger.info('Generating response with LLM');

      // Get filled response prompt for trace
      const responsePromptFilled = llmConfigService.replacePlaceholders(
        llmConfig.responsePrompt,
        {
          senderName: senderName || 'User',
          senderEmail,
          subject: subject || 'No subject',
          category: classification.category,
          severity: classification.severity,
          sourceType: classification.sourceType,
          summary: classification.summary,
          context,
          instructions: responseInstructions,
        },
      );

      const responseResult = await llmService.generateResponse({
        classification,
        senderName,
        senderEmail,
        subject,
        etaInfo,
        isAfterHours,
        isHoliday,
        holidayName: holidayCheck.name,
      });

      const generatedResponse = responseResult.response;

      addStep(6, 'AI Response Generation', Date.now() - stepStartResponse,
        {
          prompt: responsePromptFilled,
          model: responseResult.model,
          classification,
          context,
          instructions: responseInstructions,
        },
        {
          response: responseResult.response,
          tokensUsed: responseResult.tokensUsed,
          model: responseResult.model,
          duration: responseResult.duration,
          error: responseResult.error,
        },
      );

      // Update record with generated response (skip in dry-run)
      if (!dryRun && autoResponseRecord) {
        await autoResponseRepository.update(autoResponseRecord.id, {
          responseGenerated: generatedResponse.body,
          llmModel: responseResult.model,
          llmTokensUsed: classificationResult.tokensUsed + responseResult.tokensUsed,
        });
      }

      // STEP 7: Prepare Email
      const stepStartEmail = Date.now();
      const finalEmailBody = generatedResponse.body;
      const finalEmailSubject = generatedResponse.subject;

      addStep(7, 'Prepare Email', Date.now() - stepStartEmail,
        {
          generatedBody: responseResult.response.body,
          generatedSubject: responseResult.response.subject,
          signatureBlock: llmConfig.signatureBlock,
        },
        {
          finalSubject: finalEmailSubject,
          finalBody: finalEmailBody,
          to: senderEmail,
        },
      );

      // STEP 8: Send email (skip in dry-run)
      let emailResult = { success: false, error: 'Skipped (dry-run mode)' };

      if (!dryRun) {
        logger.info('Sending auto-response email');
        emailResult = await emailService.sendAutoResponse({
          to: senderEmail,
          subject: generatedResponse.subject,
          body: generatedResponse.body,
          ticketId: freshserviceTicketId || ticketId,
        });

        // Update record with send result
        if (autoResponseRecord) {
          await autoResponseRepository.update(autoResponseRecord.id, {
            responseSent: emailResult.success,
            sentAt: emailResult.success ? new Date() : null,
            errorMessage: emailResult.error,
          });
        }
      }

      const duration = Date.now() - startTime;

      logger.info('Auto-response processing complete', {
        autoResponseId: autoResponseRecord?.id,
        classification: classification.sourceType,
        sent: emailResult.success,
        duration,
        dryRun,
      });

      // Return format depends on mode
      if (dryRun) {
        // Dry-run mode: return detailed trace
        return {
          success: true,
          executionTrace,
          summary: {
            classification: classification.sourceType,
            severity: classification.severity,
            category: classification.category,
            estimatedWaitMinutes: etaInfo.estimatedMinutes,
            isAfterHours,
            isHoliday,
            configVersion: llmConfig.version,
            model: llmConfig.model,
            reasoningEffort: llmConfig.reasoningEffort,
            verbosity: llmConfig.verbosity,
            totalDuration: duration,
            totalTokens: classificationResult.tokensUsed + responseResult.tokensUsed,
          },
          email: {
            to: senderEmail,
            subject: finalEmailSubject,
            body: finalEmailBody,
          },
          sendData: {
            senderEmail,
            senderName,
            subject: finalEmailSubject,
            body: finalEmailBody,
            ticketId: freshserviceTicketId || ticketId,
          },
        };
      } else {
        // Production mode: return simple response
        return {
          success: true,
          autoResponseId: autoResponseRecord.id,
          classification: classification.sourceType,
          severity: classification.severity,
          responseSent: emailResult.success,
          estimatedWaitMinutes: etaInfo.estimatedMinutes,
          isAfterHours,
          isHoliday,
          duration,
        };
      }
    } catch (error) {
      logger.error('Auto-response processing failed', {
        error: error.message,
        stack: error.stack,
        dryRun,
      });

      // Update record with error if we have one (skip in dry-run)
      if (!dryRun && autoResponseRecord) {
        try {
          await autoResponseRepository.update(autoResponseRecord.id, {
            errorMessage: error.message,
          });
        } catch (updateError) {
          logger.error('Failed to update auto-response record with error', {
            error: updateError.message,
          });
        }
      }

      // Return with trace if dry-run
      if (dryRun && executionTrace) {
        executionTrace.success = false;
        executionTrace.error = error.message;
        return {
          success: false,
          executionTrace,
          error: error.message,
        };
      }

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Send email after dry-run review
   * @param {Object} sendData - Email data from dry-run
   * @returns {Promise<Object>}
   */
  async sendAfterReview(sendData) {
    try {
      const { senderEmail, subject, body, ticketId } = sendData;

      logger.info('Sending email after dry-run review', { senderEmail, ticketId });

      const emailResult = await emailService.sendAutoResponse({
        to: senderEmail,
        subject,
        body,
        ticketId,
      });

      return {
        success: emailResult.success,
        messageId: emailResult.messageId,
        error: emailResult.error,
      };
    } catch (error) {
      logger.error('Failed to send email after review', { error: error.message });
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get current queue statistics
   * @returns {Promise<Object>}
   */
  async getQueueStats() {
    try {
      const stats = await queueStatsService.getQueueStats();
      return {
        openTicketCount: stats.openTicketCount,
        todayTicketCount: stats.todayTicketCount,
        activeAgentCount: stats.activeAgentCount,
      };
    } catch (error) {
      logger.error('Failed to get queue stats', { error: error.message });

      // Return default stats
      return {
        openTicketCount: 0,
        todayTicketCount: 0,
        activeAgentCount: 1,
      };
    }
  }
}

export default new AutoResponseService();

