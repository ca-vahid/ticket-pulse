import { CircleDot, Hand, Send, CheckCircle2, Star } from 'lucide-react';

function Metric({ icon: Icon, iconClass, label, value, sub }) {
  return (
    <div className="flex items-center gap-2.5 px-4">
      <Icon className={`w-4 h-4 flex-shrink-0 ${iconClass}`} />
      <div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-lg font-bold text-slate-900 leading-none">{value}</span>
          {sub && <span className="text-xs text-amber-600 font-medium">{sub}</span>}
        </div>
        <div className="text-[10px] text-slate-400 uppercase tracking-wide font-medium leading-none mt-0.5">{label}</div>
      </div>
    </div>
  );
}

function Divider() {
  return <div className="w-px h-8 bg-slate-200 flex-shrink-0" />;
}

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
}) {
  const periodLabel = viewMode === 'monthly'
    ? (monthLabel || 'This Month')
    : viewMode === 'weekly'
      ? weekRangeLabel
      : isToday
        ? 'Today'
        : displayDate?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <div className="bg-white border border-slate-200 rounded-lg flex items-center divide-x divide-slate-200 overflow-hidden">
      <Metric
        icon={CircleDot}
        iconClass="text-red-400"
        label="Open now"
        value={openCount}
        sub={pendingCount > 0 ? `+${pendingCount} pending` : null}
      />
      <Divider />
      <Metric
        icon={Hand}
        iconClass="text-slate-400"
        label={`Self-picked · ${periodLabel}`}
        value={selfPickedCount}
      />
      <Divider />
      <Metric
        icon={Send}
        iconClass="text-slate-400"
        label={`Assigned · ${periodLabel}`}
        value={assignedCount}
      />
      <Divider />
      <Metric
        icon={CheckCircle2}
        iconClass="text-emerald-500"
        label={`Closed · ${periodLabel}`}
        value={closedCount}
      />
      <Divider />
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
