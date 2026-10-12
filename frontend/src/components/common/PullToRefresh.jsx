import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

const THRESHOLD = 64;
const MAX = 96;

/**
 * Pull down to refresh, for touch screens (12 Oct 2026). Renders only the
 * small indicator; the page under it does not move.
 *
 * Starts only when the page is scrolled to the very top, the finger moves
 * mostly downwards, and nothing is open over the page (sheet, dialog, menu).
 * While mounted it also turns off the browser's own pull-to-reload, which
 * would reload the whole site instead of the list.
 */
export default function PullToRefresh({ onRefresh, disabled = false }) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const state = useRef({ startY: 0, startX: 0, tracking: false, pulling: false, pull: 0, busy: false });
  const refreshRef = useRef(onRefresh);
  useEffect(() => { refreshRef.current = onRefresh; }, [onRefresh]);

  useEffect(() => {
    if (disabled) return undefined;
    if (!window.matchMedia?.('(pointer: coarse)')?.matches) return undefined;
    const s = state.current;
    const root = document.documentElement;
    const prevOverscroll = root.style.overscrollBehaviorY;
    root.style.overscrollBehaviorY = 'contain';

    const blocked = (target) => {
      if (document.body.style.overflow === 'hidden') return true;
      const el = target instanceof Element ? target : null;
      return Boolean(el?.closest('[role="dialog"], [role="listbox"], [role="menu"], [data-vaul-drawer], [data-no-pull]'));
    };
    const set = (v) => { s.pull = v; setPull(v); };

    const onStart = (e) => {
      s.tracking = false; s.pulling = false;
      if (s.busy || e.touches.length !== 1 || window.scrollY > 0 || blocked(e.target)) return;
      s.startY = e.touches[0].clientY; s.startX = e.touches[0].clientX; s.tracking = true;
    };
    const onMove = (e) => {
      if (!s.tracking) return;
      const dy = e.touches[0].clientY - s.startY;
      const dx = e.touches[0].clientX - s.startX;
      if (!s.pulling) {
        if (dy < -4 || Math.abs(dx) > Math.abs(dy)) { s.tracking = false; return; }
        if (dy < 10) return;
        if (window.scrollY > 0) { s.tracking = false; return; }
        s.pulling = true;
      }
      if (e.cancelable) e.preventDefault();
      set(Math.max(0, Math.min(MAX, (dy - 10) * 0.55)));
    };
    const onEnd = () => {
      if (!s.tracking) return;
      s.tracking = false;
      if (!s.pulling) return;
      s.pulling = false;
      if (s.pull < THRESHOLD) { set(0); return; }
      s.busy = true; setBusy(true); set(THRESHOLD);
      Promise.resolve()
        .then(() => refreshRef.current?.())
        .catch(() => { /* the page shows its own error */ })
        .finally(() => { s.busy = false; setBusy(false); set(0); });
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      root.style.overscrollBehaviorY = prevOverscroll;
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, [disabled]);

  if (pull <= 0 && !busy) return null;
  const ready = pull >= THRESHOLD;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[45] flex justify-center"
      style={{ transform: `translateY(${Math.round(pull) - 8}px)`, paddingTop: 'env(safe-area-inset-top, 0px)' }}
      data-testid="pull-to-refresh"
      data-ready={ready ? 'true' : 'false'}
      role="status"
      aria-live="polite"
    >
      <span className={`inline-flex h-9 w-9 items-center justify-center rounded-full border bg-card shadow-soft ${ready ? 'border-blue-300 text-blue-600 dark:border-blue-500/40 dark:text-blue-300' : 'border-border text-muted-foreground'}`}>
        <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} style={busy ? undefined : { transform: `rotate(${Math.round(pull * 3.2)}deg)` }} aria-hidden="true" />
        <span className="sr-only">{busy ? 'Refreshing' : ready ? 'Release to refresh' : 'Pull to refresh'}</span>
      </span>
    </div>
  );
}
