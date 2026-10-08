import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, RefreshCw, Search } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { siteStatsAPI } from '../../services/api';
import { useChartColors } from '../../utils/highchartsTheme';
import { PersonAvatar, timeAgo } from '../tickets/ticketUi';
import FancySelect from '../common/FancySelect';
import { TRACKED_ROUTES, pageLabel } from '../../utils/usageTracker';
import { ALL_SETTINGS_NAV_ITEMS } from '../../pages/settingsNav';

/**
 * Settings -> Site stats (super admins only). How much the site is used, by
 * whom, on which pages and when. It measures the tool, not the people: there
 * is no ranking by time, and every count says how many people it is out of.
 */

const RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '28', label: 'Last 28 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last year' },
];
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'people', label: 'People' },
  { id: 'items', label: 'Pages and actions' },
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const fmtInt = (n) => Number(n || 0).toLocaleString();
function fmtMinutes(minutes) {
  const m = Math.round(Number(minutes) || 0);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}
const hourLabel = (h) => `${((h + 11) % 12) + 1} ${h < 12 ? 'am' : 'pm'}`;
const shortDay = (day) => {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
};
const fullDate = (value) => (value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** "8 am to 5 pm" from the hours a person was active on at least a third of their days. */
function usualHours(hourCounts = [], activeDays = 0) {
  if (!activeDays) return '';
  const floor = Math.max(1, Math.ceil(activeDays / 3));
  const hours = hourCounts.map((count, h) => (count >= floor ? h : -1)).filter((h) => h >= 0);
  if (!hours.length) return '';
  return `${hourLabel(hours[0])} to ${hourLabel((hours[hours.length - 1] + 1) % 24)}`;
}

const SETTINGS_LABELS = new Map(ALL_SETTINGS_NAV_ITEMS.map((item) => [item.id, item.label]));
function pageName(key, section) {
  if (key === 'settings' && section) return `Settings: ${SETTINGS_LABELS.get(section) || section.replace(/-/g, ' ')}`;
  if (key === 'tickets.list' && section === 'peek') return 'Ticket peek';
  return pageLabel(key, section);
}

const TH = 'py-1.5 px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75';
const TD = 'py-1.5 px-3 tabular-nums text-muted-foreground';

function Figure({ label, value, of, previous, hint }) {
  const delta = previous === undefined || previous === null ? null : value - previous;
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">{label}</p>
      <p className="mt-0.5 text-2xl font-bold tabular-nums text-foreground">
        {fmtInt(value)}
        {of !== undefined && <span className="ml-1.5 text-sm font-medium text-muted-foreground">of {fmtInt(of)}</span>}
      </p>
      {delta !== null && (
        <p className="text-[11px] text-muted-foreground/75">
          {delta === 0 ? 'same as' : `${delta > 0 ? '+' : ''}${delta} vs`} the period before
        </p>
      )}
      {hint && <p className="text-[11px] text-muted-foreground/75">{hint}</p>}
    </div>
  );
}

