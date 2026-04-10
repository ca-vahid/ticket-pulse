import Anthropic from '@anthropic-ai/sdk';
import appConfig from '../config/index.js';
import promptRepository from './promptRepository.js';
import competencyAnalysisService from './competencyAnalysisService.js';
import prisma from './prisma.js';
import logger from '../utils/logger.js';

class CalibrationService {
  async runCalibration(workspaceId, periodStart, periodEnd, triggeredBy, onEvent) {
    const pipelineStart = Date.now();
    const emit = (event) => { try { onEvent?.(event); } catch { /* non-fatal */ } };

    const staleBefore = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.calibrationRun.updateMany({
      where: { status: { in: ['running', 'collecting', 'analyzing_prompt', 'analyzing_competencies'] }, updatedAt: { lt: staleBefore } },
      data: { status: 'failed', errorMessage: 'Marked stale after 60 minutes without completion' },
    });

    const existing = await prisma.calibrationRun.findFirst({
      where: { workspaceId, status: { in: ['running', 'collecting', 'analyzing_prompt', 'analyzing_competencies'] } },
    });
    if (existing) {
      emit({ type: 'error', message: `Calibration already running (run #${existing.id})` });
      emit({ type: 'complete' });
      return { skipped: true, reason: 'already_running' };
    }

    const assignmentConfig = await prisma.assignmentConfig.findUnique({
      where: { workspaceId },
      select: { llmModel: true },
    });
    const llmModel = assignmentConfig?.llmModel || 'claude-sonnet-4-6-20260217';

    const run = await prisma.calibrationRun.create({
      data: {
        workspaceId,
        status: 'collecting',
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        triggeredBy,
        llmModel,
      },
    });

    emit({ type: 'calibration_started', runId: run.id, periodStart, periodEnd });

    try {
      // Phase 1: Collect and classify
      emit({ type: 'phase_update', phase: 'collecting', message: 'Collecting pipeline runs and classifying outcomes...' });
      const classified = await this._collectAndClassify(workspaceId, periodStart, periodEnd);

      await prisma.calibrationRun.update({
        where: { id: run.id },
        data: {
          totalRuns: classified.totalRuns,
          outcome1Count: classified.outcome1Count,
          outcome2Count: classified.outcome2Count,
          outcome3Count: classified.outcome3Count,
          unresolvedCount: classified.unresolvedCount,
          classifiedData: classified,
        },
      });

      emit({
        type: 'classification_complete',
        totalRuns: classified.totalRuns,
        outcome1: classified.outcome1Count,
        outcome2: classified.outcome2Count,
        outcome3: classified.outcome3Count,
        unresolved: classified.unresolvedCount,
      });

      if (classified.totalRuns === 0) {
        await prisma.calibrationRun.update({
          where: { id: run.id },
          data: { status: 'completed', totalDurationMs: Date.now() - pipelineStart },
        });
        emit({ type: 'phase_update', phase: 'completed', message: 'No decided pipeline runs found in the selected period.' });
        emit({ type: 'calibration_complete', runId: run.id });
        return await this._getRun(run.id);
      }

      // Phase 2: Prompt analysis
      await prisma.calibrationRun.update({ where: { id: run.id }, data: { status: 'analyzing_prompt' } });
      emit({ type: 'phase_update', phase: 'analyzing_prompt', message: 'Analyzing patterns for prompt improvements...' });

      let promptResult = { findings: [], draftId: null, tokens: 0 };
      try {
        promptResult = await this._analyzePrompt(workspaceId, classified, llmModel, emit);
      } catch (err) {
        logger.error('Calibration prompt analysis failed (continuing)', { runId: run.id, error: err.message });
        emit({ type: 'error', message: `Prompt analysis failed: ${err.message}` });
      }

      await prisma.calibrationRun.update({
        where: { id: run.id },
        data: {
          promptFindings: promptResult.findings,
          promptDraftId: promptResult.draftId,
          promptAnalysisTokens: promptResult.tokens,
          fullTranscript: promptResult.transcript || null,
        },
      });

      emit({
        type: 'prompt_draft_created',
        draftId: promptResult.draftId,
        findings: promptResult.findings || [],
        changeSummary: promptResult.changeSummary || null,
      });

      // Phase 3: Competency updates
      await prisma.calibrationRun.update({ where: { id: run.id }, data: { status: 'analyzing_competencies' } });
      emit({ type: 'phase_update', phase: 'analyzing_competencies', message: 'Identifying technicians needing competency updates...' });

      const flaggedTechs = this._identifyFlaggedTechs(classified);
      const techsTotal = flaggedTechs.length;

      await prisma.calibrationRun.update({
        where: { id: run.id },
        data: { flaggedTechIds: flaggedTechs, techsTotal, techsProcessed: 0 },
      });

      emit({ type: 'competency_flagged', techs: flaggedTechs.map(t => ({ id: t.techId, name: t.techName, reasons: t.reasons })), total: techsTotal });

      const competencyRunMap = {};
      let totalCompetencyTokens = 0;

      for (let i = 0; i < flaggedTechs.length; i++) {
        const tech = flaggedTechs[i];
        emit({ type: 'competency_tech_start', techId: tech.techId, techName: tech.techName, index: i + 1, total: techsTotal });

        try {
          const calibrationContext = {
            periodStart,
            periodEnd,
            signals: tech.signals,
            reasons: tech.reasons,
          };

          const result = await competencyAnalysisService.runAnalysis(
            tech.techId,
            workspaceId,
            `calibration_run_${run.id}`,
            (event) => {
              if (event.type === 'text') {
                emit({ type: 'competency_text', techId: tech.techId, text: event.text });
              } else if (event.type === 'tool_call') {
                emit({ type: 'competency_tool_call', techId: tech.techId, name: event.name });
              } else if (event.type === 'assessment') {
                emit({ type: 'competency_assessment', techId: tech.techId, data: event.data });
              }
            },
            calibrationContext,
          );

          if (!result?.skipped) {
            competencyRunMap[tech.techId] = result.id;
            totalCompetencyTokens += result.totalTokensUsed || 0;
          }

          emit({ type: 'competency_tech_complete', techId: tech.techId, techName: tech.techName, index: i + 1, total: techsTotal, runId: result?.id });
        } catch (err) {
          logger.error('Calibration competency analysis failed for tech', { runId: run.id, techId: tech.techId, error: err.message });
          emit({ type: 'competency_tech_error', techId: tech.techId, techName: tech.techName, error: err.message });
        }

        await prisma.calibrationRun.update({
          where: { id: run.id },
          data: { techsProcessed: i + 1, competencyRunIds: competencyRunMap },
        });
      }

      // Finalize
      const totalTokens = (promptResult.tokens || 0) + totalCompetencyTokens;
      await prisma.calibrationRun.update({
        where: { id: run.id },
        data: {
          status: 'completed',
          competencyRunIds: competencyRunMap,
          totalDurationMs: Date.now() - pipelineStart,
          totalTokensUsed: totalTokens,
        },
      });

      emit({ type: 'phase_update', phase: 'completed', message: 'Calibration complete.' });
      emit({ type: 'calibration_complete', runId: run.id });

      logger.info('Calibration run completed', {
        runId: run.id, workspaceId, totalRuns: classified.totalRuns,
        outcome1: classified.outcome1Count, outcome2: classified.outcome2Count,
        outcome3: classified.outcome3Count, techsFlagged: techsTotal,
        durationMs: Date.now() - pipelineStart, totalTokens,
      });

      return await this._getRun(run.id);

    } catch (error) {
      logger.error('Calibration run failed', { runId: run.id, error: error.message });
      await prisma.calibrationRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          errorMessage: error.message,
          totalDurationMs: Date.now() - pipelineStart,
        },
      });
      emit({ type: 'error', message: error.message });
      emit({ type: 'calibration_complete', runId: run.id });
      return await this._getRun(run.id);
    }
  }

  async _collectAndClassify(workspaceId, periodStart, periodEnd) {
    const runs = await prisma.assignmentPipelineRun.findMany({
      where: {
        workspaceId,
        decision: { notIn: ['noise_dismissed'] },
        decidedAt: { gte: new Date(periodStart), lte: new Date(periodEnd) },
      },
      include: {
        ticket: {
          select: {
            id: true, freshserviceTicketId: true, subject: true,
            assignedTechId: true, category: true, ticketCategory: true,
            assignedTech: { select: { id: true, name: true } },
          },
        },
        assignedTech: { select: { id: true, name: true } },
      },
      orderBy: { decidedAt: 'asc' },
    });

    let outcome1Count = 0;
    let outcome2Count = 0;
    let outcome3Count = 0;
    let unresolvedCount = 0;

    const classifiedRuns = runs.map((run) => {
      const recs = run.recommendation?.recommendations || [];
      const recIds = recs.map(r => r.techId);
      const topRecId = recIds[0] || null;
      const actualTechId = run.ticket?.assignedTechId;
      const actualTechName = run.ticket?.assignedTech?.name || null;

      let outcome;
      if (!actualTechId || !topRecId) {
        outcome = 'unresolved';
        unresolvedCount++;
      } else if (actualTechId === topRecId) {
        outcome = 'top_rec';
        outcome1Count++;
      } else if (recIds.includes(actualTechId)) {
        outcome = 'in_pool';
        outcome2Count++;
      } else {
        outcome = 'outside_pool';
        outcome3Count++;
      }

      return {
        runId: run.id,
        ticketId: run.ticket?.id,
        freshserviceTicketId: run.ticket?.freshserviceTicketId ? Number(run.ticket.freshserviceTicketId) : null,
        subject: run.ticket?.subject,
        category: run.ticket?.ticketCategory || run.ticket?.category,
        decision: run.decision,
        outcome,
        pipelineAssignedTechId: run.assignedTechId,
        pipelineAssignedTechName: run.assignedTech?.name,
        actualTechId,
        actualTechName,
        topRecId,
        topRecName: recs[0]?.techName || null,
        poolIds: recIds,
        poolNames: recs.map(r => r.techName || `Tech #${r.techId}`),
        decisionNote: run.decisionNote,
        overrideReason: run.overrideReason,
        decidedAt: run.decidedAt,
        decidedByEmail: run.decidedByEmail,
      };
    });

    return {
      totalRuns: runs.length,
      outcome1Count,
      outcome2Count,
      outcome3Count,
      unresolvedCount,
      runs: classifiedRuns,
      accuracyRate: runs.length > 0 ? Math.round(((outcome1Count + outcome2Count) / runs.length) * 100) : 0,
    };
  }

  async _analyzePrompt(workspaceId, classifiedData, llmModel, emit) {
    const apiKey = appConfig.anthropic.apiKey;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

    const published = await promptRepository.getPublished(workspaceId);
    const currentPrompt = published.systemPrompt;

    const outcome3Runs = classifiedData.runs.filter(r => r.outcome === 'outside_pool');
    const runsWithNotes = classifiedData.runs.filter(r => r.decisionNote || r.overrideReason);

    const analysisContext = {
      period: { start: classifiedData.runs[0]?.decidedAt, end: classifiedData.runs[classifiedData.runs.length - 1]?.decidedAt },
      summary: {
        totalRuns: classifiedData.totalRuns,
        topRec: classifiedData.outcome1Count,
        inPool: classifiedData.outcome2Count,
        outsidePool: classifiedData.outcome3Count,
        unresolved: classifiedData.unresolvedCount,
        accuracyRate: classifiedData.accuracyRate,
      },
      outsidePoolCases: outcome3Runs.map(r => ({
        ticketSubject: r.subject,
        category: r.category,
        recommendedPool: r.poolNames,
        actualAssignee: r.actualTechName,
        adminNote: r.decisionNote,
        overrideReason: r.overrideReason,
      })),
      adminFeedback: runsWithNotes.map(r => ({
        ticketSubject: r.subject,
        category: r.category,
        decision: r.decision,
        outcome: r.outcome,
        note: r.decisionNote,
        overrideReason: r.overrideReason,
      })),
    };

    const systemPrompt = `You are an expert IT operations analyst tasked with improving an AI ticket assignment system.

You will receive:
1. Performance data from a calibration period showing how well the assignment AI performed
2. Cases where the AI's recommendation was overridden or incorrect
3. Admin feedback and notes about assignment decisions
4. The current system prompt used by the assignment AI

Your job is to:
1. Identify patterns in the mismatches and admin feedback
2. Propose specific, actionable amendments to the assignment system prompt
3. Output the COMPLETE updated prompt with your changes integrated

## Output Format
You MUST respond with a valid JSON object (no markdown fencing) with this structure:
{
  "findings": [
    {
      "pattern": "Brief description of the pattern found",
      "evidence": "Specific examples from the data",
      "confidence": "high|medium|low",
      "suggestedChange": "What should change in the prompt"
    }
  ],
  "updatedPrompt": "The COMPLETE updated system prompt with all amendments applied. Keep the existing structure and add/modify sections as needed. Do NOT remove existing functionality.",
  "changeSummary": "Brief summary of all changes made to the prompt"
}

## Rules
- Be conservative: only suggest changes supported by clear evidence
- Preserve all existing prompt structure and steps
- Add new guidelines as subsections or bullet points within existing steps
- If no changes are needed, return the original prompt unchanged with an empty findings array
- Focus on routing logic, not formatting or style changes`;

    const userMessage = `## Current Assignment System Prompt
\`\`\`
${currentPrompt}
\`\`\`

## Calibration Period Performance Data
${JSON.stringify(analysisContext, null, 2)}

Analyze the data and provide your findings and updated prompt.`;

    const client = new Anthropic({ apiKey });
    let transcript = '';

    const stream = client.messages.stream({
      model: llmModel,
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    stream.on('text', (text) => {
      transcript += text;
      emit({ type: 'prompt_analysis_text', text });
    });

    const finalMessage = await stream.finalMessage();
    const tokens = (finalMessage.usage?.input_tokens || 0) + (finalMessage.usage?.output_tokens || 0);

    let parsed;
    try {
      const jsonStr = transcript.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      logger.warn('Calibration prompt analysis returned non-JSON', { preview: transcript.slice(0, 200) });
      return { findings: [{ pattern: 'Raw analysis', evidence: transcript.slice(0, 2000), confidence: 'medium', suggestedChange: 'Review raw output' }], draftId: null, tokens, transcript };
    }

    let draftId = null;
    if (parsed.updatedPrompt && parsed.updatedPrompt !== currentPrompt) {
      const draft = await promptRepository.createVersion(workspaceId, {
        systemPrompt: parsed.updatedPrompt,
        toolConfig: published.toolConfig,
        notes: `Calibration run auto-generated draft. ${parsed.changeSummary || ''}`.trim(),
        createdBy: 'calibration_system',
      });
      draftId = draft.id;
    }

    return {
      findings: parsed.findings || [],
      draftId,
      tokens,
      transcript,
      changeSummary: parsed.changeSummary || null,
    };
  }

  _identifyFlaggedTechs(classifiedData) {
    const techSignals = new Map();

    const ensureTech = (techId, techName) => {
      if (!techSignals.has(techId)) {
        techSignals.set(techId, { techId, techName, reasons: [], signals: { assignedOutside: [], recommendedNotAssigned: [] } });
      }
    };

    for (const run of classifiedData.runs) {
      // Signal A: Tech actually got a ticket the AI didn't recommend them for
      if (run.outcome === 'outside_pool' && run.actualTechId) {
        ensureTech(run.actualTechId, run.actualTechName);
        const entry = techSignals.get(run.actualTechId);
        entry.signals.assignedOutside.push({
          runId: run.runId, subject: run.subject, category: run.category,
          note: run.decisionNote, overrideReason: run.overrideReason,
        });
        if (!entry.reasons.includes('assigned_outside_recommendations')) {
          entry.reasons.push('assigned_outside_recommendations');
        }
      }

      // Signal B: Tech was the TOP recommendation but someone else got it
      // Only flag the top rec (not everyone in the pool) to avoid over-flagging
      if (run.outcome === 'outside_pool' && run.topRecId && run.topRecId !== run.actualTechId) {
        ensureTech(run.topRecId, run.topRecName);
        const entry = techSignals.get(run.topRecId);
        entry.signals.recommendedNotAssigned.push({
          runId: run.runId, subject: run.subject, category: run.category,
          actualAssignee: run.actualTechName,
        });
        if (!entry.reasons.includes('top_recommendation_overridden')) {
          entry.reasons.push('top_recommendation_overridden');
        }
      }
    }

    return Array.from(techSignals.values()).filter(
      t => t.signals.assignedOutside.length >= 1 || t.signals.recommendedNotAssigned.length >= 2,
    );
  }

  async getRuns(workspaceId, { limit = 20, offset = 0 } = {}) {
    const [items, total] = await Promise.all([
      prisma.calibrationRun.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.calibrationRun.count({ where: { workspaceId } }),
    ]);
    return { items, total };
  }

  async _getRun(id) {
    return await prisma.calibrationRun.findUnique({ where: { id } });
  }
}

export default new CalibrationService();
