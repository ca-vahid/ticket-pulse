/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  buildHighchartsTheme,
  chartPalette,
  readChartColors,
  tokenToHex,
  useChartColors,
  useHighchartsTheme,
} from './highchartsTheme';
import { THEME_CHANGED_EVENT } from '../contexts/ThemeContext';

/**
 * Phase DM-B (DM8) — Highcharts/recharts dark theme. The theme is built from
 * the CSS tokens at call time (injected reader here — jsdom has no real
 * computed custom properties) and re-applied through the
 * `tp:theme-changed` window event or a `resolvedTheme` change, bumping the
 * `themeKey` the pages use to remount every chart.
 */

// Mutable stand-in for useTheme() so the resolvedTheme-change path is
// testable without mounting the full provider.
const themeState = vi.hoisted(() => ({ resolvedTheme: 'light' }));
vi.mock('../contexts/ThemeContext', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useTheme: () => ({
      theme: 'system',
      resolvedTheme: themeState.resolvedTheme,
      systemDark: false,
      setTheme: () => {},
    }),
  };
});

const LIGHT_VARS = {
  '--foreground': '222 47% 11%',
  '--muted-foreground': '215 16% 47%',
  '--border': '214 32% 88%',
  '--card': '0 0% 100%',
  '--primary': '221 83% 53%',
  '--muted': '215 20% 93%',
};
const DARK_VARS = {
  '--foreground': '210 40% 96%',
  '--muted-foreground': '215 20% 68%',
  '--border': '216 26% 25%',
  '--card': '222 42% 12%',
  '--primary': '219 88% 55%',
  '--muted': '217 33% 17%',
};
const readerFor = (vars) => (name) => vars[name] || '';

afterEach(() => {
  cleanup();
  themeState.resolvedTheme = 'light';
  document.documentElement.classList.remove('dark');
  vi.restoreAllMocks();
});

describe('tokenToHex', () => {
  test('converts the space-separated HSL triples the tokens use', () => {
    expect(tokenToHex('0 0% 100%')).toBe('#ffffff');
    expect(tokenToHex('222 47% 11%')).toBe('#0f1729');
  });

  test('passes hex/rgb through and falls back on junk', () => {
    expect(tokenToHex('#123456')).toBe('#123456');
    expect(tokenToHex('rgba(1, 2, 3, 0.5)')).toBe('rgba(1, 2, 3, 0.5)');
    expect(tokenToHex('', '#abcdef')).toBe('#abcdef');
    expect(tokenToHex('not-a-colour', '#abcdef')).toBe('#abcdef');
  });
});

describe('buildHighchartsTheme', () => {
  test('reads the tokens through the injected reader', () => {
    const readVar = vi.fn(readerFor(LIGHT_VARS));
    buildHighchartsTheme({ readVar, dark: false });
    for (const name of ['--foreground', '--muted-foreground', '--border', '--card', '--primary']) {
      expect(readVar).toHaveBeenCalledWith(name);
    }
  });

  test('dark and light produce different chrome colours from their tokens', () => {
    const light = buildHighchartsTheme({ readVar: readerFor(LIGHT_VARS), dark: false });
    const dark = buildHighchartsTheme({ readVar: readerFor(DARK_VARS), dark: true });

    expect(light.xAxis.labels.style.color).toBe(tokenToHex(LIGHT_VARS['--muted-foreground']));
    expect(dark.xAxis.labels.style.color).toBe(tokenToHex(DARK_VARS['--muted-foreground']));
    expect(dark.xAxis.labels.style.color).not.toBe(light.xAxis.labels.style.color);

    // Tooltip = card surface with a token border and foreground text.
    expect(dark.tooltip.backgroundColor).toBe(tokenToHex(DARK_VARS['--card']));
    expect(dark.tooltip.borderColor).toBe(tokenToHex(DARK_VARS['--border']));
    expect(dark.tooltip.style.color).toBe(tokenToHex(DARK_VARS['--foreground']));

    // Grid/axis lines follow --border; legend text follows --foreground.
    expect(dark.yAxis.gridLineColor).toBe(tokenToHex(DARK_VARS['--border']));
    expect(dark.legend.itemStyle.color).toBe(tokenToHex(DARK_VARS['--foreground']));

    // The chart canvas stays transparent over .tp-card in both themes, and
    // data labels never get the default contrast outline.
    expect(light.chart.backgroundColor).toBe('transparent');
    expect(dark.chart.backgroundColor).toBe('transparent');
    expect(dark.plotOptions.series.dataLabels.style.textOutline).toBe('none');
    expect(dark.credits.enabled).toBe(false);
  });

  test('dark categorical palette uses lighter tints of the same order', () => {
    const light = chartPalette(false);
    const dark = chartPalette(true);
    expect(light.order).toHaveLength(dark.order.length);
    expect(light.blue).toBe('#2563eb');
    expect(dark.blue).toBe('#60a5fa');
    // Assignment-source hue mapping is stable across themes (team-safe
    // muted actor-less buckets included).
    expect(light.assignmentSource.selfPicked).toBe(light.amber);
    expect(dark.assignmentSource.selfPicked).toBe(dark.amber);
    expect(dark.assignmentSource.unknown).toBe(dark.ash);
    // Treemap ramps keep the 5-stop shape with swapped colours.
    expect(dark.treemap.pressure).toHaveLength(light.treemap.pressure.length);
    expect(dark.treemap.pressure[0][1]).not.toBe(light.treemap.pressure[0][1]);
  });
});

