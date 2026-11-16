import { useEffect, useMemo, useState } from 'react';
import { Eye, Plus, X } from 'lucide-react';
import { notificationWorkflowAPI } from '../../services/api';
import { useCurrentIdentity } from '../../utils/currentIdentity';

/**
 * Mail Workflows: "Copy me on workflow e-mails" (16 Nov 2026). People who get
 * a Bcc of every e-mail this workspace's workflows send, until a date, for all
 * workflows or chosen ones. Nothing in any workflow changes; the Bcc is added
 * when the e-mail goes out, and stops by itself on the date.
 *
 * Calm and short: one line per observer with a Stop button, and a small form
 * to add someone (yourself by default).
 */
export const DURATIONS = Object.freeze([
  { days: 1, label: '1 day' },
  { days: 3, label: '3 days' },
  { days: 7, label: '1 week' },
  { days: 14, label: '2 weeks' },
  { days: 30, label: '30 days' },
]);

const fmtUntil = (iso) => {
  try {
    return new Date(iso).toLocaleString('en-CA', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Vancouver' });
  } catch {
    return iso;
  }
};

/** End of the last day, Pacific evening: a "2 weeks" observer lasts the whole 14th day. */
export function untilFor(days, now = new Date()) {
  const d = new Date(now.getTime() + days * 86400000);
  d.setHours(23, 59, 0, 0);
  return d.toISOString();
}

export function scopeText(observer, workflows = []) {
  if (!observer?.workflowIds || observer.workflowIds.length === 0) return 'every workflow e-mail';
  const names = observer.workflowIds.map((id) => workflows.find((w) => Number(w.id) === Number(id))?.name || `#${id}`);
  return names.length === 1 ? `e-mails from "${names[0]}"` : `e-mails from ${names.length} workflows`;
}

export default function WorkflowMailObservers({ workflows = [], className = '' }) {
  const me = useCurrentIdentity();
  const [observers, setObservers] = useState(null);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [days, setDays] = useState(14);
  const [scope, setScope] = useState('all');
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const emailWorkflows = useMemo(() => (workflows || [])
    .filter((w) => !w.archivedAt && w.isEnabled)
    .sort((a, b) => String(a.name).localeCompare(String(b.name))), [workflows]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => notificationWorkflowAPI.getObservers())
      .then((res) => { if (!cancelled) setObservers(res?.data?.observers || []); })
      .catch(() => { if (!cancelled) setObservers([]); });
    return () => { cancelled = true; };
  }, []);

  const active = (observers || []).filter((o) => o.active !== false && new Date(o.until).getTime() > Date.now());

  const save = async (next) => {
    setBusy(true);
    setError(null);
    try {
      const res = await notificationWorkflowAPI.setObservers(next);
      setObservers(res?.data?.observers || []);
      return true;
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not save');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const keep = (list) => list.map(({ email: e, name, until, workflowIds }) => ({ email: e, name, until, workflowIds }));

  const openForm = () => {
    setEmail(me?.email || '');
    setDays(14);
    setScope('all');
    setPicked([]);
    setError(null);
    setAdding(true);
  };

  const add = async () => {
    const address = String(email || '').trim();
    if (!address.includes('@')) { setError('Enter an e-mail address'); return; }
    if (scope === 'some' && picked.length === 0) { setError('Pick at least one workflow'); return; }
    const entry = {
      email: address,
      name: me && address.toLowerCase() === String(me.email || '').toLowerCase() ? me.name : null,
      until: untilFor(days),
      workflowIds: scope === 'some' ? picked : null,
    };
    const others = active.filter((o) => o.email !== address.toLowerCase());
    if (await save([...keep(others), entry])) setAdding(false);
  };

  const stop = (address) => save(keep(active.filter((o) => o.email !== address)));

  if (observers === null) return null;

  return (
    <section className={`rounded-lg border border-border bg-card px-3 py-2 ${className}`} aria-label="Copy me on workflow e-mails" data-testid="workflow-mail-observers">
      <div className="flex items-start gap-2">
        <Eye className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          {active.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nobody gets a Bcc of this workspace&rsquo;s workflow e-mails. A Bcc is private: requesters never see who is copied.</p>
          ) : active.map((o) => (
            <div key={o.email} className="flex flex-wrap items-center gap-x-2 text-xs text-foreground" data-testid="observer-row">
              <span>
                <strong className="font-semibold">{o.name || o.email}</strong> gets a Bcc of {scopeText(o, workflows)} until {fmtUntil(o.until)}.
              </span>
              <button type="button" disabled={busy} onClick={() => stop(o.email)} className="tp-focus-ring rounded px-1 text-xs font-medium text-primary hover:underline disabled:opacity-50" aria-label={`Stop Bcc for ${o.name || o.email}`}>
                Stop
              </button>
            </div>
          ))}

          {adding ? (
            <div className="space-y-2 pt-1" data-testid="observer-form">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <label className="flex items-center gap-1 text-muted-foreground">
                  Bcc
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="E-mail address to Bcc" className="tp-focus-ring h-7 w-56 rounded-md border border-input bg-card px-2 text-xs text-foreground" />
                </label>
                <label className="flex items-center gap-1 text-muted-foreground">
                  for
                  <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="How long" className="tp-focus-ring h-7 rounded-md border border-input bg-card px-1 text-xs text-foreground">
                    {DURATIONS.map((d) => <option key={d.days} value={d.days}>{d.label}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-1 text-muted-foreground">
                  on
                  <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Which workflows" className="tp-focus-ring h-7 rounded-md border border-input bg-card px-1 text-xs text-foreground">
                    <option value="all">every workflow</option>
                    <option value="some">chosen workflows</option>
                  </select>
                </label>
              </div>
              {scope === 'some' && (
                <fieldset className="settings-scrollbar max-h-40 space-y-1 overflow-y-auto rounded-md border border-border px-2 py-1" aria-label="Workflows to Bcc">
                  {emailWorkflows.map((w) => (
                    <label key={w.id} className="flex items-center gap-2 text-xs text-foreground">
                      <input
                        type="checkbox"
                        checked={picked.includes(Number(w.id))}
                        onChange={(e) => setPicked((list) => (e.target.checked ? [...list, Number(w.id)] : list.filter((id) => id !== Number(w.id))))}
                      />
                      {w.name}
                    </label>
                  ))}
                </fieldset>
              )}
              <div className="flex items-center gap-2">
                <button type="button" disabled={busy} onClick={add} className="tp-focus-ring h-7 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-50">
                  Start Bcc
                </button>
                <button type="button" onClick={() => setAdding(false)} className="tp-focus-ring h-7 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground" aria-label="Cancel">
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <span className="text-[11px] text-muted-foreground">A private Bcc: requesters never see it. Real e-mails only (not Shadow); it stops by itself on the date.</span>
              </div>
            </div>
          ) : (
            <button type="button" onClick={openForm} className="tp-focus-ring inline-flex items-center gap-1 rounded px-1 text-xs font-medium text-primary hover:underline">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Copy someone on workflow e-mails
            </button>
          )}
          {error && <p className="text-xs text-red-700 dark:text-red-300" role="alert">{error}</p>}
        </div>
      </div>
    </section>
  );
}
