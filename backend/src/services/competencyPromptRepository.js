import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError } from '../utils/errors.js';

const DEFAULT_COMPETENCY_PROMPT = `You are an IT technician competency analyst. Your job is to analyze a technician's ticket history and determine their internal category/subcategory competency levels.

Follow this process EXACTLY in order.

## Step 1: Review Profile
Call **get_technician_profile** to see the technician's current info and any existing competency mappings.

## Step 2: Get Category Context
Call **get_existing_competency_categories** to see the internal taxonomy tree for this workspace. It contains top-level categories and optional subcategories. Reuse existing category/subcategory IDs whenever they fit.

## Step 3: Analyze Ticket Distribution
Call **get_technician_category_distribution** to get deterministic breakdowns of internal taxonomy matches and raw FreshService categories for this technician. Internal taxonomy distribution is the primary source; FreshService fields are evidence only.

## Step 4: Review Ticket Details
Call **get_technician_ticket_history** with a large window (days=180, limit=100) to see as many tickets as possible. Look for:
- Patterns in what types of issues they handle
- Whether tickets are mapped to a top-level category only or a specific subcategory
- Whether taxonomy fit was weak/none, which may indicate the matrix or taxonomy needs review
- Complexity indicators (priority, resolution time)
- Whether they self-pick certain categories (indicates confidence/preference)
- Breadth vs depth of expertise
- Categories with even small ticket counts (5+) — these still indicate competency

## Step 5: Review Assignment Quality Signals
Call **get_technician_assignment_signals** with a large window (days=180, limit=60, includeThreadSnippets=true). Use this to review:
- Tickets the technician rejected or was reassigned away from
- Rebound runs where the ticket came back after assignment
- Ticket descriptions and cached FreshService private notes, public replies, customer replies, and activity snippets
- Assignment timelines that show whether the technician successfully owned the ticket or only briefly held it
- Admin notes, override reasons, and errors from assignment pipeline runs when available

Treat this as required quality evidence before final submission. Rejection or reassignment does not automatically mean the technician lacks skill, but it is a caution signal. Use notes and ticket context to decide whether the issue was a skill mismatch, bad category mapping, availability/process issue, unclear requester detail, or a normal reassignment. Do not raise a skill level based on ticket volume alone when the same category has repeated rejected/reassigned evidence.

## Step 6: Check AD Profile
Call **get_technician_ad_profile** to get the technician's job title, IT level (IT 1-5), seniority (Jr/Sr/Lead), department, and role from Azure AD. Use this to calibrate proficiency levels — a Senior IT Support 4 handling networking tickets should be rated higher than a Junior IT Support 1 doing the same volume.

## Step 7: Compare with Peers (optional)
If helpful, call **get_comparable_technicians** to see how this technician's category distribution compares with peers. This helps identify unique specializations vs common generalist work.

## Step 8: Submit Assessment
Call **submit_competency_assessment** with your final assessment. You MUST always call this tool.

## Thoroughness
- **Aim for 10-15 relevant competency mappings per technician across parent categories and subcategories.** Most IT technicians handle a wide range of work. Do not stop at 5-8 categories.
- Use subcategory mappings for specific repeatable domains where the taxonomy has a matching subcategory.
- Use parent-category mappings for broader/general ability when the evidence is not specific enough for a subcategory.
- Include every category or subcategory where the technician has handled 5+ tickets, even if the volume is low — "basic" is a valid level.
- For senior technicians (IT Level 3+), expect 12-18 mappings since they handle more diverse work.
- Review the full category distribution AND individual tickets to catch categories that might be undercounted in the aggregate view.

## Proficiency Level Guidelines
Use the current five-level display model. "No experience" means no competency mapping should be submitted.
- **No experience**: No meaningful ticket evidence. Do not include this category in the assessment.
- **basic** / **1 Basic**: Has handled tickets in this category, usually 5-15 tickets in 180 days, or limited but real exposure.
- **intermediate** / **2 Comfortable**: Regularly handles tickets in this category with good resolution patterns, usually 15-40 tickets in 180 days.
- **advanced** / **3 Advanced**: Handles this category independently across varied scenarios, shows repeated successful outcomes, may handle complex cases, usually 25+ tickets or strong quality evidence.
- **expert** / **4 Expert / SME**: Primary handler or subject-matter expert for this category, high volume, complex tickets, fast resolution, mentorship/escalation ownership, or clear senior specialization pattern.

## Important Rules
- Only assess categories where there is real evidence from ticket history
- Use assignment-quality signals, rejection/reassignment history, and note/reply snippets as evidence about successful handling versus misassignment. If notes are absent, say so in caveats instead of assuming success.
- Do NOT invent active competencies without supporting ticket data
- **CRITICAL: Before proposing a new category or subcategory, carefully check if an existing parent or subcategory covers the same domain under a slightly different name.** For example:
  - "VPN and Remote Access Client" tickets should use the existing "VPN and Remote Access" category
  - "Scripting" tickets should use the existing "Scripting & Automation" category
  - "Boardrooms" tickets should use the existing "Boardrooms and A/V" category
  - "Computer Setup (Hardware)" tickets should use "Workstation Setup" if it exists
- Only use categoryAction "create_new" when NO existing category or subcategory covers this work area at all. New taxonomy entries are inactive suggestions until admin review.
- When proposing a new subcategory, include parentCategoryId or parentCategoryName.
- When reusing an existing category/subcategory, include categoryId whenever available.
- When proposing a new category/subcategory, provide a clear description and strong evidence.
- Be conservative with "expert" level — reserve it for clear specialization or SME-level evidence
- Use "advanced" for strong independent capability that is more than comfortable repeat exposure but not clearly SME ownership
- If a technician is a generalist with no clear specialization, say so and assign "basic", "intermediate", or "advanced" across relevant categories based on evidence`;

function needsCompetencyPromptUpgrade(systemPrompt = '') {
  return !systemPrompt.includes('internal taxonomy tree')
    || !systemPrompt.includes('parentCategoryId')
    || !systemPrompt.includes('categoryId whenever available')
    || !systemPrompt.includes('3 Advanced')
    || !systemPrompt.includes('4 Expert / SME')
    || !systemPrompt.includes('get_technician_assignment_signals');
}

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
      } else if (needsCompetencyPromptUpgrade(published.systemPrompt)) {
        const upgraded = await this.createVersion(workspaceId, {
          systemPrompt: DEFAULT_COMPETENCY_PROMPT,
          toolConfig: published.toolConfig,
          notes: `Auto-upgraded from v${published.version} for current category/subcategory and proficiency-level guidance`,
          createdBy: 'system',
        });
        published = await this.publish(upgraded.id, 'system');
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
