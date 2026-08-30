import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle, CheckCircle, Inbox, Loader2, Mail, Plus, Send, Trash2, Wifi,
} from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { useTicketTypes } from '../../hooks/useTicketTypes';

const MODE_LABEL = {
  ingest: 'Ingest only',
  send: 'Send only',
  both: 'Ingest + send',
};

/**
 * Settings → Ticket Mailboxes: the workspace's monitored/sending mailboxes for
 * native ticketing. Ingest mailboxes turn inbound email into tickets (and
 * requester replies into thread entries); send mailboxes deliver agent replies
 * from a real address via Microsoft Graph so email threading works.
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
  const { activeTypes } = useTicketTypes(); // workspace type registry

  const load = useCallback(async () => {
    try {
      const res = await ticketsAPI.listMailboxes();
      setMailboxes(res.data || []);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
      setMailboxes([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
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
    try {
      const res = await ticketsAPI.testMailbox(mb.id);
      const result = res.data;
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
            onto existing ones); agent replies send from the mailbox via Microsoft Graph.
          </p>
        </div>
      </div>

      <div className="p-3 bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30 rounded-lg text-xs text-amber-800 dark:text-amber-200">
        Use a <b>new address</b> that FreshService does not already ingest — pointing both systems at the
        same mailbox would create duplicate tickets. The Azure app registration needs <b>Mail.Read</b> and
        <b> Mail.Send</b> application permissions for the mailbox.
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg" role="alert">
          <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-300 mt-0.5 flex-shrink-0" />
          <span className="text-sm text-red-800 dark:text-red-200">{error}</span>
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
                <p className="text-sm font-medium text-foreground">{mb.address}</p>
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

      <div className="text-xs text-muted-foreground/75 flex items-center gap-1.5">
        <Send className="w-3.5 h-3.5" aria-hidden="true" />
        Replies from Ticket Pulse send from the first enabled send-capable mailbox; without one they fall back to SendGrid.
      </div>
    </div>
  );
}
