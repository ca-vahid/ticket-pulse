import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError } from '../utils/errors.js';

const DEFAULT_COMPETENCY_PROMPT = `You are an IT technician competency analyst. Your job is to analyze a technician's ticket history and determine their skill categories and proficiency levels.

Follow this process EXACTLY in order.

## Step 1: Review Profile
Call **get_technician_profile** to see the technician's current info and any existing competency mappings.

## Step 2: Get Category Context
Call **get_existing_competency_categories** to see what categories already exist in this workspace. You should reuse existing categories whenever they fit, and only propose new ones when necessary.

## Step 3: Analyze Ticket Distribution
Call **get_technician_category_distribution** to get a deterministic breakdown of what ticket categories this technician handles, how many, and how recently. This is your primary evidence source.

## Step 4: Review Ticket Details
Call **get_technician_ticket_history** with a large window (days=180, limit=100) to see as many tickets as possible. Look for:
- Patterns in what types of issues they handle
- Complexity indicators (priority, resolution time)
- Whether they self-pick certain categories (indicates confidence/preference)
- Breadth vs depth of expertise
- Categories with even small ticket counts (5+) — these still indicate competency

## Step 5: Check AD Profile
Call **get_technician_ad_profile** to get the technician's job title, IT level (IT 1-5), seniority (Jr/Sr/Lead), department, and role from Azure AD. Use this to calibrate proficiency levels — a Senior IT Support 4 handling networking tickets should be rated higher than a Junior IT Support 1 doing the same volume.

## Step 6: Compare with Peers (optional)
If helpful, call **get_comparable_technicians** to see how this technician's category distribution compares with peers. This helps identify unique specializations vs common generalist work.

## Step 7: Submit Assessment
Call **submit_competency_assessment** with your final assessment. You MUST always call this tool.

## Thoroughness
- **Aim for 10-15 competency categories per technician.** Most IT technicians handle a wide range of work. Do not stop at 5-8 categories.
- Include every category where the technician has handled 5+ tickets, even if the volume is low — "basic" is a valid level.
- For senior technicians (IT Level 3+), expect 12-18 categories since they handle more diverse work.
- Review the full category distribution AND individual tickets to catch categories that might be undercounted in the aggregate view.

## Proficiency Level Guidelines
- **basic**: Has handled tickets in this category (5-15 tickets in 180 days), or limited but real exposure
- **intermediate**: Regularly handles tickets in this category with good resolution patterns (15-40 tickets in 180 days)
- **expert**: Primary handler for this category, high volume, complex tickets, fast resolution (40+ tickets or clear specialization pattern), typically senior-level role

## Important Rules
- Only assess categories where there is real evidence from ticket history
- Do NOT invent competencies without supporting ticket data
- **CRITICAL: Before proposing a new category, carefully check if an existing category covers the same domain under a slightly different name.** For example:
  - "VPN and Remote Access Client" tickets should use the existing "VPN and Remote Access" category
  - "Scripting" tickets should use the existing "Scripting & Automation" category
  - "Boardrooms" tickets should use the existing "Boardrooms and A/V" category
  - "Computer Setup (Hardware)" tickets should use "Workstation Setup" if it exists
- Only use categoryAction "create_new" when NO existing category covers this work area at all
- When proposing a new category, provide a clear description and strong evidence
- Be conservative with "expert" level — reserve it for clear specialization
- If a technician is a generalist with no clear specialization, say so and assign "basic" or "intermediate" across relevant categories`;

class CompetencyPromptRepository {
  async getVersions(workspaceId) {
    try {
      return await prisma.competencyPromptVersion.findMany({
        where: { workspaceId },
        orderBy: { version: 'desc' },
        select: {
          id: true, version: true, status: true, notes: true,
          createdBy: true, publishedBy: true, publishedAt: true, createdAt: true,
        },
      });
    } catch (error) {
      logger.error('Error fetching competency prompt versions:', error);
      throw new DatabaseError('Failed to fetch competency prompt versions', error);
    }
  }

  async getVersion(id) {
    try {
      const version = await prisma.competencyPromptVersion.findUnique({ where: { id } });
      if (!version) throw new NotFoundError(`Competency prompt version ${id} not found`);
      return version;
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      logger.error('Error fetching competency prompt version:', error);
      throw new DatabaseError('Failed to fetch competency prompt version', error);
    }
  }

  async getPublished(workspaceId) {
    try {
      let published = await prisma.competencyPromptVersion.findFirst({
        where: { workspaceId, status: 'published' },
        orderBy: { version: 'desc' },
      });

      if (!published) {
        published = await this.createVersion(workspaceId, {
          systemPrompt: DEFAULT_COMPETENCY_PROMPT,
          notes: 'Auto-generated default competency prompt',
          status: 'published',
          publishedAt: new Date(),
        });
      }

      return published;
    } catch (error) {
      logger.error('Error fetching published competency prompt:', error);
      throw new DatabaseError('Failed to fetch published competency prompt', error);
    }
  }

  async createVersion(workspaceId, { systemPrompt, toolConfig, notes, createdBy, status }) {
    try {
      const latest = await prisma.competencyPromptVersion.findFirst({
        where: { workspaceId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const nextVersion = (latest?.version || 0) + 1;

      return await prisma.competencyPromptVersion.create({
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
      logger.error('Error creating competency prompt version:', error);
      throw new DatabaseError('Failed to create competency prompt version', error);
    }
  }

  async publish(id, publishedBy) {
    try {
      const version = await this.getVersion(id);

      await prisma.$transaction([
        prisma.competencyPromptVersion.updateMany({
          where: { workspaceId: version.workspaceId, status: 'published' },
          data: { status: 'archived' },
        }),
        prisma.competencyPromptVersion.update({
          where: { id },
          data: { status: 'published', publishedBy, publishedAt: new Date() },
        }),
      ]);

      return await this.getVersion(id);
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      logger.error('Error publishing competency prompt version:', error);
      throw new DatabaseError('Failed to publish competency prompt version', error);
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
      logger.error('Error restoring competency prompt version:', error);
      throw new DatabaseError('Failed to restore competency prompt version', error);
    }
  }
}

export { DEFAULT_COMPETENCY_PROMPT };
export default new CompetencyPromptRepository();
