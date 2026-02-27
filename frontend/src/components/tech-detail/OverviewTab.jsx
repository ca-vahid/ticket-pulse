import { Hand, Send, CheckCircle2, TrendingUp, TrendingDown, Minus, Users, Star } from 'lucide-react';
import { STATUS_COLORS } from './constants';

// ── Shared helpers ────────────────────────────────────────────────────────────

function SectionLabel({ children }) {
  return (
    <h3 className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-2">{children}</h3>
  );
}

function CategoryPills({ tickets }) {
  if (!tickets || tickets.length === 0) return null;
  const map = {};
  tickets.forEach((t) => {
    const cat = t.ticketCategory || 'Uncategorized';
    map[cat] = (map[cat] || 0) + 1;
  });
  const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return (
    <div className="flex flex-wrap gap-1.5">
      {sorted.map(([cat, count]) => (
        <span
          key={cat}
          className="inline-flex items-center gap-1 px-2 py-0.5 bg-white text-slate-600 rounded-full text-xs border border-slate-200"
        >
          {cat}
          <span className="font-bold text-slate-700">{count}</span>
        </span>
      ))}
    </div>
  );
}

function StackedBar({ self, assigned, total }) {
  if (!total) return null;
  const selfPct = (self / total) * 100;
  const assignedPct = (assigned / total) * 100;
  return (
    <div>
      <div className="flex rounded-full overflow-hidden h-2 bg-slate-200">
        {self > 0 && (
          <div className="bg-blue-500" style={{ width: `${selfPct}%` }} />
        )}
        {assigned > 0 && (
          <div className="bg-slate-400" style={{ width: `${assignedPct}%` }} />
        )}
      </div>
      <div className="flex justify-between mt-1">
        <span className="flex items-center gap-1 text-[10px] text-slate-500">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
          Self-Picked ({self})
        </span>
        <span className="flex items-center gap-1 text-[10px] text-slate-400">
          Assigned ({assigned})
          <span className="w-1.5 h-1.5 rounded-full bg-slate-400 inline-block" />
        </span>
      </div>
    </div>
  );
}

// ── Compact inline stat row ───────────────────────────────────────────────────
// Each cell: colored number + tiny label. No heavy backgrounds — color carries meaning.

