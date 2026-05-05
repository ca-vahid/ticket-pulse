import prisma from './prisma.js';
import graphMailClient from '../integrations/graphMailClient.js';

function buildCategoryTree(categories = []) {
  const byId = new Map(categories.map((category) => [category.id, { ...category, subcategories: [] }]));
  const roots = [];
  const sort = (a, b) => ((a.sortOrder || 0) - (b.sortOrder || 0)) || a.name.localeCompare(b.name);

  for (const category of byId.values()) {
    if (category.parentId && byId.has(category.parentId)) {
      byId.get(category.parentId).subcategories.push({
        id: category.id,
        name: category.name,
        description: category.description,
      });
    } else {
      roots.push(category);
    }
  }

  return roots.sort(sort).map((category) => ({
    id: category.id,
    name: category.name,
    description: category.description,
    subcategories: category.subcategories.sort(sort),
  }));
}

function summarizeInternalTaxonomyRows(rows = [], totalTickets = 0) {
  const byKey = new Map();
  for (const row of rows) {
    const category = row.internalCategory;
    if (!category) continue;
    const subcategory = row.internalSubcategory || null;
    const key = `${category.id}:${subcategory?.id || 'parent'}`;
    const existing = byKey.get(key) || {
      categoryId: category.id,
      categoryName: category.name,
      subcategoryId: subcategory?.id || null,
      subcategoryName: subcategory?.name || null,
      count: 0,
      lastSeen: null,
    };
    existing.count += 1;
    const seen = row.createdAt?.toISOString()?.slice(0, 10) || null;
    if (seen && (!existing.lastSeen || seen > existing.lastSeen)) existing.lastSeen = seen;
    byKey.set(key, existing);
  }
  return Array.from(byKey.values())
    .map((item) => ({
      ...item,
      percentage: totalTickets > 0 ? Math.round((item.count / totalTickets) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count || a.categoryName.localeCompare(b.categoryName));
}

function summarizeTaxonomySuggestionRows(rows = [], totalTickets = 0) {
  const byKey = new Map();
  for (const row of rows) {
    const suggestedCategoryName = row.suggestedInternalCategoryName || null;
    const suggestedSubcategoryName = row.suggestedInternalSubcategoryName || null;
    const suggestedName = suggestedSubcategoryName || suggestedCategoryName;
    if (!suggestedName) continue;

    const parentCategory = row.internalCategory || null;
    const key = `${parentCategory?.id || 'no-parent'}:${suggestedName.toLowerCase()}`;
    const existing = byKey.get(key) || {
      suggestedName,
      suggestionType: suggestedSubcategoryName ? 'subcategory' : 'category',
      parentCategoryId: parentCategory?.id || null,
      parentCategoryName: parentCategory?.name || null,
      count: 0,
      lastSeen: null,
      exampleFreshserviceTicketIds: [],
    };
    existing.count += 1;
    const seen = row.createdAt?.toISOString()?.slice(0, 10) || null;
    if (seen && (!existing.lastSeen || seen > existing.lastSeen)) existing.lastSeen = seen;
    if (existing.exampleFreshserviceTicketIds.length < 5 && row.freshserviceTicketId) {
      existing.exampleFreshserviceTicketIds.push(Number(row.freshserviceTicketId));
    }
    byKey.set(key, existing);
  }

  return Array.from(byKey.values())
    .map((item) => ({
      ...item,
      percentage: totalTickets > 0 ? Math.round((item.count / totalTickets) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count || a.suggestedName.localeCompare(b.suggestedName));
}

function clampInteger(value, defaultValue, maxValue) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, maxValue);
}

function toIsoDateTime(value) {
  return value ? value.toISOString() : null;
}

function toIsoDate(value) {
  return value?.toISOString()?.slice(0, 10) || null;
}

function cleanSnippet(value, maxLength = 650) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key) || [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}

export const COMPETENCY_TOOL_SCHEMAS = [
  {
    name: 'get_technician_profile',
    description: 'Get full profile of the technician being analyzed: name, email, location, work schedule, and their current competency mappings.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_existing_competency_categories',
    description: 'Get the internal competency taxonomy tree currently defined in this workspace, with top-level categories and subcategories. Reuse existing category/subcategory IDs when they fit before proposing new ones.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_technician_ticket_history',
    description: 'Get recent tickets handled by this technician. Shows category, subcategory, priority, subject, created/resolved dates, self-picked flag, and rejection count. Use this to understand what work domains the technician covers.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'How many days of history (default 90, max 180)' },
        limit: { type: 'integer', description: 'Max tickets to return (default 50, max 100)' },
      },
      required: [],
    },
  },
  {
    name: 'get_technician_category_distribution',
    description: 'Get deterministic aggregate breakdown of ticket categories/subcategories for this technician: counts, recency, resolution rate, self-picks, and rejected assignment episodes. Best tool for understanding specialization patterns.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'How many days of history (default 90, max 180)' },
      },
      required: [],
    },
  },
  {
    name: 'get_technician_assignment_signals',
    description: 'Get assignment-quality evidence for this technician: rejected/reassigned episodes, rebound runs, ticket descriptions, and cached FreshService note/reply snippets. Use this before final assessment to distinguish successful experience from misassignments or uncertain skill fit.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'How many days of history (default 180, max 365)' },
        limit: { type: 'integer', description: 'Max tickets to return (default 40, max 80)' },
        includeThreadSnippets: { type: 'boolean', description: 'Include cached FreshService note/reply snippets when available (default true)' },
      },
      required: [],
    },
  },
  {
    name: 'search_workspace_tickets',
    description: 'Search tickets across the entire workspace by keyword, category, or technician. Returns short description snippets and assignment-quality counts for comparison and context.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search term for subject/description' },
        category: { type: 'string', description: 'Filter by FreshService category' },
        assigned_tech_id: { type: 'integer', description: 'Filter by technician ID' },
        limit: { type: 'integer', description: 'Max results (default 15, max 25)' },
      },
      required: [],
    },
  },
  {
    name: 'get_comparable_technicians',
    description: 'Compare this technician\'s ticket category distribution with peers. Helps infer relative specialization vs generalist patterns.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_technician_ad_profile',
    description: 'Look up this technician\'s Azure AD profile. Returns job title, department, seniority level (IT Support 1-5, Jr/Sr), employee type, and extension attributes. Use this to calibrate proficiency levels based on role and experience.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'submit_competency_assessment',
    description: 'Submit your final competency assessment for this technician. You MUST call this tool when done. Provide competency categories with proficiency levels and evidence.',
    input_schema: {
      type: 'object',
      properties: {
        competencies: {
          type: 'array',
          description: 'List of competency assessments',
          items: {
            type: 'object',
            properties: {
              categoryName: { type: 'string', description: 'Category name (use existing name if it fits, otherwise propose a new one)' },
              categoryId: { type: 'integer', description: 'Existing category or subcategory ID when reusing an internal taxonomy entry' },
              parentCategoryName: { type: 'string', description: 'Parent top-level category name when proposing a new subcategory' },
              parentCategoryId: { type: 'integer', description: 'Parent top-level category ID when proposing a new subcategory' },
              categoryDescription: { type: 'string', description: 'Brief description of what this category covers' },
              categoryAction: { type: 'string', enum: ['reuse_existing', 'create_new'], description: 'Whether to use an existing category/subcategory or propose a new inactive taxonomy entry for admin review' },
              proficiencyLevel: {
                type: 'string',
                enum: ['basic', 'intermediate', 'advanced', 'expert'],
                description: 'Assessed proficiency level. Use basic=1 Basic, intermediate=2 Comfortable, advanced=3 Advanced, expert=4 Expert / SME. Do not submit categories with no experience.',
              },
              confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Confidence in this assessment' },
              evidenceSummary: { type: 'string', description: 'Brief summary of evidence supporting this assessment' },
              ticketCount: { type: 'integer', description: 'Number of tickets in this category handled by the technician' },
            },
            required: ['categoryName', 'categoryAction', 'proficiencyLevel', 'confidence', 'evidenceSummary'],
          },
        },
        overallSummary: { type: 'string', description: 'Overall assessment summary for this technician' },
        notes: { type: 'string', description: 'Any additional notes or caveats' },
      },
      required: ['competencies', 'overallSummary'],
    },
  },
];

