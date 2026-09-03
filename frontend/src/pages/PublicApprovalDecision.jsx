import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock,
  Copy,
  ExternalLink,
  Link2Off,
  MessageCircleQuestion,
  Moon,
  Sun,
  XCircle,
} from 'lucide-react';
import { publicApprovalAPI } from '../services/api';
import { PersonAvatar, SafeHtml, formatDay, formatDayTime } from '../components/tickets/ticketUi';
import ApprovalRail from './publicApproval/ApprovalRail';
import DecisionBox from './publicApproval/DecisionBox';
import { usePublicTheme } from './publicApproval/usePublicTheme';
import {
  absoluteApiUrl,
  STATUS_CHIP,
  classifyLoadError,
  firstName,
  isOpenForDecision,
  isPastDate,
} from './publicApproval/approvalMeta';

/**
 * Public approval decision page (/approval/:token — magic link, no login).
 *
 * Token-driven surface: `bg-background` / `bg-card` / `text-foreground` …
 * theme under the page-local `.dark` stamp (usePublicTheme), so the approver
 * gets the same light/dark treatment as the app without touching the app's
 * own theme choice. Page-scoped CSS ("public approval page" block in
 * index.css) lets pasted quote tables keep their columns and scroll sideways.
 */

// The axios client's response interceptor (services/api.js) resolves with the
// JSON body itself; tolerate a raw axios response too so a test double or a
// future client change can't blank the page.
function unwrapBody(res) {
  if (res && typeof res === 'object' && res.data && typeof res.data === 'object' && !('approval' in res) && !('status' in res)) return res.data;
  return res;
}

const BRAND_MARK_CLASS = 'grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[9px] bg-gradient-to-br from-primary to-violet-600 text-[12px] font-bold text-white shadow-subtle';

function TopBar({ workspaceName, theme, onToggleTheme }) {
  const dark = theme === 'dark';
  return (
    <header className="mb-[18px] flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <div className={BRAND_MARK_CLASS} aria-hidden="true">TP</div>
        <div className="leading-tight">
          <p className="text-[15px] font-semibold text-foreground">Ticket Pulse</p>
          <p className="text-xs text-muted-foreground">{workspaceName ? `${workspaceName} workspace` : 'Approval request'}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onToggleTheme}
        aria-pressed={dark}
        aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
        className="tp-focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        {dark ? <Sun className="h-3.5 w-3.5" aria-hidden="true" /> : <Moon className="h-3.5 w-3.5" aria-hidden="true" />}
        {dark ? 'Light' : 'Dark'}
      </button>
    </header>
  );
}

function Shell({ workspaceName, theme, onToggleTheme, children, bottomPad = true }) {
  return (
    <div className="tp-approval-backdrop min-h-screen bg-background text-foreground">
      <div className={`mx-auto max-w-[1240px] px-5 pt-7 ${bottomPad ? 'pb-[220px] min-[800px]:pb-28' : 'pb-16'}`}>
        <TopBar workspaceName={workspaceName} theme={theme} onToggleTheme={onToggleTheme} />
        <main id="approval-main">{children}</main>
      </div>
    </div>
  );
}

function StatusChip({ status }) {
  const meta = STATUS_CHIP[status] || STATUS_CHIP.pending;
  return (
    <span className={`rounded-full px-2.5 py-[3px] text-[11px] font-bold uppercase tracking-[0.04em] ${meta.className}`}>
      {meta.label}
    </span>
  );
}

function SectionHeading({ children }) {
  return <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{children}</h3>;
}

function LoadingCard() {
  return (
    <div className="tp-card overflow-hidden rounded-2xl shadow-soft" aria-busy="true" aria-label="Loading approval">
      <div className="border-b border-border px-6 py-5">
        <div className="flex gap-2"><span className="h-5 w-40 rounded-full bg-muted motion-safe:animate-pulse" /><span className="h-5 w-36 rounded-full bg-muted motion-safe:animate-pulse" /></div>
        <div className="mt-3 h-3 w-56 rounded bg-muted motion-safe:animate-pulse" />
        <div className="mt-3 h-7 w-3/4 rounded bg-muted motion-safe:animate-pulse" />
        <div className="mt-3 h-3 w-1/2 rounded bg-muted motion-safe:animate-pulse" />
      </div>
      <div className="grid min-[800px]:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3 px-6 py-5">
          <div className="h-28 rounded-xl bg-muted motion-safe:animate-pulse" />
          <div className="h-3 w-full rounded bg-muted motion-safe:animate-pulse" />
          <div className="h-3 w-11/12 rounded bg-muted motion-safe:animate-pulse" />
          <div className="h-3 w-2/3 rounded bg-muted motion-safe:animate-pulse" />
        </div>
        <div className="space-y-4 px-5 py-5">
          <div className="h-11 rounded-lg bg-muted motion-safe:animate-pulse" />
          <div className="h-8 w-2/3 rounded-lg bg-muted motion-safe:animate-pulse" />
          <div className="h-20 rounded-lg bg-muted motion-safe:animate-pulse" />
        </div>
      </div>
    </div>
  );
}

