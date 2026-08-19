// PA Phase 7 — enable AI auto-categorization for Project Accounting.
//   1. Verifies/sets AssignmentConfig: isEnabled=true, dryRunMode=false,
//      autoCategorizeEnabled=true (+ restores poll_for_unassigned from the
//      p0 snapshot when one exists). Prints excluded/observe-only groups and
//      the after-hours coverage state for orchestrator review.
//   2. Publishes a ws-specific AssignmentPromptVersion: the current canonical
//      DEFAULT_SYSTEM_PROMPT plus a Project Accounting domain section
//      (marker: PA_DOMAIN_CONTEXT_V1). Idempotent — if the published prompt
//      already carries the marker, nothing is re-published.
// NOTE deliberately NOT touched: AssignmentConfig.categorizationPrompt is a
// DEAD column (accepted by the PUT route, zero consumers) — the published
// AssignmentPromptVersion row is the real per-workspace prompt surface.
//   node scripts/pa-migration/p7-enable-ai.mjs                  (dev dry-run)
//   node scripts/pa-migration/p7-enable-ai.mjs --apply
//   node scripts/pa-migration/p7-enable-ai.mjs --prod --apply   (PROD — orchestrator only)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE, APPLY, mode, resolveWorkspace } from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PA_MARKER = 'PA_DOMAIN_CONTEXT_V1';

const { default: prisma } = await import('../../src/services/prisma.js');
const { default: promptRepository, DEFAULT_SYSTEM_PROMPT, needsPromptUpgrade } = await import('../../src/services/promptRepository.js');
const ws = await resolveWorkspace(prisma);

console.log(`PA Phase 7 (${mode()}) — AI auto-categorize enablement\n`);

// ---- 1. AssignmentConfig ----
const cfgRows = await prisma.$queryRawUnsafe('SELECT * FROM assignment_configs WHERE workspace_id=$1', ws.id);
const cfg = cfgRows[0] || null;
let pollTarget = cfg?.poll_for_unassigned ?? true;
try {
  const snapFile = path.resolve(__dirname, `../../../reports/pa-migration${process.argv.includes('--prod') || process.env.PA_TARGET === 'prod' ? '' : '-dev'}/p0-assignment-config.json`);
  const p0cfg = JSON.parse(fs.readFileSync(snapFile, 'utf8'))[0];
  if (p0cfg && typeof p0cfg.poll_for_unassigned === 'boolean') pollTarget = p0cfg.poll_for_unassigned;
} catch { /* no p0 snapshot — keep current value */ }

