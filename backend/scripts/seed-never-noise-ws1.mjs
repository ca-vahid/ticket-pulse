#!/usr/bin/env node
/**
 * NT-3 (MEGA-0831 Phase NT): seed the ws1 "never noise" veto rule.
 *
 * Creates (idempotently, by name) a mode='never_noise' NoiseRule for
 * workspace 1 that deterministically blocks the AI pipeline from ever
 * auto-dismissing physical package / shipping-room tickets as noise —
 * regardless of prompt or model (the QA #239931 class of ticket).
 *
 * If the rule already exists it is updated in place when its pattern, mode,
 * or enabled flag drifted; otherwise nothing is changed.
 *
 * Usage:  node scripts/seed-never-noise-ws1.mjs [--apply] [--prod]
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

const WORKSPACE_ID = 1;
const RULE = {
  name: 'Physical packages & shipping',
  pattern: '(package|shipping room|mailroom|courier|FedEx|UPS|Purolator|DHL|equipment pickup)',
  description:
    'Hard veto: physical package, shipping-room, mailroom, and courier tickets are real requests '
    + 'that need a human — the AI pipeline must never auto-dismiss them as noise.',
  category: 'operations',
  mode: 'never_noise',
};

// Sanity: the pattern must compile the same way noiseRuleService does (case-insensitive).
const regex = new RegExp(RULE.pattern, 'i');
for (const probe of ['FedEx label request', 'Package waiting in the shipping room', 'Printer is jammed']) {
  console.log(`  pattern test: "${probe}" → ${regex.test(probe) ? 'MATCH' : 'no match'}`);
}

const ws = await prisma.workspace.findUnique({ where: { id: WORKSPACE_ID }, select: { id: true, name: true, slug: true } });
if (!ws) throw new Error(`Workspace ${WORKSPACE_ID} not found`);
console.log(`workspace ${ws.id}: ${ws.name} (${ws.slug})`);

const existing = await prisma.noiseRule.findFirst({
  where: { workspaceId: WORKSPACE_ID, name: RULE.name },
});

if (!existing) {
  console.log(`rule "${RULE.name}" does not exist — would CREATE (mode=${RULE.mode})`);
} else {
  const drift = [];
  if (existing.pattern !== RULE.pattern) drift.push(`pattern (${existing.pattern} → ${RULE.pattern})`);
  if (existing.mode !== RULE.mode) drift.push(`mode (${existing.mode} → ${RULE.mode})`);
  if (!existing.isEnabled) drift.push('isEnabled (false → true)');
  if (drift.length === 0) {
    console.log(`rule "${RULE.name}" already exists as #${existing.id} and is up to date — nothing to do`);
  } else {
    console.log(`rule "${RULE.name}" exists as #${existing.id} but drifted — would UPDATE: ${drift.join(', ')}`);
  }
}

if (!APPLY) { console.log('\nDRY-RUN — nothing changed. Re-run with --apply.'); await prisma.$disconnect(); process.exit(0); }

if (!existing) {
  const created = await prisma.noiseRule.create({
    data: {
      name: RULE.name,
      pattern: RULE.pattern,
      description: RULE.description,
      category: RULE.category,
      isEnabled: true,
      mode: RULE.mode,
      workspaceId: WORKSPACE_ID,
    },
  });
  console.log(`APPLIED: created never_noise rule #${created.id} "${created.name}" for workspace ${WORKSPACE_ID}`);
} else if (existing.pattern !== RULE.pattern || existing.mode !== RULE.mode || !existing.isEnabled) {
  const updated = await prisma.noiseRule.update({
    where: { id: existing.id },
    data: { pattern: RULE.pattern, mode: RULE.mode, isEnabled: true, description: RULE.description },
  });
  console.log(`APPLIED: updated rule #${updated.id} "${updated.name}" (mode=${updated.mode}, enabled=${updated.isEnabled})`);
} else {
  console.log('APPLIED: no changes needed');
}

// Note: the runtime noise-rule cache (noiseRuleService, 60s TTL) picks this up
// within a minute on running servers — no restart needed.
await prisma.$disconnect();
