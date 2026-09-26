import { useRef } from 'react';

/**
 * The blue→purple tab bar the Assignment page introduced, shared so every
 * main section that has sub-tabs looks the same (Knowledge, 26 Sep 2026).
 *
 * tabs: [{ id, label, icon: LucideIcon, badge?: number, title?: string }]
 * Tabs follow the WAI-ARIA tabs pattern (roving tabindex, arrow keys,
 * Home/End). Labels hide below `sm` like the Assignment bar; the icon keeps an
 * aria-label so the tab stays named. `children` renders at the right end
 * (e.g. a time-range filter).
 */
export default function GradientTabBar({ tabs, activeId, onSelect, ariaLabel, idPrefix = 'tab', children = null, className = '' }) {
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
    <div className={`flex-shrink-0 pb-3 ${className}`}>
      <div className="bg-gradient-to-r from-blue-600 to-purple-600 rounded-lg shadow-md px-1.5 sm:px-2 py-1 flex items-center gap-0.5 sm:gap-1 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        <div role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown} className="flex items-center gap-0.5 sm:gap-1">
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
                aria-label={tab.label}
                title={tab.title}
                tabIndex={isActive ? 0 : -1}
                onClick={() => onSelect(tab.id)}
                className={`flex items-center gap-1.5 px-3 sm:px-4 py-2.5 sm:py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${
                  isActive
                    ? 'bg-white/25 text-white shadow-sm'
                    : 'text-white opacity-70 hover:bg-white/15 hover:opacity-100'
                }`}
              >
                {Icon && <Icon className="w-5 h-5 sm:w-4 sm:h-4" aria-hidden="true" />}
                <span className="hidden sm:inline">{tab.label}</span>
                {tab.badge > 0 && (
                  <span className="ml-0.5 rounded-full bg-amber-300 px-1.5 py-0.5 text-[10px] font-bold leading-none text-amber-950 dark:text-amber-200">
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {children}
      </div>
    </div>
  );
}