console.log('AssignmentConfig target state: isEnabled=true, dryRunMode=false, autoCategorizeEnabled=true,', `pollForUnassigned=${pollTarget} (from p0 snapshot/current)`);
if (!cfg) {
  console.log('current: NO assignment_configs row — one will be created');
  if (APPLY) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO assignment_configs (workspace_id, is_enabled, dry_run_mode, auto_categorize_enabled, poll_for_unassigned, created_at, updated_at)
       VALUES ($1, true, false, true, $2, now(), now())`,
      ws.id, pollTarget,
    );
    console.log('created assignment_configs row');
  }
} else {
  console.log(`current: isEnabled=${cfg.is_enabled} dryRunMode=${cfg.dry_run_mode} autoCategorize=${cfg.auto_categorize_enabled} pollForUnassigned=${cfg.poll_for_unassigned} autoAssign=${cfg.auto_assign}`);
  const excluded = cfg.excluded_group_ids || [];
  const observeOnly = cfg.observe_only_group_ids || [];
  const groupNames = async (ids) => {
    if (!ids.length) return '(none)';
    const rows = await prisma.$queryRawUnsafe(
      'SELECT freshservice_id AS gid, name FROM groups WHERE workspace_id=$1 AND freshservice_id = ANY($2::bigint[])', ws.id, ids,
    ).catch(() => []);
    const byId = new Map(rows.map((r) => [String(r.gid), r.name]));
    return ids.map((id) => `${id}${byId.get(String(id)) ? ` (${byId.get(String(id))})` : ''}`).join(', ');
  };
  console.log(`REVIEW — excluded groups (LLM runs, decision forced to pending_review): ${await groupNames(excluded)}`);
  console.log(`REVIEW — observe-only groups (nothing is written, incl. categories unless carve-out): ${await groupNames(observeOnly)}`);
  console.log(`REVIEW — observeCategoryWritebackEnabled=${cfg.observe_category_writeback_enabled} (category carve-out for observe-only groups)`);
  console.log(`REVIEW — after-hours coverage: priorityAssessmentAfterHoursEnabled=${cfg.priority_assessment_after_hours_enabled} `
    + '(false ⇒ overnight/weekend tickets stay uncategorized until the morning queue drain — the Settings toggle shows the amber warning)');
  if (APPLY) {
    await prisma.$executeRawUnsafe(
      `UPDATE assignment_configs SET is_enabled=true, dry_run_mode=false, auto_categorize_enabled=true,
         poll_for_unassigned=$1, updated_at=now() WHERE workspace_id=$2`,
      pollTarget, ws.id,
    );
    console.log('applied AssignmentConfig target state');
  }
}

// ---- 2. sanity: the taxonomy must exist before enabling ----
const cats = await prisma.$queryRawUnsafe(
  // ws5's taxonomy predates this migration — any active category satisfies the guard
  'SELECT count(*)::int n FROM competency_categories WHERE workspace_id=$1 AND is_active=true', ws.id,
);
if (cats[0].n === 0) throw new Error('HARD BLOCK: no active PA categories — auto-categorize writes canonical ids only; run Phase 1 first');
console.log(`\ntaxonomy present: ${cats[0].n} active PA categories`);

// ---- 3. the Project Accounting prompt ----
// Base = the repo's canonical DEFAULT_SYSTEM_PROMPT (passes every
// needsPromptUpgrade() check, so the auto-upgrade machinery will never
// rewrite this version) + the PA domain section below.
const PA_SECTION = `

## Workspace Domain Context — Project Accounting (${PA_MARKER})
This workspace serves the Project Accounting team, not general IT. Tickets are business/finance requests about project and proposal administration: opening and configuring projects, setting up proposals and bids, cost codes and budgets, project numbers, timesheet/project-admin corrections, and related correspondence. Apply everything above (availability, competency, priority, briefing rules) unchanged, plus the guidance below.

### Category selection guidance
The taxonomy is two-level: top-level categories (Project Setup, Proposal Setup, General / Other) with REGION subcategories (Quebec, Chile, Other) under the two main ones. Select exactly ONE existing top-level category from get_ticket_categories; when the ticket clearly concerns a region (Quebec or Chile offices/projects), also select that region subcategory — otherwise pick the "Other" subcategory of the chosen top-level. General / Other has no subcategories; leave the subcategory unset there.

- **Project Setup** — the request is about creating or changing a PROJECT that already won/exists: new project numbers or codes, opening a project in the ERP, phases/tasks/WBS, project budgets after award, cost-code or charge-code setup and corrections, changes to an existing project's configuration, and timesheet/charging issues tied to a specific project.
- **Proposal Setup** — the request is about PRE-AWARD work: setting up a proposal, bid, RFP response, or pursuit; proposal/opportunity numbers; pre-award budgets or estimates; and converting a won proposal into a project (the conversion request itself belongs here).
- The decisive question is **award status**: before award/win → Proposal Setup; after award (a real project exists or is being created from a win) → Project Setup.
- **General / Other** (or the closest catch-all present) — greetings, notifications, vendor/marketing mail, and requests that genuinely fit no dedicated category.

### Be conservative when unsure
When the ticket is ambiguous between Project Setup and Proposal Setup, or fits nothing well: pick the closest category with categoryFit="weak" (or "none" when truly nothing fits) and explain the ambiguity in classificationRationale — a weak/none fit routes the ticket into the human review queue instead of silently mis-filing it. Never invent categories, never force a confident "exact" fit onto a guess, and prefer leaving the decision to a human over a wrong confident answer.`;

const paSystemPrompt = DEFAULT_SYSTEM_PROMPT + PA_SECTION;
if (needsPromptUpgrade(paSystemPrompt)) {
  throw new Error('authored PA prompt would trip needsPromptUpgrade() — it would be auto-rewritten at first use; fix the section text');
}

const published = await prisma.assignmentPromptVersion.findFirst({
  where: { workspaceId: ws.id, status: 'published' },
  orderBy: { version: 'desc' },
  select: { id: true, version: true, systemPrompt: true },
});
if (published?.systemPrompt?.includes(PA_MARKER)) {
  console.log(`prompt: published v${published.version} already carries ${PA_MARKER} — nothing to do`);
} else {
  console.log(`prompt: current published = ${published ? `v${published.version} (no PA marker)` : '(none — default would auto-generate)'}`);
  console.log(`prompt: will publish DEFAULT_SYSTEM_PROMPT + PA domain section (${paSystemPrompt.length} chars, marker ${PA_MARKER})`);
  if (APPLY) {
    const draft = await promptRepository.createVersion(ws.id, {
      systemPrompt: paSystemPrompt,
      toolConfig: null,
      notes: `Project Accounting domain prompt (${SOURCE}): flat taxonomy, Project vs Proposal Setup selection guidance, conservative-when-unsure.`,
      createdBy: SOURCE,
    });
    const live = await promptRepository.publish(draft.id, SOURCE);
    console.log(`prompt: published v${live.version} (id ${live.id})`);
  }
}

console.log(`\nPA Phase 7 ${APPLY ? 'APPLIED' : 'dry-run OK'}. Remaining manual steps: flip CANONICAL_CATEGORY_WORKSPACE_IDS to include this workspace (PA6, do it LAST), and review the Settings → AI & Routing toggles per docs/PA_AUTO_CATEGORIZE_SETUP.md.`);
await prisma.$disconnect();
