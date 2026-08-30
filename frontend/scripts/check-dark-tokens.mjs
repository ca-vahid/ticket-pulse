/**
 * Dark-mode token guard (Phase DM-A, v3.8.02; widened in DM-B, v3.8.03).
 *
 * Swept surfaces use design tokens (bg-card, text-foreground,
 * text-muted-foreground, border-border, bg-muted …) instead of hardcoded
 * slate/gray/white utilities, so they theme for free. This grep-based check
 * keeps it that way: for every file under the swept paths it counts legacy
 * classes — `bg-white`, `text-slate-*`/`text-gray-*`, `border-slate-*`,
 * `bg-slate-50…400`, `divide-slate-*` (and `/alpha` variants) — and fails when
 * a file exceeds its baselined count. New files under a swept path start at a
 * baseline of 0. Exempt on purpose: `dark:`-prefixed twins (the sanctioned way
 * to tint an accent that has no token), low-alpha white overlays
 * (`bg-white/10…30` — highlights on coloured buttons/bands, same in both
 * themes) and dark chrome (`bg-slate-800/900/950` tooltips and hero bands,
 * which are dark in both themes).
 *
 * Since DM-B the swept set is the whole of src/ minus the light-only pages
 * (Login, WorkspacePicker, the public token pages, the Summit pages) and the
 * legacy TechnicianDetail.jsx. Baselined residue = dark-chrome text
 * (`text-slate-300` on a slate-900 band) that is correct as written.
 *
 *   node scripts/check-dark-tokens.mjs            # check (CI)
 *   node scripts/check-dark-tokens.mjs --update   # re-baseline after a sweep
 *   node scripts/dark-migrate.mjs <files>         # the codemod that does the bulk
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = join(ROOT, 'scripts', 'dark-tokens-baseline.json');

// Files or directories (relative to frontend/) that have been swept.
export const SWEPT_PATHS = ['src'];

// Light-only by design (they carry `.tp-light`), plus the legacy tech page.
export const EXCLUDED_PATHS = [
  'src/pages/Login.jsx',
  'src/pages/WorkspacePicker.jsx',
  'src/pages/PublicApprovalDecision.jsx',
  'src/pages/PublicTicketEscalation.jsx',
  'src/pages/PublicTicketFeedback.jsx',
  'src/pages/PublicTicketStatus.jsx',
  'src/pages/PublicTicketUrgency.jsx',
  'src/pages/SummitReport.jsx',
  'src/pages/SummitVote.jsx',
  'src/pages/TechnicianDetail.jsx',
];

const LEGACY = /^(bg-white|text-(?:slate|gray)-\d{2,3}|border(?:-[trblxyse])?-(?:slate|gray)-\d{2,3}|bg-(?:slate|gray)-(?:50|100|200|300|400)|divide-(?:slate|gray)-\d{2,3})(\/[\w.[\]]+)?$/;
// `bg-white/10…30` = overlay highlight on a coloured surface; not a light surface.
const LOW_ALPHA_WHITE = /^bg-white\/(?:[5-9]|[12]\d|30)$/;

/** Count legacy utility classes in a source string (dark: twins exempt). */
export function countLegacyTokens(source) {
  let count = 0;
  const hits = [];
  // Class tokens are separated by whitespace, quotes, template braces, etc.
  for (const raw of source.split(/[\s'"`{}()[\],;]+/)) {
    if (!raw) continue;
    const parts = raw.split(':');
    const base = parts[parts.length - 1];
    if (parts.slice(0, -1).includes('dark')) continue;
    if (LOW_ALPHA_WHITE.test(base)) continue;
    if (LEGACY.test(base)) {
      count += 1;
      hits.push(raw);
    }
  }
  return { count, hits };
}

function walk(path, out) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry), out);
  } else if (/\.(jsx?|tsx?)$/.test(path) && !/\.test\.[jt]sx?$/.test(path)) {
    out.push(path);
  }
}

export function scanSwept(root = ROOT, sweptPaths = SWEPT_PATHS, excluded = EXCLUDED_PATHS) {
  const files = [];
  for (const p of sweptPaths) {
    const abs = join(root, p);
    try { walk(abs, files); } catch { /* path not present (yet) */ }
  }
  const skip = new Set(excluded);
  const counts = {};
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    if (skip.has(rel) || rel.includes('/__mocks__/')) continue;
    counts[rel] = countLegacyTokens(readFileSync(file, 'utf8'));
  }
  return counts;
}

export function compare(counts, baseline) {
  const failures = [];
  for (const [file, { count, hits }] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) failures.push({ file, count, allowed, hits });
  }
  return failures;
}

function main() {
  const update = process.argv.includes('--update');
  const counts = scanSwept();
  if (update) {
    const next = Object.fromEntries(Object.entries(counts).map(([f, { count }]) => [f, count]));
    writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Baseline written: ${Object.keys(next).length} files → ${relative(ROOT, BASELINE_FILE)}`);
    return 0;
  }
  let baseline = {};
  try { baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')); } catch { /* no baseline = all zero */ }
  const failures = compare(counts, baseline);
  const total = Object.values(counts).reduce((n, c) => n + c.count, 0);
  if (failures.length === 0) {
    console.log(`Dark-token guard OK: ${Object.keys(counts).length} swept files, ${total} baselined legacy classes, 0 new.`);
    return 0;
  }
  console.error('Dark-token guard FAILED — new hardcoded light-only classes in swept files:');
  for (const f of failures) {
    console.error(`  ${f.file}: ${f.count} (baseline ${f.allowed}) — e.g. ${[...new Set(f.hits)].slice(0, 6).join(', ')}`);
  }
  console.error('Use tokens instead (bg-card, text-foreground, text-muted-foreground, border-border, bg-muted); `dark:` twins only for accent tints. See CLAUDE.md → Design tokens.');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main());
}
