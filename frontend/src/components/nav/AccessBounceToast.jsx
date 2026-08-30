import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ShieldAlert, X } from 'lucide-react';
import { ACCESS_BOUNCE_KEY } from './navDestinations';

const AUTO_DISMISS_MS = 8000;

/**
 * One-time "Your access has changed" notice (Phase RM3 nice-to-have): when
 * AdminRoute bounces a viewer/reviewer off a page their role can no longer
 * open (a stale bookmark to /dashboard, a link in an old email), the Tickets
 * page says so instead of silently landing them somewhere else. Mounted
 * app-wide next to the health banners; renders nothing unless a bounce
 * marker is waiting in sessionStorage.
 */
export default function AccessBounceToast() {
  const location = useLocation();
  const [from, setFrom] = useState(null);

  useEffect(() => {
    let marker = null;
    try {
      marker = sessionStorage.getItem(ACCESS_BOUNCE_KEY);
      if (marker) sessionStorage.removeItem(ACCESS_BOUNCE_KEY);
    } catch { /* no-op */ }
    if (marker) setFrom(marker);
  }, [location.pathname]);

  useEffect(() => {
    if (!from) return undefined;
    const t = setTimeout(() => setFrom(null), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [from]);

  if (!from) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-20 left-1/2 z-[9997] w-[min(92vw,420px)] -translate-x-1/2 rounded-xl border border-amber-200 bg-amber-50 p-3 pr-9 text-sm text-amber-900 shadow-soft animate-fadeIn md:bottom-6 dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-100"
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-semibold">Your access has changed</p>
          <p className="mt-0.5 text-[13px] text-amber-800">
            <span className="font-mono text-[12px]">{from}</span> is now admin-only. Your role covers Tickets and Approvals — you have been brought to Tickets.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setFrom(null)}
        aria-label="Dismiss"
        className="tp-focus-ring absolute right-2 top-2 rounded-full p-1 text-amber-500 hover:bg-amber-100 hover:text-amber-800"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
