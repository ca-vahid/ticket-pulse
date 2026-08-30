/** @vitest-environment jsdom */
// Phase DM-A (v3.8.02): theme choice → `.dark` on <html>, live OS follow for
// 'system', localStorage-authoritative persistence with the server copy as
// cross-device seed only, and the index.html pre-paint script guarding the
// first frame.
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getWorkspaceId: vi.fn(),
  prefGet: vi.fn(),
  prefSet: vi.fn(),
}));

vi.mock('../services/api', () => ({
  getWorkspaceId: mocks.getWorkspaceId,
  uiPreferencesAPI: { get: mocks.prefGet, set: mocks.prefSet },
}));

import {
  ThemeProvider,
  useTheme,
  resolveTheme,
  normalizeTheme,
  THEME_STORAGE_KEY,
  THEME_COLOR,
  THEME_CHANGED_EVENT,
  applyResolvedTheme,
} from './ThemeContext';

// One controllable matchMedia: `mq.set(true)` flips the OS preference and
// notifies listeners like a real MediaQueryList would.
function installMatchMedia(initialDark = false) {
  const listeners = new Set();
  const mql = {
    matches: initialDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    dispatchEvent: () => true,
  };
  window.matchMedia = vi.fn(() => mql);
  return {
    set(dark) {
      mql.matches = dark;
      for (const fn of listeners) fn({ matches: dark });
    },
    listenerCount: () => listeners.size,
  };
}

function Probe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button type="button" onClick={() => setTheme('dark')}>dark</button>
      <button type="button" onClick={() => setTheme('light')}>light</button>
      <button type="button" onClick={() => setTheme('system')}>system</button>
      <button type="button" onClick={() => setTheme('neon')}>bogus</button>
    </div>
  );
}

