import prisma from './prisma.js';
import {
  getTodayRange,
  getLocalDateBounds,
  formatDateInTimezone,
  convertToTimezone,
} from '../utils/timezone.js';
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
    description: 'Get full details of the ticket being analyzed, including subject, description, requester info, priority, category, and creation timestamps in workspace-local time.',
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
    description: 'Get detailed availability for all technicians right now. Returns five groups: OFF (full-day leave), WFH (full-day remote), IN-OFFICE, HALF-DAY-OFF (off for only AM or PM), and HALF-DAY-WFH (remote for only AM or PM). Each agent includes their timezone, local date/time, personal schedule (start/end), whether they are currently on shift, and how much time remains in their shift. Half-day entries also include `halfDayPart` ("AM"|"PM"), `leaveWindow` ("HH:MM-HH:MM" workspace local), and `availabilityNote` — a human-readable line summarising whether the agent is reachable right now or only later in the day. ALWAYS read `availabilityNote` before excluding a half-day agent: e.g. someone in HALF-DAY-OFF (AM) is fully available in the afternoon. Use this to avoid assigning tickets to agents whose shift has ended, hasn\'t started yet, or who are only off for part of the day.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_ticket_categories',
    description: 'Get the internal category/subcategory taxonomy used for assignment matching. Use this to classify the ticket into an existing internal category and optional subcategory. FreshService category fields are returned only as raw evidence.',
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
        categoryId: { type: 'integer', description: 'Internal top-level category ID from get_ticket_categories' },
        subcategoryId: { type: 'integer', description: 'Internal subcategory ID from get_ticket_categories, when a specific subcategory applies' },
        categoryName: { type: 'string', description: 'Internal top-level category name from get_ticket_categories' },
        subcategoryName: { type: 'string', description: 'Internal subcategory name from get_ticket_categories, when a specific subcategory applies' },
        category: { type: 'string', description: 'Legacy/internal category name. Prefer categoryId/categoryName and subcategoryId/subcategoryName.' },
        requires_physical_presence: { type: 'boolean', description: 'If true, excludes WFH and remote agents' },
        preferred_location: { type: 'string', description: 'Preferred agent location for physical tasks (e.g., "Vancouver", "Calgary")' },
        min_proficiency: { type: 'string', enum: ['basic', 'intermediate', 'advanced', 'expert'], description: 'Minimum competency level required' },
      },
      required: [],
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
    description: 'Get skill/competency mappings for all technicians: which categories each tech handles and their proficiency level (basic/intermediate/advanced/expert).',
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
        overallReasoning: {
          type: 'string',
          description: `INTERNAL ONLY — never shown to the assignee. Full analysis explaining the routing logic: scores, ranking, why each candidate was preferred or rejected, workload/fairness considerations, on-shift status, rebound history, etc. This is for admin review and audit only.

FORMAT: Plain text or simple Markdown. Use short paragraphs separated by a blank line, and bullet lists ("- ") where you're enumerating candidates or factors. Do NOT produce one giant wall of text — break it up so an admin can scan it quickly. No HTML.`,
        },
        agentBriefingHtml: {
          type: 'string',
          description: `Public-facing HTML message that will be posted as a private note on the FreshService ticket and read by the assigned technician. REQUIRED when recommendations is non-empty.

PURPOSE: Explain *what the ticket is about* and *why it was routed to this person*. That's it. This is a justification note, NOT a how-to guide.

Tone: concise, professional, written directly TO the assignee (use "you").

INCLUDE:
- A 1-2 sentence recap of what the requester needs.
- Reasons this is being routed to them (e.g. "you've handled similar VPN tickets recently", "this needs on-site work in Vancouver"). Keep it human — no scoring language.
- Any directly relevant links/references found during research (KB articles, related tickets by ID).

NEVER INCLUDE:
- Suggested first steps, troubleshooting instructions, or "you should do X". The assignee is a qualified technician — do not tell them how to do their job.
- Questions the assignee should ask the requester. They will figure that out.
- Numerical scores, ranks, percentages, or confidence values.
- Names of OTHER candidates that were considered or ruled out.
- Workload counts, "open ticket" numbers, or fairness/round-robin reasoning.
- Competency proficiency levels, IT levels, seniority labels.
- Words like "algorithm", "system", "LLM", "AI", "model", "pipeline", "score", "ranked", "fairness", "rebound".
- Internal IDs, run IDs, or pipeline metadata.
- Information about agents being OFF / WFH / on leave.

Allowed HTML tags only: <b> <i> <br> <p> <ul> <li> <a href> <h3>. No <script>, <style>, <img>, inline styles, or other tags.

Length: aim for 40-120 words. Hard cap ~800 characters.`,
        },
        closureNoticeHtml: {
          type: 'string',
          description: `Public-facing HTML message posted as a private note when the ticket is being auto-closed as noise/non-actionable. REQUIRED when recommendations is empty (noise dismissal).

Tone: brief, neutral, professional. 1-2 sentences max.

Should explain in plain language why the ticket is being closed without an assignment (e.g. "This appears to be an automated notification with no action required" or "This is informational and does not require helpdesk follow-up"). Do NOT mention "noise", "spam classifier", scoring, or any algorithm internals.

Allowed HTML tags only: <b> <i> <br> <p>. No links or lists needed.

Length: under 300 characters.`,
        },
        ticketClassification: { type: 'string', description: 'Human-readable internal classification from get_ticket_categories (e.g., "Software Support > OpenGround")' },
        internalCategoryId: { type: 'integer', description: 'Selected internal top-level category ID from get_ticket_categories' },
        internalSubcategoryId: { type: 'integer', description: 'Selected internal subcategory ID from get_ticket_categories, if applicable' },
        classificationRationale: { type: 'string', description: 'Brief rationale for the selected internal category/subcategory. If the fit is weak, explain what is missing from the taxonomy.' },
        categoryFit: {
          type: 'string',
          enum: ['exact', 'weak', 'none'],
          description: 'How well the ticket fits the selected top-level internal category. Use exact when clearly aligned, weak when forced/approximate, none when no usable top-level category exists.',
        },
        subcategoryFit: {
          type: 'string',
          enum: ['exact', 'weak', 'none'],
          description: 'How well the ticket fits the selected internal subcategory. Use none when only the parent category fits or no subcategory applies.',
        },
        taxonomyReviewNeeded: {
          type: 'boolean',
          description: 'True when categoryFit or subcategoryFit is weak/none, or when this ticket suggests a new/moved/renamed category or subcategory should be reviewed later.',
        },
        suggestedInternalCategoryName: {
          type: 'string',
          description: 'Optional suggested top-level category name for Daily Review to consider. Do not invent an active category; this is only a review note.',
        },
        suggestedInternalSubcategoryName: {
          type: 'string',
          description: 'Optional suggested subcategory name for Daily Review to consider. Do not invent an active subcategory; this is only a review note.',
        },
        requiresPhysicalPresence: { type: 'boolean', description: 'Whether the ticket requires physical presence' },
        estimatedComplexity: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Estimated complexity of the ticket' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Overall confidence in the recommendation' },
      },
      required: ['recommendations', 'overallReasoning', 'ticketClassification', 'classificationRationale', 'categoryFit', 'subcategoryFit', 'taxonomyReviewNeeded', 'confidence'],
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
    return await findMatchingAgents(workspaceId, toolInput, ticketId);
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

