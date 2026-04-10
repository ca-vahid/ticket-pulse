import Anthropic from '@anthropic-ai/sdk';
import config from '../config/index.js';
import competencyPromptRepository from './competencyPromptRepository.js';
import competencyRepository from './competencyRepository.js';
import { COMPETENCY_TOOL_SCHEMAS, executeCompetencyTool } from './competencyTools.js';
import prisma from './prisma.js';
import { findBestCategoryMatch } from '../utils/categoryMatcher.js';
import logger from '../utils/logger.js';

const MAX_TURNS = 15;

class CompetencyAnalysisService {
  async runAnalysis(technicianId, workspaceId, triggeredBy = 'admin', onEvent = null, calibrationContext = null) {
    const pipelineStart = Date.now();
    const emit = (event) => { try { onEvent?.(event); } catch { /* non-fatal */ } };

    const tech = await prisma.technician.findFirst({
      where: { id: technicianId, workspaceId },
      select: { id: true, name: true },
    });
    if (!tech) {
      emit({ type: 'error', message: 'Technician not found' });
      emit({ type: 'complete' });
      return { skipped: true, reason: 'tech_not_found' };
    }

    // Sweep stale running competency runs (>30 min old)
    const staleBefore = new Date(Date.now() - 30 * 60 * 1000);
    await prisma.competencyAnalysisRun.updateMany({
      where: { status: 'running', updatedAt: { lt: staleBefore } },
      data: { status: 'failed', errorMessage: 'Marked stale after 30 minutes without completion' },
    });

    const existingRunning = await prisma.competencyAnalysisRun.findFirst({
      where: { technicianId, status: 'running' },
      select: { id: true },
    });
    if (existingRunning) {
      emit({ type: 'error', message: `Analysis already running for ${tech.name} (run #${existingRunning.id})` });
      emit({ type: 'complete' });
      return { skipped: true, reason: 'already_running' };
    }

    const promptVersion = await competencyPromptRepository.getPublished(workspaceId);
    const assignmentConfig = await prisma.assignmentConfig.findUnique({
      where: { workspaceId },
      select: { llmModel: true },
    });
    const llmModel = assignmentConfig?.llmModel || 'claude-sonnet-4-6-20260217';

    const beforeSnapshot = await this._captureSnapshot(technicianId, workspaceId);

    const run = await prisma.competencyAnalysisRun.create({
      data: {
        workspaceId,
        technicianId,
        status: 'running',
        promptVersionId: promptVersion.id,
        llmModel,
        triggeredBy,
        beforeSnapshot,
      },
    });

    emit({ type: 'run_started', runId: run.id, technicianId, techName: tech.name, promptVersion: promptVersion.version });

    const apiKey = config.anthropic.apiKey;
    if (!apiKey) {
      const errMsg = 'ANTHROPIC_API_KEY not configured';
      await prisma.competencyAnalysisRun.update({ where: { id: run.id }, data: { status: 'failed', errorMessage: errMsg, totalDurationMs: Date.now() - pipelineStart } });
      emit({ type: 'error', message: errMsg });
      emit({ type: 'complete', runId: run.id });
      return await this._getRunWithSteps(run.id);
    }

    const client = new Anthropic({ apiKey });
    let totalTokens = 0;
    let stepCounter = 0;
    let fullTranscript = '';

    let userMsg = `Analyze the competencies of technician ID ${technicianId} (${tech.name}). Use the available tools to research their ticket history, then call submit_competency_assessment with your final assessment.`;

    if (calibrationContext) {
      userMsg += `\n\nIMPORTANT: This analysis was triggered by a calibration run. Call get_calibration_signals FIRST to see specific signals about this technician's assignment outcomes. Pay special attention to:\n- Tickets they handled OUTSIDE of AI recommendations (may indicate skills not yet captured in the matrix)\n- Tickets where they were recommended but NOT assigned (may indicate their competency level needs adjustment)\nUse these signals alongside their ticket history to produce a more accurate assessment.`;
    }

    const messages = [
      { role: 'user', content: userMsg },
    ];

    const tools = COMPETENCY_TOOL_SCHEMAS.map((t) => ({ ...t, eager_input_streaming: true }));
    const context = { workspaceId, technicianId, calibrationContext };

    try {
      let continueLoop = true;
      let assessment = null;

      while (continueLoop && stepCounter < MAX_TURNS) {
        stepCounter++;
        emit({ type: 'turn_start', turn: stepCounter });

        const stream = client.messages.stream({
          model: llmModel,
          max_tokens: 8192,
          system: promptVersion.systemPrompt,
          tools,
          messages,
        });

        stream.on('text', (text) => {
          fullTranscript += text;
          emit({ type: 'text', text });
        });

        let toolJsonLength = 0;
        let lastProgressAt = 0;
        stream.on('inputJson', (partialJson) => {
          toolJsonLength += partialJson.length;
          const now = Date.now();
          if (now - lastProgressAt > 1000) {
            lastProgressAt = now;
            const kb = (toolJsonLength / 1024).toFixed(1);
            emit({ type: 'thinking', kb: parseFloat(kb) });
          }
        });

        const finalMessage = await stream.finalMessage();
        totalTokens += (finalMessage.usage?.input_tokens || 0) + (finalMessage.usage?.output_tokens || 0);

        const toolResultMap = new Map();

        for (const block of finalMessage.content) {
          if (block.type === 'tool_use') {
            if (block.name === 'submit_competency_assessment') {
              assessment = block.input;

              await prisma.competencyAnalysisStep.create({
                data: { runId: run.id, stepNumber: stepCounter, stepName: 'submit_competency_assessment', status: 'completed', input: block.input, output: { accepted: true }, durationMs: 0 },
              });

              emit({ type: 'tool_call', name: block.name, input: block.input, toolUseId: block.id });
              toolResultMap.set(block.id, { accepted: true });
              emit({ type: 'tool_result', name: block.name, data: { accepted: true }, durationMs: 0, toolUseId: block.id });
              continue;
            }

            const step = await prisma.competencyAnalysisStep.create({
              data: { runId: run.id, stepNumber: stepCounter, stepName: block.name, status: 'running', input: block.input },
            });

            emit({ type: 'tool_call', name: block.name, input: block.input, toolUseId: block.id });

            const toolStart = Date.now();
            let toolResult;
            try {
              toolResult = await executeCompetencyTool(block.name, block.input, context);
            } catch (err) {
              toolResult = { error: err.message };
            }
            const toolDuration = Date.now() - toolStart;

            toolResultMap.set(block.id, toolResult);

            await prisma.competencyAnalysisStep.update({
              where: { id: step.id },
              data: { status: 'completed', durationMs: toolDuration, output: toolResult },
            });

            emit({ type: 'tool_result', name: block.name, data: toolResult, durationMs: toolDuration, toolUseId: block.id });

            const resultStr = JSON.stringify(toolResult);
            fullTranscript += `\n\n[Tool: ${block.name}] → ${resultStr.slice(0, 500)}${resultStr.length > 500 ? '...' : ''}\n\n`;
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
          continueLoop = assessment === null;
        } else {
          continueLoop = false;
        }
      }

      if (!assessment) {
        const errMsg = 'LLM did not call submit_competency_assessment';
        await prisma.competencyAnalysisRun.update({
          where: { id: run.id },
          data: { status: 'failed', errorMessage: errMsg, fullTranscript, totalTokensUsed: totalTokens, totalDurationMs: Date.now() - pipelineStart },
        });
        emit({ type: 'error', message: errMsg });
        emit({ type: 'complete', runId: run.id });
        return await this._getRunWithSteps(run.id);
      }

      // Auto-apply: create new categories and update competency mappings
      const applyResult = await this._applyAssessment(technicianId, workspaceId, assessment);
      const afterSnapshot = await this._captureSnapshot(technicianId, workspaceId);

      await prisma.competencyAnalysisRun.update({
        where: { id: run.id },
        data: {
          status: 'completed',
          decision: 'auto_applied',
          structuredResult: assessment,
          afterSnapshot,
          fullTranscript,
          totalTokensUsed: totalTokens,
          totalDurationMs: Date.now() - pipelineStart,
        },
      });

      emit({ type: 'assessment', data: assessment, applyResult });
      logger.info('Competency analysis completed and auto-applied', {
        runId: run.id, technicianId, techName: tech.name,
        categoriesApplied: applyResult.applied,
        newCategoriesCreated: applyResult.newCategories,
        durationMs: Date.now() - pipelineStart, totalTokens,
      });

      emit({ type: 'complete', runId: run.id });
      return await this._getRunWithSteps(run.id);

    } catch (error) {
      logger.error('Competency analysis failed', { runId: run.id, technicianId, error: error.message });
      await prisma.competencyAnalysisRun.update({
        where: { id: run.id },
        data: { status: 'failed', fullTranscript, errorMessage: error.message, totalTokensUsed: totalTokens, totalDurationMs: Date.now() - pipelineStart },
      });
      emit({ type: 'error', message: error.message });
      emit({ type: 'complete', runId: run.id });
      return await this._getRunWithSteps(run.id);
    }
  }

  async _applyAssessment(technicianId, workspaceId, assessment) {
    const competencies = assessment.competencies || [];
    let newCategories = 0;
    let fuzzyMatches = 0;
    const mappings = [];

    const allExisting = await prisma.competencyCategory.findMany({
      where: { workspaceId },
      select: { id: true, name: true },
    });

    for (const comp of competencies) {
      let category;
      const normalizedName = (comp.categoryName || '').trim().replace(/\s+/g, ' ');

      // Step 1: Exact case-insensitive match
      category = allExisting.find(
        (c) => c.name.toLowerCase() === normalizedName.toLowerCase(),
      );

      // Step 2: Fuzzy match if no exact match
      if (!category) {
        const { match, score, reason } = findBestCategoryMatch(normalizedName, allExisting);
        if (match) {
          category = match;
          fuzzyMatches++;
          logger.info('Fuzzy-matched proposed category to existing', {
            proposed: normalizedName, matched: match.name, score, reason, technicianId, workspaceId,
          });
        }
      }

      // Step 3: Create new only if no match at all
      if (!category) {
        const dbCategory = await prisma.competencyCategory.create({
          data: { workspaceId, name: normalizedName, description: comp.categoryDescription || null },
        });
        category = dbCategory;
        allExisting.push({ id: dbCategory.id, name: dbCategory.name });
        newCategories++;
        logger.info('Created new competency category (no fuzzy match found)', {
          workspaceId, categoryName: normalizedName, technicianId,
        });
      }

      // Deduplicate: if same category appears twice, keep the higher proficiency
      const LEVEL_RANK = { basic: 1, intermediate: 2, expert: 3 };
      const existing = mappings.find((m) => m.competencyCategoryId === category.id);
      if (existing) {
        const existingRank = LEVEL_RANK[existing.proficiencyLevel] || 0;
        const newRank = LEVEL_RANK[comp.proficiencyLevel] || 0;
        if (newRank > existingRank) {
          existing.proficiencyLevel = comp.proficiencyLevel;
          existing.notes = comp.evidenceSummary || existing.notes;
        }
      } else {
        mappings.push({
          competencyCategoryId: category.id,
          proficiencyLevel: comp.proficiencyLevel || 'intermediate',
          notes: comp.evidenceSummary || null,
        });
      }
    }

    await competencyRepository.bulkUpdateTechnicianCompetencies(technicianId, workspaceId, mappings);

    return { applied: mappings.length, newCategories, fuzzyMatches };
  }

  async rollback(runId, rolledBackBy) {
    const run = await this._getRunWithSteps(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (run.status !== 'completed' || run.decision !== 'auto_applied') {
      throw new Error('Can only rollback auto-applied completed runs');
    }
    if (!run.beforeSnapshot) {
      throw new Error('No before snapshot available for rollback');
    }

    const snapshot = run.beforeSnapshot;
    const mappings = (snapshot.competencies || []).map((c) => ({
      competencyCategoryId: c.competencyCategoryId,
      proficiencyLevel: c.proficiencyLevel,
      notes: c.notes || null,
    }));

    await competencyRepository.bulkUpdateTechnicianCompetencies(run.technicianId, run.workspaceId, mappings);

    await prisma.competencyAnalysisRun.update({
      where: { id: runId },
      data: {
        decision: 'rolled_back',
        rolledBackBy,
        rolledBackAt: new Date(),
      },
    });

    logger.info('Competency analysis rolled back', { runId, technicianId: run.technicianId, rolledBackBy });

    return await this._getRunWithSteps(runId);
  }

  async _captureSnapshot(technicianId, workspaceId) {
    const competencies = await prisma.technicianCompetency.findMany({
      where: { technicianId, workspaceId },
      include: { competencyCategory: { select: { id: true, name: true, description: true } } },
    });

    return {
      capturedAt: new Date().toISOString(),
      competencies: competencies.map((c) => ({
        competencyCategoryId: c.competencyCategoryId,
        categoryName: c.competencyCategory.name,
        categoryDescription: c.competencyCategory.description,
        proficiencyLevel: c.proficiencyLevel,
        notes: c.notes,
      })),
    };
  }

  async _getRunWithSteps(runId) {
    return await prisma.competencyAnalysisRun.findUnique({
      where: { id: runId },
      include: {
        steps: { orderBy: { stepNumber: 'asc' } },
        technician: { select: { id: true, name: true, email: true, location: true } },
      },
    });
  }

  async getRuns(workspaceId, { technicianId, limit = 50, offset = 0 } = {}) {
    const where = { workspaceId };
    if (technicianId) where.technicianId = technicianId;

    const [items, total] = await Promise.all([
      prisma.competencyAnalysisRun.findMany({
        where,
        include: { technician: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.competencyAnalysisRun.count({ where }),
    ]);

    return { items, total };
  }
}

export default new CompetencyAnalysisService();
