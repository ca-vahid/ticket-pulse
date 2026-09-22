import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getWorkspaceId, uiPreferencesAPI } from '../services/api';

/**
 * Layout width (full-width train, 16 Sep 2026 — plans/FULL_WIDTH_LAYOUT_PLAN.md).
 *
 *   full         operational pages fill the viewport (default — Vahid's call)
 *   comfortable  capped at 1600 px, centred
 *   classic      capped at 1280 px (the pre-3.9.09 look)
 *
 * Persistence mirrors the theme: localStorage `tp_layout_width` paints
 * instantly and is authoritative for this browser; the `ui.layoutWidth`
 * preference seeds a browser that has no local choice yet and is written
 * (debounced) whenever the person picks one. The choice is stamped on
 * <html data-layout="…"> so page-level CSS (three-column ticket detail, the
 * prose guard) can key on it without prop drilling.
 */
export const LAYOUT_STORAGE_KEY = 'tp_layout_width';
export const LAYOUT_PREF_KEY = 'ui.layoutWidth';
export const LAYOUT_OPTIONS = ['full', 'comfortable', 'classic'];
export const LAYOUT_LABELS = {
  full: { label: 'Full width', hint: 'Use the whole screen' },
  comfortable: { label: 'Comfort', hint: 'Centred, up to 1600 px' }, // "Comfortable" overlapped "Classic" (QA 09-21 #11)
  classic: { label: 'Classic', hint: 'Centred, up to 1280 px' },
};
const DEFAULT_WIDTH = 'full';
const SAVE_DEBOUNCE_MS = 600;
const WORKSPACE_EVENT = 'tp:workspace-selected';

export function normalizeLayout(value) {
  return LAYOUT_OPTIONS.includes(value) ? value : null;
}

export function readStoredLayout() {
  try { return normalizeLayout(localStorage.getItem(LAYOUT_STORAGE_KEY)); } catch { return null; }
}

function writeStoredLayout(value) {
  try { localStorage.setItem(LAYOUT_STORAGE_KEY, value); } catch { /* storage blocked */ }
}

function stamp(width) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-layout', width);
}

/**
 * The container classes for an operational page. `extra` carries the page's
 * own vertical padding / flex bits; the horizontal gutters come from here.
 */
export function pageWidthClass(width, extra = '') {
  const w = normalizeLayout(width) || DEFAULT_WIDTH;
  const base = w === 'full'
    ? 'w-full max-w-none px-3 sm:px-4 xl:px-6 2xl:px-8'
    : w === 'comfortable'
      ? 'w-full max-w-[1600px] mx-auto px-3 sm:px-4 xl:px-6'
      : 'w-full max-w-7xl mx-auto px-2 sm:px-4';
  return `${base} ${extra}`.trim();
}

/**
 * Swap a page's own `max-w-* mx-auto` cap for the chosen width. Pages that
 * carry their container inline (Tickets, TicketDetail, Dashboard …) call this
 * with their existing class string so nothing else about them changes.
 */
const CAP_RE = /\bmax-w-(?:\[[^\]]+\]|\dxl|\d?xl|7xl|6xl|5xl|4xl)\s+mx-auto\b/;
export function applyWidth(className, width) {
  const w = normalizeLayout(width) || DEFAULT_WIDTH;
  const swap = w === 'full'
    ? 'w-full max-w-none xl:px-6 2xl:px-8'
    : w === 'comfortable'
      ? 'w-full max-w-[1600px] mx-auto xl:px-6'
      : 'w-full max-w-7xl mx-auto';
  return CAP_RE.test(className) ? className.replace(CAP_RE, swap) : `${swap} ${className}`;
}

const LayoutContext = createContext(null);
const FALLBACK = { width: DEFAULT_WIDTH, setWidth: () => {}, isFull: true };

export function LayoutProvider({ children }) {
  const [width, setWidthState] = useState(() => readStoredLayout() || DEFAULT_WIDTH);
  const [hasLocalChoice, setHasLocalChoice] = useState(() => readStoredLayout() !== null);
  const saveTimerRef = useRef(null);

  useEffect(() => { stamp(width); }, [width]);

  // Another tab changed the choice — mirror it.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onStorage = (e) => {
      if (e.key !== LAYOUT_STORAGE_KEY) return;
      const next = normalizeLayout(e.newValue);
      if (next) { setWidthState(next); setHasLocalChoice(true); }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // No local choice yet → the server copy seeds it once a workspace is known.
  useEffect(() => {
    if (hasLocalChoice || typeof window === 'undefined') return undefined;
    let cancelled = false;
    const seed = async () => {
      if (!getWorkspaceId()) return;
      try {
        const res = await uiPreferencesAPI.get(LAYOUT_PREF_KEY);
        const value = normalizeLayout(res?.data?.value ?? res?.value);
        if (!cancelled && value) { setWidthState(value); writeStoredLayout(value); setHasLocalChoice(true); }
      } catch { /* default stands */ }
    };
    seed();
    window.addEventListener(WORKSPACE_EVENT, seed);
    return () => { cancelled = true; window.removeEventListener(WORKSPACE_EVENT, seed); };
  }, [hasLocalChoice]);

  useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); }, []);

  const setWidth = useCallback((next) => {
    const value = normalizeLayout(next);
    if (!value) return;
    setWidthState(value);
    setHasLocalChoice(true);
    writeStoredLayout(value);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      uiPreferencesAPI.set(LAYOUT_PREF_KEY, value).catch(() => { /* local copy still applies */ });
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const value = useMemo(() => ({ width, setWidth, isFull: width === 'full' }), [width, setWidth]);
  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayoutWidth() {
  return useContext(LayoutContext) || FALLBACK;
}