async function getWorkspaceTimezone(workspaceId) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { defaultTimezone: true },
  });
  return workspace?.defaultTimezone || 'America/Los_Angeles';
}

function getAgentShiftStatus(tech, hqTimezone) {
  const tz = tech.timezone || hqTimezone;
  const now = new Date();
  let localDateStr;
  let localDayOfWeek;
  let localDateTimeStr;
  let localTimeStr;
  try {
    localDateStr = formatDateInTimezone(now, tz);
    localDayOfWeek = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
    localDateTimeStr = convertToTimezone(now, tz);
    localTimeStr = now.toLocaleTimeString('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch {
    localDateStr = formatDateInTimezone(now, hqTimezone);
    localDayOfWeek = new Intl.DateTimeFormat('en-US', { timeZone: hqTimezone, weekday: 'long' }).format(now);
    localDateTimeStr = convertToTimezone(now, hqTimezone);
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
  const isOvernightShift = endMinutes <= startMinutes;

  const onShift = isOvernightShift
    ? nowMinutes >= startMinutes || nowMinutes < endMinutes
    : nowMinutes >= startMinutes && nowMinutes < endMinutes;

  const minutesUntilStart = onShift
    ? 0
    : isOvernightShift
      ? (nowMinutes < startMinutes ? startMinutes - nowMinutes : (24 * 60) - nowMinutes + startMinutes)
      : (startMinutes > nowMinutes ? startMinutes - nowMinutes : 0);

  const minutesRemaining = onShift
    ? isOvernightShift
      ? (nowMinutes >= startMinutes ? (24 * 60) - nowMinutes + endMinutes : endMinutes - nowMinutes)
      : endMinutes - nowMinutes
    : 0;

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

  return {
    localDate: localDateStr,
    localDayOfWeek,
    localDateTime: localDateTimeStr,
    localTime: localTimeStr,
    timezone: tz,
    onShift,
    shiftNote,
    startTime,
    endTime,
    isOvernightShift,
    // Exposed so half-day leave notes can compare the leave window to "now".
    nowMinutes,
  };
}

/**
 * Format minutes-from-midnight (e.g. 810) as a workspace-local clock string ("13:30").
 */
function formatMinutes(min) {
  if (min === null || min === undefined) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Build the human-readable availability note the LLM consumes for a half-day
 * leave. Decides whether the agent is reachable RIGHT NOW vs only later in
 * the day, based on the workspace-local clock vs the leave window.
 *
 * `category` is the leave category ('OFF' | 'WFH' | 'OTHER').
 * `leave` carries halfDayPart, startMinute, endMinute.
 * `nowMinutes` is the current workspace-local time in minutes from midnight.
 */
function buildHalfDayAvailabilityNote(category, leave, nowMinutes) {
  const window = `${formatMinutes(leave.startMinute)}–${formatMinutes(leave.endMinute)}`;
  const isAM = leave.halfDayPart === 'AM';
  const verb = category === 'WFH'
    ? (isAM ? 'WFH this morning' : 'WFH this afternoon')
    : (isAM ? 'Off this morning' : 'Off this afternoon');

  // Position vs leave window
  const beforeWindow = nowMinutes < (leave.startMinute ?? 0);
  const duringWindow = nowMinutes >= (leave.startMinute ?? 0) && nowMinutes < (leave.endMinute ?? 0);
  const afterWindow  = nowMinutes >= (leave.endMinute ?? 0);

  if (category === 'WFH') {
    if (duringWindow) {
      return `${verb} (${window}) — remote tasks only right now; in-office for the rest of the day.`;
    }
    if (beforeWindow) {
      return `${verb} (${window}) — in office now, becomes remote-only at ${formatMinutes(leave.startMinute)}.`;
    }
    return `${verb} (${window}) — back in office now (WFH window has ended).`;
  }

  // OFF / OTHER (treated as unavailable during the window)
  if (isAM) {
    if (afterWindow || nowMinutes >= (leave.endMinute ?? 0)) {
      return `${verb} (off ${window}) — back and available now for the rest of the day.`;
    }
    if (duringWindow) {
      return `${verb} (off ${window}) — unavailable until ${formatMinutes(leave.endMinute)}; OK to assign tickets that don't need a response before then.`;
    }
    return `${verb} (off ${window}) — currently available; will be unavailable from ${formatMinutes(leave.startMinute)} to ${formatMinutes(leave.endMinute)}.`;
  }
  // PM
  if (beforeWindow) {
    return `${verb} (off ${window}) — available now, but leaves at ${formatMinutes(leave.startMinute)} for the rest of the day; only assign if it can wrap before then.`;
  }
  if (duringWindow) {
    return `${verb} (off ${window}) — off for the rest of the day, unavailable.`;
  }
  return `${verb} (off ${window}) — leave window already ended; available.`;
}

async function getAgentAvailability(workspaceId) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { defaultTimezone: true },
  });
  const hqTimezone = workspace?.defaultTimezone || 'America/Los_Angeles';
  const { start: dateStart, end: dateEnd, dateStr: todayStr } = getLocalDateBounds(hqTimezone);

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
      where: { workspaceId, leaveDate: { gte: dateStart, lte: dateEnd }, status: 'APPROVED' },
      include: { technician: { select: { id: true, name: true } } },
    }),
  ]);

  // One row per technician for today. If the same person has both a half-day
  // OFF and a half-day WFH on the same day (rare but possible), keep both —
  // we store an array per tech and let the renderer split them.
  const leavesByTech = {};
  for (const l of leaves) {
    if (!leavesByTech[l.technicianId]) leavesByTech[l.technicianId] = [];
    leavesByTech[l.technicianId].push({
      leaveType: l.leaveTypeName,
      category: l.category,
      isFullDay: l.isFullDay !== false,
      halfDayPart: l.halfDayPart || null,
      startMinute: l.startMinute ?? null,
      endMinute: l.endMinute ?? null,
    });
  }

  const off = [];
  const wfh = [];
  const halfDayOff = [];
  const halfDayWfh = [];
  const inOffice = [];

  for (const t of techs) {
    const techLeaves = leavesByTech[t.id] || [];
    const shift = getAgentShiftStatus(t, hqTimezone);
    const agentInfo = {
      techId: t.id,
      techName: t.name,
      location: t.location || 'Not set',
      timezone: shift.timezone,
      localDate: shift.localDate,
      localDayOfWeek: shift.localDayOfWeek,
      localDateTime: shift.localDateTime,
      localTime: shift.localTime,
      schedule: `${shift.startTime}-${shift.endTime}`,
      onShift: shift.onShift,
      shiftStatus: shift.shiftNote,
    };

    // No leave today → in office, simplest path.
    if (techLeaves.length === 0) {
      inOffice.push(agentInfo);
      continue;
    }

    // Pick a "representative" leave for bucket placement:
    //   1. A full-day leave wins over half-day (if both exist for some reason).
    //   2. Among full-day, OFF wins over WFH (most restrictive).
    // Half-day leaves are emitted into the half-day buckets directly.
    const fullDayLeaves = techLeaves.filter(l => l.isFullDay);
    const partialLeaves = techLeaves.filter(l => !l.isFullDay);

    if (fullDayLeaves.length > 0) {
      const offLeave = fullDayLeaves.find(l => l.category === 'OFF');
      const wfhLeave = fullDayLeaves.find(l => l.category === 'WFH');
      const otherLeave = fullDayLeaves.find(l => l.category !== 'OFF' && l.category !== 'WFH' && l.category !== 'IGNORED');
      const ignored = fullDayLeaves.every(l => l.category === 'IGNORED');

      if (offLeave) {
        off.push({ ...agentInfo, leaveType: offLeave.leaveType, note: 'On leave all day — fully unavailable for assignment.' });
      } else if (wfhLeave) {
        wfh.push({ ...agentInfo, leaveType: wfhLeave.leaveType, note: 'Working from home all day — available for remote tasks only, NOT for physical presence tasks.' });
      } else if (otherLeave) {
        off.push({ ...agentInfo, leaveType: otherLeave.leaveType, note: `Leave type: ${otherLeave.category} — treat as unavailable.` });
      } else if (ignored) {
        inOffice.push(agentInfo);
      }
      continue;
    }

    // Only half-day leaves remain.
    for (const leave of partialLeaves) {
      const note = buildHalfDayAvailabilityNote(leave.category, leave, shift.nowMinutes);
      const window = `${formatMinutes(leave.startMinute)}-${formatMinutes(leave.endMinute)}`;
      const enriched = {
        ...agentInfo,
        leaveType: leave.leaveType,
        halfDayPart: leave.halfDayPart,
        leaveWindow: window,
        availabilityNote: note,
      };
      if (leave.category === 'WFH') {
        halfDayWfh.push(enriched);
      } else if (leave.category === 'OFF') {
        halfDayOff.push(enriched);
      } else if (leave.category === 'IGNORED') {
        // Treat ignored half-day as fully in-office.
        inOffice.push(agentInfo);
      } else {
        // OTHER (training, etc.) treated like a half-day OFF.
        halfDayOff.push({ ...enriched, note: `Leave type: ${leave.category} — treat as unavailable during the leave window.` });
      }
    }
  }

  return {
    date: todayStr,
    timezone: hqTimezone,
    summary: {
      totalAgents: techs.length,
      inOffice: inOffice.length,
      workingFromHome: wfh.length,
      off: off.length,
      halfDayOff: halfDayOff.length,
      halfDayWfh: halfDayWfh.length,
    },
    inOffice,
    workingFromHome: wfh,
    off,
    halfDayOff,
    halfDayWfh,
  };
}

