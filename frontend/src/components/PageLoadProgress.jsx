import { useEffect, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// PageLoadProgress — thin top-of-page bar with an honest count of the page's
// own requests: "Loading 3 of 5 · 60%" (QA 09-25 slow agent page).
//
// Pass the page's requests as `steps: [{ key, loading }]`. A "round" starts
// when anything begins loading and collects every key that loads before the
// page goes idle again, so a period change that refetches one request shows
// "1 of 1", not "4 of 5". When the round completes the bar fills, fades and
// unmounts. Motion follows the app preference (motion-off: variant).
// ─────────────────────────────────────────────────────────────────────────────

const FADE_MS = 450;

export function progressOf(round, loadingKeys) {
  const total = round.length;
  const done = round.filter((k) => !loadingKeys.includes(k)).length;
  const pct = total ? Math.round((done / total) * 100) : 100;
  return { total, done, pct };
}

export default function PageLoadProgress({ steps = [], label = 'Loading' }) {
  const loadingKeys = steps.filter((s) => s.loading).map((s) => s.key);
  const loadingSig = loadingKeys.join('|');

  const [state, setState] = useState(() => ({
    round: loadingKeys,
    phase: loadingKeys.length ? 'active' : 'idle', // active → finishing → idle
  }));

  useEffect(() => {
    const keys = loadingSig ? loadingSig.split('|') : [];
    if (keys.length) {
      setState((prev) => {
        const base = prev.phase === 'active' ? prev.round : [];
        const merged = [...new Set([...base, ...keys])];
        if (prev.phase === 'active' && merged.length === prev.round.length) return prev;
        return { round: merged, phase: 'active' };
      });
      return undefined;
    }
    setState((prev) => (prev.phase === 'active' ? { ...prev, phase: 'finishing' } : prev));
    const timer = setTimeout(() => {
      setState((prev) => (prev.phase === 'finishing' ? { round: [], phase: 'idle' } : prev));
    }, FADE_MS);
    return () => clearTimeout(timer);
  }, [loadingSig]);

  if (state.phase === 'idle' || state.round.length === 0) return null;

  const finishing = state.phase === 'finishing';
  const { total, done, pct } = finishing
    ? { total: state.round.length, done: state.round.length, pct: 100 }
    : progressOf(state.round, loadingKeys);
  // "done of total", matching the percentage (3 of 5 · 60%).
  const text = `${label} ${done} of ${total} · ${pct}%`;

  return (
    <div
      className={`pointer-events-none fixed inset-x-0 top-0 z-50 transition-opacity duration-300 ease-out motion-off:transition-none ${finishing ? 'opacity-0' : 'opacity-100'}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={text}
    >
      <div className="h-0.5 w-full bg-primary/15">
        <div
          className="h-full bg-primary transition-[width] duration-300 ease-out motion-off:transition-none"
          // A sliver while the first request is in flight so the bar reads as alive.
          style={{ width: `${Math.max(pct, 6)}%` }}
        />
      </div>
      <div className="flex justify-end px-3 pt-1 sm:px-6">
        <span className="rounded-md bg-card/90 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground shadow-subtle">
          {text}
        </span>
      </div>
    </div>
  );
}
