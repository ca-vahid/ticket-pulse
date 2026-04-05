import Anthropic from '@anthropic-ai/sdk';
import config from '../config/index.js';
import assignmentRepository from './assignmentRepository.js';
import promptRepository from './promptRepository.js';
import availabilityService from './availabilityService.js';
import { TOOL_SCHEMAS, executeTool } from './assignmentTools.js';
import freshServiceActionService from './freshServiceActionService.js';
import competencyFeedbackService from './competencyFeedbackService.js';
import prisma from './prisma.js';
import logger from '../utils/logger.js';

const MAX_TURNS = 20;
const CLOSED_STATUSES = ['Closed', 'Resolved', 'closed', 'resolved', '4', '5'];

class AssignmentPipelineService {
  /**
   * Run the agentic assignment pipeline with streaming.
   * Automatic triggers are queued outside business hours.
   * Manual triggers always execute immediately.
   */
  async runPipeline(ticketId, workspaceId, triggerSource = 'manual', onEvent = null, signal = null) {
    const pipelineStart = Date.now();
    const emit = (event) => { try { onEvent?.(event); } catch { /* SSE write errors are non-fatal */ } };
    const isManual = triggerSource === 'manual';

    if (signal?.aborted) {
      return { skipped: true, reason: 'cancelled_before_start' };
    }

    // ── Dedupe: reject if a queued or running run already exists ─────────
    const openRun = await assignmentRepository.getOpenPipelineRun(ticketId);
    if (openRun) {
      if (isManual && openRun.status === 'queued') {
        logger.info('Manual trigger claiming queued run', { runId: openRun.id, ticketId });
        const claimed = await assignmentRepository.claimQueuedRun(openRun.id);
        if (claimed) {
          return this._executeRun(openRun.id, ticketId, workspaceId, triggerSource, pipelineStart, emit, signal);
        }
      }
      logger.info('Pipeline skipped: open run exists', { ticketId, existingRunId: openRun.id, existingStatus: openRun.status, triggerSource });
      emit({ type: 'error', message: `Pipeline already ${openRun.status} for this ticket (run #${openRun.id})` });
      emit({ type: 'complete' });
      return { skipped: true, reason: 'open_run_exists', existingRunId: openRun.id };
    }

    // ── Config check ────────────────────────────────────────────────────
    const assignmentConfig = await assignmentRepository.getConfig(workspaceId);
    if (!assignmentConfig?.isEnabled) {
      emit({ type: 'error', message: 'Assignment pipeline is not enabled for this workspace' });
      emit({ type: 'complete' });
      return { skipped: true, reason: 'assignment_not_enabled' };
    }

    // ── Business hours gate (automatic triggers only) ───────────────────
    if (!isManual) {
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { defaultTimezone: true },
      });
      const tz = workspace?.defaultTimezone || 'America/Los_Angeles';
      const bh = await availabilityService.isBusinessHours(new Date(), tz, workspaceId);

