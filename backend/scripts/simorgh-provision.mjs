#!/usr/bin/env node
/**
 * Simorgh integration — provisioning (plan Phase 0). Idempotent; dry-run by default.
 *
 *   node scripts/simorgh-provision.mjs --sandbox            # create "Simorgh Sandbox" ws + seed
 *   node scripts/simorgh-provision.mjs --it                 # IT workspace: taxonomy, tags, requester
 *   node scripts/simorgh-provision.mjs --client --workspace <id>   # issue the Simorgh OAuth client
 *   node scripts/simorgh-provision.mjs --webhook --workspace <id> --url <https://…>
 *   add --apply to any of the above to write.
 *
 * Why a script and not the UI: the sandbox workspace is deliberately inactive
 * (invisible to every scheduler AND to the workspace picker), and the IT
 * taxonomy edits have to be repeatable in the sandbox. Secrets print ONCE.
 *
 * Decisions encoded here (plans/SIMORGH_REPLY.md §3, Vahid 14 Sep):
 *   one credential, trusted intake ON, stage-as-data; no second client.
 */
import { PrismaClient } from '@prisma/client';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const after = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const APPLY = has('--apply');
const log = (m) => console.log(`  ${m}`);
const plan = (m) => console.log(`  ${APPLY ? 'DO  ' : 'PLAN'} ${m}`);

const prisma = new PrismaClient();

const SANDBOX = { name: 'Simorgh Sandbox', slug: 'simorgh-sandbox' };
const REQUESTER = { name: 'Simorgh · Security Operations', email: 'simorgh@bgcengineering.ca' };
const GROUP = 'Cyber Security';
const TAGS = [
  ['simorgh', 'violet'], ['tier-2', 'indigo'], ['review', 'amber'], ['sentinel', 'sky'], ['defender', 'blue'],
];
// Live IT names + the three the request needs (reply B1).
const SECURITY_SUBS = [
  'Phishing / Spam Reports',
  'Suspicious Authentication / Account Compromise',
  'Endpoint Threat / C2 Detection',
  'Network / WiFi Security Alert',
  'Data Exfiltration / DLP Alert',
  'Security Alert Triage',
  'Detection Rule Tuning',
  'Threat Intelligence / Security Advisory',
  'Firewall & Perimeter Security',
  'SSL / Certificate Management',
  'DOS (Denial of Service)',
];
const CLIENT = {
  name: 'Simorgh',
  scopes: [
    'tickets:read', 'tickets:write', 'conversations:read', 'conversations:write',
    'customfields:read', 'customfields:write', 'tags:read', 'tags:write', 'search:read',
    'agents:read', 'groups:read', 'categories:read', 'types:read', 'contacts:read', 'webhooks:read',
  ],
  trustedIntake: true,
};
const WEBHOOK_EVENTS = [
  'ticket.created', 'ticket.status_changed', 'ticket.assigned', 'ticket.reply_received',
  'ticket.public_reply_added', 'ticket.fields_updated', 'ticket.custom_fields_changed', 'ticket.tags_changed',
  'ticket.note_added',
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
    if (found.name !== REQUESTER.name) {
      plan(`rename requester #${found.id} "${found.name}" -> "${REQUESTER.name}"`);
      if (APPLY) await prisma.requester.update({ where: { id: found.id }, data: { name: REQUESTER.name } });
    } else log(`requester #${found.id} "${found.name}" (exists)`);
    return found;
  }
  plan(`create requester "${REQUESTER.name}" <${REQUESTER.email}>`);
  if (!APPLY) return null;
  return prisma.requester.create({ data: { ...REQUESTER, isActive: true } });
}

async function ensureGroup(workspaceId) {
  const found = await prisma.group.findFirst({ where: { workspaceId, name: GROUP } });
  if (found) { log(`group #${found.id} "${found.name}" (${found.origin}, exists)`); return found; }
  plan(`create local group "${GROUP}" in ws ${workspaceId}`);
  if (!APPLY) return null;
  return prisma.group.create({ data: { workspaceId, name: GROUP, origin: 'local', freshserviceId: null, isActive: true } });
}

