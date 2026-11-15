// Mail Workflows → Preview → "Try it on a past reply" (MEGA 11-14, A4 item 8).
//
// For a "Requester replied" workflow: pick one of the ticket's last 10
// replies, pick what status the ticket should have had ("as if the ticket
// was", Closed by default), tick "Use AI" if the AI reading should run, and
// try it. The run is a preview: nothing is written. The verdict is one line
// from the server's replyPreview; the step results show below as usual.
import { useEffect, useState } from 'react';
import { CheckCircle2, CircleSlash, MessageSquareReply, Play, RefreshCw, TicketPlus } from 'lucide-react';
import { notificationWorkflowAPI } from '../../../services/api';
import { formatPacificWhen } from '../../../utils/ticketDates';
import { REPLY_VERDICT_CHOICES, SENT_BY_CHOICES } from '../ConditionGroupBuilder';

function cls(...parts) {
  return parts.filter(Boolean).join(' ');
}

const DEFAULT_STATUSES = ['Open', 'Pending', 'Resolved', 'Closed'];
const wordsFor = (choices, value) => choices.find((c) => c.value === value)?.label || null;

function minutesWords(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return null;
  if (n < 60) return `${Math.round(n)} min`;
  if (n < 1440 * 2) return `${Math.round(n / 60)} h`;
  return `${Math.round(n / 1440)} days`;
}

/** The verdict line: { tone, headline, why }. null when there is nothing to say. */
export function replyOutcomeLine(replyPreview) {
  if (!replyPreview || typeof replyPreview !== 'object') return null;
  const why = String(replyPreview.why || '').trim() || null;
  switch (replyPreview.outcome) {
  case 'reopen': return { tone: 'reopen', headline: 'Would reopen', why };
  case 'stays_closed': return { tone: 'closed', headline: 'Would stay closed', why };
  case 'new_ticket': return { tone: 'new', headline: 'Would open a new ticket', why };
  default: return { tone: 'none', headline: 'Nothing would change', why };
  }
}

/** "Sent by Requester · Reads as Thanks · Closed 3 days" (what the server worked out). */
export function replyFactsLine(replyPreview) {
  if (!replyPreview) return '';
  const closed = minutesWords(replyPreview.closedMinutes);
  return [
    wordsFor(SENT_BY_CHOICES, replyPreview.sentBy) && `Sent by ${wordsFor(SENT_BY_CHOICES, replyPreview.sentBy)}`,
    wordsFor(REPLY_VERDICT_CHOICES, replyPreview.replyVerdict) && `Reads as ${wordsFor(REPLY_VERDICT_CHOICES, replyPreview.replyVerdict)}`,
    closed && `Closed ${closed}`,
    replyPreview.replyToWorkflowEmail === true && 'Answers a workflow e-mail',
  ].filter(Boolean).join(' · ');
}

const TONES = {
  reopen: { Icon: CheckCircle2, text: 'text-emerald-700 dark:text-emerald-300' },
  closed: { Icon: CircleSlash, text: 'text-amber-700 dark:text-amber-300' },
  new: { Icon: TicketPlus, text: 'text-blue-700 dark:text-blue-300' },
  none: { Icon: CircleSlash, text: 'text-muted-foreground' },
};

export function ReplyOutcome({ replyPreview }) {
  const line = replyOutcomeLine(replyPreview);
  if (!line) return null;
  const tone = TONES[line.tone] || TONES.none;
  const facts = replyFactsLine(replyPreview);
  return (
    <div className="border-b border-border/60 px-4 py-2" data-testid="reply-outcome" role="status">
      <p className="flex min-w-0 items-center gap-2 text-sm">
        <tone.Icon className={cls('h-4 w-4 shrink-0', tone.text)} aria-hidden="true" />
        <span className={cls('font-semibold', tone.text)}>{line.headline}</span>
        {line.why && <span className="min-w-0 truncate text-muted-foreground" title={line.why}>{line.why}</span>}
      </p>
      {facts && <p className="pl-6 text-[11px] text-muted-foreground/75">{facts}</p>}
    </div>
  );
}