function buildInternalTaxonomy(categories = []) {
  const byId = new Map(categories.map((category) => [category.id, { ...category, subcategories: [] }]));
  const roots = [];
  const sort = (a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name);

  for (const category of byId.values()) {
    if (category.parentId && byId.has(category.parentId)) {
      byId.get(category.parentId).subcategories.push({
        id: category.id,
        name: category.name,
        description: category.description,
        parentId: category.parentId,
      });
    } else {
      roots.push(category);
    }
  }

  roots.sort(sort);
  return roots.map((category) => ({
    id: category.id,
    name: category.name,
    description: category.description,
    subcategories: category.subcategories.sort(sort),
  }));
}

async function resolveInternalCategorySelection(workspaceId, selection = {}) {
  const requestedCategoryId = Number(selection.categoryId);
  const requestedSubcategoryId = Number(selection.subcategoryId);
  const categoryName = selection.categoryName || selection.category;
  const subcategoryName = selection.subcategoryName;

  const categories = await prisma.competencyCategory.findMany({
    where: { workspaceId, isActive: true },
    select: { id: true, name: true, parentId: true },
  });
  const byId = new Map(categories.map((c) => [c.id, c]));
  const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));

  let category = Number.isInteger(requestedCategoryId) ? byId.get(requestedCategoryId) : null;
  let subcategory = Number.isInteger(requestedSubcategoryId) ? byId.get(requestedSubcategoryId) : null;

  if (category?.parentId) {
    subcategory = subcategory || category;
    category = byId.get(category.parentId) || null;
  }

  if (!category && categoryName) {
    const named = byName.get(String(categoryName).toLowerCase());
    if (named?.parentId) {
      subcategory = subcategory || named;
      category = byId.get(named.parentId) || null;
    } else {
      category = named || null;
    }
  }

  if (!subcategory && subcategoryName) {
    const namedSubcategory = byName.get(String(subcategoryName).toLowerCase());
    if (namedSubcategory?.parentId) {
      subcategory = namedSubcategory;
    }
  }

  if (subcategory?.parentId) {
    category = byId.get(subcategory.parentId) || category;
  }

  return {
    category: category || null,
    subcategory: subcategory?.parentId ? subcategory : null,
  };
}

