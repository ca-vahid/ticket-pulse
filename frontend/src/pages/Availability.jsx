import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { CalendarDays, CalendarRange, Inbox, Settings2 } from 'lucide-react';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import LightTabBar from '../components/common/LightTabBar';
import { availabilityAPI } from '../services/api';
import { applyWidth, useLayoutWidth } from '../contexts/LayoutContext';
import { ErrorNote, Loading, useToast } from '../components/availability/availabilityUi';
import MyTimePanel from '../components/availability/MyTimePanel';
import TeamCalendarPanel from '../components/availability/TeamCalendarPanel';
import ApprovalsPanel from '../components/availability/ApprovalsPanel';
import AdminSettingsPanel from '../components/availability/AdminSettingsPanel';

/**
 * Availability — the native Vacation Tracker replacement.
 *
 *   /availability/my-time    balances, book time away (live verdict), my requests
 *   /availability/calendar   team month grid + who's out today
 *   /availability/approvals  pending requests I may decide (approvers / admins)
 *   /availability/settings   types, groups, rules, offices, people, balances, import
 *
 * Open to every signed-in person, agents included — booking your own time is
 * not a coordinator job. Approvals shows only to approvers with something
 * waiting (or admins); Settings only to Availability admins.
 */

const TAB_IDS = ['my-time', 'calendar', 'approvals', 'settings'];

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
    const list = [
      { id: 'my-time', label: 'My time', icon: CalendarDays },
      { id: 'calendar', label: 'Team calendar', icon: CalendarRange },
    ];
    if (me && (pending > 0 || me.isAdmin)) list.push({ id: 'approvals', label: pending > 0 ? `Approvals ${pending}` : 'Approvals', icon: Inbox });
    if (me?.isAdmin) list.push({ id: 'settings', label: 'Settings', icon: Settings2 });
    return list;
  }, [me, pending]);

  const nameByEmail = useMemo(() => (config?.people ? new Map(config.people.map((p) => [p.email, p.name])) : null), [config]);

  if (!tab || !TAB_IDS.includes(tab)) return <Navigate to="/availability/my-time" replace />;
  if (me && !tabs.some((t) => t.id === tab)) return <Navigate to="/availability/my-time" replace />;

  let body;
  if (!me && error) body = <ErrorNote>{error}</ErrorNote>;
  else if (!me) body = <Loading label="Loading Availability…" />;
  else {
    body = (
      <section role="tabpanel" id={`availability-panel-${tab}`} aria-labelledby={`availability-tab-${tab}`} tabIndex={-1} className="animate-fadeIn focus:outline-none">
        {tab === 'my-time' && <MyTimePanel me={me} onChanged={loadMe} toast={toast.show} />}
        {tab === 'calendar' && <TeamCalendarPanel me={me} groups={config?.groups || null} />}
        {tab === 'approvals' && <ApprovalsPanel me={me} nameByEmail={nameByEmail} toast={toast.show} onChanged={loadMe} />}
        {tab === 'settings' && <AdminSettingsPanel config={config} error={configError} reload={reloadAdmin} toast={toast.show} />}
      </section>
    );
  }

  return (
    <div className="tp-tickets-backdrop min-h-screen md:pl-[var(--tp-rail-w,58px)]">
      <AppHeader activePage="availability" />
      <main className={applyWidth('mx-auto max-w-6xl px-4 py-6 pb-24 animate-fadeIn sm:px-6 lg:pb-6', layoutWidth)}>
        <LightTabBar tabs={tabs} activeId={tab} onSelect={(id) => navigate(`/availability/${id}`)} ariaLabel="Availability sections" idPrefix="availability">
          {me?.person?.name && <span className="text-xs text-muted-foreground">{me.person.name}</span>}
        </LightTabBar>
        {me && error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}
        {body}
      </main>
      {toast.node}
      <MobileTabBar />
    </div>
  );
}
