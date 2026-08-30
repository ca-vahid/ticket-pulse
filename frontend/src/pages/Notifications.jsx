import { Bell, LayoutDashboard, LogOut } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import NotificationSettingsPanel from '../components/agent/NotificationSettingsPanel';
import AgentAlertsPanel from '../components/agent/AgentAlertsPanel';
import SignaturePanel from '../components/agent/SignaturePanel';

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
    <div className="tp-app-backdrop min-h-screen bg-cover bg-fixed">
      <header className="sticky top-0 z-30 border-b border-border bg-card/95 shadow-sm backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2">
          <div className="flex min-w-0 items-center gap-3">
            {/* The wordmark's navy lettering vanishes on the dark header — swap
                to the colourful square mark in dark mode. */}
            <img src="/brand/logo-wordmark.png" alt="Ticket Pulse" className="h-14 w-auto dark:hidden" />
            <img src="/brand/logo-mark.png" alt="Ticket Pulse" className="hidden h-9 w-9 object-contain dark:block" />
            <div className="hidden h-8 w-px bg-secondary sm:block" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">Notifications</div>
              <div className="truncate text-xs text-muted-foreground">Email, alerts &amp; signature.</div>
            </div>
          </div>
          <div className="flex flex-none items-center gap-2">
            <a
              href={homeHref}
              aria-label={canAccessDashboard ? 'Back to Dashboard' : 'Back to My Skills'}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 px-3 text-sm font-semibold text-blue-700 dark:text-blue-200 shadow-sm shadow-blue-100/50 dark:shadow-none transition hover:border-blue-300 dark:hover:border-blue-500/40 hover:bg-blue-100 dark:hover:bg-blue-500/20 hover:text-blue-800 dark:hover:text-blue-200"
            >
              <LayoutDashboard className="h-4 w-4" />
              <span className="hidden sm:inline">{canAccessDashboard ? 'Back to Dashboard' : 'Back to My Skills'}</span>
              <span className="sm:hidden">Back</span>
            </a>
            <button
              type="button"
              onClick={() => logout()}
              className="flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-semibold text-foreground/85 transition hover:border-red-200 dark:hover:border-red-500/30 hover:bg-red-50 dark:hover:bg-red-500/15 hover:text-red-700 dark:hover:text-red-200"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-5">
        <div className="mb-4 flex items-start gap-3">
          <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-sm shadow-blue-200 dark:shadow-none">
            <Bell className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-bold text-foreground">Notifications</h1>
            <p className="text-sm text-muted-foreground">
              Choose how Ticket Pulse reaches you, set up alerts for the tickets you want to hear about, and manage your email signature.
            </p>
          </div>
        </div>

        <div className="space-y-5">
          <NotificationSettingsPanel />
          <AgentAlertsPanel />
          {/* My email signature (Phase D) — same self-serve home for agents
              and coordinators, both reach this page from the account menu. */}
          <SignaturePanel />
        </div>
      </main>
    </div>
  );
}
