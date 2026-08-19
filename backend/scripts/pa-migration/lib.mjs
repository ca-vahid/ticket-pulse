// Shared plumbing for the Project Accounting (PA) category migration scripts.
// Cloned from scripts/ap-reorg/lib.mjs (the proven ws2 playbook) with three
// deliberate changes:
//   1. TARGET SELECTION — scripts run against the LOCAL DEV DB by default.
//      Only `--prod` (or PA_TARGET=prod) loads backend/scripts/.env.prod and
//      forces DATABASE_URL to PROD_DATABASE_URL. Dev rehearsal first, always.
//   2. WS is NOT hardcoded — it is resolved at runtime by workspace-name
//      lookup ('Project Accounting') with an expected-id assert (default 5,
//      override with PA_EXPECT_WS for dev rehearsal workspaces).
//   3. No FS phases — ws5 stays TP-only (no FS custom objects, no category
//      write-back). p3/p5 from the AP playbook intentionally do not exist.
//
// Import lib FIRST in every phase script — it wires DATABASE_URL BEFORE
// prisma is loaded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SOURCE = 'pa_migration_2026_08';
export const WORKSPACE_NAME = 'Project Accounting';
export const EXPECTED_WS_ID = Number(process.env.PA_EXPECT_WS || 5);

export const PROD = process.argv.includes('--prod') || process.env.PA_TARGET === 'prod';
export const REPORT_DIR = path.resolve(__dirname, `../../../reports/pa-migration${PROD ? '' : '-dev'}`);
fs.mkdirSync(REPORT_DIR, { recursive: true });

// ---- env loading ----
const dotenv = (file) => {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
      }),
  );
};
// Local .env always loads first (Anthropic key, dev DATABASE_URL, …) without
// clobbering anything already exported in the shell.
const localEnv = dotenv(path.resolve(__dirname, '../../.env'));
for (const [k, v] of Object.entries(localEnv)) if (!(k in process.env)) process.env[k] = v;

if (PROD) {
  const prodEnv = dotenv(path.resolve(__dirname, '../.env.prod'));
  const prodUrl = prodEnv.PROD_DATABASE_URL;
  if (!prodUrl) throw new Error('--prod requested but PROD_DATABASE_URL missing from backend/scripts/.env.prod');
  process.env.DATABASE_URL = prodUrl;
  console.log('TARGET: PROD database');
} else {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing (backend/.env) — is the dev environment set up?');
  console.log('TARGET: dev database (pass --prod for the production run)');
}

export const APPLY = process.argv.includes('--apply');
export const mode = () => (APPLY ? 'APPLY' : 'DRY-RUN');

// ---- workspace resolution (never trust a hardcoded id) ----
export async function resolveWorkspace(prisma) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT id, name FROM workspaces WHERE name ILIKE $1 ORDER BY id',
    `%${WORKSPACE_NAME}%`,
  );
  if (rows.length !== 1) {
    throw new Error(
      `Workspace lookup for "${WORKSPACE_NAME}" matched ${rows.length} rows `
      + `(${rows.map((r) => `#${r.id} ${r.name}`).join(', ') || 'none'}). `
      + 'Refusing to guess — fix the name filter or the data first.',
    );
  }
  const ws = { id: Number(rows[0].id), name: rows[0].name };
  if (ws.id !== EXPECTED_WS_ID) {
    throw new Error(
      `Workspace "${ws.name}" resolved to id ${ws.id} but expected ${EXPECTED_WS_ID}. `
      + 'If that is genuinely correct (e.g. a dev rehearsal workspace), re-run with '
      + `PA_EXPECT_WS=${ws.id}.`,
    );
  }
  console.log(`workspace: #${ws.id} "${ws.name}"\n`);
  return ws;
}

// ---- snapshots / reports ----
export const snap = (name, data) => {
  const file = path.join(REPORT_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  console.log(`  snapshot: ${path.basename(file)} (${Array.isArray(data) ? data.length : 'obj'})`);
  return file;
};
export const readSnap = (name) => JSON.parse(fs.readFileSync(path.join(REPORT_DIR, `${name}.json`), 'utf8'));
export const writeReport = (name, text) => {
  fs.writeFileSync(path.join(REPORT_DIR, name), text);
  console.log(`  report: ${name}`);
};

// ---- the PA taxonomy ----
// Default top-level set: the two categories QA named (08-17 #6 / 08-18 #2)
// plus a catch-all. Flat like the AP reorg — tops only, no subcategories.
//
// APPENDING MORE: run derive-pa-taxonomy.mjs (LLM proposal from real ws5
// ticket content), have the orchestrator/business owner review the output,
// then either paste approved entries below OR drop them into
// scripts/pa-migration/extra-categories.json as
//   [{ "name": "...", "description": "..." }, ...]
// — p1 merges that file automatically (name-deduped, defaults first).
export const DEFAULT_CATEGORIES = [
  { name: 'Project Setup', description: 'Requests to create or configure projects: new project numbers, project codes, phases/tasks, budgets, cost codes, and changes to existing project setup.' },
  { name: 'Proposal Setup', description: 'Requests to set up proposals, bids, and pursuits: proposal numbers, opportunity records, pre-award budgets, and proposal-to-project conversions.' },
  { name: 'General / Other', description: 'Project-accounting requests that do not fit a dedicated category yet: general questions, notifications, and uncategorizable correspondence.' },
];

export function loadCategories() {
  const extraFile = path.resolve(__dirname, 'extra-categories.json');
  let extras = [];
  if (fs.existsSync(extraFile)) {
    extras = JSON.parse(fs.readFileSync(extraFile, 'utf8'));
    if (!Array.isArray(extras)) throw new Error('extra-categories.json must be a JSON array of {name, description}');
  }
  const seen = new Set();
  const merged = [];
  for (const cat of [...DEFAULT_CATEGORIES, ...extras]) {
    const key = String(cat.name || '').trim().toLowerCase();
    if (!key) throw new Error('Category with empty name in taxonomy list');
    if (!cat.description) throw new Error(`Category "${cat.name}" is missing a description`);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ name: cat.name.trim(), description: cat.description.trim() });
  }
  if (extras.length) console.log(`taxonomy: ${DEFAULT_CATEGORIES.length} defaults + ${extras.length} from extra-categories.json → ${merged.length} unique`);
  return merged;
}

// ---- p4 keyword rules: legacy ticketCategory string → new category name ----
// Only CONFIDENT deterministic moves belong here; everything unmatched stays
// uncategorized for the Reclassify UI (canonical-workspace batch tool).
// Each rule: { rule: human label, pattern: RegExp tested against the legacy
// ticketCategory STRING (not free text), target: new category name }.
export const RECAT_RULES = [
  { rule: 'project-setup keywords', pattern: /project\s*(set\s*-?\s*up|creation|number|code|opening|open)|new\s+project|cost\s*code|charge\s*code|wbs/i, target: 'Project Setup' },
  { rule: 'proposal-setup keywords', pattern: /proposal|bid\b|rfp|pursuit|opportunit/i, target: 'Proposal Setup' },
  { rule: 'general/noise keywords', pattern: /general|other|misc|spam|noise|newsletter|notification/i, target: 'General / Other' },
];

export const RANK = { basic: 1, intermediate: 2, advanced: 3, expert: 4 };
export const bestLevel = (a, b) => (RANK[a] >= RANK[b] ? a : b);
