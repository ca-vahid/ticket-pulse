import { useEffect, useMemo, useState } from 'react';
import { Bell, CheckCircle2, Loader2, Mail, MessageCircle, MessageSquare, Phone, ShieldCheck } from 'lucide-react';
import { agentAPI } from '../../services/api';

const THRESHOLDS = [
  { value: 'high_urgent', label: 'High and Urgent' },
  { value: 'urgent_only', label: 'Urgent only' },
  { value: 'disabled', label: 'Disabled' },
];

function channelLabel(channel) {
  if (channel === 'sms') return 'SMS';
  if (channel === 'whatsapp') return 'WhatsApp';
  if (channel === 'phone_call') return 'Phone call';
  return 'Email';
}

const PHONE_CHANNELS = new Set(['sms', 'whatsapp', 'phone_call']);

function providerNote(providerStatus, channel) {
  const status = providerStatus?.[channel];
  if (!status) return null;
  return status.configured ? 'Configured' : `${status.provider} not configured`;
}

function providerConfigured(providerStatus, channel) {
  return !!providerStatus?.[channel]?.configured;
}

export default function NotificationSettingsPanel({ workspaceId }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [form, setForm] = useState({
    threshold: 'high_urgent',
    channels: { email: false, sms: false, whatsapp: false, phone_call: false },
    phoneOverride: '',
  });
  const [verificationCode, setVerificationCode] = useState('');
  const [devCode, setDevCode] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await agentAPI.getNotificationPreferences(workspaceId ? { workspaceId } : {});
      const payload = res.data;
      setData(payload);
      setForm({
        threshold: payload.preferences?.threshold || 'high_urgent',
        channels: {
          email: !!payload.preferences?.channels?.email,
          sms: !!payload.preferences?.channels?.sms,
          whatsapp: !!payload.preferences?.channels?.whatsapp,
          phone_call: !!payload.preferences?.channels?.phone_call,
        },
        phoneOverride: payload.preferences?.phoneOverride || '',
      });
    } catch (err) {
      setError(err.message || 'Could not load notification preferences');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const effectivePhone = useMemo(() => (
    form.phoneOverride || data?.preferences?.entraMobilePhone || data?.preferences?.entraPhone || ''
  ), [data?.preferences?.entraMobilePhone, data?.preferences?.entraPhone, form.phoneOverride]);

  const phoneVerified = !!data?.preferences?.phoneVerified
    && (!form.phoneOverride || form.phoneOverride === data?.preferences?.phoneOverride);

  const canEnablePhoneChannels = phoneVerified && !!effectivePhone;

  const setChannel = (channel, enabled) => {
    setForm((prev) => ({
      ...prev,
      channels: { ...prev.channels, [channel]: enabled },
    }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await agentAPI.saveNotificationPreferences({
        workspaceId,
        threshold: form.threshold,
        channels: form.channels,
        phoneOverride: form.phoneOverride,
      });
      setData((prev) => ({ ...prev, preferences: res.data }));
      setMessage('Saved');
    } catch (err) {
      setError(err.message || 'Could not save notification preferences');
    } finally {
      setSaving(false);
    }
  };

  const requestVerification = async () => {
    setVerifying(true);
    setError(null);
    setMessage(null);
    try {
      await agentAPI.saveNotificationPreferences({
        workspaceId,
        threshold: form.threshold,
        channels: { ...form.channels, sms: false, whatsapp: false, phone_call: false },
        phoneOverride: form.phoneOverride,
      });
      const res = await agentAPI.requestPhoneVerification({ workspaceId });
      setDevCode(res.devCode || '');
      setMessage(res.sent ? 'Verification code sent' : 'Dev verification code generated');
      await load();
    } catch (err) {
      setError(err.message || 'Could not start phone verification');
    } finally {
      setVerifying(false);
    }
  };

  const confirmVerification = async () => {
    setVerifying(true);
    setError(null);
    setMessage(null);
    try {
      const res = await agentAPI.confirmPhoneVerification({ workspaceId, code: verificationCode });
      setData((prev) => ({ ...prev, preferences: res.data }));
      setVerificationCode('');
      setDevCode('');
      setMessage('Phone verified');
    } catch (err) {
      setError(err.message || 'Could not verify phone');
    } finally {
      setVerifying(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[35vh] items-center justify-center rounded-lg border border-slate-200 bg-white">
        <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-blue-600" />
          <h2 className="text-sm font-semibold text-slate-900">Notifications</h2>
          {message && <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">{message}</span>}
        </div>
        {error && <p className="mt-2 text-sm font-medium text-red-600">{error}</p>}
      </div>

      <div className="grid gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">Priority threshold</label>
            <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">
              {THRESHOLDS.map((threshold) => (
                <button
                  key={threshold.value}
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, threshold: threshold.value }))}
                  className={`rounded-md px-3 py-1.5 text-sm font-semibold transition ${
                    form.threshold === threshold.value ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {threshold.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">Channels</label>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { id: 'email', icon: Mail },
                { id: 'sms', icon: MessageSquare },
                { id: 'whatsapp', icon: MessageCircle },
                { id: 'phone_call', icon: Phone },
              ].map(({ id, icon: Icon }) => {
                const providerReady = providerConfigured(data?.preferences?.providerStatus, id);
                const disabled = !providerReady || (PHONE_CHANNELS.has(id) && !canEnablePhoneChannels);
                return (
                  <label
                    key={id}
                    className={`flex min-h-[86px] cursor-pointer flex-col gap-2 rounded-lg border p-3 transition ${
                      form.channels[id] ? 'border-blue-300 bg-blue-50' : 'border-slate-200 bg-white hover:bg-slate-50'
                    } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-800">
                        <Icon className="h-4 w-4" />
                        {channelLabel(id)}
                      </span>
                      <input
                        type="checkbox"
                        checked={!!form.channels[id]}
                        disabled={disabled}
                        onChange={(event) => setChannel(id, event.target.checked)}
                        className="h-4 w-4 rounded border-slate-300 text-blue-600"
                      />
                    </span>
                    <span className="text-xs text-slate-500">
                      {providerNote(data?.preferences?.providerStatus, id)}
                      {providerReady && PHONE_CHANNELS.has(id) && !canEnablePhoneChannels ? ' · verify phone first' : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        <aside className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-slate-900">Phone</div>
            <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold ${
              phoneVerified ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
            }`}>
              {phoneVerified ? <CheckCircle2 className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              {phoneVerified ? 'Verified' : 'Unverified'}
            </span>
          </div>
          <div className="text-xs text-slate-500">
            Entra: {data?.preferences?.entraMobilePhone || data?.preferences?.entraPhone || 'None'}
          </div>
          <input
            type="tel"
            value={form.phoneOverride}
            onChange={(event) => setForm((prev) => ({ ...prev, phoneOverride: event.target.value }))}
            placeholder="Override phone"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400"
          />
          <div className="text-xs text-slate-500">Effective: {effectivePhone || 'None'}</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={requestVerification}
              disabled={verifying || !effectivePhone}
              className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Send code
            </button>
          </div>
          {devCode && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
              Dev code: {devCode}
            </div>
          )}
          {(devCode || !phoneVerified) && (
            <div className="flex gap-2">
              <input
                value={verificationCode}
                onChange={(event) => setVerificationCode(event.target.value)}
                placeholder="Code"
                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400"
              />
              <button
                type="button"
                onClick={confirmVerification}
                disabled={verifying || verificationCode.trim().length < 4}
                className="inline-flex h-9 items-center justify-center rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Confirm
              </button>
            </div>
          )}
        </aside>
      </div>

      <div className="flex justify-end border-t border-slate-200 px-4 py-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-wait disabled:opacity-60"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </button>
      </div>
    </section>
  );
}
