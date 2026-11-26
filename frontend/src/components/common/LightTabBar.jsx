import { useEffect, useRef } from 'react';
import { motionReduced } from '../../utils/motionPreference';

/**
 * The light section tab bar (Knowledge redesign, 26 Sep 2026). Every section
 * with sub-tabs uses it; Assignment moved over on 12 Oct 2026.
 *
 * tabs: [{ id, label, icon: LucideIcon, badge?: number, badgeLabel?: string, title?: string }]
 * A badge is part of the tab's accessible name ("Gaps, 3 new"; badgeLabel
 * replaces "new"), so a screen reader announces the count too.
 * WAI-ARIA tabs pattern: roving tabindex, arrow keys, Home/End. The selected
 * tab gets a soft blue fill and an underline accent. Labels show at every
 * width since 12 Oct 2026 (six bare icons on a phone said nothing); the row
 * scrolls sideways when the tabs do not fit. `children` renders
 * at the right end of the row — the page's actions for the open tab; below
 * `sm` they wrap onto their own row instead of squeezing the tabs.
 */
/** The tab's accessible name: its label, plus the badge count when there is one. */
export function tabAccessibleName(tab) {
  const n = Number(tab?.badge) || 0;
  return n > 0 ? `${tab.label}, ${n} ${tab.badgeLabel || 'new'}` : tab?.label;
}

/** The row's scroll-padding at the start (tp-swipe-row: 1rem), where a snapped tab starts. */
function snapPadding(row) {
  try {
    const v = parseFloat(window.getComputedStyle(row).scrollPaddingLeft);
    return Number.isFinite(v) ? v : 0;
  } catch { return 0; }
}

/**
 * The row's scrollLeft that brings `tab` into view, or null when the whole tab
 * is already visible. The row snaps each tab's start (tp-swipe-row), and a
 * scroll to anything but a snap point is snapped back, so this is the tab's
 * START less the scroll-padding: a valid snap position.
 */
export function tabScrollLeft(row, tab, pad = snapPadding(row)) {
  const r = row.getBoundingClientRect();
  const t = tab.getBoundingClientRect();
  if (t.left >= r.left && t.right <= r.right) return null;
  const start = row.scrollLeft + (t.left - r.left) - (row.clientLeft || 0);
  return Math.max(0, Math.round(start - pad));
}

export default function LightTabBar({ tabs, activeId, onSelect, ariaLabel, idPrefix = 'tab', children = null, className = '' }) {
  const refs = useRef({});
  const rowRef = useRef(null);
  const mounted = useRef(false);
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === activeId));

  // QA 11-25: on a phone the row scrolls sideways and the selected tab could sit
  // cut off at the edge. Bring it into view on open (at once) and on change
  // (smoothly, unless the app's motion setting is off). Only the row's own
  // scrollLeft moves, so the page never scrolls up or down.
  useEffect(() => {
    const el = refs.current[activeId];
    const row = rowRef.current;
    const smooth = mounted.current && !motionReduced();
    mounted.current = true;
    if (!el || !row) return;
    const left = tabScrollLeft(row, el);
    if (left == null) return;
    if (typeof row.scrollTo === 'function') row.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    else row.scrollLeft = left;
  }, [activeId, tabs.length]);

  const onKeyDown = (e) => {
    let next = null;
    if (e.key === 'ArrowRight') next = (activeIndex + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (activeIndex - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    refs.current[tabs[next].id]?.focus();
    onSelect(tabs[next].id);
  };

  return (
    <div className={`mb-5 flex flex-wrap items-end gap-x-3 gap-y-2 border-b border-border ${className}`} data-testid="light-tab-bar">
      <div
        ref={rowRef}
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        className="tp-swipe-row -mb-px flex min-w-0 max-w-full items-end gap-0.5 overflow-x-auto overflow-y-hidden max-sm:-mx-4 max-sm:w-[calc(100%+2rem)] max-sm:max-w-[calc(100%+2rem)] max-sm:px-4"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.id === activeId;
          return (
            <button
              key={tab.id}
              ref={(el) => { refs.current[tab.id] = el; }}
              type="button"
              role="tab"
              id={`${idPrefix}-tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`${idPrefix}-panel-${tab.id}`}
              aria-label={tabAccessibleName(tab)}
              title={tab.title}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              className={`relative flex h-11 flex-shrink-0 snap-start items-center gap-1.5 whitespace-nowrap rounded-t-lg border-b-2 px-2.5 text-sm sm:gap-2 font-medium transition-colors touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4 ${
                isActive
                  ? 'border-primary bg-primary/[0.07] text-primary dark:bg-primary/15'
                  : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
            >
              {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
              <span>{tab.label}</span>
              {tab.badge > 0 && (
                <span aria-hidden="true" className="ml-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold leading-none text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {children && (
        <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 pb-2">{children}</div>
      )}
    </div>
  );
}
