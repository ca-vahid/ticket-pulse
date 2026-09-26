/**
 * Auto-help P1 words (plans/AUTO_HELP_P1_PLAN.md): what the agent did with a
 * suggestion, how the follow-up loop ended, and why a run did not stage.
 * Plain words, never pills.
 */

export const DECISION_WORD = {
  agent_sent: 'Sent unchanged',
  agent_edited_sent: 'Edited, then sent',
  agent_dismissed: 'Dismissed',
  auto_sent: 'Sent automatically',
};

export const OUTCOME_WORD = {
  resolved_silence: 'Closed after no reply',
  resolved_confirmed: 'Requester confirmed it worked',
  help_requested: 'Requester still needed help',
  reopened: 'Reopened within 7 days',
  agent_took_over: 'A person took over',
  no_reply_left_open: 'No reply — left open for a person',
  loop_stopped: 'Follow-up stopped (ticket or playbook changed)',
};

export const DISMISS_WORD = { wrong_answer: 'wrong answer', not_needed: 'not needed', other: 'other' };

export const MODE_WORD = {
  shadow: 'Shadow — drafted and recorded, never sent',
  approve: 'Approve — suggested on the ticket; an agent sends it',
  auto: 'Auto — sends on its own',
};

/** One line for a run's P1 life: "Edited, then sent · Closed after no reply". */
export function runLifeLine(run) {
  if (!run) return null;
  const bits = [];
  if (run.decision) {
    bits.push(DECISION_WORD[run.decision] || run.decision.replace(/_/g, ' '));
    if (run.decision === 'agent_dismissed' && run.dismissReason) bits[bits.length - 1] += ` (${DISMISS_WORD[run.dismissReason] || run.dismissReason})`;
  } else if (run.status === 'staged') {
    bits.push('Waiting for an agent');
  }
  if (run.outcome) bits.push(OUTCOME_WORD[run.outcome] || run.outcome.replace(/_/g, ' '));
  else if (run.decision && run.decision !== 'agent_dismissed') bits.push(run.nudgedAt ? 'Checked in — waiting' : 'Waiting on the requester');
  return bits.join(' · ') || null;
}

/** "US$0.0123" — small costs keep their digits; null → "—". */
export function usd(value, { digits = null } = {}) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return '—';
  const d = digits ?? (n === 0 ? 2 : n < 0.1 ? 4 : 2);
  return `US$${n.toFixed(d)}`;
}

/** "12 (40 %)" with the N always visible. */
// Non-breaking space: a count and its percentage never split across lines (390 px).
const NBSP = String.fromCharCode(160);

export function nPct(entry) {
  if (!entry) return '0';
  return entry.pct === null || entry.pct === undefined ? `${entry.n}` : `${entry.n}${NBSP}(${Math.round(entry.pct)}${NBSP}%)`;
}

/**
 * CSAT on the tickets Auto-help closed, always with its N (coverage is low —
 * never a score without how many answered). `satisfied` is optional.
 */
export function csatWords(csat) {
  const n = Number(csat?.n) || 0;
  if (!n) return 'No survey answers yet (N = 0)';
  const answers = `${n} survey answer${n === 1 ? '' : 's'}`;
  if (csat.satisfied !== null && csat.satisfied !== undefined) {
    return `${csat.satisfied} of ${answers} satisfied · average ${csat.avg} out of ${csat.outOf} (N = ${n})`;
  }
  return `Average ${csat.avg} out of ${csat.outOf} across ${answers} (N = ${n})`;
}

function dayWords(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "If they don't reply, we'll check in on Wed, Oct 14 and close it on Fri, Oct 16." */
export function followUpPromise(followUp) {
  const nudge = dayWords(followUp?.nudgeAt);
  if (!nudge) return null;
  const close = dayWords(followUp?.closeAt);
  if (followUp?.onSilence === 'leave_open') {
    return `If they don't reply, Auto-help checks in on ${nudge}${close ? ` and hands it back to a person on ${close}` : ''}.`;
  }
  return `If they don't reply, Auto-help checks in on ${nudge}${close ? ` and closes the ticket on ${close}` : ''}.`;
}

/**
 * A sentence an agent can act on, never a raw transport error. Server
 * refusals (4xx) already carry a written message; everything else is mapped.
 */
export function friendlyError(err, kind = 'send') {
  const verb = kind === 'send' ? 'send' : 'dismiss';
  const status = Number(err?.status) || null;
  const raw = String(err?.message || '').trim();
  const transport = /network error|timeout of [0-9]+ms|failed to fetch|err_network/i;
  if (!status && transport.test(raw)) {
    return 'Couldn’t reach Ticket Pulse. Check your connection, then refresh the ticket before trying again — it may already have gone out.';
  }
  if (status === 401) return 'Your session has ended. Sign in again, then try once more.';
  if (status === 403) return `You don’t have permission to ${verb} Auto-help suggestions in this workspace.`;
  if (status === 404) return 'This suggestion is no longer on the ticket. Refresh to see what changed.';
  if (status === 429) return 'Too many requests just now. Wait a moment and try again.';
  if (status && status >= 500) {
    return kind === 'send'
      ? 'Something went wrong on our side. Refresh the ticket before trying again — it may already have been sent.'
      : 'Something went wrong on our side. Refresh the ticket and try again.';
  }
  if (raw && !/^request failed with status code/i.test(raw) && !transport.test(raw)) return raw;
  return kind === 'send' ? 'Could not send the answer. Refresh the ticket and try again.' : 'Could not dismiss the suggestion. Try again.';
}