export async function executeCompetencyTool(toolName, toolInput, context) {
  const { workspaceId, technicianId } = context;

  switch (toolName) {
  case 'get_technician_profile':
    return await getTechnicianProfile(workspaceId, technicianId);
  case 'get_existing_competency_categories':
    return await getExistingCategories(workspaceId);
  case 'get_technician_ticket_history':
    return await getTechnicianTicketHistory(workspaceId, technicianId, toolInput);
  case 'get_technician_category_distribution':
    return await getTechnicianCategoryDistribution(workspaceId, technicianId, toolInput);
  case 'get_technician_assignment_signals':
    return await getTechnicianAssignmentSignals(workspaceId, technicianId, toolInput);
  case 'search_workspace_tickets':
    return await searchWorkspaceTickets(workspaceId, toolInput);
  case 'get_comparable_technicians':
    return await getComparableTechnicians(workspaceId, technicianId);
  case 'get_technician_ad_profile':
    return await getTechnicianAdProfile(workspaceId, technicianId);
  default:
    return { error: `Unknown tool: ${toolName}` };
  }
}

async function getTechnicianProfile(workspaceId, technicianId) {
  const tech = await prisma.technician.findFirst({
    where: { id: technicianId, workspaceId },
    select: {
      id: true, name: true, email: true, location: true,
      workStartTime: true, workEndTime: true, isActive: true,
      competencies: {
        include: { competencyCategory: { select: { id: true, name: true, description: true, parentId: true } } },
      },
    },
  });

  if (!tech) return { error: 'Technician not found' };

  return {
    id: tech.id,
    name: tech.name,
    email: tech.email,
    location: tech.location || 'Not set',
    schedule: tech.workStartTime && tech.workEndTime ? `${tech.workStartTime}-${tech.workEndTime}` : 'Default hours',
    isActive: tech.isActive,
    currentCompetencies: tech.competencies.map((c) => ({
      categoryId: c.competencyCategory.id,
      category: c.competencyCategory.name,
      parentId: c.competencyCategory.parentId,
      levelType: c.competencyCategory.parentId ? 'subcategory' : 'category',
      description: c.competencyCategory.description,
      level: c.proficiencyLevel,
    })),
  };
}

