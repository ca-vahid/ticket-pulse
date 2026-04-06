import prisma from './prisma.js';
import { getTodayRange } from '../utils/timezone.js';
import settingsRepository from './settingsRepository.js';
import { createFreshServiceClient } from '../integrations/freshservice.js';
import graphMailClient from '../integrations/graphMailClient.js';
import logger from '../utils/logger.js';

/**
 * Tool schemas for Claude tool_use. Each tool has a name, description, and input_schema.
 */
export const TOOL_SCHEMAS = [
  {
    name: 'get_ticket_details',
    description: 'Get full details of the ticket being analyzed, including subject, description, requester info, priority, category, and timestamps.',
    input_schema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'integer', description: 'Internal ticket ID' },
      },
      required: ['ticket_id'],
    },
  },
  {
    name: 'get_agent_availability',
    description: 'Get detailed availability for all technicians right now. Returns three groups: OFF (on leave), WFH (remote only), and IN-OFFICE. Each agent includes their timezone, local time, personal schedule (start/end), whether they are currently on shift, and how much time remains in their shift. Use this to avoid assigning tickets to agents whose shift has ended or hasn\'t started yet.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_ticket_categories',
    description: 'Get the list of known ticket categories, subcategories, and competency skill categories used in this workspace. Use this to classify the ticket into a known category rather than inventing one. Returns FreshService categories (from historical tickets) and competency categories (configured by admins for skill matching).',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'find_matching_agents',
    description: 'Find agents that match specific criteria. Combines competency matching, availability, location, and workload into a single ranked result. Use this after you have classified the ticket and determined requirements.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Ticket category to match against agent competencies (e.g., "Networking", "Hardware")' },
        requires_physical_presence: { type: 'boolean', description: 'If true, excludes WFH and remote agents' },
        preferred_location: { type: 'string', description: 'Preferred agent location for physical tasks (e.g., "Vancouver", "Calgary")' },
        min_proficiency: { type: 'string', enum: ['basic', 'intermediate', 'expert'], description: 'Minimum competency level required' },
      },
      required: ['category'],
    },
  },
  {
    name: 'get_workload_stats',
    description: 'Get current workload statistics for all technicians: open ticket count, tickets assigned today, self-picked tickets today.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_technicians',
    description: 'List all active technicians in the workspace with their name, email, location, and work schedule. For availability info (who is off/WFH), use get_agent_availability instead.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_competencies',
    description: 'Get skill/competency mappings for all technicians: which categories each tech handles and their proficiency level (basic/intermediate/expert).',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_freshservice_activities',
    description: 'Fetch the activity/conversation history for a specific ticket from FreshService API. Shows who did what and when.',
    input_schema: {
      type: 'object',
      properties: {
        freshservice_ticket_id: { type: 'integer', description: 'FreshService ticket ID (the external ID, not internal)' },
      },
      required: ['freshservice_ticket_id'],
    },
  },
  {
    name: 'search_tickets',
    description: 'Search the workspace ticket database. Use this to find similar past tickets, see who resolved them, understand patterns, and build context for your recommendation. You can search by keyword, category, assigned technician, status, date range, and more. Returns up to 25 results sorted by relevance.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search term to match against ticket subject and description (case-insensitive partial match)' },
        category: { type: 'string', description: 'Filter by FreshService category (exact match)' },
        sub_category: { type: 'string', description: 'Filter by sub-category (exact match)' },
        assigned_tech_id: { type: 'integer', description: 'Filter by assigned technician ID to see their ticket history' },
        status: { type: 'string', description: 'Filter by status: Open, Pending, Resolved, Closed' },
        priority: { type: 'integer', description: 'Filter by priority: 1=Low, 2=Medium, 3=High, 4=Urgent' },
        date_from: { type: 'string', description: 'Filter tickets created after this date (YYYY-MM-DD)' },
        date_to: { type: 'string', description: 'Filter tickets created before this date (YYYY-MM-DD)' },
        limit: { type: 'integer', description: 'Max results to return (default 15, max 25)' },
        sort_by: { type: 'string', enum: ['created_at', 'resolved_at', 'priority'], description: 'Sort field (default: created_at descending)' },
      },
      required: [],
    },
  },
  {
    name: 'get_tech_ticket_history',
    description: 'Get a specific technician\'s recent ticket history. Shows what categories they handle, their resolution patterns, and workload trends. Use this to evaluate whether a technician is a good fit for the current ticket.',
    input_schema: {
      type: 'object',
      properties: {
        tech_id: { type: 'integer', description: 'Internal technician ID' },
        days: { type: 'integer', description: 'How many days of history to look back (default 30, max 90)' },
      },
      required: ['tech_id'],
    },
  },
  {
    name: 'get_technician_ad_profile',
    description: 'Look up a technician\'s Azure AD profile by email. Returns job title, department, seniority level (e.g., IT Support 1-5, Jr/Sr), employee type, office location, and any extension attributes. Use this to understand a technician\'s role and experience level when making assignment decisions.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Technician email address' },
      },
      required: ['email'],
    },
  },
  {
    name: 'search_decision_notes',
    description: 'Search past admin decision notes from the assignment pipeline. Returns notes where admins explained why they approved, modified, or rejected recommendations for similar tickets. Use this to learn from past decisions and understand admin preferences for routing patterns.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search in decision notes and ticket subjects (e.g., "BST", "VPN", "security", "Vancouver")' },
        limit: { type: 'integer', description: 'Max results to return (default 10, max 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'submit_recommendation',
    description: 'Submit your final assignment recommendation. You MUST call this tool when you have completed your analysis. Provide ranked technician recommendations with scores and reasoning. For noise/FYI tickets, submit with an empty recommendations array — the system will auto-dismiss them.',
    input_schema: {
      type: 'object',
      properties: {
        recommendations: {
          type: 'array',
          description: 'Ranked list of recommended technicians (best first). Empty array if ticket is noise/FYI or should be deferred.',
          items: {
            type: 'object',
            properties: {
              rank: { type: 'integer', description: 'Rank position (1 = best)' },
              techId: { type: 'integer', description: 'Internal technician ID' },
              techName: { type: 'string', description: 'Technician name' },
              score: { type: 'number', description: 'Confidence score 0.0-1.0' },
              reasoning: { type: 'string', description: 'Why this technician is recommended' },
            },
            required: ['rank', 'techId', 'techName', 'score', 'reasoning'],
          },
        },
        overallReasoning: { type: 'string', description: 'Overall analysis summary explaining the recommendation logic' },
        ticketClassification: { type: 'string', description: 'The matched category from get_ticket_categories (e.g., "Networking", "Hardware", "Account Access")' },
        requiresPhysicalPresence: { type: 'boolean', description: 'Whether the ticket requires physical presence' },
        estimatedComplexity: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Estimated complexity of the ticket' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Overall confidence in the recommendation' },
      },
      required: ['recommendations', 'overallReasoning', 'ticketClassification', 'confidence'],
    },
  },
];

