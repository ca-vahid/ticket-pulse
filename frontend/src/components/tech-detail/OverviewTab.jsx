import {
  Hand, Send, CheckCircle2, TrendingUp, TrendingDown, Minus, Star,
  Inbox, Sparkles, Smartphone, RotateCcw, Activity,
} from 'lucide-react';
import { STATUS_COLORS } from './constants';

// ─────────────────────────────────────────────────────────────────────────────
// Overview tab — redesigned to surface the signals an IT coordinator actually
// uses: workload pulse, throughput, self-pick behaviour (proactiveness), CSAT,
// and bounce rate. Older multi-section list view replaced with a hero KPI grid
// + supporting visualizations.
// ─────────────────────────────────────────────────────────────────────────────

// ── Shared atoms ──────────────────────────────────────────────────────────────

function SectionLabel({ children, hint }) {
  return (
    <div className="flex items-baseline justify-between mb-2">
      <h3 className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">{children}</h3>
      {hint && <span className="text-[10px] text-slate-300">{hint}</span>}
    </div>
  );
}

/**
 * Hero KPI card — big number + trend strip beneath. Used in the top row.
 * Color carries meaning (status), so deliberately light backgrounds keep the
 * grid breathable without competing with the numbers themselves.
 */
function KpiCard({ icon: Icon, label, value, sub, accent = 'slate', delta = null, footer = null }) {
  const accentMap = {
    blue:    { ring: 'ring-blue-100',    iconBg: 'bg-blue-50 text-blue-600',       num: 'text-blue-700' },
    emerald: { ring: 'ring-emerald-100', iconBg: 'bg-emerald-50 text-emerald-600', num: 'text-emerald-700' },
    amber:   { ring: 'ring-amber-100',   iconBg: 'bg-amber-50 text-amber-600',     num: 'text-amber-700' },
    rose:    { ring: 'ring-rose-100',    iconBg: 'bg-rose-50 text-rose-600',       num: 'text-rose-700' },
    purple:  { ring: 'ring-purple-100',  iconBg: 'bg-purple-50 text-purple-600',   num: 'text-purple-700' },
    slate:   { ring: 'ring-slate-100',   iconBg: 'bg-slate-100 text-slate-600',    num: 'text-slate-800' },
  };
  const a = accentMap[accent] || accentMap.slate;

  let DeltaIcon = null;
  let deltaClass = 'text-slate-400';
  if (delta != null) {
    DeltaIcon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
    // Net-change semantics: more incoming tickets is "bad" for backlog,
    // matching the existing dashboard convention.
    deltaClass = delta > 0 ? 'text-rose-500' : delta < 0 ? 'text-emerald-600' : 'text-slate-400';
  }

  return (
    <div className={`bg-white border border-slate-200 rounded-xl p-3 ring-1 ${a.ring} hover:shadow-sm transition-shadow`}>
      <div className="flex items-center gap-2.5">
        <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${a.iconBg} flex-shrink-0`}>
          <Icon className="w-4 h-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold leading-none">{label}</div>
          <div className="flex items-baseline gap-1.5 mt-1">
            <span className={`text-2xl font-bold leading-none tabular-nums ${a.num}`}>{value}</span>
            {sub && <span className="text-[11px] font-medium text-slate-500">{sub}</span>}
          </div>
        </div>
        {DeltaIcon && (
          <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold ${deltaClass}`} title="Net change">
            <DeltaIcon className="w-3 h-3" />
            {delta > 0 ? '+' : ''}{delta}
          </span>
        )}
      </div>
      {footer && <div className="mt-2 pt-2 border-t border-slate-100 text-[10px] text-slate-500">{footer}</div>}
    </div>
  );
}

/**
 * Source-mix bar — shows how a tech got their tickets. Larger and more
 * confident than the previous skinny version, with inline percentages.
 */
