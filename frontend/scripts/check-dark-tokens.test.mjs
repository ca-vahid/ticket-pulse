// Phase DM-A lint guard: the scanner counts legacy light-only classes, exempts
// `dark:` twins, and fails only on growth against the baseline.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compare, countLegacyTokens, scanSwept, SWEPT_PATHS, EXCLUDED_PATHS } from './check-dark-tokens.mjs';

describe('countLegacyTokens', () => {
  test('counts bg-white / text-slate-* / border-slate-* including alpha variants', () => {
    const src = 'className="rounded bg-white text-slate-900 border-slate-200/80 bg-white/70 hover:bg-white"';
    const { count, hits } = countLegacyTokens(src);
    expect(count).toBe(5);
    expect(hits).toEqual(['bg-white', 'text-slate-900', 'border-slate-200/80', 'bg-white/70', 'hover:bg-white']);
  });

  test('dark: twins are exempt; tokens are not counted', () => {
    const src = "cn('bg-card text-foreground dark:bg-white dark:text-slate-300', 'dark:hover:border-slate-700 border-border')";
    expect(countLegacyTokens(src).count).toBe(0);
  });

  test('does not false-positive on similar names; DM-B widened it to bg-slate-50…400, gray twins and divide-*', () => {
    expect(countLegacyTokens('bg-whitesmoke text-slate border-slate-x text-slate-500/50').hits).toEqual(['text-slate-500/50']);
    expect(countLegacyTokens('bg-slate-50 bg-gray-100 divide-slate-100 border-b-slate-200 text-gray-700').count).toBe(5);
  });

  test('exempt on purpose: low-alpha white overlays and dark chrome (same in both themes)', () => {
    expect(countLegacyTokens('bg-white/10 bg-white/20 bg-white/30 bg-slate-900 bg-slate-800/60 bg-slate-950').count).toBe(0);
    expect(countLegacyTokens('bg-white/40 bg-white/70').count).toBe(2);
  });
});

describe('compare / scanSwept', () => {
  test('fails only when a file grows past its baseline (new files start at 0)', () => {
    const counts = {
      'a.jsx': { count: 2, hits: ['bg-white', 'bg-white'] },
      'b.jsx': { count: 1, hits: ['text-slate-500'] },
      'c.jsx': { count: 0, hits: [] },
    };
    expect(compare(counts, { 'a.jsx': 2 })).toEqual([{ file: 'b.jsx', count: 1, allowed: 0, hits: ['text-slate-500'] }]);
    expect(compare(counts, { 'a.jsx': 3, 'b.jsx': 1 })).toEqual([]);
  });

  test('DM-B: the whole of src/ is swept, light-only pages are skipped, and nothing grows past the baseline', () => {
    const counts = scanSwept();
    const files = Object.keys(counts);
    expect(SWEPT_PATHS).toEqual(['src']);
    expect(files.length).toBeGreaterThan(150);
    for (const excluded of EXCLUDED_PATHS) expect(files).not.toContain(excluded);
    expect(files).toContain('src/pages/Tickets.jsx');
    expect(files).toContain('src/components/settings/NotificationWorkflowsPanel.jsx');
    const baseline = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dark-tokens-baseline.json'), 'utf8'));
    const failures = compare(counts, baseline).map((f) => `${f.file}: ${f.count} > ${f.allowed} (${[...new Set(f.hits)].join(', ')})`);
    expect(failures).toEqual([]);
    // The residue is tiny and is dark-chrome text (text-slate-100/200 on a slate-900 band) or ≥400 borders.
    const residue = Object.values(counts).reduce((n, c) => n + c.count, 0);
    expect(residue).toBeLessThan(60);
    const zero = files.filter((f) => counts[f].count === 0).length;
    expect(zero / files.length).toBeGreaterThan(0.85);
  });

});
