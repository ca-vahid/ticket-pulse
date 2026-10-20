import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowUpRight,
  BellRing,
  ChevronDown,
  Loader2,
  Mail,
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
//
// QA 10-19 #6: a calmer, warmer palette — warm off-white page, sky hero, one
// colour per step (blue → purple → amber → green) — and the stage now comes
// from the server (`data.progress`), which decides from the status first.

const DEFAULT_ACCENT = '#2563eb';
const HEX_RE = /^#[0-9a-f]{6}$/i;

// Self-contained palette (public pages never read the app theme). Bars and
// dots clear 3:1 on the hero; every text colour clears 4.5:1 on its surface.
const PAGE_BG = '#FAF8F5';
const HERO_BG = '#E6F6FD';
const CARD_BORDER = '#F0EBE4';
const STEP_COLOR = {
  received: '#2F8ADB',
  assigned: '#9672E3',
  in_progress: '#C27806',
  waiting: '#C27806',
  resolved: '#1E9A66',
  closed: '#1E9A66',
  merged: '#1E9A66',
};
const STAGE_TEXT = {
  received: '#1A6BB5',
  in_progress: '#9A5B05',
  waiting: '#9A5B05',
  done: '#16774A',
};
const LABEL_PURPLE = '#6B46C1';
const LABEL_GREEN = '#16774A';
const ACTION_TONES = {
  blue: { tile: '#E3F1FD', icon: '#1F74C7', hover: 'hover:bg-[#F3F9FE]' },
  rose: { tile: '#FDE8EC', icon: '#C8304F', hover: 'hover:bg-[#FFF6F8]' },
  orange: { tile: '#FDEEDC', icon: '#C2620A', hover: 'hover:bg-[#FFF8F1]' },
};
const HERO_ART = '/brand/status/hero-network.webp';

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

const DONE_STAGES = new Set(['resolved', 'closed', 'merged']);

/**
 * Fallback for payloads without `progress` (an older server). Status first:
 * a Closed/Resolved label wins over a missing assignee, and a step passed
 * without happening is `skipped`, never left at Received.
 */
function legacyProgress(data) {
  const ticket = data?.ticket || {};
  const timeline = Array.isArray(data?.timeline) ? data.timeline : [];
  const status = String(ticket.status || '');
  const tone = ticket.statusTone || 'neutral';
  const assigned = Boolean(
    ticket.assignedAgent?.name || ticket.assignedAt || timeline.some(item => item?.key === 'assigned'),
  );
  const closed = timeline.some(item => item?.key === 'closed') || /closed|deleted|spam/i.test(status);
  const resolved = tone === 'resolved' || closed || /resolved/i.test(status);
  const waiting = !resolved && tone === 'waiting';
  const waitingOnYou = waiting && waitsOnRequester(status);

  let headline;
  let current;
  let stage;
  if (resolved) {
    stage = closed ? 'closed' : 'resolved';
    headline = closed ? 'Closed' : 'Resolved';
    current = 4;
  } else if (waiting) {
    stage = 'waiting';
    headline = waitingOnYou ? 'Waiting on you' : 'On hold';
    current = 2;
  } else if (assigned) {
    stage = 'in_progress';
    headline = 'In progress';
    current = 2;
  } else {
    stage = 'received';
    headline = tone === 'neutral' && status && !/^\d+$/.test(status) ? status : 'Received';
    current = 1;
  }

  const keys = ['received', 'assigned', waiting ? 'waiting' : 'in_progress', closed ? 'closed' : 'resolved'];
  const steps = [
    'Received',
    'Assigned',
    waiting ? (waitingOnYou ? 'Waiting on you' : 'On hold') : 'In progress',
    closed ? 'Closed' : 'Resolved',
  ].map((label, index) => {
    let state = index < current ? 'complete' : index === current ? 'current' : 'upcoming';
    if (state === 'complete' && !assigned && (index === 1 || (index === 2 && resolved))) state = 'skipped';
    return { key: keys[index], label, state };
  });

  return {
    stage, tone, assigned, closed, resolved, waiting, waitingOnYou, headline, current, steps,
    merged: false, mergedInto: null, reopened: false, resumeAt: null,
  };
}

/**
 * The page's single source of truth for "where is my request": headline word,
 * tone, and the four-step progress (Received → Assigned → In progress/Waiting
 * → Resolved). `current` is the index of the active step; 4 = all done.
 */