function SourceMixBar({ self, appAssigned = 0, assigned, total }) {
  if (!total) return null;
  const pct = (n) => Math.round((n / total) * 100);
  const segments = [
    { key: 'self',     val: self,        pctVal: pct(self),         label: 'Self-picked',  color: 'bg-blue-500',   text: 'text-blue-700' },
    { key: 'app',      val: appAssigned, pctVal: pct(appAssigned),  label: 'App',          color: 'bg-sky-400',    text: 'text-sky-700' },
    { key: 'assigned', val: assigned,    pctVal: pct(assigned),     label: 'Assigned',     color: 'bg-slate-400',  text: 'text-slate-600' },
  ].filter((s) => s.val > 0);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3">
      <div className="flex h-3 rounded-full overflow-hidden bg-slate-100">
        {segments.map((s) => (
          <div
            key={s.key}
            className={s.color}
            style={{ width: `${s.pctVal}%` }}
            title={`${s.label}: ${s.val} (${s.pctVal}%)`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 text-[11px]">
            <span className={`w-2 h-2 rounded-full ${s.color}`} />
            <span className="text-slate-600 font-medium">{s.label}</span>
            <span className="tabular-nums text-slate-400">{s.val}</span>
            <span className={`tabular-nums font-semibold ${s.text}`}>{s.pctVal}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Daily activity chart — lightweight vertical bars instead of the previous
 * boxed cards. Today / weekend get visual differentiation. Hovering reveals
 * the full breakdown in a native tooltip.
 */
function DailyBarChart({ days }) {
  if (!days || days.length === 0) return null;
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const maxTotal = Math.max(...days.map((d) => d.total || 0), 1);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3">
      <div className="grid grid-cols-7 gap-2">
        {days.map((day, idx) => {
          const isWeekend = idx >= 5;
          const total = day.total || 0;
          const closed = day.closed || 0;
          // 80px max bar so every cell can render a label + numeric below
          const heightPx = total > 0 ? Math.max(6, Math.round((total / maxTotal) * 80)) : 0;
          const closedPx = total > 0 ? Math.round((closed / total) * heightPx) : 0;
          const dateLabel = day.date
            ? new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : null;

          return (
            <div
              key={day.date || idx}
              className={`flex flex-col items-center ${isWeekend ? 'opacity-50' : ''}`}
              title={`${dayNames[idx]} ${dateLabel || ''}: ${total} total · ${day.self || 0} self · ${day.assigned || 0} assigned · ${closed} closed`}
            >
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500 leading-none">{dayNames[idx]}</div>
              <div className="text-[9px] text-slate-300 mt-0.5">{dateLabel}</div>
              <div className="flex flex-col-reverse items-center justify-end h-[88px] mt-1.5">
                <div
                  className="w-7 rounded-md bg-blue-200 relative overflow-hidden"
                  style={{ height: heightPx ? `${heightPx}px` : '4px' }}
                >
                  {/* Closed portion stacks at the bottom in emerald to show throughput at a glance */}
                  {closedPx > 0 && (
                    <div className="absolute bottom-0 left-0 right-0 bg-emerald-400" style={{ height: `${closedPx}px` }} />
                  )}
                </div>
              </div>
              <div className={`mt-1.5 text-[12px] font-bold tabular-nums ${total === 0 ? 'text-slate-300' : 'text-slate-800'}`}>
                {total}
              </div>
            </div>
          );
        })}
      </div>
      {/* Legend strip */}
      <div className="mt-3 flex items-center justify-end gap-3 text-[10px] text-slate-500">
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-200" />Created</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-400" />Closed</span>
      </div>
    </div>
  );
}

/**
 * Top-N list — used for assigners and categories. Each row shows a horizontal
 * bar proportional to its count, so the visual hierarchy of "who tops the list"
 * is immediate without forcing the user to compare numbers.
 */
function RankedList({ items, accent = 'blue', emptyText = 'None' }) {
  if (!items || items.length === 0) {
    return (
      <div className="text-[11px] text-slate-400 italic px-3 py-4 text-center">{emptyText}</div>
    );
  }
  const max = Math.max(...items.map((i) => i.count), 1);
  const accentBar = accent === 'emerald' ? 'bg-emerald-100' : accent === 'amber' ? 'bg-amber-100' : 'bg-blue-100';
  return (
    <div className="space-y-1">
      {items.map((item) => {
        const widthPct = Math.round((item.count / max) * 100);
        return (
          <div key={item.label} className="relative">
            {/* Progress backdrop — sits behind the row, scales with relative count */}
            <div className={`absolute inset-y-0 left-0 ${accentBar} rounded-md`} style={{ width: `${widthPct}%` }} />
            <div className="relative flex items-center justify-between px-2.5 py-1.5">
              <span className="text-[12px] text-slate-700 truncate font-medium" title={item.label}>{item.label}</span>
              <span className="text-[11px] font-bold tabular-nums text-slate-700 ml-2 flex-shrink-0">{item.count}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CategoryRanked({ tickets }) {
  if (!tickets || tickets.length === 0) return null;
  const map = {};
  tickets.forEach((t) => {
    const cat = t.ticketCategory || 'Uncategorized';
    map[cat] = (map[cat] || 0) + 1;
  });
  const items = Object.entries(map)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8); // top 8 keeps the card scannable
  return <RankedList items={items} accent="blue" emptyText="No categories yet" />;
}

/**
 * Compact CSAT card — large number + star burst. Replaces the previous
 * thin two-cell layout.
 */
function CSATCard({ count, average }) {
  if (!count) return null;
  const avg = average ? Number(average).toFixed(1) : null;
  // Score colour: green ≥3.5, amber ≥2.5, rose otherwise.
  const tone = avg >= 3.5 ? 'text-emerald-600' : avg >= 2.5 ? 'text-amber-600' : 'text-rose-600';
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">Customer satisfaction</div>
          <div className="flex items-baseline gap-1.5 mt-1">
            <span className={`text-2xl font-bold tabular-nums leading-none ${tone}`}>{avg || 'N/A'}</span>
            <span className="text-[11px] text-slate-400">/ 4</span>
          </div>
          <div className="text-[10px] text-slate-500 mt-1">{count} {count === 1 ? 'rating' : 'ratings'}</div>
        </div>
        <div className="flex items-center gap-0.5">
          {[1, 2, 3, 4].map((n) => {
            const filled = avg && n <= Math.round(Number(avg));
            return (
              <Star
                key={n}
                className={`w-5 h-5 ${filled ? 'text-amber-400 fill-amber-400' : 'text-slate-200'}`}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Bounce rate indicator — shows up only when there's something to flag.
 * Helps coordinators spot techs who are repeatedly handing tickets back.
 */
function BounceCallout({ count, total }) {
  if (!count || count === 0) return null;
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  // Tone escalates with bounce rate — quiet at <10%, attention at 10-25%, urgent above.
  const tone = pct >= 25 ? 'rose' : pct >= 10 ? 'amber' : 'slate';
  const toneMap = {
    rose:  { bg: 'bg-rose-50',  border: 'border-rose-200',  text: 'text-rose-700',  iconBg: 'bg-rose-100 text-rose-600' },
    amber: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', iconBg: 'bg-amber-100 text-amber-600' },
    slate: { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-700', iconBg: 'bg-slate-100 text-slate-500' },
  };
  const t = toneMap[tone];
  return (
    <div className={`flex items-center gap-3 ${t.bg} ${t.border} border rounded-xl p-3`}>
      <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${t.iconBg} flex-shrink-0`}>
        <RotateCcw className="w-4 h-4" />
      </span>
      <div className="flex-1 min-w-0">
        <div className={`text-[12px] font-semibold ${t.text}`}>
          {count} bounced ticket{count === 1 ? '' : 's'} this period
          {total > 0 && <span className="font-normal text-slate-500"> · {pct}% of total</span>}
        </div>
        <div className="text-[10px] text-slate-500 mt-0.5">
          Picked up then put back in the queue. See the Bounced tab for details.
        </div>
      </div>
    </div>
  );
}

// ── Period-specific layouts ──────────────────────────────────────────────────

function buildAssignerItems(assigners) {
  if (!assigners || assigners.length === 0) return [];
  return assigners
    .map((a) => ({ label: a.name, count: a.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

function workloadTone(open) {
  if (open >= 10) return { tone: 'rose',    label: 'Heavy load' };
  if (open >= 5)  return { tone: 'amber',   label: 'Medium load' };
  return            { tone: 'emerald', label: 'Light load' };
}

// ── Daily Overview ────────────────────────────────────────────────────────────

function DailyOverview({ technician, selectedDate, openCount, pendingCount }) {
  const dayTickets = technician.ticketsOnDate || [];
  const total       = technician.totalTicketsOnDate || 0;
  const selfPicked  = technician.selfPickedOnDate || 0;
  const appAssigned = technician.appAssignedOnDate || 0;
  const assigned    = technician.assignedOnDate || 0;
  const closed      = technician.closedTicketsOnDateCount || 0;
  const selfRate    = total > 0 ? Math.round((selfPicked / total) * 100) : 0;
  const load        = workloadTone(openCount);

  const dateHeading = selectedDate
    ? new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    })
    : new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });

  // Status breakdown for the day — useful at a glance for "what's still open?"
  const statusMap = {};
  dayTickets.forEach((t) => {
    const s = t.status || 'Unknown';
    statusMap[s] = (statusMap[s] || 0) + 1;
  });
  const statusOrder  = ['Open', 'Pending', 'Resolved', 'Closed'];
  const sortedStatuses = Object.entries(statusMap).sort(
    (a, b) => (statusOrder.indexOf(a[0]) ?? 99) - (statusOrder.indexOf(b[0]) ?? 99),
  );

  return (
    <div className="space-y-4">
      <SectionLabel hint={dateHeading}>Daily snapshot</SectionLabel>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          icon={Inbox}
          accent={load.tone}
          label="Open now"
          value={openCount}
          sub={pendingCount > 0 ? `+${pendingCount} pending` : null}
          footer={<span className="font-semibold">{load.label}</span>}
        />
        <KpiCard
          icon={Hand}
          accent="blue"
          label="Self-picked today"
          value={selfPicked}
          sub={total > 0 ? `${selfRate}%` : null}
        />
        <KpiCard
          icon={Send}
          accent="slate"
          label="Assigned today"
          value={assigned + appAssigned}
          sub={appAssigned > 0 ? `${appAssigned} via app` : null}
        />
        <KpiCard
          icon={CheckCircle2}
          accent="emerald"
          label="Closed today"
          value={closed}
          sub={total > 0 ? `of ${total}` : null}
        />
      </div>

      {total > 0 && (
        <div>
          <SectionLabel>How tickets arrived</SectionLabel>
          <SourceMixBar self={selfPicked} appAssigned={appAssigned} assigned={assigned} total={total} />
        </div>
      )}

      <BounceCallout count={technician.rejectedThisPeriod || 0} total={total} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {dayTickets.length > 0 && (
          <div>
            <SectionLabel>Top categories</SectionLabel>
            <div className="bg-white border border-slate-200 rounded-xl p-2">
              <CategoryRanked tickets={dayTickets} />
            </div>
          </div>
        )}

        {sortedStatuses.length > 0 && (
          <div>
            <SectionLabel>Ticket statuses</SectionLabel>
            <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap gap-1.5">
              {sortedStatuses.map(([status, count]) => (
                <span
                  key={status}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${STATUS_COLORS[status] || 'bg-slate-100 text-slate-600 border border-slate-200'}`}
                >
                  {status}
                  <span className="font-bold tabular-nums">{count}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Weekly Overview ───────────────────────────────────────────────────────────

function WeeklyOverview({ technician, openCount, pendingCount }) {
  const netChange   = technician.weeklyNetChange || 0;
  const total       = technician.weeklyTotalCreated || 0;
  const selfPicked  = technician.weeklySelfPicked || 0;
  const appAssigned = technician.weeklyAppAssigned || 0;
  const assigned    = technician.weeklyAssigned || 0;
  const closed      = technician.weeklyClosed || 0;
  const selfRate    = total > 0 ? Math.round((selfPicked / total) * 100) : 0;
  const closeRate   = total > 0 ? Math.round((closed / total) * 100) : 0;
  const weeklyTickets = technician.weeklyTickets || [];
  const load        = workloadTone(openCount);

  return (
    <div className="space-y-4">
      <SectionLabel hint="Mon → Sun">This week</SectionLabel>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          icon={Inbox}
          accent={load.tone}
          label="Open now"
          value={openCount}
          sub={pendingCount > 0 ? `+${pendingCount} pending` : null}
          footer={<span className="font-semibold">{load.label}</span>}
        />
        <KpiCard
          icon={Activity}
          accent="blue"
          label="Total this week"
          value={total}
          delta={netChange}
          sub={total > 0 ? `${selfRate}% self-picked` : null}
        />
        <KpiCard
          icon={CheckCircle2}
          accent="emerald"
          label="Closed this week"
          value={closed}
          sub={total > 0 ? `${closeRate}% close rate` : null}
          footer={`Avg ${(technician.avgClosedPerDay || 0).toFixed(1)} / day`}
        />
        <KpiCard
          icon={Sparkles}
          accent="purple"
          label="Self-pick rate"
          value={`${selfRate}%`}
          sub={`${selfPicked} of ${total || 0}`}
          footer={selfRate >= 60 ? 'Highly proactive' : selfRate >= 30 ? 'Mixed mode' : 'Mostly assigned'}
        />
      </div>

      {total > 0 && (
        <div>
          <SectionLabel>How tickets arrived</SectionLabel>
          <SourceMixBar self={selfPicked} appAssigned={appAssigned} assigned={assigned} total={total} />
        </div>
      )}

      <BounceCallout count={technician.rejectedThisPeriod || 0} total={total} />

      {technician.dailyBreakdown && (
        <div>
          <SectionLabel hint={`Avg ${(technician.avgTicketsPerDay || 0).toFixed(1)} / day`}>Daily activity</SectionLabel>
          <DailyBarChart days={technician.dailyBreakdown} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
          {technician.assigners && technician.assigners.length > 0 && (
            <div>
              <SectionLabel>Assigned by</SectionLabel>
              <div className="bg-white border border-slate-200 rounded-xl p-2">
                <RankedList items={buildAssignerItems(technician.assigners)} accent="blue" emptyText="No assignments" />
              </div>
            </div>
          )}
          {weeklyTickets.length > 0 && (
            <div>
              <SectionLabel>Top categories</SectionLabel>
              <div className="bg-white border border-slate-200 rounded-xl p-2">
                <CategoryRanked tickets={weeklyTickets} />
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {(technician.weeklyCSATCount || 0) > 0 && (
            <CSATCard count={technician.weeklyCSATCount} average={technician.weeklyCSATAverage} />
          )}
          {appAssigned > 0 && (
            <KpiCard
              icon={Smartphone}
              accent="amber"
              label="Via the app"
              value={appAssigned}
              sub="auto-pipeline"
              footer="Assignments handled by Ticket Pulse this week"
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Monthly Overview ──────────────────────────────────────────────────────────

function MonthlyOverview({ technician, selectedMonth, openCount, pendingCount }) {
  const netChange    = technician.monthlyNetChange || 0;
  const total        = technician.monthlyTotalCreated || 0;
  const selfPicked   = technician.monthlySelfPicked || 0;
  const appAssigned  = technician.monthlyAppAssigned || 0;
  const assigned     = technician.monthlyAssigned || 0;
  const closed       = technician.monthlyClosed || 0;
  const selfRate     = total > 0 ? Math.round((selfPicked / total) * 100) : 0;
  const closeRate    = total > 0 ? Math.round((closed / total) * 100) : 0;
  const monthlyTickets = technician.monthlyTickets || [];
  const load         = workloadTone(openCount);

  const days = technician.dailyBreakdown || [];
  const todayStr = new Date().toLocaleDateString('en-CA');
  const firstDayOffset = days.length > 0
    ? (() => {
      const d = new Date(days[0].date + 'T12:00:00');
      return (d.getDay() + 6) % 7;
    })()
    : 0;
  const calCells = [];
  for (let i = 0; i < firstDayOffset; i++) calCells.push(null);
  days.forEach((day) => calCells.push(day));
  const maxTotal = Math.max(...days.map((d) => d.total), 1);

  const monthName = selectedMonth
    ? selectedMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <div className="space-y-4">
      <SectionLabel hint={monthName}>This month</SectionLabel>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          icon={Inbox}
          accent={load.tone}
          label="Open now"
          value={openCount}
          sub={pendingCount > 0 ? `+${pendingCount} pending` : null}
          footer={<span className="font-semibold">{load.label}</span>}
        />
        <KpiCard
          icon={Activity}
          accent="blue"
          label="Total this month"
          value={total}
          delta={netChange}
          sub={total > 0 ? `${selfRate}% self-picked` : null}
        />
        <KpiCard
          icon={CheckCircle2}
          accent="emerald"
          label="Closed this month"
          value={closed}
          sub={total > 0 ? `${closeRate}% close rate` : null}
          footer={`Avg ${(technician.avgClosedPerDay || 0).toFixed(1)} / day`}
        />
        <KpiCard
          icon={Sparkles}
          accent="purple"
          label="Self-pick rate"
          value={`${selfRate}%`}
          sub={`${selfPicked} of ${total || 0}`}
          footer={selfRate >= 60 ? 'Highly proactive' : selfRate >= 30 ? 'Mixed mode' : 'Mostly assigned'}
        />
      </div>

      {total > 0 && (
        <div>
          <SectionLabel>How tickets arrived</SectionLabel>
          <SourceMixBar self={selfPicked} appAssigned={appAssigned} assigned={assigned} total={total} />
        </div>
      )}

      <BounceCallout count={technician.rejectedThisPeriod || 0} total={total} />

      {/* Calendar heatmap — keeps the month-at-a-glance visual but with cleaner styling */}
      {days.length > 0 && (
        <div>
          <SectionLabel hint={`Avg ${(technician.avgTicketsPerDay || 0).toFixed(1)} / day`}>Daily activity</SectionLabel>
          <div className="bg-white border border-slate-200 rounded-xl p-3">
            <div className="grid grid-cols-7 gap-1 mb-1">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                <div key={d} className="text-[9px] font-bold uppercase tracking-wide text-center text-slate-400">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {calCells.map((day, idx) => {
                if (!day) {
                  return <div key={`pad-${idx}`} className="rounded-md p-1 min-h-[44px]" />;
                }
                const dateObj = new Date(day.date + 'T12:00:00');
                const dowIdx = (dateObj.getDay() + 6) % 7;
                const isWeekend = dowIdx >= 5;
                const isFuture = day.date > todayStr;
                const isToday = day.date === todayStr;
                const intensity = day.total / maxTotal;
                // Heatmap intensity bucketed into 5 steps for visual rhythm
                const heatBg = isFuture
                  ? 'bg-slate-50'
                  : isToday
                    ? 'bg-blue-100 ring-1 ring-blue-300'
                    : day.total === 0
                      ? 'bg-white'
                      : intensity >= 0.75 ? 'bg-blue-200'
                        : intensity >= 0.5  ? 'bg-blue-100'
                          : intensity >= 0.25 ? 'bg-blue-50'
                            : 'bg-slate-50';
                return (
                  <div
                    key={day.date}
                    className={`rounded-md p-1 text-center border border-slate-100 ${heatBg} ${isFuture || isWeekend ? 'opacity-60' : ''}`}
                    title={`${day.date}: ${day.total} total · ${day.self || 0} self · ${day.assigned || 0} assigned · ${day.closed || 0} closed`}
                  >
                    <div className="text-[8px] text-slate-400 leading-none">{dateObj.getDate()}</div>
                    <div className={`text-[12px] font-bold tabular-nums leading-tight mt-0.5 ${day.total === 0 || isFuture ? 'text-slate-300' : 'text-slate-800'}`}>
                      {isFuture ? '' : day.total}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
          {technician.assigners && technician.assigners.length > 0 && (
            <div>
              <SectionLabel>Assigned by</SectionLabel>
              <div className="bg-white border border-slate-200 rounded-xl p-2">
                <RankedList items={buildAssignerItems(technician.assigners)} accent="blue" emptyText="No assignments" />
              </div>
            </div>
          )}
          {monthlyTickets.length > 0 && (
            <div>
              <SectionLabel>Top categories</SectionLabel>
              <div className="bg-white border border-slate-200 rounded-xl p-2">
                <CategoryRanked tickets={monthlyTickets} />
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {(technician.monthlyCSATCount || 0) > 0 && (
            <CSATCard count={technician.monthlyCSATCount} average={technician.monthlyCSATAverage} />
          )}
          {appAssigned > 0 && (
            <KpiCard
              icon={Smartphone}
              accent="amber"
              label="Via the app"
              value={appAssigned}
              sub="auto-pipeline"
              footer="Assignments handled by Ticket Pulse this month"
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Export ────────────────────────────────────────────────────────────────────

export default function OverviewTab({
  technician,
  viewMode,
  selectedDate,
  selectedMonth,
  openCount,
  pendingCount,
}) {
  if (viewMode === 'weekly') {
    if (!technician.dailyBreakdown) {
      return (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-3" />
          <p className="text-slate-400 text-sm">Loading weekly data…</p>
        </div>
      );
    }
    return <WeeklyOverview technician={technician} openCount={openCount} pendingCount={pendingCount} />;
  }

  if (viewMode === 'monthly') {
    if (!technician.dailyBreakdown) {
      return (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-3" />
          <p className="text-slate-400 text-sm">Loading monthly data…</p>
        </div>
      );
    }
    return (
      <MonthlyOverview
        technician={technician}
        selectedMonth={selectedMonth}
        openCount={openCount}
        pendingCount={pendingCount}
      />
    );
  }

  return (
    <DailyOverview
      technician={technician}
      selectedDate={selectedDate}
      openCount={openCount}
      pendingCount={pendingCount}
    />
  );
}
