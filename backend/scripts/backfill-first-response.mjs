/**
 * First-response history backfill (gap plan 2, Phase 0). Fetches tickets
 * updated in the last N days from FreshService WITH stats and sets
 * first_public_agent_reply_at where it is NULL — set-only, one column,
 * read-only against FreshService.
 *
 * Run from backend/:  PROD=1 DAYS=45 node scripts/backfill-first-response.mjs
 * (PROD unset = dev DB + dev-configured FS.)
 */
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAYS = Math.min(Number(process.env.DAYS) || 45, 120);

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const dbUrl = process.env.PROD
  ? loadEnv(path.resolve(__dirname, '.env.prod')).PROD_DATABASE_URL
  : loadEnv(path.resolve(__dirname, '../.env')).DATABASE_URL;
if (!dbUrl) { console.error('No database URL'); process.exit(1); }
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

const settings = await prisma.$queryRawUnsafe(
  "SELECT key, value FROM app_settings WHERE key IN ('freshservice_domain','freshservice_api_key')",
);
const map = Object.fromEntries(settings.map((r) => [r.key, r.value]));
const auth = Buffer.from(`${map.freshservice_api_key}:X`).toString('base64');
const domain = map.freshservice_domain.includes('.') ? map.freshservice_domain : `${map.freshservice_domain}.freshservice.com`;

const workspaces = await prisma.$queryRawUnsafe(
  'SELECT id, freshservice_workspace_id::text AS fs_ws FROM workspaces ORDER BY id',
);
const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString();
let scanned = 0;
let updated = 0;

for (const ws of workspaces) {
  for (let page = 1; page <= 100; page++) {
    const url = `https://${domain}/api/v2/tickets?updated_since=${encodeURIComponent(since)}&per_page=100&page=${page}&include=stats`
      + (ws.fs_ws ? `&workspace_id=${ws.fs_ws}` : '');
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 30);
      console.log(`  rate limited — waiting ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      page -= 1;
      continue;
    }
    if (!res.ok) { console.log(`  ws${ws.id} page ${page}: HTTP ${res.status} — stopping this workspace`); break; }
    const tickets = (await res.json()).tickets || [];
    scanned += tickets.length;
    for (const t of tickets) {
      const fr = t.stats?.first_responded_at;
      if (!fr) continue;
      const n = await prisma.$executeRawUnsafe(
        `UPDATE tickets SET first_public_agent_reply_at = $1
         WHERE freshservice_ticket_id = $2::bigint AND first_public_agent_reply_at IS NULL`,
        new Date(fr), t.id,
      );
      updated += n;
    }
    process.stdout.write(`\r  ws${ws.id} page ${page}: scanned ${scanned}, updated ${updated}   `);
    if (tickets.length < 100) break;
    await new Promise((r) => setTimeout(r, 700)); // stay well under the FS rate limit
  }
  console.log('');
}

const coverage = await prisma.$queryRawUnsafe(`
  SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE first_public_agent_reply_at IS NOT NULL)::int AS with_fr
  FROM tickets WHERE created_at > NOW() - INTERVAL '30 days'`);
console.log(`\nDone: scanned ${scanned}, updated ${updated}. 30d coverage now: ${coverage[0].with_fr}/${coverage[0].total}`);
await prisma.$disconnect();
