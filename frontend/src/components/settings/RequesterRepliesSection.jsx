import { useEffect, useState } from 'react';
import { ArrowUpRight, MessageSquareReply } from 'lucide-react';
import { notificationWorkflowAPI, ticketsAPI } from '../../services/api';
import FancySelect from '../common/FancySelect';
import { Switch as SharedSwitch } from '../ui/switch';

/**
 * Settings → Ticket Ops → When a requester replies (13 Oct 2026; trimmed in
 * MEGA 11-14, plans/MEGA_1114_PLAN.md A5).
 *
 * Reopening a ticket on a reply is no longer set here: the mail workflow
 * "Reopen on requester reply" decides it (with its thank-you and loop-guard
 * switches), and this page says so with a link. What stays:
 *  - the owner-away and new-request switches (they run after the workflows,
 *    only when the ticket is open);
 *  - the monthly limit for reading replies (the reading the workflows ask for).
 * Switches save at once. Plain words only — no codes, no JSON.
 */
const FOLLOW_UP_SWITCHES = [
  {
    key: 'rerouteWhenOwnerAway',
    label: 'Send the ticket back for assignment when its owner is away',
    help: 'When a reply leaves the ticket open and its owner is away for more than one working day, the owner is cleared and the ticket goes through assignment again, with a private note saying why. A single day off, working from home and half days do not count.',
  },
  {
    key: 'suggestNewRequest',
    label: 'Suggest a new ticket when a reply is really a new request',
    help: 'When a reply reopens a ticket that was resolved more than a day ago and asks for something else, the ticket shows a suggestion to split the reply into its own ticket. Nothing is split until a person says so.',
  },
];
const CAP_LABEL = 'Monthly limit for reading replies';

// QA 11-05 #1: the shared app switch, with this page's "<label> on/off" name.
function Switch({ checked, disabled, label, onClick }) {
  return (
    <SharedSwitch
      checked={checked === true}
      aria-label={`${label} ${checked ? 'on' : 'off'}`}
      onCheckedChange={() => onClick?.()}
      disabled={disabled}
    />
  );
}

const money = (n) => (Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : null);

/** "/workflows", or the reopen workflow itself when the workspace has exactly one. */
export function reopenWorkflowHref(reopenWorkflows = []) {
  const enabled = (reopenWorkflows || []).filter((w) => w && w.isEnabled);
  const only = enabled.length === 1 ? enabled[0] : (reopenWorkflows || []).length === 1 ? reopenWorkflows[0] : null;
  return only?.id ? `/workflows?wf=${encodeURIComponent(only.id)}` : '/workflows';
}

export default function RequesterRepliesSection() {
  const [ctx, setCtx] = useState(null); // null = loading
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [reopenHref, setReopenHref] = useState('/workflows');

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => ticketsAPI.getRequesterReplySettings())
      .then((res) => { if (!cancelled) setCtx((res?.data?.data ?? res?.data) || {}); })
      .catch(() => { if (!cancelled) setCtx({}); });
    // The link opens the reopen workflow itself when there is one to open.
    Promise.resolve()
      .then(() => notificationWorkflowAPI.reopenCheck())
      .then((res) => { if (!cancelled) setReopenHref(reopenWorkflowHref(res?.data?.reopenWorkflows)); })
      .catch(() => { /* the plain /workflows link stays */ });
    return () => { cancelled = true; };
  }, []);

  const loading = ctx === null;
  const capChoices = Array.isArray(ctx?.replyCheckCapChoices) && ctx.replyCheckCapChoices.length ? ctx.replyCheckCapChoices : [5, 10, 25, 50];

  const save = async (key, patch) => {
    if (loading || busy) return;
    setBusy(key);
    setError(null);
    try {
      const res = await ticketsAPI.updateRequesterReplySettings(patch);
      setCtx((res?.data?.data ?? res?.data) || {});
    } catch (e) {
      setError(e.response?.data?.message || e.message);
    } finally {
      setBusy(null);
    }
  };

  const budget = ctx?.replyCheckBudget || {};
  const spent = money(budget.spentUsd);

  return (
    <section className="tp-card rounded-xl p-4" aria-label="When a requester replies">
      <div className="flex items-center gap-2 mb-1">
        <MessageSquareReply className="w-4 h-4 text-blue-500" aria-hidden="true" />
        <h3 className="text-sm font-bold text-foreground">When a requester replies</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-3" data-testid="reopen-pointer">
        Reopening is set in{' '}
        <a href={reopenHref} className="tp-focus-ring inline-flex items-center gap-0.5 rounded font-semibold text-primary hover:underline">
          Mail Workflows → Reopen on requester reply
          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
        </a>
      </p>

      <ul className="divide-y divide-border/60">
        {FOLLOW_UP_SWITCHES.map((s) => (
          <li key={s.key} className="flex items-start justify-between gap-3 py-2.5 first:pt-0">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground/85">{s.label}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{s.help}</p>
            </div>
            <Switch
              checked={ctx?.[s.key] === true}
              disabled={loading || busy !== null}
              label={s.label}
              onClick={() => save(s.key, { [s.key]: !(ctx?.[s.key] === true) })}
            />
          </li>
        ))}

        {/* The reading the reply workflows ask for (thank-you, out-of-office, new request). */}
        <li className="py-2.5 last:pb-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-sm font-semibold text-foreground/85">{CAP_LABEL}</span>
            <div className="w-24">
              <FancySelect
                value={String(ctx?.replyCheckMonthlyCapUsd ?? 10)}
                onChange={(v) => save('cap', { replyCheckMonthlyCapUsd: Number(v) })}
                options={capChoices.map((n) => ({ value: String(n), label: `$${n}` }))}
                disabled={loading || busy !== null}
                aria-label={CAP_LABEL}
                className="h-8"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-1" data-testid="reply-check-spend">
            {spent
              ? `This month: ${spent}${Number.isFinite(Number(budget.checks)) ? `, ${budget.checks} ${budget.checks === 1 ? 'reply' : 'replies'} read` : ''}. At the limit, replies reopen.`
              : 'This month: not known yet. Until it is, replies reopen.'}
          </p>
        </li>
      </ul>
      {error && <p className="text-xs text-red-600 dark:text-red-300 mt-2" role="alert">{error}</p>}
    </section>
  );
}
