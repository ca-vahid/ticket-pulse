import Anthropic from '@anthropic-ai/sdk';
import config from '../config/index.js';
import assignmentRepository from './assignmentRepository.js';
import promptRepository from './promptRepository.js';
import availabilityService from './availabilityService.js';
import { TOOL_SCHEMAS, executeTool } from './assignmentTools.js';
import freshServiceActionService from './freshServiceActionService.js';
import competencyFeedbackService from './competencyFeedbackService.js';
import { formatDateInTimezone } from '../utils/timezone.js';
import { formatInTimeZone } from 'date-fns-tz';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
// Pure helper extracted to its own module so unit tests can exercise the
// rebound-context user-message logic without pulling in Prisma/Anthropic.
import { buildUserMessage } from './assignmentUserMessage.js';

const MAX_TURNS = 20;
const CLOSED_STATUSES = ['Closed', 'Resolved', 'closed', 'resolved', 'Deleted', 'Spam', '4', '5'];

class AssignmentPipelineService {
  /**
   * Run the agentic assignment pipeline with streaming.
   * Automatic triggers are queued outside business hours.
   * Manual triggers always execute immediately.
   */
  async runPipeline(ticketId, workspaceId, triggerSource = 'manual', onEvent = null, signal = null, options = {}) {
    const pipelineStart = Date.now();
    const emit = (event) => { try { onEvent?.(event); } catch { /* SSE write errors are non-fatal */ } };
    const isManual = triggerSource === 'manual';
    // reboundFrom: { previousTechId, previousTechName, unassignedAt, unassignedByName, reboundCount }
    // Set when this run is being created because the ticket bounced back from
    // a prior assignee. Persisted on the run so the UI / LLM can show context.
    const reboundFrom = options.reboundFrom || null;

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
      // Queue-time validation: never queue a ticket that is already closed,
      // deleted, or assigned. Without this guard the email poller floods the
      // queue with noise — security alerts, marketing emails, and FS tickets
      // that were auto-deleted as spam all get pulled in by subject regex
      // matching. (The same validation runs at drain time, but by then the
      // queue UI is already polluted with stale items.)
      const queueGuard = await this._validateForQueue(ticketId);
      if (!queueGuard.valid) {
        logger.info('Pipeline queue rejected: ticket not eligible', {
          ticketId, workspaceId, triggerSource, reason: queueGuard.reason,
        });
        emit({ type: 'error', message: `Ticket not eligible for queue: ${queueGuard.reason}` });
        emit({ type: 'complete' });
        return { skipped: true, reason: 'not_eligible_for_queue', detail: queueGuard.reason };
      }

      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { defaultTimezone: true },
      });
      const tz = workspace?.defaultTimezone || 'America/Los_Angeles';
      const bh = await availabilityService.isBusinessHours(new Date(), tz, workspaceId);

      if (!bh.isBusinessHours) {
        let queuedReason = bh.reason || 'Outside business hours';
        // For rebound runs, prefix the reason with rebound context so the
        // queue UI immediately shows why this is back here.
        if (reboundFrom?.previousTechName) {
          const when = reboundFrom.unassignedAt ? ` at ${new Date(reboundFrom.unassignedAt).toISOString()}` : '';
          const who = reboundFrom.unassignedByName ? ` by ${reboundFrom.unassignedByName}` : '';
          queuedReason = `Returned from ${reboundFrom.previousTechName}${when}${who} — ${queuedReason}`;
        }
        let run;
        try {
          run = await assignmentRepository.createQueuedRun({
            ticketId, workspaceId, triggerSource, queuedReason, reboundFrom,
          });
        } catch (error) {
          const existingRun = await assignmentRepository.getOpenPipelineRun(ticketId);
          if (existingRun) {
            logger.info('Pipeline queue skipped: open run was created concurrently', {
              ticketId,
              existingRunId: existingRun.id,
              existingStatus: existingRun.status,
              triggerSource,
            });
            emit({ type: 'error', message: `Pipeline already ${existingRun.status} for this ticket (run #${existingRun.id})` });
            emit({ type: 'complete' });
            return { skipped: true, reason: 'open_run_exists', existingRunId: existingRun.id };
          }
          throw error;
        }
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
    let run;
    try {
      run = await assignmentRepository.createPipelineRun({
        ticketId,
        workspaceId,
        status: 'running',
        triggerSource,
        llmModel: assignmentConfig.llmModel,
        promptVersionId: promptVersion.id,
        reboundFrom,
      });
    } catch (error) {
      const existingRun = await assignmentRepository.getOpenPipelineRun(ticketId);
      if (existingRun) {
        logger.info('Pipeline start skipped: open run was created concurrently', {
          ticketId,
          existingRunId: existingRun.id,
          existingStatus: existingRun.status,
          triggerSource,
        });
        emit({ type: 'error', message: `Pipeline already ${existingRun.status} for this ticket (run #${existingRun.id})` });
        emit({ type: 'complete' });
        return { skipped: true, reason: 'open_run_exists', existingRunId: existingRun.id };
      }
      throw error;
    }

    return this._executeRun(run.id, ticketId, workspaceId, triggerSource, pipelineStart, emit, signal);
  }

  /**
   * Validate a ticket is eligible to enter the queue. Mirrors
   * validateQueuedRun but takes a ticketId directly (no run needed).
   * Used at queue-time so closed/deleted/assigned tickets never get
   * queued in the first place.
   */
  async _validateForQueue(ticketId) {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { status: true, assignedTechId: true },
    });
    if (!ticket) return { valid: false, reason: 'Ticket not found in database' };
    if (CLOSED_STATUSES.includes(ticket.status)) {
      return { valid: false, reason: `Ticket already ${ticket.status}` };
    }
    if (ticket.assignedTechId) {
      return { valid: false, reason: 'Ticket already assigned to a technician' };
    }
    return { valid: true };
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

    systemPrompt += '\n\n## Time Handling\nTreat the workspace current date/time supplied in the user message as the source of truth for what "today" means. Tool outputs expose ticket and decision timestamps in workspace-local time unless explicitly labeled as UTC. Agent availability includes each technician\'s own local date/time. Historical admin feedback may contain legacy UTC timestamps from older runs, so prefer current workspace-local timestamps when there is any ambiguity.';

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { defaultTimezone: true },
    });
    const wsTz = workspace?.defaultTimezone || 'America/Los_Angeles';
    const now = new Date();
    const localDate = formatDateInTimezone(now, wsTz);
    const localTime = formatInTimeZone(now, wsTz, 'HH:mm');
    const dayOfWeek = formatInTimeZone(now, wsTz, 'EEEE');

    // Pull rebound metadata that syncService persisted on the run record so we
    // can surface it to the LLM in the first user message. Without this the LLM
    // is blind to the fact that this run is a rerouting after a rejection,
    // which leads to repeating the same pick or producing a generic agent
    // briefing that doesn't acknowledge the bounce.
    let reboundFrom = null;
    try {
      const runRecord = await prisma.assignmentPipelineRun.findUnique({
        where: { id: runId },
        select: { reboundFrom: true },
      });
      reboundFrom = runRecord?.reboundFrom || null;
    } catch (err) {
      logger.debug('Could not load reboundFrom for pipeline run', { runId, error: err.message });
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
    let totalTokens = 0;
    let stepCounter = 0;
    let fullTranscript = '';
    let lastHeartbeatAt = Date.now();
    let heartbeatPromise = Promise.resolve();

    const queueHeartbeat = () => {
      const now = Date.now();
      if (now - lastHeartbeatAt < 10000) {
        return;
      }

      lastHeartbeatAt = now;
      heartbeatPromise = heartbeatPromise
        .then(() => assignmentRepository.touchPipelineRun(runId))
        .catch((error) => logger.debug('Pipeline heartbeat failed', { runId, error: error.message }));
    };

    // Pure helper at module scope; see buildUserMessage above. Surfaces the
    // rebound state explicitly so the LLM (a) actively avoids the prior
    // rejecter via the previouslyRejectedThisTicket flag from
    // find_matching_agents, and (b) knows to acknowledge the re-routing in
    // agentBriefingHtml without naming the previous assignee.
    const messages = [
      { role: 'user', content: buildUserMessage({ ticketId, dayOfWeek, localDate, localTime, wsTz, reboundFrom }) },
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
          queueHeartbeat();
        });

        let toolJsonLength = 0;
        let lastProgressAt = 0;
        stream.on('inputJson', (partialJson) => {
          toolJsonLength += partialJson.length;
          queueHeartbeat();
          const now = Date.now();
          if (now - lastProgressAt > 1000) {
            lastProgressAt = now;
            const kb = (toolJsonLength / 1024).toFixed(1);
            emit({ type: 'thinking', kb: parseFloat(kb) });
          }
        });

        const finalMessage = await stream.finalMessage();
        const usage = finalMessage?.usage || {};
        totalTokens += Object.values(usage).reduce((sum, value) => (
          typeof value === 'number' ? sum + value : sum
        ), 0);

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
            queueHeartbeat();

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
            queueHeartbeat();

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

      // Detect "LLM ignored the prompt and re-suggested a prior rejecter" so we
      // don't auto-assign a ticket back to the agent who just bounced it. The
      // preflight check would catch this at the FS layer too, but downgrading
      // here avoids the FS round-trip and produces a cleaner state.
      let llmIgnoredRebound = false;
      if (recommendation && triggerSource === 'rebound' && topRec?.techId) {
        try {
          const rejectedByTopRec = await prisma.ticketAssignmentEpisode.findFirst({
            where: {
              ticketId,
              technicianId: topRec.techId,
              endMethod: 'rejected',
            },
            select: { id: true },
          });
          if (rejectedByTopRec) {
            llmIgnoredRebound = true;
            logger.warn('Pipeline rebound: LLM picked a prior rejecter as top recommendation, downgrading to pending_review', {
              runId, ticketId, topRecTechId: topRec.techId,
            });
          }
        } catch (err) {
          logger.debug('Could not check for prior rejection of top recommendation', { runId, error: err.message });
        }
      }

      let decision;
      if (!recommendation) {
        decision = null;
      } else if (isNoise) {
        decision = 'noise_dismissed';
      } else if (llmIgnoredRebound) {
        // Force manual review when the LLM ignored the rebound constraint.
        decision = 'pending_review';
      } else if (assignmentConfig?.autoAssign) {
        decision = 'auto_assigned';
      } else {
        decision = 'pending_review';
      }

      const finalStatus = recommendation ? 'completed' : 'failed_schema_validation';
      let errorMessage = recommendation ? null : 'Could not extract structured recommendation from LLM output';
      if (llmIgnoredRebound) {
        errorMessage = `LLM re-suggested ${topRec.techName || `tech #${topRec.techId}`}, who already rejected this ticket — downgraded to pending_review for manual handling.`;
      }

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
