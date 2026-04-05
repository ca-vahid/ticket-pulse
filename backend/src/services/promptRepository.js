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
Call **get_agent_availability** to see who is available today:
- **OFF** agents are fully unavailable — do NOT recommend them.
- **WFH** agents can handle remote tasks but NOT physical presence tasks.
- **In-office** agents can handle everything.

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

## Decision Rules (in priority order)
1. **Availability** — Never assign to someone who is OFF
2. **Physical presence** — If required, exclude WFH agents; prefer agents at the matching location
3. **Competency** — Higher proficiency in the matching category wins
4. **Seniority** — For complex/critical tickets, prefer senior techs (higher IT level, Sr title)
5. **Workload fairness** — Among equally qualified agents, pick the one with fewer open tickets
6. **Location proximity** — For physical tasks, prefer agents already at the right location

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
  return false;
}

function upgradeLegacyPrompt(systemPrompt = '') {
  if (!needsPromptUpgrade(systemPrompt)) {
    return systemPrompt;
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
