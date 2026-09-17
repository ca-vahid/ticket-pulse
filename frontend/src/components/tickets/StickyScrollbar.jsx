import { useEffect, useRef, useState } from 'react';

/**
 * A horizontal scrollbar that stays at the bottom of the viewport while a wide
 * list scrolls with the page (16 Sep 2026 — dense rows keep to one line, so
 * the list can be wider than the screen; nobody should have to scroll to the
 * foot of 25 rows to reach the columns on the right). Mirrors the target's
 * scrollLeft both ways; renders nothing while the target does not overflow.
 */
export default function StickyScrollbar({ targetRef, deps = [] }) {
  const barRef = useRef(null);
  const [size, setSize] = useState({ scroll: 0, client: 0 });

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return undefined;
    const measure = () => setSize({ scroll: el.scrollWidth, client: el.clientWidth });
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    const onScroll = () => {
      const bar = barRef.current;
      if (bar && Math.abs(bar.scrollLeft - el.scrollLeft) > 1) bar.scrollLeft = el.scrollLeft;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { ro?.disconnect(); el.removeEventListener('scroll', onScroll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetRef, ...deps]);

  if (size.scroll <= size.client + 1) return null;
  return (
    <div
      ref={barRef}
      data-testid="sticky-scrollbar"
      aria-hidden="true"
      onScroll={(e) => {
        const el = targetRef.current;
        if (el && Math.abs(el.scrollLeft - e.currentTarget.scrollLeft) > 1) el.scrollLeft = e.currentTarget.scrollLeft;
      }}
      className="tp-sticky-hscroll sticky bottom-0 z-10 h-3 overflow-x-auto overflow-y-hidden bg-card/95 backdrop-blur-sm"
    >
      <div style={{ width: size.scroll, height: 1 }} />
    </div>
  );
}
