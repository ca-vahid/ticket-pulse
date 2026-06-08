import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Save,
  SendHorizonal,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { settingsAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { Button } from '../ui';
import { SettingsHero } from './SettingsLayoutPrimitives';

const FACE_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981'];
const MAX_LOGO_BYTES = 512 * 1024;

const DEFAULTS = {
  enabled: true,
  headline: 'How did we do?',
  subtext: 'Your feedback helps our team keep improving. It only takes a moment.',
  thankYouMessage: 'Thanks for letting us know — we really appreciate it.',
  commentEnabled: true,
  commentPrompt: "Anything you'd like to add? (optional)",
  label1: 'Bad',
  label2: 'Meh',
  label3: 'Okay',
  label4: 'Good',
  label5: 'Great',
  brandName: '',
  logoDataUrl: '',
  logoAltText: '',
  trademarkText: '',
  accentColor: '#2563eb',
};

function mergeSettings(data = {}) {
  const merged = {};
  for (const key of Object.keys(DEFAULTS)) {
    merged[key] = data[key] ?? DEFAULTS[key];
  }
  return merged;
}

function Toggle({ label, description, checked, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex w-full items-start justify-between gap-4 rounded-lg border p-4 text-left transition ${
        checked ? 'border-blue-200 bg-blue-50/60' : 'border-slate-200 bg-white hover:bg-slate-50'
      }`}
    >
      <span>
        <span className="block text-sm font-semibold text-slate-900">{label}</span>
        {description && <span className="mt-1 block text-sm text-slate-500">{description}</span>}
      </span>
      <span className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-blue-600' : 'bg-slate-300'}`}>
        <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${checked ? 'left-6' : 'left-1'}`} />
      </span>
    </button>
  );
}

function Field({ label, value, onChange, placeholder, maxLength }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase text-slate-500">{label}</span>
      <input
        type="text"
        value={value ?? ''}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-200"
      />
    </label>
  );
}

function AreaField({ label, value, onChange, placeholder, maxLength }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase text-slate-500">{label}</span>
      <textarea
        value={value ?? ''}
        rows={2}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-200"
      />
    </label>
  );
}

function Status({ status }) {
  if (!status) return null;
  const ok = status.type === 'success';
  return (
    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${
      ok ? 'border border-emerald-200 bg-emerald-50 text-emerald-800' : 'border border-red-200 bg-red-50 text-red-800'
    }`}>
      {ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
      {status.message}
    </div>
  );
}

/** A faithful-but-static preview of the live /feedback page so admins see their edits. */
function FeedbackPreview({ settings }) {
  const accent = settings.accentColor || '#2563eb';
  const labels = [settings.label1, settings.label2, settings.label3, settings.label4, settings.label5];
  return (
    <div
      className="rounded-2xl border border-slate-200 p-5 shadow-sm"
      style={{ background: `radial-gradient(600px 280px at 50% -20%, ${accent}22, transparent 60%), #ffffff` }}
    >
      <div className="mx-auto max-w-xs rounded-2xl border border-slate-200 bg-white/90 p-5 text-center shadow">
        {settings.logoDataUrl ? (
          <img src={settings.logoDataUrl} alt="" className="mx-auto mb-2 h-9 max-w-[140px] object-contain" />
        ) : (
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: accent }}>
            {settings.brandName || 'Ticket Pulse'}
          </div>
        )}
        <div className="text-[11px] font-medium text-slate-400">Ticket #12345 · VPN access problem</div>
        <h3 className="mt-1 text-lg font-bold text-slate-900">{settings.headline || 'How did we do?'}</h3>
        {settings.subtext && <p className="mt-1 text-xs leading-5 text-slate-500">{settings.subtext}</p>}
        <div className="mx-auto mt-3 flex h-16 w-16 items-center justify-center rounded-full" style={{ background: FACE_COLORS[4] }}>
          <span className="text-2xl">🙂</span>
        </div>
        <div className="mt-3 flex items-start justify-between gap-1">
          {labels.map((label, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1">
              <span className="h-7 w-7 rounded-full border-2" style={{ borderColor: FACE_COLORS[i], background: i === 4 ? FACE_COLORS[i] : '#fff' }} />
              <span className="text-[9px] font-semibold leading-tight text-slate-500">{label}</span>
            </div>
          ))}
        </div>
        {settings.commentEnabled && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 text-left text-[11px] text-slate-400">
            {settings.commentPrompt || "Anything you'd like to add? (optional)"}
          </div>
        )}
        <div className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-bold text-white" style={{ background: accent }}>
          <SendHorizonal className="h-4 w-4" /> Send feedback
        </div>
        {settings.trademarkText && <div className="mt-3 text-[9px] text-slate-400">{settings.trademarkText}</div>}
      </div>
    </div>
  );
}

