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
  roster: 'Escalation roster: the core after-hours list. These users are alerted for automatic after-hours urgent detections AND when a requester clicks the after-hours immediate-support button. The phone number shown in after-hours e-mails is the on-call person\'s, from the On-call tab.',
  self: 'Extra self-escalation recipients: alerted ONLY when a requester clicks the after-hours immediate-support button. They are added on top of the roster for those requester-initiated escalations, and are never paged by automatic detection.',
  supervisor: 'Business-hours supervisors: alerted ONLY when a requester raises a ticket to Urgent from the public ticket page during business hours. They are never paged after hours.',
};

function readinessTone(readiness) {
  if (readiness?.pausedByWorkspace) return 'border-border bg-muted text-muted-foreground/75 line-through decoration-gray-400/60';
  if (readiness?.ready) return 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200';
  if (readiness?.enabled) return 'border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200';
  return 'border-border bg-muted/50 text-muted-foreground';
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
          ? 'border-emerald-300 dark:border-emerald-500/40 bg-emerald-50/90 dark:bg-emerald-500/10 text-foreground shadow-sm ring-1 ring-emerald-100 dark:ring-emerald-500/30'
          : 'border-border bg-card/85 text-foreground/85 hover:border-input hover:bg-muted/50',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border',
            enabled ? 'border-emerald-400 bg-emerald-600 text-white' : 'border-input bg-muted text-muted-foreground/75',
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
                enabled ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200' : 'bg-muted text-muted-foreground',
              )}
            >
              {enabled ? 'Enabled' : 'Off'}
            </span>
          </span>
          <span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span>
        </span>
      </div>
    </button>
  );
}

function SystemDefaultCard({ title, description }) {
  return (
    <div className="rounded-2xl border border-blue-200 dark:border-blue-500/30 bg-blue-50/80 dark:bg-blue-500/10 p-4 text-left shadow-sm ring-1 ring-blue-100 dark:ring-blue-500/30">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-blue-300 dark:border-blue-500/40 bg-card text-blue-700 dark:text-blue-200">
          <CheckCircle2 className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="block text-sm font-semibold text-foreground">{title}</span>
            <span className="rounded-full bg-blue-100 dark:bg-blue-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-700 dark:text-blue-200">
              System default
            </span>
          </span>
          <span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span>
        </span>
      </div>
    </div>
  );
}

