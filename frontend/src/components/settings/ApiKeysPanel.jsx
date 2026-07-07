import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { ticketsAPI } from '../../services/api';

// Keep in sync with backend API_KEY_SCOPES (apiV1.routes.js).
const SCOPES = [
  ['tickets:read', 'Read tickets (list / detail / thread)'],
  ['tickets:write', 'Create tickets + public replies'],
  ['tickets:notes', 'Add internal notes'],
  ['tickets:attachments', 'List / download attachments'],
  ['approvals:read', 'Read approvals'],
  ['approvals:write', 'Request approvals'],
  ['tags:read', 'Read the tag palette'],
  ['tags:write', 'Set ticket tags'],
];

/**
 * Admin management for the /api/v1 integration keys (gap plan P3.1): create
 * with an explicit scope set (the raw key shows exactly ONCE), enable/disable,
 * revoke, last-used + request-count visibility. Docs live at /api/v1/docs.
 */

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

function WebhooksSection() {
  const [subs, setSubs] = useState([]);
  const [draft, setDraft] = useState(null); // { url, events: [] }
  const [freshSecret, setFreshSecret] = useState(null); // shown once
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [testResult, setTestResult] = useState(null); // { id, ok, error }

  const load = useCallback(() => {
    ticketsAPI.listWebhooks().then((res) => setSubs(res.data || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const res = await ticketsAPI.createWebhook(draft);
      setFreshSecret({ url: res.data.url, secret: res.data.secret });
      setDraft(null);
      load();
    } catch (e) { setError(e.response?.data?.message || e.message); }
    setBusy(false);
  };

  const act = async (fn) => {
    setError(null);
    try { await fn(); load(); } catch (e) { setError(e.response?.data?.message || e.message); }
  };

  const ping = async (id) => {
    setTestResult({ id, pending: true });
    try {
      const res = await ticketsAPI.testWebhook(id);
      setTestResult({ id, ...res.data });
    } catch (e) { setTestResult({ id, ok: false, error: e.message }); }
    load();
  };

  return (
    <section className="tp-card rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <Webhook className="w-4 h-4 text-blue-500" aria-hidden="true" />
        <h3 className="text-sm font-bold text-slate-800">Outbound webhooks</h3>
      </div>
      <p className="text-xs text-slate-400 mb-3">
        Signed JSON POSTs on ticket events. Verify each delivery with the <code className="bg-slate-100 rounded px-1">X-TicketPulse-Signature</code> header
        (HMAC-SHA256 of the raw body with your signing secret). Retries 3x then counts a failure; 20 consecutive failures auto-disable the hook.
      </p>

      {freshSecret && (
        <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-xs font-semibold text-emerald-800 mb-1.5">Webhook created — copy the signing secret now, it is shown only once:</p>
          <div className="flex items-center gap-1.5">
            <code className="flex-1 min-w-0 truncate text-xs bg-white border border-emerald-200 rounded-md px-2 py-1.5 font-mono">{freshSecret.secret}</code>
            <button
              onClick={() => { navigator.clipboard?.writeText(freshSecret.secret).catch(() => {}); }}
              className="tp-focus-ring inline-flex items-center gap-1 px-2 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
            >
              <Copy className="w-3.5 h-3.5" aria-hidden="true" /> Copy
            </button>
            <button onClick={() => setFreshSecret(null)} className="tp-focus-ring px-2 py-1.5 rounded-md text-xs text-emerald-700 hover:bg-emerald-100">Done</button>
          </div>
        </div>
      )}

      <ul className="space-y-1.5 mb-3">
        {subs.map((sub) => (
          <li key={sub.id} className="border border-slate-100 rounded-lg px-2.5 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <code className={`truncate max-w-[280px] font-mono ${sub.isEnabled ? 'text-slate-700' : 'text-slate-300 line-through'}`}>{sub.url}</code>
              <span className="flex flex-wrap gap-1">
                {(sub.events || []).map((e) => <span key={e} className="px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 text-[10px] font-mono">{e}</span>)}
              </span>
              <span className="ml-auto text-slate-400">
                {sub.failureCount > 0 ? `${sub.failureCount} fails - ` : ''}
                {sub.lastDeliveryAt ? `last ${new Date(sub.lastDeliveryAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'never delivered'}
              </span>
              <button onClick={() => ping(sub.id)} className="tp-focus-ring inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50">
                <Send className="w-3 h-3" aria-hidden="true" /> Test
              </button>
              <button
                onClick={() => act(() => ticketsAPI.updateWebhook(sub.id, { isEnabled: !sub.isEnabled }))}
                className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
              >
                {sub.isEnabled ? 'Disable' : 'Enable'}
              </button>
              <button
                onClick={() => act(() => ticketsAPI.deleteWebhook(sub.id))}
                aria-label={`Delete webhook ${sub.url}`}
                className="tp-focus-ring p-1 rounded text-slate-300 hover:text-red-500"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
            {testResult?.id === sub.id && (
              <p className={`mt-1 text-[11px] ${testResult.pending ? 'text-slate-400' : testResult.ok ? 'text-emerald-600' : 'text-red-600'}`}>
                {testResult.pending ? 'Pinging…' : testResult.ok ? 'Test delivery accepted (2xx).' : `Test failed: ${testResult.error || testResult.lastError || 'no 2xx response'}`}
              </p>
            )}
            {sub.lastError && !sub.isEnabled && (
              <p className="mt-1 text-[11px] text-amber-600">Auto-disabled — last error: {sub.lastError}</p>
            )}
          </li>
        ))}
        {subs.length === 0 && <li className="text-xs text-slate-400 italic">No webhooks yet.</li>}
      </ul>

      {error && <p className="text-xs text-red-500 mb-1.5">{error}</p>}
      {draft ? (
        <div className="rounded-lg border border-slate-200 p-3 space-y-2 text-xs">
          <input
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            placeholder="https://example.com/hooks/ticket-pulse"
            aria-label="Webhook URL"
            className="tp-focus-ring w-full border border-slate-200 rounded-md px-2 py-1.5 font-mono"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
            {WEBHOOK_EVENTS.map(([event, label]) => (
              <label key={event} className="flex items-center gap-1.5 text-slate-600">
                <input
                  type="checkbox"
                  checked={draft.events.includes(event)}
                  onChange={() => setDraft({
                    ...draft,
                    events: draft.events.includes(event) ? draft.events.filter((e) => e !== event) : [...draft.events, event],
                  })}
                  className="tp-focus-ring rounded border-slate-300 text-blue-600"
                />
                <code className="font-mono text-[10px] text-violet-700">{event}</code>
                <span className="text-slate-400">{label}</span>
              </label>
            ))}
          </div>
          <div className="flex gap-1.5">
            <button onClick={create} disabled={busy || !draft.url.trim() || draft.events.length === 0} className="tp-focus-ring px-2.5 py-1 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60">
              {busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : 'Create webhook'}
            </button>
            <button onClick={() => setDraft(null)} className="tp-focus-ring px-2.5 py-1 rounded-md text-slate-500 hover:bg-slate-50">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setDraft({ url: '', events: ['ticket.created'] })} className="tp-focus-ring inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
          <Plus className="w-3.5 h-3.5" aria-hidden="true" /> New webhook
        </button>
      )}
    </section>
  );
}

export default function ApiKeysPanel() {
  const [keys, setKeys] = useState([]);
  const [draft, setDraft] = useState(null); // { name, scopes: [] }
  const [freshKey, setFreshKey] = useState(null); // { name, apiKey } — shown once
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    ticketsAPI.listApiKeys().then((res) => setKeys(res.data || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const res = await ticketsAPI.createApiKey(draft);
      setFreshKey({ name: res.data.name, apiKey: res.data.apiKey });
      setDraft(null);
      load();
    } catch (e) { setError(e.response?.data?.message || e.message); }
    setBusy(false);
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(freshKey.apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* manual selection still works */ }
  };

  const act = async (fn) => {
    setError(null);
    try { await fn(); load(); } catch (e) { setError(e.response?.data?.message || e.message); }
  };

  return (
    <div className="space-y-4 animate-fadeIn">
      <section className="tp-card rounded-xl p-4">
        <div className="flex items-center gap-2 mb-1">
          <KeyRound className="w-4 h-4 text-blue-500" aria-hidden="true" />
          <h3 className="text-sm font-bold text-slate-800">Integration API keys</h3>
        </div>
        <p className="text-xs text-slate-400 mb-3">
          Keys authenticate the public <code className="bg-slate-100 rounded px-1">/api/v1</code> API (Bearer <code className="bg-slate-100 rounded px-1">tpk_…</code>), scoped to this workspace.
          {' '}Endpoint reference: <a href="/api/v1/docs" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">/api/v1/docs</a>.
        </p>

        {freshKey && (
          <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
            <p className="text-xs font-semibold text-emerald-800 mb-1.5">“{freshKey.name}” created — copy the key now, it is shown only once:</p>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 min-w-0 truncate text-xs bg-white border border-emerald-200 rounded-md px-2 py-1.5 font-mono">{freshKey.apiKey}</code>
              <button onClick={copyKey} className="tp-focus-ring inline-flex items-center gap-1 px-2 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700">
                {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button onClick={() => setFreshKey(null)} className="tp-focus-ring px-2 py-1.5 rounded-md text-xs text-emerald-700 hover:bg-emerald-100">Done</button>
            </div>
          </div>
        )}

        <ul className="space-y-1.5 mb-3">
          {keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-2 text-xs border border-slate-100 rounded-lg px-2.5 py-2">
              <span className={`font-semibold ${k.isEnabled ? 'text-slate-700' : 'text-slate-300 line-through'}`}>{k.name}</span>
              <code className="text-[10px] bg-slate-100 rounded px-1 text-slate-500 font-mono">{k.keyPrefix}…</code>
              <span className="flex flex-wrap gap-1">
                {(k.scopes || []).map((s) => (
                  <span key={s} className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] font-mono">{s}</span>
                ))}
              </span>
              <span className="ml-auto text-slate-400 tabular-nums">
                {k.requestCount || 0} calls{k.lastUsedAt ? ` · last ${new Date(k.lastUsedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ' · never used'}
              </span>
              <button
                onClick={() => act(() => ticketsAPI.updateApiKey(k.id, { isEnabled: !k.isEnabled }))}
                className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
              >
                {k.isEnabled ? 'Disable' : 'Enable'}
              </button>
              <button
                onClick={() => act(() => ticketsAPI.deleteApiKey(k.id))}
                aria-label={`Revoke key ${k.name}`}
                className="tp-focus-ring p-1 rounded text-slate-300 hover:text-red-500"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
          {keys.length === 0 && <li className="text-xs text-slate-400 italic">No API keys yet.</li>}
        </ul>

        {error && <p className="text-xs text-red-500 mb-1.5">{error}</p>}
        {draft ? (
          <div className="rounded-lg border border-slate-200 p-3 space-y-2 text-xs">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Key name (e.g. NinjaRMM integration)"
              aria-label="Key name"
              className="tp-focus-ring w-full border border-slate-200 rounded-md px-2 py-1.5"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {SCOPES.map(([scope, label]) => (
                <label key={scope} className="flex items-center gap-1.5 text-slate-600">
                  <input
                    type="checkbox"
                    checked={draft.scopes.includes(scope)}
                    onChange={() => setDraft({
                      ...draft,
                      scopes: draft.scopes.includes(scope) ? draft.scopes.filter((s) => s !== scope) : [...draft.scopes, scope],
                    })}
                    className="tp-focus-ring rounded border-slate-300 text-blue-600"
                  />
                  <code className="font-mono text-[10px] text-blue-700">{scope}</code>
                  <span className="text-slate-400">{label}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-1.5">
              <button onClick={create} disabled={busy || draft.name.trim().length < 3 || draft.scopes.length === 0} className="tp-focus-ring px-2.5 py-1 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60">
                {busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : 'Create key'}
              </button>
              <button onClick={() => setDraft(null)} className="tp-focus-ring px-2.5 py-1 rounded-md text-slate-500 hover:bg-slate-50">Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setDraft({ name: '', scopes: ['tickets:read'] })} className="tp-focus-ring inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
            <Plus className="w-3.5 h-3.5" aria-hidden="true" /> New API key
          </button>
        )}
      </section>

      <WebhooksSection />
    </div>
  );
}
