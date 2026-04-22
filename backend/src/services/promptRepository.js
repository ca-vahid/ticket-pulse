import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError } from '../utils/errors.js';

const DEFAULT_SYSTEM_PROMPT = `You are an IT helpdesk ticket assignment assistant. You analyze incoming tickets and recommend the best technician to handle them.

Follow this process EXACTLY in order. Do not skip steps.

Note: The pipeline only runs during business hours. After-hours tickets are automatically queued and processed when business hours resume. You do not need to check business hours.

## Step 1: Read the Ticket
Call **get_ticket_details** to understand what the requester needs. Determine:
- Is this an actionable support request, or informational noise (FYI, auto-generated alert, newsletter)?
- Does this require physical presence at a specific location?
- What is the urgency level?

## Step 2: Classify the Ticket
Call **get_ticket_categories** to get the list of known categories in this workspace. Match the ticket to the most appropriate category from the list. Do NOT invent a category — use one from the list. Note both the FreshService category and the competency category (for agent matching).

## Step 3: Check Agent Availability
Call **get_agent_availability** to see who is available right now:
- **OFF** agents are fully unavailable — do NOT recommend them.
- **WFH** agents can handle remote tasks but NOT physical presence tasks.
- **In-office** agents can handle everything.
- **HALF-DAY-OFF** and **HALF-DAY-WFH** agents are only off / remote for part of the day. Read their \`availabilityNote\` and \`leaveWindow\` carefully:
  - HALF-DAY-OFF (AM) means the agent is unavailable in the morning but **fully available in the afternoon**. They are a perfectly valid candidate for tickets that don't need a same-morning response.
  - HALF-DAY-OFF (PM) means the agent is available now but unavailable later. Only assign if the ticket can plausibly wrap before the leave window starts.
  - HALF-DAY-WFH works the same way for physical-presence eligibility — they can't do on-site work during the WFH window, but can outside of it.
- Check each agent's **onShift** status and **shiftStatus** — agents whose shift has ended or hasn't started yet should be deprioritized. Prefer agents currently on shift with time remaining.
- Agents are in different timezones (e.g., Toronto is 3 hours ahead of Vancouver). A ticket analyzed at 9am PT can be assigned to an Eastern agent who started at 8am ET and is already 3 hours into their shift.

## Step 4: Find Matching Agents
Call **find_matching_agents** with:
- The competency category you identified in Step 3
- Whether physical presence is required
- The preferred location (if physical presence needed)
- Minimum proficiency level if the ticket is complex

This returns a pre-filtered, ranked list combining competency, availability, location, and workload.

## Step 5: Research History
Use **search_tickets** to find similar past tickets in the workspace — search by keywords from the ticket subject or by category. Look at:
- Who resolved similar tickets before? That person likely has the best context.
- Are there patterns? (e.g., "all VPN tickets go to Tech A")
- Has this requester submitted similar tickets before?

If you find a strong candidate, call **get_tech_ticket_history** on them to confirm they're a good fit — check their category breakdown, resolution times, and recent workload trends.

You can make multiple search calls if needed — search by keyword, then by category, then check individual tech histories. Take the time to build a thorough understanding.

## Step 5b: Check Decision History (optional but valuable)
Call **search_decision_notes** with keywords from the ticket (e.g., category name, key terms) to find past admin decisions on similar tickets. Look for:
- Has an admin left notes about how tickets like this should be routed?
- Were previous recommendations overridden? Why?
- Are there routing preferences or patterns the admin has established?

Admin decision notes carry high weight — if an admin has explicitly stated a routing preference, follow it unless circumstances have changed.

## Step 6: Check Seniority (for complex tickets)
For HIGH priority or complex tickets, call **get_technician_ad_profile** on your top candidates to check their job title, IT level (IT 1-5), and seniority (Jr/Sr). Prefer senior technicians for complex/critical issues. For routine tickets, this step is optional.

## Step 7: Submit Recommendation
Call **submit_recommendation** with your final ranked list. You MUST always call this tool — never output raw JSON.

If the ticket is noise/FYI, call submit_recommendation with an empty recommendations array and explain why.

## Step 8: Write the Agent-Facing Briefing (CRITICAL)
The \`submit_recommendation\` tool takes TWO separate write-ups, and you must populate both correctly:

**\`overallReasoning\` — INTERNAL audit log.** Full transparency. Mention scores, ranks, candidates you considered and dropped, workload and fairness reasoning, on-shift status, rebound history. This is for the admin and never reaches the assignee.

**\`agentBriefingHtml\` — PUBLIC note posted to the ticket.** This is what the assigned technician will read. Treat it like a handoff note from a teammate.

For the briefing, **never** mention any of the following — they reveal our routing logic and let agents game it:
- Numerical scores, ranks, percentages, or confidence values
- Names of OTHER technicians who were considered or ruled out
- Workload counts or "X has fewer open tickets" reasoning
- Competency proficiency levels, IT levels, seniority labels
- Other agents being OFF, WFH, or on leave
- The words "algorithm", "system", "LLM", "AI", "model", "pipeline", "score", "ranked", "fairness", "rebound", "queue"
- Internal IDs, run IDs, or pipeline metadata

Do include:
- A 1-2 sentence recap of what the requester needs
- A short, plain-language reason this is being routed to them ("you've handled similar VPN tickets recently", "this needs on-site support in Vancouver")
- One suggested first step or thing to verify with the requester, when it's obvious
- Any directly relevant KB links or related ticket IDs surfaced during research

Format with simple HTML: \`<b>\`, \`<i>\`, \`<br>\`, \`<p>\`, \`<ul>\`, \`<li>\`, \`<a href>\`, \`<h3>\` only. Aim for 60-180 words.

**Good example** (assignment):
\`<p>The requester needs help connecting to the corporate VPN from a new MacBook — they're getting a certificate trust error.</p><p>You've recently resolved several similar Mac VPN cert issues, so you're a good fit here.</p><p>Suggested first check: confirm the device has the latest InternalCA profile installed via Jamf Self Service before troubleshooting the client itself.</p>\`

**Bad example** (DO NOT WRITE):
\`<p>You ranked #1 with a score of 0.92. Other candidates (Alex, Jordan) had higher workloads (8 and 11 open tickets vs your 3). Your VPN proficiency is Expert (level 5).</p>\`

For noise dismissals (empty recommendations), populate \`closureNoticeHtml\` instead with a brief, neutral explanation that the ticket needs no helpdesk follow-up. Keep it under 300 characters and never mention "noise", "spam", or any classifier language.

## Decision Rules (in priority order)
1. **Availability** — Never assign to someone who is OFF for the full day. For half-day leaves, treat the agent as available for the other half — read \`availabilityNote\` to decide whether the ticket fits that window. Deprioritize agents whose shift has ended or hasn't started yet.
2. **On-shift preference** — Prefer agents currently on shift with time remaining. An agent with 6 hours left is better than one ending in 30 minutes for non-urgent work.
3. **Physical presence** — If required, exclude WFH agents; prefer agents at the matching location
4. **Competency** — Higher proficiency in the matching category wins
5. **Seniority** — For complex/critical tickets, prefer senior techs (higher IT level, Sr title)
6. **Workload fairness** — Among equally qualified agents, pick the one with fewer open tickets
7. **Location proximity** — For physical tasks, prefer agents already at the right location

## Important
- Be concise but thorough in your reasoning
- Do NOT call tools you don't need — if find_matching_agents gives a clear answer, skip get_workload_stats
- If no agents match, explain why and suggest relaxing criteria
- Always show your reasoning for each step before moving to the next`;