function MessageCard({ icon: Icon, tone = 'muted', title, children }) {
  const toneClass = tone === 'danger'
    ? 'bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-200'
    : tone === 'warn'
      ? 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-200'
      : 'bg-muted text-muted-foreground';
  return (
    <div className="tp-card mx-auto max-w-lg rounded-2xl px-6 py-10 text-center shadow-soft motion-safe:animate-fadeIn" role="status">
      <span className={`mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full ${toneClass}`}>
        <Icon className="h-6 w-6" aria-hidden="true" />
      </span>
      <h1 className="text-lg font-bold text-foreground">{title}</h1>
      <div className="mt-2 text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

/** Decided / cancelled / info-requested banner. `tabIndex=-1` so the page can move focus here after a submit. */
const DecisionBanner = ({ approval, decidedByYou, bannerRef, isDark }) => {
  const status = approval?.status;
  let tone = 'bg-muted text-foreground border-border';
  let Icon = Ban;
  let title = '';
  let body = null;
  const when = approval?.decidedAt ? formatDayTime(approval.decidedAt) : null;
  const decidedInApp = approval?.decidedVia === 'app' && !decidedByYou;

  if (status === 'approved' || status === 'rejected') {
    const verb = status === 'approved' ? 'approved' : 'rejected';
    tone = status === 'approved'
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-100 dark:border-emerald-500/25'
      : 'bg-red-50 text-red-800 border-red-200 dark:bg-red-500/10 dark:text-red-100 dark:border-red-500/25';
    Icon = status === 'approved' ? CheckCircle2 : XCircle;
    title = decidedInApp
      ? `${verb.charAt(0).toUpperCase() + verb.slice(1)} by ${approval.approverName || 'another approver'}${when ? ` on ${when}` : ''} in the app`
      : `You ${verb} this${when ? ` on ${when}` : ''}`;
    body = (approval.decisionNoteHtml || approval.decisionNote)
      ? (
        <div className="mt-2 rounded-lg border border-border/60 bg-card/70 px-3 py-2 text-sm text-foreground/85">
          {approval.decisionNoteHtml ? <SafeHtml html={approval.decisionNoteHtml} isDark={isDark} preferThemed /> : <p className="whitespace-pre-wrap">{approval.decisionNote}</p>}
        </div>
      )
      : <p className="mt-1 text-sm opacity-80">The requester and the agent have been notified — you can close this page.</p>;
  } else if (status === 'cancelled') {
    if (approval.supersededBy?.name) {
      Icon = CheckCircle2;
      title = `Superseded — approved by ${approval.supersededBy.name}${approval.supersededBy.decidedAt ? ` on ${formatDayTime(approval.supersededBy.decidedAt)}` : ''}`;
      body = <p className="mt-1 text-sm opacity-80">Another approver already decided this request, so nothing is needed from you.</p>;
    } else {
      title = 'This request was cancelled';
      body = <p className="mt-1 text-sm opacity-80">{approval.cancelledReason || 'The agent withdrew the request — nothing is needed from you.'}</p>;
    }
  } else if (status === 'info_requested') {
    tone = 'bg-violet-50 text-violet-900 border-violet-200 dark:bg-violet-500/10 dark:text-violet-100 dark:border-violet-500/25';
    Icon = MessageCircleQuestion;
    const last = [...(approval.clarificationLog || [])].reverse().find((q) => q?.askedAt);
    title = `You asked a question${last ? ` on ${formatDayTime(last.askedAt)}` : ''} — you can still decide now`;
    body = <p className="mt-1 text-sm opacity-80">{`${firstName(approval.requestedByName) || 'The agent'} answers by email and the reply shows up below.`}</p>;
  } else {
    return null;
  }

  return (
    <div
      ref={bannerRef}
      tabIndex={-1}
      className={`tp-focus-ring mb-5 flex items-start gap-3 rounded-xl border px-4 py-3.5 motion-safe:animate-fadeIn ${tone}`}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {body}
      </div>
    </div>
  );
};

function RequestNote({ approval, workspaceName, isDark }) {
  const hasHtml = Boolean(approval?.requestNoteHtml);
  if (!hasHtml && !approval?.requestNote) return null;
  return (
    <section aria-label="Request note" className="tp-approval-note rounded-xl border border-border bg-muted/60 px-4 py-3.5">
      <div className="mb-2 flex items-center gap-2.5 text-xs text-muted-foreground">
        <PersonAvatar name={approval.requestedByName} photoUrl={absoluteApiUrl(approval.requestedByPhotoUrl)} size="h-8 w-8" textSize="text-xs" />
        <p>
          <span className="font-semibold text-foreground">{approval.requestedByName || 'The agent'}</span>
          {workspaceName ? ` (${workspaceName})` : ''} asks for your approval
        </p>
      </div>
      <div className="overflow-x-auto" data-testid="request-note-well">
        {hasHtml
          ? <SafeHtml html={approval.requestNoteHtml} className="text-[14px] leading-relaxed" isDark={isDark} preferThemed />
          : <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-foreground/85">{approval.requestNote}</p>}
      </div>
    </section>
  );
}

const COLLAPSED_MAX = 232; // ≈ 9 lines at 14px / 1.55 — a short pasted table fits without a clipped row

function TicketDescription({ ticket, isDark }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef(null);
  const html = ticket?.descriptionHtml;
  const text = ticket?.descriptionText;

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setOverflows(el.scrollHeight > COLLAPSED_MAX + 8);
  }, [html, text]);

  if (!html && !text) return null;
  const collapsed = overflows && !expanded;
  return (
    <section aria-labelledby="ticket-description-heading" className="mt-5">
      <SectionHeading><span id="ticket-description-heading">Ticket description</span></SectionHeading>
      <div className="relative">
        <div
          ref={bodyRef}
          id="ticket-description-body"
          className="tp-approval-desc overflow-hidden text-[14px] leading-[1.55] text-foreground/85"
          style={collapsed ? { maxHeight: COLLAPSED_MAX } : undefined}
        >
          {html
            ? <SafeHtml html={html} className="text-[14px] leading-[1.55]" isDark={isDark} preferThemed />
            : <p className="whitespace-pre-wrap">{text}</p>}
        </div>
        {collapsed && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" />
        )}
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls="ticket-description-body"
          className="tp-focus-ring mt-1.5 inline-flex items-center gap-1 rounded text-[13px] font-semibold text-primary hover:underline"
        >
          {expanded ? 'Show less' : 'Show full description'}
          <ChevronDown className={`h-3.5 w-3.5 ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      )}
    </section>
  );
}

function QuestionThread({ approval }) {
  const log = Array.isArray(approval?.clarificationLog) ? approval.clarificationLog.filter((q) => q?.question) : [];
  if (!log.length) return null;
  const agent = firstName(approval.requestedByName) || 'The agent';
  return (
    <section aria-label="Questions and replies" className="mt-[18px] flex flex-col gap-2.5">
      {log.map((entry, idx) => (
        <div
          key={`${entry.askedAt || idx}`}
          className="rounded-r-[10px] border-l-[3px] border-violet-500 bg-violet-50/70 px-3 py-2 text-[13px] dark:border-violet-400 dark:bg-violet-500/10"
        >
          <p className="font-semibold text-foreground">
            You asked{entry.askedAt ? ` (${formatDay(entry.askedAt)})` : ''}: {entry.question}
          </p>
          {entry.answer
            ? (
              <p className="mt-1 text-muted-foreground">
                {(entry.answeredBy ? firstName(entry.answeredBy) : agent)} replied{entry.answeredAt ? ` (${formatDay(entry.answeredAt)})` : ''}: {entry.answer}
              </p>
            )
            : (
              <p className="mt-1 inline-flex items-center gap-1.5 text-muted-foreground">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                Waiting for a reply from {agent}
              </p>
            )}
        </div>
      ))}
    </section>
  );
}

function HeaderActions({ ticket, copied, onCopy }) {
  // Always the ticket itself: an approver who wants the detail has an account,
  // and the public status page shows far less than this page already does.
  const href = ticket?.appTicketUrl;
  const title = 'Opens the full ticket in Ticket Pulse — sign in if you are not already';
  return (
    <div className="flex flex-wrap items-center gap-2">
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={title}
          className="tp-focus-ring inline-flex items-center gap-2 rounded-[10px] border border-border bg-card px-3.5 py-2 text-[13px] font-semibold text-foreground hover:bg-muted"
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
          View ticket
        </a>
      )}
      {ticket?.displayRef && (
        <button
          type="button"
          onClick={onCopy}
          className="tp-focus-ring inline-flex items-center gap-2 rounded-[10px] border border-border bg-card px-3.5 py-2 text-[13px] font-semibold text-foreground hover:bg-muted"
        >
          {copied ? <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-300" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy ref'}
        </button>
      )}
    </div>
  );
}

export default function PublicApprovalDecision() {
  const { token } = useParams();
  const { theme, isDark, toggle } = usePublicTheme();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [decidedByYou, setDecidedByYou] = useState(false);
  const [copied, setCopied] = useState(false);
  const bannerRef = useRef(null);
  const focusBannerRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    publicApprovalAPI.get(token)
      .then((res) => { if (!cancelled) { setData(unwrapBody(res)); setLoadError(null); } })
      .catch((err) => { if (!cancelled) setLoadError(classifyLoadError(err)); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  // After a submit, the decided banner takes focus so screen readers land on the result.
  useEffect(() => {
    if (focusBannerRef.current && bannerRef.current) {
      focusBannerRef.current = false;
      bannerRef.current.focus({ preventScroll: false });
    }
  });

  const onDecide = useCallback(async (decision, note, noteHtml) => {
    const body = unwrapBody(await publicApprovalAPI.decide(token, decision, note, noteHtml)) || {};
    focusBannerRef.current = true;
    setDecidedByYou(true);
    setData((prev) => {
      if (!prev) return prev;
      const now = body.decidedAt || new Date().toISOString();
      if (decision === 'clarify') {
        return {
          ...prev,
          approval: {
            ...prev.approval,
            status: 'info_requested',
            clarificationLog: [
              ...(prev.approval.clarificationLog || []),
              { question: note, askedBy: prev.approval.approverName, askedAt: now, answer: null, answeredBy: null, answeredAt: null },
            ],
          },
        };
      }
      const status = body.status || decision;
      return {
        ...prev,
        approval: {
          ...prev.approval,
          status,
          decidedAt: now,
          decidedVia: 'link',
          decisionNote: note,
          decisionNoteHtml: noteHtml,
          approverName: body.approverName || prev.approval.approverName,
        },
        approvers: (prev.approvers || []).map((a) => (a.isYou ? { ...a, status, decidedAt: now } : a)),
      };
    });
  }, [token]);

  const onCopy = useCallback(async () => {
    const ref = data?.ticket?.displayRef;
    if (!ref) return;
    try {
      await navigator.clipboard.writeText(ref);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — nothing to show */
    }
  }, [data]);

  const approval = data?.approval;
  const ticket = data?.ticket;
  const workspaceName = ticket?.workspace?.name || null;

  if (isLoading) {
    return (
      <Shell workspaceName={null} theme={theme} onToggleTheme={toggle} bottomPad={false}>
        <LoadingCard />
      </Shell>
    );
  }

  if (loadError || !approval || !ticket) {
    const kind = loadError?.kind || 'error';
    const agent = loadError?.requestedByName;
    return (
      <Shell workspaceName={null} theme={theme} onToggleTheme={toggle} bottomPad={false}>
        {kind === 'expired' ? (
          <MessageCard icon={Clock} tone="warn" title="This approval link has expired">
            <p>Approval links stop working after their expiry date to keep requests safe.</p>
            <p className="mt-1">Ask {agent ? <span className="font-semibold text-foreground">{agent}</span> : 'the agent who sent it'} for a new link — nothing you did was lost.</p>
          </MessageCard>
        ) : kind === 'invalid' ? (
          <MessageCard icon={Link2Off} title="This approval link isn't valid">
            <p>The link may have been trimmed by your mail client, or the request no longer exists.</p>
            <p className="mt-1">Open the link from the original email again, or ask the agent who sent it for a fresh one.</p>
          </MessageCard>
        ) : (
          <MessageCard icon={CircleAlert} tone="danger" title="We couldn't load this approval">
            <p>{loadError?.message || 'Something went wrong on our side.'}</p>
            <button type="button" onClick={() => window.location.reload()} className="tp-focus-ring mt-3 rounded-[10px] border border-border bg-card px-3.5 py-2 text-[13px] font-semibold text-foreground hover:bg-muted">
              Try again
            </button>
          </MessageCard>
        )}
      </Shell>
    );
  }

  const expired = approval.status === 'expired' || (isOpenForDecision(approval.status) && isPastDate(approval.expiresAt));
  if (expired) {
    return (
      <Shell workspaceName={workspaceName} theme={theme} onToggleTheme={toggle} bottomPad={false}>
        <MessageCard icon={Clock} tone="warn" title="This approval link has expired">
          <p>It expired {formatDay(approval.expiresAt)}. Ask <span className="font-semibold text-foreground">{approval.requestedByName || 'the agent who sent it'}</span> for a new link.</p>
        </MessageCard>
      </Shell>
    );
  }

  const open = isOpenForDecision(approval.status);
  const requester = ticket.requester || {};
  const requesterMeta = [requester.title, requester.location].filter(Boolean).join(', ');

  return (
    <Shell workspaceName={workspaceName} theme={theme} onToggleTheme={toggle} bottomPad={open}>
      {/* No overflow-hidden here: it would turn the card into the scroll container and
          un-stick the decision box (sticky bottom = the mobile bottom sheet). */}
      <article className="tp-card rounded-2xl shadow-soft motion-safe:animate-fadeIn" aria-labelledby="approval-subject">
        <header className="grid items-start gap-4 border-b border-border px-5 py-5 min-[800px]:grid-cols-[minmax(0,1fr)_auto] min-[800px]:px-[26px]">
          <div className="min-w-0">
            <div className="mb-2.5 flex flex-wrap gap-2">
              {approval.category?.name && (
                <span
                  title={approval.category.description || undefined}
                  className="rounded-full bg-blue-50 px-2.5 py-[3px] text-[11px] font-bold uppercase tracking-[0.04em] text-blue-700 dark:bg-blue-500/15 dark:text-blue-200"
                >
                  {approval.category.name}
                </span>
              )}
              <StatusChip status={approval.status} />
            </div>
            <p className="font-mono text-[13px] text-muted-foreground">
              {ticket.displayRef}
              {ticket.createdAt ? ` · created ${formatDay(ticket.createdAt)}` : ''}
              {ticket.dueBy ? ` · due ${formatDay(ticket.dueBy)}` : ''}
            </p>
            <h1 id="approval-subject" className="mb-1.5 mt-1 text-2xl font-bold leading-tight tracking-[-0.01em] text-foreground">
              {ticket.subject || '(no subject)'}
            </h1>
            <p className="text-[13px] text-muted-foreground">
              Requested for <span className="font-semibold text-foreground">{requester.name || 'unknown requester'}</span>
              {requesterMeta ? ` · ${requesterMeta}` : ''}
              {' · sent to you by '}
              <span className="font-semibold text-foreground">{approval.requestedByName || approval.requestedByEmail || 'an agent'}</span>
              {approval.createdAt ? ` on ${formatDayTime(approval.createdAt)}` : ''}
            </p>
          </div>
          <HeaderActions ticket={ticket} copied={copied} onCopy={onCopy} />
        </header>

        <div className="grid min-[800px]:grid-cols-[minmax(0,1fr)_320px]">
          <section
            aria-label="Approval request"
            className="min-w-0 border-b border-border px-5 py-5 min-[800px]:border-b-0 min-[800px]:border-r min-[800px]:px-[26px]"
          >
            <div aria-live="polite" aria-atomic="true">
              <DecisionBanner approval={approval} decidedByYou={decidedByYou} bannerRef={bannerRef} isDark={isDark} />
            </div>
            <RequestNote approval={approval} workspaceName={workspaceName} isDark={isDark} />
            <TicketDescription ticket={ticket} isDark={isDark} />
            <QuestionThread approval={approval} />
            {open && <DecisionBox approval={approval} onDecide={onDecide} />}
          </section>
          <ApprovalRail approval={approval} ticket={ticket} approvers={data.approvers} />
        </div>
      </article>
    </Shell>
  );
}
