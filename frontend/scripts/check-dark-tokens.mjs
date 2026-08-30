#!/usr/bin/env node
/**
 * Dark-mode token guard (Phase DM-A, v3.8.02).
 *
 * The swept chrome uses design tokens (bg-card, text-foreground,
 * text-muted-foreground, border-border, bg-muted …) instead of hardcoded
 * slate/white utilities, so it themes for free. This grep-based check keeps
 * it that way: for every file under the swept paths it counts legacy
 * classes — `bg-white`, `text-slate-*`, `border-slate-*` (and `/alpha`
 * variants) — and fails when a file exceeds its baselined count. New files
 * under a swept path start at a baseline of 0. `dark:`-prefixed twins are
 * exempt (they are the sanctioned way to tint an accent that has no token).
 *
 *   node scripts/check-dark-tokens.mjs            # check (CI)
 *   node scripts/check-dark-tokens.mjs --update   # re-baseline after a sweep
 *
 * Widen SWEPT_PATHS as DM-B converts more of the app.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = join(ROOT, 'scripts', 'dark-tokens-baseline.json');

// Files or directories (relative to frontend/) that have been swept.
export const SWEPT_PATHS = [
  'src/App.jsx',
  'src/components/AppShell.jsx',
  'src/components/AppHeader.jsx',
  'src/components/CommandPalette.jsx',
  'src/components/DemoModeBanner.jsx',
  'src/components/SyncHealthBanner.jsx',
  'src/components/EmailHealthBanner.jsx',
  'src/components/nav',
  'src/contexts/ThemeContext.jsx',
];

const LEGACY = /^(bg-white|text-slate-\d{2,3}|border-slate-\d{2,3})(\/[\w.[\]]+)?$/;

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

export function scanSwept(root = ROOT, sweptPaths = SWEPT_PATHS) {
  const files = [];
  for (const p of sweptPaths) {
    const abs = join(root, p);
    try { walk(abs, files); } catch { /* path not present (yet) */ }
  }
  const counts = {};
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
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
