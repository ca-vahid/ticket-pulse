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
        className="p-1.5 rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
        title="Column legend"
        aria-label="Show column legend"
      >
        <Info className="w-4 h-4" />
      </button>

      {open && pos && createPortal(
        <div
          className="fixed z-[100] bg-white border border-gray-200 rounded-lg shadow-xl p-3 min-w-[240px] pointer-events-none"
          style={{
            // Right-align to the trigger so the popup opens to the left,
            // never spilling off the viewport edge.
            left: pos.left,
            top: pos.top,
            transform: 'translateX(-100%)',
          }}
        >
          <div className="text-[10px] uppercase font-bold text-gray-500 mb-2 tracking-wide">Column legend</div>
          <ul className="space-y-1 text-xs">
            {showOpen && (
              <li><span className="font-semibold text-gray-700">Open</span> <span className="text-gray-500">— all open tickets</span></li>
            )}
            <li><span className="font-semibold text-blue-600">Today</span> <span className="text-gray-500">— total today</span></li>
            <li><span className="font-semibold text-purple-600">Self</span> <span className="text-gray-500">— self-picked</span></li>
            <li><span className="font-semibold text-sky-600">App</span> <span className="text-gray-500">— app assigned</span></li>
            <li><span className="font-semibold text-orange-600">Asgn</span> <span className="text-gray-500">— coordinator assigned</span></li>
            <li><span className="font-semibold text-green-600">Done</span> <span className="text-gray-500">— closed</span></li>
            <li><span className="font-semibold text-yellow-600">⭐ CSAT</span> <span className="text-gray-500">— customer satisfaction</span></li>
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}
