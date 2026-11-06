import { useEffect, useState } from 'react';

/**
 * `value`, but turning true only after it has stayed true for `delayMs`
 * (false is immediate). A refetch that answers within the delay never shows
 * its "updating" look, so fast responses don't flicker (5 Nov 2026).
 */
export function useDelayedFlag(value, delayMs = 150) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!value) { setShown(false); return undefined; }
    const t = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return Boolean(value) && shown;
}
