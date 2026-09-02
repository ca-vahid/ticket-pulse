import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  THEME_CHANGED_EVENT,
  applyResolvedTheme,
  readStoredTheme,
  resolveTheme,
  systemPrefersDark,
} from '../../contexts/ThemeContext';

/**
 * Page-local theme for the public approval page.
 *
 * Approvers open this page from an email with no session, so the app's
 * 'tp_theme' choice (owned by ThemeProvider) is not theirs to change. The page
 * keeps its own key ('tp_public_theme'), falls back to the OS preference, and
 * stamps `.dark` on <html> through the same applyResolvedTheme the app uses —
 * so every token-driven surface themes for free. ThemeProvider still wraps the
 * route and re-stamps its own choice whenever ITS resolved theme changes; the
 * listener below re-applies the page choice the moment that happens (the
 * event carries the resolved value, so a matching stamp is a no-op — no loop).
 * On unmount the app's own theme is restored.
 */
export const PUBLIC_THEME_KEY = 'tp_public_theme';

function readPublicTheme() {
  try {
    const value = localStorage.getItem(PUBLIC_THEME_KEY);
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null;
  }
}

function writePublicTheme(value) {
  try {
    localStorage.setItem(PUBLIC_THEME_KEY, value);
  } catch {
    /* storage blocked — the in-memory choice still applies for this tab */
  }
}

export function usePublicTheme() {
  const [theme, setTheme] = useState(() => readPublicTheme() || (systemPrefersDark() ? 'dark' : 'light'));

  useLayoutEffect(() => {
    applyResolvedTheme(theme);
    if (typeof window === 'undefined') return undefined;
    const onChanged = (event) => {
      if (event?.detail?.resolved !== theme) applyResolvedTheme(theme);
    };
    window.addEventListener(THEME_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onChanged);
  }, [theme]);

  // Leaving the page (SPA navigation) hands <html> back to the app's choice.
  useEffect(() => () => {
    applyResolvedTheme(resolveTheme(readStoredTheme() || 'system', systemPrefersDark()));
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      writePublicTheme(next);
      return next;
    });
  }, []);

  return { theme, isDark: theme === 'dark', toggle };
}
