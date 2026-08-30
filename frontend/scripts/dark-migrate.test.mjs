// Phase DM-B codemod: the mechanical token map + dark accent twins, applied
// only inside string/template literals (nested `${}` handled).
import { describe, expect, test } from 'vitest';
import { migrateSource, migrateToken } from './dark-migrate.mjs';

describe('migrateToken', () => {
  test('CLAUDE.md map: surfaces, text, borders, dividers, gradients', () => {
    const cases = {
      'bg-white': 'bg-card',
      'bg-white/80': 'bg-card/80',
      'hover:bg-slate-50': 'hover:bg-muted/50',
      'bg-slate-100': 'bg-muted',
      'bg-slate-200': 'bg-secondary',
      'text-slate-900': 'text-foreground',
      'md:text-slate-500': 'md:text-muted-foreground',
      'text-slate-700': 'text-foreground/85',
      'text-slate-400': 'text-muted-foreground/75',
      'text-gray-300': 'text-muted-foreground/50',
      'border-slate-200': 'border-border',
      'border-b-slate-100': 'border-b-border/60',
      'border-slate-300': 'border-input',
      'divide-slate-100': 'divide-border/60',
      'from-white': 'from-card',
      'ring-white': 'ring-card',
      'placeholder-slate-400': 'placeholder-muted-foreground/70',
    };
    for (const [from, to] of Object.entries(cases)) expect(migrateToken(from), from).toBe(to);
  });

  test('accent tints gain a dark twin in the same hue family; variants are carried over', () => {
    expect(migrateToken('bg-blue-50')).toBe('bg-blue-50 dark:bg-blue-500/15');
    expect(migrateToken('bg-emerald-100')).toBe('bg-emerald-100 dark:bg-emerald-500/20');
    expect(migrateToken('text-blue-700')).toBe('text-blue-700 dark:text-blue-200');
    expect(migrateToken('text-amber-600')).toBe('text-amber-600 dark:text-amber-300');
    expect(migrateToken('border-rose-200')).toBe('border-rose-200 dark:border-rose-500/30');
    expect(migrateToken('hover:bg-blue-50')).toBe('hover:bg-blue-50 dark:hover:bg-blue-500/15');
  });

  test('leaves alone: dark: variants, low-alpha white overlays, text-white, dark chrome, unknown tokens', () => {
    for (const t of ['dark:bg-blue-500/15', 'bg-white/20', 'text-white', 'bg-slate-900', 'bg-blue-600', 'rounded-lg', 'text-slate-300']) {
      expect(migrateToken(t, { darkChrome: t === 'text-slate-300' }), t).toBeNull();
    }
  });

  test('does not add a twin the literal already has', () => {
    expect(migrateToken('bg-blue-50', { hasDarkTwin: (p) => p === 'dark:bg-blue' })).toBeNull();
  });
});

describe('migrateSource', () => {
  test('rewrites inside quotes and nested template literals, never in code or comments', () => {
    const src = [
      "const a = 'bg-white text-slate-900'; // bg-white stays in this comment",
      '/* text-slate-500 */',
      'className={`row ${active ? `bg-white ${x}` : `${z ? \'text-slate-500\' : \'x\'} hover:text-slate-900`} text-slate-300`}',
      '<p>Don\'t</p> "bg-slate-900 text-slate-300"',
    ].join('\n');
    const { text, count } = migrateSource(src);
    expect(text).toContain("'bg-card text-foreground'; // bg-white stays in this comment");
    expect(text).toContain('/* text-slate-500 */');
    expect(text).toContain('`bg-card ${x}`');
    expect(text).toContain("'text-muted-foreground'");
    expect(text).toContain('hover:text-foreground');
    expect(text).toContain('text-muted-foreground/50`}');
    // dark chrome in the same literal keeps its light-grey text
    expect(text).toContain('"bg-slate-900 text-slate-300"');
    expect(count).toBe(6);
  });

  test('is idempotent', () => {
    const once = migrateSource("cn('bg-white', 'bg-blue-50 text-blue-700', `p-2 ${x} border-slate-200`)").text;
    expect(migrateSource(once)).toEqual({ text: once, count: 0 });
  });
});