/**
 * Execute a tool by name and return its result.
 */
export async function executeTool(toolName, toolInput, context) {
  const { workspaceId, ticketId } = context;

  switch (toolName) {
  case 'get_ticket_details':
    return await getTicketDetails(toolInput.ticket_id || ticketId);
  case 'get_agent_availability':
    return await getAgentAvailability(workspaceId);
  case 'get_ticket_categories':
    return await getTicketCategories(workspaceId);
  case 'find_matching_agents':
    return await findMatchingAgents(workspaceId, toolInput);
  case 'get_technicians':
    return await getTechnicians(workspaceId);
  case 'get_workload_stats':
    return await getWorkloadStats(workspaceId);
  case 'get_competencies':
    return await getCompetencies(workspaceId);
  case 'get_freshservice_activities':
    return await getFreshserviceActivities(toolInput.freshservice_ticket_id, workspaceId);
  case 'search_tickets':
    return await searchTickets(workspaceId, toolInput);
  case 'get_tech_ticket_history':
    return await getTechTicketHistory(workspaceId, toolInput);
  case 'get_technician_ad_profile':
    return await getTechnicianAdProfile(toolInput.email);
  case 'search_decision_notes':
    return await searchDecisionNotes(workspaceId, toolInput);
  default:
    return { error: `Unknown tool: ${toolName}` };
  }
}

// ── New tools ────────────────────────────────────────────────────────────

