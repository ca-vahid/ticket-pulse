import competencyPromptRepository from './competencyPromptRepository.js';
import competencyRepository from './competencyRepository.js';
import { COMPETENCY_TOOL_SCHEMAS, executeCompetencyTool } from './competencyTools.js';
import prisma from './prisma.js';
import { findBestCategoryMatch } from '../utils/categoryMatcher.js';
import { normalizeAiModel, providerForModel } from '../utils/aiProviders.js';
import { isSkillHierarchyWorkspace } from '../utils/workspaceFeatureFlags.js';
import providerGateway from './aiProviders/providerGateway.js';
import logger from '../utils/logger.js';

const MAX_TURNS = 15;
const LEVEL_RANK = { basic: 1, intermediate: 2, advanced: 3, expert: 4 };
const RANK_LEVEL = { 1: 'basic', 2: 'intermediate', 3: 'advanced', 4: 'expert' };

function maxLevelForCleanEvidence(cleanTicketCount) {
  if (cleanTicketCount >= 6) return 'expert';
  if (cleanTicketCount >= 3) return 'advanced';
  if (cleanTicketCount >= 2) return 'intermediate';
  if (cleanTicketCount >= 1) return 'basic';
  return null;
}

function capProficiencyLevel(requestedLevel, maxLevel) {
  if (!maxLevel) return null;
  const requestedRank = LEVEL_RANK[requestedLevel] || LEVEL_RANK.intermediate;
  const maxRank = LEVEL_RANK[maxLevel] || LEVEL_RANK.basic;
  return RANK_LEVEL[Math.min(requestedRank, maxRank)] || 'basic';
}

function resolveSuggestedParentId(comp, categories) {
  if (comp.parentCategoryId) {
    const parent = categories.find((category) => category.id === Number(comp.parentCategoryId) && !category.parentId);
    if (parent) return parent.id;
  }
  if (comp.parentCategoryName) {
    const parent = categories.find((category) => (
      !category.parentId
      && category.name.toLowerCase() === String(comp.parentCategoryName).trim().toLowerCase()
    ));
    if (parent) return parent.id;
  }
  return null;
}

