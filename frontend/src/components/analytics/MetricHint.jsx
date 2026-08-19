import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { getMetricHint } from '../../utils/metricsGlossary';

/**
 * Small ⓘ affordance that explains what a metric means (QA 08-17 #5).
 * Extracted from Analytics.jsx's StatCardInfo so every number surface —
 * stat cards, table headers, panel titles, the Reports tab — shares one
 * accessible primitive.
 *
 * API:
 *   <MetricHint metric="rebounds" />       — glossary lookup (preferred)
 *   <MetricHint title="..." info="..." />  — escape hatch for bespoke copy
 * Explicit `title`/`info` win over the glossary entry when both are given.
 *
 * Behavior (unchanged from the original): shows a positioned popover on hover
 * AND keyboard focus, closes on Escape/blur, clamps to the viewport edges, and
 * only animates when the user hasn't asked for reduced motion (motion-safe —
 * animate-fadeIn respects prefers-reduced-motion via the Tailwind setup).
 */
export function MetricHint({ metric, title, info, className = '' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const buttonRef = useRef(null);
  const popoverRef = useRef(null);
  const popoverId = useId();

  const entry = metric ? getMetricHint(metric) : null;
  const heading = title || entry?.label || 'This metric';
  const definition = info || entry?.definition || null;
  const formula = info ? null : entry?.formula || null;
  const caveats = info ? null : entry?.caveats || null;

  // Position the popover with `fixed` coordinates measured from the trigger:
  // hints live inside overflow-hidden panels and overflow-auto table shells,
  // where an absolutely-positioned child would be clipped. Fixed positioning
  // escapes every clip while the viewport clamp below keeps it on screen.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const btn = buttonRef.current;
    const el = popoverRef.current;
    if (!btn || !el) return;
    const btnRect = btn.getBoundingClientRect();
    const margin = 8;
    const width = el.offsetWidth || 240;
    const height = el.offsetHeight || 0;
    let left = btnRect.right - width; // right-aligned to the ⓘ, like the original
    left = Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - margin - width));
    let top = btnRect.bottom + 6;
    if (top + height > window.innerHeight - margin) {
      top = Math.max(margin, btnRect.top - 6 - height); // flip above near the bottom edge
    }
    setPos({ top, left });
  }, [open]);

  // Nothing to explain (unknown key without explicit copy): render nothing
  // rather than a dead ⓘ.
  if (!definition) return null;

  return (
    <span className={`relative inline-flex print:hidden ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`What "${heading}" means`}
        aria-describedby={open ? popoverId : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
        className="tp-focus-ring -m-1 rounded-full p-1 text-slate-400 transition-colors hover:text-slate-600"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={popoverRef}
          id={popoverId}
          role="tooltip"
          style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
          className="animate-fadeIn fixed z-50 w-60 whitespace-normal rounded-lg border border-slate-200 bg-white p-2.5 text-left font-normal shadow-lg"
        >
          <p className="text-[10px] font-semibold uppercase tracking-normal text-slate-400">{heading}</p>
          <p className="mt-1 text-xs font-normal normal-case leading-relaxed tracking-normal text-slate-600">{definition}</p>
          {formula && (
            <p className="mt-1.5 rounded bg-slate-50 px-1.5 py-1 font-mono text-[10px] normal-case leading-snug tracking-normal text-slate-500">{formula}</p>
          )}
          {caveats && (
            <p className="mt-1.5 text-[11px] font-normal normal-case leading-relaxed tracking-normal text-slate-400">{caveats}</p>
          )}
        </div>
      )}
    </span>
  );
}

/** Back-compat alias: StatCard's original internal name. */
export const StatCardInfo = MetricHint;

export default MetricHint;
