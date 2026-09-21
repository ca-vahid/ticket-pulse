#!/usr/bin/env node
/**
 * ContinuIT integration — provisioning. Idempotent; dry-run by default.
 * A sibling of simorgh-provision.mjs with ContinuIT's constants (their
 * integration request rev. 2, 15 Sep 2026, "provisioning" list at the end).
 *
 *   node scripts/continuit-provision.mjs --sandbox                       # "ContinuIT Sandbox" ws + tags + requester + ticket types
 *   node scripts/continuit-provision.mjs --it                            # IT workspace: tags + requester only (no taxonomy change)
 *   node scripts/continuit-provision.mjs --client --workspace <id> [--allowlist <file>] [--default-source <n>]
 *   node scripts/continuit-provision.mjs --webhook --workspace <id> [--url <https://…>] [--ref-prefix continuit:]
 *   add --apply to any of the above to write. Secrets print ONCE.
 *
 * Decisions encoded here (Vahid's forwarding note, 19 Sep 2026):
 *   one credential, trusted intake ON (R1–R5: never re-categorise / re-type /
 *   re-prioritise / noise-close what they file; assign only when they leave
 *   the assignee empty); unattended requester continuit@; tags continuit +
 *   office-check-in; webhook to continuit-api; the 32 outbound IPs for the IT
 *   client come from section 2 of their document via --allowlist.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const after = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const APPLY = has('--apply');
const log = (m) => console.log(`  ${m}`);
const plan = (m) => console.log(`  ${APPLY ? 'DO  ' : 'PLAN'} ${m}`);

const prisma = new PrismaClient();

const SANDBOX = { name: 'ContinuIT Sandbox', slug: 'continuit-sandbox' };
const REQUESTER = { name: 'ContinuIT', email: 'continuit@bgcengineering.ca' };
const TAGS = [['continuit', 'teal'], ['office-check-in', 'sky']];
const CLIENT = {
  name: 'ContinuIT',
  scopes: [
    'tickets:read', 'tickets:write', 'conversations:read', 'conversations:write',
    'customfields:read', 'customfields:write', 'tags:read', 'tags:write', 'search:read',
    'agents:read', 'groups:read', 'categories:read', 'types:read', 'contacts:read', 'webhooks:read',
    'tasks:read', 'tasks:write',
  ],
  trustedIntake: true,
  // Structural moves (merge, parent/child, links, split) limited to tickets this
  // credential created — a bug in their app can never restructure another IT ticket.
  structureOwnTicketsOnly: true,
};
const WEBHOOK_URL = 'https://continuit-api.azurewebsites.net/api/webhooks/ticketpulse';
const WEBHOOK_EVENTS = [
  'ticket.created', 'ticket.status_changed', 'ticket.assigned', 'ticket.reply_received',
  'ticket.public_reply_added', 'ticket.fields_updated', 'ticket.custom_fields_changed', 'ticket.tags_changed',
  'ticket.note_added', 'task.created', 'task.updated', 'task.completed',
];

async function ensureWorkspace() {
  const found = await prisma.workspace.findFirst({ where: { slug: SANDBOX.slug } });
  if (found) { log(`workspace #${found.id} "${found.name}" (exists)`); return found; }
  plan(`create workspace "${SANDBOX.name}" (isActive:false, nativeTicketingEnabled:true, no mirror)`);
  if (!APPLY) return null;
  return prisma.workspace.create({
    data: {
      name: SANDBOX.name, slug: SANDBOX.slug, freshserviceWorkspaceId: 0,
      isActive: false, nativeTicketingEnabled: true, internalDomains: ['bgcengineering.ca'],
    },
  });
}

async function ensureRequester() {
  const found = await prisma.requester.findFirst({ where: { email: REQUESTER.email } });
  if (found) {
    const patch = {};
    if (found.name !== REQUESTER.name) patch.name = REQUESTER.name;
    if (found.unattended !== true) patch.unattended = true;
    if (Object.keys(patch).length) {
      plan(`update requester #${found.id}: ${JSON.stringify(patch)}`);
      if (APPLY) await prisma.requester.update({ where: { id: found.id }, data: patch });
    } else log(`requester #${found.id} "${found.name}" (exists, unattended)`);
    return found;
  }
  plan(`create UNATTENDED requester "${REQUESTER.name}" <${REQUESTER.email}> (never receives requester-facing mail)`);
  if (!APPLY) return null;
  return prisma.requester.create({ data: { ...REQUESTER, isActive: true, unattended: true } });
}

async function ensureTicketTypes(workspaceId) {
  const have = await prisma.ticketTypeDefinition.count({ where: { workspaceId } });
  if (have > 0) { log(`${have} ticket types exist`); return; }
  const source = await prisma.ticketTypeDefinition.findMany({ where: { workspaceId: 1, isActive: true }, orderBy: { id: 'asc' } });
  plan(`copy ${source.length} ticket types from IT: ${source.map((t) => t.name).join(', ')}`);
  if (!APPLY) return;
  for (const t of source) {
    await prisma.ticketTypeDefinition.create({
      data: {
        workspaceId, name: t.name, description: t.description, aliases: t.aliases,
        fsTypeValue: null, fsChoiceId: null, fsDetectedAt: null,
        aiAssignable: t.aiAssignable, isDefault: t.isDefault, color: t.color, isActive: true,
      },
    });
  }
}

async function ensureTags(workspaceId) {
  for (const [name, color] of TAGS) {
    const found = await prisma.ticketTag.findFirst({ where: { workspaceId, name } });
    if (found) { log(`tag "${name}" #${found.id} (exists)`); continue; }
    plan(`create tag "${name}" (${color}) in ws ${workspaceId}`);
    if (APPLY) await prisma.ticketTag.create({ data: { workspaceId, name, color, isActive: true, createdBy: 'continuit-provision' } });
  }
}

async function issueClient(workspaceId) {
  const existing = await prisma.oAuthClient.findFirst({ where: { workspaceId, name: CLIENT.name, revokedAt: null } });
  if (existing) { log(`OAuth client "${CLIENT.name}" ${existing.clientId} already exists in ws ${workspaceId} (trusted=${existing.trustedIntake}) — rotate in Settings if a new secret is needed`); return; }
  const allowFile = after('--allowlist');
  const ipAllowlist = allowFile ? fs.readFileSync(allowFile, 'utf8').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) : [];
  const defaultSource = after('--default-source') ? Number(after('--default-source')) : null;
  plan(`issue OAuth client "${CLIENT.name}" in ws ${workspaceId}: trustedIntake=true, ${CLIENT.scopes.length} scopes, allowlist ${ipAllowlist.length} entries, defaultSource ${defaultSource ?? 'none'}`);
  if (!APPLY) return;
  const { default: oauthClientService } = await import('../src/services/oauthClientService.js');
  const c = await oauthClientService.create(workspaceId, { ...CLIENT, ipAllowlist, defaultSource }, { email: 'continuit-provision' });
  console.log(`  client_id:     ${c.clientId}`);
  console.log(`  client_secret: ${c.clientSecret}`);
  console.log('  (the secret is shown once — hand it over out of band)');
}

async function subscribeWebhook(workspaceId, url) {
  // ContinuIT D2 (3.9.54): --ref-prefix limits delivery to tickets whose
  // externalRef starts with it — the IT subscription never sees the rest of IT.
  const refPrefix = after('--ref-prefix') || null;
  const existing = await prisma.webhookSubscription.findFirst({ where: { workspaceId, url } });
  if (existing) {
    log(`webhook subscription #${existing.id} for ${url} exists (events: ${existing.events.length}, prefix: ${existing.externalRefPrefix || 'none'})`);
    if (refPrefix && existing.externalRefPrefix !== refPrefix) {
      plan(`set externalRefPrefix ${JSON.stringify(refPrefix)} on subscription #${existing.id}`);
      if (APPLY) await prisma.webhookSubscription.update({ where: { id: existing.id }, data: { externalRefPrefix: refPrefix } });
    }
    return;
  }
  plan(`create webhook subscription ws ${workspaceId} -> ${url} for ${WEBHOOK_EVENTS.length} events${refPrefix ? `, only externalRef ${refPrefix}*` : ''}`);
  if (!APPLY) return;
  const secret = `whsec_${crypto.randomBytes(24).toString('base64')}`;
  const sub = await prisma.webhookSubscription.create({
    data: { workspaceId, url, secret, events: WEBHOOK_EVENTS, createdBy: 'continuit-provision', ...(refPrefix ? { externalRefPrefix: refPrefix } : {}) },
  });
  console.log(`  subscription #${sub.id}\n  signing secret: ${secret}\n  (shown once — hand it over out of band)`);
}

async function main() {
  console.log(APPLY ? 'APPLY mode — writing.' : 'DRY RUN — pass --apply to write.');
  if (has('--sandbox')) {
    console.log('\n[sandbox]');
    const ws = await ensureWorkspace();
    await ensureRequester();
    if (ws) { await ensureTicketTypes(ws.id); await ensureTags(ws.id); }
  }
  if (has('--it')) {
    console.log('\n[IT workspace 1]');
    await ensureRequester();
    await ensureTags(1);
  }
  if (has('--client')) {
    const ws = Number(after('--workspace'));
    if (!ws) throw new Error('--client needs --workspace <id>');
    console.log(`\n[client ws ${ws}]`);
    await issueClient(ws);
  }
  if (has('--webhook')) {
    const ws = Number(after('--workspace')); const url = after('--url') || WEBHOOK_URL;
    if (!ws) throw new Error('--webhook needs --workspace <id>');
    console.log(`\n[webhook ws ${ws}]`);
    await subscribeWebhook(ws, url);
  }
  if (!has('--sandbox') && !has('--it') && !has('--client') && !has('--webhook')) console.log('nothing selected — see the header for flags');
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
