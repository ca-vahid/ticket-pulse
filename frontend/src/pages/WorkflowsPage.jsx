import { useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Bot, FlaskConical, Mail, Send } from 'lucide-react';
import AppShell from '../components/AppShell';
import NotificationWorkflowsPanel from '../components/settings/NotificationWorkflowsPanel';
import { useAuth } from '../contexts/AuthContext';
import { useWorkspace } from '../contexts/WorkspaceContext';

// Tab ids MUST match NotificationWorkflowsPanel's internal `globalTabs` ids.
const WORKFLOW_TABS = [
  { id: 'workflows', label: 'Notification Workflows', Icon: Send, accentText: 'text-blue-600', accentBorder: 'border-blue-500' },
  { id: 'llm-context', label: 'LLM Context', Icon: Bot, accentText: 'text-violet-600', accentBorder: 'border-violet-500' },
  { id: 'signature', label: 'Email Branding', Icon: Mail, accentText: 'text-emerald-600', accentBorder: 'border-emerald-500' },
  { id: 'mock-audit', label: 'Workflow Audit', Icon: FlaskConical, accentText: 'text-sky-600', accentBorder: 'border-sky-500' },
];
const TAB_IDS = WORKFLOW_TABS.map((t) => t.id);

function RibbonStat({ label, value, tone = 'default' }) {
  const valueClass = tone === 'ok' ? 'text-emerald-50' : tone === 'warn' ? 'text-amber-100' : 'text-white';
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-white/10 px-2 py-1 ring-1 ring-white/15">
      <span className="text-[10px] font-medium uppercase tracking-wide text-white/60">{label}</span>
      <span className={`text-xs font-bold ${valueClass}`}>{value}</span>
    </div>
  );
}

/**
 * Top-level Mail Workflows page.
 *
 * Promotes the Settings -> Mail Workflows panel to a first-class destination.
 * The gradient ribbon acts as the page header (tabs + workspace status), and
 * the panel fills the remaining viewport height (no page-level scroll).
 */
export default function WorkflowsPage() {
  const navigate = useNavigate();
  const { tab } = useParams();
  const { user } = useAuth();
  const { currentWorkspace, availableWorkspaces } = useWorkspace();
  const [health, setHealth] = useState(null);

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
      contentClassName="flex w-full flex-col px-2 py-3 sm:px-4"
    >
      {/* Gradient ribbon = page header: tabs on the left, workspace status on the right */}
      <div className="flex-shrink-0 pb-3">
        <div className="flex items-center gap-3 overflow-x-auto rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 p-1.5 shadow-md [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex flex-1 items-center gap-2">
            {WORKFLOW_TABS.map((t) => {
              const Icon = t.Icon;
              const isActive = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => handleTabChange(t.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`group flex flex-1 touch-manipulation items-center justify-center gap-2 whitespace-nowrap rounded-lg border-b-[3px] px-4 py-2.5 text-sm font-semibold transition-all ${
                    isActive
                      ? `bg-white text-slate-900 shadow-sm ${t.accentBorder}`
                      : 'border-transparent bg-white/10 text-white/80 hover:bg-white/20 hover:text-white'
                  }`}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${isActive ? t.accentText : 'text-white/70 group-hover:text-white'}`} />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>

          {health && (
            <div className="hidden shrink-0 items-center gap-1.5 pr-0.5 lg:flex">
              <RibbonStat
                label="SendGrid"
                value={health.sendgridConfigured ? (health.sendgridMode === 'smtp' ? 'SMTP' : 'OK') : 'Missing'}
                tone={health.sendgridConfigured ? 'ok' : 'warn'}
              />
              <RibbonStat label="Enabled" value={health.enabledWorkflows || 0} />
              <RibbonStat label="Audit 7d" value={health.workflowAuditRuns7d ?? health.mockRuns7d ?? 0} />
              <RibbonStat
                label="Fail 24h"
                value={health.failedEmailDeliveries24h || 0}
                tone={health.failedEmailDeliveries24h ? 'warn' : 'default'}
              />
            </div>
          )}
        </div>
      </div>

      <NotificationWorkflowsPanel
        controlledTab={activeTab}
        onTabChange={handleTabChange}
        hideTabBar
        onHealthChange={setHealth}
        rootClassName="tp-glass-strong flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/70"
      />
    </AppShell>
  );
}
