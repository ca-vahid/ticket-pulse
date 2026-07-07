// Read-only discovery for the AP category reorg plan (ws2, PROD).
// Prints current taxonomy, ticket/competency counts, config + FS mapping state.
//   DATABASE_URL=<prod> node scripts/ap-recat-discovery.mjs
import prisma from '../src/services/prisma.js';

const WS = 2;
const q = (sql, ...args) => prisma.$queryRawUnsafe(sql, ...args);

const ws = await q('SELECT id, name FROM workspaces WHERE id=$1', WS);
console.log('workspace:', JSON.stringify(ws[0]));

const cats = await q(`SELECT id, name, parent_id, is_active, source, description IS NOT NULL AS has_desc
  FROM competency_categories WHERE workspace_id=$1 ORDER BY parent_id NULLS FIRST, sort_order, id`, WS);
const tops = cats.filter((c) => c.parent_id === null);
const subs = cats.filter((c) => c.parent_id !== null);
console.log(`categories: ${cats.length} total | tops: ${tops.length} (${tops.filter((c) => c.is_active).length} active) | subs: ${subs.length} (${subs.filter((c) => c.is_active).length} active)`);
console.log('sources:', JSON.stringify([...new Set(cats.map((c) => c.source))]));
console.log('--- ACTIVE TOP CATEGORIES ---');
for (const c of tops.filter((c) => c.is_active)) console.log(`  #${c.id} ${c.name}`);

const tk = await q(`SELECT
  count(*)::int AS total,
  count(*) FILTER (WHERE internal_category_id IS NOT NULL)::int AS categorized,
  count(*) FILTER (WHERE internal_subcategory_id IS NOT NULL)::int AS subcategorized,
  count(*) FILTER (WHERE created_at > now() - interval '180 days')::int AS last180,
  count(*) FILTER (WHERE internal_category_id IS NOT NULL AND created_at > now() - interval '180 days')::int AS cat180,
  count(*) FILTER (WHERE status IN ('Open','Pending'))::int AS open_pending,
  min(created_at)::date::text AS oldest,
  count(*) FILTER (WHERE origin='ticketpulse')::int AS tp_born
  FROM tickets WHERE workspace_id=$1`, WS);
console.log('tickets:', JSON.stringify(tk[0]));

const byCat = await q(`SELECT c.name, t.internal_category_id AS id, count(*)::int AS n
  FROM tickets t JOIN competency_categories c ON c.id=t.internal_category_id
  WHERE t.workspace_id=$1 GROUP BY 1,2 ORDER BY n DESC`, WS);
console.log('--- TICKETS BY CURRENT CATEGORY ---');
for (const r of byCat) console.log(`  ${String(r.n).padStart(5)}  #${r.id} ${r.name}`);

const comp = await q(`SELECT count(*)::int AS competencies, count(DISTINCT technician_id)::int AS techs
  FROM technician_competencies WHERE workspace_id=$1`, WS);
console.log('competencies:', JSON.stringify(comp[0]));

const cfg = await q(`SELECT is_enabled, auto_assign, dry_run_mode, poll_for_unassigned, email_polling_enabled
  FROM assignment_configs WHERE workspace_id=$1`, WS);
console.log('assignment_config:', JSON.stringify(cfg[0] || null));

const wsRow = await q('SELECT tp_skill_custom_field, tp_subskill_custom_field FROM workspaces WHERE id=$1', WS);
console.log('FS field mapping:', JSON.stringify(wsRow[0]));

// surfaces that reference category ids
for (const [label, sql] of [
  ['category_group_maps (ws2)', `SELECT count(*)::int AS n FROM category_group_maps WHERE workspace_id=${WS}`],
  ['quick_notes (ws2, category-scoped)', `SELECT count(*)::int AS n FROM quick_notes WHERE workspace_id=${WS} AND category_id IS NOT NULL`],
  ['workflows mentioning category (ws2)', `SELECT count(*)::int AS n FROM notification_workflows WHERE workspace_id=${WS} AND definition::text ILIKE '%categor%'`],
]) {
  try {
    const r = await q(sql);
    console.log(`${label}:`, r[0].n);
  } catch (e) { console.log(`${label}: n/a (${e.message.split('\n')[0].slice(0, 80)})`); }
}
await prisma.$disconnect();
