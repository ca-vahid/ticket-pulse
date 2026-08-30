// Phase DM-A lint guard: the scanner counts legacy light-only classes, exempts
// `dark:` twins, and fails only on growth against the baseline.
import { describe, expect, test } from 'vitest';
import { compare, countLegacyTokens, scanSwept, SWEPT_PATHS } from './check-dark-tokens.mjs';

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

  test('does not false-positive on similar names', () => {
    expect(countLegacyTokens('bg-whitesmoke text-slate border-slate-x bg-slate-50 text-slate-500/50').hits).toEqual(['text-slate-500/50']);
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

  test('the swept chrome is fully token-driven today (0 legacy classes)', () => {
    const counts = scanSwept();
    const nonZero = Object.entries(counts).filter(([, c]) => c.count > 0).map(([f, c]) => `${f}: ${[...new Set(c.hits)].join(', ')}`);
    expect(SWEPT_PATHS.length).toBeGreaterThan(0);
    expect(Object.keys(counts).length).toBeGreaterThan(5);
    expect(nonZero).toEqual([]);
  });
});
