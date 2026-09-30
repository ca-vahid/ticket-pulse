/**
 * Adaptive Cards for Teams notifications (plans/TEAMS_NOTIFICATIONS_PLAN.md).
 *
 * Same visual language as the approval e-mails: the state as a word with a
 * dot ("● Assigned to you"), the subject as the title, one quiet facts line,
 * the new text, and the actions. Buttons use Action.Execute (Universal
 * Actions) so the bot can answer with a refreshed card in place.
 * Schema 1.5 — what Teams desktop, web and mobile all render.
 */

const SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';

/** Event key → how the card names it and its colour (Adaptive Card text colours). */
export const EVENT_META = {
  assigned: { word: 'Assigned to you', color: 'Accent' },
  unassigned_from_me: { word: 'Reassigned away from you', color: 'Default' },
  requester_replied: { word: 'Requester replied', color: 'Good' },
  teammate_update: { word: 'New note or reply', color: 'Accent' },
  status_changed: { word: 'Status changed', color: 'Default' },
  reopened: { word: 'Reopened', color: 'Warning' },
  park_woke: { word: 'Parked ticket woke up', color: 'Warning' },
  sla_pre_breach: { word: 'SLA about to breach', color: 'Warning' },
  sla_breach: { word: 'SLA breached', color: 'Attention' },
  approval_waiting: { word: 'Approval waiting for you', color: 'Accent' },
  group_unassigned: { word: 'New unassigned ticket', color: 'Accent' },
  test: { word: 'Test message', color: 'Good' },
};

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const statusLine = (word, color) => ({ type: 'TextBlock', text: `● ${word}`, color, weight: 'Bolder', size: 'Small', spacing: 'None' });

function factsLine(t) {
  const bits = [t.ref, t.requesterName, t.priorityLabel ? `${t.priorityLabel} priority` : null, t.dueLabel ? `Due ${t.dueLabel}` : null].filter(Boolean);
  return { type: 'TextBlock', text: bits.join(' · '), isSubtle: true, size: 'Small', wrap: true, spacing: 'Small' };
}

const inputCard = (id, placeholder, verb, label, data) => ({
  type: 'Action.ShowCard',
  title: label,
  card: {
    type: 'AdaptiveCard',
    body: [{ type: 'Input.Text', id, placeholder, isMultiline: true, isRequired: true, errorMessage: 'Write something first' }],
    actions: [{ type: 'Action.Execute', title: verb === 'reply' ? 'Send reply' : 'Add note', verb, data, style: 'positive' }],
  },
});

/**
 * The ticket card.
 * t: { id, workspaceId, ref, subject, requesterName, priorityLabel, dueLabel, url, canWrite, isUnassigned }
 * lines: [{ eventKey, text, at }] — newest first; the first sets the status line.
 */
export function ticketCard(t, lines = [], { outcome = null, actionsOff = false } = {}) {
  const first = lines[0] || { eventKey: 'assigned' };
  const meta = EVENT_META[first.eventKey] || EVENT_META.assigned;
  const data = { ticketId: t.id, workspaceId: t.workspaceId };
  const body = [
    statusLine(outcome?.word || (lines.length > 1 ? `${meta.word} · ${lines.length} updates` : meta.word), outcome?.color || meta.color),
    { type: 'TextBlock', text: clip(t.subject || 'Ticket', 140), weight: 'Bolder', size: 'Medium', wrap: true, spacing: 'Small' },
    factsLine(t),
  ];
  for (const l of lines.slice(0, 4)) {
    if (!l.text) continue;
    body.push({
      type: 'TextBlock',
      text: lines.length > 1 ? `**${EVENT_META[l.eventKey]?.word || 'Update'}** — ${clip(l.text, 280)}` : clip(l.text, 400),
      wrap: true,
      maxLines: 6,
      spacing: 'Medium',
    });
  }
  if (outcome?.detail) body.push({ type: 'TextBlock', text: outcome.detail, isSubtle: true, size: 'Small', wrap: true, spacing: 'Medium' });

  const actions = [];
  if (!actionsOff) {
    if (t.isUnassigned) actions.push({ type: 'Action.Execute', title: 'Take it', verb: 'take', data, style: 'positive' });
    if (t.canWrite) {
      actions.push(inputCard('noteText', 'Internal note — never e-mailed', 'note', 'Add note', data));
      actions.push(inputCard('replyText', 'Reply to the requester', 'reply', 'Reply', data));
    }
    actions.push({ type: 'Action.OpenUrl', title: 'Open', url: t.url });
    actions.push({ type: 'Action.Execute', title: 'Snooze 4 hours', verb: 'snooze', data, mode: 'secondary' });
    actions.push({ type: 'Action.Execute', title: 'Mute this ticket', verb: 'mute', data, mode: 'secondary' });
  } else {
    actions.push({ type: 'Action.OpenUrl', title: 'Open', url: t.url });
  }
  return { type: 'AdaptiveCard', $schema: SCHEMA, version: '1.5', body, actions, msteams: { width: 'Full' } };
}

