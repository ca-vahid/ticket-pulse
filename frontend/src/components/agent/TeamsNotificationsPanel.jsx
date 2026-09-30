import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, BellOff, Send } from 'lucide-react';
import { agentAPI } from '../../services/api';
import TeamsEventGrid from './TeamsEventGrid';

/**
 * My Teams notifications (plans/TEAMS_NOTIFICATIONS_PLAN.md): connection,
 * what I am told about, when to stay quiet, muted tickets, recent deliveries.
 * Changes save on their own (debounced) — no Save button to forget.
 */
const REASON = {
  on_leave: 'you were on leave',
  off_shift: 'outside your work hours',
  quiet_hours: 'quiet hours',
  muted: 'ticket muted',
};
const EVENT_WORD = {
  assigned: 'Assigned to you', requester_replied: 'Requester replied', teammate_update: 'New note or reply',
  status_changed: 'Status changed', reopened: 'Reopened', park_woke: 'Parked ticket woke up',
  unassigned_from_me: 'Reassigned away', sla_pre_breach: 'SLA about to breach', sla_breach: 'SLA breached',
  approval_waiting: 'Approval waiting', group_unassigned: 'New unassigned ticket', test: 'Test message', digest: 'Daily digest',
};
const PRIORITIES = [{ v: 4, l: 'Urgent only' }, { v: 3, l: 'High and above' }, { v: 2, l: 'Medium and above' }, { v: 1, l: 'Any priority' }];

