#!/usr/bin/env node
/**
 * Simorgh integration — provisioning (plan Phase 0). Idempotent; dry-run by default.
 *
 *   node scripts/simorgh-provision.mjs --sandbox            # create "Simorgh Sandbox" ws + seed
 *   node scripts/simorgh-provision.mjs --it                 # IT workspace: taxonomy, tags, requester
 *   node scripts/simorgh-provision.mjs --client --workspace <id> [--allowlist <file>] [--default-source 104]
 *   node scripts/simorgh-provision.mjs --webhook --workspace <id> --url <https://…>
 *   node scripts/simorgh-provision.mjs --policy --workspace <id> [--enable]
 *        C2: the never_noise veto keyed on simorgh@ + the "resolve on benign
 *        verdict" workflow (installed DISABLED; --enable = publish + enable)
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

// The sandbox is a native-only workspace: it has no FreshService to detect
// ticket types from, so it copies IT's type definitions (acceptance 14 Sep:
// "ticketType must be one of: (none configured)").
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
    plan(`create tag "${name}" (${color})`);
    if (APPLY) await prisma.ticketTag.create({ data: { workspaceId, name, color, isActive: true, createdBy: 'simorgh-provision' } });
  }
}

async function issueClient(workspaceId) {
  const { default: oauthClientService } = await import('../src/services/oauthClientService.js');
  const existing = await prisma.oAuthClient.findFirst({ where: { workspaceId, name: CLIENT.name, revokedAt: null } });
  if (existing) { log(`OAuth client "${CLIENT.name}" ${existing.clientId} already exists in ws ${workspaceId} (trusted=${existing.trustedIntake}) — rotate in Settings if a new secret is needed`); return; }
  const allowFile = after('--allowlist');
  const ipAllowlist = allowFile
    ? (await import('node:fs')).readFileSync(allowFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : [];
  const defaultSource = after('--default-source') ? Number(after('--default-source')) : null;
  plan(`issue OAuth client "${CLIENT.name}" in ws ${workspaceId}: trustedIntake=true, ${CLIENT.scopes.length} scopes, allowlist ${ipAllowlist.length} entries, defaultSource ${defaultSource ?? 'none'}`);
  if (!APPLY) return;
  const c = await oauthClientService.create(workspaceId, { ...CLIENT, ipAllowlist, defaultSource }, { email: 'simorgh-provision' });
  console.log('\n──────── HAND OVER SECURELY — SHOWN ONCE ────────');
  console.log('  token_url:     https://api.ticketpulse.bgcsaas.com/api/v1/oauth/token');
  console.log(`  client_id:     ${c.clientId}`);
  console.log(`  client_secret: ${c.clientSecret}`);
  console.log('──────────────────────────────────────────────────\n');
}

// C2 policy (plan Phase 1.2 + 1.5). Two halves: a veto so no noise rule can
// ever close a security-agent ticket, and the ONE sanctioned auto-resolve —
// the agent's own structured benign verdict. Both idempotent by name.
const NEVER_NOISE = {
  name: 'Simorgh — never noise (security agent)',
  pattern: '.',
  senderPattern: '^simorgh@',
  mode: 'never_noise',
  category: 'custom',
  description: 'Security-agent tickets are never noise. Matches on the sender (simorgh@…) — every noise verdict on such a ticket is vetoed, whatever the text says.',
};
async function installPolicy(workspaceId, enable) {
  const { default: noiseRuleService } = await import('../src/services/noiseRuleService.js');
  const rule = await prisma.noiseRule.findFirst({ where: { workspaceId, name: NEVER_NOISE.name } });
  if (rule) log(`never_noise rule #${rule.id} exists (enabled=${rule.isEnabled})`);
  else {
    plan(`create never_noise rule "${NEVER_NOISE.name}" sender ^simorgh@ in ws ${workspaceId}`);
    if (APPLY) {
      const created = await noiseRuleService.createRule({ ...NEVER_NOISE, workspaceId });
      log(`created never_noise rule #${created.id}`);
    }
  }

  const { WORKFLOW_TEMPLATES } = await import('../src/services/notificationWorkflowDefinition.js');
  const repo = await import('../src/services/notificationWorkflowRepository.js');
  const template = WORKFLOW_TEMPLATES.find((t) => t.key === 'simorgh_resolve_benign');
  if (!template) throw new Error('template simorgh_resolve_benign missing');
  const actor = { email: 'simorgh-provision' };
  let wf = await prisma.notificationWorkflow.findFirst({
    where: { workspaceId, triggerType: template.triggerType, name: template.name, archivedAt: null },
  });
  if (wf) log(`workflow #${wf.id} "${wf.name}" exists (published v${wf.publishedVersion}, enabled=${wf.isEnabled})`);
  else {
    plan(`install workflow template "${template.name}" in ws ${workspaceId} (additive, disabled)`);
    if (APPLY) {
      wf = await repo.createWorkflowVariant(workspaceId, {
        triggerType: template.triggerType,
        name: template.name,
        description: template.description,
        definition: template.build(),
        routingMode: 'additive',
      }, actor);
      log(`installed workflow #${wf.id}`);
    }
  }
  // Definition drift: whenever the installed nodes/edges differ from the
  // current template (positions ignored), refresh the draft and — if it was
  // published — publish the next version with the same enabled state.
  // JSONB storage reorders object keys, so compare with keys sorted.
  const canon = (v) => (Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  const strip = (def) => JSON.stringify(canon({
    nodes: (def?.nodes || []).map(({ position, ...n }) => n), // eslint-disable-line no-unused-vars
    edges: def?.edges || [],
  }));
  const current = template.build();
  if (wf && !wf.publishedVersion && strip(wf.draftDefinition) !== strip(current)) {
    plan(`refresh draft of workflow #${wf.id} to the current template`);
    if (APPLY) wf = await repo.saveDraft(workspaceId, wf.id, { definition: current }, actor);
  }
  if (wf?.publishedVersion && strip(wf.publishedDefinition) !== strip(current)) {
    plan(`upgrade workflow #${wf.id} to the current template and publish v${wf.publishedVersion + 1}, enabled=${wf.isEnabled}`);
    if (APPLY) {
      await repo.saveDraft(workspaceId, wf.id, { definition: current }, actor);
      await repo.publishWorkflow(workspaceId, wf.id, { enabled: wf.isEnabled, changeNote: 'simorgh-provision: template refresh' }, actor);
      wf = await prisma.notificationWorkflow.findUnique({ where: { id: wf.id } });
    }
  }
  if (!enable) { log('workflow stays DISABLED (add --enable after the joint acceptance)'); return; }
  if (!wf) { log('(dry run: enable is planned after install)'); return; }
  if (!wf.publishedVersion) {
    plan(`publish workflow #${wf.id} v1 (enabled=false)`);
    if (APPLY) {
      await repo.publishWorkflow(workspaceId, wf.id, { enabled: false, changeNote: 'Installed by simorgh-provision' }, actor);
      wf = await prisma.notificationWorkflow.findUnique({ where: { id: wf.id } });
    }
  }
  if (!wf.isEnabled) {
    plan(`enable workflow #${wf.id}`);
    if (APPLY) await repo.setWorkflowEnabled(workspaceId, wf.id, true, actor);
  } else log(`workflow #${wf.id} already enabled`);
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
      await ensureTicketTypes(ws.id);
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
  if (has('--unattended')) {
    const email = String(after('--unattended') || '').trim().toLowerCase();
    if (!email) throw new Error('--unattended needs <email>');
    console.log(`\n[unattended ${email}]`);
    const r = await prisma.requester.findFirst({ where: { email } });
    if (!r) throw new Error(`no requester ${email}`);
    if (r.unattended) log(`requester #${r.id} already unattended`);
    else {
      plan(`mark requester #${r.id} "${r.name}" unattended — no requester-facing mail, ever`);
      if (APPLY) await prisma.requester.update({ where: { id: r.id }, data: { unattended: true } });
    }
  }
  if (has('--policy')) {
    const ws = Number(after('--workspace'));
    if (!ws) throw new Error('--policy needs --workspace <id>');
    console.log(`\n[policy ws ${ws}]`);
    await installPolicy(ws, has('--enable'));
  }
  if (has('--webhook')) {
    const ws = Number(after('--workspace')); const url = after('--url');
    if (!ws || !url) throw new Error('--webhook needs --workspace <id> --url <https://…>');
    console.log(`\n[webhook ws ${ws}]`);
    await subscribeWebhook(ws, url);
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