function replyLabel(reply) {
  const who = reply.fromName || reply.fromEmail || 'Someone';
  const text = String(reply.preview || '').replace(/\s+/g, ' ').trim();
  const short = text.length > 70 ? `${text.slice(0, 69)}…` : text;
  return `${formatPacificWhen(reply.occurredAt)} · ${who}${short ? ` — ${short}` : ''}`;
}

const selectClass = 'tp-focus-ring h-8 min-w-0 rounded-md border border-border bg-card px-2 text-xs font-medium text-foreground';

export default function ReplyTrialBar({ ticket, statuses = DEFAULT_STATUSES, running = false, onTry, onRunPlain }) {
  const [replies, setReplies] = useState(null); // null = loading
  const [replyId, setReplyId] = useState('');
  const [asStatus, setAsStatus] = useState('Closed');
  const [useAi, setUseAi] = useState(false);
  const ticketId = ticket?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    setReplies(null);
    setReplyId('');
    if (!ticketId) return undefined;
    Promise.resolve()
      .then(() => notificationWorkflowAPI.replyCandidates(ticketId))
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.data) ? res.data.slice(0, 10) : [];
        setReplies(list);
        setReplyId(list[0] ? String(list[0].id) : '');
      })
      .catch(() => { if (!cancelled) setReplies([]); });
    return () => { cancelled = true; };
  }, [ticketId]);

  const statusChoices = statuses.length ? statuses : DEFAULT_STATUSES;
  const loading = replies === null;
  const none = !loading && replies.length === 0;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 bg-muted/30 px-4 py-2 text-xs" data-testid="reply-trial-bar">
      <span className="flex shrink-0 items-center gap-1.5 font-semibold text-foreground">
        <MessageSquareReply className="h-4 w-4 text-primary" aria-hidden="true" />
        Try it on a past reply
      </span>
      {loading && (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Loading replies
        </span>
      )}
      {none && <span className="text-muted-foreground">This ticket has no replies from the requester yet.</span>}
      {!loading && !none && (
        <>
          <label className="flex min-w-0 flex-1 items-center gap-1.5 sm:max-w-[28rem]">
            <span className="shrink-0 text-muted-foreground">Reply</span>
            <select aria-label="Reply" value={replyId} onChange={(e) => setReplyId(e.target.value)} className={cls(selectClass, 'flex-1')}>
              {replies.map((reply) => <option key={reply.id} value={String(reply.id)}>{replyLabel(reply)}</option>)}
            </select>
          </label>
          <label className="flex shrink-0 items-center gap-1.5">
            <span className="text-muted-foreground">As if the ticket was</span>
            <select aria-label="As if the ticket was" value={asStatus} onChange={(e) => setAsStatus(e.target.value)} className={selectClass}>
              {(statusChoices.includes(asStatus) ? statusChoices : [...statusChoices, asStatus]).map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-foreground/85" title="Reads the reply with AI, as a live run would. Costs a little.">
            <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} className="tp-focus-ring h-3.5 w-3.5 accent-[hsl(var(--primary))]" />
            Use AI
          </label>
          <button
            type="button"
            onClick={() => onTry?.({ replyEntryId: Number(replyId), asStatus, executeLlm: useAi })}
            disabled={running || !replyId}
            className="tp-focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {running ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />}
            Try it
          </button>
        </>
      )}
      {onRunPlain && (
        <button
          type="button"
          onClick={() => onRunPlain()}
          disabled={running || !ticket}
          className="tp-focus-ring shrink-0 rounded font-medium text-muted-foreground hover:text-foreground hover:underline disabled:opacity-50"
        >
          Run without a reply
        </button>
      )}
    </div>
  );
}
