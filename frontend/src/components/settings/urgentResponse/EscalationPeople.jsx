import { useId, useState } from 'react';
import { AlertTriangle, Info, Mail, MessageCircle, PhoneCall, Search, Smartphone, UserPlus } from 'lucide-react';
import { PersonAvatar } from '../../tickets/ticketUi';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui';

/**
 * QA 10-26 #4: who gets alerted, as one plain table. Each person shows how
 * they can be reached right now, or why they cannot and how to fix it, and
 * three quiet tick boxes for the three lists. Same data contract as before:
 * `candidates` from /settings/urgent-escalation/candidates and the three
 * id lists of the draft policy.
 */

const CHANNELS = [
  { key: 'email', label: 'E-mail', Icon: Mail },
  { key: 'sms', label: 'Text', Icon: Smartphone },
  { key: 'whatsapp', label: 'WhatsApp', Icon: MessageCircle },
  { key: 'phone_call', label: 'Phone call', Icon: PhoneCall },
];

const ROLES = [
  {
    key: 'base',
    field: 'baseRecipientIds',
    label: 'On the roster',
    short: 'Roster',
    dot: 'bg-primary',
    help: 'After hours, gets every urgent alert: when Ticket Pulse finds an urgent ticket, and when a requester presses Request immediate support.',
  },
  {
    key: 'self',
    field: 'selfExtraRecipientIds',
    label: 'Extra',
    short: 'Extra',
    dot: 'bg-violet-500 dark:bg-violet-400',
    help: 'After hours, only when a requester presses Request immediate support. Added on top of the roster.',
  },
  {
    key: 'supervisor',
    field: 'businessSupervisorRecipientIds',
    label: 'Supervisor',
    short: 'Supervisor',
    dot: 'bg-orange-500 dark:bg-orange-400',
    help: 'During business hours, only when a requester raises a ticket to Urgent from the ticket page, and only while Notify supervisors is on.',
  },
];

const WARNING_TEXT = {
  channel_paused_for_workspace: 'paused for this workspace',
  not_enabled_by_user: 'turned off in their Mail & alerts',
  missing_email: 'no e-mail address',
  missing_phone: 'no mobile number',
  phone_not_verified: 'mobile number not confirmed',
};

const MEMBERSHIP_NOTE = {
  assignable: 'Assignable only',
  member: 'App member, not an agent',
  outside: 'No longer in this workspace',
};

function channelStatus(readiness) {
  if (!readiness) return 'not available';
  if (readiness.ready) return 'ready';
  const first = (readiness.warnings || [])[0];
  return WARNING_TEXT[first] || 'not set up for Ticket Pulse yet';
}

/**
 * Why a person cannot be reached, in one line, and what fixes it. The most
 * common case by far is someone who never switched alerts on.
 */
function unreachableReason(candidate) {
  const channels = CHANNELS.map((c) => candidate?.channels?.[c.key]).filter(Boolean);
  const live = channels.filter((c) => !c.pausedByWorkspace);
  const turnedOn = live.filter((c) => c.enabled);
  if (!candidate?.hasPreferences || turnedOn.length === 0) {
    return { reason: 'Has not turned on any alerts', fix: 'They turn alerts on in Mail & alerts.' };
  }
  const warnings = turnedOn.flatMap((c) => c.warnings || []);
  if (warnings.includes('missing_email') && turnedOn.length === 1) {
    return { reason: 'No e-mail address', fix: 'Add an e-mail address to their profile.' };
  }
  if (warnings.includes('missing_phone')) {
    return { reason: 'No mobile number', fix: 'They add one in Mail & alerts.' };
  }
  if (warnings.includes('phone_not_verified')) {
    return { reason: 'Mobile number not confirmed', fix: 'They confirm it in Mail & alerts.' };
  }
  const unconfigured = turnedOn.find((c) => c.configured === false);
  if (unconfigured) {
    const label = CHANNELS.find((c) => c.key === unconfigured.channel)?.label || unconfigured.label;
    return { reason: `${label} is not set up for Ticket Pulse yet`, fix: 'A global admin sets it up in Settings, Notifications.' };
  }
  return { reason: 'Every channel they use is paused here', fix: 'Turn one back on under Channels above.' };
}

