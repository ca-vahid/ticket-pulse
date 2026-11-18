import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, Download, RefreshCw } from 'lucide-react';
import { teamsAdminAPI } from '../../services/api';
import TeamsEventGrid from '../agent/TeamsEventGrid';
import TeamsAssistantSettings from './TeamsAssistantSettings';
import { TEAMS_ADMIN_STEPS, blockedDetail, statusOf } from '../agent/teamsStatus';
import { SwitchRow } from '../ui/switch';
import { MAX_DIGEST_TIMES, digestTimeLabel, isDigestTime } from '../agent/digestTimes';

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

/**
 * MEGA 11-14 Part C: the status column. Connected · Disconnected (by whom) ·
 * Blocked by Teams policy (last refusal, cards missed in 7 days) · Not
 * connected yet (with the last error). Older servers send no status: fall
 * back to the connected / disconnected flags.
 */
function AgentStatus({ a }) {
  const state = a.status || (a.disconnected ? 'disconnected' : a.connected ? 'connected' : 'not_connected');
  const s = statusOf(state);
  let detail = '';
  let label = s.label;
  if (state === 'blocked') detail = blockedDetail(a);
  else if (state === 'disconnected') {
    label = `Disconnected ${a.disconnectedBySelf ? 'by themselves' : a.disconnectedBy ? `by ${a.disconnectedBy}` : 'by an admin'}`;
    detail = a.missed7d ? `${a.missed7d} card${a.missed7d === 1 ? '' : 's'} not sent in 7 days` : '';
  } else if (state === 'not_connected' && a.lastError) detail = a.lastError;
  return (
    <span className="col-span-2 flex min-w-0 items-start gap-1.5 text-xs sm:col-span-1 sm:col-start-2 sm:row-start-1" data-testid={`teams-status-${a.id}`}>
      <span className={`mt-1 h-2 w-2 flex-shrink-0 rounded-full ${s.dot}`} aria-hidden="true" />
      <span className="min-w-0">
        <span className={`font-medium ${s.text}`}>{label}</span>
        {detail && <span className={`block truncate ${state === 'not_connected' ? 'text-red-700 dark:text-red-200' : 'text-muted-foreground'}`} title={detail}>{detail}</span>}
      </span>
    </span>
  );
}

