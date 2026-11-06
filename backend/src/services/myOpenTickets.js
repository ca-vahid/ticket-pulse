/**
 * "My open tickets" — one rule for every place that lists them outside the
 * Tickets page: the Teams daily digest, the "my tickets" bot command and the
 * Teams assistant's my_tickets tool (plans/TEAMS_BOT_COMMANDS_PLAN.md).
 *
 * 7 Oct 2026 (Vahid's digest read "200 open, 200 overdue"): "open" was "no
 * resolved or closed date", which also matched Closed and Deleted tickets that
 * never got those dates, and the numbers were counted from a list capped at
 * 200 rows. Open means an Open- or Pending-base status in the ticket's own
 * workspace (the same rule as the Tickets page), noise left out, and the
 * numbers are real counts.
 */
import prisma from './prisma.js';

export const PACIFIC = 'America/Vancouver';

export function localDay(tz, at = new Date()) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || PACIFIC }).format(at); } catch { return at.toISOString().slice(0, 10); }
}

/**
 * One { workspace, my technician ids there, open-like status names } scope
 * per workspace the person is an agent in. Status names come from the
 * workspace's registry (custom open/pending statuses count); a registry that
 * cannot be read falls back to Open / Pending. `bases` narrows to one base
 * (['Pending'] for "waiting on someone").
 */
export async function openTicketScopes(techs, { bases = ['Open', 'Pending'] } = {}) {
  const byWs = new Map();
  for (const t of techs || []) {
    if (!byWs.has(t.workspaceId)) byWs.set(t.workspaceId, []);
    byWs.get(t.workspaceId).push(t.id);
  }
  const scopes = [];
  for (const [workspaceId, ids] of byWs) {
    let names = [...bases];
    try {
      const { default: statusService } = await import('./statusService.js');
      const found = await statusService.statusNamesForBase(workspaceId, bases);
      if (Array.isArray(found) && found.length) names = found;
    } catch { /* keep the fallback */ }
    scopes.push({ workspaceId, assignedTechId: { in: ids }, status: { in: names } });
  }
  return scopes;
}

const ROW_SELECT = { id: true, workspaceId: true, subject: true, dueBy: true, priority: true, status: true, freshserviceTicketId: true, nativeNumber: true, origin: true };

/**
 * The person's open tickets: up to `take` rows (soonest due first) plus the
 * true counts. `filter` narrows the rows (and adds its own count):
 *   open | overdue | due_today | due_this_week | pending
 * @returns {{ rows, counts: { open, overdue, dueToday, matching } } | null}  null = no agent rows
 */
export async function myOpenTickets(techs, { take = 10, now = new Date(), tz = null, filter = 'open', select = null } = {}) {
  if (!techs?.length) return null;
  const zone = tz || techs[0].timezone || PACIFIC;
  const scopes = await openTicketScopes(techs);
  const where = { OR: scopes, isNoise: false };
  const today = localDay(zone, now);
  const weekEnd = new Date(now.getTime() + 7 * 86400_000);
  let rowWhere = where;
  if (filter === 'overdue') rowWhere = { ...where, dueBy: { lt: now } };
  else if (filter === 'due_today') rowWhere = { ...where, dueBy: { gte: new Date(now.getTime() - 36 * 3600_000), lte: new Date(now.getTime() + 36 * 3600_000) } };
  else if (filter === 'due_this_week') rowWhere = { ...where, dueBy: { gte: now, lte: weekEnd } };
  else if (filter === 'pending') rowWhere = { OR: await openTicketScopes(techs, { bases: ['Pending'] }), isNoise: false };
  const [rows, openCount, overdueCount, nearDue] = await Promise.all([
    prisma.ticket.findMany({
      where: rowWhere,
      select: select || ROW_SELECT,
      orderBy: [{ dueBy: { sort: 'asc', nulls: 'last' } }, { id: 'desc' }],
      // "Due today" is filtered after the read (a local calendar day), so read a little more.
      take: filter === 'due_today' ? Math.max(take, 200) : take,
    }),
    prisma.ticket.count({ where }),
    prisma.ticket.count({ where: { ...where, dueBy: { lt: now } } }),
    // "Due today" is a local calendar day: read the due times around now and test each in the agent's time zone.
    prisma.ticket.findMany({ where: { ...where, dueBy: { gte: new Date(now.getTime() - 36 * 3600 * 1000), lte: new Date(now.getTime() + 36 * 3600 * 1000) } }, select: { dueBy: true }, take: 1000 }),
  ]);
  const dueTodayCount = nearDue.filter((t) => t.dueBy && localDay(zone, t.dueBy) === today).length;
  let list = rows;
  if (filter === 'due_today') list = rows.filter((t) => t.dueBy && localDay(zone, t.dueBy) === today).slice(0, take);
  let matching = openCount;
  if (filter === 'overdue') matching = overdueCount;
  else if (filter === 'due_today') matching = dueTodayCount;
  else if (filter === 'due_this_week' || filter === 'pending') {
    matching = await prisma.ticket.count({ where: rowWhere }).catch(() => list.length);
  }
  return { rows: list, counts: { open: openCount, overdue: overdueCount, dueToday: dueTodayCount, matching }, tz: zone, today };
}

export default { openTicketScopes, myOpenTickets, localDay };
