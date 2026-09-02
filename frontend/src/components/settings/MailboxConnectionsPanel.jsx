import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle, CheckCircle, Inbox, Loader2, Mail, Plus, Send, ShieldAlert, Star, Trash2, Wifi, XCircle, Zap,
} from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { useTicketTypes } from '../../hooks/useTicketTypes';
import HeldRepliesPanel from '../tickets/HeldRepliesPanel';

/** Phase RL (RL-4): what happens to inbound mail the matcher cannot thread. */
export const NEW_TICKET_POLICY_OPTIONS = [
  {
    value: 'hold_unmatched',
    label: 'Hold unmatched replies (recommended)',
    help: 'Fresh emails become tickets. Emails that look like replies to a conversation Ticket Pulse does not know are held in "Unmatched replies" for a person to attach, create or discard — a reply can never become a duplicate ticket.',
  },
  {
    value: 'create',
    label: 'Always create tickets',
    help: 'Every unmatched email becomes a new ticket, replies included (the pre-September behaviour). Use only when this mailbox never receives replies to mail Ticket Pulse did not send.',
  },
  {
    value: 'replies_only',
    label: 'Replies only — never create',
    help: 'This mailbox only threads replies onto existing tickets. Unmatched mail is held for review, never turned into a ticket.',
  },
];

/**
 * RL-7: the three capability checks from the mailbox Test. `null` = the
 * token roles could not be read (never shown as a tick).
 */
export function capabilityChecks(result, mode = 'both') {
  const wantsSend = ['send', 'both'].includes(mode);
  const checks = [
    { key: 'canRead', label: 'Read inbox (Mail.Read)', value: result?.canRead ?? null, required: true },
    { key: 'canSend', label: 'Send as mailbox (Mail.Send)', value: result?.canSend ?? null, required: wantsSend },
    { key: 'canThread', label: 'Thread replies (Mail.ReadWrite → createReply)', value: result?.canThread ?? null, required: false },
  ];
  return checks;
}

const MODE_LABEL = {
  ingest: 'Ingest only',
  send: 'Send only',
  both: 'Ingest + send',
};