export default function TeamsSettingsPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [webhook, setWebhook] = useState('');
  // QA 10-01 #4: Disconnect asks once, inline (no browser dialog).
  const [confirmDisconnect, setConfirmDisconnect] = useState(null);
  // Part C: "Show them" narrows the list to the people a Teams policy blocks.
  const [onlyBlocked, setOnlyBlocked] = useState(false);
  // QA 11-17 #2: adding a digest time, and changing the first (daily) one.
  const [newTime, setNewTime] = useState('15:00');
  const [firstDraft, setFirstDraft] = useState(null);

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
      setNotice(`Connected ${r.connected}${r.reinstalled ? ` · the app was put back for ${r.reinstalled}` : ''}${r.skippedDisconnected ? ` · ${r.skippedDisconnected} disconnected by an admin left alone` : ''}${r.failed?.length ? ` · ${r.failed.length} could not be connected` : ''}`);
      if (r.failed?.length) setError(r.failed.slice(0, 3).map((f) => `${f.email}: ${f.error}`).join(' · '));
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (agent) => {
    setBusy(`disconnect-${agent.id}`);
    setNotice(null);
    setError(null);
    try {
      const res = await teamsAdminAPI.disconnect([agent.id]);
      const r = res.data || res;
      setNotice(`${agent.name} is disconnected — Ticket Pulse will not message them in Teams until someone connects them again`);
      if (r.failed?.length) setError(r.failed.map((f) => f.error).join(' · '));
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setBusy(null);
      setConfirmDisconnect(null);
    }
  };

  if (!data && !error) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading Teams settings…</div>;

  const s = data?.settings;
  const defaults = s?.defaults || { events: {}, options: {} };
  // QA 11-17: rows behind a workspace switch show only while it is on.
  const gridEvents = (data?.events || [])
    .filter((e) => !e.offeredBy || s?.[e.offeredBy] === true)
    .map((e) => ({ ...e, mode: defaults.events?.[e.key] || e.mode }));
  const digestTimes = Array.isArray(s?.digestTimes) && s.digestTimes.length ? s.digestTimes : [defaults.options?.digestTime || '08:00'];
  const saveTimes = (list, label) => save({ digestTimes: [list[0], ...[...new Set(list.slice(1))].sort()] }, label);
  const connectedCount = data?.agents?.filter((a) => a.connected).length || 0;
  const blockedCount = data?.health?.blocked ?? (data?.agents || []).filter((a) => a.status === 'blocked').length;
  const disconnectedCount = data?.health?.disconnected ?? (data?.agents || []).filter((a) => a.disconnected).length;
  const shownAgents = onlyBlocked && blockedCount > 0 ? (data?.agents || []).filter((a) => a.status === 'blocked') : (data?.agents || []);

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
            {blockedCount > 0 && (
              // MEGA 11-14 Part C: who cannot get cards, at the top, with the list behind it.
              <div className="mb-2 flex flex-wrap items-start gap-x-3 gap-y-1 text-sm" data-testid="teams-blocked-count">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-foreground">{blockedCount === 1 ? '1 person can’t get Teams cards' : `${blockedCount} people can’t get Teams cards`}</p>
                  <p className="text-xs text-muted-foreground">
                    A Teams policy blocks the Ticket Pulse app for them. {TEAMS_ADMIN_STEPS} Then press Connect on their row.
                    {disconnectedCount > 0 ? ` ${disconnectedCount} more ${disconnectedCount === 1 ? 'is' : 'are'} disconnected.` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  aria-pressed={onlyBlocked}
                  onClick={() => setOnlyBlocked((v) => !v)}
                  className="tp-focus-ring flex-shrink-0 rounded px-2 py-0.5 text-xs font-semibold text-primary hover:bg-muted"
                >
                  {onlyBlocked ? 'Show everyone' : 'Show them'}
                </button>
              </div>
            )}
            <ul className="max-h-72 divide-y divide-border overflow-y-auto border-y border-border settings-scrollbar" aria-label="Agents and their Teams status">
              {shownAgents.map((a) => (
                <li key={a.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 py-1.5 text-sm sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto]">
                  <span className="truncate text-foreground">{a.name}</span>
                  <AgentStatus a={a} />
                  <span className="col-start-2 row-start-1 flex items-center justify-end gap-0.5 sm:col-start-3">
                    {!a.connected && (
                      <button type="button" disabled={!!busy || !data.bot.catalogAppId} onClick={() => install([a.id])} className="tp-focus-ring flex-shrink-0 rounded px-2 py-0.5 text-xs font-semibold text-primary hover:bg-muted disabled:opacity-50">
                        {busy === `install-${a.id}` ? 'Connecting…' : a.disconnected ? 'Connect again' : 'Connect'}
                      </button>
                    )}
                    {a.connected && confirmDisconnect !== a.id && (
                      <button type="button" disabled={!!busy || !data.bot.catalogAppId} onClick={() => install([a.id])} title="Checks with Teams and puts the app back if it was removed" className="tp-focus-ring flex-shrink-0 rounded px-2 py-0.5 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50" data-testid={`teams-reinstall-${a.id}`}>
                        {busy === `install-${a.id}` ? 'Checking…' : 'Reinstall'}
                      </button>
                    )}
                    {a.connected && confirmDisconnect !== a.id && (
                      <button type="button" disabled={!!busy} onClick={() => setConfirmDisconnect(a.id)} className="tp-focus-ring flex-shrink-0 rounded px-2 py-0.5 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-red-700 dark:hover:text-red-200 disabled:opacity-50" data-testid={`teams-disconnect-${a.id}`}>
                      Disconnect
                      </button>
                    )}
                    {a.connected && confirmDisconnect === a.id && (
                      <span className="flex flex-shrink-0 items-center gap-1 text-xs" role="group" aria-label={`Disconnect ${a.name}?`}>
                        <span className="text-muted-foreground">Remove the app from their Teams?</span>
                        <button type="button" disabled={!!busy} onClick={() => disconnect(a)} className="tp-focus-ring rounded px-2 py-0.5 font-semibold text-red-700 hover:bg-red-50 dark:text-red-200 dark:hover:bg-red-500/15 disabled:opacity-50" data-testid={`teams-disconnect-confirm-${a.id}`}>
                          {busy === `disconnect-${a.id}` ? 'Disconnecting…' : 'Disconnect'}
                        </button>
                        <button type="button" disabled={!!busy} onClick={() => setConfirmDisconnect(null)} className="tp-focus-ring rounded px-2 py-0.5 font-semibold text-muted-foreground hover:bg-muted">Keep</button>
                      </span>
                    )}
                  </span>
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
              extra={(e) => (e.key === 'group_unassigned' && e.mode !== 'off' ? (
                // QA 11-10 #1: the workspace's priority floor for this notice. It was
                // only settable per person, so the workspace default stayed High and above.
                <div className="space-y-1">
                  <div className="text-[11px] text-muted-foreground/75">Goes to the active agents in the ticket&apos;s group (FreshService or Ticket Pulse group).</div>
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    Priority
                    <select
                      aria-label="Priority for new unassigned tickets"
                      value={defaults.options?.groupMinPriority ?? 3}
                      disabled={busy === 'save'}
                      onChange={(ev) => save({ defaults: { ...defaults, options: { ...defaults.options, groupMinPriority: Number(ev.target.value) } } }, 'Defaults saved')}
                      className="tp-focus-ring rounded border border-input bg-card px-1.5 py-0.5 text-[11px] text-foreground"
                    >
                      {PRIORITIES.map((p) => <option key={p.v} value={p.v}>{p.v === 4 ? 'Urgent only' : p.l}</option>)}
                    </select>
                  </label>
                </div>
              ) : null)}
            />
          </section>

          {/* QA 11-17 #2: up to four digest times a day, Pacific. */}
          <section aria-labelledby="teams-digest-times-heading">
            <h3 id="teams-digest-times-heading" className="mb-1 text-sm font-semibold text-foreground">Digest times</h3>
            <p className="mb-2 text-xs text-muted-foreground">When digests go out on weekdays, in Pacific time. The first is everyone&apos;s daily digest, and each person can move theirs. People turn the other times on for themselves; a later digest lists only what&apos;s new since the earlier one.</p>
            <ul className="divide-y divide-border border-y border-border" aria-label="Digest times" data-testid="teams-digest-times">
              {digestTimes.map((t, i) => (
                <li key={t} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{digestTimeLabel(t)}</span>
                    <span className="text-xs text-muted-foreground"> · {i === 0 ? 'daily digest, the default for everyone' : 'people opt in'}</span>
                  </span>
                  {i === 0 && firstDraft === null && (
                    <button type="button" disabled={busy === 'save'} onClick={() => setFirstDraft(t)} className="tp-focus-ring rounded px-2 py-0.5 text-xs font-semibold text-primary hover:bg-muted disabled:opacity-50">Change</button>
                  )}
                  {i === 0 && firstDraft !== null && (
                    <span className="flex items-center gap-1.5 text-xs">
                      <input type="time" aria-label="Daily digest time" value={firstDraft} onChange={(e) => setFirstDraft(e.target.value)} className="tp-focus-ring rounded border border-input bg-card px-1.5 py-0.5 text-xs text-foreground" />
                      <button
                        type="button"
                        aria-label="Save the daily digest time"
                        disabled={busy === 'save' || !isDigestTime(firstDraft) || digestTimes.slice(1).includes(firstDraft)}
                        onClick={() => { saveTimes([firstDraft, ...digestTimes.slice(1)], `Daily digest now at ${digestTimeLabel(firstDraft)}`); setFirstDraft(null); }}
                        className="tp-focus-ring rounded px-2 py-0.5 font-semibold text-primary hover:bg-muted disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button type="button" onClick={() => setFirstDraft(null)} className="tp-focus-ring rounded px-2 py-0.5 font-semibold text-muted-foreground hover:bg-muted">Cancel</button>
                    </span>
                  )}
                  {i > 0 && (
                    <button
                      type="button"
                      disabled={busy === 'save'}
                      aria-label={`Remove ${digestTimeLabel(t)}`}
                      onClick={() => saveTimes(digestTimes.filter((x) => x !== t), `${digestTimeLabel(t)} removed`)}
                      className="tp-focus-ring rounded px-2 py-0.5 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {digestTimes.length < MAX_DIGEST_TIMES ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <label className="inline-flex items-center gap-1.5 text-muted-foreground">
                  Add a time
                  <input type="time" aria-label="New digest time" value={newTime} onChange={(e) => setNewTime(e.target.value)} className="tp-focus-ring rounded border border-input bg-card px-1.5 py-0.5 text-xs text-foreground" />
                  <span>PT</span>
                </label>
                <button
                  type="button"
                  disabled={busy === 'save' || !isDigestTime(newTime) || digestTimes.includes(newTime)}
                  onClick={() => saveTimes([...digestTimes, newTime], `Digest at ${digestTimeLabel(newTime)} added`)}
                  className="tp-focus-ring rounded-lg border border-input bg-card px-3 py-1 font-semibold text-foreground hover:bg-muted disabled:opacity-50"
                >
                  Add
                </button>
                {digestTimes.includes(newTime) && <span className="text-muted-foreground">{digestTimeLabel(newTime)} is already on the list.</span>}
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">That&apos;s the most: {MAX_DIGEST_TIMES} times a day.</p>
            )}
          </section>

          {/* QA 11-17 #3 and #4: notices a workspace offers. */}
          <section aria-labelledby="teams-more-notices-heading">
            <h3 id="teams-more-notices-heading" className="text-sm font-semibold text-foreground">More notices</h3>
            <div className="divide-y divide-border">
              <SwitchRow
                testId="teams-oncall-notice"
                label="Tell the person on call when their on-call week starts"
                description="One Teams message when their on-call period starts (the handover in Settings → Urgent Response → On-call, e.g. Mon 5:00 PM PT), with the dates. It comes through quiet hours and outside work hours. People can turn it off for themselves."
                checked={s.onCallNotice === true}
                disabled={busy === 'save'}
                onCheckedChange={(on) => save({ onCallNotice: on }, on ? 'The on-call person will be told when their week starts' : 'On-call start messages are off')}
              />
              <SwitchRow
                testId="teams-survey-results"
                label="Offer survey result notices"
                description="Adds “A survey result comes in” to each person’s Teams choices, off until they turn it on. Agents hear about tickets they handled; admins and reviewers can choose everyone’s. One result per message, never totals or rankings."
                checked={s.surveyResults === true}
                disabled={busy === 'save'}
                onCheckedChange={(on) => save({ surveyResults: on }, on ? 'Survey result notices are offered in this workspace' : 'Survey result notices are no longer offered')}
              />
            </div>
          </section>

          <TeamsAssistantSettings />

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
