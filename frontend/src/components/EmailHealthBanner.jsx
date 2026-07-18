import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MailWarning, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { settingsAPI } from '../services/api';

const POLL_MS = 3 * 60 * 1000;

/**
 * EmailHealthBanner — app-wide warning shown to global admins when outbound
 * email delivery is actively failing, so a silent provider outage (like
 * SendGrid dropping the app's IP) doesn't go unnoticed. Passive; polls the
 * admin-only email-health endpoint and links to the Settings health card.
 */
export default function EmailHealthBanner() {
  const { user } = useAuth();
  const isGlobalAdmin = user?.role === 'admin';
  const [health, setHealth] = useState(null);
  const [dismissedAt, setDismissedAt] = useState(null);
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const resp = await settingsAPI.getEmailHealth();
      setHealth(resp?.data || null);
    } catch {
      // Silent: a non-admin or transient error should never surface here.
    }
  }, []);

  useEffect(() => {
    if (!isGlobalAdmin) return undefined;
    load();
    timerRef.current = setInterval(load, POLL_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isGlobalAdmin, load]);

  if (!isGlobalAdmin) return null;
  if (health?.status !== 'down') return null;
  // Key the dismissal on the failure timestamp, falling back to a constant when
  // it's absent — otherwise a `down` status with no lastFailureAt is undismissable.
  const failureKey = health.lastFailureAt || 'down';
  // Re-show if a newer failure arrives after a dismissal.
  if (dismissedAt === failureKey) return null;

  return (
    <div
      className="fixed bottom-3 left-3 z-[9998] max-w-sm animate-fadeIn"
      role="alert"
      aria-live="assertive"
    >
      <div className="flex items-start gap-3 rounded-xl border border-red-300 bg-red-600 p-3.5 text-white shadow-lg">
        <MailWarning className="mt-0.5 h-5 w-5 flex-shrink-0" />
        <div className="min-w-0 text-sm">
          <div className="font-semibold">Email delivery is failing</div>
          <p className="mt-0.5 text-red-50">
            {health.failureCount24h
              ? `${health.failureCount24h} send${health.failureCount24h === 1 ? '' : 's'} failed in the last 24h. `
              : ''}
            Notifications may not be reaching people.
          </p>
          <Link
            to="/settings#notification-providers"
            className="mt-1.5 inline-block font-semibold text-white underline underline-offset-2 hover:text-red-100"
          >
            View email health →
          </Link>
        </div>
        <button
          type="button"
          onClick={() => setDismissedAt(failureKey)}
          className="tp-focus-ring flex-shrink-0 rounded p-0.5 text-red-100 hover:bg-red-500 hover:text-white"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
