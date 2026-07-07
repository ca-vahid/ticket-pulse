// Phase 7b — mirror the AP reorg outcome from PROD to DEV (ws2):
//   1. taxonomy: insert the 11 new categories in dev, retire the rest
//   2. competencies: replace dev ws2 competencies with prod's (techs are
//      id-aligned across envs; categories map by name)
//   3. tickets: copy internal_category_id from prod by freshservice_ticket_id
//      (name-mapped), null all subcategories
//   node scripts/ap-reorg/p7b-mirror-dev.mjs           (dry-run)
//   node scripts/ap-reorg/p7b-mirror-dev.mjs --apply
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { WS, SOURCE, APPLY, mode, NEW_CATEGORIES } from './lib.mjs';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dotenvVal = (file, key) => (fs.readFileSync(file, 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm')) || [])[1]?.trim().replace(/\r$/, '').replace(/^['"]|['"]$/g, '');
const PROD_URL = dotenvVal(path.resolve(__dirname, '../.env.prod'), 'PROD_DATABASE_URL');
const DEV_URL = dotenvVal(path.resolve(__dirname, '../../.env'), 'DATABASE_URL');
if (!PROD_URL || !DEV_URL) throw new Error('missing prod or dev DATABASE_URL');
const prod = new Pool({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false }, max: 4 });
const dev = new Pool({ connectionString: DEV_URL, max: 4 });
const q = async (p, s, a = []) => (await p.query(s, a)).rows;

console.log(`Phase 7b (${mode()}) — mirror reorg to dev\n`);

// ---- 1. taxonomy in dev ----
const devCats = await q(dev, 'SELECT id, name, parent_id, is_active FROM competency_categories WHERE workspace_id=$1', [WS]);
const devByName = new Map(devCats.map((c) => [c.name.trim().toLowerCase(), c]));
const devNewIds = new Map();
for (const [i, cat] of NEW_CATEGORIES.entries()) {
  const hit = devByName.get(cat.name.trim().toLowerCase());
  if (hit && hit.parent_id === null) {
    devNewIds.set(cat.name, hit.id);
    if (APPLY) await q(dev, 'UPDATE competency_categories SET is_active=true, description=$1, sort_order=$2, source=$3 WHERE id=$4', [cat.description, i + 1, SOURCE, hit.id]);
  } else if (APPLY) {
    const r = await q(dev, `INSERT INTO competency_categories (workspace_id, name, description, parent_id, is_active, source, sort_order, created_at, updated_at)
      VALUES ($1,$2,$3,NULL,true,$4,$5,now(),now()) RETURNING id`, [WS, cat.name, cat.description, SOURCE, i + 1]);
    devNewIds.set(cat.name, r[0].id);
  } else devNewIds.set(cat.name, null);
}
if (APPLY) {
  const keep = [...devNewIds.values()];
  const retired = await dev.query(
    `UPDATE competency_categories SET is_active=false WHERE workspace_id=$1 AND is_active=true AND id NOT IN (${keep.join(',')})`, [WS],
  );
  console.log(`dev taxonomy: 11 active, retired ${retired.rowCount}`);
} else console.log('dev taxonomy: would ensure 11 + retire the rest');

// ---- 2. competencies ----
const prodComps = await q(prod, `SELECT tc.technician_id, c.name AS cat_name, tc.proficiency_level
  FROM technician_competencies tc JOIN competency_categories c ON c.id=tc.competency_category_id
  WHERE tc.workspace_id=$1`, [WS]);
console.log(`prod competencies: ${prodComps.length}`);
if (APPLY) {
  await q(dev, 'DELETE FROM technician_competencies WHERE workspace_id=$1', [WS]);
  let ok = 0; let skipped = 0;
  for (const c of prodComps) {
    const catId = devNewIds.get(c.cat_name);
    if (!catId) { skipped += 1; continue; }
    // technicians are id-aligned, but guard against dev-missing techs
    try {
      await q(dev, `INSERT INTO technician_competencies (technician_id, workspace_id, competency_category_id, proficiency_level, created_at, updated_at)
        VALUES ($1,$2,$3,$4,now(),now())`, [c.technician_id, WS, catId, c.proficiency_level]);
      ok += 1;
    } catch { skipped += 1; }
  }
  console.log(`dev competencies: ${ok} written, ${skipped} skipped`);
}

// ---- 3. ticket categories by fsid ----
const prodTickets = await q(prod, `SELECT t.freshservice_ticket_id AS fsid, c.name AS cat_name
  FROM tickets t JOIN competency_categories c ON c.id=t.internal_category_id
  WHERE t.workspace_id=$1 AND t.freshservice_ticket_id IS NOT NULL`, [WS]);
console.log(`prod categorized tickets: ${prodTickets.length}`);
if (APPLY) {
  let moved = 0;
  for (const name of new Set(prodTickets.map((t) => t.cat_name))) {
    const catId = devNewIds.get(name);
    if (!catId) continue;
    const fsids = prodTickets.filter((t) => t.cat_name === name).map((t) => t.fsid);
    const r = await dev.query(
      `UPDATE tickets SET internal_category_id=$1, internal_subcategory_id=NULL, updated_at=now()
       WHERE workspace_id=$2 AND freshservice_ticket_id = ANY($3::bigint[])`, [catId, WS, fsids],
    );
    moved += r.rowCount;
  }
  const nulled = await dev.query('UPDATE tickets SET internal_subcategory_id=NULL WHERE workspace_id=$1 AND internal_subcategory_id IS NOT NULL', [WS]);
  console.log(`dev tickets: ${moved} categorized, subcategories nulled on ${nulled.rowCount} more`);
}

console.log('\nPhase 7b OK');
await prod.end(); await dev.end();