function getAgentShiftStatus(tech, hqTimezone) {
  const tz = tech.timezone || hqTimezone;
  const now = new Date();
  let localTimeStr;
  try {
    localTimeStr = now.toLocaleTimeString('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch {
    localTimeStr = now.toLocaleTimeString('en-US', { timeZone: hqTimezone, hour12: false, hour: '2-digit', minute: '2-digit' });
  }
  const [h, m] = localTimeStr.split(':').map(Number);
  const nowMinutes = h * 60 + m;

  const startTime = tech.workStartTime || '09:00';
  const endTime = tech.workEndTime || '17:00';
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;

  const onShift = nowMinutes >= startMinutes && nowMinutes < endMinutes;
  const minutesUntilStart = startMinutes > nowMinutes ? startMinutes - nowMinutes : 0;
  const minutesRemaining = onShift ? endMinutes - nowMinutes : 0;

  let shiftNote;
  if (onShift) {
    const hoursLeft = Math.floor(minutesRemaining / 60);
    const minsLeft = minutesRemaining % 60;
    shiftNote = `On shift — ${hoursLeft}h${minsLeft > 0 ? ` ${minsLeft}m` : ''} remaining`;
  } else if (minutesUntilStart > 0) {
    const hoursUntil = Math.floor(minutesUntilStart / 60);
    const minsUntil = minutesUntilStart % 60;
    shiftNote = `Not yet started — begins in ${hoursUntil}h${minsUntil > 0 ? ` ${minsUntil}m` : ''}`;
  } else {
    shiftNote = 'Shift ended for today';
  }

  return { localTime: localTimeStr, timezone: tz, onShift, shiftNote, startTime, endTime };
}

async function getAgentAvailability(workspaceId) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { defaultTimezone: true },
  });
  const hqTimezone = workspace?.defaultTimezone || 'America/Los_Angeles';
  const { start, end } = getTodayRange(hqTimezone);

  const [techs, leaves] = await Promise.all([
    prisma.technician.findMany({
      where: { workspaceId, isActive: true },
      select: {
        id: true, name: true, email: true, location: true, timezone: true,
        workStartTime: true, workEndTime: true,
      },
      orderBy: { name: 'asc' },
    }),
    prisma.technicianLeave.findMany({
      where: { workspaceId, leaveDate: { gte: start, lte: end }, status: 'APPROVED' },
      include: { technician: { select: { id: true, name: true } } },
    }),
  ]);

  const leaveMap = {};
  for (const l of leaves) {
    leaveMap[l.technicianId] = { leaveType: l.leaveTypeName, category: l.category };
  }

  const off = [];
  const wfh = [];
  const inOffice = [];

  for (const t of techs) {
    const leave = leaveMap[t.id];
    const shift = getAgentShiftStatus(t, hqTimezone);
    const agentInfo = {
      techId: t.id,
      techName: t.name,
      location: t.location || 'Not set',
      timezone: shift.timezone,
      localTime: shift.localTime,
      schedule: `${shift.startTime}-${shift.endTime}`,
      onShift: shift.onShift,
      shiftStatus: shift.shiftNote,
    };

    if (leave) {
      if (leave.category === 'WFH') {
        wfh.push({ ...agentInfo, leaveType: leave.leaveType, note: 'Working from home — available for remote tasks only, NOT for physical presence tasks' });
      } else if (leave.category === 'OFF') {
        off.push({ ...agentInfo, leaveType: leave.leaveType, note: 'On leave — fully unavailable for assignment' });
      } else if (leave.category === 'IGNORED') {
        inOffice.push(agentInfo);
      } else {
        off.push({ ...agentInfo, leaveType: leave.leaveType, note: `Leave type: ${leave.category} — treat as unavailable` });
      }
    } else {
      inOffice.push(agentInfo);
    }
  }

  return {
    date: start.toISOString().slice(0, 10),
    timezone: hqTimezone,
    summary: {
      totalAgents: techs.length,
      inOffice: inOffice.length,
      workingFromHome: wfh.length,
      off: off.length,
    },
    inOffice,
    workingFromHome: wfh,
    off,
  };
}

