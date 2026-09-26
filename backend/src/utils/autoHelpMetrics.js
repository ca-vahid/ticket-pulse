/**
 * How Auto-help closes count in people metrics — ONE rule, used everywhere
 * (plans/AUTO_HELP_P1_PLAN.md §3, team-safe).
 *
 * A ticket Auto-help resolved (tickets.resolved_by_kind = 'auto_help') is not
 * an agent's close:
 *   - per-agent numbers leave it out of BOTH sides — close counts, close
 *     rates (numerator and denominator), resolution times, "resolved" counts;
 *     assigned / workload counts are untouched (it was still their ticket);
 *   - team totals keep counting it as resolved, and show how many of those
 *     were "by Auto-help" on their own line (never per person).
 *
 * Three forms of the same rule: a JS row predicate, a Prisma where fragment
 * and a SQL fragment. Rows must carry `resolvedByKind` (select it).
 */

export const AUTO_HELP_RESOLVED_KIND = 'auto_help';

/** The ticket was resolved by Auto-help (not by a person). */
export function isAutoHelpResolved(ticket) {
  return ticket?.resolvedByKind === AUTO_HELP_RESOLVED_KIND;
}

/** The ticket counts in per-agent metrics (anything not resolved by Auto-help). */
export function countsForAgentMetrics(ticket) {
  return !isAutoHelpResolved(ticket);
}

/**
 * Prisma where fragment: tickets that count in per-agent metrics. A plain
 * `{ not: 'auto_help' }` would also drop NULLs (SQL three-valued logic), so
 * NULL is spelled out. Combine with AND (see withAgentMetricTickets).
 */
export const AGENT_METRIC_TICKET_WHERE = Object.freeze({
  OR: [{ resolvedByKind: null }, { resolvedByKind: { not: AUTO_HELP_RESOLVED_KIND } }],
});

/** Prisma where fragment: tickets Auto-help resolved (the team's "by Auto-help" line). */
export const AUTO_HELP_RESOLVED_WHERE = Object.freeze({ resolvedByKind: AUTO_HELP_RESOLVED_KIND });

/** `where` narrowed to tickets that count in per-agent metrics (keeps the caller's own OR intact). */
export function withAgentMetricTickets(where = {}) {
  return { AND: [where || {}, AGENT_METRIC_TICKET_WHERE] };
}

function sqlAlias(alias) {
  const a = String(alias ?? '').trim();
  if (a && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) throw new Error(`Bad SQL alias: ${alias}`);
  return a ? `${a}.` : '';
}

/** SQL fragment (use with Prisma.raw): the row counts in per-agent metrics. */
export function agentMetricTicketSql(alias = 't') {
  return `${sqlAlias(alias)}resolved_by_kind IS DISTINCT FROM '${AUTO_HELP_RESOLVED_KIND}'`;
}

/** SQL fragment (use with Prisma.raw): the row was resolved by Auto-help. */
export function autoHelpResolvedTicketSql(alias = 't') {
  return `${sqlAlias(alias)}resolved_by_kind = '${AUTO_HELP_RESOLVED_KIND}'`;
}

/**
 * Split a list of tickets by the rule.
 * @param {Array} tickets
 * @param {(t) => boolean} isClosed  the workspace's terminal-status test
 * @returns {{ agentTickets, agentClosed, autoHelpClosed }}
 *   agentTickets    tickets that count for the person (rate denominator)
 *   agentClosed     their closes (rate numerator)
 *   autoHelpClosed  closed by Auto-help (team line only)
 */
export function splitAgentCloses(tickets = [], isClosed = () => false) {
  const agentTickets = [];
  const agentClosed = [];
  const autoHelpClosed = [];
  for (const t of tickets || []) {
    if (isAutoHelpResolved(t)) {
      if (isClosed(t)) autoHelpClosed.push(t);
      continue;
    }
    agentTickets.push(t);
    if (isClosed(t)) agentClosed.push(t);
  }
  return { agentTickets, agentClosed, autoHelpClosed };
}

/** Close rate in % (one decimal), Auto-help closes out of both sides; 0 when nothing counts. */
export function agentCloseRatePct(closed, assigned, autoHelpClosed = 0) {
  const base = Math.max(0, (Number(assigned) || 0) - (Number(autoHelpClosed) || 0));
  return base ? Number((((Number(closed) || 0) / base) * 100).toFixed(1)) : 0;
}
