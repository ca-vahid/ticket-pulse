/**
 * Prod repair (QA 08-06 #6 — Susan's field cards not pinning, ws5).
 *
 * The workflow editor used to seed a DEMO routing rule
 * (requester.regionKey equals 'AU-BRISBANE') into the Routing tab for any
 * rule-less workflow; saving the tab silently attached that never-matching
 * rule and the engine suppressed the workflow before creating a run row
 * (routing_rule_not_matched). This script finds ws5 notification workflows
 * whose routingRule is EXACTLY that demo shape and repairs them:
 *   routing_rule -> NULL, routing_mode -> 'additive'
 * so they run again (additive + no rule = always runs alongside).
 *
 * DRY RUN by default — prints before/after and changes nothing.
 * Run from backend/:
 *   node scripts/fix-ws5-intake-routing.mjs           (dry run)
 *   APPLY=1 node scripts/fix-ws5-intake-routing.mjs   (apply)
 *
 * Prod connection comes from backend/scripts/.env.prod (PROD_DATABASE_URL).
 * Raw SQL via pg on purpose: prod's schema may trail dev's Prisma models.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ID = 5;
const APPLY = process.env.APPLY === '1';

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

const env = loadEnv(path.join(__dirname, '.env.prod'));
const PROD_URL = env.PROD_DATABASE_URL || process.env.PROD_DATABASE_URL;
if (!PROD_URL) {
  console.error('No PROD_DATABASE_URL in backend/scripts/.env.prod (or the environment).');
  process.exit(1);
}

/** Is this rule EXACTLY the seeded AU-BRISBANE demo rule? */
function isDemoRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
  const keys = Object.keys(rule);
  if (keys.length !== 1 || keys[0] !== '==') return false;
  const args = rule['=='];
  if (!Array.isArray(args) || args.length !== 2) return false;
  const [variable, value] = args;
  return Boolean(variable)
    && typeof variable === 'object'
    && !Array.isArray(variable)
    && Object.keys(variable).length === 1
    && variable.var === 'requester.regionKey'
    && value === 'AU-BRISBANE';
}

const pool = new pg.Pool({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false }, max: 2 });

try {
  const { rows } = await pool.query(
    `SELECT id, key, name, trigger_type, routing_mode, routing_priority, routing_rule,
            is_default_variant, is_enabled, archived_at
       FROM notification_workflows
      WHERE workspace_id = $1
      ORDER BY id`,
    [WORKSPACE_ID],
  );
  console.log(`ws${WORKSPACE_ID}: ${rows.length} notification workflows total`);

  const targets = rows.filter((row) => !row.is_default_variant && isDemoRule(row.routing_rule));
  if (targets.length === 0) {
    console.log('No workflows carry the AU-BRISBANE demo rule — nothing to repair.');
  }

  for (const row of targets) {
    console.log('---');
    console.log(`#${row.id} "${row.name}" (key=${row.key}, trigger=${row.trigger_type}, enabled=${row.is_enabled}, archived=${row.archived_at ? 'yes' : 'no'})`);
    console.log(`  BEFORE: routing_mode=${row.routing_mode} routing_rule=${JSON.stringify(row.routing_rule)}`);
    console.log("  AFTER:  routing_mode=additive routing_rule=null");
    if (APPLY) {
      await pool.query(
        `UPDATE notification_workflows
            SET routing_rule = NULL,
                routing_mode = 'additive',
                updated_at = now()
          WHERE id = $1 AND workspace_id = $2`,
        [row.id, WORKSPACE_ID],
      );
      console.log('  APPLIED');
    }
  }

  console.log('---');
  console.log(APPLY
    ? `Applied: ${targets.length} workflow(s) repaired.`
    : `DRY RUN: ${targets.length} workflow(s) would be repaired. Re-run with APPLY=1 to apply.`);
} finally {
  await pool.end();
}