function findBestCompetencyMatch(skills, selection) {
  if (!selection?.category && !selection?.subcategory) return null;

  const exactSubcategory = selection.subcategory
    ? skills.find((skill) => skill.id === selection.subcategory.id)
    : null;
  if (exactSubcategory) {
    return { ...exactSubcategory, matchType: 'subcategory_exact', matchPriority: 2 };
  }

  const parentCategory = selection.category
    ? skills.find((skill) => skill.id === selection.category.id)
    : null;
  if (parentCategory) {
    return { ...parentCategory, matchType: selection.subcategory ? 'parent_fallback' : 'category_exact', matchPriority: 1 };
  }

  return null;
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
      select: { id: true, name: true, description: true, parentId: true, sortOrder: true },
      orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
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

  const internalTaxonomy = buildInternalTaxonomy(competencyCategories);
  const flatCategories = competencyCategories.map((c) => {
    const parent = c.parentId ? competencyCategories.find((p) => p.id === c.parentId) : null;
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      parentId: c.parentId,
      parentName: parent?.name || null,
      level: c.parentId ? 'subcategory' : 'category',
      displayName: parent ? `${parent.name} > ${c.name}` : c.name,
    };
  });
  const freshserviceCategories = Object.entries(categoryTree).map(([name, subs]) => ({
    category: name,
    subCategories: subs,
  }));

  return {
    internalTaxonomy,
    freshserviceEvidence: {
      freshserviceCategories,
      ticketCategories: ticketCategories.map((t) => t.ticketCategory),
    },
    // Backward-compatible fields used by older prompts/UI.
    freshserviceCategories,
    ticketCategories: ticketCategories.map((t) => t.ticketCategory),
    competencyCategories: flatCategories,
    instruction: 'Classify into an existing internalTaxonomy category and optional subcategory. Do not invent active categories. FreshService values are raw evidence only. Call find_matching_agents with internal category/subcategory IDs when possible; subcategory experts are preferred and parent-category experts are the fallback.',
  };
}

