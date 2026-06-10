import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Clock3,
  Mail,
  MessageCircle,
  PhoneCall,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  Smartphone,
  UserPlus,
  X,
} from 'lucide-react';
import { settingsAPI } from '../../services/api';
import { cn } from '../../lib/utils';
import { Button } from '../ui';
import { SettingsHero, StatusBanner } from './SettingsLayoutPrimitives';

const CHANNEL_META = {
  email: { label: 'Email', Icon: Mail },
  sms: { label: 'SMS', Icon: Smartphone },
  whatsapp: { label: 'WhatsApp', Icon: MessageCircle },
  phone_call: { label: 'Voice', Icon: PhoneCall },
};

const PAUSABLE_CHANNELS = ['sms', 'whatsapp', 'phone_call'];

// Raw provider readiness keys -> plain-English explanations for the warning banner.
const PROVIDER_WARNING_LABELS = {
  twilio_account_sid: 'Twilio Account SID is not configured',
  twilio_auth_token: 'Twilio auth token is not configured',
  twilio_from_number: 'Twilio phone number is not configured',
  twilio_whatsapp_sender_or_messaging_service_sid: 'WhatsApp sender / messaging service is not configured',
  twilio_whatsapp_content_sid: 'an approved WhatsApp template (Twilio Content SID) has not been added',
  sendgrid_api_key: 'SendGrid API key is not configured',
  provider_not_configured: 'provider is not configured',
};

function friendlyProviderWarning(missing = []) {
  const parts = (missing || []).map((key) => PROVIDER_WARNING_LABELS[key] || key);
  return parts.join('; ');
}

const RECIPIENT_BUCKET_HELP = {
  roster: 'Escalation roster: the core after-hours list. These users are alerted for automatic after-hours urgent detections AND when a requester clicks the after-hours immediate-support button. The after-hours phone rotation is also drawn from this list.',
  self: 'Extra self-escalation recipients: alerted ONLY when a requester clicks the after-hours immediate-support button. They are added on top of the roster for those requester-initiated escalations, and are never paged by automatic detection.',
  supervisor: 'Business-hours supervisors: alerted ONLY when a requester raises a ticket to Urgent from the public ticket page during business hours. They are never paged after hours.',
};

function readinessTone(readiness) {
  if (readiness?.pausedByWorkspace) return 'border-gray-200 bg-gray-100 text-gray-400 line-through decoration-gray-400/60';
  if (readiness?.ready) return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (readiness?.enabled) return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-gray-200 bg-gray-50 text-gray-500';
}

