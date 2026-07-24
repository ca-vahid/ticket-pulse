import { useEffect, useRef, useState } from 'react';

/**
 * Cold-load progress for the dashboard (QA 07-23 #6).
 *
 * The dashboard payload arrives as a single awaited GET, so there is no
 * byte-level progress to report. Instead we show a determinate-feeling bar that
 * eases through the real phases of a cold load (connect → load agents →
 * calculate workload) and holds near the end until the data resolves and this
 * overlay unmounts. This replaces the old spinner-only screen so a slow first
 * load on a large workspace (Accounting) reads as "working", not "stuck".
 *
 * Revisiting a workspace you already viewed is now instant (cache is preserved
 * across switches), so this only appears on a genuine cold load.
 */
const PHASES = [
  { until: 25, label: 'Connecting to workspace…' },
  { until: 55, label: 'Loading agents…' },
  { until: 82, label: 'Calculating workload…' },
  { until: 94, label: 'Almost ready…' },
];

export default function DashboardLoadingProgress({ workspaceName }) {
  const [pct, setPct] = useState(6);
  const startRef = useRef(null);

  useEffect(() => {
    let raf;
    const tick = (now) => {
      if (startRef.current === null) startRef.current = now;
      const elapsed = now - startRef.current;
      // Ease toward a 94% ceiling over ~6s; decelerates so a long load doesn't
      // sit pinned at a round number. Never reaches 100 here — data arrival
      // (unmount) is the real completion.
      const target = 94 * (1 - Math.exp(-elapsed / 2600));
      setPct((prev) => (target > prev ? target : prev));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const rounded = Math.min(99, Math.round(pct));
  const phase = PHASES.find((p) => rounded < p.until) || PHASES[PHASES.length - 1];

  return (
    <div
      className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white/85 px-6 py-6 text-center shadow-sm backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <img
        src="/brand/icon-pulse.png"
        alt=""
        className="mx-auto mb-3 h-12 w-12 animate-pulse"
      />
      <p className="text-sm font-semibold text-slate-800">
        Loading {workspaceName ? `${workspaceName} ` : ''}dashboard…
      </p>
      <p className="mt-1 text-xs text-slate-500">{phase.label}</p>

      <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-blue-600 transition-[width] duration-300 ease-out"
          style={{ width: `${Math.max(4, rounded)}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] font-medium text-slate-400">
        <span>Fetching latest tickets</span>
        <span className="tabular-nums text-slate-600">{rounded}%</span>
      </div>
    </div>
  );
}
