import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowUpRight,
  BellRing,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Inbox,
  Loader2,
  Mail,
  PauseCircle,
  PhoneCall,
  RefreshCw,
  Siren,
  UserRound,
} from 'lucide-react';
import { publicTicketStatusAPI } from '../services/api';
import { LinkedText } from '../components/tickets/ticketUi';

// Requester-facing status page (/ticket-status/:token). QA 10-15 #7 redesign:
// the common helpdesk / parcel-tracker pattern — one clear status with a short
// progress stepper, who is handling it, one human sentence about what happens
// next, and the few actions a requester can take. Everything else (stats,
// percentiles, link expiry, category) is either folded into a disclosure or
// a footer line. Light-only like every public token page (.tp-light).

const DEFAULT_ACCENT = '#2563eb';
const HEX_RE = /^#[0-9a-f]{6}$/i;

function formatDate(value, options = {}) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...options,
  });
}

function formatDay(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function initials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('');
}

/** "about a day", "about 3 hours" — a typical duration said the way a person would. */
function humanDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  const hours = value / 3600;
  if (hours < 1.5) return 'an hour';
  if (hours < 20) return `${Math.round(hours)} hours`;
  if (hours < 36) return 'a day';
  const days = hours / 24;
  if (days < 6.5) return `${Math.round(days)} days`;
  if (days < 10.5) return 'a week';
  return `${Math.round(days / 7)} weeks`;
}

/** A Pending-type status that is waiting on the requester (vs. a vendor, approval, …). */
function waitsOnRequester(status) {
  return /customer|requester|user|you|response|reply|information|info/i.test(String(status || ''));
}

/**
 * The page's single source of truth for "where is my request": headline word,
 * tone, and the four-step progress (Received → Assigned → In progress/Waiting
 * → Resolved). `current` is the index of the active step; 4 = all done.
 */
function deriveProgress(data) {
  const ticket = data?.ticket || {};
  const timeline = Array.isArray(data?.timeline) ? data.timeline : [];
  const tone = ticket.statusTone || 'neutral';
  const assigned = Boolean(
    ticket.assignedAgent?.name || ticket.assignedAt || timeline.some(item => item?.key === 'assigned'),
  );
  const closed = timeline.some(item => item?.key === 'closed') || /closed/i.test(String(ticket.status || ''));
  const resolved = tone === 'resolved';
  const waiting = tone === 'waiting';
  const waitingOnYou = waiting && waitsOnRequester(ticket.status);

  let headline;
  let current;
  if (resolved) {
    headline = closed ? 'Closed' : 'Resolved';
    current = 4;
  } else if (waiting) {
    headline = waitingOnYou ? 'Waiting on you' : 'On hold';
    current = 2;
  } else if (assigned) {
    headline = 'In progress';
    current = 2;
  } else {
    headline = tone === 'neutral' && ticket.status ? ticket.status : 'Received';
    current = 1;
  }

  const steps = [
    'Received',
    'Assigned',
    waiting ? (waitingOnYou ? 'Waiting on you' : 'On hold') : 'In progress',
    closed ? 'Closed' : 'Resolved',
  ].map((label, index) => ({
    label,
    state: index < current ? 'complete' : index === current ? 'current' : 'upcoming',
  }));

  return { tone, assigned, closed, resolved, waiting, waitingOnYou, headline, current, steps };
}

function toneStyle(tone, accent) {
  if (tone === 'resolved') return { Icon: CheckCircle2, className: 'bg-emerald-50 text-emerald-700' };
  if (tone === 'waiting') return { Icon: PauseCircle, className: 'bg-amber-50 text-amber-700' };
  if (tone === 'open') return { Icon: Clock3, className: '', style: { backgroundColor: `${accent}1a`, color: accent } };
  return { Icon: Inbox, className: 'bg-slate-100 text-slate-600' };
}

function Card({ title, children, className = '', titleId }) {
  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      className={`rounded-xl border border-slate-200 bg-white p-5 shadow-subtle sm:p-6 ${className}`}
    >
      {title && (
        <h2 id={titleId} className="text-sm font-medium text-slate-500">{title}</h2>
      )}
      {children}
    </section>
  );
}

