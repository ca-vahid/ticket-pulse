import prisma from './prisma.js';
import graphMailClient from '../integrations/graphMailClient.js';

export const COMPETENCY_TOOL_SCHEMAS = [
  {
    name: 'get_technician_profile',
    description: 'Get full profile of the technician being analyzed: name, email, location, work schedule, and their current competency mappings.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_existing_competency_categories',
    description: 'Get all competency categories currently defined in this workspace, with descriptions. Reuse existing categories when they fit before proposing new ones.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_technician_ticket_history',
    description: 'Get recent tickets handled by this technician. Shows category, subcategory, priority, subject, created/resolved dates, and self-picked flag. Use this to understand what work domains the technician covers.',
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
    description: 'Get deterministic aggregate breakdown of ticket categories/subcategories for this technician: counts, recency, average resolution time. Best tool for understanding specialization patterns.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'How many days of history (default 90, max 180)' },
      },
      required: [],
    },
  },
  {
    name: 'search_workspace_tickets',
    description: 'Search tickets across the entire workspace by keyword, category, or technician. Use for comparison and context.',
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
              categoryDescription: { type: 'string', description: 'Brief description of what this category covers' },
              categoryAction: { type: 'string', enum: ['reuse_existing', 'create_new'], description: 'Whether to use an existing category or propose a new one' },
              proficiencyLevel: { type: 'string', enum: ['basic', 'intermediate', 'expert'], description: 'Assessed proficiency level' },
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
        include: { competencyCategory: { select: { name: true, description: true } } },
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
      category: c.competencyCategory.name,
      description: c.competencyCategory.description,
      level: c.proficiencyLevel,
    })),
  };
}

async function getExistingCategories(workspaceId) {
  const categories = await prisma.competencyCategory.findMany({
    where: { workspaceId, isActive: true },
    select: { id: true, name: true, description: true },
    orderBy: { name: 'asc' },
  });

  return {
    count: categories.length,
    categories,
    instruction: 'You MUST reuse an existing category if it covers the same domain, even if the name is not a perfect match. For example, if "VPN and Remote Access" exists and you see tickets about "VPN and Remote Access Client", use the existing category — do NOT create a new one. Similarly, "Scripting" and "Scripting & Automation" are the same domain. Only use categoryAction "create_new" if NO existing category covers this area at all. The system will also fuzzy-match your proposals, but you should get this right yourself.',
  };
}

async function getTechnicianTicketHistory(workspaceId, technicianId, params) {
  const days = Math.min(params.days || 90, 180);
  const limit = Math.min(params.limit || 50, 100);
  const since = new Date();
  since.setDate(since.getDate() - days);

  const tickets = await prisma.ticket.findMany({
    where: { workspaceId, assignedTechId: technicianId, createdAt: { gte: since } },
    select: {
      id: true, freshserviceTicketId: true, subject: true,
      status: true, priority: true, category: true, subCategory: true,
      ticketCategory: true, createdAt: true, resolvedAt: true,
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
      createdAt: t.createdAt?.toISOString()?.slice(0, 10),
      resolvedAt: t.resolvedAt?.toISOString()?.slice(0, 10),
      selfPicked: t.isSelfPicked,
      resolutionMins: t.resolutionTimeSeconds ? Math.round(t.resolutionTimeSeconds / 60) : null,
    })),
  };
}

async function getTechnicianCategoryDistribution(workspaceId, technicianId, params) {
  const days = Math.min(params.days || 90, 180);
  const since = new Date();
  since.setDate(since.getDate() - days);

  // Use whichever category field has data: prefer category, fall back to ticketCategory
  const [byFsCategory, byTicketCategory, total, resolved, selfPicked] = await Promise.all([
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
  ]);

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
    recentByCategory[cat.category] = latest?.createdAt?.toISOString()?.slice(0, 10);
  }

  return {
    technicianId,
    period: `Last ${days} days`,
    summary: { totalTickets: total, resolved, selfPicked, resolveRate: total > 0 ? Math.round((resolved / total) * 100) : 0 },
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

async function searchWorkspaceTickets(workspaceId, params) {
  const limit = Math.min(params.limit || 15, 25);
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
      status: true, priority: true, category: true,
      createdAt: true, resolvedAt: true,
      assignedTech: { select: { id: true, name: true } },
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
      status: t.status,
      priority: t.priority,
      category: t.category,
      createdAt: t.createdAt?.toISOString()?.slice(0, 10),
      resolvedAt: t.resolvedAt?.toISOString()?.slice(0, 10),
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
