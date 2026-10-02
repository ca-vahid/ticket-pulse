import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { History, Settings2, UsersRound, X } from 'lucide-react';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import LightTabBar from '../components/common/LightTabBar';
import { hrLifecycleAPI } from '../services/api';
import { applyWidth, useLayoutWidth } from '../contexts/LayoutContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { setHrLifecycleStatus, useHrLifecycleStatus } from '../hooks/useHrLifecycleStatus';
import { Loading } from '../components/knowledge/knowledgeUi';
import PeoplePanel from '../components/onboarding/PeoplePanel';
import ActivityPanel from '../components/onboarding/ActivityPanel';
import SettingsPanel from '../components/onboarding/SettingsPanel';
import { StatusDot } from '../components/onboarding/onboardingUi';
import { MODE_INFO } from '../components/onboarding/onboardingFormat';

/**
 * Onboarding / Offboarding (HR lifecycle, plans/HR_LIFECYCLE_PLAN.md).
 *
 *   /onboarding/people    families: person, type, date, children n/m, status
 *   /onboarding/activity  every handled notice + decision (observe = the plan)
 *   /onboarding/settings  mode, parent assignee, child lists, rules, history
 *
 * Admin-only (AdminRoute) and only where the server enables the section
 * (GET /hr-lifecycle/status — IT for now). The mode sits at the right end of
 * the tab row as a dot + word, never a pill.
 */
const TABS = [
  { id: 'people', label: 'People', icon: UsersRound },
  { id: 'activity', label: 'Activity', icon: History },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];

export default function Onboarding() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { width: layoutWidth } = useLayoutWidth();
  const { currentWorkspace } = useWorkspace();
  const status = useHrLifecycleStatus();
  const [settingsData, setSettingsData] = useState(null);
  const [error, setError] = useState(null);

  const loadSettings = useCallback(() => {
    hrLifecycleAPI.getSettings()
      .then((res) => setSettingsData(res?.data || null))
      .catch((err) => setError(err?.message || 'Could not load Comings & Goings settings'));
  }, []);

  useEffect(() => {
    if (status.available) loadSettings();
  }, [status.available, loadSettings, currentWorkspace?.id]);

  const techById = useMemo(() => new Map((settingsData?.technicians || []).map((t) => [t.id, t])), [settingsData]);

  if (!tab) return <Navigate to="/onboarding/people" replace />;
  if (!TABS.some((t) => t.id === tab)) return <Navigate to="/onboarding/people" replace />;

  const mode = settingsData?.settings?.mode || status.mode || 'off';
  const info = MODE_INFO[mode] || MODE_INFO.off;

  let body;
  if (status.loading) body = <Loading label="Loading Comings & Goings…" />;
  else if (!status.available) {
    body = (
      <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground shadow-subtle">
        Comings &amp; Goings (onboarding and offboarding) is not switched on for {currentWorkspace?.name || 'this workspace'}.
      </div>
    );
  } else if (!settingsData && !error) body = <Loading label="Loading Comings & Goings…" />;
  else if (settingsData) {
    body = (
      <section role="tabpanel" id={`onboarding-panel-${tab}`} aria-labelledby={`onboarding-tab-${tab}`} tabIndex={-1} className="animate-fadeIn focus:outline-none">
        {tab === 'people' && <PeoplePanel />}
        {tab === 'activity' && <ActivityPanel techById={techById} />}
        {tab === 'settings' && (
          <SettingsPanel
            data={settingsData}
            onSaved={(settings) => {
              setSettingsData((d) => ({ ...d, settings: { ...d.settings, ...settings } }));
              setHrLifecycleStatus(currentWorkspace?.id, { mode: settings.mode });
            }}
          />
        )}
      </section>
    );
  }

  return (
    <div className="tp-tickets-backdrop min-h-screen md:pl-[var(--tp-rail-w,58px)]">
      <AppHeader activePage="onboarding" />
      <main className={applyWidth('mx-auto max-w-6xl px-4 py-6 pb-24 animate-fadeIn sm:px-6 lg:pb-6', layoutWidth)}>
        <LightTabBar tabs={TABS} activeId={tab} onSelect={(id) => navigate(`/onboarding/${id}`)} ariaLabel="Comings & Goings sections" idPrefix="onboarding">
          {status.available && (
            <span className="flex items-center gap-2 text-xs text-muted-foreground" title={info.hint} data-testid="onboarding-mode">
              Mode <StatusDot tone={info.tone} label={info.label} />
            </span>
          )}
        </LightTabBar>
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-200" role="alert">
            <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>{error}</span>
          </div>
        )}
        {body}
      </main>
      <MobileTabBar />
    </div>
  );
}
