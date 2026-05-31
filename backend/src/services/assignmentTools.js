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
import { normalizeFreshServiceGroupMemberIds } from './freshServiceGroupGuard.js';

/**
 * Tool schemas for Claude tool_use. Each tool has a name, description, and input_schema.
 */
export const TOOL_SCHEMAS = [
  {
    name: 'get_ticket_details',
    description: 'Get full details of the ticket being analyzed, including subject, description, requester info, priority, FreshService group ID, raw FreshService categories, stored internal category/subcategory classification, taxonomy fit, previous AI category suggestions, and creation timestamps in workspace-local time.',
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
    description: 'Get the active internal category/subcategory taxonomy used for assignment matching, plus inactive AI-suggested categories waiting for admin review. Use active categories only for assignment matching; use pending suggestions as review context to avoid duplicate new-category suggestions. FreshService category fields are returned only as raw evidence.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_requester_site_context',
    description: 'Get requester and ticket-location context for the ticket being analyzed. Returns requester department/title/timezone, optional Azure AD office profile, location keywords found in the ticket text, and a preferredLocation hint when the evidence is strong enough for physical/site-aware routing.',
    input_schema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'integer', description: 'Internal ticket ID. Defaults to the current ticket.' },
      },
      required: [],
    },
  },
  {
    name: 'get_routing_boundary_context',
    description: 'Check whether this ticket sits in a FreshService group or internal category with special routing ownership, such as SharePoint/Coreshack work that should not be assigned as normal IT pool work. Returns FreshService group name/member compatibility when available, excluded-group status, and manual-review or owner-group routing advice.',
    input_schema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'integer', description: 'Internal ticket ID. Defaults to the current ticket.' },
        candidate_tech_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Optional candidate technician IDs to check for current FreshService group compatibility.',
        },
      },
      required: [],
    },
  },
  {
    name: 'find_matching_agents',
    description: 'Find agents that match specific criteria. Combines competency matching, availability, location, workload, and recent rejection/capacity risk into a single ranked result. Use this after you have classified the ticket and determined requirements.',
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
        min_proficiency: { type: 'string', enum: ['basic', 'intermediate', 'advanced', 'expert'], description: 'Minimum active competency level required. No experience is represented by the absence of a competency mapping and is not an eligible skill match.' },
      },
      required: [],
    },
  },
  {
    name: 'get_assignment_risk_signals',
    description: 'Get structured capacity and rejection-risk signals for candidate technicians before final assignment ranking. Returns same-ticket, same-day, same-subcategory, workload, leave/shift, and recent busy/unavailable rejection signals with ranking advice. Use this after find_matching_agents when there are viable candidates.',
    input_schema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'integer', description: 'Internal ticket ID. Defaults to the current ticket.' },
        categoryId: { type: 'integer', description: 'Internal top-level category ID from get_ticket_categories, if known.' },
        subcategoryId: { type: 'integer', description: 'Internal subcategory ID from get_ticket_categories, if known.' },
        candidate_tech_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Candidate technician IDs to assess. If omitted, all active technicians are assessed.',
        },
        lookback_days: { type: 'integer', description: 'How many days of rejection history to inspect. Default 5, max 30.' },
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
    description: 'Get skill/competency mappings for all technicians: active category/subcategory skills each tech handles and their proficiency level (basic/intermediate/advanced/expert). No experience is represented by no mapping.',
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
    description: 'Search the workspace ticket database. Use this to find similar past tickets, see who resolved them, understand group/category/subcategory patterns, review previous AI category suggestions, and build context for your recommendation. You can search by keyword, raw FreshService category, internal category/subcategory, assigned technician, status, date range, and more. Returns up to 25 results with FreshService group IDs when known.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search term to match against ticket subject and description (case-insensitive partial match)' },
        category: { type: 'string', description: 'Filter by FreshService category (exact match)' },
        sub_category: { type: 'string', description: 'Filter by sub-category (exact match)' },
        internal_category_id: { type: 'integer', description: 'Filter by stored internal top-level category ID' },
        internal_subcategory_id: { type: 'integer', description: 'Filter by stored internal subcategory ID' },
        internal_category_name: { type: 'string', description: 'Filter by stored internal top-level category name (case-insensitive partial match)' },
        internal_subcategory_name: { type: 'string', description: 'Filter by stored internal subcategory name (case-insensitive partial match)' },
        taxonomy_review_needed: { type: 'boolean', description: 'Filter tickets where previous analysis flagged category/subcategory review as needed' },
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
    description: 'Get a specific technician\'s recent ticket history. Shows raw and internal category/subcategory breakdowns, taxonomy-fit warnings, previous AI category suggestions, rejection signals, resolution patterns, and workload trends. Use this to evaluate whether a technician is a good fit and whether missing subcategory competencies may be a matrix gap.',
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
        assessedPriority: {
          type: 'string',
          enum: ['Low', 'Medium', 'High', 'Urgent'],
          description: 'Ticket Pulse priority assessment for this ticket. This is the source of truth that will be written back to FreshService native priority.',
        },
        priorityRationale: {
          type: 'string',
          description: 'Short admin-facing explanation of why this priority was selected. Mention concrete urgency/impact signals, but do not include sensitive ticket body text beyond what is needed to justify the priority.',
        },
        priorityConfidence: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Confidence in the assessed priority based on the available ticket details and history.',
        },
        prioritySignals: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional concise evidence signals used for priority assessment, such as VIP requester, outage language, production impact, due date risk, or missing urgency evidence.',
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
        classificationRationale: { type: 'string', description: 'Brief rationale for the selected internal category/subcategory. If the fit is weak, explain what is missing from the category/subcategory list.' },
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
          description: 'True only when categoryFit or subcategoryFit is weak/none, when a new subcategory under an existing parent should be reviewed, or when an existing category/subcategory should be moved/renamed/merged/deprecated. Do not set true for missing technician competency coverage; that is an agent skill matrix gap.',
        },
        suggestedInternalCategoryName: {
          type: 'string',
          description: 'Do not use this to propose a new top-level category. Leave null except when naming the existing parent category for context.',
        },
        suggestedInternalSubcategoryName: {
          type: 'string',
          description: 'Optional suggested subcategory name for Daily Review to consider under the selected existing parent category. Do not invent an active subcategory; this is only a review note.',
        },
        requiresPhysicalPresence: { type: 'boolean', description: 'Whether the ticket requires physical presence' },
        estimatedComplexity: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Estimated complexity of the ticket' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Overall confidence in the recommendation' },
      },
      required: ['recommendations', 'overallReasoning', 'assessedPriority', 'priorityRationale', 'priorityConfidence', 'ticketClassification', 'classificationRationale', 'categoryFit', 'subcategoryFit', 'taxonomyReviewNeeded', 'confidence'],
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
  case 'get_requester_site_context':
    return await getRequesterSiteContext(workspaceId, toolInput.ticket_id || ticketId);
  case 'get_routing_boundary_context':
    return await getRoutingBoundaryContext(workspaceId, {
      ...toolInput,
      ticket_id: toolInput.ticket_id || ticketId,
    });
  case 'find_matching_agents':
    return await findMatchingAgents(workspaceId, toolInput, ticketId);
  case 'get_assignment_risk_signals':
    return await getAssignmentRiskSignals(workspaceId, {
      ...toolInput,
      ticket_id: toolInput.ticket_id || ticketId,
    });
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

