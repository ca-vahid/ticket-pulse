import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clipboard,
  ExternalLink,
  Filter,
  Link2,
  Image as ImageIcon,
  Loader2,
  Palette,
  Search,
  RefreshCw,
  RotateCcw,
  Save,
  Shield,
  Tag,
  Ticket,
  Trash2,
  Upload,
  UserRound,
  XCircle,
} from 'lucide-react';
import { settingsAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { Button } from '../ui';
import { SettingsChip, SettingsHero } from './SettingsLayoutPrimitives';

const DEFAULTS = {
  enabled: true,
  expiryDays: 60,
  showRequesterName: false,
  showRequesterEmail: false,
  showAssignedAgent: true,
  showAssignedAgentAvatar: true,
  showSummary: true,
  showPriority: true,
  showCategory: true,
  showWorkspaceStats: true,
  etaLookbackDays: 180,
  etaMinSampleSize: 8,
  etaPercentile: 75,
  brandName: '',
  logoDataUrl: '',
  logoAltText: '',
  trademarkText: '',
  accentColor: '#2563eb',
};

const MAX_LOGO_BYTES = 512 * 1024;

function formatDate(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function classificationTone(source) {
  if (source === 'internal_taxonomy') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (source === 'ticket_pulse_fields') return 'border-blue-200 bg-blue-50 text-blue-800';
  return 'border-amber-200 bg-amber-50 text-amber-800';
}

function classificationLabel(source) {
  if (source === 'internal_taxonomy') return 'Internal taxonomy';
  if (source === 'ticket_pulse_fields') return 'Ticket Pulse fields';
  return 'Not classified';
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

function NumberField({ label, value, onChange, min, max, suffix }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase text-slate-500">{label}</span>
      <div className="mt-1 flex rounded-lg border border-slate-200 bg-white">
        <input
          type="number"
          min={min}
          max={max}
          value={value ?? ''}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border-0 px-3 py-2 text-sm font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-blue-200"
        />
        {suffix && <span className="flex items-center px-3 text-sm text-slate-500">{suffix}</span>}
      </div>
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

export default function PublicTicketStatusPanel() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id || null;
  const [settings, setSettings] = useState(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [ticketNumber, setTicketNumber] = useState('');
  const [linkAction, setLinkAction] = useState(null);
  const [lastLink, setLastLink] = useState(null);
  const [ticketSearch, setTicketSearch] = useState('');
  const [ticketClassification, setTicketClassification] = useState('all');
  const [ticketPage, setTicketPage] = useState(1);
  const [ticketRows, setTicketRows] = useState([]);
  const [ticketTotal, setTicketTotal] = useState(0);
  const [ticketTotalPages, setTicketTotalPages] = useState(1);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [ticketActionId, setTicketActionId] = useState(null);
  const [ticketWorkspace, setTicketWorkspace] = useState(null);
  const [selectedTicketId, setSelectedTicketId] = useState(null);

  const expiryMode = settings.expiryDays === null ? 'never' : 'days';
  const workspaceLabel = ticketWorkspace?.name || currentWorkspace?.name || 'selected workspace';
  const workspaceRequestConfig = useMemo(() => (
    workspaceId
      ? { headers: { 'X-Workspace-Id': String(workspaceId) } }
      : {}
  ), [workspaceId]);
  const effectiveSummary = useMemo(() => {
    if (settings.expiryDays === null) return 'Public links do not expire until an admin resets or revokes them.';
    return `Public links expire ${settings.expiryDays} days after the link is created or reset.`;
  }, [settings.expiryDays]);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setLoading(false);
      setStatus({ type: 'error', message: 'Select a workspace before editing public ticket status settings' });
      return;
    }
    setLoading(true);
    setStatus(null);
    try {
      const response = await settingsAPI.getPublicTicketStatusSettings(workspaceRequestConfig);
      setSettings({ ...DEFAULTS, ...(response.data || {}) });
    } catch (error) {
      setStatus({ type: 'error', message: error.message || 'Failed to load public status settings' });
    } finally {
      setLoading(false);
    }
  }, [workspaceId, workspaceRequestConfig]);

  const loadTickets = useCallback(async ({ page = 1 } = {}) => {
    if (!workspaceId) {
      setTicketRows([]);
      setTicketTotal(0);
      setTicketTotalPages(1);
      setTicketPage(1);
      setTicketWorkspace(null);
      return;
    }
    setTicketsLoading(true);
    try {
      const response = await settingsAPI.getPublicTicketStatusTickets({
        search: ticketSearch,
        classification: ticketClassification,
        page,
        pageSize: 8,
      }, workspaceRequestConfig);
      const payload = response.data || {};
      setTicketRows(payload.tickets || []);
      setTicketTotal(payload.total || 0);
      setTicketTotalPages(payload.totalPages || 1);
      setTicketPage(payload.page || page);
      setTicketWorkspace(payload.workspace || null);
      setSelectedTicketId(current => (
        payload.tickets?.some(ticket => ticket.id === current) ? current : null
      ));
    } catch (error) {
      setStatus({ type: 'error', message: error.message || 'Failed to load public ticket links' });
    } finally {
      setTicketsLoading(false);
    }
  }, [ticketClassification, ticketSearch, workspaceId, workspaceRequestConfig]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const timer = setTimeout(() => {
      loadTickets({ page: 1 });
    }, 250);
    return () => clearTimeout(timer);
  }, [loadTickets]);

  const update = (patch) => {
    setSettings(current => ({ ...current, ...patch }));
  };

  const buildPayload = (source) => ({
    ...source,
    expiryDays: source.expiryDays === null ? null : Number(source.expiryDays),
    etaLookbackDays: Number(source.etaLookbackDays),
    etaMinSampleSize: Number(source.etaMinSampleSize),
    etaPercentile: Number(source.etaPercentile),
  });

  const persistSettings = async (nextSettings, successMessage) => {
    setSaving(true);
    setStatus(null);
    try {
      const payload = buildPayload(nextSettings);
      const response = await settingsAPI.updatePublicTicketStatusSettings(payload, workspaceRequestConfig);
      setSettings({ ...DEFAULTS, ...(response.data || {}) });
      setStatus({ type: 'success', message: successMessage });
      return true;
    } catch (error) {
      setStatus({ type: 'error', message: error.message || 'Failed to save settings' });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    await persistSettings(settings, 'Public ticket status settings saved');
  };

  const copy = async (value) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setStatus({ type: 'success', message: 'Copied public link' });
    } catch {
      setStatus({ type: 'error', message: 'Clipboard copy failed' });
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
    reader.onload = async () => {
      const nextSettings = {
        ...settings,
        logoDataUrl: String(reader.result || ''),
        logoAltText: settings.logoAltText || file.name.replace(/\.[^.]+$/, ''),
      };
      setSettings(nextSettings);
      await persistSettings(nextSettings, 'Logo uploaded and saved. Refresh the public ticket page to see it.');
    };
    reader.onerror = () => {
      setStatus({ type: 'error', message: 'Could not read that logo file' });
    };
    reader.readAsDataURL(file);
  };

  const resetLink = async () => {
    const trimmed = ticketNumber.trim();
    if (!trimmed) {
      setStatus({ type: 'error', message: 'Enter a FreshService ticket number first' });
      return;
    }
    setLinkAction('reset');
    setStatus(null);
    try {
      const response = await settingsAPI.resetPublicTicketStatusLinkByNumber(trimmed, workspaceRequestConfig);
      setLastLink(response.data);
      setStatus({ type: 'success', message: `Reset public link for ticket #${trimmed}` });
      await refreshTicketRows();
    } catch (error) {
      setStatus({ type: 'error', message: error.message || 'Failed to reset link' });
    } finally {
      setLinkAction(null);
    }
  };

  const revokeLink = async () => {
    const trimmed = ticketNumber.trim();
    if (!trimmed) {
      setStatus({ type: 'error', message: 'Enter a FreshService ticket number first' });
      return;
    }
    setLinkAction('revoke');
    setStatus(null);
    try {
      await settingsAPI.revokePublicTicketStatusLinkByNumber(trimmed, workspaceRequestConfig);
      setLastLink(null);
      setStatus({ type: 'success', message: `Revoked public link for ticket #${trimmed}` });
      await refreshTicketRows();
    } catch (error) {
      setStatus({ type: 'error', message: error.message || 'Failed to revoke link' });
    } finally {
      setLinkAction(null);
    }
  };

  const refreshTicketRows = async () => {
    await loadTickets({ page: ticketPage });
  };

  const getTicketLink = async (ticket) => {
    setTicketActionId(`get-${ticket.id}`);
    setStatus(null);
    try {
      const response = await settingsAPI.ensurePublicTicketStatusLink(ticket.id, workspaceRequestConfig);
      const url = response.data?.url || null;
      setStatus({ type: 'success', message: `Public link ready and copied for ticket #${ticket.freshserviceTicketId}` });
      if (url) {
        await navigator.clipboard.writeText(url).catch(() => {});
      }
      await refreshTicketRows();
      return url;
    } catch (error) {
      setStatus({ type: 'error', message: error.message || 'Failed to get public link' });
      return null;
    } finally {
      setTicketActionId(null);
    }
  };

  const resetTicketLink = async (ticket) => {
    setTicketActionId(`reset-${ticket.id}`);
    setStatus(null);
    try {
      const response = await settingsAPI.resetPublicTicketStatusLink(ticket.id, workspaceRequestConfig);
      setStatus({ type: 'success', message: `Reset public link for ticket #${ticket.freshserviceTicketId}` });
      if (response.data?.url) {
        await navigator.clipboard.writeText(response.data.url).catch(() => {});
      }
      await refreshTicketRows();
    } catch (error) {
      setStatus({ type: 'error', message: error.message || 'Failed to reset public link' });
    } finally {
      setTicketActionId(null);
    }
  };

  const revokeTicketLink = async (ticket) => {
    setTicketActionId(`revoke-${ticket.id}`);
    setStatus(null);
    try {
      await settingsAPI.revokePublicTicketStatusLink(ticket.id, workspaceRequestConfig);
      setStatus({ type: 'success', message: `Revoked public link for ticket #${ticket.freshserviceTicketId}` });
      await refreshTicketRows();
    } catch (error) {
      setStatus({ type: 'error', message: error.message || 'Failed to revoke public link' });
    } finally {
      setTicketActionId(null);
    }
  };

  const copyTicketLink = async (ticket) => {
    const url = ticket.publicLink?.url || await getTicketLink(ticket);
    if (!url) return;
    await copy(url);
  };

  const openTicketLink = async (ticket) => {
    const url = ticket.publicLink?.url || await getTicketLink(ticket);
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="tp-glass flex items-center gap-3 rounded-2xl border border-white/70 p-5 text-slate-600">
          <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
          Loading public ticket status settings
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <SettingsHero
        eyebrow="Requester-facing pages"
        title="Public Ticket Status"
        description={(
          <>
            Requester-facing ticket pages used by mail workflow links like{' '}
            <code className="rounded bg-slate-100 px-1.5 py-0.5">{'{{ ticket.publicStatusUrl }}'}</code>.
          </>
        )}
        icon={ExternalLink}
        tone="blue"
        meta={(
          <SettingsChip variant="outline">
            <Shield className="h-3.5 w-3.5" />
            Editing workspace: {workspaceLabel}
          </SettingsChip>
        )}
        actions={(
          <>
            <Button
              type="button"
              onClick={load}
              variant="glass"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button
              type="button"
              onClick={save}
              disabled={saving}
              variant="default"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </Button>
          </>
        )}
      />

      <Status status={status} />

      <div className="grid gap-5 xl:grid-cols-[1fr_0.9fr]">
        <section className="space-y-5">
          <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="text-sm font-semibold uppercase text-slate-500">Availability and Expiry</h3>
            <div className="mt-4 space-y-4">
              <Toggle
                label="Enable public ticket status pages"
                description="When disabled, existing public links stop resolving and workflow link variables render blank."
                checked={settings.enabled}
                onChange={(value) => update({ enabled: value })}
              />
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="inline-flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <input
                      type="radio"
                      checked={expiryMode === 'days'}
                      onChange={() => update({ expiryDays: settings.expiryDays || 60 })}
                    />
                    Expire after
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="3650"
                    value={settings.expiryDays ?? 60}
                    disabled={expiryMode === 'never'}
                    onChange={(event) => update({ expiryDays: event.target.value })}
                    className="h-10 w-28 rounded-lg border border-slate-200 px-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-slate-100 disabled:text-slate-400"
                  />
                  <span className="text-sm text-slate-600">days</span>
                  <label className="inline-flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <input
                      type="radio"
                      checked={expiryMode === 'never'}
                      onChange={() => update({ expiryDays: null })}
                    />
                    Never expire
                  </label>
                </div>
                <p className="mt-3 text-sm text-slate-500">{effectiveSummary}</p>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <ImageIcon className="h-5 w-5 text-cyan-600" />
              <h3 className="text-sm font-semibold uppercase text-slate-500">Public Page Branding</h3>
            </div>
            <p className="mt-2 text-sm text-slate-500">
              Customize the requester-facing status page for {workspaceLabel}. Logos are workspace-specific and stored as small image data URLs.
            </p>
            <div className="mt-4 grid gap-4 lg:grid-cols-[220px_1fr]">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="flex h-28 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white">
                  {settings.logoDataUrl ? (
                    <img src={settings.logoDataUrl} alt={settings.logoAltText || 'Logo preview'} className="max-h-24 max-w-full object-contain p-2" />
                  ) : (
                    <div className="text-center text-sm text-slate-500">
                      <ImageIcon className="mx-auto mb-2 h-6 w-6" />
                      No logo
                    </div>
                  )}
                </div>
                <label className="mt-3 inline-flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-slate-950 px-3 text-sm font-semibold text-white hover:bg-slate-800">
                  <Upload className="h-4 w-4" />
                  Upload logo
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={uploadLogo} className="hidden" />
                </label>
                {settings.logoDataUrl && (
                  <button
                    type="button"
                    onClick={() => update({ logoDataUrl: '', logoAltText: '' })}
                    className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 text-sm font-semibold text-red-700 hover:bg-red-100"
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove logo
                  </button>
                )}
              </div>
              <div className="grid gap-3">
                <label className="block">
                  <span className="text-xs font-semibold uppercase text-slate-500">Brand name</span>
                  <input
                    type="text"
                    value={settings.brandName || ''}
                    onChange={(event) => update({ brandName: event.target.value })}
                    placeholder="Defaults to workspace name"
                    className="mt-1 h-10 w-full rounded-lg border border-slate-200 px-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-blue-200"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase text-slate-500">Logo alt text</span>
                  <input
                    type="text"
                    value={settings.logoAltText || ''}
                    onChange={(event) => update({ logoAltText: event.target.value })}
                    placeholder="Accessible logo label"
                    className="mt-1 h-10 w-full rounded-lg border border-slate-200 px-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-blue-200"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase text-slate-500">Footer / trademark text</span>
                  <textarea
                    value={settings.trademarkText || ''}
                    onChange={(event) => update({ trademarkText: event.target.value })}
                    rows={3}
                    placeholder="Example: BGC Engineering service status. All rights reserved."
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold outline-none focus:ring-2 focus:ring-blue-200"
                  />
                </label>
                <label className="block">
                  <span className="flex items-center gap-2 text-xs font-semibold uppercase text-slate-500">
                    <Palette className="h-4 w-4" />
                    Accent color
                  </span>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      type="color"
                      value={settings.accentColor || '#2563eb'}
                      onChange={(event) => update({ accentColor: event.target.value })}
                      className="h-10 w-14 rounded-lg border border-slate-200 bg-white p-1"
                    />
                    <input
                      type="text"
                      value={settings.accentColor || '#2563eb'}
                      onChange={(event) => update({ accentColor: event.target.value })}
                      className="h-10 flex-1 rounded-lg border border-slate-200 px-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-blue-200"
                    />
                  </div>
                </label>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="text-sm font-semibold uppercase text-slate-500">Privacy and Page Content</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Toggle label="Show assigned agent" checked={settings.showAssignedAgent} onChange={(value) => update({ showAssignedAgent: value })} />
              <Toggle
                label="Show assigned agent avatar"
                description="Displays the synced technician profile photo beside the assignee name when available."
                checked={settings.showAssignedAgentAvatar}
                onChange={(value) => update({ showAssignedAgentAvatar: value })}
              />
              <Toggle label="Show ticket summary" checked={settings.showSummary} onChange={(value) => update({ showSummary: value })} />
              <Toggle label="Show priority" checked={settings.showPriority} onChange={(value) => update({ showPriority: value })} />
              <Toggle label="Show category details" checked={settings.showCategory} onChange={(value) => update({ showCategory: value })} />
              <Toggle label="Show workspace stats" checked={settings.showWorkspaceStats} onChange={(value) => update({ showWorkspaceStats: value })} />
              <Toggle label="Show requester name" checked={settings.showRequesterName} onChange={(value) => update({ showRequesterName: value })} />
              <Toggle label="Show requester email" checked={settings.showRequesterEmail} onChange={(value) => update({ showRequesterEmail: value })} />
            </div>
          </div>
        </section>

        <aside className="space-y-5">
          <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-emerald-600" />
              <h3 className="text-sm font-semibold uppercase text-slate-500">Historical ETA Model</h3>
            </div>
            <p className="mt-2 text-sm text-slate-500">
              Ticket Pulse estimates resolution using recent non-noise resolved tickets. It tries exact category/subcategory and priority first, then relaxes to category, priority, and workspace-wide history.
            </p>
            <div className="mt-4 grid gap-3">
              <NumberField label="Lookback" value={settings.etaLookbackDays} min={30} max={1095} suffix="days" onChange={(value) => update({ etaLookbackDays: value })} />
              <NumberField label="Minimum sample size" value={settings.etaMinSampleSize} min={3} max={100} suffix="tickets" onChange={(value) => update({ etaMinSampleSize: value })} />
              <label className="block">
                <span className="text-xs font-semibold uppercase text-slate-500">Percentile</span>
                <select
                  value={settings.etaPercentile}
                  onChange={(event) => update({ etaPercentile: event.target.value })}
                  className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-blue-200"
                >
                  <option value={50}>P50 - typical</option>
                  <option value={75}>P75 - conservative default</option>
                  <option value={90}>P90 - high confidence window</option>
                </select>
              </label>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <Ticket className="h-5 w-5 text-blue-600" />
                <div>
                  <h3 className="text-sm font-semibold uppercase text-slate-500">Ticket Public Links</h3>
                  <p className="mt-1 text-sm text-slate-500">
                    Search one workspace at a time, select a ticket, and open or copy its public page.
                  </p>
                  <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-800">
                    <Shield className="h-3.5 w-3.5" />
                    {workspaceLabel}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => loadTickets({ page: ticketPage })}
                disabled={ticketsLoading}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
              >
                {ticketsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Refresh
              </button>
            </div>

            <div className="mt-4 grid gap-2">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={ticketSearch}
                  onChange={(event) => {
                    setTicketSearch(event.target.value);
                    setTicketPage(1);
                  }}
                  placeholder="Search ticket #, subject, requester, agent, or status"
                  className="h-10 w-full rounded-lg border border-slate-200 pl-9 pr-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-blue-200"
                />
              </label>
              <label className="relative block max-w-56">
                <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <select
                  value={ticketClassification}
                  onChange={(event) => {
                    setTicketClassification(event.target.value);
                    setTicketPage(1);
                  }}
                  className="h-10 w-full appearance-none rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-blue-200"
                >
                  <option value="all">All tickets</option>
                  <option value="classified">Classified only</option>
                  <option value="unclassified">Unclassified only</option>
                </select>
              </label>
            </div>

            <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
              {ticketsLoading && ticketRows.length === 0 ? (
                <div className="flex items-center gap-3 bg-slate-50 p-4 text-slate-600">
                  <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                  Loading tickets
                </div>
              ) : ticketRows.length === 0 ? (
                <div className="bg-slate-50 p-5 text-center text-sm text-slate-500">
                  No tickets matched this search.
                </div>
              ) : (
                <div className="max-h-[430px] overflow-auto">
                  <table className="min-w-[960px] w-full text-left text-sm">
                    <thead className="sticky top-0 z-10 bg-slate-50 text-xs font-bold uppercase text-slate-500">
                      <tr>
                        <th className="px-3 py-2">Ticket</th>
                        <th className="px-3 py-2">People</th>
                        <th className="px-3 py-2">State</th>
                        <th className="px-3 py-2">Ticket Pulse</th>
                        <th className="px-3 py-2">Link</th>
                        <th className="px-3 py-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {ticketRows.map(ticket => {
                        const linkUrl = ticket.publicLink?.url || '';
                        const actionBusy = ticketActionId?.endsWith(`-${ticket.id}`);
                        const isSelected = selectedTicketId === ticket.id;
                        const categoryText = ticket.ticketPulseCategory || 'Not classified';
                        const subcategoryText = ticket.ticketPulseSubcategory || 'Not classified';
                        return (
                          <tr
                            key={ticket.id}
                            onClick={() => setSelectedTicketId(ticket.id)}
                            className={`cursor-pointer transition hover:bg-blue-50/60 ${isSelected ? 'bg-blue-50 ring-1 ring-inset ring-blue-200' : ''}`}
                          >
                            <td className="max-w-[320px] px-3 py-2">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className={`h-2.5 w-2.5 rounded-full ${isSelected ? 'bg-blue-600' : 'bg-slate-300'}`} />
                                <div className="min-w-0 truncate font-black text-slate-950" title={`Updated ${formatDate(ticket.updatedAt)}`}>
                                  #{ticket.freshserviceTicketId} {ticket.subject}
                                </div>
                              </div>
                            </td>
                            <td className="max-w-[210px] px-3 py-2">
                              <div className="flex min-w-0 items-center gap-1.5 text-xs text-slate-600">
                                <UserRound className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                                <span className="truncate">{ticket.requesterName || 'No requester'}</span>
                                <span className="text-slate-300">/</span>
                                <span className="truncate font-semibold">{ticket.assignedAgentName || 'No agent'}</span>
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex flex-nowrap gap-1.5">
                                {ticket.priority && (
                                  <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs font-bold text-slate-700">
                                    {ticket.priority}
                                  </span>
                                )}
                                {ticket.status && (
                                  <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-bold text-blue-700">
                                    {ticket.status}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="max-w-[270px] px-3 py-2">
                              <div className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-bold ${classificationTone(ticket.classificationSource)}`}>
                                <Tag className="h-3.5 w-3.5 shrink-0" />
                                <span className="truncate">{classificationLabel(ticket.classificationSource)}</span>
                                <span className="text-slate-300">|</span>
                                <span className="truncate text-slate-700">{categoryText} / {subcategoryText}</span>
                              </div>
                            </td>
                            <td className="max-w-[180px] px-3 py-2">
                              {linkUrl ? (
                                <div className="flex min-w-0 items-center gap-1.5 text-xs font-bold text-emerald-700" title={`Expires ${formatDate(ticket.publicLink.expiresAt)}`}>
                                  <Link2 className="h-3.5 w-3.5 shrink-0" />
                                  <span className="truncate">Active · {ticket.publicLink.viewCount || 0} views</span>
                                </div>
                              ) : (
                                <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-bold text-amber-800">
                                  <Link2 className="h-3.5 w-3.5" />
                                  No link
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex justify-end gap-1.5">
                                <button
                                  type="button"
                                  title={linkUrl ? 'Refresh link' : 'Get link'}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    getTicketLink(ticket);
                                  }}
                                  disabled={actionBusy}
                                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-950 text-white hover:bg-slate-800 disabled:cursor-wait disabled:opacity-60"
                                >
                                  {ticketActionId === `get-${ticket.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                                </button>
                                <button
                                  type="button"
                                  title="Open public page"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openTicketLink(ticket);
                                  }}
                                  disabled={actionBusy}
                                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-blue-200 bg-white text-blue-700 hover:bg-blue-50 disabled:cursor-wait disabled:opacity-60"
                                >
                                  <ExternalLink className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  title="Copy public link"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    copyTicketLink(ticket);
                                  }}
                                  disabled={actionBusy}
                                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
                                >
                                  <Clipboard className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  title="Reset public link"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    resetTicketLink(ticket);
                                  }}
                                  disabled={actionBusy}
                                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-amber-200 bg-white text-amber-700 hover:bg-amber-50 disabled:cursor-wait disabled:opacity-60"
                                >
                                  {ticketActionId === `reset-${ticket.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                                </button>
                                <button
                                  type="button"
                                  title="Revoke public link"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    revokeTicketLink(ticket);
                                  }}
                                  disabled={actionBusy || !ticket.publicLink}
                                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-red-200 bg-white text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  {ticketActionId === `revoke-${ticket.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
              <span>{ticketTotal} tickets</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => loadTickets({ page: Math.max(1, ticketPage - 1) })}
                  disabled={ticketPage <= 1 || ticketsLoading}
                  className="h-9 rounded-lg border border-slate-200 bg-white px-3 font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Previous
                </button>
                <span>Page {ticketPage} of {ticketTotalPages}</span>
                <button
                  type="button"
                  onClick={() => loadTickets({ page: Math.min(ticketTotalPages, ticketPage + 1) })}
                  disabled={ticketPage >= ticketTotalPages || ticketsLoading}
                  className="h-9 rounded-lg border border-slate-200 bg-white px-3 font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>

            <details className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
              <summary className="cursor-pointer text-sm font-semibold text-slate-700">Manual ticket number tools</summary>
              <p className="mt-2 text-sm text-slate-500">
                Reset creates a new public URL for one ticket number. Revoke disables the current URL.
              </p>
              <div className="mt-3 flex gap-2">
                <input
                  type="text"
                  value={ticketNumber}
                  onChange={(event) => setTicketNumber(event.target.value)}
                  placeholder="FreshService ticket #"
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold outline-none focus:ring-2 focus:ring-blue-200"
                />
                <button
                  type="button"
                  onClick={resetLink}
                  disabled={!!linkAction}
                  className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-950 px-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-wait disabled:opacity-60"
                >
                  {linkAction === 'reset' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                  Reset
                </button>
              </div>
              <button
                type="button"
                onClick={revokeLink}
                disabled={!!linkAction}
                className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:cursor-wait disabled:opacity-60"
              >
                {linkAction === 'revoke' ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                Revoke current link
              </button>
              {lastLink?.url && (
                <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3">
                  <div className="break-all text-sm font-semibold text-blue-950">{lastLink.url}</div>
                  <button
                    type="button"
                    onClick={() => copy(lastLink.url)}
                    className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg border border-blue-200 bg-white px-3 text-sm font-semibold text-blue-700 hover:bg-blue-50"
                  >
                    <Clipboard className="h-4 w-4" />
                    Copy link
                  </button>
                </div>
              )}
            </details>
          </div>
        </aside>
      </div>
    </div>
  );
}
