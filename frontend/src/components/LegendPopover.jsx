import { Info } from 'lucide-react';
import { useState, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Compact info-icon button that pops a legend on hover. Used to replace the
 * full-width legend strip on the dashboard so the controls row stays tight.
 *
 * Renders the popup via a Portal at document.body so it escapes any parent
 * stacking contexts (the dashboard rows live under animation wrappers that
 * trap z-index, so a plain absolute popup would get clipped behind the
 * sticky table header).
 */
export default function LegendPopover({ showOpen = false }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setPos({ left: rect.right, top: rect.bottom + 6 });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="p-1.5 rounded-full text-muted-foreground/75 hover:text-foreground/85 hover:bg-muted transition-colors"
        title="Column legend"
        aria-label="Show column legend"
      >
        <Info className="w-4 h-4" />
      </button>

      {open && pos && createPortal(
        <div
          className="fixed z-[100] bg-card border border-border rounded-lg shadow-xl p-3 min-w-[240px] pointer-events-none"
          style={{
            // Right-align to the trigger so the popup opens to the left,
            // never spilling off the viewport edge.
            left: pos.left,
            top: pos.top,
            transform: 'translateX(-100%)',
          }}
        >
          <div className="text-[10px] uppercase font-bold text-muted-foreground mb-2 tracking-wide">Column legend</div>
          <ul className="space-y-1 text-xs">
            {showOpen && (
              <li><span className="font-semibold text-foreground/85">Open</span> <span className="text-muted-foreground">— all open tickets</span></li>
            )}
            <li><span className="font-semibold text-blue-600 dark:text-blue-300">Today</span> <span className="text-muted-foreground">— total today</span></li>
            <li><span className="font-semibold text-purple-600 dark:text-purple-300">Self</span> <span className="text-muted-foreground">— self-picked</span></li>
            <li><span className="font-semibold text-sky-600 dark:text-sky-300">App</span> <span className="text-muted-foreground">— app assigned</span></li>
            <li><span className="font-semibold text-orange-600 dark:text-orange-300">Asgn</span> <span className="text-muted-foreground">— coordinator assigned</span></li>
            <li><span className="font-semibold text-green-600 dark:text-green-300">Done</span> <span className="text-muted-foreground">— closed</span></li>
            <li><span className="font-semibold text-yellow-600 dark:text-yellow-300">⭐ CSAT</span> <span className="text-muted-foreground">— customer satisfaction</span></li>
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}