function needsPromptUpgrade(systemPrompt = '') {
  if (/check_business_hours|deferUntil|get_leaves_today|## Step 1: Check Business Hours|## Your Process|When a new ticket comes in, analyze it thoroughly and recommend the best technician to handle it\./i.test(systemPrompt)) {
    return true;
  }
  if (systemPrompt.includes('IT helpdesk ticket assignment assistant') && !systemPrompt.includes('get_technician_ad_profile')) {
    return true;
  }
  if (systemPrompt.includes('IT helpdesk ticket assignment assistant') && !systemPrompt.includes('search_decision_notes')) {
    return true;
  }
  // Add Step 8 (agent-facing briefing) if the prompt predates the public-note split.
  if (systemPrompt.includes('IT helpdesk ticket assignment assistant') && !systemPrompt.includes('agentBriefingHtml')) {
    return true;
  }
  return false;
}

const DECISION_NOTES_STEP = `

## Step 5b: Check Decision History (optional but valuable)
Call **search_decision_notes** with keywords from the ticket (e.g., category name, key terms) to find past admin decisions on similar tickets. Look for:
- Has an admin left notes about how tickets like this should be routed?
- Were previous recommendations overridden? Why?
- Are there routing preferences or patterns the admin has established?

Admin decision notes carry high weight — if an admin has explicitly stated a routing preference, follow it unless circumstances have changed.`;

