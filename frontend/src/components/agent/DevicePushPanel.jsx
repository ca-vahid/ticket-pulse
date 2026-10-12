import { useCallback, useEffect, useState } from 'react';
import { Activity, BellRing, Send } from 'lucide-react';
import { disablePush, enablePush, getPushState, sendPushTest } from '../../utils/push';

/**
 * Notifications on this device (12 Oct 2026). One switch per browser or
 * installed app; what is sent follows the person's choices in the Teams
 * section below (Off and Digest are not sent to a device).
 *
 * `compact` is the one-line version for the phone More sheet.
 */
const HELP = {
  unsupported: 'This browser cannot show notifications from Ticket Pulse.',
  'needs-install': 'On an iPhone, install Ticket Pulse first (More → Install as an app), then open it from the home screen and turn this on.',
  unconfigured: 'Not available yet on this server.',
  blocked: 'Notifications are blocked for this site. Allow them in the browser’s site settings, then turn this on.',
};

export default function DevicePushPanel({ compact = false }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const load = useCallback(() => getPushState().then(setInfo).catch(() => setInfo({ state: 'unsupported', devices: [] })), []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn, done) => {
    setBusy(true);
    setNote(null);
    try {
      const next = await fn();
      if (next?.state) setInfo(next);
      if (done) setNote(done);
    } catch (err) {
      setNote(err.response?.data?.message || err.message || 'That did not work.');
      load();
    } finally {
      setBusy(false);
    }
  };

  if (!info) return compact ? null : <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…</div>;
  const on = info.state === 'on';
  const canToggle = info.state === 'on' || info.state === 'off';
  // Nothing to offer and nothing to explain in the small sheet row.
  if (compact && (info.state === 'unsupported' || info.state === 'unconfigured')) return null;

  const toggle = (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Notifications on this device"
      disabled={busy || !canToggle}
      onClick={() => run(on ? disablePush : enablePush, on ? 'Off for this device.' : 'On. You can send a test.')}
      data-testid="device-push-toggle"
      className={`tp-focus-ring relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-primary' : 'bg-muted-foreground/40'}`}
    >
      <span className={`inline-block h-5 w-5 rounded-full bg-card shadow transition-transform ${on ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
    </button>
  );

  if (compact) {
    return (
      <div className="px-4 py-3" data-testid="device-push-row">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-blue-100 bg-blue-50 text-blue-600 dark:border-blue-400/30 dark:bg-blue-500/15 dark:text-blue-300">
            <BellRing className="h-[20px] w-[20px]" aria-hidden="true" />
          </span>
          <span className="flex-1 text-sm font-semibold text-foreground">Notifications on this phone</span>
          {toggle}
        </div>
        {(HELP[info.state] || note) && <p className="mt-1.5 pl-12 text-xs leading-snug text-muted-foreground">{HELP[info.state] || note}</p>}
      </div>
    );
  }

  return (
    <section className="tp-card rounded-xl border border-border p-4 sm:p-5" aria-labelledby="device-push-heading" data-testid="device-push-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300">
            <BellRing className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 id="device-push-heading" className="text-base font-bold text-foreground">This device</h3>
            <p className="text-xs text-muted-foreground">
              Ticket Pulse notifies this phone or browser about your tickets and approvals, even when it is closed. It follows your choices under Microsoft Teams below: anything set to Off or Digest is not sent here.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {on && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(async () => { await sendPushTest(); return null; }, 'Test sent. It should appear in a few seconds.')}
              className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-input bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" aria-hidden="true" /> Send a test
            </button>
          )}
          {toggle}
        </div>
      </div>
      {(HELP[info.state] || note) && <p className="mt-3 text-xs text-muted-foreground" role="status">{HELP[info.state] || note}</p>}
      {info.devices?.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          On for: {info.devices.map((d) => d.label).join(', ')}.
        </p>
      )}
    </section>
  );
}
