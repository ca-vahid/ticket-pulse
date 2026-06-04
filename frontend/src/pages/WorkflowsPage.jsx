import { useMemo } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Bot, FlaskConical, Mail, Send } from 'lucide-react';
import AppShell from '../components/AppShell';
import NotificationWorkflowsPanel from '../components/settings/NotificationWorkflowsPanel';
import { useAuth } from '../contexts/AuthContext';
import { useWorkspace } from '../contexts/WorkspaceContext';

// Tab ids MUST match NotificationWorkflowsPanel's internal `globalTabs` ids.
const WORKFLOW_TABS = [
  { id: 'workflows', label: 'Notification Workflows', Icon: Send },
  { id: 'llm-context', label: 'LLM Context', Icon: Bot },
  { id: 'signature', label: 'Email Branding', Icon: Mail },
  { id: 'mock-audit', label: 'Workflow Audit', Icon: FlaskConical },
];
const TAB_IDS = WORKFLOW_TABS.map((t) => t.id);

/**
 * Top-level Mail Workflows page.
 *
 * Promotes the Settings → Mail Workflows panel to a first-class destination with
 * an Assignments-style gradient ribbon, so the workflow editor gets the full
 * page width instead of the narrow Settings content column.
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
      contentClassName="mx-auto flex w-full max-w-[100rem] flex-col px-2 py-3 sm:px-4"
    >
      {/* Gradient ribbon — unified with the Assignments page tab bar */}
      <div className="flex-shrink-0 pb-3">
        <div className="flex items-center gap-0.5 overflow-x-auto rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 px-1.5 py-1 shadow-md [-ms-overflow-style:none] [scrollbar-width:none] sm:gap-1 sm:px-2 [&::-webkit-scrollbar]:hidden">
          {WORKFLOW_TABS.map((t) => {
            const Icon = t.Icon;
            const isActive = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => handleTabChange(t.id)}
                className={`flex touch-manipulation items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-2.5 text-sm font-medium transition-colors sm:px-4 sm:py-2 ${
                  isActive
                    ? 'bg-white bg-opacity-25 text-white shadow-sm'
                    : 'text-white opacity-70 hover:bg-white hover:bg-opacity-15 hover:opacity-100'
                }`}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon className="h-5 w-5 sm:h-4 sm:w-4" />
                <span className="hidden sm:inline">{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <NotificationWorkflowsPanel
        controlledTab={activeTab}
        onTabChange={handleTabChange}
        hideTabBar
        rootClassName="tp-glass-strong flex h-[calc(100dvh-11rem)] min-h-0 max-h-[calc(100dvh-11rem)] flex-col overflow-hidden rounded-2xl border border-white/70"
      />
    </AppShell>
  );
}
