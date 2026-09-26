#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Auto-help integration W3 — one-off: add the Auto-help guards to workflows
 * that were installed / seeded before the guards existed
 * (plans/AUTO_HELP_INTEGRATION_PLAN.md D, src/services/autoHelpWorkflowGuards.js):
 *
 *   Follow-up nudge        skip while ticket.parkKind is auto_help, or once Auto-help
 *                          closed the ticket (no double nudge)
 *   Resolution summary     skip tickets closed by Auto-help (resolvedByKind auto_help)
 *   Reopen on reply        don't reopen when the reply after an Auto-help close
 *                          reads as thanks / an out-of-office
 *
 * Scope (audit S3, 26 Sep 2026 — selectGuardTargets, pure and tested):
 *   - workspaces 6, 7, 8, 9 (sandboxes) are never touched;
 *   - by default only workspaces where Auto-help is ENABLED; --workspace N
 *     picks one workspace explicitly;
 *   - the gallery template / seeded workflow (matched by its key) is changed
 *     with --apply; a workflow matched only by its name or step ids may be
 *     somebody's own — it is listed with the reason and changed only when its
 *     id is passed in --include <id,id>.
 * Every match is printed with why it matched and why it is (not) selected.
 *
 * A published definition gets a NEW version (like Publish in the editor):
 * max(version) + 1 from notification_workflow_versions, so runs already
 * waiting keep the version they started on. The draft is patched too.
 * Enabled / mock state is never changed. Idempotent.
 *
 * Usage:
 *   node scripts/auto-help-workflow-guards.mjs                    dry-run, dev DB
 *   node scripts/auto-help-workflow-guards.mjs --apply            write, dev DB
 *   node scripts/auto-help-workflow-guards.mjs --workspace 1      one workspace (Auto-help on or not)
 *   node scripts/auto-help-workflow-guards.mjs --include 12,34    also change these heuristic matches
 *   --prod loads PROD_DATABASE_URL from scripts/.env.prod (release step only —
 *   run the dry-run first and read it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const PROD = argv.includes('--prod');
const argValue = (flag) => {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : null;
};
const ONLY_WS = argValue('--workspace') !== null ? Number(argValue('--workspace')) : null;
const INCLUDE = String(argValue('--include') || '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
if (argv.includes('--workspace') && !Number.isInteger(ONLY_WS)) throw new Error('--workspace needs a workspace id');
if (argv.includes('--include') && !INCLUDE.length) throw new Error('--include needs workflow ids, e.g. --include 12,34');
const here = path.dirname(fileURLToPath(import.meta.url));

if (PROD) {
  const env = fs.readFileSync(path.join(here, '.env.prod'), 'utf8');
  const m = env.match(/^PROD_DATABASE_URL=(.+)$/m);
  if (!m) throw new Error('PROD_DATABASE_URL missing from scripts/.env.prod');
  process.env.DATABASE_URL = m[1].trim().replace(/^"|"$/g, '');
}
// Local scripts never take more than one connection (prod budget is 50).
if (process.env.DATABASE_URL && !/connection_limit=/.test(process.env.DATABASE_URL)) {
  process.env.DATABASE_URL += `${process.env.DATABASE_URL.includes('?') ? '&' : '?'}connection_limit=1`;
}

const {
  applyGuard, selectGuardTargets, nextVersionNumber, GUARD_EXCLUDED_WORKSPACES,
} = await import('../src/services/autoHelpWorkflowGuards.js');
const { validateWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');
const prisma = new PrismaClient();
console.log(`TARGET: ${PROD ? 'PROD' : 'dev'} database — ${APPLY ? 'APPLY' : 'DRY-RUN'}${ONLY_WS ? ` — workspace ${ONLY_WS}` : ' — workspaces with Auto-help on'}${INCLUDE.length ? ` — include ${INCLUDE.join(', ')}` : ''}`);
console.log(`Never touched: workspaces ${GUARD_EXCLUDED_WORKSPACES.join(', ')}.`);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  const enabledRows = await prisma.autoHelpSettings.findMany({ where: { enabled: true }, select: { workspaceId: true } });
  const enabledWorkspaceIds = enabledRows.map((r) => r.workspaceId);
  console.log(`Auto-help is on in: ${enabledWorkspaceIds.length ? enabledWorkspaceIds.join(', ') : 'no workspace'}.`);
  const workflows = await prisma.notificationWorkflow.findMany({
    where: {
      archivedAt: null,
      triggerType: { in: ['ticket.public_reply_added', 'ticket.resolved_closed', 'ticket.reply_received'] },
      ...(ONLY_WS ? { workspaceId: ONLY_WS } : {}),
    },
    orderBy: [{ workspaceId: 'asc' }, { id: 'asc' }],
  });
  const targets = selectGuardTargets(workflows, { enabledWorkspaceIds, onlyWorkspace: ONLY_WS, include: INCLUDE });
  let planned = 0;
  let written = 0;
  for (const { workflow: wf, kind, by, why, selected, skip } of targets) {
    const head = `ws ${wf.workspaceId} · #${wf.id} "${wf.name}" key=${wf.key} [${kind}] matched by ${by === 'template_key' ? 'TEMPLATE KEY' : 'HEURISTIC'} (${why}) enabled=${wf.isEnabled} mock=${wf.mockModeEnabled}`;
    if (!selected) {
      console.log(`${head}\n   - not selected: ${skip}`);
      continue;
    }
    const pub = wf.publishedDefinition ? applyGuard(kind, wf.publishedDefinition) : { changed: false, why: 'not published' };
    const draftSource = wf.publishedDefinition && same(wf.draftDefinition, wf.publishedDefinition) && pub.changed ? pub.definition : wf.draftDefinition;
    const draft = same(draftSource, wf.draftDefinition) ? applyGuard(kind, wf.draftDefinition) : { changed: true, definition: draftSource, why: 'draft follows the published fix' };
    console.log(`${head}\n   - published: ${pub.changed ? 'ADD GUARD' : pub.why}; draft: ${draft.changed ? 'ADD GUARD' : draft.why}`);
    if (!pub.changed && !draft.changed) continue;
    // Never write a definition the editor would refuse to publish.
    const invalid = [pub, draft].filter((x) => x.changed)
      .map((x) => validateWorkflowDefinition(x.definition, { triggerType: wf.triggerType }))
      .find((r) => r.errors?.length);
    if (invalid) {
      console.log(`   ! skipped: the guarded definition does not validate (${invalid.errors.join('; ')})`);
      continue;
    }
    planned += 1;
    if (!APPLY) continue;
    await prisma.$transaction(async (tx) => {
      const data = { lastChangedBy: 'auto-help-workflow-guards script' };
      if (draft.changed) data.draftDefinition = draft.definition;
      if (pub.changed) {
        const versions = await tx.notificationWorkflowVersion.findMany({ where: { workflowId: wf.id }, select: { version: true } });
        const nextVersion = nextVersionNumber(versions.map((v) => v.version), wf.publishedVersion);
        const version = await tx.notificationWorkflowVersion.create({
          data: {
            workspaceId: wf.workspaceId,
            workflowId: wf.id,
            version: nextVersion,
            definition: pub.definition,
            validationResult: { script: 'auto-help-workflow-guards', guard: kind, matchedBy: by },
            changeNote: `Auto-help guard added (${kind}) — plans/AUTO_HELP_INTEGRATION_PLAN.md W3`,
            publishedBy: 'auto-help-workflow-guards script',
          },
        });
        data.publishedDefinition = pub.definition;
        data.publishedVersion = nextVersion;
        data.lastPublishedAt = version.publishedAt;
      }
      await tx.notificationWorkflow.update({ where: { id: wf.id }, data });
    });
    written += 1;
  }
  const notSelected = targets.filter((t) => !t.selected).length;
  console.log(`\n${targets.length} workflow(s) matched a guard; ${notSelected} not selected (reasons above); ${planned} selected need a guard; ${APPLY ? `${written} updated` : 'nothing written (dry-run) — re-run with --apply'}.`);
} finally {
  await prisma.$disconnect();
}