const RISK_REASON_PATTERN = /\b(busy|no time|meeting|unavailable|not available|ooo|out of office|away|vacation|time off|on leave|back tomorrow|until tomorrow|few days off|fully booked|booked solid)\b/i;

const SITE_KEYWORDS = [
  'Vancouver',
  'Calgary',
  'Toronto',
  'Ottawa',
  'Montreal',
  'Victoria',
  'Kamloops',
  'Kelowna',
  'Edmonton',
  'Winnipeg',
  'Halifax',
  'Canada',
];

function clampScore(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(value, max = 180) {
  const text = normalizeText(value);
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function minutesUntilEndOfLocalDay(timezone) {
  const now = new Date();
  const localTimeStr = now.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const [hour, minute] = localTimeStr.split(':').map(Number);
  return Math.max(0, (24 * 60) - ((hour * 60) + minute));
}

function riskLevelFromPenalty(penalty) {
  if (penalty >= 0.75) return 'critical';
  if (penalty >= 0.45) return 'high';
  if (penalty >= 0.2) return 'medium';
  return 'low';
}

function buildRiskAdvice({ riskLevel, sameTicketRejected, activeSuppression, sameDayRejectedCount, sameSubcategoryRejectedCount }) {
  if (sameTicketRejected) {
    return 'Do not rank first. This technician already rejected this ticket unless there is no viable alternative.';
  }
  if (activeSuppression?.active) {
    return 'Do not rank first unless every alternative is materially less qualified.';
  }
  if (sameDayRejectedCount >= 2) {
    return 'Down-rank for the rest of the business day unless the ticket is an unusually strong fit.';
  }
  if (sameSubcategoryRejectedCount > 0) {
    return 'Apply a soft penalty for recent same-subcategory rejection history.';
  }
  if (riskLevel === 'medium') return 'Use as a tie-breaker against this candidate when alternatives are similarly qualified.';
  return 'No meaningful rejection/capacity penalty detected.';
}

function extractLocationSignals(...parts) {
  const text = parts.map((part) => String(part || '')).join(' ');
  const lower = text.toLowerCase();
  const signals = [];
  for (const keyword of SITE_KEYWORDS) {
    if (lower.includes(keyword.toLowerCase())) signals.push(keyword);
  }
  return Array.from(new Set(signals));
}

function groupCount(row) {
  if (typeof row?._count === 'number') return row._count;
  if (typeof row?._count?._all === 'number') return row._count._all;
  const first = Object.values(row?._count || {}).find((value) => typeof value === 'number');
  return first || 0;
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

function formatTicketInternalClassification(ticket) {
  const internalCategory = ticket.internalCategory
    ? {
      id: ticket.internalCategory.id,
      name: ticket.internalCategory.name,
      parentId: ticket.internalCategory.parentId || null,
    }
    : null;
  const internalSubcategory = ticket.internalSubcategory
    ? {
      id: ticket.internalSubcategory.id,
      name: ticket.internalSubcategory.name,
      parentId: ticket.internalSubcategory.parentId || null,
    }
    : null;

  return {
    internalCategory,
    internalSubcategory,
    internalPath: internalCategory
      ? `${internalCategory.name}${internalSubcategory ? ` > ${internalSubcategory.name}` : ''}`
      : null,
    taxonomyFit: {
      categoryFit: ticket.internalCategoryFit || null,
      subcategoryFit: ticket.internalSubcategoryFit || null,
      reviewNeeded: Boolean(ticket.taxonomyReviewNeeded),
      confidence: ticket.internalCategoryConfidence || null,
      rationale: ticket.internalCategoryRationale || null,
      suggestedInternalCategoryName: ticket.suggestedInternalCategoryName || null,
      suggestedInternalSubcategoryName: ticket.suggestedInternalSubcategoryName || null,
    },
  };
}

function buildInternalTaxonomyBreakdown(tickets = []) {
  const byPath = new Map();
  const suggestionBreakdown = new Map();

  for (const ticket of tickets) {
    const classification = formatTicketInternalClassification(ticket);
    const path = classification.internalPath || 'Unclassified';
    if (!byPath.has(path)) {
      byPath.set(path, {
        internalPath: path,
        internalCategoryId: classification.internalCategory?.id || null,
        internalCategoryName: classification.internalCategory?.name || null,
        internalSubcategoryId: classification.internalSubcategory?.id || null,
        internalSubcategoryName: classification.internalSubcategory?.name || null,
        count: 0,
        resolved: 0,
        selfPicked: 0,
        rejectedSignals: 0,
        taxonomyReviewNeeded: 0,
      });
    }
    const row = byPath.get(path);
    row.count += 1;
    if (ticket.resolvedAt) row.resolved += 1;
    if (ticket.isSelfPicked) row.selfPicked += 1;
    if ((ticket.rejectionCount || 0) > 0) row.rejectedSignals += 1;
    if (ticket.taxonomyReviewNeeded) row.taxonomyReviewNeeded += 1;

    const suggestedCategory = ticket.suggestedInternalCategoryName?.trim();
    const suggestedSubcategory = ticket.suggestedInternalSubcategoryName?.trim();
    if (suggestedCategory || suggestedSubcategory) {
      const key = `${suggestedCategory || classification.internalCategory?.name || 'Unspecified'} > ${suggestedSubcategory || '(category only)'}`;
      if (!suggestionBreakdown.has(key)) {
        suggestionBreakdown.set(key, {
          suggestedInternalCategoryName: suggestedCategory || null,
          suggestedInternalSubcategoryName: suggestedSubcategory || null,
          currentInternalPath: classification.internalPath,
          count: 0,
          ticketIds: [],
        });
      }
      const suggestion = suggestionBreakdown.get(key);
      suggestion.count += 1;
      if (suggestion.ticketIds.length < 8) suggestion.ticketIds.push(Number(ticket.freshserviceTicketId));
    }
  }

  return {
    internalTaxonomyBreakdown: Array.from(byPath.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 15),
    taxonomySuggestionBreakdown: Array.from(suggestionBreakdown.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  };
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
  const [fsCategories, fsSubs, ticketCategories, competencyCategories, pendingReviewCategories] = await Promise.all([
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
    prisma.competencyCategory.findMany({
      where: { workspaceId, isActive: false, isSystemSuggested: true },
      select: {
        id: true,
        name: true,
        description: true,
        parentId: true,
        source: true,
        createdAt: true,
        parent: { select: { id: true, name: true, isActive: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { name: 'asc' }],
      take: 25,
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
  const pendingReviewSuggestions = pendingReviewCategories.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    parentId: c.parentId,
    parentName: c.parent?.name || null,
    parentIsActive: c.parent?.isActive ?? null,
    level: c.parentId ? 'subcategory' : 'category',
    displayName: c.parent ? `${c.parent.name} > ${c.name}` : c.name,
    source: c.source,
    suggestedAt: c.createdAt?.toISOString?.() || null,
    usableForAssignment: false,
  }));

  return {
    internalTaxonomy,
    pendingReviewSuggestions,
    freshserviceEvidence: {
      freshserviceCategories,
      ticketCategories: ticketCategories.map((t) => t.ticketCategory),
    },
    // Backward-compatible fields used by older prompts/UI.
    freshserviceCategories,
    ticketCategories: ticketCategories.map((t) => t.ticketCategory),
    competencyCategories: flatCategories,
    instruction: 'Classify into an existing active internalTaxonomy category and optional subcategory. Do not use pendingReviewSuggestions as active categories; they are review-only context to prevent duplicate suggestions and to understand known gaps. FreshService values are raw evidence only. Call find_matching_agents with internal category/subcategory IDs when possible; subcategory experts are preferred and parent-category experts are the fallback.',
  };
}

async function getRequesterSiteContext(workspaceId, ticketId) {
  if (!ticketId) return { error: 'ticket_id is required' };

  const ticket = await prisma.ticket.findFirst({
    where: { id: Number(ticketId), workspaceId },
    select: {
      id: true,
      freshserviceTicketId: true,
      subject: true,
      descriptionText: true,
      requester: {
        select: {
          name: true,
          email: true,
          department: true,
          jobTitle: true,
          timeZone: true,
        },
      },
    },
  });

  if (!ticket) return { error: `Ticket ${ticketId} not found in this workspace` };

  let graphProfile = null;
  if (ticket.requester?.email && graphMailClient.isConfigured()) {
    try {
      const result = await graphMailClient.getUserProfile(ticket.requester.email);
      if (!result.error) {
        graphProfile = {
          officeLocation: result.officeLocation || null,
          city: result.city || null,
          state: result.state || null,
          country: result.country || null,
          department: result.department || null,
          jobTitle: result.jobTitle || null,
        };
      }
    } catch (error) {
      logger.debug('Requester Graph profile lookup failed', { workspaceId, ticketId, error: error.message });
    }
  }

  const ticketLocationSignals = extractLocationSignals(ticket.subject, ticket.descriptionText);
  const requesterLocationSignals = extractLocationSignals(
    ticket.requester?.department,
    ticket.requester?.jobTitle,
    ticket.requester?.timeZone,
    graphProfile?.officeLocation,
    graphProfile?.city,
    graphProfile?.state,
    graphProfile?.country,
  );
  const combinedSignals = Array.from(new Set([
    ...requesterLocationSignals,
    ...ticketLocationSignals,
  ]));
  const preferredLocation = (
    graphProfile?.officeLocation
    || graphProfile?.city
    || combinedSignals.find((signal) => signal !== 'Canada')
    || null
  );

  return {
    ticket: {
      id: ticket.id,
      freshserviceTicketId: ticket.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null,
      subject: ticket.subject,
    },
    requester: ticket.requester || null,
    graphProfile,
    ticketLocationSignals,
    requesterLocationSignals,
    preferredLocation,
    confidence: graphProfile?.officeLocation || graphProfile?.city
      ? 'high'
      : preferredLocation ? 'medium' : 'low',
    instruction: preferredLocation
      ? `Use preferred_location="${preferredLocation}" when the ticket appears to require physical/site-aware work.`
      : 'No strong requester/site location signal found. Do not force a location preference unless the ticket text requires physical presence.',
  };
}

async function getRoutingBoundaryContext(workspaceId, input = {}) {
  const ticketId = Number(input.ticket_id);
  if (!ticketId) return { error: 'ticket_id is required' };

  const ticket = await prisma.ticket.findFirst({
    where: { id: ticketId, workspaceId },
    select: {
      id: true,
      freshserviceTicketId: true,
      groupId: true,
      subject: true,
      descriptionText: true,
      category: true,
      subCategory: true,
      ticketCategory: true,
      internalCategory: { select: { id: true, name: true } },
      internalSubcategory: { select: { id: true, name: true } },
    },
  });

  if (!ticket) return { error: `Ticket ${ticketId} not found in this workspace` };

  const [assignmentConfig, candidateTechs] = await Promise.all([
    prisma.assignmentConfig.findUnique({
      where: { workspaceId },
      select: { excludedGroupIds: true },
    }).catch(() => null),
    prisma.technician.findMany({
      where: {
        workspaceId,
        isActive: true,
        ...(Array.isArray(input.candidate_tech_ids) && input.candidate_tech_ids.length
          ? { id: { in: input.candidate_tech_ids.map(Number).filter(Number.isFinite) } }
          : {}),
      },
      select: { id: true, name: true, freshserviceId: true, location: true },
      orderBy: { name: 'asc' },
      take: 50,
    }),
  ]);

  let group = null;
  let groupLookup = 'not_applicable';
  if (ticket.groupId) {
    try {
      const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
      if (fsConfig?.domain && fsConfig?.apiKey) {
        const client = createFreshServiceClient(fsConfig);
        group = await client.getGroup(Number(ticket.groupId));
        groupLookup = group ? 'freshservice' : 'not_found';
      } else {
        groupLookup = 'freshservice_not_configured';
      }
    } catch (error) {
      groupLookup = `error: ${error.message}`;
    }
  }

  const excludedGroupIds = (assignmentConfig?.excludedGroupIds || []).map(Number);
  const groupId = ticket.groupId ? Number(ticket.groupId) : null;
  const excludedFromAutoAssign = !!(groupId && excludedGroupIds.includes(groupId));
  const memberIds = normalizeFreshServiceGroupMemberIds(group);
  const groupName = group?.name || (groupId ? `#${groupId}` : null);
  const text = [
    ticket.subject,
    ticket.descriptionText,
    ticket.ticketCategory,
    ticket.category,
    ticket.subCategory,
    ticket.internalCategory?.name,
    ticket.internalSubcategory?.name,
    groupName,
  ].join(' ').toLowerCase();
  const isSharePointBoundary = /\bshare\s*point\b|sharepoint|coreshack|core shack/.test(text);
  const matched = excludedFromAutoAssign || isSharePointBoundary;
  const policy = excludedFromAutoAssign
    ? 'manual_review_required'
    : isSharePointBoundary ? 'owner_group_or_manual_review' : 'normal_assignment';

  return {
    ticket: {
      id: ticket.id,
      freshserviceTicketId: ticket.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null,
      groupId,
      groupName,
      ticketCategory: ticket.ticketCategory,
      internalCategory: ticket.internalCategory,
      internalSubcategory: ticket.internalSubcategory,
    },
    freshserviceGroup: groupId ? {
      id: groupId,
      name: groupName,
      lookup: groupLookup,
      memberIdsKnown: Array.isArray(memberIds),
      memberCount: Array.isArray(memberIds) ? memberIds.length : null,
      excludedFromAutoAssign,
    } : null,
    routingBoundary: {
      matched,
      policy,
      ownerGroupName: groupName,
      reason: excludedFromAutoAssign
        ? 'The ticket group is configured for manual approval instead of direct auto-assignment.'
        : isSharePointBoundary
          ? 'The ticket appears to be SharePoint/Coreshack-owned work rather than normal IT pool work.'
          : 'No special routing boundary detected.',
    },
    candidateGroupCompatibility: candidateTechs.map((tech) => {
      const freshserviceId = tech.freshserviceId ? Number(tech.freshserviceId) : null;
      const memberOfCurrentGroup = Array.isArray(memberIds) && freshserviceId
        ? memberIds.includes(freshserviceId)
        : null;
      return {
        techId: tech.id,
        techName: tech.name,
        freshserviceId,
        location: tech.location || 'Not set',
        memberOfCurrentGroup,
      };
    }),
    rankingAdvice: matched
      ? 'Prefer owner-group compatible candidates or force manual review. Do not treat this as ordinary IT pool routing.'
      : 'No routing-boundary penalty is required.',
  };
}

function indexThreadEntriesByTicket(entries = []) {
  const byTicket = new Map();
  for (const entry of entries) {
    if (!byTicket.has(entry.ticketId)) byTicket.set(entry.ticketId, []);
    byTicket.get(entry.ticketId).push(entry);
  }
  return byTicket;
}

function findRiskReasonForEpisode(episode, entriesByTicket) {
  const entries = entriesByTicket.get(episode.ticketId) || [];
  if (!entries.length) return null;
  const endedAt = episode.endedAt ? new Date(episode.endedAt).getTime() : null;
  const actorName = String(episode.technician?.name || episode.endActorName || '').toLowerCase();
  const sorted = [...entries].sort((a, b) => {
    if (!endedAt) return 0;
    return Math.abs(new Date(a.occurredAt).getTime() - endedAt) - Math.abs(new Date(b.occurredAt).getTime() - endedAt);
  });

  for (const entry of sorted) {
    const text = normalizeText([entry.title, entry.bodyText, entry.content].filter(Boolean).join(' '));
    if (!text || !RISK_REASON_PATTERN.test(text)) continue;
    const entryActor = String(entry.actorName || '').toLowerCase();
    if (actorName && entryActor && !entryActor.includes(actorName.split(/\s+/)[0])) {
      continue;
    }
    return truncateText(text, 180);
  }

  return null;
}

function sameClassification(episodeTicket, target) {
  const sameSubcategory = !!(
    target.subcategoryId
    && episodeTicket?.internalSubcategoryId
    && Number(episodeTicket.internalSubcategoryId) === Number(target.subcategoryId)
  );
  const sameCategory = !!(
    target.categoryId
    && episodeTicket?.internalCategoryId
    && Number(episodeTicket.internalCategoryId) === Number(target.categoryId)
  );
  const targetLegacy = String(target.ticketCategory || target.category || '').trim().toLowerCase();
  const episodeLegacy = String(episodeTicket?.ticketCategory || episodeTicket?.category || '').trim().toLowerCase();
  const sameLegacyCategory = !!(targetLegacy && episodeLegacy && targetLegacy === episodeLegacy);

  return { sameSubcategory, sameCategory, sameLegacyCategory };
}

async function getAssignmentRiskSignals(workspaceId, input = {}) {
  const ticketId = Number(input.ticket_id);
  const timezone = await getWorkspaceTimezone(workspaceId);
  const lookbackDays = Math.max(1, Math.min(Number(input.lookback_days) || 5, 30));
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const { start: todayStart, end: todayEnd } = getTodayRange(timezone);
  const { start: leaveStart, end: leaveEnd } = getLocalDateBounds(timezone);

  const targetTicket = ticketId
    ? await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      select: {
        id: true,
        freshserviceTicketId: true,
        internalCategoryId: true,
        internalSubcategoryId: true,
        ticketCategory: true,
        category: true,
        subject: true,
      },
    })
    : null;

  const target = {
    ticketId: targetTicket?.id || ticketId || null,
    categoryId: Number(input.categoryId) || targetTicket?.internalCategoryId || null,
    subcategoryId: Number(input.subcategoryId) || targetTicket?.internalSubcategoryId || null,
    ticketCategory: targetTicket?.ticketCategory || null,
    category: targetTicket?.category || null,
  };

  let candidateIds = Array.isArray(input.candidate_tech_ids)
    ? input.candidate_tech_ids.map(Number).filter(Number.isFinite)
    : [];
  candidateIds = Array.from(new Set(candidateIds));

  const techs = await prisma.technician.findMany({
    where: {
      workspaceId,
      isActive: true,
      ...(candidateIds.length ? { id: { in: candidateIds } } : {}),
    },
    select: {
      id: true,
      name: true,
      email: true,
      location: true,
      timezone: true,
      workStartTime: true,
      workEndTime: true,
    },
    orderBy: { name: 'asc' },
    ...(candidateIds.length ? {} : { take: 80 }),
  });
  candidateIds = techs.map((tech) => tech.id);

  if (!candidateIds.length) {
    return {
      ticket: targetTicket ? {
        id: targetTicket.id,
        freshserviceTicketId: targetTicket.freshserviceTicketId ? Number(targetTicket.freshserviceTicketId) : null,
        subject: targetTicket.subject,
      } : null,
      candidates: [],
      summary: { highRiskCount: 0, suppressedCount: 0 },
      note: 'No active candidate technicians were available to assess.',
    };
  }

  const [episodes, openTickets, todayTickets, leaves] = await Promise.all([
    prisma.ticketAssignmentEpisode.findMany({
      where: {
        workspaceId,
        technicianId: { in: candidateIds },
        endMethod: 'rejected',
        endedAt: { gte: since },
      },
      include: {
        technician: { select: { id: true, name: true } },
        ticket: {
          select: {
            id: true,
            freshserviceTicketId: true,
            subject: true,
            internalCategoryId: true,
            internalSubcategoryId: true,
            ticketCategory: true,
            category: true,
          },
        },
      },
      orderBy: { endedAt: 'desc' },
    }),
    prisma.ticket.groupBy({
      by: ['assignedTechId'],
      where: { workspaceId, assignedTechId: { in: candidateIds }, status: { in: ['Open', 'Pending', 'open', 'pending', '2', '3'] } },
      _count: true,
    }),
    prisma.ticket.groupBy({
      by: ['assignedTechId'],
      where: { workspaceId, assignedTechId: { in: candidateIds }, createdAt: { gte: todayStart, lte: todayEnd } },
      _count: true,
    }),
    prisma.technicianLeave.findMany({
      where: {
        workspaceId,
        technicianId: { in: candidateIds },
        leaveDate: { gte: leaveStart, lte: leaveEnd },
        status: 'APPROVED',
      },
    }),
  ]);

  let reasonEntriesByTicket = new Map();
  const rejectionTicketIds = Array.from(new Set(episodes.map((episode) => episode.ticketId)));
  if (rejectionTicketIds.length) {
    try {
      const entries = await prisma.ticketThreadEntry.findMany({
        where: {
          workspaceId,
          ticketId: { in: rejectionTicketIds },
          occurredAt: { gte: since },
        },
        select: { ticketId: true, title: true, bodyText: true, content: true, actorName: true, occurredAt: true },
        orderBy: { occurredAt: 'desc' },
        take: 300,
      });
      reasonEntriesByTicket = indexThreadEntriesByTicket(entries);
    } catch (error) {
      logger.debug('Risk signal thread lookup failed', { workspaceId, ticketId, error: error.message });
    }
  }

  const openMap = Object.fromEntries(openTickets.map((row) => [row.assignedTechId, groupCount(row)]));
  const todayMap = Object.fromEntries(todayTickets.map((row) => [row.assignedTechId, groupCount(row)]));
  const leaveMap = new Map();
  for (const leave of leaves) {
    if (!leaveMap.has(leave.technicianId)) leaveMap.set(leave.technicianId, []);
    leaveMap.get(leave.technicianId).push(leave);
  }

  const episodesByTech = new Map();
  for (const episode of episodes) {
    if (!episodesByTech.has(episode.technicianId)) episodesByTech.set(episode.technicianId, []);
    episodesByTech.get(episode.technicianId).push(episode);
  }

  const candidates = techs.map((tech) => {
    const techEpisodes = episodesByTech.get(tech.id) || [];
    const sameTicketRejected = !!(target.ticketId && techEpisodes.some((episode) => episode.ticketId === target.ticketId));
    const sameDayEpisodes = techEpisodes.filter((episode) => episode.endedAt && episode.endedAt >= todayStart && episode.endedAt <= todayEnd);
    const classificationMatches = techEpisodes.map((episode) => ({
      episode,
      ...sameClassification(episode.ticket, target),
    }));
    const sameSubcategoryEpisodes = classificationMatches.filter((row) => row.sameSubcategory);
    const sameCategoryEpisodes = classificationMatches.filter((row) => row.sameCategory || row.sameLegacyCategory);
    const recentReasons = [];
    for (const episode of techEpisodes) {
      const reason = findRiskReasonForEpisode(episode, reasonEntriesByTicket);
      if (reason && !recentReasons.includes(reason)) recentReasons.push(reason);
      if (recentReasons.length >= 3) break;
    }

    const busyReason = recentReasons.find((reason) => RISK_REASON_PATTERN.test(reason));
    const techLeaves = leaveMap.get(tech.id) || [];
    const fullDayOff = techLeaves.some((leave) => leave.isFullDay !== false && leave.category === 'OFF');
    const fullDayWfh = techLeaves.some((leave) => leave.isFullDay !== false && leave.category === 'WFH');
    const shift = getAgentShiftStatus(tech, timezone);
    const openTickets = openMap[tech.id] || 0;
    const todayAssigned = todayMap[tech.id] || 0;

    let riskPenalty = 0;
    if (sameTicketRejected) riskPenalty = Math.max(riskPenalty, 0.95);
    if (fullDayOff) riskPenalty = Math.max(riskPenalty, 0.9);
    if (busyReason) riskPenalty = Math.max(riskPenalty, 0.65);
    if (sameDayEpisodes.length >= 2) riskPenalty = Math.max(riskPenalty, 0.45);
    else if (sameDayEpisodes.length === 1) riskPenalty = Math.max(riskPenalty, 0.22);
    if (sameSubcategoryEpisodes.length > 0) riskPenalty = Math.max(riskPenalty, 0.3);
    if (!shift.onShift) riskPenalty = Math.max(riskPenalty, 0.15);
    if (openTickets >= 15) riskPenalty = Math.max(riskPenalty, 0.25);
    else if (openTickets >= 10) riskPenalty = Math.max(riskPenalty, 0.15);

    const activeSuppression = sameTicketRejected || fullDayOff || !!busyReason
      ? {
        active: true,
        reason: sameTicketRejected
          ? 'same_ticket_rejected'
          : fullDayOff ? 'full_day_leave' : 'recent_busy_or_unavailable_rejection',
        until: new Date(Date.now() + minutesUntilEndOfLocalDay(timezone) * 60 * 1000).toISOString(),
      }
      : { active: false, reason: null, until: null };
    const riskLevel = riskLevelFromPenalty(riskPenalty);

    return {
      techId: tech.id,
      techName: tech.name,
      location: tech.location || 'Not set',
      sameTicketRejected,
      sameDayRejectedCount: sameDayEpisodes.length,
      sameShiftRejectedCount: sameDayEpisodes.length,
      sameCategoryRejectedCount: sameCategoryEpisodes.length,
      sameSubcategoryRejectedCount: sameSubcategoryEpisodes.length,
      lastRejectedAt: techEpisodes[0]?.endedAt?.toISOString?.() || null,
      recentRejectionReasons: recentReasons,
      availability: {
        fullDayOff,
        fullDayWfh,
        onShift: shift.onShift,
        shiftStatus: shift.shiftNote,
      },
      workload: {
        openTickets,
        todayAssigned,
      },
      riskPenalty: Number(riskPenalty.toFixed(2)),
      riskLevel,
      availabilitySuppression: activeSuppression,
      rankingAdvice: buildRiskAdvice({
        riskLevel,
        sameTicketRejected,
        activeSuppression,
        sameDayRejectedCount: sameDayEpisodes.length,
        sameSubcategoryRejectedCount: sameSubcategoryEpisodes.length,
      }),
    };
  }).sort((a, b) => b.riskPenalty - a.riskPenalty || b.sameDayRejectedCount - a.sameDayRejectedCount);

  return {
    ticket: targetTicket ? {
      id: targetTicket.id,
      freshserviceTicketId: targetTicket.freshserviceTicketId ? Number(targetTicket.freshserviceTicketId) : null,
      subject: targetTicket.subject,
      categoryId: target.categoryId,
      subcategoryId: target.subcategoryId,
      ticketCategory: target.ticketCategory,
    } : null,
    lookbackDays,
    workspaceTimezone: timezone,
    candidates,
    summary: {
      assessedCandidates: candidates.length,
      highRiskCount: candidates.filter((candidate) => ['high', 'critical'].includes(candidate.riskLevel)).length,
      suppressedCount: candidates.filter((candidate) => candidate.availabilitySuppression.active).length,
    },
    note: 'Use these signals as internal ranking context. Do not expose rejection/capacity details in agentBriefingHtml.',
  };
}

function scoreCandidate(candidate, allCandidates, weights) {
  const openMax = Math.max(1, ...allCandidates.map((item) => item.openTickets || 0));
  const competencyScore = candidate.competencyMatch?.matchType === 'subcategory_exact'
    ? 1
    : candidate.competencyMatch?.matchType === 'parent_fallback'
      ? 0.72
      : candidate.competencyMatch?.matchType === 'category_exact' ? 0.65 : 0.25;
  const workloadScore = clampScore(1 - ((candidate.openTickets || 0) / openMax));
  const locationScore = candidate.locationMatch === null ? 0.55 : candidate.locationMatch ? 1 : 0.2;
  const recencyScore = clampScore(1 - (candidate.assignmentRisk?.riskPenalty || 0));
  const baseScore = clampScore(
    (weights.competency * competencyScore)
    + (weights.workload * workloadScore)
    + (weights.location * locationScore)
    + (weights.recency * recencyScore),
  );
  const riskAdjustedScore = clampScore(baseScore - ((candidate.assignmentRisk?.riskPenalty || 0) * 0.45));

  return {
    baseScore: Number(baseScore.toFixed(3)),
    riskAdjustedScore: Number(riskAdjustedScore.toFixed(3)),
    scoreFactors: {
      competency: Number(competencyScore.toFixed(3)),
      workload: Number(workloadScore.toFixed(3)),
      location: Number(locationScore.toFixed(3)),
      recency: Number(recencyScore.toFixed(3)),
      riskPenalty: candidate.assignmentRisk?.riskPenalty || 0,
      weights,
    },
  };
}

function normalizeScoringWeights(raw = {}) {
  const defaults = { competency: 0.35, workload: 0.30, location: 0.20, recency: 0.15 };
  const merged = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const value = Number(raw?.[key]);
    return [key, Number.isFinite(value) && value >= 0 ? value : fallback];
  }));
  const total = Object.values(merged).reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, Number((value / total).toFixed(3))]));
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

  const [techs, competencies, leaves, openTickets, todayTickets, assignmentConfig] = await Promise.all([
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
    prisma.assignmentConfig.findUnique({
      where: { workspaceId },
      select: { scoringWeights: true },
    }).catch(() => null),
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

  const openMap = Object.fromEntries(openTickets.map((r) => [r.assignedTechId, groupCount(r)]));
  const todayMap = Object.fromEntries(todayTickets.map((r) => [r.assignedTechId, groupCount(r)]));

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

  let riskSummary = null;
  try {
    const riskSignals = await getAssignmentRiskSignals(workspaceId, {
      ticket_id: ticketId,
      categoryId: categorySelection.category?.id || categoryId,
      subcategoryId: categorySelection.subcategory?.id || subcategoryId,
      candidate_tech_ids: results.map((result) => result.techId),
      lookback_days: 5,
    });
    const byTech = new Map((riskSignals.candidates || []).map((candidate) => [candidate.techId, candidate]));
    for (const result of results) {
      const risk = byTech.get(result.techId) || null;
      result.assignmentRisk = risk ? {
        sameTicketRejected: risk.sameTicketRejected,
        sameDayRejectedCount: risk.sameDayRejectedCount,
        sameSubcategoryRejectedCount: risk.sameSubcategoryRejectedCount,
        sameCategoryRejectedCount: risk.sameCategoryRejectedCount,
        lastRejectedAt: risk.lastRejectedAt,
        recentRejectionReasons: risk.recentRejectionReasons,
        riskPenalty: risk.riskPenalty,
        riskLevel: risk.riskLevel,
        availabilitySuppression: risk.availabilitySuppression,
        rankingAdvice: risk.rankingAdvice,
      } : null;
      result.previouslyRejectedThisTicket = !!risk?.sameTicketRejected;
      if (risk?.sameTicketRejected && risk.lastRejectedAt) result.rejectedAt = risk.lastRejectedAt;
    }
    riskSummary = riskSignals.summary || null;
  } catch (error) {
    logger.debug('find_matching_agents risk signal enrichment failed', { workspaceId, ticketId, error: error.message });
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
  }

  const scoringWeights = normalizeScoringWeights(assignmentConfig?.scoringWeights);
  for (const result of results) {
    Object.assign(result, scoreCandidate(result, results, scoringWeights));
  }

  results.sort((a, b) => {
    if (!!a.assignmentRisk?.availabilitySuppression?.active !== !!b.assignmentRisk?.availabilitySuppression?.active) {
      return a.assignmentRisk?.availabilitySuppression?.active ? 1 : -1;
    }
    if (!!a.previouslyRejectedThisTicket !== !!b.previouslyRejectedThisTicket) {
      return a.previouslyRejectedThisTicket ? 1 : -1;
    }
    if (b.riskAdjustedScore !== a.riskAdjustedScore) return b.riskAdjustedScore - a.riskAdjustedScore;

    const aPriority = a.competencyMatch?.matchPriority || 0;
    const bPriority = b.competencyMatch?.matchPriority || 0;
    if (bPriority !== aPriority) return bPriority - aPriority;

    const aLevel = a.competencyMatch ? (proficiencyOrder[a.competencyMatch.level] || 0) : 0;
    const bLevel = b.competencyMatch ? (proficiencyOrder[b.competencyMatch.level] || 0) : 0;
    if (bLevel !== aLevel) return bLevel - aLevel;

    return a.openTickets - b.openTickets;
  });

  const competencyCoverage = {
    selectedCategoryId: categorySelection.category?.id || null,
    selectedCategoryName: categorySelection.category?.name || categoryName || category || null,
    selectedSubcategoryId: categorySelection.subcategory?.id || null,
    selectedSubcategoryName: categorySelection.subcategory?.name || subcategoryName || null,
    exactSubcategoryMatches: results.filter((r) => r.competencyMatch?.matchType === 'subcategory_exact').length,
    parentFallbackMatches: results.filter((r) => r.competencyMatch?.matchType === 'parent_fallback').length,
    categoryExactMatches: results.filter((r) => r.competencyMatch?.matchType === 'category_exact').length,
    noCompetencyMatch: results.filter((r) => !r.competencyMatch).length,
  };
  competencyCoverage.note = categorySelection.subcategory
    ? (competencyCoverage.exactSubcategoryMatches > 0
      ? `${competencyCoverage.exactSubcategoryMatches} agent(s) have exact subcategory competency for ${categorySelection.subcategory.name}.`
      : `No active agent has exact subcategory competency for ${categorySelection.subcategory.name}; parent-category fallback is the best available competency signal unless history shows otherwise.`)
    : 'No subcategory was selected; parent-category competency is the strongest available taxonomy match.';

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
    competencyCoverage,
    riskSummary,
    scoringWeights,
    matchCount: results.length,
    matches: results,
    excludedCount: excluded.length,
    excluded,
    note: results.length === 0
      ? 'No agents match all criteria. Consider relaxing requirements (e.g., remove physical presence, lower proficiency, or broaden category).'
      : `Found ${results.length} matching agent(s). Sorted by risk-adjusted score using competency, workload, location, and recent rejection/capacity signals.`,
  };
}