      if (!bh.isBusinessHours) {
        const queuedReason = bh.reason || 'Outside business hours';
        const run = await assignmentRepository.createQueuedRun({
          ticketId, workspaceId, triggerSource, queuedReason,
        });
        logger.info('Pipeline queued (outside business hours)', {
          runId: run.id, ticketId, workspaceId, triggerSource, queuedReason,
        });
        emit({ type: 'queued', runId: run.id, reason: queuedReason });
        emit({ type: 'complete' });
        return run;
      }
    }

    // ── Create running run and execute ──────────────────────────────────
    const promptVersion = await promptRepository.getPublished(workspaceId);
    const run = await assignmentRepository.createPipelineRun({
      ticketId,
      workspaceId,
      status: 'running',
      triggerSource,
      llmModel: assignmentConfig.llmModel,
      promptVersionId: promptVersion.id,
    });

    return this._executeRun(run.id, ticketId, workspaceId, triggerSource, pipelineStart, emit, signal);
  }

  /**
   * Validate a queued run is still worth executing.
   * Returns { valid: true } or { valid: false, reason: string }.
   */
  async validateQueuedRun(run) {
    const ticket = await prisma.ticket.findUnique({
      where: { id: run.ticketId },
      select: { status: true, assignedTechId: true },
    });

    if (!ticket) {
      return { valid: false, reason: 'Ticket no longer exists' };
    }

    if (CLOSED_STATUSES.includes(ticket.status)) {
      return { valid: false, reason: `Ticket already ${ticket.status}` };
    }

    if (ticket.assignedTechId) {
      return { valid: false, reason: 'Ticket already assigned to a technician' };
    }

    const newerRun = await prisma.assignmentPipelineRun.findFirst({
      where: {
        ticketId: run.ticketId,
        id: { not: run.id },
        status: { in: ['completed', 'running'] },
        createdAt: { gt: run.createdAt },
      },
      select: { id: true, status: true },
    });

    if (newerRun) {
      return { valid: false, reason: `Superseded by newer run #${newerRun.id} (${newerRun.status})` };
    }

    return { valid: true };
  }

  /**
   * Process queued runs for a workspace. Called by the scheduler during business hours.
   * Returns count of processed/skipped runs.
   */
  async drainQueuedRuns(workspaceId, maxPerTick = 5) {
    const queued = await assignmentRepository.listQueuedRuns(workspaceId, maxPerTick);
    if (queued.length === 0) return { processed: 0, skipped: 0 };

    let processed = 0;
    let skipped = 0;

    for (const run of queued) {
      const claimed = await assignmentRepository.claimQueuedRun(run.id);
      if (!claimed) {
        logger.debug('Queue drain: claim failed (already claimed)', { runId: run.id });
        continue;
      }

      const validation = await this.validateQueuedRun(run);
      if (!validation.valid) {
        await assignmentRepository.markRunSkippedStale(run.id, validation.reason);
        logger.info('Queue drain: skipped stale run', { runId: run.id, ticketId: run.ticketId, reason: validation.reason });
        skipped++;
        continue;
      }

      try {
        logger.info('Queue drain: processing queued run', { runId: run.id, ticketId: run.ticketId, workspaceId });
        await this._executeRun(run.id, run.ticketId, workspaceId, run.triggerSource, Date.now(), () => {}, null);
        processed++;
      } catch (error) {
        logger.error('Queue drain: run failed', { runId: run.id, error: error.message });
      }
    }

    logger.info('Queue drain complete', { workspaceId, found: queued.length, processed, skipped });
    return { processed, skipped };
  }

  /**
   * Core pipeline execution. Separated from runPipeline so it can be called
   * for both fresh runs and claimed queued runs.
   */
  async _executeRun(runId, ticketId, workspaceId, triggerSource, pipelineStart, emit, signal) {
    const assignmentConfig = await assignmentRepository.getConfig(workspaceId);
    const promptVersion = await promptRepository.getPublished(workspaceId);
    let systemPrompt = promptVersion.systemPrompt;

    if (assignmentConfig?.feedbackContext) {
      systemPrompt += `\n\n## Historical Admin Feedback\n${assignmentConfig.feedbackContext.slice(-4000)}`;
    }

    // Ensure run is in running state (may already be if created as running)
    await assignmentRepository.updatePipelineRun(runId, {
      status: 'running',
      llmModel: assignmentConfig?.llmModel || 'claude-sonnet-4-6-20260217',
      promptVersionId: promptVersion.id,
    });

    emit({ type: 'run_started', runId, ticketId, promptVersion: promptVersion.version });

    const apiKey = config.anthropic.apiKey;
    if (!apiKey) {
      const errMsg = 'ANTHROPIC_API_KEY not configured';
      await assignmentRepository.updatePipelineRun(runId, { status: 'failed', errorMessage: errMsg, totalDurationMs: Date.now() - pipelineStart });
      emit({ type: 'error', message: errMsg });
      emit({ type: 'complete', runId });
      return await assignmentRepository.getPipelineRun(runId);
    }

    const client = new Anthropic({ apiKey });
    const totalTokens = 0;
    let stepCounter = 0;
    let fullTranscript = '';

    const messages = [
      { role: 'user', content: `Analyze ticket ID ${ticketId} (use get_ticket_details to read it) and recommend the best technician for assignment. When you have completed your analysis, you MUST call the submit_recommendation tool with your final recommendation.` },
    ];

    const toolAllowlist = promptVersion.toolConfig?.allowedTools || null;
    let tools = TOOL_SCHEMAS
      .filter((t) => !toolAllowlist || toolAllowlist.includes(t.name));

    const enableWebSearch = promptVersion.toolConfig?.enableWebSearch !== false;
    if (enableWebSearch) {
      tools = [
        ...tools,
        { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
      ];
    }

    try {
      let continueLoop = true;
      let recommendation = null;

      while (continueLoop && stepCounter < MAX_TURNS) {
        if (signal?.aborted) {
          await assignmentRepository.updatePipelineRun(runId, {
            status: 'cancelled', totalDurationMs: Date.now() - pipelineStart,
            totalTokensUsed: totalTokens, fullTranscript,
          });
          emit({ type: 'error', message: 'Pipeline cancelled by client' });
          emit({ type: 'complete', runId });
          return await assignmentRepository.getPipelineRun(runId);
        }

        stepCounter++;
        emit({ type: 'turn_start', turn: stepCounter });

        const stream = client.messages.stream({
          model: assignmentConfig?.llmModel || 'claude-sonnet-4-6-20260217',
          max_tokens: 4096,
          system: systemPrompt,
          tools,
          messages,
        });

        stream.on('text', (text) => {
          fullTranscript += text;
          emit({ type: 'text', text });
        });

        stream.on('inputJson', () => {
          // Tool input JSON is streaming — tool cards provide visual feedback
        });

        const finalMessage = await stream.finalMessage();

        const toolResultMap = new Map();

        for (const block of finalMessage.content) {
          if (block.type === 'tool_use') {
            if (block.name === 'submit_recommendation') {
              recommendation = block.input;

              await assignmentRepository.createPipelineStep({
                pipelineRunId: runId,
                stepNumber: stepCounter,
                stepName: 'submit_recommendation',
                status: 'completed',
                input: block.input,
                output: { accepted: true },
                durationMs: 0,
              });

              emit({ type: 'tool_call', name: block.name, input: block.input, toolUseId: block.id });
              toolResultMap.set(block.id, { accepted: true });
              emit({ type: 'tool_result', name: block.name, data: { accepted: true }, durationMs: 0, toolUseId: block.id });
              continue;
            }

            const toolStep = await assignmentRepository.createPipelineStep({
              pipelineRunId: runId,
              stepNumber: stepCounter,
              stepName: block.name,
              status: 'running',
              input: block.input,
            });

            emit({ type: 'tool_call', name: block.name, input: block.input, toolUseId: block.id });

            const toolStart = Date.now();
            let toolResult;
            try {
              toolResult = await executeTool(block.name, block.input, { workspaceId, ticketId });
            } catch (err) {
              toolResult = { error: err.message };
            }
            const toolDuration = Date.now() - toolStart;

            toolResultMap.set(block.id, toolResult);

            await assignmentRepository.updatePipelineStep(toolStep.id, {
              status: 'completed',
              durationMs: toolDuration,
              output: toolResult,
            });

            emit({ type: 'tool_result', name: block.name, data: toolResult, durationMs: toolDuration, toolUseId: block.id });

            const toolResultStr = JSON.stringify(toolResult);
            fullTranscript += `\n\n[Tool: ${block.name}] → ${toolResultStr.slice(0, 500)}${toolResultStr.length > 500 ? '...' : ''}\n\n`;
          }
        }

        for (const block of finalMessage.content) {
          if (block.type === 'server_tool_use') {
            emit({ type: 'tool_call', name: block.name, input: block.input, toolUseId: block.id, serverTool: true });
            fullTranscript += `\n\n[Server Tool: ${block.name}] query="${block.input?.query || ''}"\n\n`;
          } else if (block.type === 'web_search_tool_result') {
            const resultCount = Array.isArray(block.content) ? block.content.filter((r) => r.type === 'web_search_result').length : 0;
            emit({ type: 'tool_result', name: 'web_search', data: { resultCount }, toolUseId: block.tool_use_id, serverTool: true });
            fullTranscript += `[Web Search Results: ${resultCount} results]\n\n`;
          }
        }

        messages.push({ role: 'assistant', content: finalMessage.content });

        if (finalMessage.stop_reason === 'tool_use') {
          const toolResultBlocks = finalMessage.content
            .filter((b) => b.type === 'tool_use')
            .map((b) => ({
              type: 'tool_result',
              tool_use_id: b.id,
              content: JSON.stringify(toolResultMap.get(b.id) || { error: 'Result not found' }),
            }));

          messages.push({ role: 'user', content: toolResultBlocks });
          continueLoop = recommendation === null;
        } else if (finalMessage.stop_reason === 'pause_turn') {
          continueLoop = true;
        } else {
          continueLoop = false;

          const accumulatedText = finalMessage.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('');

          if (accumulatedText) {
            await assignmentRepository.createPipelineStep({
              pipelineRunId: runId,
              stepNumber: stepCounter,
              stepName: 'final_response',
              status: 'completed',
              durationMs: Date.now() - pipelineStart,
              llmResponse: accumulatedText,
              tokensUsed: totalTokens,
            });
          }
        }
      }

      if (!recommendation) {
        logger.warn('Claude did not call submit_recommendation, falling back to regex parse', { runId });
        recommendation = this._parseRecommendationFromTranscript(fullTranscript, runId);
      }

      const topRec = recommendation?.recommendations?.[0];
      const isNoise = recommendation && (!recommendation.recommendations || recommendation.recommendations.length === 0);

      let decision;
      if (!recommendation) {
        decision = null;
      } else if (isNoise) {
        decision = 'noise_dismissed';
      } else if (assignmentConfig?.autoAssign) {
        decision = 'auto_assigned';
      } else {
        decision = 'pending_review';
      }

      const finalStatus = recommendation ? 'completed' : 'failed_schema_validation';
      const errorMessage = recommendation ? null : 'Could not extract structured recommendation from LLM output';

      await assignmentRepository.updatePipelineRun(runId, {
        status: finalStatus,
        decision,
        totalDurationMs: Date.now() - pipelineStart,
        totalTokensUsed: totalTokens,
        recommendation,
        fullTranscript,
        errorMessage,
        ...(decision === 'auto_assigned' && topRec?.techId ? { assignedTechId: topRec.techId } : {}),
      });

      if (recommendation) {
        emit({ type: 'recommendation', data: recommendation, decision, totalDurationMs: Date.now() - pipelineStart, totalTokens });
      } else {
        emit({ type: 'error', message: errorMessage });
      }

      logger.info('Pipeline completed', {
        runId, ticketId, status: finalStatus, decision: recommendation ? decision : null,
        turns: stepCounter, durationMs: Date.now() - pipelineStart, totalTokens,
      });

      // FreshService write-back — separate logic for assignments vs noise
      if (decision === 'auto_assigned') {
        freshServiceActionService.execute(runId, workspaceId, assignmentConfig?.dryRunMode ?? true).catch((err) =>
          logger.warn('FreshService auto-assign sync failed', { runId, error: err.message }),
        );
      } else if (decision === 'noise_dismissed' && assignmentConfig?.autoCloseNoise) {
        freshServiceActionService.execute(runId, workspaceId, assignmentConfig?.dryRunMode ?? true).catch((err) =>
          logger.warn('FreshService auto-close noise failed', { runId, error: err.message }),
        );
      }

      // Competency feedback for auto-assign
      if (decision === 'auto_assigned' && topRec?.techId) {
        competencyFeedbackService.processDecisionFeedback(runId, decision, topRec.techId, workspaceId).catch((err) =>
          logger.warn('Competency feedback failed after auto-assign', { runId, error: err.message }),
        );
      }

      emit({ type: 'complete', runId });
      return await assignmentRepository.getPipelineRun(runId);

    } catch (error) {
      logger.error('Pipeline failed', { runId, ticketId, error: error.message });
      await assignmentRepository.updatePipelineRun(runId, {
        status: 'failed',
        totalDurationMs: Date.now() - pipelineStart,
        totalTokensUsed: totalTokens,
        fullTranscript,
        errorMessage: error.message,
      });
      emit({ type: 'error', message: error.message });
      emit({ type: 'complete', runId });
      return await assignmentRepository.getPipelineRun(runId);
    }
  }

  _parseRecommendationFromTranscript(transcript, runId) {
    try {
      const jsonMatch = transcript.match(/```json\s*([\s\S]*?)```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
      }
      const rawMatch = transcript.match(/\{[\s\S]*"recommendations"[\s\S]*\}/);
      if (rawMatch) return JSON.parse(rawMatch[0]);
    } catch {
      logger.warn('Failed to parse recommendation JSON from pipeline output', { runId });
    }
    return null;
  }
}

export default new AssignmentPipelineService();