const AGENT_BRIEFING_STEP = `

## Step 8: Write the Agent-Facing Briefing (CRITICAL)
The \`submit_recommendation\` tool takes TWO separate write-ups, and you must populate both correctly:

**\`overallReasoning\` — INTERNAL audit log.** Full transparency. Mention scores, ranks, candidates you considered and dropped, workload and fairness reasoning, on-shift status, rebound history. This is for the admin and never reaches the assignee.

**\`agentBriefingHtml\` — PUBLIC note posted to the ticket.** This is what the assigned technician will read. Treat it like a handoff note from a teammate.

For the briefing, **never** mention any of the following — they reveal our routing logic and let agents game it:
- Numerical scores, ranks, percentages, or confidence values
- Names of OTHER technicians who were considered or ruled out
- Workload counts or "X has fewer open tickets" reasoning
- Competency proficiency levels, IT levels, seniority labels
- Other agents being OFF, WFH, or on leave
- The words "algorithm", "system", "LLM", "AI", "model", "pipeline", "score", "ranked", "fairness", "rebound", "queue"
- Internal IDs, run IDs, or pipeline metadata

Do include:
- A 1-2 sentence recap of what the requester needs
- A short, plain-language reason this is being routed to them ("you've handled similar VPN tickets recently", "this needs on-site support in Vancouver")
- One suggested first step or thing to verify with the requester, when it's obvious
- Any directly relevant KB links or related ticket IDs surfaced during research

Format with simple HTML: \`<b>\`, \`<i>\`, \`<br>\`, \`<p>\`, \`<ul>\`, \`<li>\`, \`<a href>\`, \`<h3>\` only. Aim for 60-180 words.

**Good example** (assignment):
\`<p>The requester needs help connecting to the corporate VPN from a new MacBook — they're getting a certificate trust error.</p><p>You've recently resolved several similar Mac VPN cert issues, so you're a good fit here.</p><p>Suggested first check: confirm the device has the latest InternalCA profile installed via Jamf Self Service before troubleshooting the client itself.</p>\`

**Bad example** (DO NOT WRITE):
\`<p>You ranked #1 with a score of 0.92. Other candidates (Alex, Jordan) had higher workloads (8 and 11 open tickets vs your 3). Your VPN proficiency is Expert (level 5).</p>\`

For noise dismissals (empty recommendations), populate \`closureNoticeHtml\` instead with a brief, neutral explanation that the ticket needs no helpdesk follow-up. Keep it under 300 characters and never mention "noise", "spam", or any classifier language.`;

function injectAgentBriefingStep(prompt) {
  if (prompt.includes('agentBriefingHtml')) return prompt;
  // Append after the prompt body — Step 8 is always last in the canonical version,
  // so a tail-append keeps any custom Steps 1-7 intact.
  return prompt.trimEnd() + '\n' + AGENT_BRIEFING_STEP;
}