async function ensureSecurityTaxonomy(workspaceId) {
  let parent = await prisma.competencyCategory.findFirst({ where: { workspaceId, parentId: null, name: 'Security' } });
  if (!parent) {
    plan(`create top-level category "Security" in ws ${workspaceId}`);
    if (!APPLY) return;
    parent = await prisma.competencyCategory.create({ data: { workspaceId, name: 'Security', isActive: true, source: 'manual' } });
  } else log(`category "Security" #${parent.id} (exists${parent.isActive ? '' : ', INACTIVE'})`);
  for (const name of SECURITY_SUBS) {
    const sub = await prisma.competencyCategory.findFirst({ where: { workspaceId, parentId: parent.id, name } });
    if (!sub) {
      plan(`create subcategory "Security > ${name}"`);
      if (APPLY) await prisma.competencyCategory.create({ data: { workspaceId, parentId: parent.id, name, isActive: true, source: 'manual' } });
    } else if (!sub.isActive) {
      plan(`REACTIVATE "Security > ${name}" (#${sub.id})`);
      if (APPLY) await prisma.competencyCategory.update({ where: { id: sub.id }, data: { isActive: true } });
    } else log(`"Security > ${name}" #${sub.id} (exists)`);
  }
}

async function ensureTags(workspaceId) {
  for (const [name, color] of TAGS) {
    const found = await prisma.ticketTag.findFirst({ where: { workspaceId, name } });
    if (found) { log(`tag "${name}" #${found.id} (exists)`); continue; }
    plan(`create tag "${name}" (${color})`);
    if (APPLY) await prisma.ticketTag.create({ data: { workspaceId, name, color, isActive: true, createdBy: 'simorgh-provision' } });
  }
}

async function issueClient(workspaceId) {
  const { default: oauthClientService } = await import('../src/services/oauthClientService.js');
  const existing = await prisma.oAuthClient.findFirst({ where: { workspaceId, name: CLIENT.name, revokedAt: null } });
  if (existing) { log(`OAuth client "${CLIENT.name}" ${existing.clientId} already exists in ws ${workspaceId} (trusted=${existing.trustedIntake}) — rotate in Settings if a new secret is needed`); return; }
  plan(`issue OAuth client "${CLIENT.name}" in ws ${workspaceId}: trustedIntake=true, ${CLIENT.scopes.length} scopes`);
  if (!APPLY) return;
  const c = await oauthClientService.create(workspaceId, CLIENT, { email: 'simorgh-provision' });
  console.log('\n──────── HAND OVER SECURELY — SHOWN ONCE ────────');
  console.log(`  token_url:     https://api.ticketpulse.bgcsaas.com/api/v1/oauth/token`);
  console.log(`  client_id:     ${c.clientId}`);
  console.log(`  client_secret: ${c.clientSecret}`);
  console.log('──────────────────────────────────────────────────\n');
}

async function subscribeWebhook(workspaceId, url) {
  const existing = await prisma.webhookSubscription.findFirst({ where: { workspaceId, url } });
  if (existing) { log(`webhook subscription #${existing.id} for ${url} exists (events: ${existing.events.length})`); return; }
  plan(`create webhook subscription ws ${workspaceId} -> ${url} for ${WEBHOOK_EVENTS.length} events`);
  if (!APPLY) return;
  const crypto = await import('node:crypto');
  const secret = `whsec_${crypto.randomBytes(24).toString('base64')}`;
  const sub = await prisma.webhookSubscription.create({
    data: { workspaceId, url, secret, events: WEBHOOK_EVENTS, createdBy: 'simorgh-provision' },
  });
  const { invalidateWebhookCache } = await import('../src/services/webhookDispatchService.js');
  invalidateWebhookCache(workspaceId);
  console.log('\n──────── WEBHOOK SECRET — SHOWN ONCE ────────');
  console.log(`  subscription #${sub.id}\n  signing secret: ${secret}`);
  console.log('──────────────────────────────────────────────\n');
}

async function main() {
  console.log(APPLY ? 'APPLY mode' : 'DRY RUN (add --apply to write)');
  if (has('--sandbox')) {
    console.log('\n[sandbox]');
    const ws = await ensureWorkspace();
    if (ws) {
      await ensureRequester();
      await ensureGroup(ws.id);
      await ensureSecurityTaxonomy(ws.id);
      await ensureTags(ws.id);
      log(`sandbox workspace id = ${ws.id}`);
    } else {
      log('(dry run: the workspace does not exist yet, so its seed is planned on the first --apply)');
    }
  }
  if (has('--it')) {
    console.log('\n[IT workspace 1]');
    await ensureRequester();
    await ensureSecurityTaxonomy(1);
    await ensureTags(1);
  }
  if (has('--client')) {
    const ws = Number(after('--workspace'));
    if (!ws) throw new Error('--client needs --workspace <id>');
    console.log(`\n[client ws ${ws}]`);
    await issueClient(ws);
  }
  if (has('--webhook')) {
    const ws = Number(after('--workspace')); const url = after('--url');
    if (!ws || !url) throw new Error('--webhook needs --workspace <id> --url <https://…>');
    console.log(`\n[webhook ws ${ws}]`);
    await subscribeWebhook(ws, url);
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