async function getExistingCategories(workspaceId) {
  const categories = await prisma.competencyCategory.findMany({
    where: { workspaceId, isActive: true },
    select: { id: true, name: true, description: true, parentId: true, sortOrder: true },
    orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  });

  return {
    count: categories.length,
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      description: category.description,
      parentId: category.parentId,
      levelType: category.parentId ? 'subcategory' : 'category',
    })),
    categoryTree: buildCategoryTree(categories),
    instruction: 'Reuse an existing internal category/subcategory ID whenever it fits. Prefer exact subcategory mappings for specific work domains; use parent-category mappings for broader/general competency. Only use categoryAction "create_new" when NO existing category or subcategory covers this work area; new entries are inactive suggestions until admin review.',
  };
}

async function getTechnicianTicketHistory(workspaceId, technicianId, params = {}) {
  const days = clampInteger(params.days, 90, 180);
  const limit = clampInteger(params.limit, 50, 100);
  const since = new Date();
  since.setDate(since.getDate() - days);

  const tickets = await prisma.ticket.findMany({
    where: { workspaceId, assignedTechId: technicianId, createdAt: { gte: since } },
    select: {
      id: true, freshserviceTicketId: true, subject: true,
      status: true, priority: true, category: true, subCategory: true,
      ticketCategory: true,
      internalCategory: { select: { id: true, name: true } },
      internalSubcategory: { select: { id: true, name: true, parentId: true } },
      internalCategoryFit: true,
      internalSubcategoryFit: true,
      taxonomyReviewNeeded: true,
      suggestedInternalCategoryName: true,
      suggestedInternalSubcategoryName: true,
      rejectionCount: true,
      createdAt: true, resolvedAt: true,
      isSelfPicked: true, resolutionTimeSeconds: true,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const total = await prisma.ticket.count({
    where: { workspaceId, assignedTechId: technicianId, createdAt: { gte: since } },
  });

  return {
    technicianId,
    period: `Last ${days} days`,
    totalTickets: total,
    returned: tickets.length,
    tickets: tickets.map((t) => ({
      id: t.id,
      freshserviceTicketId: Number(t.freshserviceTicketId),
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      category: t.category,
      subCategory: t.subCategory,
      ticketCategory: t.ticketCategory,
      internalCategory: t.internalCategory
        ? {
          id: t.internalCategory.id,
          name: t.internalCategory.name,
          subcategory: t.internalSubcategory ? { id: t.internalSubcategory.id, name: t.internalSubcategory.name } : null,
        }
        : null,
      taxonomyFit: {
        categoryFit: t.internalCategoryFit,
        subcategoryFit: t.internalSubcategoryFit,
        reviewNeeded: t.taxonomyReviewNeeded,
        suggestedCategoryName: t.suggestedInternalCategoryName,
        suggestedSubcategoryName: t.suggestedInternalSubcategoryName,
      },
      assignmentSignals: {
        rejectionCount: t.rejectionCount || 0,
        hasRejectedEpisode: (t.rejectionCount || 0) > 0,
      },
      createdAt: toIsoDate(t.createdAt),
      resolvedAt: toIsoDate(t.resolvedAt),
      selfPicked: t.isSelfPicked,
      resolutionMins: t.resolutionTimeSeconds ? Math.round(t.resolutionTimeSeconds / 60) : null,
    })),
  };
}

async function getTechnicianCategoryDistribution(workspaceId, technicianId, params = {}) {
  const days = clampInteger(params.days, 90, 180);
  const since = new Date();
  since.setDate(since.getDate() - days);

  // Use whichever category field has data: prefer category, fall back to ticketCategory
  const [byFsCategory, byTicketCategory, total, resolved, selfPicked, rejectedEpisodes, reassignedEpisodes] = await Promise.all([
    prisma.ticket.groupBy({
      by: ['category'],
      where: { workspaceId, assignedTechId: technicianId, createdAt: { gte: since }, category: { not: null } },
      _count: true,
      orderBy: { _count: { category: 'desc' } },
    }),
    prisma.ticket.groupBy({
      by: ['ticketCategory'],
      where: { workspaceId, assignedTechId: technicianId, createdAt: { gte: since }, ticketCategory: { not: null } },
      _count: true,
      orderBy: { _count: { ticketCategory: 'desc' } },
    }),
    prisma.ticket.count({
      where: { workspaceId, assignedTechId: technicianId, createdAt: { gte: since } },
    }),
    prisma.ticket.count({
      where: { workspaceId, assignedTechId: technicianId, createdAt: { gte: since }, resolvedAt: { not: null } },
    }),
    prisma.ticket.count({
      where: { workspaceId, assignedTechId: technicianId, createdAt: { gte: since }, isSelfPicked: true },
    }),
    prisma.ticketAssignmentEpisode.count({
      where: { workspaceId, technicianId, startedAt: { gte: since }, endMethod: 'rejected' },
    }),
    prisma.ticketAssignmentEpisode.count({
      where: { workspaceId, technicianId, startedAt: { gte: since }, endMethod: 'reassigned' },
    }),
  ]);

  const internalRows = await prisma.ticket.findMany({
    where: {
      workspaceId,
      assignedTechId: technicianId,
      createdAt: { gte: since },
      internalCategoryId: { not: null },
    },
    select: {
      internalCategory: { select: { id: true, name: true } },
      internalSubcategory: { select: { id: true, name: true, parentId: true } },
      createdAt: true,
      freshserviceTicketId: true,
      suggestedInternalCategoryName: true,
      suggestedInternalSubcategoryName: true,
    },
  });

  const suggestionRows = await prisma.ticket.findMany({
    where: {
      workspaceId,
      assignedTechId: technicianId,
      createdAt: { gte: since },
      OR: [
        { suggestedInternalCategoryName: { not: null } },
        { suggestedInternalSubcategoryName: { not: null } },
      ],
    },
    select: {
      freshserviceTicketId: true,
      createdAt: true,
      suggestedInternalCategoryName: true,
      suggestedInternalSubcategoryName: true,
      internalCategory: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  // Pick whichever category field has more data
  const byCategory = byFsCategory.length >= byTicketCategory.length
    ? byFsCategory
    : byTicketCategory.map((r) => ({ ...r, category: r.ticketCategory }));
  const categoryField = byFsCategory.length >= byTicketCategory.length ? 'category' : 'ticketCategory';

  const bySub = categoryField === 'category'
    ? await prisma.ticket.groupBy({
      by: ['category', 'subCategory'],
      where: { workspaceId, assignedTechId: technicianId, createdAt: { gte: since }, category: { not: null }, subCategory: { not: null } },
      _count: true,
      orderBy: { _count: { category: 'desc' } },
    })
    : [];

  // Get most recent ticket date per category
  const recentByCategory = {};
  for (const cat of byCategory) {
    const catFilter = categoryField === 'category'
      ? { category: cat.category }
      : { ticketCategory: cat.category };
    const latest = await prisma.ticket.findFirst({
      where: { workspaceId, assignedTechId: technicianId, ...catFilter, createdAt: { gte: since } },
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    recentByCategory[cat.category] = toIsoDate(latest?.createdAt);
  }

  return {
    technicianId,
    period: `Last ${days} days`,
    summary: {
      totalTickets: total,
      resolved,
      selfPicked,
      rejectedEpisodes,
      reassignedEpisodes,
      resolveRate: total > 0 ? Math.round((resolved / total) * 100) : 0,
      rejectionRatePerHandledTicket: total > 0 ? Number(((rejectedEpisodes / total) * 100).toFixed(1)) : 0,
    },
    internalTaxonomyBreakdown: summarizeInternalTaxonomyRows(internalRows, total),
    taxonomySuggestionBreakdown: summarizeTaxonomySuggestionRows(suggestionRows, total),
    categoryBreakdown: byCategory.map((c) => ({
      category: c.category,
      count: c._count,
      percentage: total > 0 ? Math.round((c._count / total) * 100) : 0,
      lastSeen: recentByCategory[c.category] || null,
      subCategories: bySub
        .filter((s) => s.category === c.category)
        .map((s) => ({ subCategory: s.subCategory, count: s._count })),
    })),
  };
}

async function getTechnicianAssignmentSignals(workspaceId, technicianId, params = {}) {
  const days = clampInteger(params.days, 180, 365);
  const limit = clampInteger(params.limit, 40, 80);
  const includeThreadSnippets = params.includeThreadSnippets !== false;
  const since = new Date();
  since.setDate(since.getDate() - days);

  const [technician, targetEpisodes] = await Promise.all([
    prisma.technician.findFirst({
      where: { id: technicianId, workspaceId },
      select: { id: true, name: true, email: true },
    }),
    prisma.ticketAssignmentEpisode.findMany({
      where: { workspaceId, technicianId, startedAt: { gte: since } },
      select: {
        ticketId: true,
        startedAt: true,
        endedAt: true,
        startMethod: true,
        startAssignedByName: true,
        endMethod: true,
        endActorName: true,
      },
      orderBy: { startedAt: 'desc' },
    }),
  ]);

  if (!technician) return { error: 'Technician not found' };

  const targetTicketIds = Array.from(new Set(targetEpisodes.map((episode) => episode.ticketId)));

  const tickets = await prisma.ticket.findMany({
    where: {
      workspaceId,
      createdAt: { gte: since },
      OR: [
        { assignedTechId: technicianId },
        { id: { in: targetTicketIds.length > 0 ? targetTicketIds : [-1] } },
      ],
    },
    select: {
      id: true,
      freshserviceTicketId: true,
      subject: true,
      descriptionText: true,
      status: true,
      priority: true,
      category: true,
      subCategory: true,
      ticketCategory: true,
      internalCategory: { select: { id: true, name: true } },
      internalSubcategory: { select: { id: true, name: true, parentId: true } },
      internalCategoryFit: true,
      internalSubcategoryFit: true,
      taxonomyReviewNeeded: true,
      suggestedInternalCategoryName: true,
      suggestedInternalSubcategoryName: true,
      rejectionCount: true,
      createdAt: true,
      resolvedAt: true,
      assignedTech: { select: { id: true, name: true } },
      _count: { select: { threadEntries: true, assignmentEpisodes: true, pipelineRuns: true } },
    },
    orderBy: [{ rejectionCount: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  });

  const ticketIds = tickets.map((ticket) => ticket.id);
  const [episodes, activities, threadEntries, pipelineRuns] = ticketIds.length > 0
    ? await Promise.all([
      prisma.ticketAssignmentEpisode.findMany({
        where: { workspaceId, ticketId: { in: ticketIds } },
        include: { technician: { select: { id: true, name: true } } },
        orderBy: { startedAt: 'asc' },
      }),
      prisma.ticketActivity.findMany({
        where: {
          ticketId: { in: ticketIds },
          activityType: {
            in: ['self_picked', 'coordinator_assigned', 'assigned', 'rejected', 'reassigned', 'status_changed', 'resolved', 'group_changed'],
          },
        },
        select: { ticketId: true, activityType: true, performedBy: true, performedAt: true, details: true },
        orderBy: { performedAt: 'asc' },
      }),
      includeThreadSnippets
        ? prisma.ticketThreadEntry.findMany({
          where: { workspaceId, ticketId: { in: ticketIds }, bodyText: { not: null } },
          select: {
            ticketId: true,
            source: true,
            eventType: true,
            actorName: true,
            actorEmail: true,
            visibility: true,
            isPrivate: true,
            title: true,
            bodyText: true,
            occurredAt: true,
          },
          orderBy: { occurredAt: 'desc' },
          take: Math.min(ticketIds.length * 4, 240),
        })
        : Promise.resolve([]),
      prisma.assignmentPipelineRun.findMany({
        where: { workspaceId, ticketId: { in: ticketIds } },
        select: {
          id: true,
          ticketId: true,
          triggerSource: true,
          reboundFrom: true,
          assignedTechId: true,
          decision: true,
          decisionNote: true,
          overrideReason: true,
          errorMessage: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(ticketIds.length * 3, 180),
      }),
    ])
    : [[], [], [], []];

  const episodesByTicket = groupBy(episodes, (episode) => episode.ticketId);
  const activitiesByTicket = groupBy(activities, (activity) => activity.ticketId);
  const threadsByTicket = groupBy(threadEntries, (entry) => entry.ticketId);
  const runsByTicket = groupBy(pipelineRuns, (run) => run.ticketId);

  const analyzedTickets = tickets.map((ticket) => {
    const ticketEpisodes = episodesByTicket.get(ticket.id) || [];
    const targetTicketEpisodes = ticketEpisodes.filter((episode) => episode.technicianId === technicianId);
    const rejectedByTechnician = targetTicketEpisodes.filter((episode) => episode.endMethod === 'rejected');
    const reassignedAwayFromTechnician = targetTicketEpisodes.filter((episode) => episode.endMethod === 'reassigned');
    const ticketRuns = runsByTicket.get(ticket.id) || [];
    const reboundRuns = ticketRuns.filter((run) => {
      const rebound = run.reboundFrom || {};
      return run.triggerSource === 'rebound'
        || run.triggerSource === 'rebound_exhausted'
        || rebound.previousTechId === technicianId
        || rebound.previousTechName === technician.name;
    });

    return {
      id: ticket.id,
      freshserviceTicketId: Number(ticket.freshserviceTicketId),
      subject: ticket.subject,
      descriptionSnippet: cleanSnippet(ticket.descriptionText, 500),
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category,
      subCategory: ticket.subCategory,
      ticketCategory: ticket.ticketCategory,
      internalCategory: ticket.internalCategory
        ? {
          id: ticket.internalCategory.id,
          name: ticket.internalCategory.name,
          subcategory: ticket.internalSubcategory ? { id: ticket.internalSubcategory.id, name: ticket.internalSubcategory.name } : null,
        }
        : null,
      taxonomyFit: {
        categoryFit: ticket.internalCategoryFit,
        subcategoryFit: ticket.internalSubcategoryFit,
        reviewNeeded: ticket.taxonomyReviewNeeded,
        suggestedCategoryName: ticket.suggestedInternalCategoryName,
        suggestedSubcategoryName: ticket.suggestedInternalSubcategoryName,
      },
      currentAssignedTo: ticket.assignedTech ? { id: ticket.assignedTech.id, name: ticket.assignedTech.name } : null,
      createdAt: toIsoDate(ticket.createdAt),
      resolvedAt: toIsoDate(ticket.resolvedAt),
      assignmentQualitySignals: {
        ticketRejectionCount: ticket.rejectionCount || 0,
        targetEpisodeCount: targetTicketEpisodes.length,
        rejectedByTechnicianCount: rejectedByTechnician.length,
        reassignedAwayFromTechnicianCount: reassignedAwayFromTechnician.length,
        hasNegativeTargetSignal: rejectedByTechnician.length > 0 || reassignedAwayFromTechnician.length > 0 || reboundRuns.length > 0,
        cachedThreadEntryCount: ticket._count.threadEntries,
        assignmentEpisodeCount: ticket._count.assignmentEpisodes,
        pipelineRunCount: ticket._count.pipelineRuns,
      },
      targetEpisodes: targetTicketEpisodes.map((episode) => ({
        startedAt: toIsoDateTime(episode.startedAt),
        endedAt: toIsoDateTime(episode.endedAt),
        startMethod: episode.startMethod,
        startedBy: episode.startAssignedByName,
        endMethod: episode.endMethod,
        endedBy: episode.endActorName,
      })),
      ticketAssignmentTimeline: ticketEpisodes.map((episode) => ({
        technicianId: episode.technicianId,
        technicianName: episode.technician?.name || null,
        startedAt: toIsoDateTime(episode.startedAt),
        endedAt: toIsoDateTime(episode.endedAt),
        startMethod: episode.startMethod,
        startedBy: episode.startAssignedByName,
        endMethod: episode.endMethod,
        endedBy: episode.endActorName,
      })),
      activityTimeline: (activitiesByTicket.get(ticket.id) || []).slice(-12).map((activity) => ({
        type: activity.activityType,
        performedBy: activity.performedBy,
        performedAt: toIsoDateTime(activity.performedAt),
        details: activity.details || null,
      })),
      reboundRuns: reboundRuns.slice(0, 5).map((run) => ({
        runId: run.id,
        createdAt: toIsoDateTime(run.createdAt),
        triggerSource: run.triggerSource,
        decision: run.decision,
        assignedTechId: run.assignedTechId,
        reboundFrom: run.reboundFrom || null,
        decisionNote: cleanSnippet(run.decisionNote, 450),
        overrideReason: cleanSnippet(run.overrideReason, 450),
        errorMessage: cleanSnippet(run.errorMessage, 450),
      })),
      threadSnippets: (threadsByTicket.get(ticket.id) || []).slice(0, 4).map((entry) => ({
        occurredAt: toIsoDateTime(entry.occurredAt),
        source: entry.source,
        eventType: entry.eventType,
        visibility: entry.visibility,
        isPrivate: entry.isPrivate,
        actorName: entry.actorName,
        actorEmail: entry.actorEmail,
        title: entry.title,
        snippet: cleanSnippet(entry.bodyText, 650),
      })).filter((entry) => entry.snippet),
    };
  });

  const totals = analyzedTickets.reduce((acc, ticket) => {
    acc.rejectedByTechnician += ticket.assignmentQualitySignals.rejectedByTechnicianCount;
    acc.reassignedAwayFromTechnician += ticket.assignmentQualitySignals.reassignedAwayFromTechnicianCount;
    acc.negativeSignalTickets += ticket.assignmentQualitySignals.hasNegativeTargetSignal ? 1 : 0;
    acc.threadSnippetsReturned += ticket.threadSnippets.length;
    return acc;
  }, {
    rejectedByTechnician: 0,
    reassignedAwayFromTechnician: 0,
    negativeSignalTickets: 0,
    threadSnippetsReturned: 0,
  });

  return {
    technician: { id: technician.id, name: technician.name, email: technician.email },
    period: `Last ${days} days`,
    returnedTickets: analyzedTickets.length,
    totals,
    interpretationGuidance: [
      'Use rejected/reassigned episodes and rebound runs as caution signals: they can indicate misassignment, insufficient skill fit, unavailable context, or process issues.',
      'Do not raise proficiency on volume alone when the same category has repeated rejection/reassignment signals.',
      'Use thread snippets and ticket descriptions to understand why the assignment succeeded or failed; absence of snippets means the cache may not have notes for that ticket.',
    ],
    tickets: analyzedTickets,
  };
}

async function searchWorkspaceTickets(workspaceId, params = {}) {
  const limit = clampInteger(params.limit, 15, 25);
  const where = { workspaceId };

  if (params.category) where.category = params.category;
  if (params.assigned_tech_id) where.assignedTechId = params.assigned_tech_id;
  if (params.keyword) {
    where.OR = [
      { subject: { contains: params.keyword, mode: 'insensitive' } },
      { descriptionText: { contains: params.keyword, mode: 'insensitive' } },
    ];
  }

  const tickets = await prisma.ticket.findMany({
    where,
    select: {
      id: true, freshserviceTicketId: true, subject: true,
      descriptionText: true,
      status: true, priority: true, category: true,
      rejectionCount: true,
      internalCategory: { select: { id: true, name: true } },
      internalSubcategory: { select: { id: true, name: true, parentId: true } },
      internalCategoryFit: true,
      internalSubcategoryFit: true,
      taxonomyReviewNeeded: true,
      suggestedInternalCategoryName: true,
      suggestedInternalSubcategoryName: true,
      createdAt: true, resolvedAt: true,
      assignedTech: { select: { id: true, name: true } },
      _count: { select: { threadEntries: true, assignmentEpisodes: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return {
    returned: tickets.length,
    tickets: tickets.map((t) => ({
      id: t.id,
      freshserviceTicketId: Number(t.freshserviceTicketId),
      subject: t.subject,
      descriptionSnippet: cleanSnippet(t.descriptionText, 350),
      status: t.status,
      priority: t.priority,
      category: t.category,
      internalCategory: t.internalCategory
        ? {
          id: t.internalCategory.id,
          name: t.internalCategory.name,
          subcategory: t.internalSubcategory ? { id: t.internalSubcategory.id, name: t.internalSubcategory.name } : null,
        }
        : null,
      taxonomyFit: {
        categoryFit: t.internalCategoryFit,
        subcategoryFit: t.internalSubcategoryFit,
        reviewNeeded: t.taxonomyReviewNeeded,
        suggestedCategoryName: t.suggestedInternalCategoryName,
        suggestedSubcategoryName: t.suggestedInternalSubcategoryName,
      },
      assignmentSignals: {
        rejectionCount: t.rejectionCount || 0,
        assignmentEpisodeCount: t._count.assignmentEpisodes,
        cachedThreadEntryCount: t._count.threadEntries,
      },
      createdAt: toIsoDate(t.createdAt),
      resolvedAt: toIsoDate(t.resolvedAt),
      assignedTo: t.assignedTech?.name || 'Unassigned',
    })),
  };
}

async function getComparableTechnicians(workspaceId, technicianId) {
  const since = new Date();
  since.setDate(since.getDate() - 90);

  const allTechs = await prisma.technician.findMany({
    where: { workspaceId, isActive: true },
    select: { id: true, name: true },
  });

  const distributions = [];
  for (const tech of allTechs.slice(0, 15)) {
    const cats = await prisma.ticket.groupBy({
      by: ['category'],
      where: { workspaceId, assignedTechId: tech.id, createdAt: { gte: since }, category: { not: null } },
      _count: true,
      orderBy: { _count: { category: 'desc' } },
      take: 5,
    });

    const total = await prisma.ticket.count({
      where: { workspaceId, assignedTechId: tech.id, createdAt: { gte: since } },
    });

    distributions.push({
      techId: tech.id,
      techName: tech.name,
      isTargetTech: tech.id === technicianId,
      totalTickets: total,
      topCategories: cats.map((c) => ({ category: c.category, count: c._count })),
    });
  }

  return {
    period: 'Last 90 days',
    technicians: distributions.sort((a, b) => b.totalTickets - a.totalTickets),
    note: 'Compare the target technician\'s category distribution with peers to identify unique specializations.',
  };
}

const ROMAN_TO_ARABIC = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7 };

function parseSenioritySignals(jobTitle, department) {
  const signals = [];
  const title = (jobTitle || '').toLowerCase();
  const dept = department || '';

  if (/\bsr\.?\b|\bsenior\b|\blead\b|\bprincipal\b|\bmanager\b|\bdirector\b|\bhead\b|\bchief\b/.test(title)) {
    signals.push('senior');
  }
  if (/\bjr\.?\b|\bjunior\b|\bassociate\b|\bintern\b|\bentry\b|\bco-op\b|\bcoop\b/.test(title)) {
    signals.push('junior');
  }

  const titleLevelMatch = title.match(/\bit\s*(?:support\s*)?(\d)/i);
  if (titleLevelMatch) {
    signals.push(`IT Level ${titleLevelMatch[1]}`);
  }

  const deptRomanMatch = dept.match(/\b(I{1,3}|IV|VI{0,2}|V)\s*$/);
  if (deptRomanMatch) {
    const level = ROMAN_TO_ARABIC[deptRomanMatch[1]];
    if (level) {
      signals.push(`IT Level ${level} (from department: ${dept})`);
    }
  }

  const deptArabicMatch = dept.match(/\b(\d)\s*$/);
  if (deptArabicMatch && !deptRomanMatch) {
    signals.push(`IT Level ${deptArabicMatch[1]} (from department: ${dept})`);
  }

  return signals.length > 0 ? signals : ['not detected'];
}

async function getTechnicianAdProfile(workspaceId, technicianId) {
  const tech = await prisma.technician.findFirst({
    where: { id: technicianId, workspaceId },
    select: { email: true, name: true },
  });

  if (!tech?.email) {
    return { error: 'Technician email not found' };
  }

  const result = await graphMailClient.getUserProfile(tech.email);
  if (result.error) return result;

  const profile = { ...result };
  delete profile.success;

  profile.senioritySignals = parseSenioritySignals(profile.jobTitle, profile.department);

  return profile;
}
