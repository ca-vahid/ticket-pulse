#!/usr/bin/env node
/**
 * RL-6 (MEGA 09-01 Phase RL): "Ticket arrived" workflow hygiene for ws5.
 *
 * Workflow 11369 ("Ticket arrived", trigger ticket.created) acks EVERY new
 * ticket — including FreshService sync-ins (the duplicate acks behind QA #2/#3)
 * — to a hard-coded 19-address `custom_emails` list. This script:
 *
 *   1. inserts a condition node `ticket.origin is ticketpulse` right after the
 *      trigger (FS-born sync-ins no longer ack), and
 *   2. swaps every `custom_emails` recipient for the internal-group recipient
 *      `internal_group:3458` (resolved to the group's ACTIVE members at send
 *      time — no address list to maintain). The old list is kept on the
 *      definition metadata (`rl6PreviousCustomEmails`) for rollback.
 *
 * Both draft and published definitions are updated; --apply publishes a new
 * version through notificationWorkflowRepository.publishWorkflow (validated,
 * versioned, enabled state preserved). Idempotent: re-running reports
 * "already hygienic" and changes nothing.
 *
 * Usage:  node scripts/ws5-ticket-arrived-hygiene.mjs [--apply] [--prod]
 *         [--workspace <id>] [--workflow <id>] [--group <id>]
 * Default = dry-run against the dev DB. --prod loads PROD_DATABASE_URL from
 * scripts/.env.prod. The orchestrator applies to prod.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const PROD = args.includes('--prod');
const KEEP_RECIPIENTS = args.includes('--keep-recipients'); // origin guard only; leave custom_emails as-is
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const WORKSPACE_ID = Number(opt('--workspace', 5));
const WORKFLOW_ID = Number(opt('--workflow', 11369));
const GROUP_ID = Number(opt('--group', 3458));
const here = path.dirname(fileURLToPath(import.meta.url));

if (PROD) {
  const env = fs.readFileSync(path.join(here, '.env.prod'), 'utf8');
  const m = env.match(/^PROD_DATABASE_URL=(.+)$/m);
  if (!m) throw new Error('PROD_DATABASE_URL missing from scripts/.env.prod');
  process.env.DATABASE_URL = m[1].trim().replace(/^"|"$/g, '');
}
// Dynamic imports AFTER the env is set: services/prisma.js reads DATABASE_URL at load.
const { default: prisma } = await import('../src/services/prisma.js');
console.log(`TARGET: ${PROD ? 'PROD' : 'dev'} database — ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`workspace ${WORKSPACE_ID} · workflow ${WORKFLOW_ID} · group ${GROUP_ID}`);

const CONDITION_NODE_ID = 'rl6_origin_guard';
const GROUP_TOKEN = `internal_group:${GROUP_ID}`;

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/** Apply both hygiene edits to a definition; returns { definition, changes[] }. */
function hygienize(definition) {
  const changes = [];
  const def = JSON.parse(JSON.stringify(definition));
  def.nodes = Array.isArray(def.nodes) ? def.nodes : [];
  def.edges = Array.isArray(def.edges) ? def.edges : [];
  def.metadata = isPlainObject(def.metadata) ? def.metadata : {};

  // 1. origin guard after the trigger
  const trigger = def.nodes.find((n) => n.type === 'trigger');
  if (!trigger) throw new Error('definition has no trigger node');
  const hasGuard = def.nodes.some((n) => n.id === CONDITION_NODE_ID)
    || def.nodes.some((n) => n.type === 'condition' && JSON.stringify(n.data?.conditionGroup || {}).includes('"ticket.origin"'));
  if (!hasGuard) {
    const outgoing = def.edges.filter((e) => e.source === trigger.id);
    const guard = {
      id: CONDITION_NODE_ID,
      type: 'condition',
      position: { x: (trigger.position?.x || 80) + 120, y: (trigger.position?.y || 80) + 140 },
      data: {
        label: 'Born in Ticket Pulse?',
        conditionGroup: { logic: 'all', conditions: [{ field: 'ticket.origin', operator: 'is', value: 'ticketpulse' }] },
      },
    };
    def.nodes.splice(def.nodes.indexOf(trigger) + 1, 0, guard);
    for (const e of outgoing) {
      e.source = CONDITION_NODE_ID;
      e.sourceHandle = 'true';
      if (e.id) e.id = `${e.id}__via_${CONDITION_NODE_ID}`;
    }
    def.edges.push({ id: `${trigger.id}->${CONDITION_NODE_ID}`, source: trigger.id, target: CONDITION_NODE_ID });
    changes.push(`add condition node "${CONDITION_NODE_ID}" (ticket.origin is ticketpulse) between "${trigger.id}" and ${outgoing.length} successor edge(s) [${outgoing.map((e) => e.target).join(', ')}]`);
  }

  // 2. custom_emails → internal group members
  for (const node of def.nodes) {
    if (node.type !== 'recipient_resolver') continue;
    const data = isPlainObject(node.data) ? node.data : (node.data = {});
    for (const key of ['to', 'cc', 'bcc']) {
      const list = Array.isArray(data[key]) ? data[key] : [];
      if (KEEP_RECIPIENTS || !list.includes('custom_emails')) continue;
      const previous = Array.isArray(data.customEmails) ? data.customEmails : [];
      const next = [...list.filter((t) => t !== 'custom_emails')];
      if (!next.includes(GROUP_TOKEN)) next.push(GROUP_TOKEN);
      data[key] = next;
      def.metadata.rl6PreviousCustomEmails = { nodeId: node.id, list: key, customEmails: previous, replacedAt: new Date().toISOString() };
      data.customEmails = [];
      changes.push(`node "${node.id}" ${key}: custom_emails (${previous.length} address${previous.length === 1 ? '' : 'es'}) → ${GROUP_TOKEN}`);
    }
  }
  return { definition: def, changes };
}