// ── Search and history tools ──────────────────────────────────────────────

async function searchTickets(workspaceId, params) {
  const {
    keyword, category, sub_category, assigned_tech_id,
    status, priority, date_from, date_to, sort_by,
    internal_category_id, internal_subcategory_id,
    internal_category_name, internal_subcategory_name,
    taxonomy_review_needed,
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
  if (Number.isInteger(Number(internal_category_id))) where.internalCategoryId = Number(internal_category_id);
  if (Number.isInteger(Number(internal_subcategory_id))) where.internalSubcategoryId = Number(internal_subcategory_id);
  if (typeof taxonomy_review_needed === 'boolean') where.taxonomyReviewNeeded = taxonomy_review_needed;

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
    andClauses.push({
      OR: [
        { category },
        { ticketCategory: category },
        { internalCategory: { name: { contains: category, mode: 'insensitive' } } },
        { internalSubcategory: { name: { contains: category, mode: 'insensitive' } } },
      ],
    });
  }
  if (internal_category_name) {
    andClauses.push({
      internalCategory: { name: { contains: internal_category_name, mode: 'insensitive' } },
    });
  }
  if (internal_subcategory_name) {
    andClauses.push({
      internalSubcategory: { name: { contains: internal_subcategory_name, mode: 'insensitive' } },
    });
  }
  if (keyword) {
    andClauses.push({ OR: [
      { subject: { contains: keyword, mode: 'insensitive' } },
      { descriptionText: { contains: keyword, mode: 'insensitive' } },
      { internalCategory: { name: { contains: keyword, mode: 'insensitive' } } },
      { internalSubcategory: { name: { contains: keyword, mode: 'insensitive' } } },
      { suggestedInternalCategoryName: { contains: keyword, mode: 'insensitive' } },
      { suggestedInternalSubcategoryName: { contains: keyword, mode: 'insensitive' } },
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
        groupId: true,
        subject: true,
        status: true,
        priority: true,
        category: true,
        subCategory: true,
        ticketCategory: true,
        internalCategoryFit: true,
        internalSubcategoryFit: true,
        internalCategoryConfidence: true,
        internalCategoryRationale: true,
        taxonomyReviewNeeded: true,
        suggestedInternalCategoryName: true,
        suggestedInternalSubcategoryName: true,
        rejectionCount: true,
        createdAt: true,
        resolvedAt: true,
        assignedTechId: true,
        isSelfPicked: true,
        internalCategory: { select: { id: true, name: true, parentId: true } },
        internalSubcategory: { select: { id: true, name: true, parentId: true } },
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
      groupId: t.groupId ? Number(t.groupId) : null,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      category: t.category,
      subCategory: t.subCategory,
      ticketCategory: t.ticketCategory,
      ...formatTicketInternalClassification(t),
      createdAt: t.createdAt ? formatDateInTimezone(t.createdAt, tz) : null,
      resolvedAt: t.resolvedAt ? formatDateInTimezone(t.resolvedAt, tz) : null,
      assignedTo: t.assignedTech?.name || 'Unassigned',
      assignedTechId: t.assignedTechId,
      selfPicked: t.isSelfPicked,
      assignmentSignals: {
        rejectionCount: t.rejectionCount || 0,
        hasRejectedEpisode: (t.rejectionCount || 0) > 0,
      },
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
        groupId: true,
        subject: true,
        status: true,
        priority: true,
        category: true,
        subCategory: true,
        ticketCategory: true,
        internalCategoryFit: true,
        internalSubcategoryFit: true,
        internalCategoryConfidence: true,
        internalCategoryRationale: true,
        taxonomyReviewNeeded: true,
        suggestedInternalCategoryName: true,
        suggestedInternalSubcategoryName: true,
        rejectionCount: true,
        createdAt: true,
        resolvedAt: true,
        isSelfPicked: true,
        internalCategory: { select: { id: true, name: true, parentId: true } },
        internalSubcategory: { select: { id: true, name: true, parentId: true } },
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
  const taxonomyReviewNeeded = tickets.filter((t) => t.taxonomyReviewNeeded).length;
  const rejectedSignals = tickets.reduce((sum, t) => sum + (t.rejectionCount || 0), 0);
  const taxonomyBreakdowns = buildInternalTaxonomyBreakdown(tickets);

  return {
    technician: { id: tech.id, name: tech.name, location: tech.location },
    period: `Last ${days} days`,
    summary: {
      totalTickets,
      resolvedInPeriod: resolved,
      selfPickedInPeriod: selfPicked,
      taxonomyReviewNeeded,
      rejectedSignals,
      avgResolutionTimeMins: resolutionStats._avg?.resolutionTimeSeconds
        ? Math.round(resolutionStats._avg.resolutionTimeSeconds / 60)
        : null,
    },
    categoryBreakdown: categoryBreakdown.map((c) => ({
      category: c.ticketCategory || c.category,
      count: c._count,
    })),
    ...taxonomyBreakdowns,
    recentTickets: tickets.slice(0, 15).map((t) => ({
      id: t.id,
      freshserviceTicketId: Number(t.freshserviceTicketId),
      groupId: t.groupId ? Number(t.groupId) : null,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      category: t.ticketCategory || t.category,
      rawFreshServiceCategory: t.category,
      rawFreshServiceSubcategory: t.subCategory,
      ...formatTicketInternalClassification(t),
      assignmentSignals: {
        rejectionCount: t.rejectionCount || 0,
        hasRejectedEpisode: (t.rejectionCount || 0) > 0,
      },
      createdAt: t.createdAt ? formatDateInTimezone(t.createdAt, tz) : null,
      resolvedAt: t.resolvedAt ? formatDateInTimezone(t.resolvedAt, tz) : null,
      selfPicked: t.isSelfPicked,
    })),
    insight: taxonomyBreakdowns.internalTaxonomyBreakdown.length > 0
      ? `${tech.name}'s top internal categories: ${taxonomyBreakdowns.internalTaxonomyBreakdown.slice(0, 5).map((c) => `${c.internalPath} (${c.count})`).join(', ')}`
      : `${tech.name} has no internally categorized tickets in the last ${days} days.`,
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
      internalCategory: { select: { id: true, name: true, parentId: true } },
      internalSubcategory: { select: { id: true, name: true, parentId: true } },
    },
  });

  if (!ticket) return { error: 'Ticket not found' };
  const timezone = await getWorkspaceTimezone(ticket.workspaceId);

  return {
    id: ticket.id,
    freshserviceTicketId: Number(ticket.freshserviceTicketId),
    groupId: ticket.groupId ? Number(ticket.groupId) : null,
    subject: ticket.subject,
    description: (ticket.descriptionText || ticket.description || '').slice(0, 5000),
    status: ticket.status,
    priority: ticket.priority,
    priorityLabel: { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' }[ticket.priority] || `P${ticket.priority}`,
    assessedPriority: ticket.assessedPriority,
    assessedPriorityId: ticket.assessedPriorityId,
    priorityRationale: ticket.priorityRationale,
    priorityConfidence: ticket.priorityConfidence,
    priorityEvidence: ticket.priorityEvidence,
    priorityAssessedAt: ticket.priorityAssessedAt?.toISOString?.() || null,
    category: ticket.category,
    subCategory: ticket.subCategory,
    ticketCategory: ticket.ticketCategory,
    ...formatTicketInternalClassification(ticket),
    department: ticket.department,
    source: ticket.source,
    isEscalated: ticket.isEscalated,
    assignmentSignals: {
      rejectionCount: ticket.rejectionCount || 0,
      hasRejectedEpisode: (ticket.rejectionCount || 0) > 0,
    },
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
  const [categories, mappings, activeTechnicians] = await Promise.all([
    prisma.competencyCategory.findMany({
      where: { workspaceId, isActive: true },
      orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.technicianCompetency.findMany({
      where: { workspaceId, competencyCategory: { isActive: true } },
      include: {
        technician: { select: { id: true, name: true } },
        competencyCategory: { select: { id: true, name: true, parentId: true } },
      },
    }),
    prisma.technician.count({ where: { workspaceId, isActive: true } }),
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
  const coverageByCategoryId = new Map();
  for (const category of categories) {
    coverageByCategoryId.set(category.id, {
      categoryId: category.id,
      category: category.name,
      parentId: category.parentId,
      levelType: category.parentId ? 'subcategory' : 'category',
      mappedTechnicians: 0,
      byLevel: { basic: 0, intermediate: 0, advanced: 0, expert: 0 },
    });
  }
  for (const mapping of mappings) {
    const coverage = coverageByCategoryId.get(mapping.competencyCategoryId);
    if (!coverage) continue;
    coverage.mappedTechnicians += 1;
    if (coverage.byLevel[mapping.proficiencyLevel] !== undefined) {
      coverage.byLevel[mapping.proficiencyLevel] += 1;
    }
  }

  return {
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      parentId: c.parentId,
      levelType: c.parentId ? 'subcategory' : 'category',
    })),
    categoryTree: buildInternalTaxonomy(categories),
    competencyCoverage: {
      activeTechnicians,
      categoriesWithNoMappedTechnicians: Array.from(coverageByCategoryId.values())
        .filter((row) => row.mappedTechnicians === 0),
      categoryCoverage: Array.from(coverageByCategoryId.values()),
      note: 'No experience is represented by no competency mapping. For a selected subcategory, prefer technicians mapped to that exact subcategory; parent-category mappings are fallback only.',
    },
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
