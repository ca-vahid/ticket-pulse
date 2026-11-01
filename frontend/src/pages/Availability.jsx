import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { CalendarDays, CalendarPlus, CalendarRange, History, Inbox, LayoutDashboard, Rows3, Settings2 } from 'lucide-react';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import LightTabBar from '../components/common/LightTabBar';
import { availabilityAPI } from '../services/api';
import { applyWidth, useLayoutWidth } from '../contexts/LayoutContext';
import { ErrorNote, Loading, useToast } from '../components/availability/availabilityUi';
import MyTimePanel from '../components/availability/MyTimePanel';
import TeamCalendarPanel from '../components/availability/TeamCalendarPanel';
import MonthCalendarPanel from '../components/availability/MonthCalendarPanel';
import OverviewPanel from '../components/availability/OverviewPanel';
import ApprovalsPanel from '../components/availability/ApprovalsPanel';
import AdminSettingsPanel from '../components/availability/AdminSettingsPanel';
import RequestHistoryPanel from '../components/availability/RequestHistoryPanel';

/**
 * Availability — the native Vacation Tracker replacement.
 *
 *   /availability/overview   who is out this week, my balance, holidays, coverage (default)
 *   /availability/calendar   wallchart: people by day, grouped by office / approval group
 *   /availability/month      the month with named bars
 *   /availability/my-time    balances, book time away (live verdict), my requests
 *   /availability/approvals  pending requests I may decide (approvers / admins)
 *   /availability/history    anyone's requests, past and present (admins, QA 10-21 #1)
 *   /availability/settings   types, groups, rules, offices, people, balances, import
 *
 * Open to every signed-in person, agents included — booking your own time is
 * not a coordinator job. Approvals shows only to approvers with something
 * waiting (or admins); Settings only to Availability admins.
 */

const TAB_IDS = ['overview', 'calendar', 'month', 'my-time', 'approvals', 'history', 'settings'];

/** The booking form on My time, once it has rendered (it loads after the tab). */
function focusBookingForm(tries = 12) {
  const form = typeof document !== 'undefined' ? document.querySelector('form[aria-label="Book time away"]') : null;
  if (form) {
    form.scrollIntoView({ block: 'start', behavior: 'smooth' });
    form.querySelector('select, input, button, [tabindex]')?.focus?.({ preventScroll: true });
    return;
  }
  if (tries > 0) setTimeout(() => focusBookingForm(tries - 1), 120);
}

/**
 * QA 10-30 #1: "Book time away" is the main thing people come here for, and as
 * a small link in the My time card it was easy to miss. It is now the one solid
 * button at the top right of every tab. A soft ring pulses four times when the
 * page opens and then stops (Vahid, 31 Oct 2026: a ping that kept going and
 * grew the page was too much); none when the app's motion setting is off.
 */
export function BookTimeButton({ onClick, className = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="book-time-away"
      className={`tp-focus-ring tp-book-pulse inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-soft hover:bg-blue-700 ${className}`}
    >
      <CalendarPlus className="h-4 w-4" aria-hidden="true" />
      <span>Book time away</span>
    </button>
  );
}

export default function Availability() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { width: layoutWidth } = useLayoutWidth();
  const toast = useToast();
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);

  const loadMe = useCallback(() => {
    availabilityAPI.me()
      .then((res) => { setMe(res?.data || null); setError(null); })
      .catch((err) => setError(err?.message || 'Could not load Availability'));
  }, []);

  const loadConfig = useCallback(() => {
    availabilityAPI.adminConfig()
      .then((res) => { setConfig(res?.data || null); setConfigError(null); })
      .catch((err) => setConfigError(err?.message || 'Could not load Availability settings'));
  }, []);

  useEffect(() => { loadMe(); }, [loadMe]);
  useEffect(() => { if (me?.isAdmin) loadConfig(); }, [me?.isAdmin, loadConfig]);

  const reloadAdmin = useCallback(() => { loadConfig(); loadMe(); }, [loadConfig, loadMe]);

  const pending = Number(me?.pendingApprovals) || 0;
  const tabs = useMemo(() => {
    // 5 Oct 2026 (Vahid): Overview first and the default; the old team grid is the Wallchart.
    const list = [
      { id: 'overview', label: 'Overview', icon: LayoutDashboard },
      { id: 'calendar', label: 'Wallchart', icon: Rows3 },
      { id: 'month', label: 'Calendar', icon: CalendarRange },
      { id: 'my-time', label: 'My time', icon: CalendarDays },
    ];
    if (me && (pending > 0 || Number(me.otherApprovals) > 0 || me.isAdmin)) list.push({ id: 'approvals', label: 'Approvals', icon: Inbox, badge: pending, badgeLabel: 'waiting' });
    if (me?.isAdmin) list.push({ id: 'history', label: 'History', icon: History });
    if (me?.isAdmin) list.push({ id: 'settings', label: 'Settings', icon: Settings2 });
    return list;
  }, [me, pending]);

  const nameByEmail = useMemo(() => (config?.people ? new Map(config.people.map((p) => [p.email, p.name])) : null), [config]);
  const bookTime = () => {
    if (tab !== 'my-time') navigate('/availability/my-time');
    focusBookingForm();
  };

  if (!tab || !TAB_IDS.includes(tab)) return <Navigate to="/availability/overview" replace />;
  if (me && !tabs.some((t) => t.id === tab)) return <Navigate to="/availability/overview" replace />;

  let body;
  if (!me && error) body = <ErrorNote>{error}</ErrorNote>;
  else if (!me) body = <Loading label="Loading Availability…" />;
  else {
    body = (
      <section role="tabpanel" id={`availability-panel-${tab}`} aria-labelledby={`availability-tab-${tab}`} tabIndex={-1} className="animate-fadeIn focus:outline-none">
        {tab === 'overview' && <OverviewPanel me={me} />}
        {tab === 'calendar' && <TeamCalendarPanel me={me} />}
        {tab === 'month' && <MonthCalendarPanel me={me} />}
        {tab === 'my-time' && <MyTimePanel me={me} onChanged={loadMe} toast={toast.show} />}
        {tab === 'approvals' && <ApprovalsPanel me={me} nameByEmail={nameByEmail} toast={toast.show} onChanged={loadMe} />}
        {tab === 'history' && <RequestHistoryPanel me={me} config={config} />}
        {tab === 'settings' && <AdminSettingsPanel config={config} error={configError} reload={reloadAdmin} toast={toast.show} />}
      </section>
    );
  }

  return (
    <div className="tp-tickets-backdrop min-h-screen md:pl-[var(--tp-rail-w,58px)]">
      <AppHeader activePage="availability" />
      <main className={applyWidth('mx-auto max-w-6xl px-4 py-6 pb-24 animate-fadeIn sm:px-6 lg:pb-6', layoutWidth)}>
        <LightTabBar tabs={tabs} activeId={tab} onSelect={(id) => navigate(`/availability/${id}`)} ariaLabel="Availability sections" idPrefix="availability" className="max-sm:[&>div:nth-child(2)]:hidden">
          <span className="hidden items-center gap-3 sm:inline-flex">
            {me?.person?.name && <span className="text-xs text-muted-foreground">{me.person.name}</span>}
            <BookTimeButton onClick={bookTime} />
          </span>
        </LightTabBar>
        {/* Phones: the tab bar hides its right side, so the button gets its own row. */}
        <BookTimeButton onClick={bookTime} className="mb-4 w-full sm:hidden" />
        {me && error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}
        {body}
      </main>
      {toast.node}
      <MobileTabBar />
    </div>
  );
}