export default function FeedbackPagePanel() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id || null;
  const [settings, setSettings] = useState(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  const workspaceRequestConfig = useMemo(() => (
    workspaceId ? { headers: { 'X-Workspace-Id': String(workspaceId) } } : {}
  ), [workspaceId]);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setLoading(false);
      setStatus({ type: 'error', message: 'Select a workspace before editing the feedback page' });
      return;
    }
    setLoading(true);
    setStatus(null);
    try {
      const response = await settingsAPI.getFeedbackSettings(workspaceRequestConfig);
      setSettings(mergeSettings(response.data || {}));
    } catch (error) {
      setStatus({ type: 'error', message: error.message || 'Failed to load feedback settings' });
    } finally {
      setLoading(false);
    }
  }, [workspaceId, workspaceRequestConfig]);

  useEffect(() => {
    load();
  }, [load]);

  const update = (patch) => setSettings((current) => ({ ...current, ...patch }));

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const response = await settingsAPI.updateFeedbackSettings(settings, workspaceRequestConfig);
      setSettings(mergeSettings(response.data || {}));
      setStatus({ type: 'success', message: 'Feedback page settings saved' });
    } catch (error) {
      setStatus({ type: 'error', message: error.message || 'Failed to save settings' });
    } finally {
      setSaving(false);
    }
  };

  const uploadLogo = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(file.type)) {
      setStatus({ type: 'error', message: 'Logo must be a PNG, JPG, WEBP, or GIF image' });
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setStatus({ type: 'error', message: 'Logo must be 512 KB or smaller' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      update({
        logoDataUrl: String(reader.result || ''),
        logoAltText: settings.logoAltText || file.name.replace(/\.[^.]+$/, ''),
      });
      setStatus({ type: 'success', message: 'Logo ready — click Save to apply.' });
    };
    reader.onerror = () => setStatus({ type: 'error', message: 'Could not read that logo file' });
    reader.readAsDataURL(file);
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="tp-glass flex items-center gap-3 rounded-2xl border border-white/70 p-5 text-slate-600">
          <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
          Loading feedback page settings
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <SettingsHero
        eyebrow="Requester-facing pages"
        title="Feedback Page"
        description={(
          <>
            The first-party satisfaction page requesters land on from mail workflow links like{' '}
            <code className="rounded bg-slate-100 px-1.5 py-0.5">{'{{ ticket.feedbackUrl }}'}</code>.
            Customize the wording and branding below; it shares the per-ticket link with the public status page.
          </>
        )}
      />

      <Status status={status} />

      <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="space-y-4">
          <Toggle
            label="Collect feedback"
            description="When off, the feedback page shows a friendly closed message and submissions are rejected."
            checked={settings.enabled}
            onChange={(v) => update({ enabled: v })}
          />

          <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-sm font-semibold text-slate-900">Wording</div>
            <Field label="Headline" value={settings.headline} maxLength={160} onChange={(v) => update({ headline: v })} placeholder="How did we do?" />
            <AreaField label="Subtext" value={settings.subtext} maxLength={400} onChange={(v) => update({ subtext: v })} placeholder="Short intro line under the headline" />
            <Field label="Thank-you message" value={settings.thankYouMessage} maxLength={400} onChange={(v) => update({ thankYouMessage: v })} placeholder="Shown after they submit" />
          </div>

          <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-sm font-semibold text-slate-900">Rating labels</div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[1, 2, 3, 4, 5].map((n) => (
                <label key={n} className="block">
                  <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                    <span className="h-3 w-3 rounded-full" style={{ background: FACE_COLORS[n - 1] }} /> {n}
                  </span>
                  <input
                    type="text"
                    value={settings[`label${n}`] ?? ''}
                    maxLength={40}
                    onChange={(e) => update({ [`label${n}`]: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-200"
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
            <Toggle
              label="Comment box"
              description="Let requesters add an optional free-text comment."
              checked={settings.commentEnabled}
              onChange={(v) => update({ commentEnabled: v })}
            />
            {settings.commentEnabled && (
              <Field label="Comment prompt" value={settings.commentPrompt} maxLength={200} onChange={(v) => update({ commentPrompt: v })} placeholder="Anything you'd like to add? (optional)" />
            )}
          </div>

          <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-sm font-semibold text-slate-900">Branding</div>
            <Field label="Brand name" value={settings.brandName} maxLength={120} onChange={(v) => update({ brandName: v })} placeholder="Shown when no logo is set" />
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <span className="text-xs font-semibold uppercase text-slate-500">Accent color</span>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="color"
                    value={settings.accentColor || '#2563eb'}
                    onChange={(e) => update({ accentColor: e.target.value })}
                    className="h-9 w-12 cursor-pointer rounded border border-slate-200 bg-white"
                  />
                  <input
                    type="text"
                    value={settings.accentColor || ''}
                    onChange={(e) => update({ accentColor: e.target.value })}
                    className="w-28 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-200"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                  {settings.logoDataUrl ? <ImageIcon className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
                  {settings.logoDataUrl ? 'Replace logo' : 'Upload logo'}
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={uploadLogo} />
                </label>
                {settings.logoDataUrl && (
                  <button
                    type="button"
                    onClick={() => update({ logoDataUrl: '' })}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4" /> Remove
                  </button>
                )}
              </div>
            </div>
            <Field label="Footer / trademark text" value={settings.trademarkText} maxLength={300} onChange={(v) => update({ trademarkText: v })} placeholder="© Your Company. All rights reserved." />
          </div>

          <div className="flex items-center gap-3">
            <Button type="button" onClick={load} variant="glass">
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button type="button" onClick={save} disabled={saving} variant="default">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save changes
            </Button>
          </div>
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Live preview</div>
          <FeedbackPreview settings={settings} />
        </div>
      </div>
    </div>
  );
}