describe('useHighchartsTheme', () => {
  test('applies once on mount without bumping the key', () => {
    const Highcharts = { setOptions: vi.fn() };
    const { result } = renderHook(() => useHighchartsTheme(Highcharts));
    expect(Highcharts.setOptions).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(0);
  });

  test('re-applies and bumps the key on tp:theme-changed, once per toggle', () => {
    const Highcharts = { setOptions: vi.fn() };
    const { result } = renderHook(() => useHighchartsTheme(Highcharts));
    expect(result.current).toBe(0);

    act(() => {
      document.documentElement.classList.add('dark');
      window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: { resolved: 'dark' } }));
    });
    expect(result.current).toBe(1);
    expect(Highcharts.setOptions).toHaveBeenCalledTimes(2);
    // Dark palette went out on the second apply.
    const applied = Highcharts.setOptions.mock.calls.at(-1)[0];
    expect(applied.colors[0]).toBe(chartPalette(true).blue);

    // Same resolved theme again (event + context both fire on one toggle) —
    // idempotent, no extra remount.
    act(() => {
      window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: { resolved: 'dark' } }));
    });
    expect(result.current).toBe(1);
    expect(Highcharts.setOptions).toHaveBeenCalledTimes(2);
  });

  test('re-applies and bumps the key when resolvedTheme changes', () => {
    const Highcharts = { setOptions: vi.fn() };
    const { result, rerender } = renderHook(() => useHighchartsTheme(Highcharts));
    expect(result.current).toBe(0);

    themeState.resolvedTheme = 'dark';
    rerender();
    expect(result.current).toBe(1);
    expect(Highcharts.setOptions).toHaveBeenCalledTimes(2);
    expect(Highcharts.setOptions.mock.calls.at(-1)[0].colors[0]).toBe(chartPalette(true).blue);
  });
});

describe('useChartColors (recharts)', () => {
  test('serves plain colour strings and re-reads on theme change', () => {
    const { result } = renderHook(() => useChartColors());
    expect(result.current.dark).toBe(false);
    const lightText = result.current.text;
    expect(typeof lightText).toBe('string');

    act(() => {
      document.documentElement.classList.add('dark');
      window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: { resolved: 'dark' } }));
    });
    expect(result.current.dark).toBe(true);
    expect(result.current.text).not.toBe(lightText);
    expect(result.current.series.blue).toBe(chartPalette(true).blue);
  });

  test('readChartColors falls back sanely when tokens are unreadable', () => {
    const colors = readChartColors(() => '', true);
    expect(colors.text).toMatch(/^#/);
    expect(colors.tooltipBg).toMatch(/^#/);
  });
});