function StatRow({ stats }) {
  return (
    <div className="flex items-stretch divide-x divide-slate-100 bg-white border border-slate-200 rounded-lg overflow-hidden">
      {stats.map(({ label, value, color, sub }) => (
        <div key={label} className="flex-1 px-2.5 py-1.5 text-center">
          <div className={`text-sm font-bold leading-none ${color || 'text-slate-700'}`}>
            {value}
          </div>
          {sub && (
            <div className="text-[8px] mt-0.5 text-slate-400">{sub}</div>
          )}
          <div className="text-[8px] uppercase tracking-wider font-semibold mt-1 text-slate-400">
            {label}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Weekly Overview ───────────────────────────────────────────────────────────

function WeeklyOverview({ technician }) {
  const netChange = technician.weeklyNetChange || 0;
  const total     = technician.weeklyTotalCreated || 0;
  const selfPicked = technician.weeklySelfPicked || 0;
  const assigned  = technician.weeklyAssigned || 0;
  const closed    = technician.weeklyClosed || 0;
  const selfRate  = total > 0 ? Math.round((selfPicked / total) * 100) : 0;
  const weeklyTickets = technician.weeklyTickets || [];

  const NetIcon = netChange > 0 ? TrendingUp : netChange < 0 ? TrendingDown : Minus;
  const netColor = netChange > 0 ? 'text-red-500' : netChange < 0 ? 'text-emerald-600' : 'text-slate-400';

  return (
    <div className="space-y-4">
      {/* 1. Weekly Summary — shown first */}
      <div>
        <SectionLabel>Weekly Summary</SectionLabel>
        <StatRow stats={[
          { label: 'Total', value: total, color: 'text-blue-600' },
          { label: 'Self-Picked', value: selfPicked, color: 'text-slate-700' },
          { label: 'Assigned', value: assigned },
          { label: 'Closed', value: closed, color: 'text-emerald-600' },
          {
            label: 'Net Change',
            value: (
              <span className="flex items-center justify-center gap-0.5">
                <NetIcon className="w-3 h-3" />
                {netChange > 0 ? '+' : ''}{netChange}
              </span>
            ),
            color: netColor,
          },
          { label: 'Self-Pick %', value: `${selfRate}%` },
        ]} />
      </div>

      {/* Self vs Assigned bar */}
      {total > 0 && (
        <div>
          <SectionLabel>Self-Picked vs Assigned</SectionLabel>
          <StackedBar self={selfPicked} assigned={assigned} total={total} />
        </div>
      )}

      {/* 2. Daily Breakdown — shown below summary */}
      {technician.dailyBreakdown && (
        <div>
          <SectionLabel>Daily Breakdown</SectionLabel>
          <div className="grid grid-cols-7 gap-1.5">
            {technician.dailyBreakdown.map((day, index) => {
              const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
              const dateObj  = new Date(day.date + 'T12:00:00');
              const dateLabel = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
              const isWeekend = index >= 5;
              const maxTotal  = Math.max(...technician.dailyBreakdown.map((d) => d.total), 1);
              const intensity = day.total / maxTotal;
              const bgClass   = isWeekend
                ? 'bg-slate-50 border-slate-100'
                : day.total === 0
                  ? 'bg-white border-slate-100'
                  : intensity >= 0.66
                    ? 'bg-blue-50 border-blue-200'
                    : 'bg-white border-slate-200';

              return (
                <div
                  key={day.date}
                  className={`rounded-lg border p-1.5 text-center ${bgClass} ${isWeekend ? 'opacity-50' : ''}`}
                >
                  <div className={`text-[9px] font-bold uppercase tracking-wide ${isWeekend ? 'text-slate-300' : 'text-slate-500'}`}>
                    {dayNames[index]}
                  </div>
                  <div className="text-[8px] text-slate-300 mb-0.5">{dateLabel}</div>
                  <div className={`text-base font-bold ${day.total === 0 ? 'text-slate-200' : 'text-slate-800'}`}>
                    {day.total}
                  </div>
                  {day.total > 0 && (
                    <div className="mt-0.5 text-[8px] text-slate-400">
                      <div className="flex items-center justify-center gap-0.5">
                        <Hand className="w-2 h-2" />
                        <span>{day.self}</span>
                        <span className="text-slate-200 mx-0.5">·</span>
                        <Send className="w-2 h-2" />
                        <span>{day.assigned}</span>
                        <span className="text-slate-200 mx-0.5">·</span>
                        <CheckCircle2 className="w-2 h-2 text-emerald-400" />
                        <span className="text-emerald-500">{day.closed}</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. Daily averages */}
      <div>
        <SectionLabel>Daily Averages</SectionLabel>
        <StatRow stats={[
          { label: 'Tickets / Day', value: (technician.avgTicketsPerDay || 0).toFixed(1), color: 'text-blue-600' },
          { label: 'Self-Picked / Day', value: (technician.avgSelfPickedPerDay || 0).toFixed(1), color: 'text-slate-700' },
          { label: 'Closed / Day', value: (technician.avgClosedPerDay || 0).toFixed(1), color: 'text-emerald-600' },
        ]} />
      </div>

      {/* 4. Assigners + CSAT */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {technician.assigners && technician.assigners.length > 0 && (
          <div>
            <SectionLabel>Assigned By</SectionLabel>
            <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
              {technician.assigners.map((assigner, idx) => (
                <div key={idx} className="flex items-center justify-between px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Users className="w-3 h-3 text-slate-300" />
                    <span className="text-sm text-slate-700">{assigner.name}</span>
                  </div>
                  <span className="text-sm font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded-full">
                    {assigner.count}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {(technician.weeklyCSATCount || 0) > 0 && (
          <div>
            <SectionLabel>Weekly CSAT</SectionLabel>
            <div className="bg-white rounded-lg border border-slate-200 p-3 flex items-center justify-center gap-6">
              <div className="text-center">
                <div className="text-xl font-bold text-slate-800">{technician.weeklyCSATCount}</div>
                <div className="text-[10px] text-slate-400 font-medium uppercase">Ratings</div>
              </div>
              <div className="w-px h-8 bg-slate-200" />
              <div className="text-center">
                <div className="text-xl font-bold text-amber-600 flex items-center gap-1">
                  {technician.weeklyCSATAverage ? Number(technician.weeklyCSATAverage).toFixed(1) : 'N/A'}
                  <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                </div>
                <div className="text-[10px] text-slate-400 font-medium uppercase">Avg / 4</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 5. Categories */}
      {weeklyTickets.length > 0 && (
        <div>
          <SectionLabel>Categories</SectionLabel>
          <CategoryPills tickets={weeklyTickets} />
        </div>
      )}
    </div>
  );
}

// ── Daily Overview ────────────────────────────────────────────────────────────

function DailyOverview({ technician, selectedDate, openCount, pendingCount }) {
  const dayTickets = technician.ticketsOnDate || [];
  const total      = technician.totalTicketsOnDate || 0;
  const selfPicked = technician.selfPickedOnDate || 0;
  const assigned   = technician.assignedOnDate || 0;
  const closed     = technician.closedTicketsOnDateCount || 0;
  const selfRate   = total > 0 ? Math.round((selfPicked / total) * 100) : 0;

  const dateHeading = selectedDate
    ? new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    })
    : new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });

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
      <div>
        <SectionLabel>{dateHeading}</SectionLabel>
        <StatRow stats={[
          { label: 'Total', value: total, color: 'text-blue-600' },
          { label: 'Self-Picked', value: selfPicked, color: 'text-slate-700' },
          { label: 'Assigned', value: assigned },
          { label: 'Closed', value: closed, color: 'text-emerald-600' },
          {
            label: 'Open Now',
            value: openCount,
            sub: pendingCount > 0 ? `+${pendingCount} pending` : null,
          },
          { label: 'Self-Pick %', value: `${selfRate}%` },
        ]} />
      </div>

      {total > 0 && (
        <div>
          <SectionLabel>Self-Picked vs Assigned</SectionLabel>
          <StackedBar self={selfPicked} assigned={assigned} total={total} />
        </div>
      )}

      {dayTickets.length > 0 && (
        <>
          <div>
            <SectionLabel>Categories</SectionLabel>
            <CategoryPills tickets={dayTickets} />
          </div>

          {sortedStatuses.length > 0 && (
            <div>
              <SectionLabel>Ticket Statuses</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                {sortedStatuses.map(([status, count]) => (
                  <span
                    key={status}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${STATUS_COLORS[status] || 'bg-slate-100 text-slate-600 border border-slate-200'}`}
                  >
                    {status}
                    <span className="font-bold">{count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Monthly Overview ──────────────────────────────────────────────────────────

function MonthlyOverview({ technician, selectedMonth }) {
  const netChange    = technician.monthlyNetChange || 0;
  const total        = technician.monthlyTotalCreated || 0;
  const selfPicked   = technician.monthlySelfPicked || 0;
  const assigned     = technician.monthlyAssigned || 0;
  const closed       = technician.monthlyClosed || 0;
  const selfRate     = total > 0 ? Math.round((selfPicked / total) * 100) : 0;
  const monthlyTickets = technician.monthlyTickets || [];

  const NetIcon = netChange > 0 ? TrendingUp : netChange < 0 ? TrendingDown : Minus;
  const netColor = netChange > 0 ? 'text-red-500' : netChange < 0 ? 'text-emerald-600' : 'text-slate-400';

  // Build a calendar grid: 7-column Mon–Sun
  // dailyBreakdown has one entry per calendar day of the month
  const days = technician.dailyBreakdown || [];
  const todayStr = new Date().toLocaleDateString('en-CA');

  // Figure out day-of-week for first day (0=Mon, 6=Sun)
  const firstDayOffset = days.length > 0
    ? (() => {
      const d = new Date(days[0].date + 'T12:00:00');
      return (d.getDay() + 6) % 7; // Mon=0, Sun=6
    })()
    : 0;

  // All cells = padding + day cells
  const calCells = [];
  for (let i = 0; i < firstDayOffset; i++) calCells.push(null);
  days.forEach((day) => calCells.push(day));

  const maxTotal = Math.max(...days.map((d) => d.total), 1);

  const monthName = selectedMonth
    ? selectedMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <div className="space-y-4">
      {/* Monthly Summary */}
      <div>
        <SectionLabel>Monthly Summary — {monthName}</SectionLabel>
        <StatRow stats={[
          { label: 'Total', value: total, color: 'text-blue-600' },
          { label: 'Self-Picked', value: selfPicked, color: 'text-slate-700' },
          { label: 'Assigned', value: assigned },
          { label: 'Closed', value: closed, color: 'text-emerald-600' },
          {
            label: 'Net Change',
            value: (
              <span className="flex items-center justify-center gap-0.5">
                <NetIcon className="w-3 h-3" />
                {netChange > 0 ? '+' : ''}{netChange}
              </span>
            ),
            color: netColor,
          },
          { label: 'Self-Pick %', value: `${selfRate}%` },
        ]} />
      </div>

      {/* Self vs Assigned bar */}
      {total > 0 && (
        <div>
          <SectionLabel>Self-Picked vs Assigned</SectionLabel>
          <StackedBar self={selfPicked} assigned={assigned} total={total} />
        </div>
      )}

      {/* Calendar grid */}
      {days.length > 0 && (
        <div>
          <SectionLabel>Daily Breakdown</SectionLabel>
          {/* Day-of-week headers */}
          <div className="grid grid-cols-7 gap-1 mb-1">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
              <div key={d} className="text-[9px] font-bold uppercase tracking-wide text-center text-slate-400">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {calCells.map((day, idx) => {
              if (!day) {
                return <div key={`pad-${idx}`} className="rounded-lg border border-transparent p-1 min-h-[52px]" />;
              }
              const dateObj = new Date(day.date + 'T12:00:00');
              const dowIdx = (dateObj.getDay() + 6) % 7; // Mon=0, Sun=6
              const isWeekend = dowIdx >= 5;
              const isFuture = day.date > todayStr;
              const isToday = day.date === todayStr;
              const intensity = day.total / maxTotal;
              const bgClass = isFuture || isWeekend
                ? 'bg-slate-50 border-slate-100 opacity-40'
                : isToday
                  ? 'bg-blue-50 border-blue-300'
                  : day.total === 0
                    ? 'bg-white border-slate-100'
                    : intensity >= 0.66
                      ? 'bg-blue-50 border-blue-200'
                      : 'bg-white border-slate-200';
              const dateLabel = dateObj.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });

              return (
                <div
                  key={day.date}
                  className={`rounded-lg border p-1 text-center ${bgClass}`}
                >
                  <div className="text-[8px] text-slate-300 leading-none">{dateLabel}</div>
                  <div className={`text-sm font-bold leading-tight mt-0.5 ${day.total === 0 || isFuture ? 'text-slate-200' : 'text-slate-800'}`}>
                    {isFuture ? '' : day.total}
                  </div>
                  {!isFuture && day.total > 0 && (
                    <div className="mt-0.5 text-[7px] text-slate-400">
                      <div className="flex items-center justify-center gap-0.5">
                        <Hand className="w-1.5 h-1.5" />
                        <span>{day.self}</span>
                        <span className="text-slate-200 mx-0.5">·</span>
                        <CheckCircle2 className="w-1.5 h-1.5 text-emerald-400" />
                        <span className="text-emerald-500">{day.closed}</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Daily averages */}
      <div>
        <SectionLabel>Daily Averages (whole month)</SectionLabel>
        <StatRow stats={[
          { label: 'Tickets / Day', value: (technician.avgTicketsPerDay || 0).toFixed(1), color: 'text-blue-600' },
          { label: 'Self-Picked / Day', value: (technician.avgSelfPickedPerDay || 0).toFixed(1), color: 'text-slate-700' },
          { label: 'Closed / Day', value: (technician.avgClosedPerDay || 0).toFixed(1), color: 'text-emerald-600' },
        ]} />
      </div>

      {/* Assigners + CSAT */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {technician.assigners && technician.assigners.length > 0 && (
          <div>
            <SectionLabel>Assigned By</SectionLabel>
            <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
              {technician.assigners.map((assigner, idx) => (
                <div key={idx} className="flex items-center justify-between px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Users className="w-3 h-3 text-slate-300" />
                    <span className="text-sm text-slate-700">{assigner.name}</span>
                  </div>
                  <span className="text-sm font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded-full">
                    {assigner.count}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {(technician.monthlyCSATCount || 0) > 0 && (
          <div>
            <SectionLabel>Monthly CSAT</SectionLabel>
            <div className="bg-white rounded-lg border border-slate-200 p-3 flex items-center justify-center gap-6">
              <div className="text-center">
                <div className="text-xl font-bold text-slate-800">{technician.monthlyCSATCount}</div>
                <div className="text-[10px] text-slate-400 font-medium uppercase">Ratings</div>
              </div>
              <div className="w-px h-8 bg-slate-200" />
              <div className="text-center">
                <div className="text-xl font-bold text-amber-600 flex items-center gap-1">
                  {technician.monthlyCSATAverage ? Number(technician.monthlyCSATAverage).toFixed(1) : 'N/A'}
                  <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                </div>
                <div className="text-[10px] text-slate-400 font-medium uppercase">Avg / 4</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Categories */}
      {monthlyTickets.length > 0 && (
        <div>
          <SectionLabel>Categories</SectionLabel>
          <CategoryPills tickets={monthlyTickets} />
        </div>
      )}
    </div>
  );
}

// ── Export ────────────────────────────────────────────────────────────────────

export default function OverviewTab({ technician, viewMode, selectedDate, selectedMonth, openCount, pendingCount }) {
  if (viewMode === 'weekly') {
    if (!technician.dailyBreakdown) {
      return (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-3" />
          <p className="text-slate-400 text-sm">Loading weekly data…</p>
        </div>
      );
    }
    return <WeeklyOverview technician={technician} />;
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
    return <MonthlyOverview technician={technician} selectedMonth={selectedMonth} />;
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
