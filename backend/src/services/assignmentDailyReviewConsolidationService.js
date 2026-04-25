import Anthropic from '@anthropic-ai/sdk';
import prisma from './prisma.js';
import promptRepository from './promptRepository.js';
import competencyRepository from './competencyRepository.js';
import logger from '../utils/logger.js';
import appConfig from '../config/index.js';

const ACTIVE_STATUSES = ['collecting', 'analyzing', 'saving'];
const APPLYABLE_SECTIONS = ['prompt', 'skills', 'technician_competencies'];
const SECTION_LABELS = {
  prompt: 'Prompt Edits',
  skills: 'Skill List Changes',
  technician_competencies: 'Technician Skill Changes',
  process: 'Process Changes',
};

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function truncate(text, max = 1200) {
  if (!text) return null;
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

function normalizeLevel(value) {
  const level = String(value || '').toLowerCase();
  if (['basic', 'intermediate', 'expert'].includes(level)) return level;
  return 'intermediate';
}

function toSafeBigInt(value) {
  try {
    if (value === null || value === undefined || value === '') return null;
    return BigInt(value);
  } catch {
    return null;
  }
}

function sourceCounts(rows = []) {
  return rows.reduce((acc, row) => {
    acc.total += 1;
    acc[row.kind] = (acc[row.kind] || 0) + 1;
    return acc;
  }, { total: 0, prompt: 0, process: 0, skill: 0 });
}

class AssignmentDailyReviewConsolidationService {
  constructor() {
    this.activeStreams = new Map();
  }

  async kickOff(workspaceId, actorEmail = 'admin') {
    const staleBefore = new Date(Date.now() - 45 * 60 * 1000);
    await prisma.assignmentDailyReviewConsolidationRun.updateMany({
      where: { workspaceId, status: { in: ACTIVE_STATUSES }, updatedAt: { lt: staleBefore } },
      data: { status: 'failed', errorMessage: 'Marked stale after 45 minutes without progress' },
    });

    const existing = await prisma.assignmentDailyReviewConsolidationRun.findFirst({
      where: { workspaceId, status: { in: ACTIVE_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return this.getRun(existing.id, workspaceId);

    const run = await prisma.assignmentDailyReviewConsolidationRun.create({
      data: {
        workspaceId,
        status: 'collecting',
        phase: 'collecting',
        triggeredBy: actorEmail,
        llmModel: 'claude-opus-4-7',
        progress: { phase: 'collecting', message: 'Collecting approved Daily Review recommendations...', percent: 5 },
      },
    });

    await this._recordEvent(run.id, 'progress', 'Collecting approved Daily Review recommendations...', { phase: 'collecting' });

    setImmediate(() => {
      this._run(run.id).catch((error) => {
        logger.error('Daily review consolidation background run failed', { runId: run.id, error: error.message });
      });
    });

    return this.getRun(run.id, workspaceId);
  }

  async getActive(workspaceId) {
    const run = await prisma.assignmentDailyReviewConsolidationRun.findFirst({
      where: { workspaceId, status: { in: [...ACTIVE_STATUSES, 'completed', 'partially_applied'] } },
      orderBy: { createdAt: 'desc' },
    });
    return run ? this.getRun(run.id, workspaceId) : null;
  }

  async getRuns(workspaceId, { limit = 10, offset = 0 } = {}) {
    const [items, total] = await Promise.all([
      prisma.assignmentDailyReviewConsolidationRun.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.assignmentDailyReviewConsolidationRun.count({ where: { workspaceId } }),
    ]);
    return { items, total };
  }

  async getRun(id, workspaceId) {
    const run = await prisma.assignmentDailyReviewConsolidationRun.findUnique({
      where: { id },
      include: {
        items: { orderBy: [{ section: 'asc' }, { id: 'asc' }] },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!run) return null;
    if (workspaceId && run.workspaceId !== workspaceId) {
      throw new Error('Consolidation run belongs to a different workspace');
    }
    return {
      ...run,
      groupedItems: this._groupItems(run.items),
    };
  }

  async updateItem(itemId, workspaceId, { includeInApply, editedPayload, status }) {
    const existing = await prisma.assignmentDailyReviewConsolidationItem.findUnique({
      where: { id: itemId },
      include: { run: { select: { workspaceId: true, status: true } } },
    });
    if (!existing) return null;
    if (existing.workspaceId !== workspaceId || existing.run.workspaceId !== workspaceId) {
      throw new Error('Consolidation item belongs to a different workspace');
    }
    if (existing.status === 'applied') {
      throw new Error('Applied consolidation items cannot be edited');
    }

    const data = {};
    if (includeInApply !== undefined) data.includeInApply = !!includeInApply;
    if (editedPayload !== undefined) data.editedPayload = editedPayload || null;
    if (status !== undefined) data.status = status;

    const updated = await prisma.assignmentDailyReviewConsolidationItem.update({
      where: { id: itemId },
      data,
    });
    return updated;
  }

  async cancel(runId, workspaceId, actorEmail = 'admin') {
    const run = await prisma.assignmentDailyReviewConsolidationRun.findUnique({ where: { id: runId } });
    if (!run) return null;
    if (run.workspaceId !== workspaceId) throw new Error('Consolidation run belongs to a different workspace');
    if (!ACTIVE_STATUSES.includes(run.status)) {
      throw new Error(`Only active consolidation runs can be cancelled (current status: ${run.status})`);
    }

    const stream = this.activeStreams.get(runId);
    if (stream) {
      try { stream.abort(); } catch { /* non-fatal */ }
    }

    await prisma.assignmentDailyReviewConsolidationRun.update({
      where: { id: runId },
      data: {
        status: 'cancelled',
        phase: 'cancelled',
        errorMessage: `Cancelled by ${actorEmail}`,
        completedAt: new Date(),
        progress: { phase: 'cancelled', percent: 100, message: `Cancelled by ${actorEmail}` },
      },
    });
    await this._recordEvent(runId, 'cancelled', `Cancelled by ${actorEmail}`);
    return this.getRun(runId, workspaceId);
  }

  async deleteRun(runId, workspaceId) {
    const run = await prisma.assignmentDailyReviewConsolidationRun.findUnique({ where: { id: runId } });
    if (!run) return null;
    if (run.workspaceId !== workspaceId) throw new Error('Consolidation run belongs to a different workspace');
    if (ACTIVE_STATUSES.includes(run.status)) {
      throw new Error('Cancel an active consolidation run before deleting it');
    }

    await prisma.assignmentDailyReviewConsolidationRun.delete({ where: { id: runId } });
    return { deleted: true, id: runId };
  }

  async apply(runId, workspaceId, {
    applyPrompt = true,
    applySkills = true,
    applyTechnicianCompetencies = true,
    actorEmail = 'admin',
  } = {}) {
    const run = await this.getRun(runId, workspaceId);
    if (!run) throw new Error('Consolidation run not found');
    if (!['completed', 'partially_applied'].includes(run.status)) {
      throw new Error(`Consolidation must be completed before apply (current status: ${run.status})`);
    }

    const selectedSections = {
      prompt: !!applyPrompt,
      skills: !!applySkills,
      technician_competencies: !!applyTechnicianCompetencies,
      process: false,
    };

    const items = run.items.filter((item) => (
      APPLYABLE_SECTIONS.includes(item.section)
      && selectedSections[item.section]
      && item.includeInApply
      && item.status !== 'applied'
    ));

    const appliedSourceIds = new Set();
    const results = [];

    const promptItems = items.filter((item) => item.section === 'prompt');
    if (promptItems.length > 0) {
      const result = await this._applyPromptItem(workspaceId, promptItems[0], actorEmail);
      results.push({ itemId: promptItems[0].id, section: 'prompt', ...result });
      for (const id of toArray(promptItems[0].sourceRecommendationIds)) appliedSourceIds.add(id);
      await prisma.assignmentDailyReviewConsolidationItem.update({
        where: { id: promptItems[0].id },
        data: { status: 'applied', applyResult: result, appliedAt: new Date() },
      });
    }

    for (const item of items.filter((row) => row.section === 'skills')) {
      const result = await this._applySkillItem(workspaceId, item);
      results.push({ itemId: item.id, section: 'skills', ...result });
      for (const id of toArray(item.sourceRecommendationIds)) appliedSourceIds.add(id);
      await prisma.assignmentDailyReviewConsolidationItem.update({
        where: { id: item.id },
        data: { status: 'applied', applyResult: result, appliedAt: new Date() },
      });
    }

    for (const item of items.filter((row) => row.section === 'technician_competencies')) {
      const result = await this._applyTechnicianCompetencyItem(workspaceId, item);
      results.push({ itemId: item.id, section: 'technician_competencies', ...result });
      for (const id of toArray(item.sourceRecommendationIds)) appliedSourceIds.add(id);
      await prisma.assignmentDailyReviewConsolidationItem.update({
        where: { id: item.id },
        data: { status: 'applied', applyResult: result, appliedAt: new Date() },
      });
    }

    // Process items are not directly applyable in the app, but once the
    // consolidation is accepted they should not keep reappearing in the
    // approved-not-applied source set. The saved process item remains as the
    // dev-work record.
    for (const item of run.items.filter((row) => row.section === 'process')) {
      for (const id of toArray(item.sourceRecommendationIds)) appliedSourceIds.add(id);
    }

    const skippedSections = APPLYABLE_SECTIONS.filter((section) => !selectedSections[section]);
    if (skippedSections.length > 0) {
      await prisma.assignmentDailyReviewConsolidationItem.updateMany({
        where: {
          runId,
          section: { in: skippedSections },
          status: 'pending',
        },
        data: { status: 'skipped' },
      });
    }

    if (appliedSourceIds.size > 0) {
      await prisma.assignmentDailyReviewRecommendation.updateMany({
        where: {
          workspaceId,
          id: { in: Array.from(appliedSourceIds) },
          status: 'approved',
        },
        data: {
          status: 'applied',
          appliedBy: actorEmail,
          appliedAt: new Date(),
        },
      });
    }

    const remainingPending = await prisma.assignmentDailyReviewConsolidationItem.count({
      where: { runId, section: { in: APPLYABLE_SECTIONS }, status: 'pending' },
    });
    const appliedCount = await prisma.assignmentDailyReviewConsolidationItem.count({
      where: { runId, status: 'applied' },
    });

    const updatedRun = await prisma.assignmentDailyReviewConsolidationRun.update({
      where: { id: runId },
      data: {
        status: remainingPending > 0 ? 'partially_applied' : 'applied',
        sectionSelection: selectedSections,
        appliedBy: actorEmail,
        appliedAt: new Date(),
        promptDraftId: results.find((item) => item.promptDraftId)?.promptDraftId || run.promptDraftId || null,
        progress: {
          phase: 'applied',
          percent: 100,
          message: remainingPending > 0
            ? `Applied ${appliedCount} item(s); skipped sections remain available.`
            : `Applied ${appliedCount} item(s).`,
        },
      },
    });

    await this._recordEvent(runId, 'applied', 'Selected consolidation sections applied.', { selectedSections, results });
    return this.getRun(updatedRun.id, workspaceId);
  }

  async _run(runId) {
    const startedAt = Date.now();
    const baseRun = await prisma.assignmentDailyReviewConsolidationRun.findUnique({ where: { id: runId } });
    if (!baseRun) return null;

    try {
      await this._updateProgress(runId, 'collecting', 'Loading approved Daily Review recommendations...', 10);
      const context = await this._buildContext(baseRun.workspaceId);

      await prisma.assignmentDailyReviewConsolidationRun.update({
        where: { id: runId },
        data: {
          sourceRecommendationIds: context.sourceRecommendations.map((item) => item.id),
          sourceCounts: sourceCounts(context.sourceRecommendations),
          contextSnapshot: context.snapshot,
        },
      });

      if (context.sourceRecommendations.length === 0) {
        await prisma.assignmentDailyReviewConsolidationRun.update({
          where: { id: runId },
          data: {
            status: 'completed',
            phase: 'completed',
            completedAt: new Date(),
            totalDurationMs: Date.now() - startedAt,
            progress: { phase: 'completed', message: 'No approved recommendations are waiting for consolidation.', percent: 100 },
          },
        });
        await this._recordEvent(runId, 'complete', 'No approved recommendations are waiting for consolidation.');
        return this.getRun(runId, baseRun.workspaceId);
      }

      await this._updateProgress(runId, 'analyzing', 'Running Opus 4.7 consolidation analysis...', 35);
      const analysis = await this._analyze(context, runId);

      await this._updateProgress(runId, 'saving', 'Saving editable consolidation plan...', 88);
      const current = await prisma.assignmentDailyReviewConsolidationRun.findUnique({
        where: { id: runId },
        select: { status: true },
      });
      if (!current || current.status === 'cancelled') {
        return current ? this.getRun(runId, baseRun.workspaceId) : null;
      }
      await prisma.$transaction(async (tx) => {
        await tx.assignmentDailyReviewConsolidationItem.deleteMany({ where: { runId } });
        const rows = this._buildItems(runId, baseRun.workspaceId, analysis.result, context.sourceRecommendations);
        if (rows.length > 0) {
          await tx.assignmentDailyReviewConsolidationItem.createMany({ data: rows });
        }
        await tx.assignmentDailyReviewConsolidationRun.update({
          where: { id: runId },
          data: {
            status: 'completed',
            phase: 'completed',
            rawResult: analysis.result,
            totalTokensUsed: analysis.tokens,
            totalDurationMs: Date.now() - startedAt,
            completedAt: new Date(),
            progress: {
              phase: 'completed',
              percent: 100,
              message: `Consolidation plan ready with ${rows.length} editable item(s).`,
            },
          },
        });
      });

      await this._recordEvent(runId, 'complete', 'Consolidation plan is ready.', { itemCount: this._buildItems(runId, baseRun.workspaceId, analysis.result, context.sourceRecommendations).length });
      return this.getRun(runId, baseRun.workspaceId);
    } catch (error) {
      const current = await prisma.assignmentDailyReviewConsolidationRun.findUnique({
        where: { id: runId },
        select: { status: true },
      });
      if (!current) return null;
      if (current.status === 'cancelled') {
        return this.getRun(runId, baseRun.workspaceId);
      }
      logger.error('Daily review consolidation failed', { runId, error: error.message });
      await prisma.assignmentDailyReviewConsolidationRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          phase: 'failed',
          errorMessage: error.message,
          totalDurationMs: Date.now() - startedAt,
          completedAt: new Date(),
          progress: { phase: 'failed', message: error.message, percent: 100 },
        },
      });
      await this._recordEvent(runId, 'error', error.message);
      return this.getRun(runId, baseRun.workspaceId);
    }
  }

  async _buildContext(workspaceId) {
    const [sourceRecommendations, publishedPrompt, categories, competencies, technicians] = await Promise.all([
      prisma.assignmentDailyReviewRecommendation.findMany({
        where: { workspaceId, status: 'approved' },
        include: { run: { select: { id: true, reviewDate: true, status: true, summaryMetrics: true } } },
        orderBy: [{ reviewDate: 'asc' }, { kind: 'asc' }, { ordinal: 'asc' }],
        take: 500,
      }),
      promptRepository.getPublished(workspaceId),
      competencyRepository.getCategories(workspaceId),
      competencyRepository.getAllCompetenciesForWorkspace(workspaceId),
      prisma.technician.findMany({
        where: { workspaceId, isActive: true },
        select: { id: true, name: true, email: true, location: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const ticketIds = new Set();
    const freshserviceIds = new Set();
    for (const rec of sourceRecommendations) {
      for (const id of toArray(rec.supportingTicketIds)) ticketIds.add(Number(id));
      for (const id of toArray(rec.supportingFreshserviceTicketIds)) freshserviceIds.add(String(id));
    }

    const tickets = ticketIds.size || freshserviceIds.size
      ? await prisma.ticket.findMany({
        where: {
          workspaceId,
          OR: [
            ...(ticketIds.size ? [{ id: { in: Array.from(ticketIds).filter(Number.isFinite) } }] : []),
            ...(freshserviceIds.size ? [{
              freshserviceTicketId: {
                in: Array.from(freshserviceIds).map(toSafeBigInt).filter((value) => value !== null),
              },
            }] : []),
          ],
        },
        select: {
          id: true,
          freshserviceTicketId: true,
          subject: true,
          status: true,
          priority: true,
          category: true,
          ticketCategory: true,
          assignedTech: { select: { id: true, name: true } },
        },
        take: 150,
      })
      : [];

    const snapshot = {
      recommendations: sourceRecommendations.map((rec) => ({
        id: rec.id,
        runId: rec.runId,
        reviewDate: rec.reviewDate,
        kind: rec.kind,
        title: rec.title,
        severity: rec.severity,
        rationale: rec.rationale,
        suggestedAction: rec.suggestedAction,
        skillsAffected: toArray(rec.skillsAffected),
        supportingTicketIds: toArray(rec.supportingTicketIds),
        supportingFreshserviceTicketIds: toArray(rec.supportingFreshserviceTicketIds),
      })),
      prompt: {
        id: publishedPrompt.id,
        version: publishedPrompt.version,
        systemPrompt: publishedPrompt.systemPrompt,
        toolConfig: publishedPrompt.toolConfig,
      },
      categories: categories.map((cat) => ({
        id: cat.id,
        name: cat.name,
        description: cat.description,
        isActive: cat.isActive,
      })),
      competencies: competencies.map((comp) => ({
        technicianId: comp.technicianId,
        technicianName: comp.technician?.name,
        categoryId: comp.competencyCategoryId,
        categoryName: comp.competencyCategory?.name,
        proficiencyLevel: comp.proficiencyLevel,
      })),
      technicians,
      tickets: tickets.map((ticket) => ({
        id: ticket.id,
        freshserviceTicketId: ticket.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null,
        subject: truncate(ticket.subject, 220),
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.ticketCategory || ticket.category,
        assignedTech: ticket.assignedTech?.name || null,
      })),
    };

    return {
      sourceRecommendations,
      publishedPrompt,
      snapshot,
    };
  }

  async _analyze(context, runId) {
    const apiKey = appConfig.anthropic.apiKey;
    if (!apiKey) throw new Error('Anthropic API key is not configured on the server');

    const client = new Anthropic({ apiKey });
    const tool = this._consolidationToolSchema();
    const system = `You are a senior IT operations analyst improving a ticket assignment system.

You will receive approved Daily Review recommendations, the current assignment prompt, current skill categories, technician competency mappings, and limited ticket evidence.

Produce a consolidation plan with exactly four sections:
1. Prompt edits: suggest a complete updated assignment prompt, but do not assume it will be applied automatically.
2. Skill list changes: add, rename, merge, update, or deprecate skills/categories where evidence supports it.
3. Technician skill changes: suggest technician competency level updates or mappings where evidence supports it.
4. Process changes: operational or engineering work. These are visible but not directly applyable in the app.

Rules:
- Be conservative. Do not invent skills or competency changes without evidence from approved recommendations.
- Preserve useful existing prompt content. Tighten only where findings justify it.
- Prefer adding narrow guidance over broad rewrites.
- Reference sourceRecommendationIds on every proposed item.
- Process changes must not require app-side application; mark them as dev_required or policy_required.
- Before the final tool call, write a concise visible summary of the plan you are about to submit.
- Call submit_consolidation_plan with the final structured result.`;

    const messages = [{
      role: 'user',
      content: `Consolidate these approved Daily Review recommendations into a reviewable improvement plan.

${JSON.stringify(context.snapshot, null, 2)}`,
    }];

    let transcript = '';
    let thinking = '';
    let totalTokens = 0;
    let submission = null;
    let inputJsonLength = 0;
    let lastProgressAt = 0;
    let lastStreamActivityAt = Date.now();
    let lastOutputAt = Date.now();
    let lastOutputType = 'connection';

    const stream = client.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: 32000,
      system,
      tools: [tool],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      messages,
    });
    this.activeStreams.set(runId, stream);

    const heartbeat = setInterval(() => {
      const sinceOutputSec = Math.round((Date.now() - lastOutputAt) / 1000);
      const sinceStreamEventSec = Math.round((Date.now() - lastStreamActivityAt) / 1000);
      this._recordEvent(
        runId,
        'heartbeat',
        `Anthropic stream is open. Last output: ${lastOutputType} ${sinceOutputSec}s ago; last stream event ${sinceStreamEventSec}s ago.`,
        {
          sinceOutputSec,
          sinceStreamEventSec,
          lastOutputType,
          textKb: parseFloat((transcript.length / 1024).toFixed(1)),
          thinkingKb: parseFloat((thinking.length / 1024).toFixed(1)),
          structuredPlanKb: parseFloat((inputJsonLength / 1024).toFixed(1)),
          requestId: stream.request_id || null,
        },
      ).catch(() => {});
    }, 5000);

    stream.on('streamEvent', (event) => {
      lastStreamActivityAt = Date.now();
      if (event?.type === 'content_block_delta' && event.delta?.type) {
        this._recordEvent(runId, 'stream_delta', `Received ${event.delta.type}.`, {
          deltaType: event.delta.type,
        }).catch(() => {});
      }
    });

    stream.on('connect', () => {
      lastStreamActivityAt = Date.now();
      lastOutputAt = Date.now();
      lastOutputType = 'connected';
      this._recordEvent(runId, 'connected', 'Connected to Anthropic stream.', {
        requestId: stream.request_id || null,
      }).catch(() => {});
    });

    stream.on('text', (text) => {
      lastStreamActivityAt = Date.now();
      lastOutputAt = Date.now();
      lastOutputType = 'visible text';
      transcript += text;
      this._recordEvent(runId, 'text', text).catch(() => {});
    });

    stream.on('inputJson', (partialJson) => {
      lastStreamActivityAt = Date.now();
      lastOutputAt = Date.now();
      lastOutputType = 'structured plan JSON';
      inputJsonLength += partialJson.length;
      const now = Date.now();
      if (now - lastProgressAt > 400) {
        lastProgressAt = now;
        this._recordEvent(runId, 'tool_json', 'Structured plan JSON is streaming...', {
          kb: parseFloat((inputJsonLength / 1024).toFixed(1)),
        }).catch(() => {});
      }
    });

    stream.on('thinking', (chunk) => {
      lastStreamActivityAt = Date.now();
      lastOutputAt = Date.now();
      lastOutputType = 'thinking';
      if (chunk) {
        thinking += chunk;
        this._recordEvent(runId, 'thinking', chunk).catch(() => {});
      }
    });

    stream.on('error', (error) => {
      lastStreamActivityAt = Date.now();
      this._recordEvent(runId, 'error', error?.message || 'Anthropic stream error').catch(() => {});
    });

    stream.on('end', () => {
      lastStreamActivityAt = Date.now();
      this._recordEvent(runId, 'stream_end', 'Anthropic stream ended.').catch(() => {});
    });

    const timeoutMs = 6 * 60 * 1000;
    let finalMessage;
    try {
      finalMessage = await Promise.race([
        stream.finalMessage(),
        new Promise((_, reject) => {
          setTimeout(() => {
            stream.abort();
            reject(new Error('Anthropic consolidation stream timed out after 6 minutes'));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearInterval(heartbeat);
      this.activeStreams.delete(runId);
    }
    totalTokens += (finalMessage.usage?.input_tokens || 0) + (finalMessage.usage?.output_tokens || 0);

    const toolUse = finalMessage.content.find((block) => block.type === 'tool_use' && block.name === 'submit_consolidation_plan');
    if (toolUse?.input) {
      submission = toolUse.input;
    }

    if (!submission) {
      throw new Error('Consolidation model did not submit a structured plan');
    }

    await this._recordEvent(runId, 'submitted', 'Structured consolidation plan submitted.', {
      textChars: transcript.length,
      thinkingChars: thinking.length,
    });

    return { result: submission, tokens: totalTokens, transcript };
  }

  _consolidationToolSchema() {
    return {
      name: 'submit_consolidation_plan',
      description: 'Submit the final Daily Review consolidation plan.',
      input_schema: {
        type: 'object',
        properties: {
          executiveSummary: { type: 'string' },
          prompt: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              rationale: { type: 'string' },
              changeSummary: { type: 'string' },
              updatedPrompt: { type: 'string' },
              sourceRecommendationIds: { type: 'array', items: { type: 'number' } },
            },
            required: ['title', 'rationale', 'changeSummary', 'updatedPrompt', 'sourceRecommendationIds'],
          },
          skillChanges: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                action: { type: 'string', enum: ['add', 'rename', 'update', 'merge', 'deprecate'] },
                categoryId: { type: ['number', 'null'] },
                categoryName: { type: 'string' },
                newName: { type: ['string', 'null'] },
                description: { type: ['string', 'null'] },
                rationale: { type: 'string' },
                sourceRecommendationIds: { type: 'array', items: { type: 'number' } },
              },
              required: ['title', 'action', 'categoryName', 'rationale', 'sourceRecommendationIds'],
            },
          },
          technicianCompetencyChanges: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                technicianId: { type: ['number', 'null'] },
                technicianName: { type: 'string' },
                categoryId: { type: ['number', 'null'] },
                categoryName: { type: 'string' },
                proficiencyLevel: { type: 'string', enum: ['basic', 'intermediate', 'expert'] },
                notes: { type: ['string', 'null'] },
                rationale: { type: 'string' },
                sourceRecommendationIds: { type: 'array', items: { type: 'number' } },
              },
              required: ['title', 'technicianName', 'categoryName', 'proficiencyLevel', 'rationale', 'sourceRecommendationIds'],
            },
          },
          processChanges: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                changeType: { type: 'string' },
                rationale: { type: 'string' },
                suggestedAction: { type: 'string' },
                sourceRecommendationIds: { type: 'array', items: { type: 'number' } },
              },
              required: ['title', 'changeType', 'rationale', 'suggestedAction', 'sourceRecommendationIds'],
            },
          },
        },
        required: ['executiveSummary', 'prompt', 'skillChanges', 'technicianCompetencyChanges', 'processChanges'],
      },
    };
  }

  _buildItems(runId, workspaceId, result, sourceRecommendations) {
    const allSourceIds = sourceRecommendations.map((rec) => rec.id);
    const rows = [];
    const prompt = result?.prompt;
    if (prompt?.updatedPrompt) {
      rows.push({
        runId,
        workspaceId,
        section: 'prompt',
        actionType: 'draft_prompt',
        title: prompt.title || 'Update assignment prompt',
        rationale: prompt.rationale || prompt.changeSummary || null,
        payload: prompt,
        sourceRecommendationIds: toArray(prompt.sourceRecommendationIds).length ? toArray(prompt.sourceRecommendationIds) : allSourceIds,
      });
    }

    for (const item of toArray(result?.skillChanges)) {
      rows.push({
        runId,
        workspaceId,
        section: 'skills',
        actionType: item.action || 'update',
        title: item.title || `${SECTION_LABELS.skills}: ${item.categoryName || 'Skill change'}`,
        rationale: item.rationale || null,
        payload: item,
        sourceRecommendationIds: toArray(item.sourceRecommendationIds),
      });
    }

    for (const item of toArray(result?.technicianCompetencyChanges)) {
      rows.push({
        runId,
        workspaceId,
        section: 'technician_competencies',
        actionType: 'upsert_competency',
        title: item.title || `${item.technicianName || 'Technician'}: ${item.categoryName || 'Skill'}`,
        rationale: item.rationale || null,
        payload: item,
        sourceRecommendationIds: toArray(item.sourceRecommendationIds),
      });
    }

    for (const item of toArray(result?.processChanges)) {
      rows.push({
        runId,
        workspaceId,
        section: 'process',
        actionType: item.changeType || 'dev_required',
        title: item.title || 'Process change',
        rationale: item.rationale || null,
        payload: item,
        sourceRecommendationIds: toArray(item.sourceRecommendationIds),
        includeInApply: false,
        status: 'documented',
      });
    }

    return rows;
  }

  async _applyPromptItem(workspaceId, item, actorEmail) {
    const payload = item.editedPayload || item.payload || {};
    if (!payload.updatedPrompt || String(payload.updatedPrompt).trim().length < 100) {
      throw new Error('Prompt item must include the complete updated prompt before it can be applied');
    }
    const published = await promptRepository.getPublished(workspaceId);
    const draft = await promptRepository.createVersion(workspaceId, {
      systemPrompt: payload.updatedPrompt,
      toolConfig: published.toolConfig,
      notes: `Daily Review consolidation draft. ${payload.changeSummary || item.title || ''}`.trim(),
      createdBy: actorEmail,
    });
    return { action: 'created_prompt_draft', promptDraftId: draft.id, version: draft.version };
  }

  async _applySkillItem(workspaceId, item) {
    const payload = item.editedPayload || item.payload || {};
    const action = payload.action || item.actionType || 'update';
    const categories = await competencyRepository.getCategories(workspaceId);
    const findCategory = () => {
      if (payload.categoryId) return categories.find((cat) => cat.id === Number(payload.categoryId));
      return categories.find((cat) => cat.name.toLowerCase() === String(payload.categoryName || '').toLowerCase());
    };
    const existing = findCategory();

    if (action === 'add') {
      if (existing) {
        const updated = await competencyRepository.updateCategory(existing.id, {
          description: payload.description ?? existing.description,
          isActive: true,
        });
        return { action: 'updated_existing_skill', categoryId: updated.id };
      }
      const created = await competencyRepository.createCategory(workspaceId, {
        name: payload.newName || payload.categoryName,
        description: payload.description || null,
      });
      return { action: 'created_skill', categoryId: created.id };
    }

    if (!existing) {
      const created = await competencyRepository.createCategory(workspaceId, {
        name: payload.newName || payload.categoryName,
        description: payload.description || null,
      });
      return { action: 'created_skill_fallback', categoryId: created.id };
    }

    if (action === 'deprecate') {
      const updated = await competencyRepository.updateCategory(existing.id, { isActive: false });
      return { action: 'deprecated_skill', categoryId: updated.id };
    }

    if (action === 'rename' || action === 'update') {
      const updated = await competencyRepository.updateCategory(existing.id, {
        name: payload.newName || existing.name,
        description: payload.description ?? existing.description,
        isActive: payload.isActive ?? existing.isActive,
      });
      return { action: action === 'rename' ? 'renamed_skill' : 'updated_skill', categoryId: updated.id };
    }

    return { action: 'recorded_skill_change', categoryId: existing.id, note: 'Merge actions require manual review in the Skill Matrix.' };
  }

  async _applyTechnicianCompetencyItem(workspaceId, item) {
    const payload = item.editedPayload || item.payload || {};
    let technicianId = payload.technicianId ? Number(payload.technicianId) : null;
    if (!technicianId && payload.technicianName) {
      const tech = await prisma.technician.findFirst({
        where: { workspaceId, name: { equals: payload.technicianName, mode: 'insensitive' } },
        select: { id: true },
      });
      technicianId = tech?.id || null;
    }
    if (!technicianId) throw new Error(`Could not resolve technician for "${payload.technicianName || item.title}"`);

    let categoryId = payload.categoryId ? Number(payload.categoryId) : null;
    if (!categoryId && payload.categoryName) {
      let category = await prisma.competencyCategory.findFirst({
        where: { workspaceId, name: { equals: payload.categoryName, mode: 'insensitive' } },
      });
      if (!category) {
        category = await competencyRepository.createCategory(workspaceId, {
          name: payload.categoryName,
          description: `Created by Daily Review consolidation for ${payload.technicianName || `technician #${technicianId}`}.`,
        });
      }
      categoryId = category.id;
    }
    if (!categoryId) throw new Error(`Could not resolve category for "${payload.categoryName || item.title}"`);

    const competency = await competencyRepository.upsertTechnicianCompetency(
      technicianId,
      workspaceId,
      categoryId,
      normalizeLevel(payload.proficiencyLevel),
      payload.notes || item.rationale || null,
    );
    return { action: 'upserted_technician_competency', technicianId, categoryId, competencyId: competency.id };
  }

  _groupItems(items = []) {
    return items.reduce((acc, item) => {
      if (!acc[item.section]) acc[item.section] = [];
      acc[item.section].push(item);
      return acc;
    }, { prompt: [], skills: [], technician_competencies: [], process: [] });
  }

  async _updateProgress(runId, phase, message, percent) {
    await prisma.assignmentDailyReviewConsolidationRun.update({
      where: { id: runId },
      data: {
        status: phase,
        phase,
        progress: { phase, message, percent },
      },
    });
    await this._recordEvent(runId, 'progress', message, { phase, percent });
  }

  async _recordEvent(runId, type, message, payload = null) {
    return prisma.assignmentDailyReviewConsolidationEvent.create({
      data: { runId, type, message, payload },
    });
  }
}

export default new AssignmentDailyReviewConsolidationService();
