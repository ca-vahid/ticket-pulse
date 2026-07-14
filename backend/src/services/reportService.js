// Analytics Reports (feedback 07-14): on-demand report snapshots for weekly
// meetings. Two layers, deliberately separated:
//   1. DATASET — deterministic aggregates straight from SQL (counts, deltas
//      vs the previous period, daily series, breakdowns, samples). This is
//      the same explainable posture as the rest of Analytics.
//   2. NARRATIVE — a clearly-labeled AI brief written FROM that dataset
//      (executive summary, pattern clusters inferred from subjects,
//      discussion points). The narrative never invents numbers; the UI
//      renders it under an explicit "AI narrative" banner.
// Snapshots are immutable rows — regenerate for fresh numbers.
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import providerGateway from './aiProviders/providerGateway.js';

const SCOPE_KINDS = new Set(['all', 'noise', 'category', 'subcategory', 'tag']);
const MAX_SUBJECTS_FOR_LLM = 60;

const NARRATIVE_SCHEMA = {
  type: 'object',
  properties: {
    executiveSummary: { type: 'string', description: '3-5 sentence brief a manager can read aloud in a meeting' },
    keyFindings: { type: 'array', items: { type: 'string' }, description: '3-6 crisp bullet findings grounded in the provided numbers' },
    clusters: {
      type: 'array',
      description: 'Thematic clusters inferred from the sample subjects (e.g. "credential-phish impersonating Microsoft"), largest first',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          approxShare: { type: 'string', description: 'rough share like "~40%" — clearly approximate' },
          description: { type: 'string' },
        },
        required: ['label', 'description'],
      },
    },
    trendCommentary: { type: 'string', description: 'What the daily series and period delta suggest, plainly' },
    discussionPoints: { type: 'array', items: { type: 'string' }, description: '3-5 questions/topics worth raising in the weekly meeting' },
    recommendations: { type: 'array', items: { type: 'string' }, description: '2-4 concrete next actions' },
  },
  required: ['executiveSummary', 'keyFindings', 'trendCommentary', 'discussionPoints'],
};

const SYSTEM_PROMPT = `You are a senior IT operations analyst preparing a weekly-meeting brief for an internal helpdesk team.
You are given a DETERMINISTIC dataset (exact counts, deltas, breakdowns) plus a sample of ticket subjects.
Write the brief FROM the data. Rules:
- Never invent numbers — quote only figures present in the dataset; approximate shares from subjects must read as approximate ("roughly a third").
- Cluster the sample subjects into recognizable themes when the scope makes that useful (e.g. types of phishing).
- Be concrete and discussion-ready: what changed, what stands out, what deserves a decision.
- Neutral, professional tone. No praise/blame of individual people — this team reviews workload as a team.`;

function domainOf(email) {
  const at = String(email || '').lastIndexOf('@');
  return at > 0 ? String(email).slice(at + 1).toLowerCase() : null;
}

