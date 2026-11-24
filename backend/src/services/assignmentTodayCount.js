import prisma from './prisma.js';
import { getTodayRange } from '../utils/timezone.js';

/**
 * "Today" for assignment — one definition everywhere (QA 11-23 item 3).
 *
 * The tickets given to the person since local midnight (the workspace's zone,
 * Pacific by default), by anyone — automation, a coordinator, the person
 * themselves, FreshService — counted ONCE per ticket however often it went
 * back and forth. A ticket they handed back still counts: it landed on them.
 *
 * Before this, Level match counted assignment episodes (so a ticket that
 * bounced back to someone counted twice) and get_assignment_risk_signals,
 * find_matching_agents and get_workload_stats counted tickets CREATED today
 * that the person still holds (so an older ticket given to them this morning,
 * or one they passed on, did not count at all). One run showed the same
 * person at "4 today" and `todayAssigned: 1`.
 *
 * Two sources, joined by ticket:
 *   1. assignment episodes that started today (every assignment path writes one);
 *   2. tickets they hold now whose assigned_at is today — the backstop for an
 *      FS-side assignment the activity sync has not turned into an episode yet.
 * `excludeTicketId` leaves out the ticket being decided.
 *
 * Never throws: a source that cannot be read counts nothing.
 * @returns {Promise<Map<number, number>>} technicianId → tickets today
 */
export async function countAssignedToday({
  workspaceId, technicianIds = [], timezone = 'America/Vancouver', now = new Date(), excludeTicketId = null,
} = {}) {
  const ids = [...new Set((technicianIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const tickets = new Map(ids.map((id) => [id, new Set()]));
  if (!ids.length) return new Map();
  const ws = Number(workspaceId);
  const exclude = Number(excludeTicketId) || null;
  const { start } = getTodayRange(timezone || 'America/Vancouver', now);
  const notThis = exclude ? { NOT: { ticketId: exclude } } : {};
  const notThisTicket = exclude ? { NOT: { id: exclude } } : {};

  const soft = (fn) => Promise.resolve().then(fn).then((rows) => (Array.isArray(rows) ? rows : [])).catch(() => []);
  const [episodes, held] = await Promise.all([
    soft(() => prisma.ticketAssignmentEpisode.findMany({
      where: { workspaceId: ws, technicianId: { in: ids }, startedAt: { gte: start, lte: now }, ...notThis },
      select: { technicianId: true, ticketId: true, startedAt: true },
    })),
    soft(() => prisma.ticket.findMany({
      where: { workspaceId: ws, assignedTechId: { in: ids }, assignedAt: { gte: start, lte: now }, ...notThisTicket },
      select: { id: true, assignedTechId: true },
    })),
  ]);

  const inDay = (at) => !at || (new Date(at) >= start && new Date(at) <= now);
  for (const e of episodes) {
    if (!e || (exclude && Number(e.ticketId) === exclude) || !inDay(e.startedAt)) continue;
    tickets.get(Number(e.technicianId))?.add(Number(e.ticketId));
  }
  for (const t of held) {
    if (!t || (exclude && Number(t.id) === exclude)) continue;
    tickets.get(Number(t.assignedTechId))?.add(Number(t.id));
  }
  return new Map([...tickets].map(([id, set]) => [id, set.size]));
}

export default { countAssignedToday };