const ws = await prisma.workspace.findUnique({ where: { id: WORKSPACE_ID }, select: { id: true, name: true, slug: true } });
if (!ws) { console.log(`workspace ${WORKSPACE_ID} not found in this database — nothing to do`); await prisma.$disconnect(); process.exit(0); }
console.log(`workspace ${ws.id}: ${ws.name} (${ws.slug})`);

const group = await prisma.group.findFirst({
  where: { id: GROUP_ID, workspaceId: WORKSPACE_ID },
  select: { id: true, name: true, origin: true, isActive: true, members: { select: { technician: { select: { email: true, isActive: true } } } } },
});
if (!group) {
  console.log(`group ${GROUP_ID} not found in workspace ${WORKSPACE_ID} — refusing to point recipients at a missing group`);
  await prisma.$disconnect(); process.exit(APPLY ? 1 : 0);
}
const activeMembers = group.members.filter((m) => m.technician?.isActive && m.technician?.email).map((m) => m.technician.email);
console.log(`group ${group.id}: "${group.name}" (${group.origin}${group.isActive ? '' : ', INACTIVE'}) — ${activeMembers.length} active member(s): ${activeMembers.join(', ') || '(none)'}`);
if (group.origin !== 'local') console.log('  WARNING: group is not an internal (local) group — internal_group tokens resolve via group_members only');

const workflow = await prisma.notificationWorkflow.findFirst({ where: { id: WORKFLOW_ID, workspaceId: WORKSPACE_ID } });
if (!workflow) { console.log(`workflow ${WORKFLOW_ID} not found in workspace ${WORKSPACE_ID} — nothing to do`); await prisma.$disconnect(); process.exit(0); }
console.log(`workflow ${workflow.id}: "${workflow.name}" trigger=${workflow.triggerType} enabled=${workflow.isEnabled} published=v${workflow.publishedVersion}`);
if (workflow.triggerType !== 'ticket.created') console.log('  WARNING: trigger is not ticket.created — the origin guard still applies, verify this is the ack workflow');

const source = workflow.publishedDefinition || workflow.draftDefinition;
const { definition: nextDefinition, changes } = hygienize(source);
if (changes.length === 0) {
  console.log('already hygienic — nothing to do');
  await prisma.$disconnect(); process.exit(0);
}
console.log('\nPLANNED CHANGES:');
for (const c of changes) console.log(`  • ${c}`);
const previous = nextDefinition.metadata?.rl6PreviousCustomEmails?.customEmails || [];
if (previous.length) console.log(`  (previous custom_emails kept on metadata.rl6PreviousCustomEmails: ${previous.join(', ')})`);

if (!APPLY) { console.log('\nDRY-RUN — nothing changed. Re-run with --apply.'); await prisma.$disconnect(); process.exit(0); }

const { publishWorkflow, saveDraft } = await import('../src/services/notificationWorkflowRepository.js');
const actor = { email: 'rl6-hygiene@ticketpulse.internal', name: 'RL-6 hygiene script' };
// saveDraft validates the definition (assertValidWorkflowDefinition) before
// publishWorkflow versions it — a malformed edit fails here, not in prod runs.
await saveDraft(WORKSPACE_ID, WORKFLOW_ID, { definition: nextDefinition }, actor);
const { workflow: published, version } = await publishWorkflow(WORKSPACE_ID, WORKFLOW_ID, {
  changeNote: KEEP_RECIPIENTS ? 'RL-6 hygiene: origin guard (ticket.origin is ticketpulse); recipients unchanged' : 'RL-6 hygiene: origin guard (ticket.origin is ticketpulse) + custom_emails → internal group members',
  enabled: workflow.isEnabled,
}, actor);
console.log(`APPLIED: workflow ${published.id} published as v${version.version} (enabled=${published.isEnabled})`);
await prisma.$disconnect();
