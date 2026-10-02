import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { motionReduced } from '../../utils/motionPreference';

/**
 * Sideways scrolling for the wide Tickets list (2 Oct 2026, mockup round 2 —
 * Vahid picked C + E + F):
 *  C  soft edge fades + round arrows that glide in, follow the visible middle
 *     of the list and page one screen of columns with an eased slide (hold to
 *     keep going). With the subject pinned, the left ones start at column B.
 *  E  drag the list sideways with the mouse, ← / → (Shift = a page) anywhere on
 *     the page outside a field. Shift + wheel is the browser's own.
 *  D  an opt-in column map (jump links + mini-map) — a personal setting in
 *     the Columns menu, off by default because it costs a toolbar row.
 * F (the pinned checkbox + subject) is CSS: `.tp-q-pin` in index.css; this
 * component only measures where the pinned block ends and stamps
 * `data-scrolled` on the scroller for its edge shadow.
 */

// Fields and resize handles keep their own drags. Buttons and links don't:
// the list's cells are mostly full-width pickers, so a drag may start on one —
// a press that never moves is still a normal click.
const DRAG_IGNORE = 'input,select,textarea,[role="separator"],[role="slider"],[contenteditable="true"],[data-no-drag]';

export default function QueueSideScroll({ targetRef, pinned = false, showMap = false, deps = [], children }) {
  const frameRef = useRef(null);
  const animRef = useRef(0);
  const [edges, setEdges] = useState({ left: false, right: false, pinW: 0, top: 0, ready: false });
  const [map, setMap] = useState({ cols: [], total: 0, x: 0, client: 0 });

  const measure = useCallback(() => {
    const el = targetRef.current; const frame = frameRef.current;
    if (!el || !frame) return;
    const max = el.scrollWidth - el.clientWidth;
    const x = el.scrollLeft;
    const left = max > 1 && x > 2;
    const right = max > 1 && x < max - 2;
    if (left) el.setAttribute('data-scrolled', ''); else el.removeAttribute('data-scrolled');
    let pinW = 0;
    if (pinned) {
      const end = el.querySelector('[data-pin-end]');
      if (end && end.offsetParent) pinW = Math.max(0, Math.round(end.getBoundingClientRect().right - el.getBoundingClientRect().left));
    }
    // Arrows ride the middle of the part of the list that is on screen.
    const r = frame.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const mid = (Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2 - r.top - 18;
    const top = Math.round(Math.max(12, Math.min(r.height - 48, mid)));
    setEdges((p) => (p.left === left && p.right === right && p.pinW === pinW && p.top === top && p.ready
      ? p : { left, right, pinW, top, ready: true }));
    if (showMap) {
      // Positions in the scrolled content (rect + scrollLeft), so a sticky
      // cell or an intermediate offsetParent can't skew them.
      const base = el.getBoundingClientRect().left - x;
      const cols = [...el.querySelectorAll('[data-qcol]')]
        .filter((c) => c.offsetParent && !(pinned && c.hasAttribute('data-pin-end')))
        .map((c) => {
          const cr = c.getBoundingClientRect();
          return { key: c.dataset.qcol, label: c.dataset.qlabel || c.dataset.qcol, left: Math.round(cr.left - base), width: Math.round(cr.width) };
        });
      setMap({ cols, total: el.scrollWidth, x, client: el.clientWidth });
    }
  }, [targetRef, pinned, showMap]);

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return undefined;
    measure();
    let raf = 0;
    const onAny = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    el.addEventListener('scroll', onAny, { passive: true });
    // Capture: the page may scroll in a container, not the window.
    window.addEventListener('scroll', onAny, { passive: true, capture: true });
    window.addEventListener('resize', onAny);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onAny) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', onAny);
      window.removeEventListener('scroll', onAny, { capture: true });
      window.removeEventListener('resize', onAny);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetRef, measure, ...deps]);

  // Eased glide (ease-out cubic, 420 ms) — the arrows, keys and map share it.
  const glideTo = useCallback((target) => {
    const el = targetRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const to = Math.max(0, Math.min(max, target));
    const from = el.scrollLeft;
    cancelAnimationFrame(animRef.current);
    if (motionReduced() || Math.abs(to - from) < 2) { el.scrollLeft = to; return; }
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / 420);
      el.scrollLeft = from + (to - from) * (1 - (1 - t) ** 3);
      if (t < 1) animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
  }, [targetRef]);
  useEffect(() => () => cancelAnimationFrame(animRef.current), []);

  const pageBy = useCallback((dir) => {
    const el = targetRef.current;
    if (!el) return;
    glideTo(el.scrollLeft + dir * Math.max(160, el.clientWidth - edges.pinW - 96));
  }, [targetRef, glideTo, edges.pinW]);

  // Hold an arrow to keep going.
  const holdRef = useRef(null);
  const startHold = (dir) => {
    clearTimeout(holdRef.current);
    holdRef.current = setTimeout(function tick() {
      const el = targetRef.current;
      if (!el) return;
      cancelAnimationFrame(animRef.current);
      el.scrollLeft += dir * 14;
      holdRef.current = setTimeout(tick, 16);
    }, 450);
  };
  const stopHold = () => clearTimeout(holdRef.current);
  useEffect(() => () => clearTimeout(holdRef.current), []);

  // E: drag the list with the mouse (touch already pans natively). A drag
  // that moved swallows the click that follows, so it never opens a row or a
  // picker; links' native drag-and-drop is held off while it runs.
  useEffect(() => {
    const el = targetRef.current;
    if (!el) return undefined;
    let drag = null;
    const onDown = (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      if (el.scrollWidth <= el.clientWidth + 1) return;
      if (e.target.closest(DRAG_IGNORE)) return;
      drag = { x: e.clientX, left: el.scrollLeft, moved: false };
    };
    const onMove = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 6) return;
      if (!drag.moved) {
        drag.moved = true;
        cancelAnimationFrame(animRef.current);
        el.setAttribute('data-dragging', '');
        window.getSelection?.()?.removeAllRanges();
      }
      el.scrollLeft = drag.left - dx;
    };
    let swallowUntil = 0;
    const onClick = (ev) => { if (Date.now() < swallowUntil) { ev.stopPropagation(); ev.preventDefault(); } };
    const onUp = () => {
      if (!drag) return;
      if (drag.moved) {
        el.removeAttribute('data-dragging');
        swallowUntil = Date.now() + 250;
      }
      drag = null;
    };
    const onDragStart = (ev) => { if (drag) ev.preventDefault(); };
    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('click', onClick, { capture: true });
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('dragstart', onDragStart);
      el.removeEventListener('click', onClick, { capture: true });
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [targetRef]);

  // E: ← / → (Shift = a page). ↑ ↓ j k stay the queue's row keys.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable || t.closest?.('[role="dialog"],[role="menu"],[role="listbox"],[role="slider"],[role="separator"],[role="tablist"]'))) return;
      const el = targetRef.current;
      if (!el || el.scrollWidth <= el.clientWidth + 1 || !el.offsetParent) return;
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (e.shiftKey) pageBy(dir); else glideTo(el.scrollLeft + dir * 240);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [targetRef, glideTo, pageBy]);

  const goToCol = (col) => glideTo(col.left - edges.pinW - 8);
  const overflowing = edges.left || edges.right;
  const jumpable = map.cols.filter((c) => c.left >= edges.pinW - 2);

  return (
    <>
      {showMap && overflowing && map.total > 0 && (
        <div className="hidden md:flex items-center gap-3 px-3 py-1.5 border-b border-border/60 text-xs animate-fadeIn" data-testid="queue-column-map">
          <span className="text-muted-foreground/75 flex-shrink-0">Jump to</span>
          <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto tp-scrollbar-none">
            {jumpable.map((c) => {
              const inView = c.left + c.width > map.x + edges.pinW && c.left < map.x + map.client;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => goToCol(c)}
                  className={`tp-focus-ring whitespace-nowrap rounded-md px-1.5 py-0.5 transition-colors ${inView ? 'text-foreground font-medium' : 'text-primary hover:bg-muted'}`}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          <div
            role="slider"
            tabIndex={0}
            aria-label="Column map — click to jump"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((map.x / Math.max(1, map.total - map.client)) * 100)}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              glideTo(((e.clientX - r.left) / r.width) * map.total - map.client / 2);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); pageBy(e.key === 'ArrowRight' ? 1 : -1); }
            }}
            className="tp-focus-ring relative ml-auto hidden lg:block h-4 w-44 flex-shrink-0 cursor-pointer rounded bg-muted overflow-hidden"
          >
            {map.cols.map((c) => (
              <i key={c.key} title={c.label} className="absolute inset-y-[3px] border-r border-card bg-muted-foreground/25" style={{ left: `${(c.left / map.total) * 100}%`, width: `${(c.width / map.total) * 100}%` }} />
            ))}
            <span
              aria-hidden="true"
              className="absolute inset-y-0 rounded border-2 border-primary bg-primary/10 transition-[left] duration-75"
              style={{ left: `${(map.x / map.total) * 100}%`, width: `${(map.client / map.total) * 100}%` }}
            />
          </div>
        </div>
      )}
      <div ref={frameRef} className="relative">
        {children}
        {edges.ready && (
          <>
            <span
              aria-hidden="true"
              className={`tp-side-fade tp-side-fade-l ${edges.left ? 'is-on' : ''}`}
              style={{ left: edges.pinW }}
            />
            <span aria-hidden="true" className={`tp-side-fade tp-side-fade-r ${edges.right ? 'is-on' : ''}`} />
            <button
              type="button"
              tabIndex={-1}
              aria-label="Scroll columns left"
              title="Scroll columns left (←) · hold to keep going"
              onClick={() => pageBy(-1)}
              onPointerDown={() => startHold(-1)}
              onPointerUp={stopHold}
              onPointerLeave={stopHold}
              onPointerCancel={stopHold}
              className={`tp-side-arrow tp-side-arrow-l ${edges.left ? 'is-on' : ''}`}
              style={{ top: edges.top, left: edges.pinW + 10 }}
            >
              <ChevronLeft className="w-5 h-5" aria-hidden="true" />
            </button>
            <button
              type="button"
              tabIndex={-1}
              aria-label="Scroll columns right"
              title="Scroll columns right (→) · hold to keep going"
              onClick={() => pageBy(1)}
              onPointerDown={() => startHold(1)}
              onPointerUp={stopHold}
              onPointerLeave={stopHold}
              onPointerCancel={stopHold}
              className={`tp-side-arrow tp-side-arrow-r ${edges.right ? 'is-on' : ''}`}
              style={{ top: edges.top }}
            >
              <ChevronRight className="w-5 h-5" aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </>
  );
}
