// Phase 0 — freeze ws2 automation, snapshot everything, verify AI + FS access.
//   node scripts/ap-reorg/p0-freeze.mjs           (dry-run: snapshots + probes only)
//   node scripts/ap-reorg/p0-freeze.mjs --apply   (also pauses ws2 automation)
import { WS, APPLY, mode, snap } from './lib.mjs';

const { default: prisma } = await import('../../src/services/prisma.js');
const { default: settingsRepository } = await import('../../src/services/settingsRepository.js');
const { createFreshServiceClient } = await import('../../src/integrations/freshservice.js');

console.log(`Phase 0 (${mode()}) — freeze + snapshot + probes\n`);

// ---- 1. snapshots (abort the whole run if any fails) ----
const cats = await prisma.$queryRawUnsafe(
  `SELECT id, name, description, parent_id, is_active, source, sort_order
   FROM competency_categories WHERE workspace_id=$1 ORDER BY id`, WS,
);
snap('p0-categories', cats);

const comps = await prisma.$queryRawUnsafe(
  `SELECT tc.id, tc.technician_id, tc.competency_category_id, tc.proficiency_level, t.name AS tech_name, t.email AS tech_email
   FROM technician_competencies tc JOIN technicians t ON t.id=tc.technician_id
   WHERE tc.workspace_id=$1 ORDER BY tc.id`, WS,
);
snap('p0-competencies', comps);

const tickets = await prisma.$queryRawUnsafe(
  `SELECT id, freshservice_ticket_id, internal_category_id, internal_subcategory_id, status
   FROM tickets WHERE workspace_id=$1 ORDER BY id`, WS,
);
snap('p0-tickets', tickets);

const cfg = await prisma.$queryRawUnsafe(
  'SELECT * FROM assignment_configs WHERE workspace_id=$1', WS,
);
snap('p0-assignment-config', cfg);

// ---- 2. FS probe + record snapshots ----
const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(WS);
console.log(`FS config: domain=${fsConfig.domain} workspaceId=${fsConfig.workspaceId}`);
const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, { priority: 'low', source: 'ap-reorg-p0' });
const objects = await client.listCustomObjects({ workspace_id: fsConfig.workspaceId });
const skillObj = objects.find((o) => o.title === 'Ticket Pulse Skills');
const subObj = objects.find((o) => o.title === 'Ticket Pulse Subskills');
if (!skillObj || !subObj) throw new Error(`FS custom objects missing: skills=${!!skillObj} subskills=${!!subObj}`);
const [skillRecs, subRecs] = [await client.listCustomObjectRecords(skillObj.id), await client.listCustomObjectRecords(subObj.id)];
console.log(`FS objects: skills#${skillObj.id} (${skillRecs.length} records), subskills#${subObj.id} (${subRecs.length} records)`);
snap('p0-fs-skill-records', skillRecs);
snap('p0-fs-subskill-records', subRecs);
snap('p0-fs-objects', { skillObjectId: skillObj.id, subskillObjectId: subObj.id });

// ---- 3. Anthropic probe ----
const { default: anthropicProvider } = await import('../../src/services/aiProviders/anthropicProvider.js');
const probe = await anthropicProvider.sendJson({
  systemPrompt: 'Reply with JSON only.',
  userMessage: 'Return {"ok": true}',
  model: 'claude-haiku-4-5-20251001',
  maxTokens: 50,
  temperature: 0,
});
console.log(`Anthropic probe: ok=${probe?.parsed?.ok === true}`);
if (probe?.parsed?.ok !== true) throw new Error('Anthropic probe failed');

// ---- 4. freeze ----
const cur = cfg[0];
console.log(`current config: poll_for_unassigned=${cur.poll_for_unassigned} dry_run_mode=${cur.dry_run_mode} auto_assign=${cur.auto_assign}`);
if (APPLY) {
  await prisma.$executeRawUnsafe(
    'UPDATE assignment_configs SET poll_for_unassigned=false, dry_run_mode=true, updated_at=now() WHERE workspace_id=$1', WS,
  );
  console.log('FROZEN: poll_for_unassigned=false, dry_run_mode=true (restore in Phase 7 from p0-assignment-config.json)');
} else {
  console.log('(dry-run: would set poll_for_unassigned=false, dry_run_mode=true)');
}

console.log('\nPhase 0 OK');
await prisma.$disconnect();
