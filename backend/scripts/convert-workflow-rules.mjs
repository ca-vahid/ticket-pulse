#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * One-off (14 Oct 2026): show workflow conditions as builder rows instead of
 * code. For every non-archived workflow in workspaces 1-5 (never 6-9) whose
 * condition / branch steps still carry a raw json-logic `rule` and no
 * conditions, convert the rule to rows (+ the Skip noise / Ignore Auto-help
 * thank-you switches) — ONLY when the old rule and the new rows give the same
 * answer for every combination of values the rule reads
 * (src/services/workflowRuleConversion.js, tested).
 *
 * Prints, per workflow and step: the old rule, the new sentence, the verdict.
 *
 * Writing (--apply) publishes a new version the way the editor does: a
 * version row (max(version) + 1, change note saying why) and the workflow row
 * in one transaction, with the draft and the published definition both
 * updated. Enabled / mock state is never changed. A workflow whose draft
 * differs from its published definition (unpublished edits, or never
 * published) is skipped and reported: the editor converts those steps when
 * an admin opens them.
 *
 * Usage:
 *   node scripts/convert-workflow-rules.mjs                  dry-run, dev DB
 *   node scripts/convert-workflow-rules.mjs --apply          write, dev DB
 *   node scripts/convert-workflow-rules.mjs --workspace 1    one workspace (1-5)
 *   --prod loads PROD_DATABASE_URL from scripts/.env.prod (read the dry run first).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const PROD = argv.includes('--prod');
const argValue = (flag) => {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : null;
};
const ONLY_WS = argValue('--workspace') !== null ? Number(argValue('--workspace')) : null;
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The whole run, with its database and output passed in (tests drive it with
 * a mocked Prisma). Returns { planned, written, skipped, rows }.
 */
export async function runConversion({ prisma, apply = false, onlyWorkspace = null, log = console.log, actor = 'convert-workflow-rules script' } = {}) {
  const {
    CONVERT_WORKSPACES, CONVERSION_CHANGE_NOTE, convertDefinitionRules, definitionHasRawRules,
  } = await import('../src/services/workflowRuleConversion.js');
  const { validateWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');
  const { nextVersionNumber } = await import('../src/services/autoHelpWorkflowGuards.js');

  if (onlyWorkspace !== null && !CONVERT_WORKSPACES.includes(Number(onlyWorkspace))) {
    throw new Error(`--workspace must be one of ${CONVERT_WORKSPACES.join(', ')} (sandboxes 6-9 are never touched)`);
  }
  const workspaceIds = onlyWorkspace !== null ? [Number(onlyWorkspace)] : [...CONVERT_WORKSPACES];
  log(`${apply ? 'APPLY' : 'DRY-RUN'} — workspaces ${workspaceIds.join(', ')} (never 6, 7, 8, 9)`);

  const workflows = await prisma.notificationWorkflow.findMany({
    where: { archivedAt: null, workspaceId: { in: workspaceIds } },
    orderBy: [{ workspaceId: 'asc' }, { id: 'asc' }],
  });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const rows = [];
  let planned = 0;
  let written = 0;
  let skipped = 0;

  for (const wf of workflows) {
    if (!definitionHasRawRules(wf.publishedDefinition) && !definitionHasRawRules(wf.draftDefinition)) continue;
    const head = `ws ${wf.workspaceId} · #${wf.id} "${wf.name}" (${wf.triggerType}) enabled=${wf.isEnabled} mock=${wf.mockModeEnabled} v${wf.publishedVersion}`;
    if (!wf.publishedDefinition || !same(wf.draftDefinition, wf.publishedDefinition)) {
      const why = wf.publishedDefinition ? 'the draft has unpublished edits' : 'never published';
      log(`${head}\n   - SKIPPED: ${why}. The editor shows these steps as rows when an admin opens them.`);
      rows.push({ workflowId: wf.id, workspaceId: wf.workspaceId, skipped: why, steps: [] });
      skipped += 1;
      continue;
    }
    const result = convertDefinitionRules(wf.publishedDefinition);
    log(head);
    for (const step of result.steps) {
      log(`   - step ${step.nodeId}${step.branchKey ? ` / branch ${step.branchKey}` : ''} "${step.label}"`);
      log(`       old rule: ${JSON.stringify(step.oldRule)}`);
      log(`       new:      ${step.sentence || '(stays code)'}`);
      log(`       verdict:  ${step.verdict.toUpperCase()} — ${step.why}`);
    }
    const row = { workflowId: wf.id, workspaceId: wf.workspaceId, steps: result.steps, changed: result.changed };
    rows.push(row);
    if (!result.changed) continue;
    const validation = validateWorkflowDefinition(result.definition, { triggerType: wf.triggerType });
    if (validation.errors?.length) {
      log(`   ! skipped: the converted definition does not validate (${validation.errors.join('; ')})`);
      row.skipped = 'does not validate';
      skipped += 1;
      continue;
    }
    planned += 1;
    if (!apply) continue;
    let nextVersion = null;
    await prisma.$transaction(async (tx) => {
      const versions = await tx.notificationWorkflowVersion.findMany({ where: { workflowId: wf.id }, select: { version: true } });
      nextVersion = nextVersionNumber(versions.map((v) => v.version), wf.publishedVersion);
      const version = await tx.notificationWorkflowVersion.create({
        data: {
          workspaceId: wf.workspaceId,
          workflowId: wf.id,
          version: nextVersion,
          definition: result.definition,
          validationResult: validation,
          changeNote: CONVERSION_CHANGE_NOTE,
          publishedBy: actor,
        },
      });
      await tx.notificationWorkflow.update({
        where: { id: wf.id },
        data: {
          draftDefinition: result.definition,
          publishedDefinition: result.definition,
          publishedVersion: nextVersion,
          lastPublishedAt: version.publishedAt,
          lastChangedBy: actor,
        },
      });
    });
    written += 1;
    log(`   = published as version ${nextVersion}`);
  }
  log(`\n${planned} workflow(s) to convert, ${skipped} skipped; ${apply ? `${written} published` : 'nothing written (dry-run) — re-run with --apply'}.`);
  return { planned, written, skipped, rows };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (argv.includes('--workspace') && !Number.isInteger(ONLY_WS)) throw new Error('--workspace needs a workspace id');
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
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  console.log(`TARGET: ${PROD ? 'PROD' : 'dev'} database`);
  try {
    await runConversion({ prisma, apply: APPLY, onlyWorkspace: ONLY_WS });
  } finally {
    await prisma.$disconnect();
  }
}