/**
 * Approval card for the named approver.
 * a: { approvalId, ticketId, workspaceId, categoryName, ref, subject, requesterName, askedByName, note, decisionUrl }
 * stage: 'ask' | { confirm: 'approved'|'rejected' } | { done: 'approved'|'rejected'|'closed', detail }
 */
export function approvalCard(a, stage = 'ask', { error = null } = {}) {
  const data = { approvalId: a.approvalId, ticketId: a.ticketId, workspaceId: a.workspaceId, decisionUrl: a.decisionUrl };
  const facts = [a.ref, a.subject ? clip(a.subject, 90) : null].filter(Boolean).join(' · ');
  const people = [a.requesterName ? `For **${a.requesterName}**` : null, a.askedByName ? `asked by **${a.askedByName}**` : null].filter(Boolean).join(' · ');
  const body = [];
  const actions = [];

  if (stage?.done) {
    const word = stage.done === 'approved' ? 'Approved' : stage.done === 'rejected' ? 'Not approved' : 'Already decided';
    body.push(statusLine(word, stage.done === 'approved' ? 'Good' : stage.done === 'rejected' ? 'Attention' : 'Default'));
  } else if (stage?.confirm) {
    body.push(statusLine(stage.confirm === 'approved' ? 'Confirm: approve' : 'Confirm: do not approve', stage.confirm === 'approved' ? 'Good' : 'Attention'));
  } else {
    body.push(statusLine(EVENT_META.approval_waiting.word, 'Accent'));
  }
  body.push({ type: 'TextBlock', text: clip(a.categoryName || a.subject || 'Approval', 120), weight: 'Bolder', size: 'Medium', wrap: true, spacing: 'Small' });
  if (facts) body.push({ type: 'TextBlock', text: facts, isSubtle: true, size: 'Small', wrap: true, spacing: 'Small' });
  if (people) body.push({ type: 'TextBlock', text: people, size: 'Small', wrap: true, spacing: 'Small' });
  if (a.note && !stage?.done) body.push({ type: 'TextBlock', text: clip(a.note, 400), wrap: true, maxLines: 6, spacing: 'Medium' });
  if (error) body.push({ type: 'TextBlock', text: error, color: 'Attention', wrap: true, spacing: 'Medium' });

  if (stage?.done) {
    if (stage.detail) body.push({ type: 'TextBlock', text: stage.detail, isSubtle: true, size: 'Small', wrap: true, spacing: 'Medium' });
    actions.push({ type: 'Action.OpenUrl', title: 'Open the approval', url: a.decisionUrl });
  } else if (stage?.confirm) {
    const rejecting = stage.confirm === 'rejected';
    body.push({
      type: 'Input.Text',
      id: 'decisionNote',
      label: rejecting ? 'Reason (required — the agents read it)' : 'Note (optional)',
      isMultiline: true,
      isRequired: rejecting,
      errorMessage: 'Add a reason for not approving',
    });
    actions.push({ type: 'Action.Execute', title: rejecting ? 'Yes, do not approve' : 'Yes, approve', verb: 'approval.confirm', data: { ...data, decision: stage.confirm }, style: rejecting ? 'destructive' : 'positive' });
    actions.push({ type: 'Action.Execute', title: 'Go back', verb: 'approval.back', data, associatedInputs: 'none' });
  } else {
    actions.push({ type: 'Action.Execute', title: 'Approve', verb: 'approval.prepare', data: { ...data, decision: 'approved' }, style: 'positive' });
    actions.push({ type: 'Action.Execute', title: 'Decline', verb: 'approval.prepare', data: { ...data, decision: 'rejected' } });
    actions.push({ type: 'Action.OpenUrl', title: 'Ask a question', url: `${a.decisionUrl}${a.decisionUrl.includes('?') ? '&' : '?'}intent=ask` });
    actions.push({ type: 'Action.OpenUrl', title: 'Open the approval', url: a.decisionUrl, mode: 'secondary' });
  }
  return { type: 'AdaptiveCard', $schema: SCHEMA, version: '1.5', body, actions, msteams: { width: 'Full' } };
}