function deriveProgress(data) {
  const server = data?.progress;
  if (!server || !Array.isArray(server.steps) || server.steps.length !== 4 || !server.stage) {
    return legacyProgress(data);
  }
  const stage = server.stage;
  return {
    stage,
    tone: server.tone || data?.ticket?.statusTone || 'neutral',
    assigned: Boolean(server.assigned),
    closed: stage === 'closed',
    merged: stage === 'merged',
    resolved: DONE_STAGES.has(stage),
    waiting: stage === 'waiting',
    waitingOnYou: Boolean(server.waitingOnRequester),
    reopened: Boolean(server.reopened),
    resumeAt: server.resumeAt || null,
    mergedInto: server.mergedInto || null,
    headline: server.headline || 'Received',
    current: Number(server.current) || 1,
    steps: server.steps.map(step => ({ key: step.key, label: step.label, state: step.state })),
  };
}

function stageColors(progress) {
  if (progress.resolved) return { text: STAGE_TEXT.done, dot: STEP_COLOR.resolved };
  if (progress.waiting) return { text: STAGE_TEXT.waiting, dot: STEP_COLOR.waiting };
  if (progress.stage === 'in_progress' || progress.reopened) return { text: STAGE_TEXT.in_progress, dot: STEP_COLOR.in_progress };
  return { text: STAGE_TEXT.received, dot: STEP_COLOR.received };
}

