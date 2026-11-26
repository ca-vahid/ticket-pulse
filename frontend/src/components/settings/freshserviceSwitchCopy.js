/**
 * Words for the FreshService switch (Settings → Workspaces, 25 Nov 2026).
 * Plain words only: purposes are never shown by their code names.
 */

export const FS_MODE_META = Object.freeze({
  connected: {
    label: 'Connected',
    dot: 'bg-emerald-500',
    text: 'text-emerald-700 dark:text-emerald-300',
    help: 'Today’s behaviour: sync, copies and write-backs run as usual.',
  },
  shadow: {
    label: 'Shadow',
    dot: 'bg-amber-500',
    text: 'text-amber-700 dark:text-amber-300',
    help: 'Counts what Off would stop; nothing changes yet.',
  },
  off: {
    label: 'Off',
    dot: 'bg-muted-foreground/60',
    text: 'text-foreground/85',
    help: 'Nothing calls FreshService. Ticket Pulse is the only system of record.',
  },
  never_connected: {
    label: 'Never connected',
    dot: 'bg-muted-foreground/40',
    text: 'text-muted-foreground',
    help: 'Never connected to FreshService — nothing to switch.',
  },
});

export const modeMeta = (mode) => FS_MODE_META[mode] || FS_MODE_META.connected;

/** The list's label for each purpose fsGate counts. */
export const PURPOSE_LABELS = Object.freeze({
  sync: 'Ticket sync',
  fast_lane: 'Assignment fast sync',
  deleted_check: 'Deleted-ticket check',
  reconcile: 'Copy check-ups',
  mirror: 'Copies to FreshService',
  writeback: 'Field write-backs (status, priority, category)',
  reply_or_note: 'Replies and notes sent through FreshService',
  thread_pull: 'Conversation pulls',
  attachment: 'Attachment downloads',
  approval_refresh: 'Approval refresh',
  relations: 'Parent and child links',
  tasks: 'Tasks',
  webhook: 'Webhooks from FreshService',
  ai_tools: 'AI reading FreshService',
  assignment_check: 'Assignment live checks',
  daily_review: 'Daily review',
  groups: 'Group lists',
  ticket_types: 'Ticket type sync',
  other: 'Other calls',
});

/** The short words used inside the one-sentence summary. */
const PURPOSE_SHORT = Object.freeze({
  sync: 'sync', fast_lane: 'fast sync', deleted_check: 'deleted checks', reconcile: 'check-ups',
  mirror: 'copies', writeback: 'write-backs', reply_or_note: 'replies and notes', thread_pull: 'conversation pulls',
  attachment: 'attachments', approval_refresh: 'approvals', relations: 'links', tasks: 'tasks', webhook: 'webhooks',
  ai_tools: 'AI reads', assignment_check: 'assignment checks', daily_review: 'daily review', groups: 'groups',
  ticket_types: 'ticket types', other: 'other',
});

export const purposeLabel = (p) => PURPOSE_LABELS[p] || PURPOSE_LABELS.other;

const PACIFIC = 'America/Vancouver';

/**
 * Pacific time, short: "Tue 9:12 AM" within the last six days, otherwise
 * "Tue 17 Nov, 9:12 AM". `now` is injectable for tests.
 */
export function pacificWhen(iso, now = new Date()) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString('en-US', { timeZone: PACIFIC, hour: 'numeric', minute: '2-digit' });
  const weekday = d.toLocaleDateString('en-US', { timeZone: PACIFIC, weekday: 'short' });
  const recent = Math.abs(now.getTime() - d.getTime()) < 6 * 24 * 60 * 60 * 1000;
  if (recent) return `${weekday} ${time}`;
  const day = d.toLocaleDateString('en-GB', { timeZone: PACIFIC, day: 'numeric', month: 'short' });
  return `${weekday} ${day}, ${time}`;
}