async function findMatchingAgents(workspaceId, criteria, ticketId = null) {
  const {
    category,
    categoryId,
    subcategoryId,
    categoryName,
    subcategoryName,
    requires_physical_presence,
    preferred_location,
    min_proficiency,
  } = criteria;
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { defaultTimezone: true },
  });
  const timezone = workspace?.defaultTimezone || 'America/Los_Angeles';
  const { start: dateStart, end: dateEnd } = getLocalDateBounds(timezone);
  const { start: todayStart, end: todayEnd } = getTodayRange(timezone);

  const proficiencyOrder = { basic: 1, intermediate: 2, advanced: 3, expert: 4 };
  const minLevel = proficiencyOrder[min_proficiency] || 0;
  const categorySelection = await resolveInternalCategorySelection(workspaceId, {
    category,
    categoryId,
    subcategoryId,
    categoryName,
    subcategoryName,
  });

  const [techs, competencies, leaves, openTickets, todayTickets] = await Promise.all([
    prisma.technician.findMany({
      where: { workspaceId, isActive: true },
      select: { id: true, name: true, location: true, timezone: true, workStartTime: true, workEndTime: true },
    }),
    prisma.technicianCompetency.findMany({
      where: { workspaceId },
      include: { competencyCategory: { select: { id: true, name: true, parentId: true } } },
    }),
    prisma.technicianLeave.findMany({
      where: { workspaceId, leaveDate: { gte: dateStart, lte: dateEnd }, status: 'APPROVED' },
    }),
    prisma.ticket.groupBy({
      by: ['assignedTechId'],
      where: { workspaceId, status: { in: ['Open', 'Pending', 'open', 'pending', '2', '3'] } },
      _count: true,
    }),
    prisma.ticket.groupBy({
      by: ['assignedTechId'],
      where: { workspaceId, createdAt: { gte: todayStart, lte: todayEnd } },
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
      id: c.competencyCategory.id,
      category: c.competencyCategory.name,
      parentId: c.competencyCategory.parentId,
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
    const matchingSkill = findBestCompetencyMatch(skills, categorySelection);

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
      localDate: shift.localDate,
      localDayOfWeek: shift.localDayOfWeek,
      localDateTime: shift.localDateTime,
      localTime: shift.localTime,
      schedule: `${shift.startTime}-${shift.endTime}`,
      onShift: shift.onShift,
      shiftStatus: shift.shiftNote,
      availability: leaveCategory === 'WFH' ? 'WFH (remote only)' : 'In office',
      competencyMatch: matchingSkill ? {
        categoryId: matchingSkill.id,
        category: matchingSkill.category,
        level: matchingSkill.level,
        matchType: matchingSkill.matchType,
        matchPriority: matchingSkill.matchPriority,
      } : null,
      locationMatch,
      openTickets: open,
      todayAssigned: today,
    });
  }

  // Sort: competency match first, then by lowest workload
  results.sort((a, b) => {
    const aPriority = a.competencyMatch?.matchPriority || 0;
    const bPriority = b.competencyMatch?.matchPriority || 0;
    if (bPriority !== aPriority) return bPriority - aPriority;

    const aLevel = a.competencyMatch ? (proficiencyOrder[a.competencyMatch.level] || 0) : 0;
    const bLevel = b.competencyMatch ? (proficiencyOrder[b.competencyMatch.level] || 0) : 0;
    if (bLevel !== aLevel) return bLevel - aLevel;

    if (a.locationMatch !== b.locationMatch && a.locationMatch !== null) {
      return a.locationMatch ? -1 : 1;
    }

    return a.openTickets - b.openTickets;
  });

  // Annotate with rejection history for this specific ticket
  if (ticketId) {
    try {
      const rejections = await prisma.ticketAssignmentEpisode.findMany({
        where: { ticketId, endMethod: 'rejected' },
        select: { technicianId: true, endedAt: true },
      });
      const rejMap = new Map(rejections.map((r) => [r.technicianId, r.endedAt]));
      for (const r of results) {
        const rejectedAt = rejMap.get(r.techId);
        r.previouslyRejectedThisTicket = !!rejectedAt;
        if (rejectedAt) r.rejectedAt = rejectedAt.toISOString();
      }
    } catch { /* non-fatal */ }
  }

  return {
    criteria: {
      category,
      categoryId: categorySelection.category?.id || null,
      categoryName: categorySelection.category?.name || categoryName || category || null,
      subcategoryId: categorySelection.subcategory?.id || null,
      subcategoryName: categorySelection.subcategory?.name || subcategoryName || null,
      requires_physical_presence,
      preferred_location,
      min_proficiency,
    },
    matchCount: results.length,
    matches: results,
    excludedCount: excluded.length,
    excluded,
    note: results.length === 0
      ? 'No agents match all criteria. Consider relaxing requirements (e.g., remove physical presence, lower proficiency, or broaden category).'
      : `Found ${results.length} matching agent(s). Sorted by exact subcategory competency, then parent-category fallback, then workload.`,
  };
}