function Stepper({ steps, accent, waiting }) {
  return (
    <ol aria-label="Progress" className="mt-6 grid grid-cols-4 gap-2 sm:gap-3">
      {steps.map((step, index) => {
        const isCurrent = step.state === 'current';
        const isComplete = step.state === 'complete';
        const barStyle = isComplete
          ? { backgroundColor: accent }
          : isCurrent
            ? { backgroundColor: waiting ? '#f59e0b' : `${accent}80` }
            : undefined;
        return (
          <li
            key={step.label}
            aria-current={isCurrent ? 'step' : undefined}
            data-state={step.state}
            className="min-w-0"
          >
            <span
              aria-hidden="true"
              className={`block h-1.5 rounded-full ${isComplete || isCurrent ? '' : 'bg-slate-200'}`}
              style={barStyle}
            />
            <span
              className={`mt-2 block text-xs leading-snug sm:text-sm ${
                isCurrent ? 'font-semibold text-slate-900' : isComplete ? 'text-slate-700' : 'text-slate-500'
              }`}
            >
              {step.label}
              <span className="sr-only">
                {isComplete ? ' (done)' : isCurrent ? ' (current step)' : ` (step ${index + 1}, not yet)`}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function AgentAvatar({ agent }) {
  const [failed, setFailed] = useState(false);
  if (agent?.photoUrl && !failed) {
    return (
      <img
        src={agent.photoUrl}
        alt=""
        className="h-12 w-12 shrink-0 rounded-full bg-slate-100 object-cover"
        onError={() => setFailed(true)}
      />
    );
  }
  const letters = initials(agent?.name);
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-slate-100 text-base font-semibold text-slate-600"
    >
      {letters || <UserRound className="h-6 w-6" />}
    </span>
  );
}

function HelperCard({ ticket, progress }) {
  const agent = ticket.assignedAgent;
  const name = agent?.name || null;
  const since = formatDate(ticket.assignedAt);

  let title;
  let detail;
  if (name) {
    title = name;
    detail = since && !progress.resolved ? `Since ${since}` : null;
  } else if (progress.resolved || (progress.assigned && agent === null)) {
    // Settings can hide the name; never call a handled ticket "unassigned".
    title = 'Our support team';
    detail = progress.resolved ? null : 'Your request is with a member of the team.';
  } else {
    title = 'Not assigned yet';
    detail = 'We will pick someone shortly.';
  }

  return (
    <Card title={progress.resolved ? 'Who helped you' : 'Who is helping you'} titleId="tp-status-helper">
      <div className="mt-4 flex items-center gap-4">
        {name ? <AgentAvatar agent={agent} /> : (
          <span aria-hidden="true" className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
            <UserRound className="h-6 w-6" />
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-slate-900">{title}</p>
          {detail && <p className="mt-0.5 text-sm text-slate-600">{detail}</p>}
        </div>
      </div>
    </Card>
  );
}

function nextStep(eta, progress, ticket) {
  if (progress.resolved) {
    const word = progress.closed ? 'Closed' : 'Resolved';
    const when = formatDate(ticket.closedAt || ticket.resolvedAt || ticket.completedAt);
    return {
      sentence: eta.actualResolutionLabel ? `${word} in ${eta.actualResolutionLabel}.` : `This request is ${word.toLowerCase()}.`,
      detail: when ? `${word} ${when}.` : null,
    };
  }
  if (progress.waiting) {
    return progress.waitingOnYou
      ? {
        sentence: 'We need something from you before we can continue.',
        detail: 'Please reply to our last e-mail about this request.',
      }
      : {
        sentence: 'The work is paused while we wait on another step, such as a vendor or an approval.',
        detail: 'We will pick it up again as soon as that clears.',
      };
  }
  if (eta.state === 'overdue' || eta.overdue) {
    return {
      sentence: 'This one is taking longer than usual.',
      detail: 'It is still being worked on, and we will e-mail you with any news.',
    };
  }
  const about = humanDuration(eta.estimatedSeconds);
  if (about) {
    return {
      sentence: `Most requests like this are done within about ${about}.`,
      detail: 'We will e-mail you when there is news.',
    };
  }
  return {
    sentence: 'We will e-mail you as soon as there is an update.',
    detail: null,
  };
}

function NextCard({ eta, progress, ticket }) {
  const { sentence, detail } = nextStep(eta, progress, ticket);
  // The method only explains an estimate that is still in play.
  const showMethod = !progress.resolved && !progress.waiting && Number(eta.sampleSize) > 0 && eta.estimatedResolutionLabel;
  const expected = !progress.resolved && !progress.waiting && eta.state === 'on_track' ? formatDate(eta.expectedAt) : null;
  return (
    <Card title="What happens next" titleId="tp-status-next">
      <p className="mt-4 text-base font-semibold text-slate-900">{sentence}</p>
      {detail && <p className="mt-1 text-sm text-slate-600">{detail}</p>}
      {showMethod && (
        <details className="group mt-4">
          <summary className="tp-focus-ring inline-flex cursor-pointer list-none items-center gap-1 rounded-md text-sm text-slate-600 hover:text-slate-900 [&::-webkit-details-marker]:hidden">
            How we estimate this
            <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform group-open:rotate-180" />
          </summary>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            We looked at {eta.sampleSize} similar requests resolved
            {eta.lookbackDays ? ` in the last ${eta.lookbackDays} days` : ' recently'}.
            {' '}{eta.percentile ? `${eta.percentile} in 100` : 'Most'} of them were done within {eta.estimatedResolutionLabel}.
            {expected ? ` For this request that points to around ${expected}.` : ''}
          </p>
        </details>
      )}
    </Card>
  );
}

function ActionRow({ href, Icon, title, detail }) {
  return (
    <li>
      <a
        href={href}
        className="tp-focus-ring group flex items-center gap-4 rounded-lg px-1 py-3 hover:bg-slate-50"
      >
        <span aria-hidden="true" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700">
          <Icon className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-900">{title}</span>
          <span className="block text-sm text-slate-600">{detail}</span>
        </span>
        <ArrowUpRight aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400 group-hover:text-slate-700" />
      </a>
    </li>
  );
}

function ActionsCard({ data, progress }) {
  const link = data?.link || {};
  const actions = data?.publicActions || {};
  const notices = [];
  if (actions.urgencyRaised) {
    const at = formatDate(actions.urgencyRaisedAt);
    notices.push(`You marked this request as urgent${at ? ` on ${at}` : ''}. The team has been told.`);
  }
  if (actions.immediateSupportRequested) {
    const at = formatDate(actions.immediateSupportRequestedAt);
    notices.push(`You asked for immediate help${at ? ` on ${at}` : ''}. The on-call person has been told.`);
  }

  const open = !progress.resolved;
  const canRaise = open && link.raiseUrgencyUrl && actions.raiseUrgencyAvailable !== false && !actions.urgencyRaised;
  const canGetHelp = open && link.immediateSupportUrl && actions.immediateSupportAvailable === true && !actions.immediateSupportRequested;

  return (
    <Card title="Need something?" titleId="tp-status-actions">
      {notices.length > 0 && (
        <div role="status" className="mt-4 flex items-start gap-3 rounded-lg bg-slate-50 p-4">
          <BellRing aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-slate-600" />
          <div className="space-y-1 text-sm text-slate-700">
            {notices.map(text => <p key={text}>{text}</p>)}
          </div>
        </div>
      )}
      <ul className="mt-3 divide-y divide-slate-100">
        <li className="flex items-center gap-4 px-1 py-3">
          <span aria-hidden="true" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700">
            <Mail className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-slate-900">
              {open ? 'Add information' : 'Still not right?'}
            </span>
            <span className="block text-sm text-slate-600">
              {open
                ? 'Reply to any e-mail we sent you about this request.'
                : 'Reply to our last e-mail about this request and we will take another look.'}
            </span>
          </span>
        </li>
        {canRaise && (
          <ActionRow
            href={link.raiseUrgencyUrl}
            Icon={Siren}
            title="Mark as urgent"
            detail="Only if this is stopping your work."
          />
        )}
        {canGetHelp && (
          <ActionRow
            href={link.immediateSupportUrl}
            Icon={PhoneCall}
            title="Get after-hours help"
            detail="Reaches the on-call person outside business hours."
          />
        )}
      </ul>
    </Card>
  );
}

function RequestCard({ ticket }) {
  const category = ticket.category || {};
  const categoryLine = [category.ticketPulseCategory, category.ticketPulseSubcategory].filter(Boolean).join(' › ');
  const facts = [
    ticket.priority ? ['Priority', ticket.priority] : null,
    categoryLine ? ['Category', categoryLine] : null,
  ].filter(Boolean);
  if (!ticket.summary && facts.length === 0) return null;
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-subtle">
      <details className="group">
        <summary className="tp-focus-ring flex cursor-pointer list-none items-center justify-between gap-4 rounded-xl p-5 sm:px-6 [&::-webkit-details-marker]:hidden">
          <h2 className="text-sm font-medium text-slate-500">Your request</h2>
          <ChevronDown aria-hidden="true" className="h-4 w-4 text-slate-500 transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t border-slate-100 px-5 pb-5 pt-4 sm:px-6">
          {ticket.summary && <LinkedText text={ticket.summary} className="text-sm leading-6 text-slate-700" />}
          {facts.length > 0 && (
            <dl className={`grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr] ${ticket.summary ? 'mt-4' : ''}`}>
              {facts.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="text-slate-800">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </details>
    </section>
  );
}

function Shell({ children }) {
  return (
    <main className="tp-light min-h-screen bg-slate-50 text-slate-900">
      {children}
    </main>
  );
}

function ErrorPage({ title, message, onRefresh }) {
  return (
    <Shell>
      <div className="mx-auto max-w-xl px-4 py-16">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-subtle sm:p-8">
          <span aria-hidden="true" className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-rose-50 text-rose-700">
            <AlertCircle className="h-6 w-6" />
          </span>
          <h1 className="mt-4 text-xl font-semibold text-slate-900">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">{message}</p>
          <button
            type="button"
            onClick={onRefresh}
            className="tp-focus-ring mt-5 inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50"
          >
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
            Try again
          </button>
        </div>
      </div>
    </Shell>
  );
}

export default function PublicTicketStatus() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await publicTicketStatusAPI.get(token);
      setData(response.data);
    } catch (err) {
      setError({
        status: err.status,
        message: err.message || 'Unable to load this ticket status link.',
      });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !data) {
    return (
      <Shell>
        <div className="flex min-h-screen items-center justify-center gap-3 text-sm text-slate-600" role="status">
          <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin text-slate-500" />
          Loading your request
        </div>
      </Shell>
    );
  }

  if (error && !data) {
    const expired = error.status === 403;
    return (
      <ErrorPage
        title={expired ? 'This link is no longer active' : 'We could not find this request'}
        message={error.message}
        onRefresh={load}
      />
    );
  }

  return <StatusView data={data} loading={loading} onRefresh={load} />;
}

export function StatusView({ data, loading = false, onRefresh }) {
  const ticket = data?.ticket || {};
  const eta = data?.eta || {};
  const branding = data?.branding || {};
  const settings = data?.settings || {};
  const accent = HEX_RE.test(branding.accentColor || '') ? branding.accentColor : DEFAULT_ACCENT;
  const brandName = branding.brandName || data?.workspace?.name || 'Ticket Pulse';
  const progress = deriveProgress(data);
  const tone = toneStyle(progress.resolved ? 'resolved' : progress.waiting ? 'waiting' : progress.tone, accent);
  const StatusIcon = tone.Icon;
  const received = formatDate(ticket.createdAt);
  const requesterName = settings.showRequesterName ? ticket.requester?.name : null;
  const checkedAt = formatTime(data?.refreshedAt);
  const expires = formatDay(data?.link?.expiresAt);

  return (
    <Shell>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {branding.logoDataUrl ? (
              <img
                src={branding.logoDataUrl}
                alt={branding.logoAltText || brandName}
                className="h-9 max-w-[10rem] object-contain"
              />
            ) : (
              <span
                aria-hidden="true"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white"
                style={{ backgroundColor: accent }}
              >
                {initials(brandName) || 'TP'}
              </span>
            )}
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-semibold text-slate-900">{brandName}</p>
              <p className="text-xs text-slate-500">Request status</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="tp-focus-ring inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-slate-600 hover:text-slate-900 disabled:cursor-wait disabled:opacity-60"
          >
            {loading
              ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
            Refresh
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6 sm:space-y-5 sm:px-6 sm:py-10">
        <section aria-labelledby="tp-status-subject" className="rounded-xl border border-slate-200 bg-white p-5 shadow-subtle sm:p-8">
          <div className="flex items-center gap-4">
            <span
              aria-hidden="true"
              className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${tone.className}`}
              style={tone.style}
            >
              <StatusIcon className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              {ticket.displayRef && (
                <p className="text-sm font-medium tabular-nums text-slate-500" data-testid="ticket-ref">{ticket.displayRef}</p>
              )}
              <p className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl" data-testid="status-headline">
                {progress.headline}
              </p>
            </div>
          </div>
          <h1 id="tp-status-subject" className="mt-5 break-words text-lg font-medium text-slate-800 sm:text-xl">
            {ticket.subject}
          </h1>
          {(received || requesterName) && (
            <p className="mt-1 text-sm text-slate-500">
              {received ? `Received ${received}` : 'Received'}
              {requesterName ? ` from ${requesterName}` : ''}
            </p>
          )}
          <Stepper steps={progress.steps} accent={accent} waiting={progress.waiting} />
        </section>

        <div className="grid gap-4 sm:grid-cols-2 sm:gap-5">
          <HelperCard ticket={ticket} progress={progress} />
          <NextCard eta={eta} progress={progress} ticket={ticket} />
        </div>

        <ActionsCard data={data} progress={progress} />

        <RequestCard ticket={ticket} />

        <footer className="space-y-1 px-1 pt-4 text-xs leading-5 text-slate-500">
          <p>{branding.trademarkText || `${brandName} · powered by Ticket Pulse`}</p>
          <p>
            No sign-in needed for this link{expires ? `; it works until ${expires}` : ''}.
            {checkedAt ? ` Checked at ${checkedAt}.` : ''}
          </p>
        </footer>
      </div>
    </Shell>
  );
}