/** "12s ago" / "3m ago" / "2h ago" for the last-notification age. */
export function relativeAge(iso, now = Date.now()) {
  if (!iso) return null;
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Inbound-lane status for a mailbox row (Mega 08-31 MB-2e): which lane is
 * live (Graph webhook vs poller) and, for webhooks, how fresh the last
 * notification is. Backend computes `instantIngest`; `notificationStatus`
 * 'error' means the subscription could not be created/renewed and the
 * poller is carrying the mailbox on its own cadence.
 */
export function ingestLane(mb, now = Date.now()) {
  const ingests = mb.isEnabled && ['ingest', 'both'].includes(mb.mode);
  if (!ingests) return null;
  const every = `Polling every ${mb.pollIntervalSec || 60}s`;
  if (mb.instantIngest) {
    const age = relativeAge(mb.lastNotificationAt, now);
    return { tone: 'instant', label: `Instant (webhook) · ${age ? `last notification ${age}` : 'no notification yet'}` };
  }
  if (mb.notificationStatus === 'error') return { tone: 'error', label: `Webhook error — ${every.toLowerCase()}` };
  if (mb.notificationStatus === 'renewing') return { tone: 'muted', label: `Webhook renewing · ${every.toLowerCase()}` };
  return { tone: 'muted', label: every };
}

const LANE_CLASS = {
  instant: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200 border-emerald-200 dark:border-emerald-500/30',
  error: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200 border-amber-200 dark:border-amber-500/30',
  muted: 'bg-muted text-muted-foreground border-border',
};

/**
 * Settings → Ticket Mailboxes: the workspace's monitored/sending mailboxes for
 * native ticketing. Ingest mailboxes turn inbound email into tickets (and
 * requester replies into thread entries); send mailboxes deliver agent replies
 * AND workflow emails from a real address via Microsoft Graph so replies
 * thread back into the ticket. The starred mailbox is the primary sender
 * (Mega 08-31 Phase MB-1g/1i) — one per workspace, set through PATCH
 * { isPrimary }.
 */
export default function MailboxConnectionsPanel() {
  const [mailboxes, setMailboxes] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [testing, setTesting] = useState(null);
  const [address, setAddress] = useState('');
  const [mode, setMode] = useState('both');
  const [routeGroup, setRouteGroup] = useState('');
  const [routeType, setRouteType] = useState('');
  const [groups, setGroups] = useState([]);
  const [sendLane, setSendLane] = useState(null); // RL-2: Graph outbound lane state
  const [testResult, setTestResult] = useState(null); // RL-7: { mailboxId, ...checks }
  const [heldCount, setHeldCount] = useState(null);
  const { activeTypes } = useTicketTypes(); // workspace type registry

  const load = useCallback(async () => {
    try {
      const res = await ticketsAPI.listMailboxes();
      setMailboxes(res.data || []);
      setSendLane(res.meta?.sendLane || null);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
      setMailboxes([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  // Keep the inbound-lane pill honest (last-notification age, webhook state)
  // without a manual reload; light poll, only while the tab is visible.
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') load();
    }, 30000);
    return () => clearInterval(id);
  }, [load]);
  useEffect(() => {
    ticketsAPI.meta().then((res) => setGroups(res.data?.groups || [])).catch(() => {});
  }, []);

  // Composite "fs:<freshserviceId>" | "int:<groupId>" so one dropdown covers both
  // FreshService and internal (TP-native) groups.
  const groupValue = (mb) => (mb.defaultInternalGroupId ? `int:${mb.defaultInternalGroupId}`
    : mb.defaultGroupId ? `fs:${mb.defaultGroupId}` : '');
  const routingFields = (composite) => ({
    defaultGroupId: composite.startsWith('fs:') ? composite.slice(3) : null,
    defaultInternalGroupId: composite.startsWith('int:') ? Number(composite.slice(4)) : null,
  });
  const routeLabel = (mb) => {
    if (mb.defaultInternalGroupId) return groups.find((g) => g.origin === 'local' && g.id === mb.defaultInternalGroupId)?.name;
    if (mb.defaultGroupId) return groups.find((g) => String(g.freshserviceId) === String(mb.defaultGroupId))?.name;
    return null;
  };

  const add = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      await ticketsAPI.createMailbox({
        address: address.trim(),
        mode,
        ...(routeGroup ? routingFields(routeGroup) : {}),
        ...(routeType ? { defaultTicketType: routeType } : {}),
      });
      setAddress('');
      setRouteGroup('');
      setRouteType('');
      setNotice(`Mailbox connected. New mail to ${address.trim()} becomes tickets within about a minute.`);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const changeRouting = async (mb, patch) => {
    try {
      await ticketsAPI.updateMailbox(mb.id, patch);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
  };

  const toggle = async (mb) => {
    try {
      await ticketsAPI.updateMailbox(mb.id, { isEnabled: !mb.isEnabled });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
  };

  const setPrimary = async (mb) => {
    setError(null);
    try {
      await ticketsAPI.updateMailbox(mb.id, { isPrimary: !mb.isPrimary });
      setNotice(mb.isPrimary
        ? `${mb.address} is no longer the primary sender.`
        : `${mb.address} is now the primary sender for replies and workflow emails.`);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
  };

  const changeMode = async (mb, newMode) => {
    try {
      await ticketsAPI.updateMailbox(mb.id, { mode: newMode });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
  };

  const remove = async (mb) => {
    try {
      await ticketsAPI.removeMailbox(mb.id);
      setNotice(`${mb.address} disconnected.`);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
  };

  const test = async (mb) => {
    setTesting(mb.id);
    setError(null);
    setNotice(null);
    setTestResult(null);
    try {
      const res = await ticketsAPI.testMailbox(mb.id);
      const result = res.data;
      setTestResult({ mailboxId: mb.id, mode: mb.mode, ...(result || {}) });
      if (result?.success) {
        setNotice(`${mb.address}: connected${result.latestSubject ? ` — latest message "${result.latestSubject}"` : ''}`);
      } else {
        setError(`${mb.address}: ${result?.message || 'connection failed'}`);
      }
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 bg-sky-100 dark:bg-sky-500/20 rounded-lg">
          <Inbox className="w-5 h-5 text-sky-600 dark:text-sky-300" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-foreground">Ticket Mailboxes</h3>
          <p className="text-sm text-muted-foreground">
            Connect one or more mailboxes for native ticketing. Inbound mail becomes tickets (or threads
            onto existing ones); agent replies and workflow emails send from the mailbox via Microsoft Graph,
            and replies to them land back in the ticket automatically.
          </p>
        </div>
      </div>

      <div className="p-3 bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30 rounded-lg text-xs text-amber-800 dark:text-amber-200 space-y-1.5" data-testid="mailbox-panel-notice">
        <p>
          <b>Connecting a mailbox in Send or Ingest + send mode changes this workspace&apos;s outbound sender.</b>{' '}
          Agent replies <b>and</b> workflow emails (acknowledgements, status updates, approvals) then leave from that
          address instead of ticketpulse@ via SendGrid, and requester replies to any of them land back in the ticket
          thread automatically. Existing conversations pick this up on the next send.
        </p>
        <p>
          Use a <b>new address</b> that FreshService does not already ingest — pointing both systems at the same
          mailbox would create duplicate tickets. The Azure Graph app registration needs <b>Mail.Read</b> and{' '}
          <b>Mail.Send</b> application permissions with admin consent for the mailbox, plus <b>Mail.ReadWrite</b> for
          header-threaded replies (IT can scope the grant to just these mailboxes with Exchange RBAC for Applications).
          Use <b>Test</b> to verify all three.
        </p>
      </div>

      {sendLane?.status === 'not_granted' && (
        <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg" role="alert" data-testid="mailbox-send-lane-alert">
          <ShieldAlert className="w-4 h-4 text-red-600 dark:text-red-300 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <div className="text-sm text-red-800 dark:text-red-200 space-y-1">
            <p className="font-semibold">Send lane not granted — falling back to SendGrid as ticketpulse@.</p>
            <p className="text-xs">
              Microsoft Graph refused the last send from the workspace mailbox (403 access denied
              {sendLane.lastEventAt ? `, ${new Date(sendLane.lastEventAt).toLocaleString()}` : ''}). Replies and workflow
              emails are still delivered, but they leave from ticketpulse@ instead of the mailbox, so the requester&apos;s
              reply threads only via the Reply-To token.
            </p>
            <p className="text-xs font-medium">{sendLane.permissionGrantText || sendLane.hint}</p>
          </div>
        </div>
      )}
      {sendLane?.status === 'failing' && (
        <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30 rounded-lg" role="status" data-testid="mailbox-send-lane-alert">
          <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-300 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span className="text-sm text-amber-800 dark:text-amber-200">
            The last Graph send from the workspace mailbox failed ({sendLane.errorClass || 'error'}) and fell back to SendGrid. {sendLane.hint}
          </span>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg" role="alert">
          <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-300 mt-0.5 flex-shrink-0" />
          <span className="text-sm text-red-800 dark:text-red-200">{error}</span>
        </div>
      )}
      {testResult && (
        <div className="p-3 bg-card border border-border rounded-lg" data-testid="mailbox-test-checks">
          <p className="text-xs font-medium text-muted-foreground mb-1.5">
            Capability check for {mailboxes?.find((m) => m.id === testResult.mailboxId)?.address || 'mailbox'}
            {Array.isArray(testResult.roles) ? ` · app roles: ${testResult.roles.length ? testResult.roles.join(', ') : 'none'}` : ' · app roles could not be read'}
          </p>
          <ul className="flex flex-wrap gap-2">
            {capabilityChecks(testResult, testResult.mode).map((c) => {
              const state = c.value === true ? 'ok' : c.value === false ? (c.required ? 'fail' : 'warn') : 'unknown';
              const cls = state === 'ok'
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200 dark:border-emerald-500/30'
                : state === 'fail'
                  ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-200 dark:border-red-500/30'
                  : state === 'warn'
                    ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30'
                    : 'bg-muted text-muted-foreground border-border';
              return (
                <li key={c.key} className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium border ${cls}`} data-testid={`mailbox-check-${c.key}`} data-state={state}>
                  {state === 'ok' ? <CheckCircle className="w-3 h-3" aria-hidden="true" /> : state === 'unknown' ? <AlertCircle className="w-3 h-3" aria-hidden="true" /> : <XCircle className="w-3 h-3" aria-hidden="true" />}
                  {c.label}{state === 'unknown' ? ' — could not verify' : state === 'warn' ? ' — not granted (sends work, no header threading)' : state === 'fail' ? ' — NOT granted' : ''}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 p-3 bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-200 dark:border-emerald-500/30 rounded-lg" role="status">
          <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-300 mt-0.5 flex-shrink-0" />
          <span className="text-sm text-emerald-800 dark:text-emerald-200">{notice}</span>
        </div>
      )}

      {/* Add form */}
      <form onSubmit={add} className="flex flex-wrap items-center gap-2 p-3 bg-card border border-border rounded-lg">
        <Mail className="w-4 h-4 text-muted-foreground/75" aria-hidden="true" />
        <input
          type="email"
          required
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="helpdesk-pilot@company.com"
          aria-label="Mailbox address"
          className="flex-1 min-w-[220px] text-sm border border-border rounded-lg px-3 py-2"
        />
        <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Mailbox mode" className="text-sm border border-border rounded-lg px-2.5 py-2">
          <option value="both">Ingest + send</option>
          <option value="ingest">Ingest only</option>
          <option value="send">Send only</option>
        </select>
        {groups.length > 0 && (
          <select
            value={routeGroup}
            onChange={(e) => setRouteGroup(e.target.value)}
            aria-label="Route new tickets to group"
            title="Tickets born from this mailbox land in this group (e.g. AP@ → AP group)"
            className="text-sm border border-border rounded-lg px-2.5 py-2"
          >
            <option value="">No group routing</option>
            {groups.some((g) => g.origin === 'local') && (
              <optgroup label="Internal groups">
                {groups.filter((g) => g.origin === 'local').map((g) => (
                  <option key={`int-${g.id}`} value={`int:${g.id}`}>→ {g.name}</option>
                ))}
              </optgroup>
            )}
            {groups.some((g) => g.origin !== 'local') && (
              <optgroup label="FreshService groups">
                {groups.filter((g) => g.origin !== 'local').map((g) => (
                  <option key={`fs-${g.id}`} value={`fs:${g.freshserviceId}`}>→ {g.name}</option>
                ))}
              </optgroup>
            )}
          </select>
        )}
        <select
          value={routeType}
          onChange={(e) => setRouteType(e.target.value)}
          aria-label="Ticket type"
          title="By default the AI pipeline classifies the ticket type per email. Pick a fixed type only to override that for every ticket from this mailbox."
          className="text-sm border border-border rounded-lg px-2.5 py-2"
        >
          <option value="">Type: AI-detected</option>
          {activeTypes.map((t) => <option key={t.id} value={t.name}>Force type: {t.name}</option>)}
        </select>
        <button
          type="submit"
          disabled={isSaving || !address.trim()}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-sky-600 hover:bg-sky-700 disabled:bg-sky-300 text-white text-sm font-medium rounded-lg"
        >
          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Connect
        </button>
      </form>

      {/* List */}
      {mailboxes === null ? (
        <div className="p-8 text-center text-muted-foreground/75"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
      ) : mailboxes.length === 0 ? (
        <div className="bg-muted/50 border border-border rounded-lg p-8 text-center text-sm text-muted-foreground">
          No mailboxes connected yet. Connect one above to enable email-to-ticket.
        </div>
      ) : (
        <div className="bg-card border border-border rounded-lg divide-y divide-border/60">
          {mailboxes.map((mb) => (
            <div key={mb.id} className="px-4 py-3 flex flex-wrap items-center gap-3">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${mb.isEnabled ? (mb.lastError ? 'bg-amber-500' : 'bg-emerald-500') : 'bg-muted-foreground/40'}`} aria-hidden="true" />
              <div className="flex-1 min-w-[200px]">
                <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                  {mb.address}
                  {mb.isPrimary && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200 border border-amber-200 dark:border-amber-500/30" data-testid={`mailbox-primary-badge-${mb.id}`}>
                      <Star className="w-3 h-3 fill-current" aria-hidden="true" />
                      Primary sender
                    </span>
                  )}
                </p>
                {ingestLane(mb) && (
                  <span
                    className={`inline-flex items-center gap-1 mt-0.5 mb-0.5 px-1.5 py-0.5 rounded-md text-[11px] font-medium border ${LANE_CLASS[ingestLane(mb).tone]}`}
                    data-testid={`mailbox-lane-${mb.id}`}
                    title={mb.subscriptionExpiresAt ? `Webhook subscription renews before ${new Date(mb.subscriptionExpiresAt).toLocaleString()}` : undefined}
                  >
                    {ingestLane(mb).tone === 'instant' ? <Zap className="w-3 h-3" aria-hidden="true" /> : null}
                    {ingestLane(mb).label}
                  </span>
                )}
                <p className="text-xs text-muted-foreground/75">
                  {MODE_LABEL[mb.mode] || mb.mode}
                  {routeLabel(mb) ? <span className="text-sky-600 dark:text-sky-300"> · routes to {routeLabel(mb)}</span> : null}
                  {mb.defaultTicketType ? ` · ${mb.defaultTicketType}` : ''}
                  {mb.lastCheckedAt ? ` · checked ${new Date(mb.lastCheckedAt).toLocaleTimeString()}` : ' · not checked yet'}
                  {mb.lastError ? <span className="text-amber-600 dark:text-amber-300"> · {mb.lastError.slice(0, 60)}</span> : null}
                </p>
              </div>
              <select
                value={mb.mode}
                onChange={(e) => changeMode(mb, e.target.value)}
                aria-label={`Mode for ${mb.address}`}
                className="text-xs border border-border rounded-lg px-2 py-1.5"
              >
                <option value="both">Ingest + send</option>
                <option value="ingest">Ingest only</option>
                <option value="send">Send only</option>
              </select>
              {groups.length > 0 && (
                <select
                  value={groupValue(mb)}
                  onChange={(e) => changeRouting(mb, routingFields(e.target.value))}
                  aria-label={`Group routing for ${mb.address}`}
                  title="Tickets born from this mailbox land in this group"
                  className="text-xs border border-border rounded-lg px-2 py-1.5"
                >
                  <option value="">No group</option>
                  {groups.some((g) => g.origin === 'local') && (
                    <optgroup label="Internal groups">
                      {groups.filter((g) => g.origin === 'local').map((g) => (
                        <option key={`int-${g.id}`} value={`int:${g.id}`}>→ {g.name}</option>
                      ))}
                    </optgroup>
                  )}
                  {groups.some((g) => g.origin !== 'local') && (
                    <optgroup label="FreshService groups">
                      {groups.filter((g) => g.origin !== 'local').map((g) => (
                        <option key={`fs-${g.id}`} value={`fs:${g.freshserviceId}`}>→ {g.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              )}
              <select
                value={mb.defaultTicketType || ''}
                onChange={(e) => changeRouting(mb, { defaultTicketType: e.target.value || null })}
                aria-label={`Default ticket type for ${mb.address}`}
                className="text-xs border border-border rounded-lg px-2 py-1.5"
              >
                <option value="">Type: default</option>
                {activeTypes.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                {mb.defaultTicketType && !activeTypes.some((t) => t.name === mb.defaultTicketType) && (
                  <option value={mb.defaultTicketType}>{mb.defaultTicketType}</option>
                )}
              </select>
              {['ingest', 'both'].includes(mb.mode) && (
                <>
                  <select
                    value={mb.newTicketPolicy || 'hold_unmatched'}
                    onChange={(e) => changeRouting(mb, { newTicketPolicy: e.target.value })}
                    aria-label={`New-ticket policy for ${mb.address}`}
                    title={NEW_TICKET_POLICY_OPTIONS.find((o) => o.value === (mb.newTicketPolicy || 'hold_unmatched'))?.help}
                    className="text-xs border border-border rounded-lg px-2 py-1.5"
                    data-testid={`mailbox-policy-${mb.id}`}
                  >
                    {NEW_TICKET_POLICY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <label
                    className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer"
                    title="An agent who replies-all to a requester with this mailbox in Cc creates the ticket for that requester (the agent's reply is the first response and the agent is assigned). Off = such mail is held for review."
                  >
                    <input
                      type="checkbox"
                      checked={mb.agentCcIntake !== false}
                      onChange={(e) => changeRouting(mb, { agentCcIntake: e.target.checked })}
                      aria-label={`Agent Cc intake for ${mb.address}`}
                      className="h-3.5 w-3.5 rounded border-input"
                    />
                    Agent Cc creates tickets
                  </label>
                </>
              )}
              <button
                type="button"
                onClick={() => setPrimary(mb)}
                aria-pressed={Boolean(mb.isPrimary)}
                aria-label={mb.isPrimary ? `${mb.address} is the primary sender — click to unset` : `Make ${mb.address} the primary sender`}
                title={mb.isPrimary
                  ? 'Primary sender: replies and workflow emails leave from this mailbox'
                  : 'Make this the primary sender for replies and workflow emails'}
                className={`p-1.5 rounded-lg border tp-focus-ring ${
                  mb.isPrimary
                    ? 'text-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/15 border-amber-200 dark:border-amber-500/30'
                    : 'text-muted-foreground/75 border-transparent hover:text-amber-600 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-500/15'
                }`}
              >
                <Star className={`w-4 h-4 ${mb.isPrimary ? 'fill-current' : ''}`} />
              </button>
              <button
                onClick={() => test(mb)}
                disabled={testing === mb.id}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-sky-700 dark:text-sky-200 bg-sky-50 dark:bg-sky-500/15 border border-sky-200 dark:border-sky-500/30 rounded-lg hover:bg-sky-100 dark:hover:bg-sky-500/20"
              >
                {testing === mb.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wifi className="w-3 h-3" />}
                Test
              </button>
              <button
                onClick={() => toggle(mb)}
                className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border ${
                  mb.isEnabled
                    ? 'text-muted-foreground bg-muted/50 border-border hover:bg-muted'
                    : 'text-emerald-700 dark:text-emerald-200 bg-emerald-50 dark:bg-emerald-500/15 border-emerald-200 dark:border-emerald-500/30 hover:bg-emerald-100 dark:hover:bg-emerald-500/20'
                }`}
              >
                {mb.isEnabled ? 'Disable' : 'Enable'}
              </button>
              <button
                onClick={() => remove(mb)}
                aria-label={`Disconnect ${mb.address}`}
                className="p-1.5 text-muted-foreground/75 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/15 rounded-lg"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="text-xs text-muted-foreground/75 space-y-1" data-testid="mailbox-policy-help">
        <p className="font-medium text-muted-foreground">What each new-ticket policy means</p>
        <ul className="list-disc pl-4 space-y-0.5">
          {NEW_TICKET_POLICY_OPTIONS.map((o) => <li key={o.value}><b>{o.label}</b> — {o.help}</li>)}
        </ul>
        <p>
          <b>Agent Cc creates tickets</b> — an agent who replies-all to a requester&apos;s direct email with the mailbox in Cc
          creates the ticket for that requester; the agent&apos;s reply becomes the first response and the agent is assigned.
          Turn it off to hold such mail for review instead.
        </p>
      </div>

      <div className="pt-2 border-t border-border/60" id="unmatched-replies">
        <HeldRepliesPanel onCountChange={setHeldCount} />
        {heldCount > 0 && (
          <p className="sr-only" data-testid="mailbox-held-count">{heldCount} unmatched replies waiting</p>
        )}
      </div>

      <div className="text-xs text-muted-foreground/75 flex items-start gap-1.5">
        <Send className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
        <span>
          Outbound sender for replies and workflow emails: the starred primary mailbox; without a star, the oldest
          enabled send-capable mailbox; with none connected, SendGrid as ticketpulse@ (replies to those are not read back).
        </span>
      </div>
    </div>
  );
}