function ChannelChip({ readiness }) {
  const meta = CHANNEL_META[readiness?.channel] || { label: readiness?.channel || 'Channel', Icon: BellRing };
  const Icon = meta.Icon;
  const tooltip = readiness?.pausedByWorkspace
    ? `${meta.label} is paused for this workspace`
    : readiness?.ready
      ? `${meta.label} ready`
      : readiness?.warnings?.join(', ') || `${meta.label} not ready`;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-semibold ${readinessTone(readiness)}`}
      title={tooltip}
    >
      <Icon className="h-3 w-3" />
      {meta.label}
    </span>
  );
}

function ToggleCard({ enabled, title, description, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={enabled === true}
      className={cn(
        'rounded-2xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
        enabled
          ? 'border-emerald-300 bg-emerald-50/90 text-slate-950 shadow-sm ring-1 ring-emerald-100'
          : 'border-slate-200 bg-white/85 text-slate-700 hover:border-slate-300 hover:bg-slate-50',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border',
            enabled ? 'border-emerald-400 bg-emerald-600 text-white' : 'border-slate-300 bg-slate-100 text-slate-400',
          )}
        >
          {enabled ? <CheckCircle2 className="h-4 w-4" /> : <span className="h-2 w-2 rounded-full bg-current" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="block text-sm font-semibold">{title}</span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500',
              )}
            >
              {enabled ? 'Enabled' : 'Off'}
            </span>
          </span>
          <span className="mt-1 block text-xs leading-5 text-gray-600">{description}</span>
        </span>
      </div>
    </button>
  );
}

function SystemDefaultCard({ title, description }) {
  return (
    <div className="rounded-2xl border border-blue-200 bg-blue-50/80 p-4 text-left shadow-sm ring-1 ring-blue-100">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-blue-300 bg-white text-blue-700">
          <CheckCircle2 className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="block text-sm font-semibold text-slate-950">{title}</span>
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-700">
              System default
            </span>
          </span>
          <span className="mt-1 block text-xs leading-5 text-slate-600">{description}</span>
        </span>
      </div>
    </div>
  );
}

function IntegratedStatusCard({ tone = 'blue', label, status, detail }) {
  const tones = {
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    gray: 'border-gray-200 bg-gray-50 text-gray-600',
  };
  return (
    <div className={`rounded-lg border px-3 py-2 ${tones[tone] || tones.blue}`}>
      <div className="text-xs font-semibold uppercase">{label}</div>
      <div className="mt-1 text-sm font-semibold text-gray-950">{status}</div>
      {detail && <div className="mt-1 text-xs leading-5 text-gray-600">{detail}</div>}
    </div>
  );
}

function CandidateRow({
  candidate,
  selectedBase,
  selectedSelfExtra,
  selectedBusinessSupervisor,
  onToggleBase,
  onToggleSelfExtra,
  onToggleBusinessSupervisor,
}) {
  const channels = Object.values(candidate.channels || {});
  return (
    <div className="grid grid-cols-[minmax(220px,1.1fr)_minmax(260px,1.2fr)_auto_auto_auto] items-center gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-blue-50 text-sm font-semibold text-blue-700">
            {candidate.photoUrl
              ? <img src={candidate.photoUrl} alt="" className="h-full w-full object-cover" />
              : (candidate.name || '?').slice(0, 1)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-gray-900">{candidate.name}</div>
            <div className="truncate text-xs text-gray-500">{candidate.email || 'No email on technician record'}</div>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {channels.map((readiness) => (
          <ChannelChip key={readiness.channel} readiness={readiness} />
        ))}
        {candidate.readyChannelCount === 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700">
            <AlertTriangle className="h-3 w-3" />
            No ready channel
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={() => onToggleBase(candidate.id)}
        title={RECIPIENT_BUCKET_HELP.roster}
        className={`rounded-lg border px-3 py-2 text-xs font-semibold transition ${
          selectedBase ? 'border-blue-300 bg-blue-600 text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-blue-300'
        }`}
      >
        {selectedBase ? 'Roster' : 'Add roster'}
      </button>
      <button
        type="button"
        onClick={() => onToggleSelfExtra(candidate.id)}
        title={RECIPIENT_BUCKET_HELP.self}
        className={`rounded-lg border px-3 py-2 text-xs font-semibold transition ${
          selectedSelfExtra ? 'border-purple-300 bg-purple-600 text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-purple-300'
        }`}
      >
        {selectedSelfExtra ? 'Self extra' : 'Add self'}
      </button>
      <button
        type="button"
        onClick={() => onToggleBusinessSupervisor(candidate.id)}
        title={RECIPIENT_BUCKET_HELP.supervisor}
        className={`rounded-lg border px-3 py-2 text-xs font-semibold transition ${
          selectedBusinessSupervisor ? 'border-orange-300 bg-orange-600 text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-orange-300'
        }`}
      >
        {selectedBusinessSupervisor ? 'Supervisor' : 'Add supervisor'}
      </button>
    </div>
  );
}

const DEFAULT_RESPONSE_COPY = {
  businessHours: 'Simply press the button to send an urgent message to the IT department. A representative will respond promptly, or as soon as possible.',
  afterHours: 'In the event of an emergency outside of business hours, an urgent message will be sent to our dedicated after-hours phone, and you should expect a response within two hours during our after-hours operation.',
  lateNight: "If your message is received during late night hours, we'll make every effort to get back to you as soon as possible, but it might take longer than two hours.",
};

const DEFAULT_RESPONSE_TABLE = {
  rows: [
    { label: 'Monday to Friday', businessHours: '5am - 5pm PT', afterHours: '5pm - 10pm PT', lateNight: 'After 10pm PT' },
    { label: 'Weekends', businessHours: 'N/A', afterHours: '10am - 5pm PT', lateNight: 'After 5pm PT' },
    { label: 'Holidays', businessHours: 'N/A', afterHours: '10am - 5pm PT', lateNight: 'After 5pm PT' },
  ],
};

function unwrapApiData(response) {
  return response?.data?.data ?? response?.data ?? response ?? {};
}

export default function UrgentEscalationPanel() {
  const [policy, setPolicy] = useState(null);
  const [draft, setDraft] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [providerStatus, setProviderStatus] = useState({});
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  const load = async () => {
    setLoading(true);
    setStatus(null);
    try {
      const [policyResponse, candidatesResponse] = await Promise.all([
        settingsAPI.getUrgentEscalationPolicy(),
        settingsAPI.getUrgentEscalationCandidates(),
      ]);
      const nextPolicy = unwrapApiData(policyResponse);
      const nextCandidates = unwrapApiData(candidatesResponse);
      setPolicy(nextPolicy);
      setDraft({
        automaticEnabled: nextPolicy.automaticEnabled === true,
        selfServiceEnabled: nextPolicy.selfServiceEnabled === true,
        businessUrgencyEnabled: nextPolicy.businessUrgencyEnabled !== false,
        businessUrgencyNotifySupervisors: nextPolicy.businessUrgencyNotifySupervisors === true,
        cooldownMinutes: nextPolicy.cooldownMinutes || 60,
        confirmationTitle: nextPolicy.confirmationTitle || 'Request urgent after-hours assistance',
        confirmationBody: nextPolicy.confirmationBody || '',
        afterHoursResponseCopy: nextPolicy.afterHoursResponseCopy || DEFAULT_RESPONSE_COPY,
        afterHoursResponseTable: nextPolicy.afterHoursResponseTable || DEFAULT_RESPONSE_TABLE,
        afterHoursContactMode: nextPolicy.afterHoursContactMode || 'manual',
        afterHoursManualTechnicianId: nextPolicy.afterHoursManualTechnicianId || '',
        afterHoursRotationOrder: nextPolicy.afterHoursRotationOrder || [],
        afterHoursRotationAnchorDate: nextPolicy.afterHoursRotationAnchorDate || '',
        showAfterHoursPhoneInEmail: nextPolicy.showAfterHoursPhoneInEmail !== false,
        disabledChannels: nextPolicy.disabledChannels || [],
        baseRecipientIds: nextPolicy.baseRecipientIds || [],
        selfExtraRecipientIds: nextPolicy.selfExtraRecipientIds || [],
        businessSupervisorRecipientIds: nextPolicy.businessSupervisorRecipientIds || [],
        clearLegacy: false,
      });
      setCandidates(nextCandidates.candidates || []);
      setProviderStatus(nextCandidates.providerStatus || {});
    } catch (error) {
      setStatus({ type: 'error', message: error.response?.data?.message || error.message || 'Failed to load urgent escalation settings' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const selectedBase = useMemo(() => new Set(draft?.baseRecipientIds || []), [draft?.baseRecipientIds]);
  const selectedSelfExtra = useMemo(() => new Set(draft?.selfExtraRecipientIds || []), [draft?.selfExtraRecipientIds]);
  const selectedBusinessSupervisor = useMemo(() => new Set(draft?.businessSupervisorRecipientIds || []), [draft?.businessSupervisorRecipientIds]);

  const filteredCandidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((candidate) => {
      const channelText = Object.values(candidate.channels || {})
        .flatMap((channel) => [
          channel.label,
          channel.recipient,
          ...(channel.warnings || []),
        ]);
      return [
        candidate.name,
        candidate.email,
        ...channelText,
      ].filter(Boolean).some((value) => String(value).toLowerCase().includes(q));
    });
  }, [candidates, search]);

  const selectedBaseUsers = candidates.filter((candidate) => selectedBase.has(candidate.id));
  const selectedSelfUsers = candidates.filter((candidate) => selectedSelfExtra.has(candidate.id));
  const selectedBusinessSupervisorUsers = candidates.filter((candidate) => selectedBusinessSupervisor.has(candidate.id));
  const rotationOrderUsers = (draft?.afterHoursRotationOrder || [])
    .map((id) => candidates.find((candidate) => candidate.id === id))
    .filter(Boolean);
  const pausedChannels = useMemo(() => new Set(draft?.disabledChannels || []), [draft?.disabledChannels]);
  const providerWarnings = Object.entries(providerStatus || {})
    .filter(([channel, value]) => value?.configured !== true && !pausedChannels.has(channel))
    .map(([channel, value]) => `${CHANNEL_META[channel]?.label || channel}: ${friendlyProviderWarning(value?.missing?.length ? value.missing : ['provider_not_configured'])}`);

  const togglePausedChannel = (channel) => {
    setDraft((current) => {
      const set = new Set(current?.disabledChannels || []);
      if (set.has(channel)) set.delete(channel);
      else set.add(channel);
      return { ...(current || {}), disabledChannels: PAUSABLE_CHANNELS.filter((value) => set.has(value)) };
    });
  };

  const updateDraft = (patch) => setDraft((current) => ({ ...(current || {}), ...patch }));

  const verifiedPhoneForCandidate = (candidate) => {
    const phoneChannels = ['sms', 'whatsapp', 'phone_call'];
    for (const channel of phoneChannels) {
      const readiness = candidate?.channels?.[channel];
      if (readiness?.phoneVerified && readiness?.recipient) return readiness.recipient;
    }
    return null;
  };

  const setRosterOrder = () => {
    updateDraft({ afterHoursRotationOrder: selectedBaseUsers.map((candidate) => candidate.id) });
  };

  const moveRotationUser = (id, direction) => {
    setDraft((current) => {
      const order = [...(current?.afterHoursRotationOrder || [])];
      const index = order.indexOf(id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return current;
      [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
      return { ...(current || {}), afterHoursRotationOrder: order };
    });
  };

  const updateResponseCopy = (field, value) => {
    setDraft((current) => ({
      ...(current || {}),
      afterHoursResponseCopy: {
        ...(current?.afterHoursResponseCopy || DEFAULT_RESPONSE_COPY),
        [field]: value,
      },
    }));
  };

  const updateResponseTableRow = (index, field, value) => {
    setDraft((current) => {
      const rows = [...(current?.afterHoursResponseTable?.rows || DEFAULT_RESPONSE_TABLE.rows)];
      rows[index] = { ...(rows[index] || {}), [field]: value };
      return {
        ...(current || {}),
        afterHoursResponseTable: {
          ...(current?.afterHoursResponseTable || DEFAULT_RESPONSE_TABLE),
          rows,
        },
      };
    });
  };

  const toggleId = (field, id) => {
    setDraft((current) => {
      const set = new Set(current?.[field] || []);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      const next = { ...(current || {}), [field]: [...set] };
      if (field === 'baseRecipientIds' && !set.has(id)) {
        next.afterHoursRotationOrder = (current?.afterHoursRotationOrder || []).filter((candidateId) => candidateId !== id);
        if (Number(current?.afterHoursManualTechnicianId) === id) {
          next.afterHoursManualTechnicianId = '';
        }
      }
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const response = await settingsAPI.updateUrgentEscalationPolicy(draft);
      const nextPolicy = unwrapApiData(response);
      setPolicy(nextPolicy);
      setDraft((current) => ({
        ...(current || {}),
        clearLegacy: false,
        baseRecipientIds: nextPolicy.baseRecipientIds || [],
        selfExtraRecipientIds: nextPolicy.selfExtraRecipientIds || [],
        businessSupervisorRecipientIds: nextPolicy.businessSupervisorRecipientIds || [],
        afterHoursContactMode: nextPolicy.afterHoursContactMode || current?.afterHoursContactMode || 'manual',
        afterHoursManualTechnicianId: nextPolicy.afterHoursManualTechnicianId || current?.afterHoursManualTechnicianId || '',
        afterHoursRotationOrder: nextPolicy.afterHoursRotationOrder || current?.afterHoursRotationOrder || [],
        afterHoursRotationAnchorDate: nextPolicy.afterHoursRotationAnchorDate || current?.afterHoursRotationAnchorDate || '',
        showAfterHoursPhoneInEmail: nextPolicy.showAfterHoursPhoneInEmail !== false,
        disabledChannels: nextPolicy.disabledChannels || [],
      }));
      setStatus({ type: 'success', message: 'Urgent escalation settings saved' });
      await load();
    } catch (error) {
      setStatus({ type: 'error', message: error.response?.data?.message || error.message || 'Failed to save urgent escalation settings' });
    } finally {
      setSaving(false);
    }
  };

  if (loading && !draft) {
    return (
      <div className="p-6">
        <div className="tp-glass rounded-2xl border border-white/70 p-8 text-center text-slate-500">
          <RefreshCw className="mx-auto mb-3 h-6 w-6 animate-spin text-blue-600" />
          Loading urgent escalation settings...
        </div>
      </div>
    );
  }

  const dependencies = policy?.dependencies || {};
  const priorityRunnerTone = draft?.automaticEnabled
    ? dependencies.priorityAssessmentEnabled === false ? 'amber' : dependencies.afterHoursPriorityAssessmentEnabled ? 'emerald' : 'blue'
    : 'gray';
  const priorityRunnerStatus = draft?.automaticEnabled
    ? dependencies.priorityAssessmentEnabled === false ? 'Priority assessment off' : dependencies.afterHoursPriorityAssessmentEnabled ? 'Enabled' : 'Will enable on save'
    : 'Off';
  const priorityWritebackStatus = dependencies.priorityWritebackEnabled === false ? 'FreshService writeback off' : 'FreshService writeback on';
  const workflowRoutingTone = draft?.selfServiceEnabled
    ? dependencies.afterHoursWorkflowRoutingEnabled ? 'emerald' : 'amber'
    : 'gray';
  const workflowRoutingStatus = draft?.selfServiceEnabled
    ? dependencies.afterHoursWorkflowRoutingEnabled ? 'Enabled' : 'Mail workflow routing is off'
    : 'Off';

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <SettingsHero
        eyebrow="Workspace urgent escalation"
        title="Urgent Escalation"
        description="Configure requester urgency links, after-hours immediate support, and the workspace users who receive escalation alerts."
        icon={ShieldAlert}
        tone="red"
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
              disabled={saving || !draft}
              variant="dark"
            >
              <Save className="h-4 w-4" />
              {saving ? 'Saving...' : 'Save settings'}
            </Button>
          </>
        )}
      />

      {status && (
        <StatusBanner type={status.type === 'success' ? 'success' : 'error'}>
          {status.message}
        </StatusBanner>
      )}

      <div className="grid gap-3 lg:grid-cols-3">
        <ToggleCard
          enabled={draft?.businessUrgencyEnabled}
          title="Business-hours raise urgency"
          description="Let requesters mark the ticket Urgent during business hours without paging the after-hours roster."
          onClick={() => updateDraft({ businessUrgencyEnabled: !draft?.businessUrgencyEnabled })}
        />
        <SystemDefaultCard
          title="Assigned-agent priority alerts"
          description="When any ticket becomes High or Urgent, Ticket Pulse uses the assigned agent's notification preferences. This is handled centrally to avoid duplicate alert paths."
        />
        <ToggleCard
          enabled={draft?.businessUrgencyNotifySupervisors}
          title="Notify supervisors"
          description="Also notify the selected supervisor list when requesters raise urgency during business hours."
          onClick={() => updateDraft({ businessUrgencyNotifySupervisors: !draft?.businessUrgencyNotifySupervisors })}
        />
        <ToggleCard
          enabled={draft?.automaticEnabled}
          title="Automatic urgent detection"
          description="When an after-hours priority-only run assesses a ticket as Urgent, alert the escalation roster."
          onClick={() => updateDraft({ automaticEnabled: !draft?.automaticEnabled })}
        />
        <ToggleCard
          enabled={draft?.selfServiceEnabled}
          title="After-hours immediate support"
          description="Let the requester use a public after-hours page to request immediate support and alert the escalation roster."
          onClick={() => updateDraft({ selfServiceEnabled: !draft?.selfServiceEnabled })}
        />
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <label className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <Clock3 className="h-4 w-4 text-blue-600" />
            Repeat-click cooldown
          </label>
          <div className="mt-3 flex items-center gap-2">
            <input
              type="number"
              min="5"
              max="1440"
              value={draft?.cooldownMinutes || 60}
              onChange={(event) => updateDraft({ cooldownMinutes: event.target.value })}
              className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
            <span className="text-sm text-gray-600">minutes</span>
          </div>
          <p className="mt-2 text-xs text-gray-500">Default is 60 minutes. Repeated requester clicks within this window will not alert again.</p>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <IntegratedStatusCard
          tone={priorityRunnerTone}
          label="After-hours priority assessment"
          status={priorityRunnerStatus}
          detail="Controlled by Automatic urgent detection on this page. The global priority assessment control in Assignment Review must also be enabled."
        />
        <IntegratedStatusCard
          tone={dependencies.priorityWritebackEnabled === false ? 'amber' : 'emerald'}
          label="Priority writeback"
          status={priorityWritebackStatus}
          detail="Controlled in Assignment Review configuration. When off, urgent escalation can still notify recipients without changing FreshService native priority."
        />
        <IntegratedStatusCard
          tone={workflowRoutingTone}
          label="After-hours workflow routing"
          status={workflowRoutingStatus}
          detail="Used by Mail Workflows to choose the after-hours received workflow. The immediate-support page itself is controlled here."
        />
      </div>

      {providerWarnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
            <div>
              <div className="text-sm font-semibold text-amber-900">Provider readiness warnings</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-amber-800">
                {providerWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
              <div className="mt-2 text-xs text-amber-700">
                Provider credentials and WhatsApp templates are managed under Settings &gt; Notifications (global admin). If a channel is not used in this workspace, pause it below to silence its warnings.
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-gray-950">Escalation channels</h3>
            <p className="mt-1 text-sm text-gray-600">
              Paused channels are skipped for every escalation send and excluded from readiness warnings. Email is always on.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700"
              title="Email is the baseline escalation channel and cannot be paused."
            >
              <Mail className="h-3.5 w-3.5" />
              Email
            </span>
            {PAUSABLE_CHANNELS.map((channel) => {
              const meta = CHANNEL_META[channel];
              const Icon = meta.Icon;
              const paused = pausedChannels.has(channel);
              return (
                <button
                  key={channel}
                  type="button"
                  onClick={() => togglePausedChannel(channel)}
                  aria-pressed={!paused}
                  title={paused
                    ? `${meta.label} is paused for this workspace - click to resume (remember to save)`
                    : `${meta.label} is active - click to pause it for this workspace (remember to save)`}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                    paused
                      ? 'border-gray-200 bg-gray-100 text-gray-400 hover:border-gray-300'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-300'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {meta.label}
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase ${paused ? 'bg-gray-200 text-gray-500' : 'bg-emerald-100 text-emerald-700'}`}>
                    {paused ? 'Paused' : 'On'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-200 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-gray-950">Escalation recipients</h3>
              <p className="mt-1 text-sm text-gray-600">
                Roster users receive automatic and after-hours immediate-support alerts. Extra self-escalation users are added only for after-hours requester clicks. Supervisors are only used for business-hours urgency raises when that toggle is on.
              </p>
            </div>
            <div className="relative min-w-[280px]">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search users"
                className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </div>
          </div>
          <div className="mt-2 text-xs text-gray-500">
            Showing {filteredCandidates.length} of {candidates.length} workspace users.
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3" title={RECIPIENT_BUCKET_HELP.roster}>
              <div className="flex items-center gap-1 text-xs font-semibold uppercase text-blue-700">
                Escalation roster
                <span className="cursor-help rounded-full bg-blue-100 px-1.5 text-[10px] font-bold normal-case text-blue-600">?</span>
              </div>
              <div className="mt-0.5 text-[11px] leading-4 text-blue-700/80">Automatic after-hours alerts + requester immediate-support clicks</div>
              <div className="mt-1 text-sm font-semibold text-gray-900">{selectedBaseUsers.length} selected</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {selectedBaseUsers.length === 0 && <span className="text-xs text-blue-700">No users selected yet.</span>}
                {selectedBaseUsers.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => toggleId('baseRecipientIds', candidate.id)}
                    className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-1 text-xs font-semibold text-blue-800 ring-1 ring-blue-200"
                  >
                    {candidate.name}
                    <X className="h-3 w-3" />
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-purple-200 bg-purple-50 p-3" title={RECIPIENT_BUCKET_HELP.self}>
              <div className="flex items-center gap-1 text-xs font-semibold uppercase text-purple-700">
                Extra self-escalation recipients
                <span className="cursor-help rounded-full bg-purple-100 px-1.5 text-[10px] font-bold normal-case text-purple-600">?</span>
              </div>
              <div className="mt-0.5 text-[11px] leading-4 text-purple-700/80">Only when a requester clicks the after-hours support button</div>
              <div className="mt-1 text-sm font-semibold text-gray-900">{selectedSelfUsers.length} selected</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {selectedSelfUsers.length === 0 && <span className="text-xs text-purple-700">No extra users selected.</span>}
                {selectedSelfUsers.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => toggleId('selfExtraRecipientIds', candidate.id)}
                    className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-1 text-xs font-semibold text-purple-800 ring-1 ring-purple-200"
                  >
                    {candidate.name}
                    <X className="h-3 w-3" />
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-orange-200 bg-orange-50 p-3" title={RECIPIENT_BUCKET_HELP.supervisor}>
              <div className="flex items-center gap-1 text-xs font-semibold uppercase text-orange-700">
                Business-hours supervisors
                <span className="cursor-help rounded-full bg-orange-100 px-1.5 text-[10px] font-bold normal-case text-orange-600">?</span>
              </div>
              <div className="mt-0.5 text-[11px] leading-4 text-orange-700/80">Only for requester urgency raises during business hours</div>
              <div className="mt-1 text-sm font-semibold text-gray-900">{selectedBusinessSupervisorUsers.length} selected</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {selectedBusinessSupervisorUsers.length === 0 && <span className="text-xs text-orange-700">No supervisors selected.</span>}
                {selectedBusinessSupervisorUsers.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => toggleId('businessSupervisorRecipientIds', candidate.id)}
                    className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-1 text-xs font-semibold text-orange-800 ring-1 ring-orange-200"
                  >
                    {candidate.name}
                    <X className="h-3 w-3" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[1040px]">
            {filteredCandidates.map((candidate) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                selectedBase={selectedBase.has(candidate.id)}
                selectedSelfExtra={selectedSelfExtra.has(candidate.id)}
                selectedBusinessSupervisor={selectedBusinessSupervisor.has(candidate.id)}
                onToggleBase={(id) => toggleId('baseRecipientIds', id)}
                onToggleSelfExtra={(id) => toggleId('selfExtraRecipientIds', id)}
                onToggleBusinessSupervisor={(id) => toggleId('businessSupervisorRecipientIds', id)}
              />
            ))}
            {filteredCandidates.length === 0 && (
              <div className="p-8 text-center text-sm text-gray-500">
                <UserPlus className="mx-auto mb-2 h-5 w-5 text-gray-400" />
                {candidates.length === 0
                  ? 'No workspace users loaded. Click Refresh to try again.'
                  : 'No users match this search.'}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-gray-950">After-hours contact shown in emails</h3>
            <p className="mt-1 text-sm text-gray-600">
              The immediate-support action block uses this contact phone. Phone numbers are shown only when verified in the selected user&apos;s notification preferences.
            </p>
          </div>
          <span className="rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-semibold text-red-700">
            Requester-facing
          </span>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.55fr)]">
          <div className="space-y-3">
            <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
              {[
                ['manual', 'Manual contact'],
                ['weekly_rotation', 'Weekly rotation'],
              ].map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => updateDraft({ afterHoursContactMode: mode })}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-xs font-semibold transition',
                    draft?.afterHoursContactMode === mode
                      ? 'bg-white text-gray-950 shadow-sm ring-1 ring-gray-200'
                      : 'text-gray-500 hover:text-gray-800',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            <label className="flex items-start gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
              <input
                type="checkbox"
                checked={draft?.showAfterHoursPhoneInEmail !== false}
                onChange={(event) => updateDraft({ showAfterHoursPhoneInEmail: event.target.checked })}
                className="mt-1 h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
              />
              <span>
                <span className="block text-sm font-semibold text-gray-900">Show active phone number in requester emails</span>
                <span className="mt-0.5 block text-xs leading-5 text-gray-600">When off, the immediate-support button can still appear, but no phone number is printed in email.</span>
              </span>
            </label>

            {draft?.afterHoursContactMode === 'manual' ? (
              <div className="rounded-lg border border-gray-200 p-3">
                <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Current after-hours contact</label>
                <select
                  value={draft?.afterHoursManualTechnicianId || ''}
                  onChange={(event) => updateDraft({ afterHoursManualTechnicianId: event.target.value ? Number(event.target.value) : '' })}
                  className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                >
                  <option value="">Use first ready roster phone</option>
                  {selectedBaseUsers.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}{verifiedPhoneForCandidate(candidate) ? ` - ${verifiedPhoneForCandidate(candidate)}` : ' - no verified phone'}
                    </option>
                  ))}
                </select>
                <p className="mt-2 text-xs text-gray-500">
                  Select from the escalation roster. If the selected user has no verified phone, Ticket Pulse falls back to the first roster user with a verified phone.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-gray-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Weekly rotation order</div>
                    <p className="mt-1 text-xs text-gray-500">Rotation starts Monday at 00:00 in the workspace timezone.</p>
                  </div>
                  <button
                    type="button"
                    onClick={setRosterOrder}
                    className="rounded-md border border-gray-200 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                  >
                    Use roster order
                  </button>
                </div>
                <div className="mt-3 space-y-2">
                  {rotationOrderUsers.length === 0 && (
                    <div className="rounded-md border border-dashed border-gray-300 px-3 py-4 text-center text-xs text-gray-500">
                      Add roster users, then click Use roster order.
                    </div>
                  )}
                  {rotationOrderUsers.map((candidate, index) => (
                    <div key={candidate.id} className="flex items-center justify-between gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-gray-900">{index + 1}. {candidate.name}</div>
                        <div className="truncate text-xs text-gray-500">{verifiedPhoneForCandidate(candidate) || 'No verified phone'}</div>
                      </div>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => moveRotationUser(candidate.id, -1)}
                          disabled={index === 0}
                          className="rounded border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-600 disabled:opacity-40"
                        >
                          Up
                        </button>
                        <button
                          type="button"
                          onClick={() => moveRotationUser(candidate.id, 1)}
                          disabled={index === rotationOrderUsers.length - 1}
                          className="rounded border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-600 disabled:opacity-40"
                        >
                          Down
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <label className="mt-3 block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Rotation anchor date</span>
                  <input
                    type="date"
                    value={draft?.afterHoursRotationAnchorDate ? String(draft.afterHoursRotationAnchorDate).slice(0, 10) : ''}
                    onChange={(event) => updateDraft({ afterHoursRotationAnchorDate: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </label>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-red-700">
              <PhoneCall className="h-4 w-4" />
              Current resolved contact
            </div>
            <div className="mt-3 text-lg font-semibold text-gray-950">
              {policy?.afterHoursActiveContact?.name || 'No contact selected'}
            </div>
            <div className="mt-1 text-sm font-semibold text-red-800">
              {policy?.afterHoursActiveContact?.phone || 'No verified phone resolved'}
            </div>
            <div className="mt-2 text-xs leading-5 text-gray-600">
              {policy?.afterHoursActiveContact?.rotationLabel || 'Save settings to refresh the resolved contact.'}
            </div>
            {(policy?.afterHoursActiveContact?.warnings || []).length > 0 && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {policy.afterHoursActiveContact.warnings.join(', ')}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <label className="text-sm font-semibold uppercase tracking-wide text-gray-600">Confirmation title</label>
          <input
            value={draft?.confirmationTitle || ''}
            onChange={(event) => updateDraft({ confirmationTitle: event.target.value })}
            className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <label className="text-sm font-semibold uppercase tracking-wide text-gray-600">Requester confirmation copy</label>
          <textarea
            value={draft?.confirmationBody || ''}
            onChange={(event) => updateDraft({ confirmationBody: event.target.value })}
            rows={4}
            className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-gray-950">After-hours response page copy</h3>
            <p className="mt-1 text-sm text-gray-600">
              This is shown on the public immediate-support page before the requester confirms escalation. Edit it per workspace.
            </p>
          </div>
          <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
            Workspace-specific
          </span>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          {[
            ['businessHours', 'During Business Hours'],
            ['afterHours', 'During After Hours'],
            ['lateNight', 'During Late Night Hours'],
          ].map(([field, label]) => (
            <label key={field} className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</span>
              <textarea
                value={draft?.afterHoursResponseCopy?.[field] || ''}
                onChange={(event) => updateResponseCopy(field, event.target.value)}
                rows={5}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm leading-6 focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </label>
          ))}
        </div>
        <div className="mt-5 overflow-hidden rounded-lg border border-gray-200">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-gray-50 text-gray-700">
              <tr>
                <th className="border-b border-gray-200 px-3 py-2 text-left font-semibold">Window</th>
                <th className="border-b border-gray-200 px-3 py-2 text-left font-semibold">Business Hours</th>
                <th className="border-b border-gray-200 px-3 py-2 text-left font-semibold">After-hours</th>
                <th className="border-b border-gray-200 px-3 py-2 text-left font-semibold">Late Night</th>
              </tr>
            </thead>
            <tbody>
              {(draft?.afterHoursResponseTable?.rows || DEFAULT_RESPONSE_TABLE.rows).map((row, index) => (
                <tr key={`${row.label}-${index}`} className="odd:bg-white even:bg-gray-50/60">
                  {['label', 'businessHours', 'afterHours', 'lateNight'].map((field) => (
                    <td key={field} className="border-b border-gray-100 px-3 py-2">
                      <input
                        value={row?.[field] || ''}
                        onChange={(event) => updateResponseTableRow(index, field, event.target.value)}
                        className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(policy?.legacyEmails?.length > 0 || policy?.legacyPhones?.length > 0) && (
        <details className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-amber-900">
            Legacy external recipients preserved from Assignment configuration
          </summary>
          <div className="mt-3 space-y-2 text-sm text-amber-900">
            <p>Replace these with selected users when possible. Legacy recipients do not have per-user readiness or channel preferences.</p>
            {policy.legacyEmails?.length > 0 && <p><strong>Email:</strong> {policy.legacyEmails.join(', ')}</p>}
            {policy.legacyPhones?.length > 0 && <p><strong>Phone:</strong> {policy.legacyPhones.join(', ')}</p>}
            {policy.legacyChannels?.length > 0 && <p><strong>Channels:</strong> {policy.legacyChannels.join(', ')}</p>}
            <label className="inline-flex items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                checked={draft?.clearLegacy === true}
                onChange={(event) => updateDraft({ clearLegacy: event.target.checked })}
                className="h-4 w-4 rounded border-amber-300 text-amber-700"
              />
              Clear legacy recipients on next save
            </label>
          </div>
        </details>
      )}
    </div>
  );
}
