import { useCallback, useEffect, useState } from 'react';
import { Activity, Download, RefreshCw } from 'lucide-react';
import { teamsAdminAPI } from '../../services/api';
import TeamsEventGrid from '../agent/TeamsEventGrid';

/**
 * Settings → Teams (plans/TEAMS_NOTIFICATIONS_PLAN.md): is the bot healthy,
 * is it on for this workspace, what agents get by default, who is connected,
 * and the optional team-channel feed.
 */
const PRIORITIES = [{ v: 4, l: 'Urgent' }, { v: 3, l: 'High and above' }, { v: 2, l: 'Medium and above' }, { v: 1, l: 'Any priority' }];

const Check = ({ ok, children }) => (
  <li className="flex items-center gap-2 text-sm">
    <span className={`h-2 w-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`} aria-hidden="true" />
    <span className="text-foreground">{children}</span>
  </li>
);

export default function TeamsSettingsPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [webhook, setWebhook] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await teamsAdminAPI.status();
      const d = res.data || res;
      setData(d);
      setWebhook(d.settings.channelWebhookUrl || '');
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (patch, label = 'Saved') => {
    setBusy('save');
    try {
      const res = await teamsAdminAPI.saveSettings(patch);
      setData((d) => ({ ...d, settings: res.data || res }));
      setNotice(label);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setBusy(null);
    }
  };

  const install = async (technicianIds = null) => {
    setBusy(technicianIds ? `install-${technicianIds[0]}` : 'install');
    setNotice(null);
    try {
      const res = await teamsAdminAPI.install(technicianIds ? { technicianIds } : {});
      const r = res.data || res;
      setNotice(`Connected ${r.connected}${r.failed?.length ? ` · ${r.failed.length} could not be connected` : ''}`);
      if (r.failed?.length) setError(r.failed.slice(0, 3).map((f) => `${f.email}: ${f.error}`).join(' · '));
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setBusy(null);
    }
  };

  if (!data && !error) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading Teams settings…</div>;

  const s = data?.settings;
  const defaults = s?.defaults || { events: {}, options: {} };
  const gridEvents = (data?.events || []).map((e) => ({ ...e, mode: defaults.events?.[e.key] || e.mode }));
  const connectedCount = data?.agents?.filter((a) => a.connected).length || 0;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Teams notifications</h2>
        <p className="text-sm text-muted-foreground">Ticket Pulse messages agents in Microsoft Teams about their tickets — assignments, replies, SLA warnings, approvals — and they act from the message. Each agent changes their own choices under Mail &amp; alerts.</p>
      </div>

      {error && <div role="alert" className="rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 px-3 py-2 text-xs text-red-700 dark:text-red-200">{error}</div>}
      {notice && <div className="text-xs text-muted-foreground">{notice}</div>}

      {data && (
        <>
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Connection</h3>
              <button type="button" onClick={load} className="tp-focus-ring inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Check again</button>
            </div>
            <ul className="space-y-1.5">
              <Check ok={data.bot.configured}>Bot credentials on the server{data.bot.appId ? ` (app ${data.bot.appId.slice(0, 8)}…)` : ''}</Check>
              <Check ok={data.bot.botToken}>Can sign in to the Bot Framework</Check>
              <Check ok={data.bot.graphToken}>Can reach Microsoft Graph</Check>
              <Check ok={Boolean(data.bot.catalogAppId)}>Ticket Pulse app is in the organisation&apos;s Teams app store</Check>
            </ul>
            {data.bot.error && <p className="mt-2 text-xs text-red-700 dark:text-red-200">{data.bot.error}</p>}
            {!data.bot.catalogAppId && data.bot.graphToken && (
              <p className="mt-2 text-xs text-muted-foreground">
                One-time step for a Teams admin: <a className="font-semibold text-primary underline" href={teamsAdminAPI.packageUrl()}>download the app package <Download className="inline h-3 w-3" aria-hidden="true" /></a>, then in the Teams admin center go to Teams apps → Manage apps → Upload new app.
              </p>
            )}
          </section>

          <section>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={s.teamsEnabled} disabled={busy === 'save'} onChange={(e) => save({ teamsEnabled: e.target.checked }, e.target.checked ? 'Teams notifications are on for this workspace' : 'Teams notifications are off for this workspace')} />
              <span>
                <span className="text-sm font-semibold text-foreground">Send Teams notifications in this workspace</span>
                <span className="block text-xs text-muted-foreground">Only people who are connected get messages. Leave FreshService ServiceBot on until the pilot is done, or agents get everything twice.</span>
              </span>
            </label>
          </section>

          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">Agents <span className="font-normal text-muted-foreground">— {connectedCount} of {data.agents.length} connected</span></h3>
              <button type="button" disabled={!!busy || !data.bot.catalogAppId} onClick={() => install()} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-50">
                {busy === 'install' && <Activity className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                Connect all agents
              </button>
            </div>
            <ul className="max-h-72 divide-y divide-border overflow-y-auto border-y border-border settings-scrollbar">
              {data.agents.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`h-2 w-2 flex-shrink-0 rounded-full ${a.connected ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} aria-hidden="true" />
                    <span className="truncate text-foreground">{a.name}</span>
                    {a.lastError && !a.connected && <span className="truncate text-xs text-red-700 dark:text-red-200">{a.lastError}</span>}
                  </span>
                  {!a.connected && (
                    <button type="button" disabled={!!busy || !data.bot.catalogAppId} onClick={() => install([a.id])} className="tp-focus-ring flex-shrink-0 rounded px-2 py-0.5 text-xs font-semibold text-primary hover:bg-muted disabled:opacity-50">
                      {busy === `install-${a.id}` ? 'Connecting…' : 'Connect'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {data.last24h && Object.keys(data.last24h).length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                Last 24 hours: {Object.entries(data.last24h).map(([k, v]) => `${v} ${k}`).join(' · ')}
                {data.lastFailure ? ` · last failure: ${data.lastFailure.reason}` : ''}
              </p>
            )}
          </section>

          <section>
            <h3 className="mb-1 text-sm font-semibold text-foreground">Defaults for agents</h3>
            <p className="mb-3 text-xs text-muted-foreground">What each agent gets until they change it themselves.</p>
            <TeamsEventGrid
              events={gridEvents}
              disabled={busy === 'save'}
              onChange={(key, mode) => save({ defaults: { ...defaults, events: { ...defaults.events, [key]: mode } } }, 'Defaults saved')}
            />
          </section>

          <section>
            <h3 className="mb-1 text-sm font-semibold text-foreground">Team channel feed</h3>
            <p className="mb-2 text-xs text-muted-foreground">Optional: post new unassigned tickets to a Teams channel. In the channel choose Workflows → &ldquo;Post to a channel when a webhook request is received&rdquo; and paste its URL here.</p>
            <div className="flex flex-wrap items-center gap-2">
              <input type="url" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://…logic.azure.com/…" className="tp-focus-ring min-w-0 flex-1 rounded-lg border border-input bg-card px-2.5 py-1.5 text-sm text-foreground" />
              <select value={s.channelMinPriority} onChange={(e) => save({ channelMinPriority: Number(e.target.value) })} className="tp-focus-ring rounded-lg border border-input bg-card px-2 py-1.5 text-sm text-foreground">
                {PRIORITIES.map((p) => <option key={p.v} value={p.v}>{p.l}</option>)}
              </select>
              <button type="button" disabled={busy === 'save'} onClick={() => save({ channelWebhookUrl: webhook }, webhook ? 'Channel feed saved' : 'Channel feed removed')} className="tp-focus-ring rounded-lg border border-input bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted">Save</button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