function IntegratedStatusCard({ tone = 'blue', label, status, detail }) {
  const tones = {
    blue: 'border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200',
    amber: 'border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200',
    emerald: 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200',
    gray: 'border-border bg-muted/50 text-muted-foreground',
  };
  return (
    <div className={`rounded-lg border px-3 py-2 ${tones[tone] || tones.blue}`}>
      <div className="text-xs font-semibold uppercase">{label}</div>
      <div className="mt-1 text-sm font-semibold text-foreground">{status}</div>
      {detail && <div className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</div>}
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
    <div className="grid grid-cols-[minmax(220px,1.1fr)_minmax(260px,1.2fr)_auto_auto_auto] items-center gap-3 border-b border-border/60 px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-blue-50 dark:bg-blue-500/15 text-sm font-semibold text-blue-700 dark:text-blue-200">
            {candidate.photoUrl
              ? <img src={candidate.photoUrl} alt="" className="h-full w-full object-cover" />
              : (candidate.name || '?').slice(0, 1)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{candidate.name}</div>
            <div className="truncate text-xs text-muted-foreground">{candidate.email || 'No email on technician record'}</div>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {channels.map((readiness) => (
          <ChannelChip key={readiness.channel} readiness={readiness} />
        ))}
        {candidate.readyChannelCount === 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 px-2 py-1 text-[11px] font-semibold text-red-700 dark:text-red-200">
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
          selectedBase ? 'border-blue-300 dark:border-blue-500/40 bg-blue-600 text-white' : 'border-border bg-card text-foreground/85 hover:border-blue-300 dark:hover:border-blue-500/40'
        }`}
      >
        {selectedBase ? 'Roster' : 'Add roster'}
      </button>
      <button
        type="button"
        onClick={() => onToggleSelfExtra(candidate.id)}
        title={RECIPIENT_BUCKET_HELP.self}
        className={`rounded-lg border px-3 py-2 text-xs font-semibold transition ${
          selectedSelfExtra ? 'border-purple-300 dark:border-purple-500/40 bg-purple-600 text-white' : 'border-border bg-card text-foreground/85 hover:border-purple-300 dark:hover:border-purple-500/40'
        }`}
      >
        {selectedSelfExtra ? 'Self extra' : 'Add self'}
      </button>
      <button
        type="button"
        onClick={() => onToggleBusinessSupervisor(candidate.id)}
        title={RECIPIENT_BUCKET_HELP.supervisor}
        className={`rounded-lg border px-3 py-2 text-xs font-semibold transition ${
          selectedBusinessSupervisor ? 'border-orange-300 dark:border-orange-500/40 bg-orange-600 text-white' : 'border-border bg-card text-foreground/85 hover:border-orange-300 dark:hover:border-orange-500/40'
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

const CONTACT_NOTES = {
  on_call_phone_not_verified: (name) => `${name || 'The on-call person'} has no verified phone yet, so e-mails show the Request immediate support button without a number. A number can be verified in their notification preferences.`,
  on_call_person_away_no_cover: (name) => `${name || 'The on-call person'} is away today with nobody covering, so no number is printed. Add a cover on the On-call tab.`,
  on_call_not_configured: () => 'Nobody is on call yet. Set the order on the On-call tab; until then after-hours e-mails show no number.',
  no_one_on_call: () => 'Nobody holds on-call right now, so after-hours e-mails show no number.',
  on_call_person_not_found: (name) => `${name || 'The on-call person'} is not an active member of this workspace, so no number is printed.`,
  phone_hidden_by_workspace_setting: () => 'Numbers are hidden: e-mails show the Request immediate support button only.',
};

function formatUntil(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * QA 10-23 #2: the "Can't wait until morning?" card prints the on-call
 * person's number. One switch (print it or not) and who that is right now.
 */
function AfterHoursNumberCard({ contact, showPhone, onShowPhone, onOpenOnCall }) {
  const warnings = contact?.warnings || [];
  const note = warnings.map((code) => CONTACT_NOTES[code]?.(contact?.name)).find(Boolean) || null;
  const until = formatUntil(contact?.until);
  const onCallLink = onOpenOnCall
    ? <button type="button" onClick={onOpenOnCall} className="tp-focus-ring rounded font-medium text-primary hover:underline">On-call tab</button>
    : 'On-call tab';
  return (
    <div className="rounded-xl border border-border bg-card p-4" data-testid="after-hours-number">
      <h3 className="text-base font-semibold text-foreground">Phone number in after-hours e-mails</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        After-hours e-mails show the number of whoever is on call, from the {onCallLink}. It follows the handover time and any cover, and only a verified number is printed.
      </p>
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.6fr)]">
        <label className="flex items-start gap-3 rounded-lg border border-border bg-muted/50 p-3">
          <input
            type="checkbox"
            checked={showPhone}
            onChange={(event) => onShowPhone(event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-input text-red-600 dark:text-red-300 focus:ring-red-500"
          />
          <span>
            <span className="block text-sm font-semibold text-foreground">Show the on-call number</span>
            <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">When off, e-mails keep the Request immediate support button, which pages whoever is on call, without printing a number.</span>
          </span>
        </label>
        <div className="rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <PhoneCall className="h-4 w-4" aria-hidden="true" />
            On call now
          </div>
          <div className="mt-2 text-base font-semibold text-foreground" data-testid="after-hours-number-name">
            {contact?.name || 'Nobody'}
          </div>
          {contact?.phone && (
            <div className="mt-0.5 text-sm font-semibold text-red-800 dark:text-red-200">{contact.phone}</div>
          )}
          {(contact?.rotationLabel || until) && (
            <div className="mt-1 text-xs text-muted-foreground">
              {[contact?.technicianId ? contact.rotationLabel : null, until ? `until ${until}` : null].filter(Boolean).join(', ')}
            </div>
          )}
          {note && (
            <p className="mt-3 text-xs leading-5 text-amber-800 dark:text-amber-200" data-testid="after-hours-number-note">{note}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function unwrapApiData(response) {
  return response?.data?.data ?? response?.data ?? response ?? {};
}

/**
 * QA 10-23 #2: the after-hours contact in e-mails is the on-call person of
 * Settings → Urgent Response → On-call (handover time, covers). This page only
 * says who that is now and whether their number is printed; `onOpenOnCall`
 * opens the On-call tab.
 */
export default function UrgentEscalationPanel({ onOpenOnCall = null } = {}) {
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
      return { ...(current || {}), [field]: [...set] };
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
        <div className="tp-glass rounded-2xl border border-card/70 dark:border-white/10 p-8 text-center text-muted-foreground">
          <RefreshCw className="mx-auto mb-3 h-6 w-6 animate-spin text-blue-600 dark:text-blue-300" />
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
        <div className="rounded-lg border border-border bg-card p-4">
          <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Clock3 className="h-4 w-4 text-blue-600 dark:text-blue-300" />
            Repeat-click cooldown
          </label>
          <div className="mt-3 flex items-center gap-2">
            <input
              type="number"
              min="5"
              max="1440"
              value={draft?.cooldownMinutes || 60}
              onChange={(event) => updateDraft({ cooldownMinutes: event.target.value })}
              className="w-28 rounded-lg border border-input px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
            />
            <span className="text-sm text-muted-foreground">minutes</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Default is 60 minutes. Repeated requester clicks within this window will not alert again.</p>
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
        <div className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-300" />
            <div>
              <div className="text-sm font-semibold text-amber-900 dark:text-amber-200">Provider readiness warnings</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-amber-800 dark:text-amber-200">
                {providerWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
              <div className="mt-2 text-xs text-amber-700 dark:text-amber-200">
                Provider credentials and WhatsApp templates are managed under Settings &gt; Notifications (global admin). If a channel is not used in this workspace, pause it below to silence its warnings.
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-foreground">Escalation channels</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Paused channels are skipped for every escalation send and excluded from readiness warnings. Email is always on.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-200"
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
                      ? 'border-border bg-muted text-muted-foreground/75 hover:border-input'
                      : 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 hover:border-emerald-300 dark:hover:border-emerald-500/40'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {meta.label}
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase ${paused ? 'bg-secondary text-muted-foreground' : 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200'}`}>
                    {paused ? 'Paused' : 'On'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="border-b border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-foreground">Escalation recipients</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Roster users receive automatic and after-hours immediate-support alerts. Extra self-escalation users are added only for after-hours requester clicks. Supervisors are only used for business-hours urgency raises when that toggle is on.
              </p>
            </div>
            <div className="relative min-w-[280px]">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground/75" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search users"
                className="w-full rounded-lg border border-input py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
              />
            </div>
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            Showing {filteredCandidates.length} of {candidates.length} workspace users.
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <div className="rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 p-3" title={RECIPIENT_BUCKET_HELP.roster}>
              <div className="flex items-center gap-1 text-xs font-semibold uppercase text-blue-700 dark:text-blue-200">
                Escalation roster
                <span className="cursor-help rounded-full bg-blue-100 dark:bg-blue-500/20 px-1.5 text-[10px] font-bold normal-case text-blue-600 dark:text-blue-300">?</span>
              </div>
              <div className="mt-0.5 text-[11px] leading-4 text-blue-700/80">Automatic after-hours alerts + requester immediate-support clicks</div>
              <div className="mt-1 text-sm font-semibold text-foreground">{selectedBaseUsers.length} selected</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {selectedBaseUsers.length === 0 && <span className="text-xs text-blue-700 dark:text-blue-200">No users selected yet.</span>}
                {selectedBaseUsers.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => toggleId('baseRecipientIds', candidate.id)}
                    className="inline-flex items-center gap-1 rounded-full bg-card px-2 py-1 text-xs font-semibold text-blue-800 dark:text-blue-200 ring-1 ring-blue-200 dark:ring-blue-500/30"
                  >
                    {candidate.name}
                    <X className="h-3 w-3" />
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-purple-200 dark:border-purple-500/30 bg-purple-50 dark:bg-purple-500/15 p-3" title={RECIPIENT_BUCKET_HELP.self}>
              <div className="flex items-center gap-1 text-xs font-semibold uppercase text-purple-700 dark:text-purple-200">
                Extra self-escalation recipients
                <span className="cursor-help rounded-full bg-purple-100 dark:bg-purple-500/20 px-1.5 text-[10px] font-bold normal-case text-purple-600 dark:text-purple-300">?</span>
              </div>
              <div className="mt-0.5 text-[11px] leading-4 text-purple-700/80">Only when a requester clicks the after-hours support button</div>
              <div className="mt-1 text-sm font-semibold text-foreground">{selectedSelfUsers.length} selected</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {selectedSelfUsers.length === 0 && <span className="text-xs text-purple-700 dark:text-purple-200">No extra users selected.</span>}
                {selectedSelfUsers.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => toggleId('selfExtraRecipientIds', candidate.id)}
                    className="inline-flex items-center gap-1 rounded-full bg-card px-2 py-1 text-xs font-semibold text-purple-800 dark:text-purple-200 ring-1 ring-purple-200 dark:ring-purple-500/30"
                  >
                    {candidate.name}
                    <X className="h-3 w-3" />
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-orange-200 dark:border-orange-500/30 bg-orange-50 dark:bg-orange-500/15 p-3" title={RECIPIENT_BUCKET_HELP.supervisor}>
              <div className="flex items-center gap-1 text-xs font-semibold uppercase text-orange-700 dark:text-orange-200">
                Business-hours supervisors
                <span className="cursor-help rounded-full bg-orange-100 dark:bg-orange-500/20 px-1.5 text-[10px] font-bold normal-case text-orange-600 dark:text-orange-300">?</span>
              </div>
              <div className="mt-0.5 text-[11px] leading-4 text-orange-700/80">Only for requester urgency raises during business hours</div>
              <div className="mt-1 text-sm font-semibold text-foreground">{selectedBusinessSupervisorUsers.length} selected</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {selectedBusinessSupervisorUsers.length === 0 && <span className="text-xs text-orange-700 dark:text-orange-200">No supervisors selected.</span>}
                {selectedBusinessSupervisorUsers.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => toggleId('businessSupervisorRecipientIds', candidate.id)}
                    className="inline-flex items-center gap-1 rounded-full bg-card px-2 py-1 text-xs font-semibold text-orange-800 dark:text-orange-200 ring-1 ring-orange-200 dark:ring-orange-500/30"
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
              <div className="p-8 text-center text-sm text-muted-foreground">
                <UserPlus className="mx-auto mb-2 h-5 w-5 text-muted-foreground/75" />
                {candidates.length === 0
                  ? 'No workspace users loaded. Click Refresh to try again.'
                  : 'No users match this search.'}
              </div>
            )}
          </div>
        </div>
      </div>

      <AfterHoursNumberCard
        contact={policy?.afterHoursActiveContact}
        showPhone={draft?.showAfterHoursPhoneInEmail !== false}
        onShowPhone={(value) => updateDraft({ showAfterHoursPhoneInEmail: value })}
        onOpenOnCall={onOpenOnCall}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-4">
          <label className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Confirmation title</label>
          <input
            value={draft?.confirmationTitle || ''}
            onChange={(event) => updateDraft({ confirmationTitle: event.target.value })}
            className="mt-2 w-full rounded-lg border border-input px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
          />
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <label className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Requester confirmation copy</label>
          <textarea
            value={draft?.confirmationBody || ''}
            onChange={(event) => updateDraft({ confirmationBody: event.target.value })}
            rows={4}
            className="mt-2 w-full rounded-lg border border-input px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
          />
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-foreground">After-hours response page copy</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              This is shown on the public immediate-support page before the requester confirms escalation. Edit it per workspace.
            </p>
          </div>
          <span className="rounded-full border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-3 py-1 text-xs font-semibold text-amber-700 dark:text-amber-200">
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
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
              <textarea
                value={draft?.afterHoursResponseCopy?.[field] || ''}
                onChange={(event) => updateResponseCopy(field, event.target.value)}
                rows={5}
                className="mt-1 w-full rounded-lg border border-input px-3 py-2 text-sm leading-6 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
              />
            </label>
          ))}
        </div>
        <div className="mt-5 overflow-hidden rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/50 text-foreground/85">
              <tr>
                <th className="border-b border-border px-3 py-2 text-left font-semibold">Window</th>
                <th className="border-b border-border px-3 py-2 text-left font-semibold">Business Hours</th>
                <th className="border-b border-border px-3 py-2 text-left font-semibold">After-hours</th>
                <th className="border-b border-border px-3 py-2 text-left font-semibold">Late Night</th>
              </tr>
            </thead>
            <tbody>
              {(draft?.afterHoursResponseTable?.rows || DEFAULT_RESPONSE_TABLE.rows).map((row, index) => (
                <tr key={`${row.label}-${index}`} className="odd:bg-card even:bg-muted/30">
                  {['label', 'businessHours', 'afterHours', 'lateNight'].map((field) => (
                    <td key={field} className="border-b border-border/60 px-3 py-2">
                      <input
                        value={row?.[field] || ''}
                        onChange={(event) => updateResponseTableRow(index, field, event.target.value)}
                        className="w-full rounded-md border border-border px-2 py-1.5 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
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
        <details className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-amber-900 dark:text-amber-200">
            Legacy external recipients preserved from Assignment configuration
          </summary>
          <div className="mt-3 space-y-2 text-sm text-amber-900 dark:text-amber-200">
            <p>Replace these with selected users when possible. Legacy recipients do not have per-user readiness or channel preferences.</p>
            {policy.legacyEmails?.length > 0 && <p><strong>Email:</strong> {policy.legacyEmails.join(', ')}</p>}
            {policy.legacyPhones?.length > 0 && <p><strong>Phone:</strong> {policy.legacyPhones.join(', ')}</p>}
            {policy.legacyChannels?.length > 0 && <p><strong>Channels:</strong> {policy.legacyChannels.join(', ')}</p>}
            <label className="inline-flex items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                checked={draft?.clearLegacy === true}
                onChange={(event) => updateDraft({ clearLegacy: event.target.checked })}
                className="h-4 w-4 rounded border-amber-300 dark:border-amber-500/40 text-amber-700 dark:text-amber-200"
              />
              Clear legacy recipients on next save
            </label>
          </div>
        </details>
      )}
    </div>
  );
}
