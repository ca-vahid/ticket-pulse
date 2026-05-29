import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { assignmentAPI } from '../../services/api';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';

export default function FreshServiceWebhookCard({ workspaceTimezone = 'America/Los_Angeles' }) {
  const [config, setConfig] = useState(null);
  const [secret, setSecret] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [copied, setCopied] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await assignmentAPI.getWebhookConfig();
      setConfig(res?.data || null);
    } catch {
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const copyText = async (kind, text) => {
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return;
    await navigator.clipboard.writeText(text);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1800);
  };

  const updateEnabled = async (enabled) => {
    try {
      setSaving(true);
      setTestResult(null);
      const res = await assignmentAPI.updateWebhookConfig({ enabled });
      setConfig(res?.data || null);
      setSecret(res?.data?.secret || null);
    } finally {
      setSaving(false);
    }
  };

  const rotate = async () => {
    try {
      setSaving(true);
      setTestResult(null);
      const res = await assignmentAPI.rotateWebhookSecret();
      setConfig(res?.data || null);
      setSecret(res?.data?.secret || null);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    try {
      setSaving(true);
      const res = await assignmentAPI.testWebhookConfig();
      setTestResult(res?.data || { ok: false, issues: ['unknown'] });
    } catch {
      setTestResult({ ok: false, issues: ['request_failed'] });
    } finally {
      setSaving(false);
    }
  };

  const timestamp = (value) => value ? formatDateTimeInTimezone(value, workspaceTimezone) : 'Never';

  if (loading) {
    return (
      <div className="py-3">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading webhook configuration
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="py-3">
        <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
          Webhook configuration is unavailable.
        </div>
      </div>
    );
  }

  const enabled = Boolean(config.enabled);
  const statusClass = enabled ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500';
  const requestBody = '{"ticket_id":"{{ticket.id_numeric}}"}';
  const counters = [
    ['Received', config.receivedCount || 0, config.lastReceivedAt],
    ['Accepted', config.acceptedCount || 0, config.lastAcceptedAt],
    ['Rejected', config.rejectedCount || 0, config.lastRejectedAt],
    ['Errors', config.errorCount || 0, config.lastErrorAt],
  ];

  return (
    <div className="py-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h4 className="font-medium text-sm text-slate-800">FreshService Ticket Webhook</h4>
          <p className="text-xs text-slate-500 mt-0.5">Low-latency ticket ingest for this workspace; scheduled polling remains the safety net.</p>
        </div>
        <button onClick={() => updateEnabled(!enabled)} disabled={saving} className="flex-shrink-0">
          {enabled
            ? <ToggleRight className="w-8 h-8 text-blue-600" />
            : <ToggleLeft className="w-8 h-8 text-slate-300" />
          }
        </button>
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-semibold ${statusClass}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${enabled ? 'bg-green-500' : 'bg-slate-400'}`} />
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2 py-1 text-xs font-medium text-slate-600 border border-slate-200">
            <KeyRound className="w-3 h-3" />
            {config.hasSecret ? `Secret ends ${config.secretLast4 || 'set'}` : 'No secret'}
          </span>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">FreshService Action URL</label>
          <div className="flex gap-2">
            <input readOnly value={config.webhookUrl || ''} className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 font-mono" />
            <button type="button" onClick={() => copyText('url', config.webhookUrl)} disabled={!config.webhookUrl} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
              {copied === 'url' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              URL
            </button>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Method</label>
            <input readOnly value="POST" className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Workspace Slug</label>
            <input readOnly value={config.workspaceSlug || ''} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono text-slate-700" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Secret Header</label>
            <input readOnly value={config.headerName || 'X-Ticket-Pulse-Webhook-Secret'} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700" />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">JSON Body</label>
          <div className="flex gap-2">
            <input readOnly value={requestBody} className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono text-slate-700" />
            <button type="button" onClick={() => copyText('body', requestBody)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50">
              {copied === 'body' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              Body
            </button>
          </div>
        </div>

        {secret && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <label className="block text-xs font-semibold text-amber-800 mb-1">New Secret</label>
            <div className="flex gap-2">
              <input readOnly value={secret} className="min-w-0 flex-1 rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs font-mono text-slate-800" />
              <button type="button" onClick={() => copyText('secret', secret)} className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-white px-2.5 py-2 text-xs font-medium text-amber-700 hover:bg-amber-100">
                {copied === 'secret' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                Secret
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          {counters.map(([label, count, at]) => (
            <div key={label} className="rounded-lg border border-slate-200 bg-white px-2.5 py-2">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
              <span className="mt-0.5 block text-base font-bold text-slate-800">{count}</span>
              <span className="mt-0.5 block truncate text-[10px] text-slate-500" title={timestamp(at)}>{timestamp(at)}</span>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={rotate} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Rotate Secret
          </button>
          <button type="button" onClick={runTest} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            <ShieldCheck className="w-3.5 h-3.5" />
            Check Setup
          </button>
        </div>

        {testResult && (
          <div className={`rounded-lg border px-3 py-2 text-xs ${testResult.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
            {testResult.ok ? 'Webhook setup is ready.' : `Setup needs attention: ${(testResult.issues || []).join(', ')}`}
          </div>
        )}
      </div>
    </div>
  );
}
