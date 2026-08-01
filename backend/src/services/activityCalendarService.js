import prisma from './prisma.js';
import { formatDateInTimezone } from '../utils/timezone.js';

/**
 * Bucket ticket rows into per-day handled counts.
 *
 * "Handled" mirrors the dashboard's assignment-date convention: a ticket
 * counts on the day it was first assigned to the tech (firstAssignedAt),
 * falling back to createdAt when assignment metadata is missing — the exact
 * same rule statsCalculator uses for ticketsOnDate/weeklyTickets, so the
 * heatmap always agrees with the page's period counts.
 *
 * @param {Array<{firstAssignedAt: Date|string|null, createdAt: Date|string|null}>} rows
 * @param {string} timezone IANA timezone used for day boundaries (default PT,
 *   matching the rest of the dashboard).
 * @returns {Array<{date: string, count: number}>} sorted ascending by date
 */
export function bucketTicketsByDay(rows, timezone = 'America/Los_Angeles') {
  const counts = new Map();
  for (const row of rows || []) {
    const ts = row?.firstAssignedAt || row?.createdAt;
    if (!ts) continue;
    const d = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(d.getTime())) continue;
    const key = formatDateInTimezone(d, timezone);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Per-day handled counts for one technician over the trailing `days` window.
 * Single light query — only two timestamp columns are selected, no includes.
 */
export async function getActivityCalendar({ technicianId, workspaceId, days = 365, timezone = 'America/Los_Angeles' }) {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.ticket.findMany({
    where: {
      assignedTechId: technicianId,
      workspaceId,
      OR: [
        { firstAssignedAt: { gte: cutoff } },
        { firstAssignedAt: null, createdAt: { gte: cutoff } },
      ],
    },
    select: { firstAssignedAt: true, createdAt: true },
  });
  return bucketTicketsByDay(rows, timezone);
}

export default { bucketTicketsByDay, getActivityCalendar };
