import { useEffect, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2 } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import FancySelect from '../common/FancySelect';

/**
 * Settings → Ticket Ops → When a ticket is resolved (17 Oct 2026).
 *
 * Close Ticket Pulse tickets that stayed Resolved for a chosen time, instead
 * of waiting for FreshService's supervisor rule to close the copy. Turning it
 * on (or picking a shorter time) closes the tickets already past that time, so
 * the block works as a draft with its own Save and says how many will close.
 * Plain words only — no codes, no JSON.
 */
const LABEL = 'Close resolved tickets automatically';
const FALLBACK_CHOICES = [1, 4, 24, 48, 72, 168].map((hours) => ({ hours, label: hours < 24 ? `${hours} hour${hours === 1 ? '' : 's'}` : hours === 168 ? '1 week' : `${hours / 24} day${hours === 24 ? '' : 's'}` }));

function Switch({ checked, disabled, label, onClick }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked === true}
      aria-label={`${label} ${checked ? 'on' : 'off'}`}
      onClick={onClick}
      disabled={disabled}
      className={`tp-focus-ring relative inline-flex h-5 w-9 shrink-0 rounded-full disabled:opacity-60 ${checked ? 'bg-primary' : 'bg-muted-foreground/40'}`}
    >
      <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-card shadow" style={{ transform: checked ? 'translateX(16px)' : 'translateX(0)' }} aria-hidden="true" />
    </button>
  );
}

const ticketsWord = (n) => `${n} ticket${n === 1 ? '' : 's'}`;

export default function ResolvedTicketsSection() {
  const [ctx, setCtx] = useState(null); // null = loading
  const [draft, setDraft] = useState(null); // { on, afterHours } while being changed
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => ticketsAPI.getAutoCloseSettings())
      .then((res) => { if (!cancelled) setCtx((res?.data?.data ?? res?.data) || {}); })
      .catch(() => { if (!cancelled) setCtx({}); });
    return () => { cancelled = true; };
  }, []);

  const loading = ctx === null;
  const choices = Array.isArray(ctx?.choices) && ctx.choices.length ? ctx.choices : FALLBACK_CHOICES;
  const savedOn = ctx?.enabled === true;
  const savedHours = Number(ctx?.afterHours) || 48;
  const on = draft ? draft.on : savedOn;
  const hours = draft ? draft.afterHours : savedHours;
  const labelFor = (h) => choices.find((c) => Number(c.hours) === Number(h))?.label || `${h} hours`;
  const due = ctx?.dueByChoice?.[hours];
  const dirty = draft && (draft.on !== savedOn || (draft.on && draft.afterHours !== savedHours));

  const edit = (over) => {
    if (loading || busy) return;
    setDraft({ on: savedOn, afterHours: savedHours, ...(draft || {}), ...over });
    setSaved(null);
    setError(null);
  };

  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await ticketsAPI.updateAutoCloseSettings(draft.on ? { enabled: true, afterHours: draft.afterHours } : { enabled: false });
      setCtx((res?.data?.data ?? res?.data) || {});
      setSaved(draft.on
        ? `Saved. Resolved tickets close after ${labelFor(draft.afterHours)}${Number(due) > 0 ? `; the ${ticketsWord(Number(due))} already past that close within the next few minutes` : ''}.`
        : 'Saved. Ticket Pulse no longer closes resolved tickets on its own.');
      setDraft(null);
    } catch (e) {
      setError(e.response?.data?.message || e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="tp-card rounded-xl p-4" aria-label="When a ticket is resolved">
      <div className="flex items-center gap-2 mb-1">
        <CheckCircle2 className="w-4 h-4 text-emerald-500" aria-hidden="true" />
        <h3 className="text-sm font-bold text-foreground">When a ticket is resolved</h3>
      </div>
      <p className="text-xs text-muted-foreground/75 mb-3">What Ticket Pulse does on its own once a ticket is resolved.</p>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground/85">{LABEL}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            A Ticket Pulse ticket that stays Resolved for the time below is closed, and its FreshService copy with it. A requester reply before then reopens it as usual. FreshService tickets keep following FreshService.
          </p>
        </div>
        <Switch checked={on} disabled={loading || busy} label={LABEL} onClick={() => edit({ on: !on })} />
      </div>

      {on && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-xs font-semibold text-foreground/85">Close after</span>
          <div className="w-28">
            <FancySelect
              value={String(hours)}
              onChange={(v) => edit({ afterHours: Number(v) })}
              options={choices.map((c) => ({ value: String(c.hours), label: c.label }))}
              disabled={loading || busy}
              aria-label="Close after"
              className="h-8"
            />
          </div>
          <span className="text-xs text-muted-foreground" data-testid="auto-close-now">
            {Number.isFinite(Number(ctx?.resolvedNow)) ? `${ticketsWord(Number(ctx.resolvedNow))} resolved now.` : ''}
          </span>
        </div>
      )}

      {dirty && on && Number(due) > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-200" data-testid="auto-close-due">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
          <span>{ticketsWord(Number(due))} {Number(due) === 1 ? 'has' : 'have'} been resolved for longer than {labelFor(hours)} and will close within a few minutes of saving.</span>
        </p>
      )}

      {dirty && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={!dirty || busy}
            className="tp-focus-ring rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => setDraft(null)}
            disabled={busy}
            className="tp-focus-ring rounded-lg px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
      {saved && (
        <p className="mt-2 flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-300" role="status">
          <Check className="h-3.5 w-3.5" aria-hidden="true" /> {saved}
        </p>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-300 mt-2" role="alert">{error}</p>}
    </section>
  );
}