/** Daily digest. rows: [{ ref, subject, dueLabel, overdue, url }]; counts: { open, overdue, dueToday, waiting } */
export function digestCard({ name, counts, rows, queueUrl, held = [] }) {
  const body = [
    statusLine(`Your tickets today${name ? ` — ${name.split(' ')[0]}` : ''}`, 'Accent'),
    {
      type: 'TextBlock',
      text: [`**${counts.open}** open`, counts.overdue ? `**${counts.overdue}** overdue` : null, counts.dueToday ? `**${counts.dueToday}** due today` : null, counts.waiting ? `**${counts.waiting}** waiting for your reply` : null].filter(Boolean).join(' · '),
      wrap: true,
      spacing: 'Small',
    },
  ];
  for (const r of rows.slice(0, 8)) {
    body.push({
      type: 'ColumnSet',
      spacing: 'Small',
      selectAction: { type: 'Action.OpenUrl', url: r.url },
      columns: [
        { type: 'Column', width: 'auto', items: [{ type: 'TextBlock', text: r.ref, isSubtle: true, size: 'Small' }] },
        { type: 'Column', width: 'stretch', items: [{ type: 'TextBlock', text: clip(r.subject, 80), wrap: false, size: 'Small' }] },
        { type: 'Column', width: 'auto', items: [{ type: 'TextBlock', text: r.dueLabel || '', size: 'Small', color: r.overdue ? 'Attention' : 'Default' }] },
      ],
    });
  }
  if (held.length) {
    body.push({ type: 'TextBlock', text: 'Held for this digest', weight: 'Bolder', size: 'Small', spacing: 'Large' });
    for (const h of held.slice(0, 8)) body.push({ type: 'TextBlock', text: `${EVENT_META[h.eventKey]?.word || 'Update'} — ${clip(h.summary, 120)}`, wrap: true, size: 'Small', spacing: 'Small' });
  }
  return {
    type: 'AdaptiveCard',
    $schema: SCHEMA,
    version: '1.5',
    body,
    actions: [{ type: 'Action.OpenUrl', title: 'Open my tickets', url: queueUrl }],
    msteams: { width: 'Full' },
  };
}

/** Plain text cards for help / welcome / errors. */
export function textCard(title, lines = [], actions = []) {
  return {
    type: 'AdaptiveCard',
    $schema: SCHEMA,
    version: '1.5',
    body: [
      { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
      ...lines.map((l) => ({ type: 'TextBlock', text: l, wrap: true, spacing: 'Small' })),
    ],
    actions,
  };
}

export default { EVENT_META, ticketCard, approvalCard, digestCard, textCard };