class CompetencyAnalysisService {
  async runAnalysis(technicianId, workspaceId, triggeredBy = 'admin', onEvent = null) {
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
      where: { workspaceId, technicianId, status: 'running' },
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
    const llmProvider = providerForModel(assignmentConfig?.llmModel, 'anthropic');
    const llmModel = normalizeAiModel(assignmentConfig?.llmModel, llmProvider, null, 'competency_analysis');

    const beforeSnapshot = await this._captureSnapshot(technicianId, workspaceId);

    const run = await prisma.competencyAnalysisRun.create({
      data: {
        workspaceId,
        technicianId,
        status: 'running',
        promptVersionId: promptVersion.id,
        llmProvider,
        llmModel,
        triggeredBy,
        beforeSnapshot,
      },
    });

    emit({ type: 'run_started', runId: run.id, technicianId, techName: tech.name, promptVersion: promptVersion.version });
    let totalTokens = 0;
    let resolvedProvider = llmProvider;
    let resolvedModel = llmModel;
    let llmFallbackUsed = false;
    let llmFallbackReason = null;
    let llmAttemptCount = 0;
    let stepCounter = 0;
    let fullTranscript = '';

    const userMsg = `Analyze the competencies of technician ID ${technicianId} (${tech.name}). Use the available tools to research their ticket history, then call submit_competency_assessment with your final assessment.`;

    const messages = [
      { role: 'user', content: userMsg },
    ];

    const tools = COMPETENCY_TOOL_SCHEMAS.map((t) => ({ ...t, eager_input_streaming: true }));
    const context = { workspaceId, technicianId };

    try {
      let continueLoop = true;
      let assessment = null;

      while (continueLoop && stepCounter < MAX_TURNS) {
        stepCounter++;
        emit({ type: 'turn_start', turn: stepCounter });

        let toolJsonLength = 0;
        let lastProgressAt = 0;
        const turnResult = await providerGateway.runToolTurn({
          operation: 'competency_analysis',
          workspaceId,
          legacyModel: assignmentConfig?.llmModel,
          runLinks: { competencyAnalysisRunId: run.id },
          systemPrompt: promptVersion.systemPrompt,
          tools,
          messages,
          maxTokens: 8192,
          emit,
          onText: (text) => {
            fullTranscript += text;
            emit({ type: 'text', text });
          },
          onInputJson: (partialJson) => {
            toolJsonLength += partialJson.length;
            const now = Date.now();
            if (now - lastProgressAt > 1000) {
              lastProgressAt = now;
              const kb = (toolJsonLength / 1024).toFixed(1);
              emit({ type: 'thinking', kb: parseFloat(kb) });
            }
          },
          onThinking: (chunk) => {
            if (chunk) emit({ type: 'thinking', text: chunk });
          },
        });

        const finalMessage = turnResult.message;
        totalTokens += turnResult.usage?.totalTokens || 0;
        resolvedProvider = turnResult.provider;
        resolvedModel = turnResult.model;
        llmFallbackUsed = llmFallbackUsed || turnResult.fallbackUsed;
        llmFallbackReason = turnResult.fallbackReason || llmFallbackReason;
        llmAttemptCount += turnResult.attemptNumber || 1;

        await prisma.competencyAnalysisRun.update({
          where: { id: run.id },
          data: {
            llmProvider: resolvedProvider,
            llmModel: resolvedModel,
            llmFallbackUsed,
            llmFallbackReason,
            llmAttemptCount,
          },
        });

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
          data: {
            status: 'failed',
            errorMessage: errMsg,
            fullTranscript,
            totalTokensUsed: totalTokens,
            totalDurationMs: Date.now() - pipelineStart,
            llmProvider: resolvedProvider,
            llmModel: resolvedModel,
            llmFallbackUsed,
            llmFallbackReason,
            llmAttemptCount,
          },
        });
        emit({ type: 'error', message: errMsg });
        emit({ type: 'complete', runId: run.id });
        return await this._getRunWithSteps(run.id);
      }

      // Auto-apply: create new categories and update competency mappings
      const applyResult = await this._applyAssessment(technicianId, workspaceId, assessment);
      const afterSnapshot = await this._captureSnapshot(technicianId, workspaceId);
      const decision = applyResult.preservedExisting ? 'preserved_existing' : 'auto_applied';

      const structuredResult = { ...assessment, applyResult };

      await prisma.competencyAnalysisRun.update({
        where: { id: run.id },
        data: {
          status: 'completed',
          decision,
          structuredResult,
          afterSnapshot,
          fullTranscript,
          totalTokensUsed: totalTokens,
          totalDurationMs: Date.now() - pipelineStart,
          llmProvider: resolvedProvider,
          llmModel: resolvedModel,
          llmFallbackUsed,
          llmFallbackReason,
          llmAttemptCount,
        },
      });

