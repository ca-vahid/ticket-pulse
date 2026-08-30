import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { THEME_CHANGED_EVENT, useTheme } from '../contexts/ThemeContext';

/**
 * Chart theming for dark mode (Phase DM-B, DM8).
 *
 * Highcharts and recharts paint SVG attributes, not CSS classes, so the
 * `.dark` token swap in index.css cannot reach them. This module reads the
 * tokens (`--foreground`, `--muted-foreground`, `--border`, `--card`,
 * `--primary`, `--muted`) off <html> at call time, converts them to hex
 * (Highcharts' Color parser only understands hex/rgb(a) — it needs real
 * colours for hover brightening and opacity maths) and builds:
 *
 *   - `buildHighchartsTheme({ readVar, dark })` — pure; the global
 *     `Highcharts.setOptions` payload (chart chrome, axes, legend, tooltip,
 *     data labels, breadcrumbs, exporting menu, treemap/heatmap borders).
 *   - `chartPalette(dark)` — the categorical series palette. Dark uses the
 *     400-ish tints of the same hues so a series keeps its meaning (blue =
 *     created, green = resolved, amber = net…) but reads on a slate-900 card.
 *   - `useHighchartsTheme(Highcharts)` — applies the theme on mount and
 *     re-applies on `tp:theme-changed` / `resolvedTheme` change, returning a
 *     `themeKey` counter. `Highcharts.setOptions` only affects charts created
 *     AFTER it runs (existing charts keep their merged options), so pages key
 *     every `HighchartsReact` on `themeKey` to remount — the reliable redraw.
 *   - `useChartPalette()` / `useChartColors()` — React-state views of the
 *     palette + chrome colours for options memos and recharts props.
 */

export const CHART_FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif";

// Tailwind 600/500 tones in light; the 400/300 tints of the SAME hues in dark.
const SERIES_LIGHT = Object.freeze({
  blue: '#2563eb',
  green: '#059669',
  amber: '#f59e0b',
  violet: '#7c3aed',
  red: '#dc2626',
  cyan: '#0891b2',
  slate: '#64748b',
  teal: '#0f766e',
  orange: '#c2410c',
  emerald: '#10b981',
  purple: '#8b5cf6',
  blueDeep: '#1d4ed8',
  // Sub-series fills (responses column, sankey nodes) — pastel in light.
  blueSoft: '#bfdbfe',
  steel: '#7c93c4',
  ash: '#94a3b8',
});

const SERIES_DARK = Object.freeze({
  blue: '#60a5fa',
  green: '#34d399',
  amber: '#fbbf24',
  violet: '#a78bfa',
  red: '#f87171',
  cyan: '#22d3ee',
  slate: '#94a3b8',
  teal: '#2dd4bf',
  orange: '#fb923c',
  emerald: '#6ee7b7',
  purple: '#c4b5fd',
  blueDeep: '#3b82f6',
  blueSoft: 'rgba(96, 165, 250, 0.35)',
  steel: '#9db3d9',
  ash: '#8b98ad',
});

// Ordered categorical palette (per-agent lines, funnel slices…).
const SERIES_ORDER = ['blue', 'green', 'amber', 'violet', 'red', 'cyan', 'slate', 'teal', 'orange'];

// Pastel node fills for the assignment-path sankey; deeper tints in dark so
// the light data labels sit on them.
const SOFT_LIGHT = Object.freeze({
  blue: '#dbeafe',
  red: '#fecaca',
  orange: '#fed7aa',
  green: '#d1fae5',
  slate: '#e2e8f0',
  sky: '#e0f2fe',
});
const SOFT_DARK = Object.freeze({
  blue: '#1e40af',
  red: '#991b1b',
  orange: '#9a3412',
  green: '#065f46',
  slate: '#334155',
  sky: '#075985',
});

