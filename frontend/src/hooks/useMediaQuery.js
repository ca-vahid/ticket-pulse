import { useEffect, useState } from 'react';

/**
 * True while the CSS media query matches. Where matchMedia is missing (jsdom,
 * very old browsers) it returns `fallback` — false unless the caller says
 * otherwise (the app header passes true so its desktop layout stays the default).
 */
export default function useMediaQuery(query, { fallback = false } = {}) {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return fallback;
    return Boolean(window.matchMedia(query)?.matches);
  });
  useEffect(() => {
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
    if (!mq) return undefined;
    const on = () => setMatches(Boolean(mq.matches));
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return matches;
}
