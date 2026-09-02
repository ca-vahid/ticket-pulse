#!/usr/bin/env node
/**
 * RO-6 (MEGA 09-01 Phase RO): publish + enable the seeded "Reopen on requester
 * reply" workflow in workspace 2 (Accounting) in MOCK mode, with two visible
 * guard conditions in front of the reopen:
 *
 *   • event.senderIsAgent   is false   ("sender is not an agent")
 *   • event.isSurveyResponse is false  ("not a survey response")
 *
 * Both flags ride `event.extra` from ticketThreadRepository.bulkUpsert (RO-3),
 * which already filters agent replies and CSAT survey responses out — the
 * conditions make that guard visible/editable in the workflow editor.
 *
 * Mock mode: the run is recorded (Settings → Mail Workflows → runs) and the
 * update_ticket node reports what it WOULD set, but nothing is written to
 * FreshService. Flip mock off in the editor after the 2-day soak.
 *
 * Idempotent: re-running after apply reports "up to date".
 *
 * Usage:  node scripts/enable-reopen-workflow-ws2.mjs [--apply] [--prod]
 * Default = dry-run against the dev DB. --prod loads PROD_DATABASE_URL from scripts/.env.prod.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const PROD = process.argv.includes('--prod');
const here = path.dirname(fileURLToPath(import.meta.url));

if (PROD) {
  const env = fs.readFileSync(path.join(here, '.env.prod'), 'utf8');
  const m = env.match(/^PROD_DATABASE_URL=(.+)$/m);
  if (!m) throw new Error('PROD_DATABASE_URL missing from scripts/.env.prod');
  process.env.DATABASE_URL = m[1].trim().replace(/^"|"$/g, '');
}
const prisma = new PrismaClient();
console.log(`TARGET: ${PROD ? 'PROD' : 'dev'} database — ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

const WORKSPACE_ID = 2;
const WORKFLOW_KEY = 'ticket_reply_received_reopen';
const GUARD_NODE_ID = 'sender-guard';
const CHANGED_BY = 'script:enable-reopen-workflow-ws2';

// Pure module — safe to import after the env swap above.
const { buildDefaultWorkflowDefinition, validateWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');

function withSenderGuard(definition) {
  const def = JSON.parse(JSON.stringify(definition));
  if (def.nodes.some((n) => n.id === GUARD_NODE_ID)) return { definition: def, added: false };
  const triggerEdge = def.edges.find((e) => e.source === 'trigger');
  if (!triggerEdge) throw new Error('Seeded reopen definition has no edge out of the trigger');
  const firstAfterTrigger = triggerEdge.target;
  const skipNode = def.nodes.find((n) => n.type === 'stop' && n.id === 'skip') || def.nodes.find((n) => n.type === 'stop');
  if (!skipNode) throw new Error('Seeded reopen definition has no stop node to route excluded replies to');
  def.nodes.splice(1, 0, {
    id: GUARD_NODE_ID,
    type: 'condition',
    position: { x: 130, y: 60 },
    data: {
      label: 'Real requester reply? (not an agent, not a survey)',
      conditionGroup: {
        logic: 'all',
        conditions: [
          { field: 'event.senderIsAgent', operator: 'is_false' },
          { field: 'event.isSurveyResponse', operator: 'is_false' },
        ],
      },
    },
  });
  triggerEdge.target = GUARD_NODE_ID;
  def.edges.push(
    { id: 'e-guard-true', source: GUARD_NODE_ID, target: firstAfterTrigger, sourceHandle: 'true' },
    { id: 'e-guard-false', source: GUARD_NODE_ID, target: skipNode.id, sourceHandle: 'false' },
  );
  return { definition: def, added: true };
}

const ws = await prisma.workspace.findUnique({ where: { id: WORKSPACE_ID }, select: { id: true, name: true, slug: true } });
if (!ws) throw new Error(`Workspace ${WORKSPACE_ID} not found`);
console.log(`workspace ${ws.id}: ${ws.name} (${ws.slug})`);

let workflow = await prisma.notificationWorkflow.findFirst({
  where: { workspaceId: WORKSPACE_ID, key: WORKFLOW_KEY },
});

const plan = [];
let baseDefinition;
if (!workflow) {
  baseDefinition = buildDefaultWorkflowDefinition('ticket.reply_received');
  plan.push(`workflow "${WORKFLOW_KEY}" does not exist in ws${WORKSPACE_ID} — would CREATE it from the seeded default`);
} else {
  baseDefinition = workflow.draftDefinition || workflow.publishedDefinition || buildDefaultWorkflowDefinition('ticket.reply_received');
  console.log(`workflow #${workflow.id} "${workflow.name}": enabled=${workflow.isEnabled} mock=${workflow.mockModeEnabled} publishedVersion=${workflow.publishedVersion} archived=${Boolean(workflow.archivedAt)}`);
  if (workflow.archivedAt) throw new Error('Workflow is archived — restore it in the editor first');
}

const { definition, added } = withSenderGuard(baseDefinition);
const validation = validateWorkflowDefinition(definition, { triggerType: 'ticket.reply_received' });
if (!validation.success) throw new Error(`Guarded definition does not validate: ${validation.errors.join('; ')}`);
console.log(`definition validates (${definition.nodes.length} nodes, ${definition.edges.length} edges); sender guard ${added ? 'ADDED' : 'already present'}`);
for (const n of definition.nodes) {
  const summary = n.type === 'condition'
    ? (n.data?.conditionGroup ? JSON.stringify(n.data.conditionGroup.conditions) : JSON.stringify(n.data?.rule))
    : n.type === 'update_ticket' ? `setStatus=${n.data?.setStatus}` : '';
  console.log(`  node ${n.id.padEnd(14)} ${n.type.padEnd(14)} ${summary}`);
}

const publishedMatches = workflow?.publishedDefinition
  && JSON.stringify(workflow.publishedDefinition) === JSON.stringify(definition);
if (workflow) {
  if (!publishedMatches) plan.push(`would PUBLISH version ${workflow.publishedVersion + 1} with the guarded definition (draft updated to match)`);
  else plan.push('published definition already matches — no new version');
  if (!workflow.isEnabled) plan.push('would ENABLE the workflow');
  if (!workflow.mockModeEnabled) plan.push('would arm MOCK mode (runs recorded, nothing written to FreshService)');
}
if (!workflow) plan.push('would PUBLISH version 1, ENABLE it, and arm MOCK mode');
if (plan.length === 0 || (workflow && publishedMatches && workflow.isEnabled && workflow.mockModeEnabled)) {
  console.log('\nworkflow is already published, enabled and in mock mode with the sender guard — nothing to do');
  await prisma.$disconnect();
  process.exit(0);
}
console.log('\nPLAN:');
for (const line of plan) console.log(`  - ${line}`);

if (!APPLY) { console.log('\nDRY-RUN — nothing changed. Re-run with --apply.'); await prisma.$disconnect(); process.exit(0); }

const now = new Date();
await prisma.$transaction(async (tx) => {
  if (!workflow) {
    workflow = await tx.notificationWorkflow.create({
      data: {
        workspaceId: WORKSPACE_ID,
        key: WORKFLOW_KEY,
        name: 'Reopen on requester reply',
        description: 'When a requester replies to a resolved or closed ticket, reopen it so the reply is not missed. Fully customizable — no email is sent by default.',
        triggerType: 'ticket.reply_received',
        draftDefinition: definition,
        isDefaultVariant: true,
        lastChangedBy: CHANGED_BY,
      },
    });
  }
  const nextVersion = publishedMatches ? workflow.publishedVersion : workflow.publishedVersion + 1;
  if (!publishedMatches) {
    await tx.notificationWorkflowVersion.create({
      data: {
        workspaceId: WORKSPACE_ID,
        workflowId: workflow.id,
        version: nextVersion,
        definition,
        validationResult: validation,
        changeNote: 'RO-6: sender guard (not an agent, not a survey response) + mock-mode rollout',
        publishedBy: CHANGED_BY,
      },
    });
  }
  workflow = await tx.notificationWorkflow.update({
    where: { id: workflow.id },
    data: {
      draftDefinition: definition,
      ...(publishedMatches ? {} : { publishedDefinition: definition, publishedVersion: nextVersion, lastPublishedAt: now }),
      isEnabled: true,
      enabledAt: workflow.isEnabled ? workflow.enabledAt : now,
      mockModeEnabled: true,
      mockModeEnabledAt: workflow.mockModeEnabled ? workflow.mockModeEnabledAt : now,
      mockModeUpdatedBy: CHANGED_BY,
      lastChangedBy: CHANGED_BY,
    },
  });
});
console.log(`APPLIED: workflow #${workflow.id} "${workflow.name}" → published v${workflow.publishedVersion}, enabled=${workflow.isEnabled}, mock=${workflow.mockModeEnabled}`);
console.log('Next: watch Settings → Mail Workflows → runs for ~2 days, then turn mock mode off in the editor to go live.');
await prisma.$disconnect();