const mount = () => render(<ThemeProvider><Probe /></ThemeProvider>);
const html = () => document.documentElement;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  html().classList.remove('dark');
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'theme-color');
  meta.setAttribute('content', '#0f172a');
  document.head.appendChild(meta);
  mocks.getWorkspaceId.mockReturnValue(1);
  mocks.prefGet.mockResolvedValue({ success: true, data: { key: 'ui.theme', value: null } });
  mocks.prefSet.mockResolvedValue({ success: true, data: { key: 'ui.theme', value: 'dark' } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('pure helpers', () => {
  test('resolveTheme: explicit choices win, system follows the OS', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  test('normalizeTheme rejects anything outside the three strings', () => {
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('DARK')).toBeNull();
    expect(normalizeTheme('')).toBeNull();
    expect(normalizeTheme(undefined)).toBeNull();
  });
});

describe('ThemeProvider', () => {
  test('defaults to system: light OS → no .dark; OS flips to dark → .dark + theme-color', () => {
    const mq = installMatchMedia(false);
    mount();
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    expect(html()).not.toHaveClass('dark');
    expect(document.querySelector('meta[name="theme-color"]').getAttribute('content')).toBe(THEME_COLOR.light);

    act(() => mq.set(true));
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(html()).toHaveClass('dark');
    expect(document.querySelector('meta[name="theme-color"]').getAttribute('content')).toBe(THEME_COLOR.dark);

    act(() => mq.set(false));
    expect(html()).not.toHaveClass('dark');
  });

  test('explicit light ignores a dark OS; explicit dark applies under a light OS', () => {
    const mq = installMatchMedia(true);
    mount();
    expect(html()).toHaveClass('dark'); // system + dark OS
    act(() => screen.getByText('light').click());
    expect(html()).not.toHaveClass('dark');
    act(() => mq.set(true)); // OS churn must not override the explicit choice
    expect(html()).not.toHaveClass('dark');

    act(() => mq.set(false));
    act(() => screen.getByText('dark').click());
    expect(html()).toHaveClass('dark');
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
  });

  test('an invalid value is ignored', () => {
    installMatchMedia(false);
    mount();
    act(() => screen.getByText('bogus').click());
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  test('a choice writes localStorage immediately and the server copy after the debounce', async () => {
    installMatchMedia(false);
    mount();
    act(() => screen.getByText('dark').click());
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(mocks.prefSet).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(mocks.prefSet).toHaveBeenCalledTimes(1);
    expect(mocks.prefSet).toHaveBeenCalledWith('ui.theme', 'dark');
  });

  test('rapid changes collapse into one server write (last value)', async () => {
    installMatchMedia(false);
    mount();
    act(() => screen.getByText('dark').click());
    act(() => screen.getByText('light').click());
    act(() => screen.getByText('system').click());
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(mocks.prefSet).toHaveBeenCalledTimes(1);
    expect(mocks.prefSet).toHaveBeenCalledWith('ui.theme', 'system');
  });

  test('stored localStorage choice paints on mount and is NOT overruled by the server', async () => {
    installMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    mocks.prefGet.mockResolvedValue({ success: true, data: { key: 'ui.theme', value: 'light' } });
    mount();
    expect(html()).toHaveClass('dark');
    await flush();
    // Local is authoritative: no seed request is even made.
    expect(mocks.prefGet).not.toHaveBeenCalled();
    expect(html()).toHaveClass('dark');
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
  });

  test('empty localStorage → server copy seeds the choice (cross-device) and is mirrored locally', async () => {
    installMatchMedia(false);
    mocks.prefGet.mockResolvedValue({ success: true, data: { key: 'ui.theme', value: 'dark' } });
    mount();
    expect(html()).not.toHaveClass('dark');
    await flush();
    expect(mocks.prefGet).toHaveBeenCalledWith('ui.theme');
    expect(html()).toHaveClass('dark');
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  test('server seed waits for a workspace: nothing at boot, fetch once the workspace is announced', async () => {
    installMatchMedia(false);
    mocks.getWorkspaceId.mockReturnValue(null);
    mocks.prefGet.mockResolvedValue({ success: true, data: { key: 'ui.theme', value: 'dark' } });
    mount();
    await flush();
    expect(mocks.prefGet).not.toHaveBeenCalled();
    mocks.getWorkspaceId.mockReturnValue(3);
    await act(async () => {
      window.dispatchEvent(new CustomEvent('tp:workspace-selected', { detail: { id: 3 } }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.prefGet).toHaveBeenCalledTimes(1);
    expect(html()).toHaveClass('dark');
  });

  test('a garbage server value never seeds; a failed seed is silent', async () => {
    installMatchMedia(false);
    mocks.prefGet.mockResolvedValue({ success: true, data: { key: 'ui.theme', value: 'sepia' } });
    mount();
    await flush();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(screen.getByTestId('theme')).toHaveTextContent('system');

    cleanup();
    mocks.prefGet.mockRejectedValue(new Error('401'));
    mount();
    await flush();
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
  });

  test('unmount removes the media listener', () => {
    const mq = installMatchMedia(false);
    const view = mount();
    expect(mq.listenerCount()).toBe(1);
    view.unmount();
    expect(mq.listenerCount()).toBe(0);
  });

  test('useTheme outside the provider is an inert light fallback (test/public routes)', () => {
    installMatchMedia(true);
    render(<Probe />);
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    act(() => screen.getByText('dark').click());
    expect(html()).not.toHaveClass('dark');
  });
});

describe('tp:theme-changed (DM-B: charts + map tiles re-read the tokens)', () => {
  test('applyResolvedTheme stamps the class first, then fires the window event with the resolved theme', () => {
    const seen = [];
    const onChange = (e) => seen.push({ resolved: e.detail.resolved, hasClass: document.documentElement.classList.contains('dark') });
    window.addEventListener(THEME_CHANGED_EVENT, onChange);
    try {
      applyResolvedTheme('dark');
      applyResolvedTheme('light');
    } finally {
      window.removeEventListener(THEME_CHANGED_EVENT, onChange);
    }
    expect(THEME_CHANGED_EVENT).toBe('tp:theme-changed');
    expect(seen).toEqual([{ resolved: 'dark', hasClass: true }, { resolved: 'light', hasClass: false }]);
  });
});
describe('index.html pre-paint script (no-flash smoke)', () => {
  const htmlSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../index.html'), 'utf8');

  test('an inline script reads tp_theme + prefers-color-scheme BEFORE /src/main.jsx loads', () => {
    const scriptAt = htmlSrc.indexOf("localStorage.getItem('tp_theme')");
    const mainAt = htmlSrc.indexOf('src="/src/main.jsx"');
    expect(scriptAt).toBeGreaterThan(-1);
    expect(mainAt).toBeGreaterThan(-1);
    expect(scriptAt).toBeLessThan(mainAt);
    expect(htmlSrc).toContain('prefers-color-scheme: dark');
    expect(htmlSrc).toContain("classList.add('dark')");
    // Ground paints dark even before the CSS bundle arrives.
    expect(htmlSrc).toMatch(/html\.dark\s*\{[^}]*background:\s*#090e1a/);
    expect(htmlSrc).toContain(`'${THEME_COLOR.dark}'`);
  });

  test('the script is inert for a light choice and stamps .dark for a stored dark choice', () => {
    const body = htmlSrc.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
    const run = (stored, osDark) => {
      const root = { classList: { add: vi.fn() } };
      const meta = { setAttribute: vi.fn() };
      const fn = new Function('localStorage', 'window', 'document', body);
      fn(
        { getItem: () => stored },
        { matchMedia: () => ({ matches: osDark }) },
        { documentElement: root, querySelector: () => meta },
      );
      return { dark: root.classList.add.mock.calls.length > 0, meta: meta.setAttribute.mock.calls[0]?.[1] };
    };
    expect(run('dark', false)).toEqual({ dark: true, meta: THEME_COLOR.dark });
    expect(run('light', true)).toEqual({ dark: false, meta: undefined });
    expect(run(null, true)).toEqual({ dark: true, meta: THEME_COLOR.dark });
    expect(run(null, false)).toEqual({ dark: false, meta: undefined });
    expect(run('garbage', false)).toEqual({ dark: false, meta: undefined });
  });
});