// ── Search and history tools ──────────────────────────────────────────────

async function searchTickets(workspaceId, params) {
  const {
    keyword, category, sub_category, assigned_tech_id,
    status, priority, date_from, date_to, sort_by,
  } = params;
  const limit = Math.min(params.limit || 15, 25);

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { defaultTimezone: true },
  });
  const tz = workspace?.defaultTimezone || 'America/Los_Angeles';

  const where = { workspaceId };

  if (sub_category) where.subCategory = sub_category;
  if (assigned_tech_id) where.assignedTechId = assigned_tech_id;
  if (status) where.status = { in: [status, status.toLowerCase(), status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()] };
  if (priority) where.priority = priority;

  if (date_from || date_to) {
    where.createdAt = {};
    if (date_from) {
      const { start } = getTodayRange(tz, new Date(date_from + 'T12:00:00Z'));
      where.createdAt.gte = start;
    }
    if (date_to) {
      const { end } = getTodayRange(tz, new Date(date_to + 'T12:00:00Z'));
      where.createdAt.lte = end;
    }
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
      createdAt: t.createdAt ? formatDateInTimezone(t.createdAt, tz) : null,
      resolvedAt: t.resolvedAt ? formatDateInTimezone(t.resolvedAt, tz) : null,
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

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { defaultTimezone: true },
  });
  const tz = workspace?.defaultTimezone || 'America/Los_Angeles';

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
      createdAt: t.createdAt ? formatDateInTimezone(t.createdAt, tz) : null,
      resolvedAt: t.resolvedAt ? formatDateInTimezone(t.resolvedAt, tz) : null,
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
  const timezone = await getWorkspaceTimezone(ticket.workspaceId);

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
    createdAt: ticket.createdAt ? convertToTimezone(ticket.createdAt, timezone) : null,
    createdAtUtc: ticket.createdAt?.toISOString?.() || null,
    createdDate: ticket.createdAt ? formatDateInTimezone(ticket.createdAt, timezone) : null,
    workspaceTimezone: timezone,
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
  const todayStr = formatDateInTimezone(null, timezone);

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
    date: todayStr,
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
      orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.technicianCompetency.findMany({
      where: { workspaceId },
      include: {
        technician: { select: { id: true, name: true } },
        competencyCategory: { select: { id: true, name: true, parentId: true } },
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
      categoryId: m.competencyCategory.id,
      category: m.competencyCategory.name,
      parentId: m.competencyCategory.parentId,
      levelType: m.competencyCategory.parentId ? 'subcategory' : 'category',
      level: m.proficiencyLevel,
    });
  }

  return {
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      parentId: c.parentId,
      levelType: c.parentId ? 'subcategory' : 'category',
    })),
    categoryTree: buildInternalTaxonomy(categories),
    technicianSkills: Object.values(byTech),
  };
}