      emit({ type: 'assessment', data: structuredResult, applyResult });
      logger.info('Competency analysis completed', {
        runId: run.id, technicianId, techName: tech.name,
        decision,
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
        data: {
          status: 'failed',
          fullTranscript,
          errorMessage: error.message,
          totalTokensUsed: totalTokens,
          totalDurationMs: Date.now() - pipelineStart,
          llmProvider: resolvedProvider,
          llmModel: resolvedModel,
          llmFallbackUsed,
          llmFallbackReason,
          llmAttemptCount,
        },
      });
      emit({ type: 'error', message: error.message });
      emit({ type: 'complete', runId: run.id });
      return await this._getRunWithSteps(run.id);
    }
  }

  async _applyAssessment(technicianId, workspaceId, assessment) {
    if (!isSkillHierarchyWorkspace(workspaceId)) {
      return this._applyLegacyAssessment(technicianId, workspaceId, assessment);
    }

    const competencies = assessment.competencies || [];
    let newCategories = 0;
    let skippedMissingId = 0;
    let skippedInvalidId = 0;
    let skippedNameOnly = 0;
    let skippedDuplicateSuggestion = 0;
    let skippedInvalidSuggestionParent = 0;
    let skippedNoCanonicalEvidence = 0;
    let skippedInsufficientCleanEvidence = 0;
    let skippedParentCoveredBySubskills = 0;
    let cappedByCleanEvidence = 0;

    const cleanEvidenceStats = await this._getCleanCanonicalEvidenceStats(technicianId, workspaceId);
    const cleanEvidenceCategoryIds = new Set(cleanEvidenceStats.keys());
    const activeExisting = await prisma.competencyCategory.findMany({
      where: { workspaceId, isActive: true },
      select: { id: true, name: true, parentId: true, isActive: true },
    });
    const activeById = new Map(activeExisting.map((category) => [category.id, category]));
    const allExisting = await prisma.competencyCategory.findMany({
      where: { workspaceId },
      select: { id: true, name: true, parentId: true, isActive: true },
    });
    const allNames = new Set(allExisting.map((category) => category.name.trim().toLowerCase()));
    const existingTechnicianCompetencies = await prisma.technicianCompetency.findMany({
      where: { technicianId, workspaceId },
      select: { competencyCategoryId: true, proficiencyLevel: true, notes: true },
    });
    const mappingsByCategoryId = new Map(existingTechnicianCompetencies.map((mapping) => [
      mapping.competencyCategoryId,
      {
        competencyCategoryId: mapping.competencyCategoryId,
        proficiencyLevel: mapping.proficiencyLevel,
        notes: mapping.notes || null,
      },
    ]));
    let changedMappings = 0;

    for (const comp of competencies) {
      const normalizedName = (comp.categoryName || '').trim().replace(/\s+/g, ' ');
      const action = comp.categoryAction || 'reuse_existing';

      if (action === 'create_new') {
        if (!normalizedName) {
          logger.warn('Skipping taxonomy-gap suggestion without categoryName', { technicianId, workspaceId });
          continue;
        }

        if (allNames.has(normalizedName.toLowerCase())) {
          skippedDuplicateSuggestion++;
          logger.info('Skipped taxonomy-gap suggestion because a category with that name already exists', {
            workspaceId, categoryName: normalizedName, technicianId,
          });
          continue;
        }

        const parentId = resolveSuggestedParentId(comp, activeExisting);
        if (isSkillHierarchyWorkspace(workspaceId) && !parentId) {
          skippedInvalidSuggestionParent++;
          logger.warn('Skipped top-level taxonomy-gap suggestion in canonical category workspace', {
            workspaceId,
            categoryName: normalizedName,
            parentCategoryId: comp.parentCategoryId || null,
            parentCategoryName: comp.parentCategoryName || null,
            technicianId,
          });
          continue;
        }

        if (!parentId && (comp.parentCategoryId || comp.parentCategoryName)) {
          skippedInvalidSuggestionParent++;
          logger.warn('Skipped taxonomy-gap suggestion with invalid parent category', {
            workspaceId,
            categoryName: normalizedName,
            parentCategoryId: comp.parentCategoryId || null,
            parentCategoryName: comp.parentCategoryName || null,
            technicianId,
          });
          continue;
        }

        await prisma.competencyCategory.create({
          data: {
            workspaceId,
            name: normalizedName,
            description: comp.categoryDescription || comp.evidenceSummary || null,
            parentId,
            isActive: false,
            isSystemSuggested: true,
            source: 'technician_analysis_gap',
          },
        });
        allNames.add(normalizedName.toLowerCase());
        newCategories++;
        logger.info('Created inactive taxonomy-gap suggestion from competency analysis', {
          workspaceId, categoryName: normalizedName, parentId, technicianId,
        });
        continue;
      }

      if (!comp.categoryId) {
        skippedMissingId++;
        skippedNameOnly += normalizedName ? 1 : 0;
        logger.warn('Skipping competency assessment item without canonical categoryId', {
          technicianId, workspaceId, categoryName: normalizedName || null,
        });
        continue;
      }

      const category = activeById.get(Number(comp.categoryId));
      if (!category) {
        skippedInvalidId++;
        logger.warn('Skipping competency assessment item with inactive or invalid canonical categoryId', {
          technicianId,
          workspaceId,
          categoryId: comp.categoryId,
          categoryName: normalizedName || null,
        });
        continue;
      }

      const existing = mappingsByCategoryId.get(category.id);
      if (!cleanEvidenceCategoryIds.has(category.id)) {
        skippedNoCanonicalEvidence++;
        logger.warn('Skipping competency assessment item without clean canonical ticket evidence', {
          technicianId,
          workspaceId,
          categoryId: category.id,
          categoryName: normalizedName || category.name,
        });
        continue;
      }

      if (!category.parentId) {
        const hasCoveredChild = activeExisting.some((candidate) => (
          candidate.parentId === category.id && mappingsByCategoryId.has(candidate.id)
        ));
        if (hasCoveredChild) {
          skippedParentCoveredBySubskills++;
          logger.info('Skipping parent competency because supported subcategory competency already exists', {
            technicianId,
            workspaceId,
            categoryId: category.id,
            categoryName: normalizedName || category.name,
          });
          continue;
        }
      }

      const cleanTicketCount = cleanEvidenceStats.get(category.id)?.cleanTicketCount || 0;
      const maxLevel = maxLevelForCleanEvidence(cleanTicketCount);
      if (!maxLevel) {
        skippedNoCanonicalEvidence++;
        continue;
      }
      if (cleanTicketCount < 2 && !existing) {
        skippedInsufficientCleanEvidence++;
        logger.warn('Skipping new competency assessment item with only one clean canonical ticket', {
          technicianId,
          workspaceId,
          categoryId: category.id,
          categoryName: normalizedName || category.name,
          cleanTicketCount,
        });
        continue;
      }

      const requestedLevel = comp.proficiencyLevel || 'intermediate';
      const cappedLevel = capProficiencyLevel(requestedLevel, maxLevel);
      const existingRank = existing ? (LEVEL_RANK[existing.proficiencyLevel] || 0) : 0;
      const cappedRank = LEVEL_RANK[cappedLevel] || 0;
      const preservingExistingDueToSparseEvidence = existing && existingRank > cappedRank;
      const finalLevel = preservingExistingDueToSparseEvidence ? existing.proficiencyLevel : cappedLevel;
      const finalNotes = preservingExistingDueToSparseEvidence
        ? existing.notes
        : (comp.evidenceSummary || existing?.notes || null);
      if (finalLevel !== requestedLevel) cappedByCleanEvidence++;

      const previous = mappingsByCategoryId.get(category.id);
      if (!previous || previous.proficiencyLevel !== finalLevel || previous.notes !== finalNotes) {
        changedMappings++;
      }
      mappingsByCategoryId.set(category.id, {
        competencyCategoryId: category.id,
        proficiencyLevel: finalLevel,
        notes: finalNotes,
      });
    }

    const mappings = Array.from(mappingsByCategoryId.values());
    if (changedMappings === 0) {
      logger.warn('No valid canonical competency mappings returned; preserving existing technician competencies', {
        technicianId,
        workspaceId,
        submittedCount: competencies.length,
        skippedMissingId,
        skippedInvalidId,
        skippedNoCanonicalEvidence,
        newCategories,
      });
      return {
        applied: 0,
        newCategories,
        skippedMissingId,
        skippedInvalidId,
        skippedNameOnly,
        skippedDuplicateSuggestion,
        skippedInvalidSuggestionParent,
        skippedNoCanonicalEvidence,
        skippedInsufficientCleanEvidence,
        skippedParentCoveredBySubskills,
        cappedByCleanEvidence,
        changedMappings: 0,
        preservedExisting: true,
        preserveReason: 'No submitted skill changes had enough clean canonical Ticket Pulse ticket evidence. Existing technician skills were preserved.',
      };
    }

    await competencyRepository.bulkUpdateTechnicianCompetencies(technicianId, workspaceId, mappings);

    return {
      applied: mappings.length,
      newCategories,
      skippedMissingId,
      skippedInvalidId,
      skippedNameOnly,
      skippedDuplicateSuggestion,
      skippedInvalidSuggestionParent,
      skippedNoCanonicalEvidence,
      skippedInsufficientCleanEvidence,
      skippedParentCoveredBySubskills,
      cappedByCleanEvidence,
      changedMappings,
      preservedExisting: false,
    };
  }

  async _applyLegacyAssessment(technicianId, workspaceId, assessment) {
    const competencies = assessment.competencies || [];
    let newCategories = 0;
    let fuzzyMatches = 0;
    const mappings = [];

    const allExisting = await prisma.competencyCategory.findMany({
      where: { workspaceId, isActive: true },
      select: { id: true, name: true, parentId: true, isActive: true },
    });

    for (const comp of competencies) {
      let category;
      const normalizedName = (comp.categoryName || '').trim().replace(/\s+/g, ' ');
      if (!comp.categoryId && !normalizedName) {
        logger.warn('Skipping legacy competency assessment item without categoryId or categoryName', { technicianId, workspaceId });
        continue;
      }

      if (comp.categoryId) {
        category = allExisting.find((c) => c.id === Number(comp.categoryId));
      }

      if (!category) {
        category = allExisting.find((c) => c.name.toLowerCase() === normalizedName.toLowerCase());
      }

      if (!category) {
        const { match, score, reason } = findBestCategoryMatch(normalizedName, allExisting);
        if (match) {
          category = match;
          fuzzyMatches++;
          logger.info('Fuzzy-matched proposed legacy category to existing', {
            proposed: normalizedName,
            matched: match.name,
            score,
            reason,
            technicianId,
            workspaceId,
          });
        }
      }

      if (!category) {
        const parentId = resolveSuggestedParentId(comp, allExisting);
        await prisma.competencyCategory.create({
          data: {
            workspaceId,
            name: normalizedName,
            description: comp.categoryDescription || comp.evidenceSummary || null,
            parentId,
            isActive: false,
            isSystemSuggested: true,
            source: 'technician_analysis',
          },
        });
        newCategories++;
        logger.info('Created inactive system-suggested legacy competency category', {
          workspaceId,
          categoryName: normalizedName,
          technicianId,
        });
        continue;
      }

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

    return {
      applied: mappings.length,
      newCategories,
      fuzzyMatches,
      legacyCategoryMode: true,
    };
  }

  async _getCleanCanonicalEvidenceStats(technicianId, workspaceId, days = 180) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const rows = await prisma.ticket.findMany({
      where: {
        workspaceId,
        assignedTechId: technicianId,
        createdAt: { gte: since },
        internalCategoryId: { not: null },
      },
      select: {
        internalCategoryId: true,
        internalSubcategoryId: true,
        internalCategoryFit: true,
        internalSubcategoryFit: true,
        taxonomyReviewNeeded: true,
      },
      take: 1000,
    });

    const stats = new Map();
    const addCleanTicket = (categoryId) => {
      if (!categoryId) return;
      const existing = stats.get(categoryId) || { cleanTicketCount: 0 };
      existing.cleanTicketCount += 1;
      stats.set(categoryId, existing);
    };
    for (const row of rows) {
      if (row.taxonomyReviewNeeded) continue;
      if (row.internalCategoryFit === 'weak' || row.internalCategoryFit === 'none') continue;
      if (row.internalSubcategoryId && (row.internalSubcategoryFit === 'weak' || row.internalSubcategoryFit === 'none')) continue;

      addCleanTicket(row.internalCategoryId);
      addCleanTicket(row.internalSubcategoryId);
    }
    return stats;
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