class ReportService {
  async generate(workspaceId, { scope, rangeDays = 7, title = null }, actor) {
    if (!scope || !SCOPE_KINDS.has(scope.kind)) {
      throw new ValidationError(`scope.kind must be one of: ${[...SCOPE_KINDS].join(', ')}`);
    }
    const days = Math.max(1, Math.min(90, Number(rangeDays) || 7));
    const rangeEnd = new Date();
    const rangeStart = new Date(rangeEnd.getTime() - days * 24 * 3600 * 1000);
    const prevStart = new Date(rangeStart.getTime() - days * 24 * 3600 * 1000);

    // Resolve scope → where-clause + label
    let scopeWhere = {};
    let label = 'All tickets';
    if (scope.kind === 'noise') {
      scopeWhere = { isNoise: true };
      label = 'Noise & spam';
    } else if (scope.kind === 'category' || scope.kind === 'subcategory') {
      const cat = await prisma.competencyCategory.findFirst({ where: { id: Number(scope.id), workspaceId } });
      if (!cat) throw new ValidationError('Unknown category for this workspace');
      scopeWhere = scope.kind === 'category' ? { internalCategoryId: cat.id } : { internalSubcategoryId: cat.id };
      label = cat.name;
    } else if (scope.kind === 'tag') {
      const tag = await prisma.ticketTag.findFirst({ where: { id: Number(scope.id), workspaceId } });
      if (!tag) throw new ValidationError('Unknown tag for this workspace');
      scopeWhere = { tagLinks: { some: { tagId: tag.id } } };
      label = `Tag: ${tag.name}`;
    }
    const base = { workspaceId, ...scopeWhere, status: { notIn: ['Deleted'] } };

    // ---- deterministic dataset --------------------------------------------
    const inWindow = { ...base, createdAt: { gte: rangeStart, lt: rangeEnd } };
    const inPrev = { ...base, createdAt: { gte: prevStart, lt: rangeStart } };

    const [total, prevTotal, byStatusRaw, byPriorityRaw, rows] = await Promise.all([
      prisma.ticket.count({ where: inWindow }),
      prisma.ticket.count({ where: inPrev }),
      prisma.ticket.groupBy({ by: ['status'], where: inWindow, _count: true }),
      prisma.ticket.groupBy({ by: ['priority'], where: inWindow, _count: true }),
      prisma.ticket.findMany({
        where: inWindow,
        select: {
          id: true, subject: true, status: true, createdAt: true, resolvedAt: true,
          freshserviceTicketId: true, nativeNumber: true, origin: true, isNoise: true,
          internalCategory: { select: { name: true } },
          internalSubcategory: { select: { name: true } },
          requester: { select: { name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 2000,
      }),
    ]);

    const byDay = {};
    const bySubcategory = {};
    const byCategory = {};
    const byDomain = {};
    const byRequester = {};
    let resolvedCount = 0;
    let resolutionMsSum = 0;
    for (const t of rows) {
      const day = t.createdAt.toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
      const cat = t.internalCategory?.name || '(uncategorized)';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      const sub = t.internalSubcategory?.name || '(no subcategory)';
      bySubcategory[sub] = (bySubcategory[sub] || 0) + 1;
      const dom = domainOf(t.requester?.email) || '(unknown)';
      byDomain[dom] = (byDomain[dom] || 0) + 1;
      const req = t.requester?.name || '(unknown)';
      byRequester[req] = (byRequester[req] || 0) + 1;
      if (t.resolvedAt) {
        resolvedCount += 1;
        resolutionMsSum += (t.resolvedAt.getTime() - t.createdAt.getTime());
      }
    }
    const top = (m, n = 8) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
    // Dense daily series (zero-filled) so charts show quiet days honestly.
    const days_ = [];
    for (let d = new Date(rangeStart); d < rangeEnd; d = new Date(d.getTime() + 24 * 3600 * 1000)) {
      const key = d.toISOString().slice(0, 10);
      days_.push({ date: key, count: byDay[key] || 0 });
    }

    const dataset = {
      rangeDays: days,
      totals: {
        created: total,
        previousPeriod: prevTotal,
        deltaPct: prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 100) : null,
        resolvedInWindow: resolvedCount,
        avgResolutionHours: resolvedCount ? Math.round(resolutionMsSum / resolvedCount / 3600000 * 10) / 10 : null,
      },
      byDay: days_,
      byStatus: byStatusRaw.map((r) => ({ name: r.status, count: r._count })),
      byPriority: byPriorityRaw.map((r) => ({ name: { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' }[r.priority] || String(r.priority), count: r._count })).sort((a, b) => b.count - a.count),
      byCategory: scope.kind === 'all' || scope.kind === 'noise' || scope.kind === 'tag' ? top(byCategory) : undefined,
      bySubcategory: scope.kind !== 'subcategory' ? top(bySubcategory) : undefined,
      byRequesterDomain: top(byDomain, 6),
      topRequesters: top(byRequester, 6),
      // ALL in-scope tickets (bounded by the 2000-row aggregate cap): the
      // snapshot stays self-contained, the UI paginates, and each row links
      // to its Ticket Pulse page via `id`.
      samples: rows.map((t) => ({
        id: t.id,
        ref: t.origin === 'ticketpulse' && t.nativeNumber ? `TP-${t.nativeNumber}` : `#${t.freshserviceTicketId ?? t.id}`,
        subject: t.subject || '(no subject)',
        status: t.status,
        createdAt: t.createdAt.toISOString(),
      })),
      truncated: rows.length >= 2000 ? 'aggregates computed from the first 2000 tickets in range' : null,
    };

    // ---- AI narrative ------------------------------------------------------
    let narrative = null;
    let llmModel = null;
    try {
      const subjectSample = rows.slice(0, MAX_SUBJECTS_FOR_LLM).map((t) => `- ${String(t.subject || '').slice(0, 140)}`).join('\n');
      const userMessage = [
        `Report scope: ${label} · last ${days} days (${rangeStart.toISOString().slice(0, 10)} → ${rangeEnd.toISOString().slice(0, 10)})`,
        '',
        'DATASET (exact figures — quote only these):',
        JSON.stringify({ ...dataset, samples: undefined }, null, 1).slice(0, 6000),
        '',
        `SAMPLE SUBJECTS (${Math.min(rows.length, MAX_SUBJECTS_FOR_LLM)} most recent — cluster these into themes):`,
        subjectSample || '(none)',
      ].join('\n');

      const response = await providerGateway.sendJson({
        operation: 'analytics_report',
        workspaceId,
        systemPrompt: SYSTEM_PROMPT,
        userMessage,
        maxTokens: 1600,
        temperature: 0.2,
        extra: { jsonSchema: NARRATIVE_SCHEMA },
      });
      if (response.parsed?.executiveSummary) {
        narrative = response.parsed;
        llmModel = response.model || null;
      }
    } catch (err) {
      logger.warn(`Report narrative generation failed (dataset still saved): ${err.message}`);
    }

    const row = await prisma.analyticsReport.create({
      data: {
        workspaceId,
        title: (title || `${label} — last ${days} days`).slice(0, 200),
        scope: { ...scope, label },
        rangeStart,
        rangeEnd,
        dataset,
        narrative,
        llmModel,
        createdBy: actor?.email || null,
      },
    });
    logger.info(`Analytics report generated: "${row.title}" (ws ${workspaceId}, ${total} tickets, narrative ${narrative ? 'ok' : 'skipped'})`);
    return row;
  }

  async list(workspaceId, take = 30) {
    return prisma.analyticsReport.findMany({
      where: { workspaceId },
      select: { id: true, title: true, scope: true, rangeStart: true, rangeEnd: true, createdBy: true, createdAt: true, llmModel: true },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async get(id, workspaceId) {
    const row = await prisma.analyticsReport.findFirst({ where: { id: Number(id), workspaceId } });
    if (!row) throw new NotFoundError('Report not found');
    return row;
  }

  async rename(id, workspaceId, title) {
    const clean = String(title || '').trim();
    if (!clean) throw new ValidationError('Give the report a name');
    const row = await prisma.analyticsReport.findFirst({ where: { id: Number(id), workspaceId }, select: { id: true } });
    if (!row) throw new NotFoundError('Report not found');
    return prisma.analyticsReport.update({ where: { id: row.id }, data: { title: clean.slice(0, 200) } });
  }

  async remove(id, workspaceId) {
    const row = await prisma.analyticsReport.findFirst({ where: { id: Number(id), workspaceId }, select: { id: true } });
    if (!row) throw new NotFoundError('Report not found');
    await prisma.analyticsReport.delete({ where: { id: row.id } });
    return { deleted: true };
  }
}

export default new ReportService();