async function getTicketCategories(workspaceId) {
  const [fsCategories, fsSubs, ticketCategories, competencyCategories] = await Promise.all([
    prisma.ticket.findMany({
      where: { workspaceId, category: { not: null } },
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
    }),
    prisma.ticket.findMany({
      where: { workspaceId, subCategory: { not: null } },
      select: { category: true, subCategory: true },
      distinct: ['category', 'subCategory'],
      orderBy: [{ category: 'asc' }, { subCategory: 'asc' }],
    }),
    prisma.ticket.findMany({
      where: { workspaceId, ticketCategory: { not: null } },
      select: { ticketCategory: true },
      distinct: ['ticketCategory'],
      orderBy: { ticketCategory: 'asc' },
    }),
    prisma.competencyCategory.findMany({
      where: { workspaceId, isActive: true },
      select: { id: true, name: true, description: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const categoryTree = {};
  for (const row of fsCategories) {
    categoryTree[row.category] = [];
  }
  for (const row of fsSubs) {
    if (row.category && categoryTree[row.category]) {
      categoryTree[row.category].push(row.subCategory);
    }
  }

  return {
    freshserviceCategories: Object.entries(categoryTree).map(([name, subs]) => ({
      category: name,
      subCategories: subs,
    })),
    ticketCategories: ticketCategories.map((t) => t.ticketCategory),
    competencyCategories: competencyCategories.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
    })),
    instruction: 'Choose the best matching category from the lists above. FreshService categories and ticket categories (custom field) both represent ticket types. Use the competency category name for agent skill matching via find_matching_agents.',
  };
}

async function findMatchingAgents(workspaceId, criteria) {
  const { category, requires_physical_presence, preferred_location, min_proficiency } = criteria;
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { defaultTimezone: true },
  });
  const timezone = workspace?.defaultTimezone || 'America/Los_Angeles';
  const { start, end } = getTodayRange(timezone);

  const proficiencyOrder = { basic: 1, intermediate: 2, expert: 3 };
  const minLevel = proficiencyOrder[min_proficiency] || 0;

  // Load all active techs with competencies and today's leaves
  const [techs, competencies, leaves, openTickets, todayTickets] = await Promise.all([
    prisma.technician.findMany({
      where: { workspaceId, isActive: true },
      select: { id: true, name: true, location: true, timezone: true, workStartTime: true, workEndTime: true },
    }),
    prisma.technicianCompetency.findMany({
      where: { workspaceId },
      include: { competencyCategory: { select: { name: true } } },
    }),
    prisma.technicianLeave.findMany({
      where: { workspaceId, leaveDate: { gte: start, lte: end }, status: 'APPROVED' },
    }),
    prisma.ticket.groupBy({
      by: ['assignedTechId'],
      where: { workspaceId, status: { in: ['Open', 'Pending', 'open', 'pending', '2', '3'] } },
      _count: true,
    }),
    prisma.ticket.groupBy({
      by: ['assignedTechId'],
      where: { workspaceId, createdAt: { gte: start, lte: end } },
      _count: true,
    }),
  ]);

  const leaveMap = {};
  for (const l of leaves) {
    leaveMap[l.technicianId] = l.category;
  }

  const compMap = {};
  for (const c of competencies) {
    if (!compMap[c.technicianId]) compMap[c.technicianId] = [];
    compMap[c.technicianId].push({
      category: c.competencyCategory.name,
      level: c.proficiencyLevel,
      levelNum: proficiencyOrder[c.proficiencyLevel] || 0,
    });
  }

  const openMap = Object.fromEntries(openTickets.map((r) => [r.assignedTechId, r._count]));
  const todayMap = Object.fromEntries(todayTickets.map((r) => [r.assignedTechId, r._count]));

  const results = [];
  const excluded = [];

  for (const t of techs) {
    const leaveCategory = leaveMap[t.id];

    // Exclude fully unavailable agents
    if (leaveCategory === 'OFF' || (leaveCategory && leaveCategory !== 'WFH' && leaveCategory !== 'IGNORED')) {
      excluded.push({ techId: t.id, techName: t.name, reason: `On leave (${leaveCategory})` });
      continue;
    }

    // Exclude WFH agents if physical presence required
    if (requires_physical_presence && leaveCategory === 'WFH') {
      excluded.push({ techId: t.id, techName: t.name, reason: 'Working from home — physical presence required' });
      continue;
    }

    // Check competency match
    const skills = compMap[t.id] || [];
    const matchingSkill = skills.find((s) =>
      s.category.toLowerCase() === category.toLowerCase(),
    );

    // Filter by minimum proficiency if set
    if (matchingSkill && minLevel > 0 && matchingSkill.levelNum < minLevel) {
      excluded.push({ techId: t.id, techName: t.name, reason: `Competency level too low (${matchingSkill.level}, need ${min_proficiency})` });
      continue;
    }

    const open = openMap[t.id] || 0;
    const today = todayMap[t.id] || 0;
    const locationMatch = preferred_location
      ? (t.location || '').toLowerCase().includes(preferred_location.toLowerCase())
      : null;

    const shift = getAgentShiftStatus(t, timezone);
    results.push({
      techId: t.id,
      techName: t.name,
      location: t.location || 'Not set',
      timezone: shift.timezone,
      localTime: shift.localTime,
      schedule: `${shift.startTime}-${shift.endTime}`,
      onShift: shift.onShift,
      shiftStatus: shift.shiftNote,
      availability: leaveCategory === 'WFH' ? 'WFH (remote only)' : 'In office',
      competencyMatch: matchingSkill ? { category: matchingSkill.category, level: matchingSkill.level } : null,
      locationMatch,
      openTickets: open,
      todayAssigned: today,
    });
  }

  // Sort: competency match first, then by lowest workload
  results.sort((a, b) => {
    const aHasComp = a.competencyMatch ? 1 : 0;
    const bHasComp = b.competencyMatch ? 1 : 0;
    if (bHasComp !== aHasComp) return bHasComp - aHasComp;

    const aLevel = a.competencyMatch ? (proficiencyOrder[a.competencyMatch.level] || 0) : 0;
    const bLevel = b.competencyMatch ? (proficiencyOrder[b.competencyMatch.level] || 0) : 0;
    if (bLevel !== aLevel) return bLevel - aLevel;

    if (a.locationMatch !== b.locationMatch && a.locationMatch !== null) {
      return a.locationMatch ? -1 : 1;
    }

    return a.openTickets - b.openTickets;
  });

  return {
    criteria: { category, requires_physical_presence, preferred_location, min_proficiency },
    matchCount: results.length,
    matches: results,
    excludedCount: excluded.length,
    excluded,
    note: results.length === 0
      ? 'No agents match all criteria. Consider relaxing requirements (e.g., remove physical presence, lower proficiency, or broaden category).'
      : `Found ${results.length} matching agent(s). Sorted by competency match, then by lowest workload.`,
  };
}

