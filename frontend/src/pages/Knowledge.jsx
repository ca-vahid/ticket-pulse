import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { BookMarked, FileText, Hourglass, ListChecks, X } from 'lucide-react';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import { knowledgeAPI } from '../services/api';
import { applyWidth, useLayoutWidth } from '../contexts/LayoutContext';
import KnowledgeSettingsStrip from '../components/knowledge/KnowledgeSettingsStrip';
import ArticlesPanel from '../components/knowledge/ArticlesPanel';
import PlaybooksPanel from '../components/knowledge/PlaybooksPanel';
import WaitingPanel from '../components/knowledge/WaitingPanel';
import ActivityPanel from '../components/knowledge/ActivityPanel';
import { ConfirmDialog, KnowledgeGuardContext, Loading } from '../components/knowledge/knowledgeUi';

/**
 * Knowledge (Auto-help P0, plans/AUTO_HELP_PLAN.md): the articles we can
 * stand behind and the playbooks that use them to draft first answers.
 * Shadow mode only — nothing reaches a requester in this phase.
 *
 * Every tab has its own URL (/knowledge/articles, /playbooks, /waiting,
 * /activity) and an open article / playbook / run adds its id, so F5 and
 * shared links land where you were. Tabs follow the WAI-ARIA tabs pattern
 * (arrow keys, Home/End, roving tabindex). Editors with unsaved changes ask
 * before any in-section navigation (in-app dialog) and before the browser tab
 * closes (the browser's own prompt).
 */
const TABS = [
  { k: 'articles', label: 'Articles', Icon: FileText },
  { k: 'playbooks', label: 'Playbooks', Icon: BookMarked },
  { k: 'waiting', label: 'Waiting', Icon: Hourglass },
  { k: 'activity', label: 'Activity', Icon: ListChecks },
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
  const dirtyRef = useRef(false);
  const tabRefs = useRef({});

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
  if (!TABS.some((t) => t.k === tab)) return <Navigate to="/knowledge/articles" replace />;
  const canManage = settings?.canManage === true;
  const activeIndex = TABS.findIndex((t) => t.k === tab);

  const onTabKeyDown = (e) => {
    let next = null;
    if (e.key === 'ArrowRight') next = (activeIndex + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (activeIndex - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    tabRefs.current[TABS[next].k]?.focus();
    leave(`/knowledge/${TABS[next].k}`);
  };

  return (
    <KnowledgeGuardContext.Provider value={guard}>
      <div className="tp-tickets-backdrop min-h-screen md:pl-[var(--tp-rail-w,58px)]">
        <AppHeader activePage="knowledge" />
        <main className={applyWidth('mx-auto max-w-6xl px-4 py-6 pb-24 animate-fadeIn sm:px-6 lg:pb-6', layoutWidth)}>
          {/* Page header: one slim, unboxed row like Tickets. */}
          <div className="mb-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h1 className="text-lg font-bold text-foreground">Knowledge</h1>
            <p className="min-w-0 text-[13px] text-muted-foreground">Answers we can stand behind, and the playbooks that use them to draft first replies.</p>
          </div>

          {settings && <KnowledgeSettingsStrip settings={settings} onChange={setSettings} />}

          <div role="tablist" aria-label="Knowledge sections" onKeyDown={onTabKeyDown} className="settings-scrollbar mb-4 flex items-end gap-5 overflow-x-auto border-b border-border">
            {TABS.map(({ k, label, Icon }) => {
              const selected = tab === k;
              return (
                <Link
                  key={k}
                  ref={(el) => { tabRefs.current[k] = el; }}
                  id={`knowledge-tab-${k}`}
                  role="tab"
                  to={`/knowledge/${k}`}
                  aria-selected={selected}
                  aria-controls={`knowledge-panel-${k}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    if (!selected || itemId) leave(`/knowledge/${k}`);
                  }}
                  className={`tp-focus-ring relative -mb-px inline-flex flex-shrink-0 items-center gap-1.5 rounded-t border-b-2 px-0.5 pb-2 pt-1 text-sm font-semibold transition-colors ${
                    selected ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" /> {label}
                </Link>
              );
            })}
          </div>

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-200" role="alert">
              <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>{error}</span>
            </div>
          )}

          {!settings && !error ? <Loading label="Loading Knowledge…" /> : (
            <section
              role="tabpanel"
              id={`knowledge-panel-${tab}`}
              aria-labelledby={`knowledge-tab-${tab}`}
              tabIndex={-1}
              className="animate-fadeIn focus:outline-none"
            >
              {tab === 'articles' && <ArticlesPanel itemId={itemId} categories={categories} canManage={canManage} />}
              {tab === 'playbooks' && <PlaybooksPanel itemId={itemId} categories={categories} canManage={canManage} tools={settings?.tools || []} defaults={settings?.defaults || null} />}
              {tab === 'waiting' && <WaitingPanel />}
              {tab === 'activity' && <ActivityPanel runId={itemId || null} canReview={settings?.canReview === true} />}
            </section>
          )}
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
