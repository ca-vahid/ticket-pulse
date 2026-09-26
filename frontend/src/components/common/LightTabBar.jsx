import { useRef } from 'react';

/**
 * The light section tab bar (Knowledge redesign, 26 Sep 2026 — Vahid chose
 * light tabs for Knowledge; Assignment keeps GradientTabBar).
 *
 * tabs: [{ id, label, icon: LucideIcon, badge?: number, badgeLabel?: string, title?: string }]
 * A badge is part of the tab's accessible name ("Gaps, 3 new"; badgeLabel
 * replaces "new"), so a screen reader announces the count too.
 * WAI-ARIA tabs pattern: roving tabindex, arrow keys, Home/End. The selected
 * tab gets a soft blue fill and an underline accent. Labels hide below `sm`
 * (the icon keeps an aria-label so the tab stays named). `children` renders
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
        className="-mb-px flex min-w-0 max-w-full items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
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
              className={`relative flex h-11 items-center gap-2 whitespace-nowrap rounded-t-lg border-b-2 px-3 text-sm font-medium transition-colors touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4 ${
                isActive
                  ? 'border-primary bg-primary/[0.07] text-primary dark:bg-primary/15'
                  : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
            >
              {Icon && <Icon className="h-[18px] w-[18px] sm:h-4 sm:w-4" aria-hidden="true" />}
              <span className="hidden sm:inline">{tab.label}</span>
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
