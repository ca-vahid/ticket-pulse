import { Bell, LayoutDashboard, LogOut } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import NotificationSettingsPanel from '../components/agent/NotificationSettingsPanel';
import AgentAlertsPanel from '../components/agent/AgentAlertsPanel';

/**
 * Dedicated Notifications page (its own destination from the account menu) —
 * NOT a tab inside My Competencies, so it carries no "My Competencies" header
 * or nav bar (QA 07-21 #3, #4). Two clear sections: how you're notified
 * (delivery preferences) and what you're notified about (your alert rules).
 */
export default function Notifications() {
  const { user, logout } = useAuth();
  const canAccessDashboard = user?.role && user.role !== 'agent';
  const homeHref = canAccessDashboard ? '/dashboard' : '/my-competencies';

  return (
    <div className="min-h-screen bg-slate-100 bg-[url('/brand/dashboard-background.webp')] bg-cover bg-fixed">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 shadow-sm backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/brand/logo-wordmark.png" alt="Ticket Pulse" className="h-14 w-auto" />
            <div className="hidden h-8 w-px bg-slate-200 sm:block" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-900">Notifications</div>
              <div className="truncate text-xs text-slate-500">Email &amp; alert preferences.</div>
            </div>
          </div>
          <div className="flex flex-none items-center gap-2">
            <a
              href={homeHref}
              aria-label={canAccessDashboard ? 'Back to Dashboard' : 'Back to My Skills'}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 text-sm font-semibold text-blue-700 shadow-sm shadow-blue-100/50 transition hover:border-blue-300 hover:bg-blue-100 hover:text-blue-800"
            >
              <LayoutDashboard className="h-4 w-4" />
              <span className="hidden sm:inline">{canAccessDashboard ? 'Back to Dashboard' : 'Back to My Skills'}</span>
              <span className="sm:hidden">Back</span>
            </a>
            <button
              type="button"
              onClick={() => logout()}
              className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-5">
        <div className="mb-4 flex items-start gap-3">
          <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-sm shadow-blue-200">
            <Bell className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Notifications</h1>
            <p className="text-sm text-slate-500">
              Choose how Ticket Pulse reaches you, then set up alerts for the tickets you want to hear about.
            </p>
          </div>
        </div>

        <div className="space-y-5">
          <NotificationSettingsPanel />
          <AgentAlertsPanel />
        </div>
      </main>
    </div>
  );
}