function HelpTip({ text, label }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="tp-focus-ring inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground/75 hover:text-foreground"
          aria-label={label}
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-normal leading-5">{text}</TooltipContent>
    </Tooltip>
  );
}

function ReachCell({ candidate }) {
  const detailId = useId();
  const ready = CHANNELS.filter((c) => candidate.channels?.[c.key]?.ready);
  const lines = CHANNELS.map((c) => `${c.label}: ${channelStatus(candidate.channels?.[c.key])}`);
  const blocked = ready.length === 0 ? unreachableReason(candidate) : null;
  const tip = (
    <ul className="space-y-0.5">
      {lines.map((line) => <li key={line}>{line}</li>)}
    </ul>
  );
  return (
    <div className="min-w-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-describedby={detailId}
            className="tp-focus-ring -mx-1 flex max-w-full items-start gap-1.5 rounded px-1 py-0.5 text-left"
          >
            {blocked ? (
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium text-amber-800 dark:text-amber-200">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                  Can&apos;t be reached
                </span>
                <span className="block text-xs leading-5 text-muted-foreground">{blocked.reason}. {blocked.fix}</span>
              </span>
            ) : (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-foreground">
                {ready.map(({ key, label, Icon }) => (
                  <span key={key} className="inline-flex items-center gap-1">
                    <Icon className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />
                    {label}
                  </span>
                ))}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs whitespace-normal leading-5">{tip}</TooltipContent>
      </Tooltip>
      <span id={detailId} className="sr-only">{lines.join('. ')}</span>
    </div>
  );
}

function PersonRow({ candidate, picked, onToggle }) {
  const note = MEMBERSHIP_NOTE[candidate.membership];
  return (
    <div
     
      data-testid="escalation-person"
      className="grid grid-cols-1 gap-x-4 gap-y-2 border-b border-border/60 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.3fr)_repeat(3,5.5rem)] md:items-center"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <PersonAvatar name={candidate.name} photoUrl={candidate.photoUrl || null} size="h-8 w-8" textSize="text-xs" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{candidate.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {candidate.email || 'No e-mail address'}
            {note && (
              <span className={candidate.membership === 'outside' ? 'text-amber-800 dark:text-amber-200' : ''}>
                {', '}{note}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="min-w-0 pl-[2.625rem] md:pl-0">
        <ReachCell candidate={candidate} />
      </div>
      <div className="contents">
        <div className="flex flex-wrap gap-x-5 gap-y-1 pl-[2.625rem] md:contents">
          {ROLES.map((role) => (
            <label
              key={role.key}
              className="inline-flex cursor-pointer items-center gap-2 text-sm text-foreground/85 md:justify-center"
            >
              <input
                type="checkbox"
                checked={picked[role.key]}
                onChange={() => onToggle(role.field, candidate.id)}
                aria-label={`${candidate.name}: ${role.label}`}
                className="h-4 w-4 cursor-pointer rounded border-input text-primary focus:ring-2 focus:ring-ring"
              />
              <span className="md:sr-only">{role.short}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function EscalationPeople({ candidates = [], selected = {}, onToggle }) {
  const [search, setSearch] = useState('');
  const [view, setView] = useState('all');

  const isPicked = (id) => ({
    base: selected.base?.has(id) === true,
    self: selected.self?.has(id) === true,
    supervisor: selected.supervisor?.has(id) === true,
  });
  const reachable = (candidate) => CHANNELS.some((c) => candidate.channels?.[c.key]?.ready);
  const anyPicked = (candidate) => Object.values(isPicked(candidate.id)).some(Boolean);

  // Picked people first, then those who can be reached, then the rest.
  const score = (candidate) => (anyPicked(candidate) ? 0 : reachable(candidate) ? 1 : 2);
  const ordered = [...candidates].sort((a, b) => score(a) - score(b) || String(a.name || '').localeCompare(String(b.name || '')));

  const counts = {
    all: candidates.length,
    picked: candidates.filter(anyPicked).length,
    unreachable: candidates.filter((c) => !reachable(c)).length,
  };

  const visible = ordered.filter((candidate) => {
    if (view === 'picked' && !anyPicked(candidate)) return false;
    if (view === 'unreachable' && reachable(candidate)) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [candidate.name, candidate.email].filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
  });

  const rolePeople = (role) => candidates.filter((c) => selected[role.key]?.has(c.id));

  return (
    <TooltipProvider delayDuration={150}>
      <section className="rounded-xl border border-border bg-card" aria-labelledby="escalation-people-title" data-testid="escalation-people">
        <div className="p-4 pb-3">
          <h3 id="escalation-people-title" className="text-base font-semibold text-foreground">Who gets alerted</h3>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Tick a box to put someone on a list. Only people in this workspace are shown. Someone who can&apos;t be reached gets nothing, so fix that first.
          </p>

          <dl className="mt-4 grid gap-x-8 gap-y-3 md:grid-cols-3">
            {ROLES.map((role) => {
              const people = rolePeople(role);
              return (
                <div key={role.key} className="min-w-0">
                  <dt className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <span className={`h-2 w-2 flex-shrink-0 rounded-full ${role.dot}`} aria-hidden="true" />
                    {role.label}
                    <span className="font-normal text-muted-foreground">{people.length}</span>
                  </dt>
                  <dd className="mt-0.5 text-xs leading-5 text-muted-foreground">{role.help}</dd>
                  <dd className="mt-1 truncate text-xs text-foreground/85" title={people.map((p) => p.name).join(', ')}>
                    {people.length ? people.map((p) => p.name).join(', ') : 'Nobody yet'}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>

        <div className="flex flex-col gap-3 border-y border-border px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div role="group" aria-label="Show" className="flex gap-4 text-sm">
            {[
              ['all', 'Everyone'],
              ['picked', 'On a list'],
              ['unreachable', "Can't be reached"],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={view === key}
                onClick={() => setView(key)}
                className={`tp-focus-ring -mb-[11px] border-b-2 pb-2 pt-0.5 ${
                  view === key
                    ? 'border-primary font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {label} <span className="text-muted-foreground">{counts[key]}</span>
              </button>
            ))}
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground/75" aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find a person"
              aria-label="Find a person"
              className="h-8 w-full rounded-md border border-input bg-card pl-8 pr-2 text-sm text-foreground focus:border-primary focus:ring-2 focus:ring-ring/30"
            />
          </div>
        </div>

        <div>
          <div
           
            className="hidden border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground md:grid md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.3fr)_repeat(3,5.5rem)] md:items-center md:gap-x-4"
          >
            <span>Person</span>
            <span className="flex items-center gap-1">
              Can be reached by
              <HelpTip
                label="About reaching people"
                text="What can deliver an alert to this person right now. They choose their channels in Mail & alerts; text, WhatsApp and calls also need a confirmed mobile number. Hover a person for the detail."
              />
            </span>
            {ROLES.map((role) => (
              <span key={role.key} className="flex items-center justify-center gap-1">
                {role.short}
                <HelpTip label={`About ${role.label}`} text={role.help} />
              </span>
            ))}
          </div>

          {visible.map((candidate) => (
            <PersonRow key={candidate.id} candidate={candidate} picked={isPicked(candidate.id)} onToggle={onToggle} />
          ))}

          {visible.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              <UserPlus className="mx-auto mb-2 h-5 w-5 text-muted-foreground/75" aria-hidden="true" />
              {candidates.length === 0
                ? 'Nobody in this workspace yet. Add agents or members first, then Refresh.'
                : view === 'unreachable' && !search
                  ? 'Everyone here can be reached.'
                  : 'Nobody matches. Clear the search or show everyone.'}
            </div>
          )}
        </div>
      </section>
    </TooltipProvider>
  );
}
