import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Settings2, X } from 'lucide-react';
import { knowledgePictogram } from '../components/v4/KnowledgePictogram';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import { knowledgeAPI } from '../services/api';
import { applyWidth, useLayoutWidth } from '../contexts/LayoutContext';
import KnowledgeSettingsPanel from '../components/knowledge/KnowledgeSettingsPanel';
import LightTabBar from '../components/common/LightTabBar';
import ArticlesPanel from '../components/knowledge/ArticlesPanel';
import PlaybooksPanel from '../components/knowledge/PlaybooksPanel';
import WaitingPanel from '../components/knowledge/WaitingPanel';
import ApprovalsPanel from '../components/knowledge/ApprovalsPanel';
import ActivityPanel from '../components/knowledge/ActivityPanel';
import GapsPanel from '../components/knowledge/GapsPanel';
import { ConfirmDialog, KnowledgeGuardContext, Loading } from '../components/knowledge/knowledgeUi';
import { TabActionsContext } from '../components/knowledge/builderUi';

/**
 * Knowledge (Auto-help P0, plans/AUTO_HELP_PLAN.md): the articles we can
 * stand behind and the playbooks that use them to draft first answers.
 * Shadow and approve modes (P1) — nothing reaches a requester unless an agent sends it.
 *
 * Every tab has its own URL (/knowledge/articles, /gaps, /playbooks,
 * /waiting, /activity, /settings) and an open article / playbook / run adds its id, so
 * F5 and shared links land where you were. The tab bar is the light
 * LightTabBar (Knowledge redesign, 26 Sep 2026: soft blue fill + underline on
 * the selected tab; WAI-ARIA tabs: arrow keys, Home/End, roving tabindex);
 * its right end carries the open tab's page actions (TabActions portals
 * them there); the workspace switches live on the Settings tab
 * (26 Sep 2026, Vahid: no page header, settings out of the way). Editors with unsaved changes ask
 * before any in-section navigation (in-app dialog) and before the browser tab
 * closes (the browser's own prompt).
 */
// Ticket Pulse 4 (v4.0.01): the content tabs carry the v4 pictograms;
// Settings keeps a plain glyph so it reads as chrome, not content.
const TABS = [
  { id: 'articles', label: 'Articles', icon: knowledgePictogram('articles') },
  { id: 'gaps', label: 'Gaps', icon: knowledgePictogram('gaps') },
  { id: 'playbooks', label: 'Playbooks', icon: knowledgePictogram('playbooks') },
  { id: 'waiting', label: 'Waiting', icon: knowledgePictogram('followup') },
  // Reviewers and admins only (30 Sep 2026): every Auto-help answer waiting to be sent.
  { id: 'approvals', label: 'Approvals', icon: knowledgePictogram('approve') },
  { id: 'activity', label: 'Activity', icon: knowledgePictogram('autohelp') },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];

export default function Knowledge() {
  const { tab, itemId } = useParams();
  const navigate = useNavigate();
  const { width: layoutWidth } = useLayoutWidth();
  const [settings, setSettings] = useState(null);
  const [categories, setCategories] = useState([]);
  const [error, setError] = useState(null);
  const [dirty, setDirtyState] = useState(false);
  const [pendingNav, setPendingNav] = useState(null);
  const [actionsNode, setActionsNode] = useState(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([knowledgeAPI.getSettings(), knowledgeAPI.categories().catch(() => ({ data: [] }))])
      .then(([s, c]) => {
        if (cancelled) return;
        setSettings(s?.data || null);
        setCategories(c?.data || []);
      })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load Knowledge'); });
    return () => { cancelled = true; };
  }, []);

  // Closing or reloading the browser tab with unsaved edits: the browser's own prompt.
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const setDirty = useCallback((v) => { dirtyRef.current = Boolean(v); setDirtyState(Boolean(v)); }, []);
  const leave = useCallback((to) => {
    if (dirtyRef.current) setPendingNav(to);
    else navigate(to);
  }, [navigate]);
  const guard = useMemo(() => ({ setDirty, leave }), [setDirty, leave]);

  if (!tab) return <Navigate to="/knowledge/articles" replace />;
  if (!TABS.some((t) => t.id === tab)) return <Navigate to="/knowledge/articles" replace />;
  const canManage = settings?.canManage === true;
  const tabs = TABS.filter((t) => t.id !== 'approvals' || settings?.canApprove === true);
  // A tab click also closes an open article / playbook / run on the same tab.
  const selectTab = (id) => { if (id !== tab || itemId) leave(`/knowledge/${id}`); };

  return (
    <KnowledgeGuardContext.Provider value={guard}>
      <div className="tp-tickets-backdrop min-h-screen md:pl-[var(--tp-rail-w,58px)]">
        <AppHeader activePage="knowledge" />
        <main className={applyWidth('mx-auto max-w-6xl px-4 py-6 pb-24 animate-fadeIn sm:px-6 lg:pb-6', layoutWidth)}>
          <LightTabBar tabs={tabs} activeId={tab} onSelect={selectTab} ariaLabel="Knowledge sections" idPrefix="knowledge">
            <div ref={setActionsNode} className="flex flex-wrap items-center justify-end gap-2" data-testid="knowledge-tab-actions" />
          </LightTabBar>

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-200" role="alert">
              <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>{error}</span>
            </div>
          )}

          <TabActionsContext.Provider value={actionsNode}>
            {!settings && !error ? <Loading label="Loading Knowledge…" /> : (
              <section
                role="tabpanel"
                id={`knowledge-panel-${tab}`}
                aria-labelledby={`knowledge-tab-${tab}`}
                tabIndex={-1}
                className="animate-fadeIn focus:outline-none"
              >
                {tab === 'articles' && <ArticlesPanel itemId={itemId} categories={categories} canManage={canManage} />}
                {tab === 'gaps' && <GapsPanel canManage={canManage} canRefresh={canManage || settings?.canReview === true} />}
                {tab === 'playbooks' && <PlaybooksPanel itemId={itemId} categories={categories} canManage={canManage} tools={settings?.tools || []} defaults={settings?.defaults || null} />}
                {tab === 'waiting' && <WaitingPanel />}
                {tab === 'approvals' && <ApprovalsPanel />}
                {tab === 'activity' && <ActivityPanel runId={itemId || null} canReview={settings?.canReview === true} />}
                {tab === 'settings' && <KnowledgeSettingsPanel settings={settings} onChange={setSettings} />}
              </section>
            )}
          </TabActionsContext.Provider>
        </main>
        <MobileTabBar />
        <ConfirmDialog
          open={Boolean(pendingNav)}
          title="Leave without saving?"
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          destructive
          onCancel={() => setPendingNav(null)}
          onConfirm={() => {
            const to = pendingNav;
            setPendingNav(null);
            setDirty(false);
            navigate(to);
          }}
        >
          Your edits here have not been saved.
        </ConfirmDialog>
      </div>
    </KnowledgeGuardContext.Provider>
  );
}