// ── Search and history tools ──────────────────────────────────────────────

async function searchTickets(workspaceId, params) {
  const {
    keyword, category, sub_category, assigned_tech_id,
    status, priority, date_from, date_to, sort_by,
  } = params;
  const limit = Math.min(params.limit || 15, 25);

  const where = { workspaceId };

  if (sub_category) where.subCategory = sub_category;
  if (assigned_tech_id) where.assignedTechId = assigned_tech_id;
  if (status) where.status = { in: [status, status.toLowerCase(), status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()] };
  if (priority) where.priority = priority;

  if (date_from || date_to) {
    where.createdAt = {};
    if (date_from) where.createdAt.gte = new Date(date_from);
    if (date_to) where.createdAt.lte = new Date(date_to + 'T23:59:59Z');
  }

  const andClauses = [];
  if (category) {
    andClauses.push({ OR: [{ category }, { ticketCategory: category }] });
  }
  if (keyword) {
    andClauses.push({ OR: [
      { subject: { contains: keyword, mode: 'insensitive' } },
      { descriptionText: { contains: keyword, mode: 'insensitive' } },
    ] });
  }
  if (andClauses.length > 0) {
    where.AND = andClauses;
  }

  const orderBy = sort_by === 'resolved_at'
    ? { resolvedAt: 'desc' }
    : sort_by === 'priority'
      ? { priority: 'desc' }
      : { createdAt: 'desc' };

  const [tickets, totalCount] = await Promise.all([
    prisma.ticket.findMany({
      where,
      select: {
        id: true,
        freshserviceTicketId: true,
        subject: true,
        status: true,
        priority: true,
        category: true,
        subCategory: true,
        createdAt: true,
        resolvedAt: true,
        assignedTechId: true,
        isSelfPicked: true,
        assignedTech: { select: { id: true, name: true } },
        requester: { select: { name: true, department: true } },
      },
      orderBy,
      take: limit,
    }),
    prisma.ticket.count({ where }),
  ]);

  return {
    totalMatches: totalCount,
    returned: tickets.length,
    tickets: tickets.map((t) => ({
      id: t.id,
      freshserviceTicketId: Number(t.freshserviceTicketId),
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      category: t.category,
      subCategory: t.subCategory,
      createdAt: t.createdAt?.toISOString()?.slice(0, 10),
      resolvedAt: t.resolvedAt?.toISOString()?.slice(0, 10),
      assignedTo: t.assignedTech?.name || 'Unassigned',
      assignedTechId: t.assignedTechId,
      selfPicked: t.isSelfPicked,
      requester: t.requester?.name || 'Unknown',
      department: t.requester?.department || null,
    })),
    note: totalCount > limit
      ? `Showing ${limit} of ${totalCount} total matches. Narrow your search for more specific results.`
      : `Found ${totalCount} matching ticket(s).`,
  };
}

