import { useMemo } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Bot, FlaskConical, Mail, Send } from 'lucide-react';
import AppShell from '../components/AppShell';
import NotificationWorkflowsPanel from '../components/settings/NotificationWorkflowsPanel';
import { useAuth } from '../contexts/AuthContext';
import { useWorkspace } from '../contexts/WorkspaceContext';

// Tab ids MUST match NotificationWorkflowsPanel's internal `globalTabs` ids.
export const WORKFLOW_TABS = [
  { id: 'workflows', label: 'Workflows', Icon: Send },
  { id: 'llm-context', label: 'LLM context', Icon: Bot },
  { id: 'signature', label: 'Email branding', Icon: Mail },
  { id: 'mock-audit', label: 'Audit', Icon: FlaskConical },
];
const TAB_IDS = WORKFLOW_TABS.map((t) => t.id);

/**
 * Quiet section tabs that sit in the app header next to the page title
 * (Mail Workflows redesign "H1", 22 Sep 2026): text with an underline, no
 * band of their own. Below lg the header hides its title, so the same tabs
 * render as a slim row above the panel instead.
 */
export function WorkflowSectionTabs({ activeTab, onChange, className = '' }) {
  return (
    <div role="tablist" aria-label="Mail workflows sections" className={`flex items-center gap-0.5 ${className}`}>
      {WORKFLOW_TABS.map((t) => {
        const isActive = activeTab === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            className={`tp-focus-ring relative inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[13px] font-semibold transition-colors ${
              isActive ? 'text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground/85'
            }`}
          >
            <t.Icon className={`h-3.5 w-3.5 ${isActive ? 'text-primary' : 'text-muted-foreground/75'}`} aria-hidden="true" />
            {t.label}
            {isActive && <span className="absolute inset-x-2 -bottom-[7px] h-0.5 rounded-full bg-primary" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Top-level Mail Workflows page.
 *
 * The section tabs live in the app header beside the title (no gradient
 * ribbon), health moved into the workflow sidebar's footer, and the panel
 * fills the remaining viewport height (no page-level scroll) — so the editor
 * starts two rows down instead of five.
 */
export default function WorkflowsPage() {
  const navigate = useNavigate();
  const { tab } = useParams();
  const { user } = useAuth();
  const { currentWorkspace, availableWorkspaces } = useWorkspace();

  const wsRole = useMemo(() => {
    if (user?.role === 'admin') return 'admin';
    const ws = availableWorkspaces?.find((w) => w.id === currentWorkspace?.id);
    return ws?.role || 'viewer';
  }, [user?.role, availableWorkspaces, currentWorkspace?.id]);
  const canManageWorkspace = wsRole === 'admin';

  const activeTab = TAB_IDS.includes(tab) ? tab : 'workflows';

  if (!canManageWorkspace) {
    return <Navigate to="/dashboard" replace />;
  }

  const handleTabChange = (id) => {
    navigate(id === 'workflows' ? '/workflows' : `/workflows/${id}`);
  };

  return (
    <AppShell
      activePage="workflows"
      fillViewport
      contentClassName="flex w-full flex-col px-2 py-2 sm:px-3"
      headerProps={{ titleAddon: <WorkflowSectionTabs activeTab={activeTab} onChange={handleTabChange} className="ml-3 border-l border-border pl-3" /> }}
    >
      {/* Below lg the header has no title row, so the tabs get a slim row here. */}
      <div className="flex-shrink-0 pb-2 lg:hidden">
        <WorkflowSectionTabs activeTab={activeTab} onChange={handleTabChange} className="overflow-x-auto" />
      </div>

      <NotificationWorkflowsPanel
        controlledTab={activeTab}
        onTabChange={handleTabChange}
        hideTabBar
        rootClassName="tp-glass-strong flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-card/70 dark:border-white/10"
      />
    </AppShell>
  );
}