function NameList({ title, empty, rows, sub }) {
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-bold text-foreground">{title} <span className="font-medium text-muted-foreground">({rows.length})</span></h3>
      {rows.length === 0
        ? <p className="mt-1 text-xs text-muted-foreground">{empty}</p>
        : (
          <ul className="mt-1.5 max-h-56 space-y-1 overflow-y-auto settings-scrollbar pr-1">
            {rows.map((r) => (
              <li key={r.email} className="flex items-center gap-2 text-sm">
                <PersonAvatar name={r.name} size="h-5 w-5" textSize="text-[9px]" />
                <span className="truncate text-foreground/85" title={r.email}>{r.name}</span>
                {sub && sub(r) && <span className="ml-auto flex-none text-[11px] text-muted-foreground/75">{sub(r)}</span>}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

function HoursGrid({ hours }) {
  const max = Math.max(1, ...hours.flat());
  return (
    <div className="overflow-x-auto settings-scrollbar">
      <table className="border-separate" style={{ borderSpacing: 2 }} aria-label="Active people by weekday and hour, Pacific time">
        <thead>
          <tr>
            <th />
            {Array.from({ length: 24 }, (_, h) => (
              <th key={h} className="w-6 text-center text-[9px] font-medium text-muted-foreground/75">{h % 3 === 0 ? hourLabel(h).replace(' ', '') : ''}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WEEK_ORDER.map((weekday) => (
            <tr key={weekday}>
              <th scope="row" className="pr-2 text-left text-[11px] font-medium text-muted-foreground">{WEEKDAYS[weekday]}</th>
              {hours[weekday].map((count, h) => (
                <td
                  key={h}
                  title={`${WEEKDAYS[weekday]} ${hourLabel(h)}: ${count} person-day${count === 1 ? '' : 's'}`}
                  className="h-5 w-6 rounded-sm bg-muted/50"
                  style={count ? { backgroundColor: `hsl(var(--primary) / ${(0.15 + 0.75 * (count / max)).toFixed(2)})` } : undefined}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Overview({ data }) {
  const chartColors = useChartColors();
  const [weekdaysOnly, setWeekdaysOnly] = useState(true);
  const series = useMemo(
    () => data.series.filter((d) => !weekdaysOnly || d.weekday).map((d) => ({ ...d, label: shortDay(d.day) })),
    [data.series, weekdaysOnly],
  );
  const total = data.peopleWithAccess;
  const t = data.totals;
  return (
    <div className="space-y-6">
      {!data.collectionStartedOn && (
        <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          Nothing has been recorded yet. Figures appear a few minutes after people use the site.
        </p>
      )}
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Active today" value={data.active.today.active} of={total} />
        <Figure label="Last 7 days" value={data.active.week.active} of={total} previous={data.active.week.previous} />
        <Figure label="Last 28 days" value={data.active.month.active} of={total} previous={data.active.month.previous} />
        <Figure label="Sign-ins in this range" value={t.signIns} hint="Sign-in is kept for 7 days, so this is lower than visits." />
      </div>

      <section>
        <div className="mb-1 flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-bold text-foreground">People active per day</h3>
          <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" className="tp-focus-ring rounded border-input" checked={weekdaysOnly} onChange={(e) => setWeekdaysOnly(e.target.checked)} />
            Weekdays only
          </label>
        </div>
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={chartColors.grid} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: chartColors.axis }} tickLine={false} axisLine={false} minTickGap={16} />
              <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: chartColors.axis }} tickLine={false} axisLine={false} width={28} />
              <Tooltip
                formatter={(value) => [`${value} of ${total}`, 'People']}
                contentStyle={{ fontSize: 12, borderRadius: 8, backgroundColor: chartColors.tooltipBg, border: `1px solid ${chartColors.tooltipBorder}`, color: chartColors.text }}
                labelStyle={{ fontSize: 12, color: chartColors.text }}
                itemStyle={{ color: chartColors.text }}
              />
              <Bar dataKey="active" name="People" fill={chartColors.series.blueDeep} radius={[3, 3, 0, 0]} maxBarSize={26} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          In this range: {fmtInt(t.visits)} visits, {fmtInt(t.pageViews)} page views, {fmtInt(t.actions)} actions,
          {' '}{fmtMinutes(t.openMinutes)} with the site open, {fmtMinutes(t.engagedMinutes)} of it with input.
          {data.collectionStartedOn && ` Recording started ${shortDay(data.collectionStartedOn)}.`}
        </p>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-1 text-sm font-bold text-foreground">By workspace</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60">
                <th className={`${TH} pl-0 text-left`}>Workspace</th>
                <th className={`${TH} text-right`}>Active</th>
                <th className={`${TH} pr-0 text-right`}>People</th>
              </tr>
            </thead>
            <tbody>
              {data.byWorkspace.map((w) => (
                <tr key={w.id} className="border-b border-border/60 last:border-0">
                  <td className="py-1.5 pr-3 text-foreground/85">{w.name}</td>
                  <td className={`${TD} text-right font-semibold text-foreground`}>{w.active}</td>
                  <td className={`${TD} pr-0 text-right`}>{w.people}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h3 className="mb-1 text-sm font-bold text-foreground">By role</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60">
                <th className={`${TH} pl-0 text-left`}>Role</th>
                <th className={`${TH} text-right`}>Active</th>
                <th className={`${TH} pr-0 text-right`}>People</th>
              </tr>
            </thead>
            <tbody>
              {data.byRole.map((r) => (
                <tr key={r.role} className="border-b border-border/60 last:border-0">
                  <td className="py-1.5 pr-3 capitalize text-foreground/85">{r.role}</td>
                  <td className={`${TD} text-right font-semibold text-foreground`}>{r.active}</td>
                  <td className={`${TD} pr-0 text-right`}>{r.people}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 className="text-sm font-bold text-foreground">When people use it</h3>
        <p className="mb-2 text-xs text-muted-foreground">Darker means more people were active in that hour (Pacific time). The pale hours are the quiet ones.</p>
        <HoursGrid hours={data.hours} />
      </section>

      <section className="grid gap-6 sm:grid-cols-3">
        <NameList title="New in this range" empty="Nobody used the site for the first time." rows={data.lists.newPeople} sub={(r) => timeAgo(r.firstSeenAt)} />
        <NameList title="Gone quiet" empty="Nobody who was active has stopped." rows={data.lists.quiet} sub={(r) => (r.lastSeenAt ? timeAgo(r.lastSeenAt) : '')} />
        <NameList title="Never seen" empty="Everyone with access has used the site." rows={data.lists.never} sub={(r) => r.role} />
      </section>
      <p className="text-xs text-muted-foreground">
        Gone quiet: active in the four weeks before, nothing in the last two. Never seen: has access, no activity since recording started.
      </p>

      <section className="grid gap-6 sm:grid-cols-3">
        {[['Browser', data.browsers], ['Device', data.devices], ['Window size', data.viewports]].map(([title, rows]) => (
          <div key={title}>
            <h3 className="mb-1 text-sm font-bold text-foreground">{title}</h3>
            {rows.length === 0
              ? <p className="text-xs text-muted-foreground">No data yet.</p>
              : (
                <ul className="space-y-0.5 text-sm">
                  {rows.map((r) => (
                    <li key={r.name} className="flex justify-between gap-3">
                      <span className="capitalize text-foreground/85">{r.name}</span>
                      <span className="tabular-nums text-muted-foreground">{r.count} {r.count === 1 ? 'person' : 'people'}</span>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        ))}
      </section>
    </div>
  );
}

const STATUS_OPTIONS = [
  { value: 'all', label: 'Everyone' },
  { value: 'active', label: 'Active in the last 14 days' },
  { value: 'quiet', label: 'Seen, but not in the last 14 days' },
  { value: 'never', label: 'Never seen' },
];
const FORTNIGHT_MS = 14 * 24 * 60 * 60 * 1000;

function WeekStrip({ weeks }) {
  return (
    <span className="inline-flex gap-0.5" role="img" aria-label={`Active days per week, last 12 weeks: ${weeks.join(', ')}`}>
      {weeks.map((days, i) => (
        <span
          key={i} // fixed twelve slots, never reordered
          title={`${12 - i === 1 ? 'This week' : `${11 - i} week${11 - i === 1 ? '' : 's'} ago`}: ${days} day${days === 1 ? '' : 's'}`}
          className="h-4 w-2 rounded-sm bg-muted"
          style={days ? { backgroundColor: `hsl(var(--primary) / ${(0.2 + 0.8 * Math.min(days, 5) / 5).toFixed(2)})` } : undefined}
        />
      ))}
    </span>
  );
}

function People({ data }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    return data.people.filter((p) => {
      if (q && !`${p.name} ${p.email}`.toLowerCase().includes(q)) return false;
      const recent = p.lastSeenAt && now - new Date(p.lastSeenAt).getTime() <= FORTNIGHT_MS;
      if (status === 'active') return recent;
      if (status === 'quiet') return p.lastSeenAt && !recent;
      if (status === 'never') return !p.lastSeenAt;
      return true;
    });
  }, [data.people, query, status]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <span className="sr-only">Find a person</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a person"
            className="tp-focus-ring h-9 w-56 rounded-lg border border-input bg-card pl-8 pr-2 text-sm text-foreground placeholder:text-muted-foreground/75"
          />
        </label>
        <div className="w-64"><FancySelect value={status} onChange={setStatus} options={STATUS_OPTIONS} aria-label="Show" className="h-9" /></div>
        <span className="ml-auto text-xs text-muted-foreground">{rows.length} of {data.people.length} people. Averages are per active day, last 28 days.</span>
      </div>
      <div className="overflow-x-auto settings-scrollbar">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60">
              <th className={`${TH} pl-0 text-left`}>Person</th>
              <th className={`${TH} text-left`}>Last seen</th>
              <th className={`${TH} text-left`}>Last sign-in</th>
              <th className={`${TH} text-right`} title="Days with activity in the last 28">Active days</th>
              <th className={`${TH} text-left`}>12 weeks</th>
              <th className={`${TH} text-left`}>Usual hours</th>
              <th className={`${TH} text-right`}>Visits</th>
              <th className={`${TH} text-right`} title="Tab visible">Open</th>
              <th className={`${TH} text-right`} title="Tab visible with input in the last minute">With input</th>
              <th className={`${TH} text-left`}>Most time on</th>
              <th className={`${TH} pr-0 text-left`}>Device</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.email} className="border-b border-border/60 last:border-0">
                <td className="py-2 pr-3">
                  <span className="flex items-center gap-2">
                    <PersonAvatar name={p.name} size="h-7 w-7" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-foreground" title={p.email}>{p.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground/75">
                        {p.hasAccess ? [p.role, p.workspaces.map((w) => w.name).join(', ')].filter(Boolean).join(' · ') : 'no longer has access'}
                      </span>
                    </span>
                  </span>
                </td>
                <td className={`${TD} whitespace-nowrap`} title={fullDate(p.lastSeenAt)}>{p.lastSeenAt ? timeAgo(p.lastSeenAt) : 'never'}</td>
                <td className={`${TD} whitespace-nowrap`} title={fullDate(p.lastSignInAt)}>{p.lastSignInAt ? timeAgo(p.lastSignInAt) : ''}</td>
                <td className={`${TD} text-right font-semibold text-foreground`}>{p.activeDays}</td>
                <td className="px-3 py-2"><WeekStrip weeks={p.weeks} /></td>
                <td className={`${TD} whitespace-nowrap`}>{usualHours(p.hourCounts, p.activeDays)}</td>
                <td className={`${TD} text-right`}>{p.activeDays ? p.visitsPerDay : ''}</td>
                <td className={`${TD} whitespace-nowrap text-right`}>{p.activeDays ? fmtMinutes(p.openMinutesPerDay) : ''}</td>
                <td className={`${TD} whitespace-nowrap text-right`}>{p.activeDays ? fmtMinutes(p.engagedMinutesPerDay) : ''}</td>
                <td className={`${TD} max-w-[18rem] truncate`} title={p.topPages.map((page) => pageName(page.key, page.section)).join(', ')}>
                  {p.topPages.map((page) => pageName(page.key, page.section)).join(', ')}
                </td>
                <td className={`${TD} whitespace-nowrap pr-0 capitalize`}>{[p.browser, p.device].filter(Boolean).join(', ')}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={11} className="py-6 text-center text-sm text-muted-foreground">Nobody matches.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Items({ data }) {
  const opened = new Set(data.pages.map((p) => p.key));
  const unopened = [...new Map(TRACKED_ROUTES.map((r) => [r.key, r.label])).entries()].filter(([key]) => !opened.has(key));
  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-bold text-foreground">Pages</h3>
        <p className="mb-1 text-xs text-muted-foreground">Ranked by how many people opened the page, then by views. Open is time with the tab visible; with input is the part where someone was clicking, typing or scrolling.</p>
        <div className="overflow-x-auto settings-scrollbar">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60">
                <th className={`${TH} pl-0 text-left`}>Page</th>
                <th className={`${TH} text-right`}>People</th>
                <th className={`${TH} text-right`}>Views</th>
                <th className={`${TH} text-right`}>Open</th>
                <th className={`${TH} pr-0 text-right`}>With input</th>
              </tr>
            </thead>
            <tbody>
              {data.pages.map((p) => (
                <tr key={`${p.key}|${p.section}`} className="border-b border-border/60 last:border-0">
                  <td className="py-1.5 pr-3 text-foreground/85">{pageName(p.key, p.section)}</td>
                  <td className={`${TD} text-right font-semibold text-foreground`}>{p.people}</td>
                  <td className={`${TD} text-right`}>{fmtInt(p.count)}</td>
                  <td className={`${TD} whitespace-nowrap text-right`}>{fmtMinutes(p.openMinutes)}</td>
                  <td className={`${TD} whitespace-nowrap pr-0 text-right`}>{fmtMinutes(p.engagedMinutes)}</td>
                </tr>
              ))}
              {data.pages.length === 0 && (
                <tr><td colSpan={5} className="py-6 text-center text-sm text-muted-foreground">No page views in this range yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {data.pages.length > 0 && unopened.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground/85">Nobody opened in this range:</span> {unopened.map(([, label]) => label).join(', ')}.
          </p>
        )}
      </section>

      <section>
        <h3 className="text-sm font-bold text-foreground">Actions</h3>
        <p className="mb-1 text-xs text-muted-foreground">What people did, counted on the server. An action without a name yet is shown as its request.</p>
        <div className="overflow-x-auto settings-scrollbar">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60">
                <th className={`${TH} pl-0 text-left`}>Action</th>
                <th className={`${TH} text-right`}>People</th>
                <th className={`${TH} pr-0 text-right`}>Times</th>
              </tr>
            </thead>
            <tbody>
              {data.actions.map((a) => (
                <tr key={`${a.kind}|${a.key}`} className="border-b border-border/60 last:border-0">
                  <td className="py-1.5 pr-3 text-foreground/85">
                    {a.label || <code className="text-xs text-muted-foreground">{a.key}</code>}
                  </td>
                  <td className={`${TD} text-right font-semibold text-foreground`}>{a.people}</td>
                  <td className={`${TD} pr-0 text-right`}>{fmtInt(a.count)}</td>
                </tr>
              ))}
              {data.actions.length === 0 && (
                <tr><td colSpan={3} className="py-6 text-center text-sm text-muted-foreground">No actions in this range yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default function SiteStatsPanel() {
  const [tab, setTab] = useState('overview');
  const [days, setDays] = useState('28');
  const [workspaceId, setWorkspaceId] = useState('');
  const [workspaces, setWorkspaces] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { days: Number(days), ...(workspaceId ? { workspaceId: Number(workspaceId) } : {}) };
      const call = tab === 'people' ? siteStatsAPI.people : tab === 'items' ? siteStatsAPI.items : siteStatsAPI.overview;
      // The API client hands back the report itself (the { success, data } envelope is already removed).
      const report = await call(params);
      setData({ tab, value: report });
      if (report?.workspaces) setWorkspaces(report.workspaces);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not load site stats');
    } finally {
      setLoading(false);
    }
  }, [tab, days, workspaceId]);

  useEffect(() => { load(); }, [load]);

  const workspaceOptions = useMemo(
    () => [{ value: '', label: 'All workspaces' }, ...workspaces.map((w) => ({ value: String(w.id), label: w.name }))],
    [workspaces],
  );
  const current = data && data.tab === tab ? data.value : null;

  return (
    <div className="space-y-4" data-testid="site-stats-panel">
      <div>
        <h2 className="text-lg font-bold text-foreground">Site stats</h2>
        <p className="text-sm text-muted-foreground">
          How much Ticket Pulse is used, on which pages and when, so we can improve the pages people rely on.
          Visible to super admins only. Page names and times are recorded; ticket content, search text and addresses are not.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border/60">
        <div role="tablist" aria-label="Site stats views" className="flex gap-4">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`tp-focus-ring -mb-px border-b-2 px-0.5 pb-2 text-sm font-semibold ${tab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 pb-2">
          {tab !== 'people' && (
            <div className="w-40"><FancySelect value={days} onChange={setDays} options={RANGES} aria-label="Date range" className="h-9" /></div>
          )}
          <div className="w-48"><FancySelect value={workspaceId} onChange={setWorkspaceId} options={workspaceOptions} aria-label="Workspace" className="h-9" /></div>
          <button type="button" onClick={load} className="tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-input bg-card px-3 text-sm text-foreground hover:bg-muted/50" aria-label="Refresh">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>

      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-200">{error}</p>}
      {!current && loading && (
        <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading</p>
      )}
      {current && tab === 'overview' && <Overview data={current} />}
      {current && tab === 'people' && <People data={current} />}
      {current && tab === 'items' && <Items data={current} />}
    </div>
  );
}