async function getTechTicketHistory(workspaceId, params) {
  const { tech_id } = params;
  const days = Math.min(params.days || 30, 90);
  const since = new Date();
  since.setDate(since.getDate() - days);

  const tech = await prisma.technician.findFirst({
    where: { id: tech_id, workspaceId },
    select: { id: true, name: true, location: true },
  });

  if (!tech) return { error: `Technician ${tech_id} not found in this workspace` };

  const [tickets, categoryBreakdown, resolutionStats] = await Promise.all([
    prisma.ticket.findMany({
      where: { workspaceId, assignedTechId: tech_id, createdAt: { gte: since } },
      select: {
        id: true,
        freshserviceTicketId: true,
        subject: true,
        status: true,
        priority: true,
        category: true,
        subCategory: true,
        ticketCategory: true,
        createdAt: true,
        resolvedAt: true,
        isSelfPicked: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 25,
    }),
    prisma.ticket.groupBy({
      by: ['ticketCategory'],
      where: { workspaceId, assignedTechId: tech_id, createdAt: { gte: since }, ticketCategory: { not: null } },
      _count: true,
      orderBy: { _count: { ticketCategory: 'desc' } },
    }),
    prisma.ticket.aggregate({
      where: { workspaceId, assignedTechId: tech_id, createdAt: { gte: since } },
      _count: true,
      _avg: { resolutionTimeSeconds: true },
    }),
  ]);

  const totalTickets = resolutionStats._count;
  const resolved = tickets.filter((t) => t.resolvedAt).length;
  const selfPicked = tickets.filter((t) => t.isSelfPicked).length;

  return {
    technician: { id: tech.id, name: tech.name, location: tech.location },
    period: `Last ${days} days`,
    summary: {
      totalTickets,
      resolvedInPeriod: resolved,
      selfPickedInPeriod: selfPicked,
      avgResolutionTimeMins: resolutionStats._avg?.resolutionTimeSeconds
        ? Math.round(resolutionStats._avg.resolutionTimeSeconds / 60)
        : null,
    },
    categoryBreakdown: categoryBreakdown.map((c) => ({
      category: c.ticketCategory || c.category,
      count: c._count,
    })),
    recentTickets: tickets.slice(0, 15).map((t) => ({
      id: t.id,
      freshserviceTicketId: Number(t.freshserviceTicketId),
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      category: t.ticketCategory || t.category,
      createdAt: t.createdAt?.toISOString()?.slice(0, 10),
      resolvedAt: t.resolvedAt?.toISOString()?.slice(0, 10),
      selfPicked: t.isSelfPicked,
    })),
    insight: categoryBreakdown.length > 0
      ? `${tech.name}'s top categories: ${categoryBreakdown.slice(0, 5).map((c) => `${c.ticketCategory || c.category} (${c._count})`).join(', ')}`
      : `${tech.name} has no categorized tickets in the last ${days} days.`,
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

  // Check for IT level in job title (arabic: IT 1, IT Support 3)
  const titleLevelMatch = title.match(/\bit\s*(?:support\s*)?(\d)/i);
  if (titleLevelMatch) {
    signals.push(`IT Level ${titleLevelMatch[1]}`);
  }

  // Check for IT level in department via Roman numerals (Information Technology I, II, III, IV, V)
  const deptRomanMatch = dept.match(/\b(I{1,3}|IV|VI{0,2}|V)\s*$/);
  if (deptRomanMatch) {
    const level = ROMAN_TO_ARABIC[deptRomanMatch[1]];
    if (level) {
      signals.push(`IT Level ${level} (from department: ${dept})`);
    }
  }

  // Check for arabic numeral in department (IT 3, Technology 2)
  const deptArabicMatch = dept.match(/\b(\d)\s*$/);
  if (deptArabicMatch && !deptRomanMatch) {
    signals.push(`IT Level ${deptArabicMatch[1]} (from department: ${dept})`);
  }

  return signals.length > 0 ? signals : ['not detected'];
}

async function getTechnicianAdProfile(email) {
  if (!email) return { error: 'Email is required' };

  const result = await graphMailClient.getUserProfile(email);
  if (result.error) return result;

  const profile = { ...result };
  delete profile.success;

  profile.senioritySignals = parseSenioritySignals(profile.jobTitle, profile.department);

  return profile;
}

// ── Existing tools ───────────────────────────────────────────────────────

async function getTicketDetails(ticketId) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      requester: { select: { name: true, email: true, department: true, jobTitle: true, phone: true } },
      assignedTech: { select: { id: true, name: true } },
    },
  });

  if (!ticket) return { error: 'Ticket not found' };

  return {
    id: ticket.id,
    freshserviceTicketId: Number(ticket.freshserviceTicketId),
    subject: ticket.subject,
    description: (ticket.descriptionText || ticket.description || '').slice(0, 5000),
    status: ticket.status,
    priority: ticket.priority,
    priorityLabel: { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' }[ticket.priority] || `P${ticket.priority}`,
    category: ticket.category,
    subCategory: ticket.subCategory,
    ticketCategory: ticket.ticketCategory,
    department: ticket.department,
    source: ticket.source,
    isEscalated: ticket.isEscalated,
    createdAt: ticket.createdAt?.toISOString(),
    requester: ticket.requester || null,
    currentlyAssignedTo: ticket.assignedTech?.name || 'Unassigned',
  };
}