// Category-map colour-axis ramps. Semantics are unchanged (calm → hot,
// none → most of the agent's portfolio, light → dark blue share); the dark
// ramps start from a slate-800 neutral and deepen so the light leaf labels
// keep contrast at every stop.
const TREEMAP_LIGHT = Object.freeze({
  pressure: [[0, '#dbeafe'], [0.22, '#d1fae5'], [0.48, '#fef9c3'], [0.74, '#fed7aa'], [1, '#fecaca']],
  agentShare: [[0, '#f8fafc'], [0.18, '#dbeafe'], [0.45, '#93c5fd'], [0.72, '#3b82f6'], [1, '#1d4ed8']],
  agentPortfolio: [[0, '#f8fafc'], [0.16, '#dcfce7'], [0.4, '#bae6fd'], [0.68, '#fde68a'], [1, '#fb7185']],
  heatMin: '#eff6ff',
  heatMax: '#2563eb',
  label: '#0f172a',
  labelMuted: '#334155',
  parentBorder: '#334155',
  leafBorder: '#94a3b8',
  cellBorder: '#64748b',
  hotBorder: '#ef4444',
  parentFill: 'rgba(255,255,255,0.001)',
});
const TREEMAP_DARK = Object.freeze({
  pressure: [[0, '#1e3a8a'], [0.22, '#065f46'], [0.48, '#854d0e'], [0.74, '#9a3412'], [1, '#991b1b']],
  agentShare: [[0, '#273449'], [0.18, '#1e3a8a'], [0.45, '#1e40af'], [0.72, '#2563eb'], [1, '#3b82f6']],
  agentPortfolio: [[0, '#273449'], [0.16, '#065f46'], [0.4, '#075985'], [0.68, '#92400e'], [1, '#9f1239']],
  heatMin: '#1e293b',
  heatMax: '#60a5fa',
  label: '#f1f5f9',
  labelMuted: '#cbd5e1',
  parentBorder: '#cbd5e1',
  leafBorder: '#475569',
  cellBorder: '#475569',
  hotBorder: '#f87171',
  parentFill: 'rgba(0,0,0,0.001)',
});

export function isDocumentDark() {
  if (typeof document === 'undefined') return false;
  return Boolean(document.documentElement?.classList?.contains('dark'));
}

/** Raw token value ("222 47% 11%") read off <html>. */
export function readCssVar(name) {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return '';
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return '';
  }
}

