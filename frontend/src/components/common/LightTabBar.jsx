import { useRef } from 'react';

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

export default function LightTabBar({ tabs, activeId, onSelect, ariaLabel, idPrefix = 'tab', children = null, className = '' }) {
  const refs = useRef({});
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === activeId));

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
