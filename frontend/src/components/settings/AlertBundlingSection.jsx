import { useEffect, useState } from 'react';
import { Layers } from 'lucide-react';
import { alertCorrelationAPI } from '../../services/api';
import FancySelect from '../common/FancySelect';

/**
 * Settings → Alert correlation → Bursts from connected monitors (17 Oct 2026).
 *
 * Connected monitors (Sentinel's infrastructure checks) send one ticket per
 * server and the rules above leave them alone. This switch bundles a burst of
 * one check into one incident with the servers' tickets under it. It only
 * affects alerts that arrive after it is on, so it saves straight away.
 * Plain words only — no codes, no JSON.
 */
const LABEL = 'Bundle bursts into one incident';
const windowLabel = (m) => (m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`);

export default function AlertBundlingSection() {
  const [ctx, setCtx] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => alertCorrelationAPI.getBundling())
      .then((res) => { if (!cancelled) setCtx((res?.data?.data ?? res?.data) || {}); })
      .catch(() => { if (!cancelled) setCtx({}); });
    return () => { cancelled = true; };
  }, []);

  const loading = ctx === null;
  const on = ctx?.enabled === true;
  const counts = Array.isArray(ctx?.minCountChoices) && ctx.minCountChoices.length ? ctx.minCountChoices : [2, 3, 4, 5];
  const windows = Array.isArray(ctx?.windowChoices) && ctx.windowChoices.length ? ctx.windowChoices : [30, 60, 120, 240];

  const save = async (patch) => {
    if (loading || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await alertCorrelationAPI.updateBundling(patch);
      setCtx((prev) => ({ ...(prev || {}), ...((res?.data?.data ?? res?.data) || {}) }));
    } catch (e) {
      setError(e.response?.data?.message || e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="tp-card rounded-xl p-4" aria-label="Bursts from connected monitors">
      <div className="flex items-center gap-2 mb-1">
        <Layers className="w-4 h-4 text-blue-500" aria-hidden="true" />
        <h3 className="text-sm font-bold text-foreground">Bursts from connected monitors</h3>
      </div>
      <p className="text-xs text-muted-foreground/75 mb-3">
        Connected monitors such as Sentinel send one ticket per server, and the rules above leave those tickets alone.
      </p>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground/85">{LABEL}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            When the same check fires on several servers in a short time, Ticket Pulse opens one incident with each server&rsquo;s ticket under it. One person works it: the servers&rsquo; tickets take the incident&rsquo;s owner. The monitor still resolves each server&rsquo;s ticket, and the incident is resolved when they all are. Later alerts of the same check join it.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`${LABEL} ${on ? 'on' : 'off'}`}
          onClick={() => save({ enabled: !on })}
          disabled={loading || busy}
          className={`tp-focus-ring relative inline-flex h-5 w-9 shrink-0 rounded-full disabled:opacity-60 ${on ? 'bg-primary' : 'bg-muted-foreground/40'}`}
        >
          <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-card shadow" style={{ transform: on ? 'translateX(16px)' : 'translateX(0)' }} aria-hidden="true" />
        </button>
      </div>

      {on && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
          <span className="font-semibold text-foreground/85">When</span>
          <div className="w-16">
            <FancySelect
              value={String(ctx?.minCount ?? 3)}
              onChange={(v) => save({ minCount: Number(v) })}
              options={counts.map((n) => ({ value: String(n), label: String(n) }))}
              disabled={busy}
              aria-label="How many alerts"
              className="h-8"
            />
          </div>
          <span className="font-semibold text-foreground/85">alerts of the same check arrive within</span>
          <div className="w-28">
            <FancySelect
              value={String(ctx?.windowMinutes ?? 60)}
              onChange={(v) => save({ windowMinutes: Number(v) })}
              options={windows.map((m) => ({ value: String(m), label: windowLabel(m) }))}
              disabled={busy}
              aria-label="Within"
              className="h-8"
            />
          </div>
          {Number.isFinite(Number(ctx?.openBundles)) && (
            <span className="text-muted-foreground" data-testid="open-bundles">
              {Number(ctx.openBundles) === 0 ? 'No open incidents.' : `${ctx.openBundles} open incident${Number(ctx.openBundles) === 1 ? '' : 's'}.`}
            </span>
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-300 mt-2" role="alert">{error}</p>}
    </section>
  );
}
