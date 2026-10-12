import { useEffect, useRef } from 'react';
import { motion, useAnimationControls } from 'motion/react';

/**
 * Phone ticket card that slides left to show quick actions (12 Oct 2026), the
 * way mail apps and the Freshdesk / Zoho Desk phone apps do.
 *
 * Rules this follows:
 *  - Every action here also has a visible control elsewhere on the card or
 *    toolbar, so nothing depends on being able to swipe.
 *  - Actions carry a word, not only an icon.
 *  - The drag locks to one direction, so scrolling the list never opens a row.
 *
 * `open` is owned by the page so only one row is open at a time.
 */
const ACTION_W = 68;

const TONES = {
  blue: 'bg-blue-600 text-white',
  emerald: 'bg-emerald-600 text-white',
  slate: 'bg-slate-600 text-white',
};

export default function PhoneSwipeRow({ actions = [], open = false, onOpenChange, className = '', children }) {
  const controls = useAnimationControls();
  const dragged = useRef(false);
  const width = actions.length * ACTION_W;

  useEffect(() => {
    controls.start({ x: open ? -width : 0 });
  }, [open, width, controls]);

  if (actions.length === 0) return <div className={className}>{children}</div>;

  return (
    <div className="relative overflow-hidden" data-testid="phone-swipe-row" data-open={open ? 'true' : 'false'}>
      <div className="absolute inset-y-0 right-0 flex" aria-hidden={!open}>
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            tabIndex={open ? 0 : -1}
            onClick={(e) => { e.stopPropagation(); onOpenChange?.(false); a.onClick(); }}
            data-testid={`swipe-${a.key}`}
            className={`tp-focus-ring flex flex-col items-center justify-center gap-1 text-[11px] font-semibold ${TONES[a.tone] || TONES.slate}`}
            style={{ width: ACTION_W }}
          >
            <a.Icon className="h-[18px] w-[18px]" aria-hidden="true" />
            {a.label}
          </button>
        ))}
      </div>
      <motion.div
        drag="x"
        dragDirectionLock
        dragMomentum={false}
        dragElastic={0.04}
        dragConstraints={{ left: -width, right: 0 }}
        animate={controls}
        transition={{ type: 'spring', stiffness: 520, damping: 42 }}
        onDragStart={() => { dragged.current = true; }}
        onDragEnd={(_e, info) => {
          const next = info.offset.x < -40 ? true : info.offset.x > 40 ? false : open;
          controls.start({ x: next ? -width : 0 });
          if (next !== open) onOpenChange?.(next);
          // The click that ends a drag must not open the ticket.
          setTimeout(() => { dragged.current = false; }, 0);
        }}
        onClickCapture={(e) => {
          if (dragged.current) { e.stopPropagation(); e.preventDefault(); return; }
          if (open) { e.stopPropagation(); e.preventDefault(); onOpenChange?.(false); }
        }}
        style={{ touchAction: 'pan-y' }}
        className={`relative bg-card ${className}`}
      >
        {children}
      </motion.div>
    </div>
  );
}
