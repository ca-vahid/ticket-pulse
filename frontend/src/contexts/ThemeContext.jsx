import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getWorkspaceId, uiPreferencesAPI } from '../services/api';

/**
 * Theme (Phase DM-A, v3.8.02 — Early access dark mode).
 *
 * Three choices — 'system' | 'light' | 'dark' — resolved to a `.dark` class on
 * <html> (Tailwind `darkMode: 'class'`; every token in index.css swaps under
 * it). 'system' follows `prefers-color-scheme` live via a matchMedia listener.
 *
 * Persistence: localStorage 'tp_theme' is AUTHORITATIVE — it is what the
 * index.html pre-paint script reads before React exists (no white flash), and
 * the device the user is looking at should always win. The server copy
 * ('ui.theme' in the per-user preference store) is cross-device SEEDING only:
 * read once when this device has no stored choice, written (debounced) on
 * every change, never allowed to overrule a local choice. Same shape as the
 * queue-column choreography (useColumnWidths) minus the "server wins" step.
 *
 * No cross-fade: the swap is a class toggle, so the many prefers-reduced-
 * motion rules in index.css have nothing to fight.
 */

export const THEME_STORAGE_KEY = 'tp_theme';
export const THEME_PREF_KEY = 'ui.theme';
export const THEME_OPTIONS = ['system', 'light', 'dark'];
export const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';
// Mirrors index.html: the light value is the existing meta (unchanged), the
// dark value is the dark --background.
export const THEME_COLOR = { light: '#0f172a', dark: '#090e1a' };
const SAVE_DEBOUNCE_MS = 600;
const WORKSPACE_EVENT = 'tp:workspace-selected';

export function normalizeTheme(value) {
  return THEME_OPTIONS.includes(value) ? value : null;
}

export function readStoredTheme() {
  try {
    return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStoredTheme(value) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch {
    /* storage blocked — the in-memory state still applies for this tab */
  }
}

export function systemPrefersDark() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return Boolean(window.matchMedia(DARK_MEDIA_QUERY).matches);
  } catch {
    return false;
  }
}

/** 'dark' when the choice is dark, or system with a dark OS preference. */
export function resolveTheme(theme, prefersDark) {
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  return prefersDark ? 'dark' : 'light';
}

/** Stamp the resolved theme on the document: `.dark` class + theme-color meta. */
export function applyResolvedTheme(resolved) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[resolved] || THEME_COLOR.light);
}

const ThemeContext = createContext(null);

// Components render in tests (and could render on public routes) without the
// provider — fall back to a light, inert theme rather than throwing.
const FALLBACK = Object.freeze({
  theme: 'system',
  resolvedTheme: 'light',
  systemDark: false,
  setTheme: () => {},
});

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => readStoredTheme() || 'system');
  const [hasLocalChoice, setHasLocalChoice] = useState(() => readStoredTheme() !== null);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const saveTimerRef = useRef(null);

  // Follow the OS preference while it changes (only matters for 'system').
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    let mq;
    try {
      mq = window.matchMedia(DARK_MEDIA_QUERY);
    } catch {
      return undefined;
    }
    if (!mq) return undefined;
    setSystemDark(Boolean(mq.matches));
    const onChange = (event) => setSystemDark(Boolean(event.matches));
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    if (typeof mq.addListener === 'function') {
      mq.addListener(onChange);
      return () => mq.removeListener(onChange);
    }
    return undefined;
  }, []);

  // Another tab changed the choice — mirror it (localStorage is authoritative).
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onStorage = (event) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = normalizeTheme(event.newValue);
      setThemeState(next || 'system');
      setHasLocalChoice(next !== null);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const resolvedTheme = resolveTheme(theme, systemDark);
  // Layout effect: the class must be on <html> before the browser paints the
  // React tree (the pre-paint script already stamped the stored choice, so
  // this is a no-op on load and a same-frame swap on change).
  useLayoutEffect(() => {
    applyResolvedTheme(resolvedTheme);
  }, [resolvedTheme]);

  // Server seed: only when this device has never chosen. The preference store
  // is workspace-scoped and needs a signed-in session, so wait for the
  // workspace id (api.js announces it) instead of firing a doomed request at
  // boot. A local choice made meanwhile always wins.
  useEffect(() => {
    if (hasLocalChoice) return undefined;
    let cancelled = false;
    const seed = async () => {
      if (!getWorkspaceId()) return;
      try {
        const res = await uiPreferencesAPI.get(THEME_PREF_KEY);
        const value = normalizeTheme(res?.data?.value);
        if (cancelled || !value || readStoredTheme() !== null) return;
        writeStoredTheme(value);
        setThemeState(value);
        setHasLocalChoice(true);
      } catch {
        /* not signed in / no workspace / offline — the local default stands */
      }
    };
    seed();
    if (typeof window === 'undefined') return () => { cancelled = true; };
    const onWorkspace = () => { seed(); };
    window.addEventListener(WORKSPACE_EVENT, onWorkspace);
    return () => {
      cancelled = true;
      window.removeEventListener(WORKSPACE_EVENT, onWorkspace);
    };
  }, [hasLocalChoice]);

  useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); }, []);

  const setTheme = useCallback((next) => {
    const value = normalizeTheme(next);
    if (!value) return;
    setThemeState(value);
    setHasLocalChoice(true);
    writeStoredTheme(value);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      if (!getWorkspaceId()) return;
      uiPreferencesAPI.set(THEME_PREF_KEY, value).catch(() => { /* local copy still applies */ });
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, systemDark, setTheme }),
    [theme, resolvedTheme, systemDark, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext) || FALLBACK;
}