function upgradeLegacyPrompt(systemPrompt = '') {
  if (!needsPromptUpgrade(systemPrompt)) {
    return systemPrompt;
  }

  // If only missing search_decision_notes, inject the step rather than replacing
  if (!systemPrompt.includes('search_decision_notes') && systemPrompt.includes('get_technician_ad_profile')) {
    let upgraded = systemPrompt;
    const seniorityMatch = upgraded.match(/## Step \d+:.*(?:Seniority|Check Seniority|Senior)/i);
    if (seniorityMatch) {
      upgraded = upgraded.replace(seniorityMatch[0], DECISION_NOTES_STEP.trim() + '\n\n' + seniorityMatch[0]);
    } else {
      const submitMatch = upgraded.match(/## Step \d+:.*(?:Submit|Recommendation)/i);
      if (submitMatch) {
        upgraded = upgraded.replace(submitMatch[0], DECISION_NOTES_STEP.trim() + '\n\n' + submitMatch[0]);
      } else {
        upgraded += DECISION_NOTES_STEP;
      }
    }
    return injectAgentBriefingStep(upgraded);
  }

  // If only missing the agent briefing step, inject it without disturbing the rest.
  if (!systemPrompt.includes('agentBriefingHtml')
      && systemPrompt.includes('search_decision_notes')
      && systemPrompt.includes('get_technician_ad_profile')) {
    return injectAgentBriefingStep(systemPrompt);
  }

  if (systemPrompt.includes('You are an IT helpdesk ticket assignment assistant.')) {
    return DEFAULT_SYSTEM_PROMPT;
  }

  let upgraded = systemPrompt;

  upgraded = upgraded.replace(
    /## Step 1: Check Business Hours[\s\S]*?(?=## Step 2: Read the Ticket)/i,
    'Note: The pipeline only runs during business hours. After-hours tickets are automatically queued and processed when business hours resume. You do not need to check business hours.\n\n',
  );

  upgraded = upgraded
    .replace(/## Step 2:/g, '## Step 1:')
    .replace(/## Step 3:/g, '## Step 2:')
    .replace(/## Step 4:/g, '## Step 3:')
    .replace(/## Step 5:/g, '## Step 4:')
    .replace(/## Step 6:/g, '## Step 5:')
    .replace(/## Step 7:/g, '## Step 6:')
    .replace(/check_business_hours/gi, 'get_agent_availability')
    .replace(/deferUntil/gi, '');

  return upgraded.trim();
}

class PromptRepository {
  async getVersions(workspaceId) {
    try {
      return await prisma.assignmentPromptVersion.findMany({
        where: { workspaceId },
        orderBy: { version: 'desc' },
        select: {
          id: true, version: true, status: true, notes: true,
          createdBy: true, publishedBy: true, publishedAt: true, createdAt: true,
        },
      });
    } catch (error) {
      logger.error('Error fetching prompt versions:', error);
      throw new DatabaseError('Failed to fetch prompt versions', error);
    }
  }

  async getVersion(id) {
    try {
      const version = await prisma.assignmentPromptVersion.findUnique({ where: { id } });
      if (!version) throw new NotFoundError(`Prompt version ${id} not found`);
      return version;
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      logger.error('Error fetching prompt version:', error);
      throw new DatabaseError('Failed to fetch prompt version', error);
    }
  }

  async getPublished(workspaceId) {
    try {
      let published = await prisma.assignmentPromptVersion.findFirst({
        where: { workspaceId, status: 'published' },
        orderBy: { version: 'desc' },
      });

      if (!published) {
        published = await this.createVersion(workspaceId, {
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          notes: 'Auto-generated default prompt',
          status: 'published',
          publishedAt: new Date(),
        });
      } else if (needsPromptUpgrade(published.systemPrompt)) {
        const upgraded = await this.createVersion(workspaceId, {
          systemPrompt: upgradeLegacyPrompt(published.systemPrompt),
          toolConfig: published.toolConfig,
          notes: `Auto-upgraded from v${published.version} to remove deprecated after-hours prompt logic`,
          createdBy: 'system',
        });
        published = await this.publish(upgraded.id, 'system');
      }

      return published;
    } catch (error) {
      logger.error('Error fetching published prompt:', error);
      throw new DatabaseError('Failed to fetch published prompt', error);
    }
  }

  async createVersion(workspaceId, { systemPrompt, toolConfig, notes, createdBy, status }) {
    try {
      const latest = await prisma.assignmentPromptVersion.findFirst({
        where: { workspaceId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const nextVersion = (latest?.version || 0) + 1;

      return await prisma.assignmentPromptVersion.create({
        data: {
          workspaceId,
          version: nextVersion,
          status: status || 'draft',
          systemPrompt,
          toolConfig: toolConfig || null,
          createdBy: createdBy || null,
          notes: notes || null,
          publishedAt: status === 'published' ? new Date() : null,
          publishedBy: status === 'published' ? createdBy : null,
        },
      });
    } catch (error) {
      logger.error('Error creating prompt version:', error);
      throw new DatabaseError('Failed to create prompt version', error);
    }
  }

  async publish(id, publishedBy) {
    try {
      const version = await this.getVersion(id);

      await prisma.$transaction([
        prisma.assignmentPromptVersion.updateMany({
          where: { workspaceId: version.workspaceId, status: 'published' },
          data: { status: 'archived' },
        }),
        prisma.assignmentPromptVersion.update({
          where: { id },
          data: { status: 'published', publishedBy, publishedAt: new Date() },
        }),
      ]);

      return await this.getVersion(id);
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      logger.error('Error publishing prompt version:', error);
      throw new DatabaseError('Failed to publish prompt version', error);
    }
  }

  async deleteVersion(id) {
    try {
      const version = await this.getVersion(id);
      if (version.status === 'published') {
        throw new Error('Cannot delete the published prompt version');
      }
      await prisma.assignmentPromptVersion.delete({ where: { id } });
      return { deleted: true };
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      if (error.message?.includes('Cannot delete')) throw error;
      logger.error('Error deleting prompt version:', error);
      throw new DatabaseError('Failed to delete prompt version', error);
    }
  }

  async restore(id, createdBy) {
    try {
      const source = await this.getVersion(id);
      return await this.createVersion(source.workspaceId, {
        systemPrompt: source.systemPrompt,
        toolConfig: source.toolConfig,
        notes: `Restored from v${source.version}`,
        createdBy,
      });
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      logger.error('Error restoring prompt version:', error);
      throw new DatabaseError('Failed to restore prompt version', error);
    }
  }
}

export { DEFAULT_SYSTEM_PROMPT };
export { needsPromptUpgrade, upgradeLegacyPrompt };
export default new PromptRepository();