const ago = (d) => {
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

export default function TeamsNotificationsPanel({ workspaceId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [saved, setSaved] = useState(false);
  const saveTimer = useRef(null);
  const ws = workspaceId ? { workspaceId } : {};

  const load = useCallback(async () => {
    try {
      const res = await agentAPI.getTeams(ws);
      setData(res.data || res);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- ws is derived from workspaceId
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const persist = (next) => {
    setData(next);
    setSaved(false);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const events = Object.fromEntries(next.events.map((e) => [e.key, e.mode]));
        const res = await agentAPI.saveTeamsPreferences({ ...ws, events, options: next.options });
        setData(res.data || res);
        setSaved(true);
      } catch (err) {
        setError(err.response?.data?.message || err.message);
      }
    }, 500);
  };

  const run = async (key, fn) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fn();
      setData(res.data || res);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setBusy(null);
    }
  };

  if (!data && !error) {
    return <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading Teams notifications…</div>;
  }

  const setMode = (key, mode) => persist({ ...data, events: data.events.map((e) => (e.key === key ? { ...e, mode } : e)) });
  const setOpt = (patch) => persist({ ...data, options: { ...data.options, ...patch } });
  const connected = data?.connection?.connected;

  return (
    <section className="tp-card rounded-xl border border-border p-4 sm:p-5" aria-labelledby="teams-notifications-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <img src="/brand/logo-mark.png" alt="" className="mt-0.5 h-8 w-8 flex-shrink-0 object-contain" />
          <div>
            <h3 id="teams-notifications-heading" className="text-base font-bold text-foreground">Microsoft Teams</h3>
            <p className="text-xs text-muted-foreground">Ticket Pulse messages you in Teams about your tickets. Take a ticket, add a note, reply or snooze straight from the message.</p>
          </div>
        </div>
        {data && (
          <div className="flex flex-wrap items-center gap-2">
            {!connected && (
              <button type="button" disabled={!!busy || !data.configured} onClick={() => run('connect', () => agentAPI.connectTeams(ws))} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-50">
                {busy === 'connect' ? <Activity className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                Connect Teams
              </button>
            )}
            {connected && (
              <button type="button" disabled={!!busy || !data.enabled} onClick={() => run('test', () => agentAPI.sendTeamsTest(ws))} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-input bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50">
                {busy === 'test' ? <Activity className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Send className="h-3.5 w-3.5" aria-hidden="true" />}
                Send me a test
              </button>
            )}
          </div>
        )}
      </div>

      {error && <div role="alert" className="mt-3 rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 px-3 py-2 text-xs text-red-700 dark:text-red-200">{error}</div>}

      {data && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="inline-flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} aria-hidden="true" />
              <span className="text-foreground">{connected ? 'Connected — you have a chat with Ticket Pulse in Teams' : 'Not connected yet'}</span>
            </span>
            {!data.enabled && <span className="text-amber-700 dark:text-amber-200">Teams notifications are off in this workspace — an admin turns them on in Settings → Teams.</span>}
            {!data.configured && <span className="text-amber-700 dark:text-amber-200">The Teams app is not set up on the server yet.</span>}
            {data.connection?.lastError && !connected && <span className="text-red-700 dark:text-red-200">{data.connection.lastError}</span>}
            {saved && <span className="text-muted-foreground">Saved</span>}
          </div>

          <div className="mt-5">
            <TeamsEventGrid
              events={data.events}
              onChange={setMode}
              extra={(e) => (e.key === 'group_unassigned' && e.mode !== 'off' ? (
                <label className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  Priority
                  <select value={data.options.groupMinPriority} onChange={(ev) => setOpt({ groupMinPriority: Number(ev.target.value) })} className="tp-focus-ring rounded border border-input bg-card px-1.5 py-0.5 text-[11px] text-foreground">
                    {PRIORITIES.map((p) => <option key={p.v} value={p.v}>{p.l}</option>)}
                  </select>
                </label>
              ) : null)}
            />
          </div>

          <div className="mt-5 space-y-2 text-sm">
            <div className="text-xs font-semibold text-muted-foreground">When to stay quiet</div>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={data.options.respectAway} onChange={(e) => setOpt({ respectAway: e.target.checked })} />
              <span className="text-foreground">While I&apos;m on leave or outside my work hours <span className="text-muted-foreground">— urgent tickets and SLA breaches still come through</span></span>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={data.options.urgentBypassesQuiet} onChange={(e) => setOpt({ urgentBypassesQuiet: e.target.checked })} />
              <span className="text-foreground">Urgent tickets come through my quiet hours <span className="text-muted-foreground">(quiet hours are set under My alerts below)</span></span>
            </label>
            <label className="flex flex-wrap items-center gap-2">
              <input type="checkbox" checked={data.options.dailyDigest} onChange={(e) => setOpt({ dailyDigest: e.target.checked })} />
              <span className="text-foreground">Send me a daily digest of my open tickets at</span>
              <input type="time" value={data.options.digestTime} onChange={(e) => setOpt({ digestTime: e.target.value })} className="tp-focus-ring rounded border border-input bg-card px-1.5 py-0.5 text-xs text-foreground" />
              <span className="text-xs text-muted-foreground">(weekdays; anything set to Digest is listed there too)</span>
            </label>
          </div>

          {data.mutes?.length > 0 && (
            <div className="mt-5">
              <div className="mb-1 text-xs font-semibold text-muted-foreground">Muted tickets</div>
              <ul className="divide-y divide-border border-y border-border">
                {data.mutes.map((m) => (
                  <li key={m.ticketId} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                    <span className="min-w-0 truncate"><BellOff className="mr-1.5 inline h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /><span className="text-muted-foreground">{m.ref}</span> {m.subject}<span className="ml-2 text-xs text-muted-foreground">{m.forever ? 'until you unmute' : `until ${new Date(m.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}</span></span>
                    <button type="button" onClick={() => run(`unmute-${m.ticketId}`, () => agentAPI.unmuteTeamsTicket(m.ticketId, ws))} className="tp-focus-ring flex-shrink-0 rounded px-2 py-0.5 text-xs font-semibold text-primary hover:bg-muted">Unmute</button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.recent?.length > 0 && (
            <div className="mt-5">
              <div className="mb-1 text-xs font-semibold text-muted-foreground">Recent</div>
              <ul className="space-y-1 text-xs">
                {data.recent.map((r, i) => (
                  <li key={i} className="flex gap-2">
                    <span className={`mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full ${r.status === 'sent' ? 'bg-emerald-500' : r.status === 'failed' ? 'bg-red-500' : 'bg-muted-foreground/40'}`} aria-hidden="true" />
                    <span className="min-w-0 truncate text-foreground">
                      {EVENT_WORD[r.eventKey] || r.eventKey}
                      <span className="text-muted-foreground"> · {r.status === 'sent' ? 'sent' : r.status === 'digest' ? 'held for the digest' : r.status === 'failed' ? `failed${r.reason ? ` (${r.reason})` : ''}` : `not sent — ${REASON[r.reason] || r.reason}`}{r.summary ? ` · ${r.summary}` : ''}</span>
                    </span>
                    <span className="ml-auto flex-shrink-0 text-muted-foreground">{ago(r.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