function Card({ title, children, className = '', titleId, titleColor }) {
  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      className={`rounded-2xl border bg-white p-5 shadow-subtle sm:p-6 ${className}`}
      style={{ borderColor: CARD_BORDER }}
    >
      {title && (
        <h2
          id={titleId}
          className={`text-sm font-semibold ${titleColor ? '' : 'text-slate-600'}`}
          style={titleColor ? { color: titleColor } : undefined}
        >
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

const STATE_NOTE = {
  complete: ' (done)',
  current: ' (current step)',
  skipped: ' (skipped)',
};

function Stepper({ steps }) {
  return (
    <ol aria-label="Progress" className="mt-6 grid grid-cols-4 gap-2 sm:gap-3">
      {steps.map((step, index) => {
        const isCurrent = step.state === 'current';
        const isComplete = step.state === 'complete';
        const isSkipped = step.state === 'skipped';
        const color = STEP_COLOR[step.key] || STEP_COLOR.received;
        // Reached steps carry their own colour; a skipped one is a faint wash of it.
        const barStyle = isComplete || isCurrent
          ? { backgroundColor: color }
          : isSkipped
            ? { backgroundColor: `${color}4d` }
            : undefined;
        return (
          <li
            key={step.key || step.label}
            aria-current={isCurrent ? 'step' : undefined}
            data-state={step.state}
            className="min-w-0"
          >
            <span
              aria-hidden="true"
              className={`block h-2 rounded-full ${barStyle ? '' : 'bg-white'}`}
              style={barStyle}
            />
            <span
              className={`mt-2 block text-xs leading-snug sm:text-sm ${
                isCurrent ? 'font-semibold text-slate-900' : isComplete ? 'text-slate-700' : 'text-slate-600'
              }`}
            >
              {step.label}
              <span className="sr-only">
                {STATE_NOTE[step.state] || ` (step ${index + 1}, not yet)`}
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
        className="h-12 w-12 shrink-0 rounded-full bg-[#EEE8FB] object-cover"
        onError={() => setFailed(true)}
      />
    );
  }
  const letters = initials(agent?.name);
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#EEE8FB] text-base font-semibold text-[#5B3FB0]"
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
  } else if (progress.waiting || progress.stage === 'in_progress') {
    // Being worked (or waiting) without a named person: still the team's.
    title = 'Our support team';
    detail = 'Your request is with the team.';
  } else {
    title = 'Not assigned yet';
    detail = 'We will pick someone shortly.';
  }

  return (
    <Card
      title={progress.resolved ? 'Who helped you' : 'Who is helping you'}
      titleId="tp-status-helper"
      titleColor={LABEL_PURPLE}
    >
      <div className="mt-4 flex items-center gap-4">
        {name ? <AgentAvatar agent={agent} /> : (
          <span aria-hidden="true" className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#EEE8FB] text-[#5B3FB0]">
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
  if (progress.merged) {
    const ref = progress.mergedInto?.displayRef;
    return {
      sentence: ref ? `This request continues on ${ref}.` : 'This request continues on another ticket.',
      detail: 'Updates and replies happen there now.',
      link: progress.mergedInto?.statusUrl ? { href: progress.mergedInto.statusUrl, label: ref ? `See the status of ${ref}` : 'See its status' } : null,
    };
  }
  if (progress.resolved) {
    const word = progress.closed ? 'Closed' : 'Resolved';
    const when = formatDate(ticket.closedAt || ticket.resolvedAt || ticket.completedAt);
    return {
      sentence: eta.actualResolutionLabel ? `${word} in ${eta.actualResolutionLabel}.` : `This request is ${word.toLowerCase()}.`,
      detail: when ? `${word} ${when}.` : null,
    };
  }
  if (progress.waiting) {
    if (progress.waitingOnYou) {
      return {
        sentence: 'We need something from you before we can continue.',
        detail: 'Please reply to our last e-mail about this request.',
      };
    }
    const resume = formatDate(progress.resumeAt);
    return {
      sentence: 'The work is paused while we wait on another step, such as a vendor or an approval.',
      detail: resume ? `We plan to pick it up again by ${resume}.` : 'We will pick it up again as soon as that clears.',
    };
  }
  if (progress.reopened) {
    return {
      sentence: 'We reopened this request and are looking at it again.',
      detail: 'We will e-mail you when there is news.',
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
  const { sentence, detail, link } = nextStep(eta, progress, ticket);
  // The method only explains an estimate that is still in play.
  const showMethod = !progress.resolved && !progress.waiting && !progress.reopened
    && Number(eta.sampleSize) > 0 && eta.estimatedResolutionLabel;
  const expected = !progress.resolved && !progress.waiting && eta.state === 'on_track' ? formatDate(eta.expectedAt) : null;
  return (
    <Card title="What happens next" titleId="tp-status-next" titleColor={LABEL_GREEN}>
      <p className="mt-4 text-base font-semibold text-slate-900">{sentence}</p>
      {detail && <p className="mt-1 text-sm text-slate-600">{detail}</p>}
      {link && (
        <a
          href={link.href}
          className="tp-focus-ring mt-3 inline-flex items-center gap-1 rounded-md text-sm font-semibold text-[#16774A] underline-offset-4 hover:underline"
        >
          {link.label}
          <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
        </a>
      )}
      {showMethod && (
        <details className="group mt-4">
          <summary className="tp-focus-ring inline-flex cursor-pointer list-none items-center gap-1 rounded-lg bg-[#E7F6EE] px-3 py-1.5 text-sm font-medium text-[#166534] hover:bg-[#D7EFE2] [&::-webkit-details-marker]:hidden">
            How we estimate this
            <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform group-open:rotate-180" />
          </summary>
          <p className="mt-3 text-sm leading-6 text-slate-600">
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

function ActionTile({ Icon, tone }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
      style={{ backgroundColor: tone.tile, color: tone.icon }}
    >
      <Icon className="h-5 w-5" />
    </span>
  );
}

function ActionRow({ href, Icon, title, detail, tone }) {
  return (
    <li>
      <a
        href={href}
        className={`tp-focus-ring group flex items-center gap-4 rounded-xl px-2 py-3 ${tone.hover}`}
      >
        <ActionTile Icon={Icon} tone={tone} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-900">{title}</span>
          <span className="block text-sm text-slate-600">{detail}</span>
        </span>
        <ArrowUpRight
          aria-hidden="true"
          className="h-4 w-4 shrink-0 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transition-none"
          style={{ color: tone.icon }}
        />
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
  const addInfoTitle = open || progress.merged ? 'Add information' : 'Still not right?';
  const addInfoDetail = open
    ? 'Reply to any e-mail we sent you about this request.'
    : progress.merged
      ? 'Reply to our last e-mail about this request.'
      : 'Reply to our last e-mail about this request and we will take another look.';

  return (
    <Card title="Need something?" titleId="tp-status-actions">
      {notices.length > 0 && (
        <div role="status" className="mt-4 flex items-start gap-3 rounded-xl p-4" style={{ backgroundColor: PAGE_BG }}>
          <BellRing aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-[#C8304F]" />
          <div className="space-y-1 text-sm text-slate-700">
            {notices.map(text => <p key={text}>{text}</p>)}
          </div>
        </div>
      )}
      <ul className="mt-3 space-y-1">
        <li className="flex items-center gap-4 px-2 py-3">
          <ActionTile Icon={Mail} tone={ACTION_TONES.blue} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-slate-900">{addInfoTitle}</span>
            <span className="block text-sm text-slate-600">{addInfoDetail}</span>
          </span>
        </li>
        {canRaise && (
          <ActionRow
            href={link.raiseUrgencyUrl}
            Icon={Siren}
            tone={ACTION_TONES.rose}
            title="Mark as urgent"
            detail="Only if this is stopping your work."
          />
        )}
        {canGetHelp && (
          <ActionRow
            href={link.immediateSupportUrl}
            Icon={PhoneCall}
            tone={ACTION_TONES.orange}
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
    <section className="rounded-2xl border bg-white shadow-subtle" style={{ borderColor: CARD_BORDER }}>
      <details className="group">
        <summary className="tp-focus-ring flex cursor-pointer list-none items-center justify-between gap-4 rounded-2xl p-5 sm:px-6 [&::-webkit-details-marker]:hidden">
          <h2 className="text-sm font-semibold text-slate-600">Your request</h2>
          <ChevronDown aria-hidden="true" className="h-4 w-4 text-slate-500 transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t px-5 pb-5 pt-4 sm:px-6" style={{ borderColor: CARD_BORDER }}>
          {ticket.summary && <LinkedText text={ticket.summary} className="text-sm leading-6 text-slate-700" />}
          {facts.length > 0 && (
            <dl className={`grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr] ${ticket.summary ? 'mt-4' : ''}`}>
              {facts.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-slate-600">{label}</dt>
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

function HeroArt() {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <img
      src={HERO_ART}
      alt=""
      aria-hidden="true"
      decoding="async"
      onError={() => setHidden(true)}
      className="pointer-events-none absolute inset-0 -z-10 h-full w-full select-none object-cover object-right opacity-70"
    />
  );
}

function Shell({ children }) {
  return (
    <main className="tp-light min-h-screen text-slate-900" style={{ backgroundColor: PAGE_BG }}>
      {children}
    </main>
  );
}

function ErrorPage({ title, message, hint, onRefresh }) {
  return (
    <Shell>
      <div className="mx-auto max-w-xl px-4 py-16">
        <div className="rounded-2xl border bg-white p-6 shadow-subtle sm:p-8" style={{ borderColor: CARD_BORDER }}>
          <span aria-hidden="true" className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-[#FDE8EC] text-[#C8304F]">
            <AlertCircle className="h-6 w-6" />
          </span>
          <h1 className="mt-4 text-xl font-semibold text-slate-900">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">{message}</p>
          {hint && <p className="mt-2 text-sm leading-6 text-slate-600">{hint}</p>}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="tp-focus-ring mt-5 inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50"
            >
              <RefreshCw aria-hidden="true" className="h-4 w-4" />
              Try again
            </button>
          )}
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
    // 403 = expired, revoked or switched off: trying again cannot help, a new
    // e-mail can (the server mints a fresh link for the next one it sends).
    const expired = error.status === 403;
    return (
      <ErrorPage
        title={expired ? 'This link is no longer active' : 'We could not find this request'}
        message={error.message}
        hint={expired ? 'The next e-mail we send you about this request will carry a fresh link.' : null}
        onRefresh={expired ? null : load}
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
  const colors = stageColors(progress);
  const received = formatDate(ticket.createdAt);
  const requesterName = settings.showRequesterName ? ticket.requester?.name : null;
  const checkedAt = formatTime(data?.refreshedAt);
  const expires = formatDay(data?.link?.expiresAt);

  return (
    <Shell>
      <header className="border-b bg-white" style={{ borderColor: CARD_BORDER }}>
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
              <p className="text-xs text-slate-600">Request status</p>
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
        <section
          aria-labelledby="tp-status-subject"
          className="relative isolate overflow-hidden rounded-2xl p-5 shadow-subtle sm:p-8"
          style={{ backgroundColor: HERO_BG }}
        >
          <HeroArt />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {ticket.displayRef && (
              <span
                className="rounded-md bg-white px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-700 shadow-subtle"
                data-testid="ticket-ref"
              >
                {ticket.displayRef}
              </span>
            )}
            <p
              className="inline-flex items-center gap-2 text-base font-semibold sm:text-lg"
              style={{ color: colors.text }}
              data-testid="status-headline"
            >
              <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: colors.dot }} />
              {progress.headline}
            </p>
          </div>
          <h1 id="tp-status-subject" className="mt-4 break-words text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            {ticket.subject}
          </h1>
          {(received || requesterName) && (
            <p className="mt-1.5 text-sm text-slate-600">
              {received ? `Received ${received}` : 'Received'}
              {requesterName ? ` from ${requesterName}` : ''}
            </p>
          )}
          <Stepper steps={progress.steps} />
        </section>

        <div className="grid gap-4 sm:grid-cols-2 sm:gap-5">
          <HelperCard ticket={ticket} progress={progress} />
          <NextCard eta={eta} progress={progress} ticket={ticket} />
        </div>

        <ActionsCard data={data} progress={progress} />

        <RequestCard ticket={ticket} />

        <footer className="space-y-1 px-1 pt-4 text-xs leading-5 text-slate-600">
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
