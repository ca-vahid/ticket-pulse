import { CircleDot, Hand, Send, CheckCircle2, Star } from 'lucide-react';

/**
 * Single metric cell. Renders as a plain div, OR as a button when both
 * `viewId` and `onSelect` are provided — used by the Tickets tab to make
 * the ribbon double as the sub-view selector. Active state is signalled
 * with a ring + bolder background so it reads as "you are here" without
 * adding a separate row of pills below.
 */
function Metric({ icon: Icon, iconClass, label, value, sub, viewId, activeViewId, onSelect, isZero }) {
  const isActive = viewId && activeViewId === viewId;
  const isClickable = !!(viewId && onSelect);

  // Color-keyed dim/dim-inactive states so the active cell stands out without
  // making inactive ones feel disabled.
  const baseClasses = 'flex items-center gap-2.5 px-3 py-2.5 sm:px-4 sm:py-2 transition-colors w-full h-full text-left';
  const activeClasses = 'bg-blue-50 ring-1 ring-blue-200 ring-inset';
  const idleClasses = isClickable ? 'hover:bg-slate-50 cursor-pointer' : '';
  const inactiveTextDim = isClickable && !isActive && isZero ? 'opacity-60' : '';

  const inner = (
    <>
      <Icon className={`w-4 h-4 flex-shrink-0 ${iconClass}`} />
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className={`text-lg font-bold leading-none tabular-nums ${isActive ? 'text-blue-700' : 'text-slate-900'}`}>{value}</span>
          {sub && <span className="text-xs text-amber-600 font-medium">{sub}</span>}
        </div>
        <div className={`text-[10px] uppercase tracking-wide font-medium leading-tight mt-0.5 ${isActive ? 'text-blue-600' : 'text-slate-400'}`}>{label}</div>
      </div>
    </>
  );

  if (isClickable) {
    return (
      <button
        type="button"
        onClick={() => onSelect(viewId)}
        className={`${baseClasses} ${isActive ? activeClasses : idleClasses} ${inactiveTextDim}`}
        aria-pressed={isActive}
      >
        {inner}
      </button>
    );
  }

  return <div className={baseClasses}>{inner}</div>;
}

/**
 * Tickets-tab metrics ribbon. When `activeView` + `onSelectView` are passed,
 * the four count metrics (Open / Self-picked / Assigned / Closed) become
 * clickable and drive the underlying ticket sub-view. CSAT stays static
 * because it lives on its own tab.
 */
export default function MetricsRibbon({
  openCount,
  pendingCount,
  selfPickedCount,
  assignedCount,
  closedCount,
  csatCount,
  csatAverage,
  viewMode,
  isToday,
  displayDate,
  weekRangeLabel,
  monthLabel,
  // Optional — when present, the four count metrics double as sub-view buttons.
  activeView,
  onSelectView,
}) {
  const periodLabel = viewMode === 'monthly'
    ? (monthLabel || 'This Month')
    : viewMode === 'weekly'
      ? weekRangeLabel
      : isToday
        ? 'Today'
        : displayDate?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-slate-200 bg-white sm:grid-cols-3 lg:grid-cols-5 [&>*]:border-b [&>*]:border-r [&>*]:border-slate-200 lg:[&>*]:border-b-0">
      <Metric
        icon={CircleDot}
        iconClass="text-red-400"
        label="Open now"
        value={openCount}
        sub={pendingCount > 0 ? `+${pendingCount} pending` : null}
        viewId="all"
        activeViewId={activeView}
        onSelect={onSelectView}
        isZero={openCount + pendingCount === 0}
      />
      <Metric
        icon={Hand}
        iconClass="text-slate-400"
        label={`Self-picked · ${periodLabel}`}
        value={selfPickedCount}
        viewId="self"
        activeViewId={activeView}
        onSelect={onSelectView}
        isZero={selfPickedCount === 0}
      />
      <Metric
        icon={Send}
        iconClass="text-slate-400"
        label={`Assigned · ${periodLabel}`}
        value={assignedCount}
        viewId="assigned"
        activeViewId={activeView}
        onSelect={onSelectView}
        isZero={assignedCount === 0}
      />
      <Metric
        icon={CheckCircle2}
        iconClass="text-emerald-500"
        label={`Closed · ${periodLabel}`}
        value={closedCount}
        viewId="closed"
        activeViewId={activeView}
        onSelect={onSelectView}
        isZero={closedCount === 0}
      />
      <Metric
        icon={Star}
        iconClass={csatCount > 0 ? 'text-amber-400 fill-amber-400' : 'text-slate-300'}
        label="CSAT · All time"
        value={csatCount}
        sub={csatAverage ? `Avg ${csatAverage}/4` : null}
      />
    </div>
  );
}
