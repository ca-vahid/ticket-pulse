import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { availabilityAPI } from '../../../services/api';
import { BTN_QUIET, ErrorNote, Loading, SectionTitle, StatusDot, addDaysKey, fmtDay } from '../availabilityUi';

/**
 * Vacation Pulse → Settings → Vacation Tracker (26 Nov 2026): the one switch
 * that retires Vacation Tracker so its subscription can end.
 *
 * Before: whether it still syncs and how many upcoming bookings came from
 * there, and "Retire Vacation Tracker" (super admins) behind an inline
 * confirm that says plainly what happens. After: when and by whom, what the
 * handover moved, and the leave-days it kept for a look.
 */

export const RETIRE_CONFIRM = 'Ticket Pulse stops reading from and writing to Vacation Tracker. Upcoming bookings made there move to Vacation Pulse and can be changed here. Past leave stays as it is.';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function fmtWhen(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Vancouver' });
}

function fmtTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Vancouver' });
}

/** "Thu, Dec 10" or "Mon, Dec 7 – Wed, Dec 9"; separate runs joined with " · ". */
export function fmtDates(dates = []) {
  const sorted = [...new Set(dates)].sort();
  const runs = [];
  for (const k of sorted) {
    const last = runs[runs.length - 1];
    if (last && addDaysKey(last[1], 1) === k) last[1] = k;
    else runs.push([k, k]);
  }
  return runs.map(([a, b]) => (a === b ? fmtDay(a) : `${fmtDay(a)} – ${fmtDay(b)}`)).join(' · ');
}

function Report({ report }) {
  if (!report) return null;
  const kept = Array.isArray(report.keptUnmatched) ? report.keptUnmatched : [];
  const failed = Array.isArray(report.failed) ? report.failed : [];
  return (
    <div className="space-y-3" data-testid="vt-retire-report">
      <p className="text-sm text-foreground/85">
        {plural(report.handedOver ?? 0, 'booking', 'bookings')} moved to Vacation Pulse · {plural(report.directRowsReplaced ?? 0, 'leave-day', 'leave-days')} replaced by them
      </p>
      {failed.length > 0 && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {plural(failed.length, 'booking', 'bookings')} could not be moved. Run the handover again; it only moves what is left.
        </p>
      )}
      {kept.length > 0 ? (
        <div className="border-t border-border pt-3">
          <h3 className="text-xs font-medium text-foreground">Kept for a look ({kept.length})</h3>
          <p className="mb-1.5 text-xs text-muted-foreground">
            Upcoming leave-days Vacation Tracker wrote that no Vacation Pulse booking covers (for example, a person who is not set up here). They stay on the dashboard as they are. Book them in Vacation Pulse if they are real.
          </p>
          <ul className="divide-y divide-border/70" aria-label="Leave-days kept for a look">
            {kept.map((k) => (
              <li key={`${k.workspaceId}-${k.technicianId}-${k.dates?.[0]}-${k.leaveType}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5 text-sm">
                <span className="min-w-0 text-foreground">
                  {k.technicianName || `Technician #${k.technicianId}`}
                  <span className="text-muted-foreground"> · {k.leaveType || 'Leave'}</span>
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">{fmtDates(k.dates)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Every upcoming leave-day from Vacation Tracker is now covered by a Vacation Pulse booking.</p>
      )}
    </div>
  );
}

export default function VacationTrackerSection({ toast = () => {}, reload = null }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.resolve()
      .then(() => availabilityAPI.vtRetirementStatus())
      .then((res) => { setStatus(res?.data || null); setError(null); })
      .catch((err) => setError(err?.message || 'Could not load the Vacation Tracker status'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const retire = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await availabilityAPI.retireVacationTracker();
      const r = res?.data || {};
      toast(`Vacation Tracker retired · ${plural(r.handedOver ?? 0, 'booking', 'bookings')} moved to Vacation Pulse`);
      setConfirming(false);
      load();
      reload?.();
    } catch (err) {
      setError(err?.message || 'Could not retire Vacation Tracker');
    } finally {
      setBusy(false);
    }
  };

  if (!status && !error) return <Loading label="Loading Vacation Tracker…" />;

  const retired = status?.retired || null;
  const upcoming = status?.upcomingFromVt ?? 0;
  const lastSync = fmtTime(status?.lastSyncAt);

  return (
    <section aria-label="Vacation Tracker" className="max-w-2xl space-y-4">
      <SectionTitle hint="Ticket Pulse's link to the Vacation Tracker subscription.">Vacation Tracker</SectionTitle>

      {status && !retired && (
        <>
          <div className="space-y-1" data-testid="vt-status">
            <p className="text-sm text-foreground">
              <StatusDot tone={status.syncing ? 'green' : 'grey'} label={status.syncing ? 'Syncing every hour' : 'Not syncing'} />
              <span className="text-xs text-muted-foreground"> · {plural(upcoming, 'upcoming booking', 'upcoming bookings')} came from Vacation Tracker</span>
            </p>
            {lastSync && <p className="text-xs text-muted-foreground">Last sync {lastSync}</p>}
          </div>

          <div className="border-t border-border pt-4">
            <h3 className="text-sm font-medium text-foreground">Retire Vacation Tracker</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">When nobody books in Vacation Tracker any more, retire it here first; then its subscription can end. This cannot be undone from this page.</p>
            {!confirming && (
              <div className="mt-2.5 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className={`${BTN_QUIET} border border-input text-foreground`}
                  onClick={() => setConfirming(true)}
                  disabled={!status.canRetire}
                >
                  Retire Vacation Tracker
                </button>
                {!status.canRetire && <span className="text-xs text-muted-foreground">Only a super admin can retire Vacation Tracker.</span>}
              </div>
            )}
            {confirming && (
              <div role="group" aria-label="Confirm retiring Vacation Tracker" className="mt-2.5 space-y-2.5 rounded-lg border border-border bg-muted/50 p-3 animate-fadeIn">
                <p className="text-sm text-foreground/85">{RETIRE_CONFIRM}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={retire}
                    disabled={busy}
                    className="tp-focus-ring inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}Yes, retire Vacation Tracker
                  </button>
                  <button type="button" className={BTN_QUIET} onClick={() => setConfirming(false)} disabled={busy}>Not now</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {retired && (
        <div className="space-y-3" data-testid="vt-retired">
          <p className="text-sm text-foreground">
            <StatusDot tone="grey" label={`Retired on ${fmtWhen(retired.retiredAt)}${retired.retiredByName || retired.retiredBy ? ` by ${retired.retiredByName || retired.retiredBy}` : ''}`} />
          </p>
          <p className="text-xs text-muted-foreground">Ticket Pulse no longer reads from or writes to Vacation Tracker. Bookings made there are Vacation Pulse bookings now; past leave is unchanged.</p>
          <Report report={retired.report} />
          {status?.canRetire && Array.isArray(retired.report?.failed) && retired.report.failed.length > 0 && (
            <button type="button" className={`${BTN_QUIET} border border-input`} onClick={retire} disabled={busy}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}Run the handover again
            </button>
          )}
        </div>
      )}

      <ErrorNote>{error}</ErrorNote>
    </section>
  );
}
