#!/usr/bin/env node
/**
 * Auto-help P1 one-off: mark password / MFA / access / security playbooks as
 * `sensitive` (approve-only forever — they can never be switched to auto).
 * Run once in prod AFTER migration 20260926020000_auto_help_p1_core is applied.
 *
 * A playbook is picked when its NAME matches the sensitive pattern below, or
 * when it is named with --name "<exact name>" (repeatable). Playbooks already
 * marked are left alone; nothing is ever unmarked here.
 *
 * Usage:  node scripts/mark-sensitive-auto-help-playbooks.mjs [--apply] [--prod] [--workspace <id>] [--name "<exact name>"]...
 * Default = dry-run against the dev DB (DATABASE_URL). --prod loads
 * PROD_DATABASE_URL from scripts/.env.prod. One connection (connection_limit=1).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const PROD = args.includes('--prod');
const wsArg = args.indexOf('--workspace');
const WORKSPACE_ID = wsArg >= 0 ? Number(args[wsArg + 1]) : null;
const NAMES = args.flatMap((a, i) => (a === '--name' && args[i + 1] ? [args[i + 1]] : []));
const SENSITIVE_NAME = /\b(password|passcode|mfa|multi[- ]?factor|2fa|authenticator|sign[- ]?in|log[- ]?in|access|account|security|phishing|identity)\b/i;
const here = path.dirname(fileURLToPath(import.meta.url));

function withConnectionLimit(url) {
  if (!url) return url;
  if (/[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`;
}

if (PROD) {
  const env = fs.readFileSync(path.join(here, '.env.prod'), 'utf8');
  const m = env.match(/^PROD_DATABASE_URL=(.+)$/m);
  if (!m) throw new Error('PROD_DATABASE_URL missing from scripts/.env.prod');
  process.env.DATABASE_URL = m[1].trim().replace(/^"|"$/g, '');
}
if (WORKSPACE_ID !== null && !Number.isInteger(WORKSPACE_ID)) throw new Error('--workspace needs a number');
process.env.DATABASE_URL = withConnectionLimit(process.env.DATABASE_URL);
const prisma = new PrismaClient();
console.log(`TARGET: ${PROD ? 'PROD' : 'dev'} database — ${APPLY ? 'APPLY' : 'DRY-RUN'}${WORKSPACE_ID ? ` — workspace ${WORKSPACE_ID}` : ' — every workspace'}`);

async function main() {
  const col = await prisma.$queryRawUnsafe(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'auto_help_playbooks' AND column_name = 'sensitive'",
  );
  if (!col.length) {
    console.log('auto_help_playbooks.sensitive does not exist yet — apply migration 20260926020000_auto_help_p1_core first.');
    return;
  }
  const rows = await prisma.autoHelpPlaybook.findMany({
    where: WORKSPACE_ID ? { workspaceId: WORKSPACE_ID } : {},
    select: { id: true, workspaceId: true, name: true, mode: true, sensitive: true },
    orderBy: [{ workspaceId: 'asc' }, { id: 'asc' }],
  });
  const picked = rows.filter((r) => SENSITIVE_NAME.test(r.name) || NAMES.includes(r.name));
  if (!picked.length) {
    console.log('No playbook matches — nothing to do.');
    return;
  }
  let changed = 0;
  for (const r of picked) {
    const label = `ws${r.workspaceId} #${r.id} "${r.name}" (mode ${r.mode})`;
    if (r.sensitive) { console.log(`• ${label}: already sensitive`); continue; }
    if (r.mode === 'auto') console.log(`  ! ${label} is in auto mode — it will run as approve once marked`);
    if (!APPLY) { console.log(`• ${label}: would mark sensitive`); continue; }
    await prisma.autoHelpPlaybook.update({ where: { id: r.id }, data: { sensitive: true, updatedBy: 'mark-sensitive-auto-help-playbooks' } });
    changed += 1;
    console.log(`• ${label}: marked sensitive`);
  }
  console.log(APPLY ? `\nMarked ${changed}.` : '\nDry run — nothing written. Re-run with --apply.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
