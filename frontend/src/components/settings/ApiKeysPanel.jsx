import { useCallback, useEffect, useState } from 'react';
import {
  Check, Copy, KeyRound, Loader2, Lock, Plus, RefreshCw, Send, Trash2, Webhook,
} from 'lucide-react';
import { ticketsAPI } from '../../services/api';

// Grouped scope catalogue — mirrors backend API_KEY_SCOPES (apiKeyService.js).
const SCOPE_GROUPS = [
  ['Tickets', [['tickets:read', 'List & read tickets'], ['tickets:write', 'Create, update, assign, merge']]],
  ['Conversations', [['conversations:read', 'Read the full thread'], ['conversations:write', 'Public replies & internal notes']]],
  ['Tasks', [['tasks:read', 'Read tasks'], ['tasks:write', 'Create / update / delete tasks']]],
  ['Directory', [['contacts:read', 'Read requesters'], ['agents:read', 'Read agents'], ['groups:read', 'Read groups']]],
  ['Taxonomy', [['tags:read', 'Read tag palette'], ['tags:write', 'Set ticket tags'], ['categories:read', 'Read categories'], ['types:read', 'Read ticket types']]],
  ['Attachments', [['attachments:read', 'List & download attachments']]],
  ['Approvals', [['approvals:read', 'Read approvals'], ['approvals:write', 'Request approvals']]],
  ['Search', [['search:read', 'Search tickets']]],
];
const EXPIRY_OPTIONS = [['', 'Never'], ['30', '30 days'], ['90', '90 days'], ['365', '1 year']];

const WEBHOOK_EVENTS = [
  ['ticket.created', 'Ticket created'],
  ['ticket.status_changed', 'Status changed'],
  ['ticket.assigned', 'Assigned'],
  ['ticket.reply_received', 'Requester replied'],
  ['ticket.public_reply_added', 'Agent replied'],
  ['ticket.tags_changed', 'Tags changed'],
  ['approval.requested', 'Approval requested'],
  ['approval.decided', 'Approval decided'],
];