/** The Shadow counts, most calls first: [{ purpose, label, n, first, last }]. */
export function shadowRows(shadow) {
  const counts = shadow?.counts || {};
  return Object.entries(counts)
    .map(([purpose, c]) => ({ purpose, label: purposeLabel(purpose), n: Number(c?.n) || 0, first: c?.first || null, last: c?.last || null }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

/**
 * One sentence: "In Shadow since Tue 9:12 AM: 214 FreshService calls Off would
 * stop — sync 180, copies 30, write-backs 4". Quiet: "Nothing has called
 * FreshService since Tue 9:12 AM".
 */
export function shadowSentence(shadow, now = new Date()) {
  const since = pacificWhen(shadow?.since, now);
  const rows = shadowRows(shadow);
  const total = rows.reduce((s, r) => s + r.n, 0);
  if (!total) return since ? `Nothing has called FreshService since ${since}.` : 'Nothing has called FreshService yet.';
  const parts = rows.slice(0, 4).map((r) => `${PURPOSE_SHORT[r.purpose] || 'other'} ${r.n.toLocaleString('en-US')}`);
  const more = rows.length > 4 ? ', and more' : '';
  return `${since ? `In Shadow since ${since}: ` : ''}${total.toLocaleString('en-US')} FreshService call${total === 1 ? '' : 's'} Off would stop — ${parts.join(', ')}${more}.`;
}

/** Where a preflight item's "go and fix it" link points (Settings sections, current workspace). */
export const PREFLIGHT_LINKS = Object.freeze({
  'ticket-mailboxes': { href: '/settings#ticket-mailboxes', label: 'Ticket Mailboxes' },
  'notification-workflows': { href: '/settings#notification-workflows', label: 'Mail Workflows' },
  'ticket-ops': { href: '/settings#ticket-ops', label: 'Ticket Ops' },
});

export const PREFLIGHT_STATE = Object.freeze({
  ok: { word: 'OK', text: 'text-emerald-700 dark:text-emerald-300' },
  warn: { word: 'Check this', text: 'text-amber-700 dark:text-amber-300' },
  block: { word: 'Blocks Off', text: 'text-red-700 dark:text-red-300' },
});

/** The Off steps and where a job stands on them. */
export const OFF_STEPS = Object.freeze(['check', 'adopt', 'switch', 'done']);

export function stepStates(job) {
  if (!job) return OFF_STEPS.map(() => 'todo');
  const at = Math.max(0, OFF_STEPS.indexOf(job.step || 'check'));
  return OFF_STEPS.map((_, i) => {
    if (job.state === 'done') return 'done';
    if (i < at) return 'done';
    if (i === at) return job.state === 'failed' ? 'failed' : 'current';
    return 'todo';
  });
}

/** "Adopted 12 of 55" — the running count while adopting. */
export function adoptCount(job) {
  const total = Number(job?.total) || 0;
  const done = Number(job?.done ?? job?.adopted) || 0;
  return `${Math.min(done, total || done).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;
}

/** The sentence at the end of the Off flow. */
export function outcomeSentence(job, workspaceName) {
  if (!job) return null;
  const n = Number(job.adopted) || 0;
  if (job.state === 'done') {
    return `FreshService is off for ${workspaceName}. ${n === 0 ? 'There were no open FreshService tickets to adopt.' : `${n.toLocaleString('en-US')} ticket${n === 1 ? ' was' : 's were'} adopted and ${n === 1 ? 'is a Ticket Pulse ticket' : 'are Ticket Pulse tickets'} now.`}`;
  }
  if (job.state === 'failed') {
    if (job.error) return job.error;
    return n > 0
      ? `The switch did not finish. ${n.toLocaleString('en-US')} ticket${n === 1 ? ' was' : 's were'} adopted; FreshService is still on. Try again to finish.`
      : 'The switch did not finish. Nothing was switched off; try again.';
  }
  return null;
}

/** What switching back on does, and plainly what it does NOT do. */
export const BACK_ON_LIMITS = 'Tickets and messages created while FreshService was off won’t be copied to it, and edits made while off aren’t sent back. Adopted tickets stay Ticket Pulse tickets.';

export function backOnQuestion(workspaceName) {
  return `Turn FreshService back on for ${workspaceName}? Sync and waiting copies restart. ${BACK_ON_LIMITS}`;
}