async function getTechnicians(workspaceId) {
  const techs = await prisma.technician.findMany({
    where: { workspaceId, isActive: true },
    select: {
      id: true, name: true, email: true, location: true,
      workStartTime: true, workEndTime: true,
    },
    orderBy: { name: 'asc' },
  });

  return {
    count: techs.length,
    technicians: techs.map((t) => ({
      id: t.id,
      name: t.name,
      email: t.email,
      location: t.location || 'Not set',
      schedule: t.workStartTime && t.workEndTime ? `${t.workStartTime}-${t.workEndTime}` : 'Default hours',
    })),
  };
}

async function getWorkloadStats(workspaceId) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { defaultTimezone: true },
  });
  const timezone = workspace?.defaultTimezone || 'America/Los_Angeles';
  const { start, end } = getTodayRange(timezone);

  const techs = await prisma.technician.findMany({
    where: { workspaceId, isActive: true },
    select: { id: true, name: true },
  });
  const techIds = techs.map((t) => t.id);

  const [openTickets, todayTickets, selfPicked] = await Promise.all([
    prisma.ticket.groupBy({
      by: ['assignedTechId'],
      where: { workspaceId, assignedTechId: { in: techIds }, status: { in: ['Open', 'Pending', 'open', 'pending', '2', '3'] } },
      _count: true,
    }),
    prisma.ticket.groupBy({
      by: ['assignedTechId'],
      where: { workspaceId, assignedTechId: { in: techIds }, createdAt: { gte: start, lte: end } },
      _count: true,
    }),
    prisma.ticket.groupBy({
      by: ['assignedTechId'],
      where: { workspaceId, assignedTechId: { in: techIds }, createdAt: { gte: start, lte: end }, isSelfPicked: true },
      _count: true,
    }),
  ]);

  const openMap = Object.fromEntries(openTickets.map((r) => [r.assignedTechId, r._count]));
  const todayMap = Object.fromEntries(todayTickets.map((r) => [r.assignedTechId, r._count]));
  const selfMap = Object.fromEntries(selfPicked.map((r) => [r.assignedTechId, r._count]));

  return {
    date: start.toISOString().slice(0, 10),
    stats: techs.map((t) => ({
      techId: t.id,
      techName: t.name,
      openTickets: openMap[t.id] || 0,
      todayAssigned: todayMap[t.id] || 0,
      todaySelfPicked: selfMap[t.id] || 0,
    })).sort((a, b) => a.openTickets - b.openTickets),
  };
}