const fmtDate = (d) => new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function DeliveryLog({ subId }) {
  const [rows, setRows] = useState(null);
  const load = useCallback(() => { ticketsAPI.listWebhookDeliveries(subId).then((r) => setRows(r.data || [])).catch(() => setRows([])); }, [subId]);
  useEffect(() => { load(); }, [load]);
  const redeliver = async (id) => { await ticketsAPI.redeliverWebhook(id).catch(() => {}); setTimeout(load, 300); };
  if (rows === null) return <p className="mt-1.5 text-[11px] text-slate-400">Loading deliveries…</p>;
  if (!rows.length) return <p className="mt-1.5 text-[11px] text-slate-400">No deliveries yet.</p>;
  const tone = { success: 'text-emerald-600', pending: 'text-amber-600', failed: 'text-red-600', dead: 'text-red-600' };
  return (
    <div className="mt-1.5 overflow-x-auto rounded-md border border-slate-100">
      <table className="w-full text-[11px]">
        <tbody className="divide-y divide-slate-100">
          {rows.map((d) => (
            <tr key={d.id}>
              <td className="px-2 py-1 font-mono text-violet-700">{d.eventType}</td>
              <td className={`px-2 py-1 font-semibold ${tone[d.status] || 'text-slate-500'}`}>{d.status}{d.lastStatusCode ? ` ${d.lastStatusCode}` : ''}</td>
              <td className="px-2 py-1 text-slate-400 tabular-nums">try {d.attempts}</td>
              <td className="px-2 py-1 text-slate-400">{fmtDate(d.createdAt)}</td>
              <td className="px-2 py-1 text-right">
                {(d.status === 'dead' || d.status === 'failed') && (
                  <button onClick={() => redeliver(d.id)} className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50">Redeliver</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WebhooksSection() {
  const [subs, setSubs] = useState([]);
  const [draft, setDraft] = useState(null);
  const [freshSecret, setFreshSecret] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [openLog, setOpenLog] = useState(null);

  const load = useCallback(() => {
    ticketsAPI.listWebhooks().then((res) => setSubs(res.data || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const res = await ticketsAPI.createWebhook(draft);
      setFreshSecret({ url: res.data.url, secret: res.data.secret });
      setDraft(null); load();
    } catch (e) { setError(e.response?.data?.detail || e.response?.data?.message || e.message); }
    setBusy(false);
  };
  const act = async (fn) => { setError(null); try { await fn(); load(); } catch (e) { setError(e.response?.data?.detail || e.response?.data?.message || e.message); } };
  const ping = async (id) => {
    setTestResult({ id, pending: true });
    try { const res = await ticketsAPI.testWebhook(id); setTestResult({ id, ...res.data }); } catch (e) { setTestResult({ id, ok: false, error: e.message }); }
    load();
  };

  return (
    <section className="tp-card rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <Webhook className="w-4 h-4 text-blue-500" aria-hidden="true" />
        <h3 className="text-sm font-bold text-slate-800">Outbound webhooks</h3>
      </div>
      <p className="text-xs text-slate-400 mb-3">
        Signed JSON POSTs on ticket events, following the <a href="https://www.standardwebhooks.com" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">Standard Webhooks</a> spec
        (<code className="bg-slate-100 rounded px-1">webhook-signature: v1,&lt;HMAC&gt;</code>). Delivery is durable with exponential-backoff retries; failures are visible below with a redeliver action.
      </p>

      {freshSecret && (
        <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-xs font-semibold text-emerald-800 mb-1.5">Webhook created — copy the signing secret now, it is shown only once:</p>
          <div className="flex items-center gap-1.5">
            <code className="flex-1 min-w-0 truncate text-xs bg-white border border-emerald-200 rounded-md px-2 py-1.5 font-mono">{freshSecret.secret}</code>
            <button onClick={() => { navigator.clipboard?.writeText(freshSecret.secret).catch(() => {}); }} className="tp-focus-ring inline-flex items-center gap-1 px-2 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"><Copy className="w-3.5 h-3.5" aria-hidden="true" /> Copy</button>
            <button onClick={() => setFreshSecret(null)} className="tp-focus-ring px-2 py-1.5 rounded-md text-xs text-emerald-700 hover:bg-emerald-100">Done</button>
          </div>
        </div>
      )}

      <ul className="space-y-1.5 mb-3">
        {subs.map((sub) => (
          <li key={sub.id} className="border border-slate-100 rounded-lg px-2.5 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <code className={`truncate max-w-[260px] font-mono ${sub.isEnabled ? 'text-slate-700' : 'text-slate-300 line-through'}`}>{sub.url}</code>
              <span className="flex flex-wrap gap-1">
                {(sub.events || []).map((e) => <span key={e} className="px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 text-[10px] font-mono">{e}</span>)}
              </span>
              <span className="ml-auto text-slate-400">
                {sub.failureCount > 0 ? `${sub.failureCount} fails · ` : ''}
                {sub.lastDeliveryAt ? `last ${fmtDate(sub.lastDeliveryAt)}` : 'never delivered'}
              </span>
              <button onClick={() => setOpenLog(openLog === sub.id ? null : sub.id)} className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50">Log</button>
              <button onClick={() => ping(sub.id)} className="tp-focus-ring inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"><Send className="w-3 h-3" aria-hidden="true" /> Test</button>
              <button onClick={() => act(() => ticketsAPI.updateWebhook(sub.id, { isEnabled: !sub.isEnabled }))} className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50">{sub.isEnabled ? 'Disable' : 'Enable'}</button>
              <button onClick={() => act(() => ticketsAPI.deleteWebhook(sub.id))} aria-label={`Delete webhook ${sub.url}`} className="tp-focus-ring p-1 rounded text-slate-300 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" aria-hidden="true" /></button>
            </div>
            {testResult?.id === sub.id && (
              <p className={`mt-1 text-[11px] ${testResult.pending ? 'text-slate-400' : testResult.ok ? 'text-emerald-600' : 'text-red-600'}`}>
                {testResult.pending ? 'Pinging…' : testResult.ok ? 'Test delivery accepted (2xx).' : `Test failed: ${testResult.error || testResult.lastError || 'no 2xx response'}`}
              </p>
            )}
            {sub.lastError && !sub.isEnabled && <p className="mt-1 text-[11px] text-amber-600">Auto-disabled — last error: {sub.lastError}</p>}
            {openLog === sub.id && <DeliveryLog subId={sub.id} />}
          </li>
        ))}
        {subs.length === 0 && <li className="text-xs text-slate-400 italic">No webhooks yet.</li>}
      </ul>

      {error && <p className="text-xs text-red-500 mb-1.5">{error}</p>}
      {draft ? (
        <div className="rounded-lg border border-slate-200 p-3 space-y-2 text-xs">
          <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://example.com/hooks/ticket-pulse" aria-label="Webhook URL" className="tp-focus-ring w-full border border-slate-200 rounded-md px-2 py-1.5 font-mono" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
            {WEBHOOK_EVENTS.map(([event, label]) => (
              <label key={event} className="flex items-center gap-1.5 text-slate-600">
                <input type="checkbox" checked={draft.events.includes(event)} onChange={() => setDraft({ ...draft, events: draft.events.includes(event) ? draft.events.filter((e) => e !== event) : [...draft.events, event] })} className="tp-focus-ring rounded border-slate-300 text-blue-600" />
                <code className="font-mono text-[10px] text-violet-700">{event}</code><span className="text-slate-400">{label}</span>
              </label>
            ))}
          </div>
          <div className="flex gap-1.5">
            <button onClick={create} disabled={busy || !draft.url.trim() || draft.events.length === 0} className="tp-focus-ring px-2.5 py-1 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60">{busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : 'Create webhook'}</button>
            <button onClick={() => setDraft(null)} className="tp-focus-ring px-2.5 py-1 rounded-md text-slate-500 hover:bg-slate-50">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setDraft({ url: '', events: ['ticket.created'] })} className="tp-focus-ring inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"><Plus className="w-3.5 h-3.5" aria-hidden="true" /> New webhook</button>
      )}
    </section>
  );
}

function OAuthClientsSection() {
  const [clients, setClients] = useState([]);
  const [draft, setDraft] = useState(null); // { name, scopes, expiresInDays }
  const [fresh, setFresh] = useState(null); // { clientId, clientSecret } — shown once
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => { ticketsAPI.listOauthClients().then((r) => setClients(r.data || [])).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setBusy(true); setError(null);
    try { const r = await ticketsAPI.createOauthClient(draft); setFresh({ name: r.data.name, clientId: r.data.clientId, clientSecret: r.data.clientSecret }); setDraft(null); load(); }
    catch (e) { setError(e.response?.data?.detail || e.response?.data?.message || e.message); }
    setBusy(false);
  };
  const rotate = async (c) => { setError(null); try { const r = await ticketsAPI.rotateOauthClient(c.id); setFresh({ name: `${r.data.name} (rotated)`, clientId: r.data.clientId, clientSecret: r.data.clientSecret }); load(); } catch (e) { setError(e.response?.data?.detail || e.message); } };
  const act = async (fn) => { setError(null); try { await fn(); load(); } catch (e) { setError(e.response?.data?.detail || e.response?.data?.message || e.message); } };

  return (
    <section className="tp-card rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <Lock className="w-4 h-4 text-blue-500" aria-hidden="true" />
        <h3 className="text-sm font-bold text-slate-800">OAuth clients</h3>
      </div>
      <p className="text-xs text-slate-400 mb-3">
        For app-to-app integrations. Exchange a client at <code className="bg-slate-100 rounded px-1">POST /api/v1/oauth/token</code> (grant <code className="bg-slate-100 rounded px-1">client_credentials</code>)
        for a short-lived bearer token scoped to this workspace. The API accepts these tokens anywhere an API key works.
      </p>

      {fresh && (
        <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-1.5">
          <p className="text-xs font-semibold text-emerald-800">“{fresh.name}” — copy the secret now, it is shown only once:</p>
          <div className="text-[11px] text-slate-600">Client ID</div>
          <code className="block truncate text-xs bg-white border border-emerald-200 rounded-md px-2 py-1.5 font-mono">{fresh.clientId}</code>
          <div className="text-[11px] text-slate-600">Client secret</div>
          <div className="flex items-center gap-1.5">
            <code className="flex-1 min-w-0 truncate text-xs bg-white border border-emerald-200 rounded-md px-2 py-1.5 font-mono">{fresh.clientSecret}</code>
            <button onClick={() => { navigator.clipboard?.writeText(fresh.clientSecret).catch(() => {}); }} className="tp-focus-ring inline-flex items-center gap-1 px-2 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"><Copy className="w-3.5 h-3.5" aria-hidden="true" /> Copy</button>
            <button onClick={() => setFresh(null)} className="tp-focus-ring px-2 py-1.5 rounded-md text-xs text-emerald-700 hover:bg-emerald-100">Done</button>
          </div>
        </div>
      )}

      <ul className="space-y-1.5 mb-3">
        {clients.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2 text-xs border border-slate-100 rounded-lg px-2.5 py-2">
            <span className={`font-semibold ${c.isEnabled && !c.revokedAt ? 'text-slate-700' : 'text-slate-300 line-through'}`}>{c.name}</span>
            <code className="text-[10px] bg-slate-100 rounded px-1 text-slate-500 font-mono">{c.clientId}</code>
            <span className="flex flex-wrap gap-1">
              {(c.scopes || []).slice(0, 5).map((s) => <span key={s} className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] font-mono">{s}</span>)}
              {(c.scopes || []).length > 5 && <span className="text-[10px] text-slate-400">+{c.scopes.length - 5}</span>}
            </span>
            <span className="ml-auto text-slate-400 tabular-nums">{c.tokenCount || 0} tokens{c.lastUsedAt ? ` · last ${new Date(c.lastUsedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}</span>
            <button onClick={() => rotate(c)} title="Rotate secret" className="tp-focus-ring inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"><RefreshCw className="w-3 h-3" aria-hidden="true" /> Rotate</button>
            <button onClick={() => act(() => ticketsAPI.updateOauthClient(c.id, { isEnabled: !c.isEnabled }))} className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50">{c.isEnabled ? 'Disable' : 'Enable'}</button>
            <button onClick={() => act(() => ticketsAPI.deleteOauthClient(c.id))} aria-label={`Delete client ${c.name}`} className="tp-focus-ring p-1 rounded text-slate-300 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" aria-hidden="true" /></button>
          </li>
        ))}
        {clients.length === 0 && <li className="text-xs text-slate-400 italic">No OAuth clients yet.</li>}
      </ul>

      {error && <p className="text-xs text-red-500 mb-1.5">{error}</p>}
      {draft ? (
        <div className="rounded-lg border border-slate-200 p-3 space-y-2.5 text-xs">
          <div className="flex flex-wrap gap-2">
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Client name (e.g. Provisioning daemon)" aria-label="Client name" className="tp-focus-ring min-w-[200px] flex-1 border border-slate-200 rounded-md px-2 py-1.5" />
            <select value={draft.expiresInDays} onChange={(e) => setDraft({ ...draft, expiresInDays: e.target.value })} aria-label="Expiry" className="tp-focus-ring border border-slate-200 rounded-md px-2 py-1.5 text-slate-600">
              {EXPIRY_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            {SCOPE_GROUPS.map(([group, scopes]) => (
              <div key={group}>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-0.5">{group}</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  {scopes.map(([scope, label]) => (
                    <label key={scope} className="flex items-center gap-1.5 text-slate-600">
                      <input type="checkbox" checked={draft.scopes.includes(scope)} onChange={() => setDraft({ ...draft, scopes: draft.scopes.includes(scope) ? draft.scopes.filter((s) => s !== scope) : [...draft.scopes, scope] })} className="tp-focus-ring rounded border-slate-300 text-blue-600" />
                      <code className="font-mono text-[10px] text-blue-700">{scope}</code><span className="text-slate-400">{label}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-1.5">
            <button onClick={create} disabled={busy || draft.name.trim().length < 3 || draft.scopes.length === 0} className="tp-focus-ring px-2.5 py-1 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60">{busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : 'Create client'}</button>
            <button onClick={() => setDraft(null)} className="tp-focus-ring px-2.5 py-1 rounded-md text-slate-500 hover:bg-slate-50">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setDraft({ name: '', scopes: ['tickets:read'], expiresInDays: '' })} className="tp-focus-ring inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"><Plus className="w-3.5 h-3.5" aria-hidden="true" /> New OAuth client</button>
      )}
    </section>
  );
}

export default function ApiKeysPanel() {
  const [keys, setKeys] = useState([]);
  const [draft, setDraft] = useState(null); // { name, scopes, mode, expiresInDays }
  const [freshKey, setFreshKey] = useState(null); // { name, apiKey } — shown once
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => { ticketsAPI.listApiKeys().then((res) => setKeys(res.data || [])).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const res = await ticketsAPI.createApiKey(draft);
      setFreshKey({ name: res.data.name, apiKey: res.data.apiKey });
      setDraft(null); load();
    } catch (e) { setError(e.response?.data?.detail || e.response?.data?.message || e.message); }
    setBusy(false);
  };
  const rotate = async (k) => {
    setError(null);
    try { const res = await ticketsAPI.rotateApiKey(k.id); setFreshKey({ name: `${res.data.name} (rotated)`, apiKey: res.data.apiKey }); load(); } catch (e) { setError(e.response?.data?.detail || e.message); }
  };
  const copyKey = async () => {
    try { await navigator.clipboard.writeText(freshKey.apiKey); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* manual selection still works */ }
  };
  const act = async (fn) => { setError(null); try { await fn(); load(); } catch (e) { setError(e.response?.data?.detail || e.response?.data?.message || e.message); } };

  return (
    <div className="space-y-4 animate-fadeIn">
      <section className="tp-card rounded-xl p-4">
        <div className="flex items-center gap-2 mb-1">
          <KeyRound className="w-4 h-4 text-blue-500" aria-hidden="true" />
          <h3 className="text-sm font-bold text-slate-800">Integration API keys</h3>
        </div>
        <p className="text-xs text-slate-400 mb-3">
          Keys authenticate the public <code className="bg-slate-100 rounded px-1">/api/v1</code> API (Bearer <code className="bg-slate-100 rounded px-1">tp_live_…</code> / <code className="bg-slate-100 rounded px-1">tp_test_…</code>), scoped to this workspace.
          {' '}Full reference: <a href="/api/v1/docs" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">/api/v1/docs</a>.
        </p>

        {freshKey && (
          <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
            <p className="text-xs font-semibold text-emerald-800 mb-1.5">“{freshKey.name}” — copy the key now, it is shown only once:</p>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 min-w-0 truncate text-xs bg-white border border-emerald-200 rounded-md px-2 py-1.5 font-mono">{freshKey.apiKey}</code>
              <button onClick={copyKey} className="tp-focus-ring inline-flex items-center gap-1 px-2 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700">{copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}{copied ? 'Copied' : 'Copy'}</button>
              <button onClick={() => setFreshKey(null)} className="tp-focus-ring px-2 py-1.5 rounded-md text-xs text-emerald-700 hover:bg-emerald-100">Done</button>
            </div>
          </div>
        )}

        <ul className="space-y-1.5 mb-3">
          {keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-2 text-xs border border-slate-100 rounded-lg px-2.5 py-2">
              <span className={`font-semibold ${k.isEnabled && !k.revokedAt ? 'text-slate-700' : 'text-slate-300 line-through'}`}>{k.name}</span>
              {k.mode === 'test' && <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 text-[10px] font-bold uppercase">Test</span>}
              <code className="text-[10px] bg-slate-100 rounded px-1 text-slate-500 font-mono">{k.prefix}…</code>
              <span className="flex flex-wrap gap-1">
                {(k.scopes || []).slice(0, 6).map((s) => <span key={s} className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] font-mono">{s}</span>)}
                {(k.scopes || []).length > 6 && <span className="text-[10px] text-slate-400">+{k.scopes.length - 6}</span>}
              </span>
              <span className="ml-auto text-slate-400 tabular-nums">
                {k.requestCount || 0} calls{k.lastUsedAt ? ` · last ${new Date(k.lastUsedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ' · never used'}
                {k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}
              </span>
              <button onClick={() => rotate(k)} title="Rotate secret" className="tp-focus-ring inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"><RefreshCw className="w-3 h-3" aria-hidden="true" /> Rotate</button>
              <button onClick={() => act(() => ticketsAPI.updateApiKey(k.id, { isEnabled: !k.isEnabled }))} className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50">{k.isEnabled ? 'Disable' : 'Enable'}</button>
              <button onClick={() => act(() => ticketsAPI.deleteApiKey(k.id))} aria-label={`Revoke key ${k.name}`} className="tp-focus-ring p-1 rounded text-slate-300 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" aria-hidden="true" /></button>
            </li>
          ))}
          {keys.length === 0 && <li className="text-xs text-slate-400 italic">No API keys yet.</li>}
        </ul>

        {error && <p className="text-xs text-red-500 mb-1.5">{error}</p>}
        {draft ? (
          <div className="rounded-lg border border-slate-200 p-3 space-y-2.5 text-xs">
            <div className="flex flex-wrap gap-2">
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Key name (e.g. NinjaRMM integration)" aria-label="Key name" className="tp-focus-ring min-w-[200px] flex-1 border border-slate-200 rounded-md px-2 py-1.5" />
              <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value })} aria-label="Mode" className="tp-focus-ring border border-slate-200 rounded-md px-2 py-1.5 text-slate-600">
                <option value="live">Live</option>
                <option value="test">Test</option>
              </select>
              <select value={draft.expiresInDays} onChange={(e) => setDraft({ ...draft, expiresInDays: e.target.value })} aria-label="Expiry" className="tp-focus-ring border border-slate-200 rounded-md px-2 py-1.5 text-slate-600">
                {EXPIRY_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              {SCOPE_GROUPS.map(([group, scopes]) => (
                <div key={group}>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-0.5">{group}</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                    {scopes.map(([scope, label]) => (
                      <label key={scope} className="flex items-center gap-1.5 text-slate-600">
                        <input type="checkbox" checked={draft.scopes.includes(scope)} onChange={() => setDraft({ ...draft, scopes: draft.scopes.includes(scope) ? draft.scopes.filter((s) => s !== scope) : [...draft.scopes, scope] })} className="tp-focus-ring rounded border-slate-300 text-blue-600" />
                        <code className="font-mono text-[10px] text-blue-700">{scope}</code><span className="text-slate-400">{label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-1.5">
              <button onClick={create} disabled={busy || draft.name.trim().length < 3 || draft.scopes.length === 0} className="tp-focus-ring px-2.5 py-1 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60">{busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : 'Create key'}</button>
              <button onClick={() => setDraft(null)} className="tp-focus-ring px-2.5 py-1 rounded-md text-slate-500 hover:bg-slate-50">Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setDraft({ name: '', scopes: ['tickets:read'], mode: 'live', expiresInDays: '' })} className="tp-focus-ring inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"><Plus className="w-3.5 h-3.5" aria-hidden="true" /> New API key</button>
        )}
      </section>

      <OAuthClientsSection />
      <WebhooksSection />
    </div>
  );
}