function hslToHex(h, s, l) {
  const sat = s / 100;
  const light = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Token value → hex. Accepts the space-separated HSL triple the tokens use,
 * `hsl(...)`, a hex string or rgb(a) (returned as-is), else the fallback.
 */
export function tokenToHex(raw, fallback) {
  const value = String(raw || '').trim();
  if (!value) return fallback;
  if (value.startsWith('#') || value.startsWith('rgb')) return value;
  const m = value.match(/(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/);
  if (!m) return fallback;
  return hslToHex(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** Hex → rgba string at the given alpha (for tints/overlays). */
export function withAlpha(hex, alpha) {
  const m = String(hex).match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

const FALLBACK_TOKENS = {
  light: { foreground: '#0f172a', muted: '#64748b', border: '#dbe2ec', card: '#ffffff', primary: '#2563eb', mutedBg: '#e9edf2' },
  dark: { foreground: '#f1f5f9', muted: '#9ca9bd', border: '#2f3a50', card: '#12192b', primary: '#2b6cf1', mutedBg: '#1d2839' },
};

/** Chrome colours (text, borders, card) resolved from the tokens. */
export function readChromeColors(readVar = readCssVar, dark = isDocumentDark()) {
  const fb = dark ? FALLBACK_TOKENS.dark : FALLBACK_TOKENS.light;
  return {
    foreground: tokenToHex(readVar('--foreground'), fb.foreground),
    muted: tokenToHex(readVar('--muted-foreground'), fb.muted),
    border: tokenToHex(readVar('--border'), fb.border),
    card: tokenToHex(readVar('--card'), fb.card),
    primary: tokenToHex(readVar('--primary'), fb.primary),
    mutedBg: tokenToHex(readVar('--muted'), fb.mutedBg),
  };
}

/** Categorical + semantic series palette for the given theme. */
export function chartPalette(dark = isDocumentDark()) {
  const series = dark ? SERIES_DARK : SERIES_LIGHT;
  return {
    dark,
    ...series,
    order: SERIES_ORDER.map((key) => series[key]),
    soft: dark ? SOFT_DARK : SOFT_LIGHT,
    treemap: dark ? TREEMAP_DARK : TREEMAP_LIGHT,
    assignmentSource: {
      selfPicked: series.amber,
      coordinatorAssigned: series.green,
      appAssigned: series.blue,
      workflowAssigned: series.steel,
      unknown: series.ash,
    },
    severity: { critical: series.red, warning: series.amber, info: series.blue },
  };
}

/**
 * Pure builder for `Highcharts.setOptions`. `readVar(name)` returns the raw
 * token value; `dark` selects the palette. Every colour Highcharts would
 * otherwise default to white/black/grey is pinned here so per-chart options
 * only need to carry data colours and sizes.
 */
export function buildHighchartsTheme({ readVar = readCssVar, dark = isDocumentDark() } = {}) {
  const c = readChromeColors(readVar, dark);
  const palette = chartPalette(dark);
  const gridLine = c.border;
  const hidden = withAlpha(c.muted, 0.55);
  const primaryTint = withAlpha(c.primary, dark ? 0.18 : 0.1);
  const textOutline = 'none';
  const labelStyle = { color: c.muted, fontSize: '11px' };
  const axis = {
    labels: { style: labelStyle },
    title: { style: { color: c.muted, fontSize: '11px' } },
    lineColor: c.border,
    tickColor: c.border,
    gridLineColor: gridLine,
    minorGridLineColor: withAlpha(c.border, 0.5),
    crosshair: { color: withAlpha(c.muted, 0.25) },
  };
  const dataLabels = { color: c.foreground, style: { color: c.foreground, textOutline, fontSize: '10px' } };
  const buttonTheme = {
    fill: c.card,
    stroke: c.border,
    'stroke-width': 1,
    r: 6,
    style: { color: c.foreground },
    states: {
      hover: { fill: c.mutedBg, style: { color: c.foreground } },
      select: { fill: c.mutedBg, style: { color: c.foreground } },
    },
  };

  return {
    colors: palette.order,
    chart: {
      backgroundColor: 'transparent',
      plotBackgroundColor: 'transparent',
      plotBorderColor: c.border,
      style: { fontFamily: CHART_FONT_FAMILY, color: c.foreground },
      resetZoomButton: { theme: buttonTheme },
    },
    title: { style: { color: c.foreground, fontSize: '14px', fontWeight: '700' } },
    subtitle: { style: { color: c.muted, fontSize: '12px' } },
    caption: { style: { color: c.muted } },
    credits: { enabled: false },
    xAxis: { ...axis },
    yAxis: { ...axis, stackLabels: { style: { color: c.foreground, textOutline, fontSize: '10px' } } },
    zAxis: { ...axis },
    legend: {
      itemStyle: { color: c.foreground, fontSize: '12px', fontWeight: '600' },
      itemHoverStyle: { color: c.primary },
      itemHiddenStyle: { color: hidden, textDecoration: 'line-through' },
      title: { style: { color: c.muted } },
      navigation: { activeColor: c.primary, inactiveColor: hidden, style: { color: c.muted } },
    },
    tooltip: {
      backgroundColor: c.card,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 8,
      shadow: !dark,
      style: { color: c.foreground, fontSize: '12px' },
    },
    plotOptions: {
      series: {
        dataLabels,
        marker: { lineColor: c.card },
      },
      column: { borderColor: c.card },
      bar: { borderColor: c.card },
      pie: { borderColor: c.card, dataLabels: { ...dataLabels, connectorColor: c.muted } },
      area: { marker: { lineColor: c.card } },
      heatmap: { borderColor: c.card, dataLabels },
      treemap: { borderColor: palette.treemap.cellBorder, dataLabels },
      sankey: { dataLabels: { ...dataLabels, style: { ...dataLabels.style, fontWeight: '700' } } },
      bubble: { marker: { lineColor: c.card } },
    },
    drilldown: {
      activeAxisLabelStyle: { color: c.primary, textDecoration: 'none' },
      activeDataLabelStyle: { color: c.primary, textDecoration: 'none' },
    },
    navigation: {
      breadcrumbs: {
        buttonTheme: {
          fill: 'none',
          'stroke-width': 0,
          style: { color: c.primary, fontSize: '12px', fontWeight: '700' },
          states: {
            hover: { fill: primaryTint },
            select: { fill: 'none', style: { color: c.foreground, fontWeight: '800' } },
          },
        },
        separator: { style: { color: c.muted, fontSize: '13px' } },
      },
      buttonOptions: { symbolStroke: c.muted, symbolFill: c.muted, theme: buttonTheme },
      menuStyle: { background: c.card, border: `1px solid ${c.border}`, borderRadius: '8px' },
      menuItemStyle: { color: c.foreground },
      menuItemHoverStyle: { background: c.mutedBg, color: c.foreground },
    },
    loading: { style: { backgroundColor: c.card, color: c.foreground, opacity: 0.8 } },
    accessibility: { keyboardNavigation: { focusBorder: { style: { color: c.primary } } } },
  };
}

/** Apply the current theme globally. Only charts created afterwards use it. */
export function applyHighchartsTheme(Highcharts, overrides = {}) {
  if (!Highcharts || typeof Highcharts.setOptions !== 'function') return null;
  const theme = buildHighchartsTheme(overrides);
  Highcharts.setOptions(theme);
  return theme;
}

/**
 * Applies the theme on mount and re-applies when the resolved theme changes —
 * via the `tp:theme-changed` window event (fired after `.dark` is stamped, so
 * the tokens are already swapped) and via `useTheme().resolvedTheme` as a
 * belt-and-braces path. Both routes funnel through one idempotent `sync`, so a
 * single toggle bumps `themeKey` exactly once. Key each chart on the result.
 */
export function useHighchartsTheme(Highcharts) {
  const { resolvedTheme } = useTheme();
  const [themeKey, setThemeKey] = useState(0);
  const appliedRef = useRef(null);

  // First render: apply synchronously, BEFORE the chart child renders —
  // effects (even layout effects) would run after the child created its
  // chart, leaving the very first chart unthemed. Idempotent + global, so a
  // render-phase side effect (and many blocks doing it) is safe. No key bump:
  // the chart that mounts next already gets this theme.
  if (appliedRef.current === null) {
    const initial = resolvedTheme === 'dark' || (resolvedTheme !== 'light' && isDocumentDark()) ? 'dark' : 'light';
    appliedRef.current = initial;
    applyHighchartsTheme(Highcharts, { dark: initial === 'dark' });
  }

  const sync = useCallback((resolved) => {
    const next = resolved === 'dark' || resolved === 'light' ? resolved : (isDocumentDark() ? 'dark' : 'light');
    if (appliedRef.current === next) return;
    appliedRef.current = next;
    applyHighchartsTheme(Highcharts, { dark: next === 'dark' });
    setThemeKey((key) => key + 1);
  }, [Highcharts]);

  // Resolved theme change from context (belt-and-braces with the event).
  useEffect(() => {
    sync(resolvedTheme);
  }, [sync, resolvedTheme]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChange = (event) => sync(event?.detail?.resolved);
    window.addEventListener(THEME_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onChange);
  }, [sync]);

  return themeKey;
}

/** Palette for options memos — new identity whenever the resolved theme flips. */
export function useChartPalette() {
  const { resolvedTheme } = useTheme();
  return useMemo(() => chartPalette(resolvedTheme === 'dark'), [resolvedTheme]);
}

/** recharts-ready chrome colours (plain strings), re-read on theme change. */
export function readChartColors(readVar = readCssVar, dark = isDocumentDark()) {
  const c = readChromeColors(readVar, dark);
  const palette = chartPalette(dark);
  return {
    ...c,
    dark,
    text: c.foreground,
    grid: c.border,
    axis: c.muted,
    cursor: dark ? withAlpha(c.muted, 0.12) : '#f1f5f9',
    tooltipBg: c.card,
    tooltipBorder: c.border,
    series: palette,
  };
}

export function useChartColors() {
  const { resolvedTheme } = useTheme();
  const [colors, setColors] = useState(() => readChartColors(readCssVar, resolvedTheme === 'dark'));

  useEffect(() => {
    setColors(readChartColors(readCssVar, resolvedTheme === 'dark'));
  }, [resolvedTheme]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChange = (event) => {
      const resolved = event?.detail?.resolved;
      setColors(readChartColors(readCssVar, resolved ? resolved === 'dark' : isDocumentDark()));
    };
    window.addEventListener(THEME_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onChange);
  }, []);

  return colors;
}
