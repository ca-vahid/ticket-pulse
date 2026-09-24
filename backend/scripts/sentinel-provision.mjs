#!/usr/bin/env node
/**
 * Microsoft Sentinel monitoring-alert integration — provisioning (24 Sep 2026).
 * Idempotent; dry-run by default. A sibling of continuit-provision.mjs.
 *
 *   node scripts/sentinel-provision.mjs --sandbox                    # "Sentinel Sandbox" ws + types + taxonomy subset + group + tag + requester
 *   node scripts/sentinel-provision.mjs --it                         # IT: tag + requester only
 *   node scripts/sentinel-provision.mjs --client --workspace <id> [--allowlist <file>]
 *   node scripts/sentinel-provision.mjs --webhook --workspace <id> --url <https://…logic app…>
 *   add --apply to write. Secrets print ONCE — redirect to a file, never paste in chat.
 *
 * Scope (Vahid, 24 Sep 2026): Sentinel sends INFRASTRUCTURE alerts (servers,
 * FTP, certificate expiry, up/down). Security alerts stay with Simorgh, which
 * investigates before it files — this credential is not a security gate. The
 * existing tag "sentinel" belongs to Simorgh's security tickets, so these
 * tickets use their own tag "monitoring-alert".
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

const SANDBOX = { name: 'Sentinel Sandbox', slug: 'sentinel-sandbox' };
const REQUESTER = { name: 'Microsoft Sentinel', email: 'sentinel@bgcengineering.ca' };
const TAGS = [['monitoring-alert', 'amber']];
const CLIENT = {
  name: 'Microsoft Sentinel (monitoring)',
  scopes: [
    'tickets:read', 'tickets:write', 'conversations:read', 'conversations:write',
    'customfields:read', 'customfields:write', 'tags:read', 'tags:write', 'search:read',
    'agents:read', 'groups:read', 'categories:read', 'types:read', 'contacts:read', 'webhooks:read',
  ],
  // Monitoring Alert (106): shows where these tickets came from in the queue.
  defaultSource: 106,
  trustedIntake: true,
  // Structural moves (merge, parent/child, links, split) limited to tickets this
  // credential created — a bug in their app can never restructure another IT ticket.
  structureOwnTicketsOnly: true,
};
const WEBHOOK_URL = null; // their Logic App callback URL — pass --url when they send it
const WEBHOOK_EVENTS = ['ticket.status_changed'];
// Only their tickets reach the callback: the subscription is limited to this tag.
const WEBHOOK_MATCH_TAG = 'monitoring-alert';
const WEBHOOK_REF_PREFIX = 'sentinel:';
// Taxonomy the sandbox needs so category names resolve the way they do in IT.
const SANDBOX_TAXONOMY = {
  'Cloud & Servers': ['Network & Server Infrastructure', 'Backup / Restore', 'Azure Infrastructure'],
  'Network & Remote Access': ['ISP / Connectivity Monitoring', 'Office Network Setup and Troubleshooting'],
};
const SANDBOX_GROUP = 'Servers (sandbox)';

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

async function ensureTaxonomy(workspaceId) {
  for (const [parentName, children] of Object.entries(SANDBOX_TAXONOMY)) {
    let parent = await prisma.competencyCategory.findFirst({ where: { workspaceId, name: parentName, parentId: null } });
    if (!parent) {
      plan(`create category "${parentName}" in ws ${workspaceId}`);
      if (APPLY) parent = await prisma.competencyCategory.create({ data: { workspaceId, name: parentName, source: 'sentinel-provision' } });
    } else log(`category "${parentName}" #${parent.id} (exists)`);
    for (const child of children) {
      const found = parent ? await prisma.competencyCategory.findFirst({ where: { workspaceId, name: child, parentId: parent.id } }) : null;
      if (found) { log(`  subcategory "${child}" (exists)`); continue; }
      plan(`  create subcategory "${parentName} / ${child}"`);
      if (APPLY && parent) await prisma.competencyCategory.create({ data: { workspaceId, name: child, parentId: parent.id, source: 'sentinel-provision' } });
    }
  }
}

async function ensureGroup(workspaceId) {
  const found = await prisma.group.findFirst({ where: { workspaceId, name: SANDBOX_GROUP } });
  if (found) { log(`group "${SANDBOX_GROUP}" #${found.id} (exists) — internalGroupId ${found.id}`); return found; }
  plan(`create internal group "${SANDBOX_GROUP}" in ws ${workspaceId}`);
  if (!APPLY) return null;
  const g = await prisma.group.create({ data: { workspaceId, name: SANDBOX_GROUP, origin: 'local', freshserviceId: null } });
  log(`group #${g.id} — use internalGroupId ${g.id} in the sandbox`);
  return g;
}

async function issueClient(workspaceId) {
  const existing = await prisma.oAuthClient.findFirst({ where: { workspaceId, name: CLIENT.name, revokedAt: null } });
  if (existing) { log(`OAuth client "${CLIENT.name}" ${existing.clientId} already exists in ws ${workspaceId} (trusted=${existing.trustedIntake}) — rotate in Settings if a new secret is needed`); return; }
  const allowFile = after('--allowlist');
  const ipAllowlist = allowFile ? fs.readFileSync(allowFile, 'utf8').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) : [];
  const defaultSource = after('--default-source') ? Number(after('--default-source')) : (CLIENT.defaultSource ?? null);
  plan(`issue OAuth client "${CLIENT.name}" in ws ${workspaceId}: trustedIntake=true, ${CLIENT.scopes.length} scopes, allowlist ${ipAllowlist.length} entries, defaultSource ${defaultSource ?? 'none'}`);
  if (!APPLY) return;
  const { default: oauthClientService } = await import('../src/services/oauthClientService.js');
  const c = await oauthClientService.create(workspaceId, { ...CLIENT, ipAllowlist, defaultSource }, { email: 'continuit-provision' });
  console.log(`  client_id:     ${c.clientId}`);
  console.log(`  client_secret: ${c.clientSecret}`);
  console.log('  (the secret is shown once — hand it over out of band)');
}

async function subscribeWebhook(workspaceId, url) {
  // --ref-prefix limits delivery to tickets whose
  // externalRef starts with it — the IT subscription never sees the rest of IT.
  const refPrefix = after('--ref-prefix') || WEBHOOK_REF_PREFIX;
  // --match-tag (23 Sep 2026): also deliver tickets carrying this tag — the ones
  // the integration links to instead of creating.
  const matchTag = after('--match-tag') || WEBHOOK_MATCH_TAG;
  const existing = await prisma.webhookSubscription.findFirst({ where: { workspaceId, url } });
  if (existing) {
    log(`webhook subscription #${existing.id} for ${url} exists (events: ${existing.events.length}, prefix: ${existing.externalRefPrefix || 'none'})`);
    if (refPrefix && existing.externalRefPrefix !== refPrefix) {
      plan(`set externalRefPrefix ${JSON.stringify(refPrefix)} on subscription #${existing.id}`);
      if (APPLY) await prisma.webhookSubscription.update({ where: { id: existing.id }, data: { externalRefPrefix: refPrefix } });
    }
    if (matchTag && existing.matchTag !== matchTag) {
      plan(`set matchTag ${JSON.stringify(matchTag)} on subscription #${existing.id}`);
      if (APPLY) await prisma.webhookSubscription.update({ where: { id: existing.id }, data: { matchTag } });
    }
    return;
  }
  plan(`create webhook subscription ws ${workspaceId} -> ${url} for ${WEBHOOK_EVENTS.length} events${refPrefix ? `, only externalRef ${refPrefix}*` : ''}`);
  if (!APPLY) return;
  const secret = `whsec_${crypto.randomBytes(24).toString('base64')}`;
  const sub = await prisma.webhookSubscription.create({
    data: { workspaceId, url, secret, events: WEBHOOK_EVENTS, createdBy: 'continuit-provision', ...(refPrefix ? { externalRefPrefix: refPrefix } : {}), ...(matchTag ? { matchTag } : {}) },
  });
  console.log(`  subscription #${sub.id}\n  signing secret: ${secret}\n  (shown once — hand it over out of band)`);
}

async function main() {
  console.log(APPLY ? 'APPLY mode — writing.' : 'DRY RUN — pass --apply to write.');
  if (has('--sandbox')) {
    console.log('\n[sandbox]');
    const ws = await ensureWorkspace();
    await ensureRequester();
    if (ws) { await ensureTicketTypes(ws.id); await ensureTags(ws.id); await ensureTaxonomy(ws.id); await ensureGroup(ws.id); }
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
    if (!url) throw new Error('--webhook needs --url <their Logic App callback URL>');
    if (!ws) throw new Error('--webhook needs --workspace <id>');
    console.log(`\n[webhook ws ${ws}]`);
    await subscribeWebhook(ws, url);
  }
  if (!has('--sandbox') && !has('--it') && !has('--client') && !has('--webhook')) console.log('nothing selected — see the header for flags');
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
