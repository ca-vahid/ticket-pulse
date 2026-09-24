import prisma from './prisma.js';
import statusService from './statusService.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { REQUESTER_PROFILE_SELECT, refreshRequesterEntraProfile } from './requesterProfileService.js';

/**
 * Search v2 / requester page (16 Sep 2026): everything the /requesters/:id
 * page needs in one call — the person (global requester row + directory
 * fields), and their service history in THIS workspace: counts, first / last
 * ticket, median resolution, top categories, plus the tickets where they were
 * an additional requester. One person's own history — never a comparison.
 */

function median(values) {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export async function requesterProfile(requesterId, workspaceId) {
  const id = Number(requesterId);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Invalid requester id');
  const select = { ...REQUESTER_PROFILE_SELECT, freshserviceId: true, isActive: true, createdAt: true, unattended: true, entraMissingAt: true, entraProfileSyncedAt: true };
  let requester = await prisma.requester.findUnique({ where: { id }, select });
  if (!requester) throw new NotFoundError('Requester not found');
  // QA 09-23 #7: the directory lookup only ever ran on ticket activity, so a
  // person without a recent ticket never got their job title / office (29 of
  // 75 Cambio Earth profiles, #800 among them). Opening the page now looks
  // them up once (a week's freshness; a recorded miss is retried after a
  // day), capped at 3 s so the page never waits on the directory.
  const stale = !requester.entraProfileSyncedAt || Date.now() - new Date(requester.entraProfileSyncedAt).getTime() > 7 * 86400e3;
  const recentMiss = requester.entraMissingAt && Date.now() - new Date(requester.entraMissingAt).getTime() < 86400e3;
  if (requester.email && stale && !recentMiss) {
    const refreshed = await Promise.race([
      refreshRequesterEntraProfile(requester).then(() => true).catch(() => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    if (refreshed) requester = (await prisma.requester.findUnique({ where: { id }, select }).catch(() => null)) || requester;
  }

  const base = { workspaceId, requesterId: id, isNoise: false };
  const [openNames, doneNames] = await Promise.all([
    statusService.statusNamesForBase(workspaceId, ['Open', 'Pending']),
    statusService.statusNamesForBase(workspaceId, ['Resolved', 'Closed']),
  ]);
  const [total, open, resolved, first, last, resolvedRows, categories, alsoForCount] = await Promise.all([
    prisma.ticket.count({ where: base }),
    prisma.ticket.count({ where: { ...base, status: { in: openNames } } }),
    prisma.ticket.count({ where: { ...base, status: { in: doneNames } } }),
    prisma.ticket.findFirst({ where: base, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    prisma.ticket.findFirst({ where: base, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, subject: true, status: true } }),
    prisma.ticket.findMany({
      where: { ...base, resolvedAt: { not: null } },
      orderBy: { resolvedAt: 'desc' },
      take: 50,
      select: { createdAt: true, resolvedAt: true },
    }),
    prisma.ticket.groupBy({
      by: ['internalCategoryId'],
      where: { ...base, internalCategoryId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { internalCategoryId: 'desc' } },
      take: 3,
    }).catch(() => []),
    Promise.resolve(0), // additional requesters live on the FS ticket, not in a local table — reserved
  ]);
  const categoryIds = categories.map((c) => c.internalCategoryId).filter(Boolean);
  const categoryRows = categoryIds.length
    ? await prisma.competencyCategory.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } }).catch(() => [])
    : [];
  const categoryName = new Map(categoryRows.map((c) => [c.id, c.name]));
  const resolutionHours = resolvedRows
    .map((t) => (t.resolvedAt && t.createdAt ? (new Date(t.resolvedAt) - new Date(t.createdAt)) / 3600000 : null))
    .filter((h) => Number.isFinite(h) && h >= 0);

  return {
    requester: {
      ...requester,
      freshserviceId: requester.freshserviceId === null || requester.freshserviceId === undefined ? null : String(requester.freshserviceId),
    },
    stats: {
      total,
      open,
      resolved,
      alsoFor: alsoForCount || 0,
      firstTicketAt: first?.createdAt || null,
      lastTicketAt: last?.createdAt || null,
      lastTicket: last ? { id: last.id, subject: last.subject, status: last.status } : null,
      medianResolutionHours: median(resolutionHours),
      resolutionSample: resolutionHours.length,
      topCategories: categories.map((c) => ({ id: c.internalCategoryId, name: categoryName.get(c.internalCategoryId) || null, count: c._count?._all || 0 })).filter((c) => c.name),
    },
  };
}

export default { requesterProfile };