async function getCompetencies(workspaceId) {
  const [categories, mappings] = await Promise.all([
    prisma.competencyCategory.findMany({
      where: { workspaceId, isActive: true },
      orderBy: { name: 'asc' },
    }),
    prisma.technicianCompetency.findMany({
      where: { workspaceId },
      include: {
        technician: { select: { id: true, name: true } },
        competencyCategory: { select: { name: true } },
      },
    }),
  ]);

  if (categories.length === 0) {
    return { message: 'No competency categories defined for this workspace. Consider all technicians as generalists.' };
  }

  const byTech = {};
  for (const m of mappings) {
    if (!byTech[m.technicianId]) {
      byTech[m.technicianId] = { techId: m.technician.id, techName: m.technician.name, skills: [] };
    }
    byTech[m.technicianId].skills.push({
      category: m.competencyCategory.name,
      level: m.proficiencyLevel,
    });
  }

  return {
    categories: categories.map((c) => c.name),
    technicianSkills: Object.values(byTech),
  };
}

async function searchDecisionNotes(workspaceId, input) {
  const limit = Math.min(input.limit || 10, 20);
  const query = input.query?.trim();
  if (!query) return { error: 'query is required' };

  const keywords = query.split(/\s+/).filter(Boolean);

  try {
    const runs = await prisma.assignmentPipelineRun.findMany({
      where: {
        workspaceId,
        decidedAt: { not: null },
        OR: keywords.flatMap((kw) => [
          { decisionNote: { contains: kw, mode: 'insensitive' } },
          { overrideReason: { contains: kw, mode: 'insensitive' } },
          { ticket: { subject: { contains: kw, mode: 'insensitive' } } },
          { ticket: { ticketCategory: { contains: kw, mode: 'insensitive' } } },
        ]),
      },
      orderBy: { decidedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        decision: true,
        decisionNote: true,
        overrideReason: true,
        decidedByEmail: true,
        decidedAt: true,
        assignedTechId: true,
        assignedTech: { select: { name: true } },
        ticket: { select: { freshserviceTicketId: true, subject: true, ticketCategory: true, category: true } },
        recommendation: true,
      },
    });

    return {
      query,
      totalMatches: runs.length,
      notes: runs.map((r) => ({
        runId: r.id,
        ticketId: r.ticket?.freshserviceTicketId,
        ticketSubject: r.ticket?.subject,
        ticketCategory: r.ticket?.ticketCategory || r.ticket?.category,
        decision: r.decision,
        decisionNote: r.decisionNote,
        overrideReason: r.overrideReason,
        assignedTo: r.assignedTech?.name,
        decidedBy: r.decidedByEmail,
        decidedAt: r.decidedAt,
        originalTopRecommendation: r.recommendation?.recommendations?.[0]?.techName,
      })),
    };
  } catch (error) {
    logger.error('Error searching decision notes:', error);
    return { error: `Search failed: ${error.message}` };
  }
}

async function getFreshserviceActivities(freshserviceTicketId, workspaceId) {
  try {
    const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
    if (!fsConfig?.domain || !fsConfig?.apiKey) {
      return { error: 'FreshService not configured for this workspace' };
    }

    const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey);
    const activities = await client.fetchTicketActivities(freshserviceTicketId);

    return {
      ticketId: freshserviceTicketId,
      activityCount: activities.length,
      activities: activities.slice(0, 20).map((a) => ({
        type: a.actor?.type || 'unknown',
        performer: a.actor?.name || 'System',
        action: a.content || a.note?.content || '',
        createdAt: a.created_at,
      })),
    };
  } catch (error) {
    logger.warn('Failed to fetch FreshService activities', { freshserviceTicketId, error: error.message });
    return { error: `Failed to fetch activities: ${error.message}` };
  }
}
