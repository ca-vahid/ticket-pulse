import { formatInTimeZone } from 'date-fns-tz';

/**
 * Build the first user message for the assignment-pipeline LLM. Pure function —
 * extracted from assignmentPipelineService so it can be unit-tested without
 * pulling in the full service (Prisma, Anthropic SDK, etc).
 *
 * When the run was created as a rebound (syncService persists `reboundFrom` on
 * the run record), prepend a "## Rebound Context" block so the LLM knows which
 * attempt this is and how to handle the agent-facing briefing.
 *
 * @param {object}  args
 * @param {number}  args.ticketId        Internal ticket id
 * @param {string}  args.dayOfWeek       e.g. "Monday"
 * @param {string}  args.localDate       e.g. "2026-04-21"
 * @param {string}  args.localTime       e.g. "14:32"
 * @param {string}  args.wsTz            IANA tz, e.g. "America/Los_Angeles"
 * @param {object}  [args.reboundFrom]   { previousTechName, unassignedAt, reboundCount }
 * @returns {string}
 */
export function buildUserMessage({ ticketId, dayOfWeek, localDate, localTime, wsTz, reboundFrom }) {
  let userMessage = `Current date/time: ${dayOfWeek}, ${localDate} at ${localTime} (${wsTz})\n\nAnalyze ticket ID ${ticketId} (use get_ticket_details to read it) and recommend the best technician for assignment. When you have completed your analysis, you MUST call the submit_recommendation tool with your final recommendation.`;

  if (reboundFrom && (reboundFrom.previousTechName || reboundFrom.reboundCount)) {
    const reboundCount = reboundFrom.reboundCount || 1;
    const prevName = reboundFrom.previousTechName || 'a previous assignee';
    const whenStr = reboundFrom.unassignedAt
      ? formatInTimeZone(new Date(reboundFrom.unassignedAt), wsTz, 'yyyy-MM-dd HH:mm zzz')
      : 'recently';
    const ordinal = reboundCount === 1 ? '1st' : reboundCount === 2 ? '2nd' : reboundCount === 3 ? '3rd' : `${reboundCount}th`;
    // Surface the rebound state explicitly so the LLM (a) actively avoids the
    // prior rejecter via the previouslyRejectedThisTicket flag from
    // find_matching_agents, and (b) knows to acknowledge the re-routing in
    // agentBriefingHtml without naming the previous assignee.
    userMessage += `\n\n## Rebound Context\nThis ticket was previously assigned and returned to the queue. This is the ${ordinal} attempt to find an assignee. Most recently it was returned by ${prevName} at ${whenStr}.\n\nWhen calling find_matching_agents, expect to see \`previouslyRejectedThisTicket: true\` on at least one candidate. Avoid recommending any agent flagged as a prior rejecter unless they are genuinely the only qualified option (and explain why in overallReasoning if so).\n\nWhen writing the agentBriefingHtml, include a brief, neutral acknowledgement that this ticket was re-routed (e.g. "This ticket was returned to the queue and now needs your attention"). Do NOT name the previous assignee or explain why they returned it.`;
  }

  return userMessage;
}
