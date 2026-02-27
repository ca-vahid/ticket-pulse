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
// Replaces the large metric boxes with a tight horizontal row of key figures

function StatRow({ stats }) {
  return (
    <div className="flex items-stretch divide-x divide-slate-200 bg-white border border-slate-200 rounded-lg overflow-hidden text-center">
      {stats.map(({ label, value, accent, sub }) => (
        <div key={label} className={`flex-1 px-3 py-2 ${accent ? accent : ''}`}>
          <div className={`text-xl font-bold leading-none ${accent ? 'text-white' : 'text-slate-800'}`}>
            {value}
          </div>
          {sub && (
            <div className={`text-[9px] mt-0.5 ${accent ? 'text-white/70' : 'text-slate-400'}`}>{sub}</div>
          )}
          <div className={`text-[9px] uppercase tracking-wide font-medium mt-0.5 ${accent ? 'text-white/70' : 'text-slate-400'}`}>
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
  const netAccent = netChange > 0 ? 'bg-red-500' : netChange < 0 ? 'bg-emerald-600' : 'bg-slate-500';

  return (
    <div className="space-y-4">
      {/* 1. Weekly Summary — shown first */}
      <div>
        <SectionLabel>Weekly Summary</SectionLabel>
        <StatRow stats={[
          { label: 'Total', value: total, accent: 'bg-blue-600' },
          { label: 'Self-Picked', value: selfPicked },
          { label: 'Assigned', value: assigned },
          { label: 'Closed', value: closed, accent: 'bg-emerald-600' },
          {
            label: 'Net Change',
            value: (
              <span className="flex items-center justify-center gap-0.5">
                <NetIcon className="w-3.5 h-3.5" />
                {netChange > 0 ? '+' : ''}{netChange}
              </span>
            ),
            accent: netAccent,
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
                  className={`rounded-lg border p-2 text-center ${bgClass} ${isWeekend ? 'opacity-50' : ''}`}
                >
                  <div className={`text-[10px] font-bold uppercase tracking-wide ${isWeekend ? 'text-slate-300' : 'text-slate-500'}`}>
                    {dayNames[index]}
                  </div>
                  <div className="text-[9px] text-slate-300 mb-1">{dateLabel}</div>
                  <div className={`text-lg font-bold ${day.total === 0 ? 'text-slate-200' : 'text-slate-800'}`}>
                    {day.total}
                  </div>
                  {day.total > 0 && (
                    <div className="mt-1 text-[9px] text-slate-400 space-y-0.5">
                      <div className="flex items-center justify-center gap-1">
                        <Hand className="w-2 h-2" />
                        <span>{day.self}</span>
                        <span className="text-slate-200">·</span>
                        <Send className="w-2 h-2" />
                        <span>{day.assigned}</span>
                      </div>
                      <div className="flex items-center justify-center gap-1 text-emerald-500">
                        <CheckCircle2 className="w-2 h-2" />
                        <span>{day.closed}</span>
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
          { label: 'Tickets / Day', value: (technician.avgTicketsPerDay || 0).toFixed(1) },
          { label: 'Self-Picked / Day', value: (technician.avgSelfPickedPerDay || 0).toFixed(1) },
          { label: 'Closed / Day', value: (technician.avgClosedPerDay || 0).toFixed(1) },
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
          { label: 'Total', value: total, accent: 'bg-blue-600' },
          { label: 'Self-Picked', value: selfPicked },
          { label: 'Assigned', value: assigned },
          { label: 'Closed', value: closed, accent: 'bg-emerald-600' },
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

// ── Export ────────────────────────────────────────────────────────────────────

export default function OverviewTab({ technician, viewMode, selectedDate, openCount, pendingCount }) {
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

  return (
    <DailyOverview
      technician={technician}
      selectedDate={selectedDate}
      openCount={openCount}
      pendingCount={pendingCount}
    />
  );
}