async function searchDecisionNotes(workspaceId, input) {
  const limit = Math.min(input.limit || 10, 20);
  const query = input.query?.trim();
  if (!query) return { error: 'query is required' };
  const timezone = await getWorkspaceTimezone(workspaceId);

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
        decidedAt: r.decidedAt ? convertToTimezone(r.decidedAt, timezone) : null,
        decidedAtUtc: r.decidedAt?.toISOString?.() || null,
        workspaceTimezone: timezone,
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
    const [fsConfig, timezone] = await Promise.all([
      settingsRepository.getFreshServiceConfigForWorkspace(workspaceId),
      getWorkspaceTimezone(workspaceId),
    ]);
    if (!fsConfig?.domain || !fsConfig?.apiKey) {
      return { error: 'FreshService not configured for this workspace' };
    }

    const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey);
    const activities = await client.fetchTicketActivities(freshserviceTicketId);

    return {
      ticketId: freshserviceTicketId,
      activityCount: activities.length,
      workspaceTimezone: timezone,
      activities: activities.slice(0, 20).map((a) => ({
        type: a.actor?.type || 'unknown',
        performer: a.actor?.name || 'System',
        action: a.content || a.note?.content || '',
        createdAt: a.created_at ? convertToTimezone(a.created_at, timezone) : null,
        createdAtRaw: a.created_at || null,
      })),
    };
  } catch (error) {
    logger.warn('Failed to fetch FreshService activities', { freshserviceTicketId, error: error.message });
    return { error: `Failed to fetch activities: ${error.message}` };
  }
}
