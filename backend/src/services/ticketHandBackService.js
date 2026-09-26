import { fromZonedTime } from 'date-fns-tz';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError } from '../utils/errors.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';

/**
 * Hand-backs (QA 09-25 item 3): why an agent gave a ticket back to the queue.
 *
 * One row per unassign done in Ticket Pulse, for both origins:
 *  - TP-born: recorded at unassign time with the rejected episode and the
 *    rebound run attached straight away.
 *  - FS-born: recorded at unassign time (origin 'freshservice'); the sync pass
 *    that later sees FreshService's "set Agent as none" activity attaches the
 *    rejected episode + rebound run (syncService._handleTicketRebound).
 *
 * The reason reaches the assignment AI through `reboundFrom.reason` on the
 * rebound run, and the review surface (Assignment Review → Hand-backs) reads
 * it back as a process signal — never a per-person ranking.
 *
 * Every read here degrades to empty on a missing table/column, so a partial
 * deploy (migration not applied yet) never breaks an unassign.
 */

export const HAND_BACK_REASONS = Object.freeze({
  location: 'Location issue',
  capacity: 'Capacity full',
  competency: 'Competency mismatch',
  other: 'Other',
  skipped: 'No reason given',
});

const REAL_REASON_CODES = new Set(['location', 'capacity', 'competency', 'other']);
const NOTE_MAX = 500;
// FS-born: how far apart our unassign and FreshService's activity timestamp may
// be and still be the same event.
export const FS_ATTACH_WINDOW_MS = 15 * 60 * 1000;

export function handBackLabel(code) {
  return HAND_BACK_REASONS[code] || null;
}

export function isRealReason(code) {
  return REAL_REASON_CODES.has(code);
}

/**
 * Validate a `handBack: { code, note }` payload. Returns null when absent,
 * otherwise `{ code, note }`. 'other' needs a note; 'skipped' carries none.
 */
export function normalizeHandBack(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('handBack must be an object like { code, note }');
  }
  const code = String(input.code || '').trim().toLowerCase();
  if (!HAND_BACK_REASONS[code]) {
    throw new ValidationError('handBack.code must be one of location, capacity, competency, other, skipped');
  }
  let note = input.note === undefined || input.note === null ? '' : String(input.note).trim();
  if (note.length > NOTE_MAX) note = note.slice(0, NOTE_MAX);
  if (code === 'other' && !note) {
    throw new ValidationError('Add a short note when the reason is Other');
  }
  if (code === 'skipped') note = '';
  return { code, note: note || null };
}

/** The `reboundFrom.reason` block the AI prompt and review surfaces read. */
export function reasonForRebound(row) {
  if (!row || !isRealReason(row.reasonCode || row.code)) return null;
  const code = row.reasonCode || row.code;
  return { code, label: handBackLabel(code), note: (row.reasonNote ?? row.note) || null };
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FALLBACK_TIMEZONE = 'America/Los_Angeles';

async function workspaceTimezone(workspaceId) {
  const ws = await Promise.resolve()
    .then(() => prisma.workspace.findUnique({ where: { id: Number(workspaceId) }, select: { defaultTimezone: true } }))
    .catch(() => null);
  return ws?.defaultTimezone || FALLBACK_TIMEZONE;
}

export function parseRangeBound(value, timezone, edge = 'start') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (DATE_ONLY_RE.test(text)) {
    const local = edge === 'end' ? `${text}T23:59:59.999` : `${text}T00:00:00.000`;
    const d = fromZonedTime(local, timezone || FALLBACK_TIMEZONE);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

const ticketHandBackService = {
  async record({
    workspaceId, ticketId, technicianId = null, actor = null, handBack,
    selfHandBack = true, origin, episodeId = null, pipelineRunId = null,
  }) {
    if (!handBack) return null;
    return Promise.resolve()
      .then(() => prisma.ticketHandBack.create({
        data: {
          workspaceId,
          ticketId,
          technicianId: technicianId || null,
          actorTechId: actor?.technicianId || null,
          actorName: actor?.name || actor?.email || null,
          selfHandBack: Boolean(selfHandBack),
          reasonCode: handBack.code,
          reasonNote: handBack.note || null,
          origin,
          episodeId,
          pipelineRunId,
        },
      }))
      .catch((err) => {
        logger.warn(`Hand-back record skipped for ticket ${ticketId}: ${err.message}`);
        return null;
      });
  },

  async attach(id, { episodeId, pipelineRunId } = {}) {
    if (!id) return null;
    const data = {};
    if (episodeId) data.episodeId = episodeId;
    if (pipelineRunId) data.pipelineRunId = pipelineRunId;
    if (!Object.keys(data).length) return null;
    return Promise.resolve()
      .then(() => prisma.ticketHandBack.update({ where: { id }, data }))
      .catch((err) => {
        logger.debug?.(`Hand-back attach skipped (${id}): ${err.message}`);
        return null;
      });
  },

  /**
   * FS-born: the TP-side row waiting for sync to see the rejection. Matches the
   * same ticket (and previous tech when known) within FS_ATTACH_WINDOW_MS of
   * FreshService's unassign timestamp, not yet tied to an episode.
   */
  async findPendingForRebound({ ticketId, technicianId = null, unassignedAt }) {
    const at = unassignedAt ? new Date(unassignedAt) : new Date();
    if (Number.isNaN(at.getTime())) return null;
    return Promise.resolve()
      .then(() => prisma.ticketHandBack.findFirst({
        where: {
          ticketId,
          origin: 'freshservice',
          episodeId: null,
          ...(technicianId ? { technicianId } : {}),
          createdAt: {
            gte: new Date(at.getTime() - FS_ATTACH_WINDOW_MS),
            lte: new Date(at.getTime() + FS_ATTACH_WINDOW_MS),
          },
        },
        orderBy: { createdAt: 'desc' },
      }))
      .catch(() => null);
  },

  async forTicket(ticketId, workspaceId) {
    return Promise.resolve()
      .then(() => prisma.ticketHandBack.findMany({
        where: { ticketId, workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }))
      .then((rows) => rows.map((r) => ({ ...r, reasonLabel: handBackLabel(r.reasonCode) })))
      .catch(() => []);
  },

  /**
   * Latest stored reason per (ticketId, technicianId) — for the AI risk
   * signals and the Bounced tab. Map key: `${ticketId}:${technicianId}`.
   */
  async latestByTicketTech(workspaceId, { ticketIds = [], technicianIds = null, since = null } = {}) {
    const ids = [...new Set(ticketIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const rows = await Promise.resolve()
      .then(() => prisma.ticketHandBack.findMany({
        where: {
          workspaceId,
          ticketId: { in: ids },
          ...(technicianIds ? { technicianId: { in: technicianIds } } : {}),
          ...(since ? { createdAt: { gte: since } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: { ticketId: true, technicianId: true, reasonCode: true, reasonNote: true, createdAt: true },
      }))
      .catch(() => []);
    const map = new Map();
    for (const r of rows || []) {
      const key = `${r.ticketId}:${r.technicianId}`;
      if (!map.has(key)) map.set(key, { ...r, reasonLabel: handBackLabel(r.reasonCode) });
    }
    return map;
  },

  /**
   * Review list: hand-backs for a workspace, newest first, with the ticket,
   * category, who handed it back, and where the AI sent it next. Summary is
   * by reason and by category only — process framing, no per-person tally.
   */
  async listForWorkspace(workspaceId, { reason = null, from = null, to = null, technicianId = null, limit = 200 } = {}) {
    const take = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const createdAt = {};
    // Review S2: a date-only bound is a whole day in the workspace timezone
    // (from = start of that day, to = end of it), never midnight UTC.
    const dateOnly = (v) => typeof v === 'string' && DATE_ONLY_RE.test(v.trim());
    const tz = (dateOnly(from) || dateOnly(to)) ? await workspaceTimezone(workspaceId) : null;
    const fromDate = parseRangeBound(from, tz, 'start');
    const toDate = parseRangeBound(to, tz, 'end');
    if (fromDate) createdAt.gte = fromDate;
    if (toDate) createdAt.lte = toDate;
    const where = {
      workspaceId,
      ...(reason ? { reasonCode: String(reason) } : {}),
      ...(technicianId ? { technicianId: Number(technicianId) } : {}),
      ...(Object.keys(createdAt).length ? { createdAt } : {}),
    };
    const rows = await Promise.resolve()
      .then(() => prisma.ticketHandBack.findMany({ where, orderBy: { createdAt: 'desc' }, take }))
      .catch((err) => {
        logger.debug?.(`Hand-back list unavailable: ${err.message}`);
        return [];
      });
    if (!rows.length) return { items: [], summary: { total: 0, byReason: [], byCategory: [] } };

    const ticketIds = [...new Set(rows.map((r) => r.ticketId))];
    const techIds = [...new Set(rows.flatMap((r) => [r.technicianId, r.actorTechId]).filter(Boolean))];
    const runIds = [...new Set(rows.map((r) => r.pipelineRunId).filter(Boolean))];

    const [tickets, techs, linkedRuns, reboundRuns] = await Promise.all([
      Promise.resolve().then(() => prisma.ticket.findMany({
        where: { id: { in: ticketIds } },
        select: {
          id: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true,
          internalCategoryId: true, internalCategory: { select: { id: true, name: true } },
          tpSkill: true, ticketCategory: true, assignedTechId: true,
        },
      })).catch(() => []),
      Promise.resolve().then(() => prisma.technician.findMany({
        where: { id: { in: techIds } },
        select: { id: true, name: true, photoUrl: true },
      })).catch(() => []),
      runIds.length
        ? Promise.resolve().then(() => prisma.assignmentPipelineRun.findMany({
          where: { id: { in: runIds } },
          select: RUN_SELECT,
        })).catch(() => [])
        : [],
      // Rows not linked to a run yet (FS-born awaiting sync, or a run created
      // after the row): the first rebound run for the ticket after the row.
      Promise.resolve().then(() => prisma.assignmentPipelineRun.findMany({
        where: {
          ticketId: { in: [...new Set(rows.filter((r) => !r.pipelineRunId).map((r) => r.ticketId))] },
          triggerSource: { in: ['rebound', 'rebound_exhausted'] },
          createdAt: { gte: rows[rows.length - 1].createdAt },
        },
        orderBy: { createdAt: 'asc' },
        select: RUN_SELECT,
      })).catch(() => []),
    ]);

    const ticketById = new Map(tickets.map((t) => [t.id, t]));
    const techById = new Map(techs.map((t) => [t.id, t]));
    const runById = new Map(linkedRuns.map((r) => [r.id, r]));
    const assignedIds = [...new Set([...linkedRuns, ...reboundRuns].map((r) => r.assignedTechId).filter(Boolean))]
      .filter((id) => !techById.has(id));
    if (assignedIds.length) {
      const more = await Promise.resolve().then(() => prisma.technician.findMany({
        where: { id: { in: assignedIds } }, select: { id: true, name: true, photoUrl: true },
      })).catch(() => []);
      for (const t of more) techById.set(t.id, t);
    }

    const items = rows.map((r) => {
      const t = ticketById.get(r.ticketId) || null;
      const run = r.pipelineRunId
        ? runById.get(r.pipelineRunId)
        : reboundRuns.find((x) => x.ticketId === r.ticketId && new Date(x.createdAt) >= new Date(r.createdAt));
      const categoryName = t?.internalCategory?.name || t?.tpSkill || t?.ticketCategory || null;
      return {
        id: r.id,
        createdAt: r.createdAt,
        origin: r.origin,
        reasonCode: r.reasonCode,
        reasonLabel: handBackLabel(r.reasonCode),
        reasonNote: r.reasonNote || null,
        selfHandBack: r.selfHandBack !== false,
        episodeId: r.episodeId || null,
        ticket: t ? {
          id: t.id,
          displayRef: ticketDisplayRef(t),
          subject: t.subject,
          categoryId: t.internalCategoryId || null,
          categoryName,
        } : { id: r.ticketId, displayRef: `TP-ID-${r.ticketId}`, subject: null, categoryId: null, categoryName: null },
        technician: r.technicianId ? { id: r.technicianId, name: techById.get(r.technicianId)?.name || null } : null,
        actor: { id: r.actorTechId || null, name: r.actorName || techById.get(r.actorTechId)?.name || null },
        next: describeNext(run, techById),
      };
    });

    const byReason = new Map();
    const byCategory = new Map();
    for (const it of items) {
      byReason.set(it.reasonCode, (byReason.get(it.reasonCode) || 0) + 1);
      const cat = it.ticket.categoryName || 'Uncategorized';
      byCategory.set(cat, (byCategory.get(cat) || 0) + 1);
    }
    return {
      items,
      summary: {
        total: items.length,
        byReason: [...byReason.entries()]
          .map(([code, count]) => ({ code, label: handBackLabel(code), count }))
          .sort((a, b) => b.count - a.count),
        byCategory: [...byCategory.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 12),
      },
    };
  },
};

const RUN_SELECT = {
  id: true, ticketId: true, status: true, decision: true, triggerSource: true,
  assignedTechId: true, recommendation: true, createdAt: true,
};

/** Where the AI sent it next, from the rebound run (plain words). */
export function describeNext(run, techById = new Map()) {
  if (!run) return null;
  const top = Array.isArray(run.recommendation?.recommendations) ? run.recommendation.recommendations[0] : null;
  const assigned = run.assignedTechId ? techById.get(run.assignedTechId)?.name || null : null;
  let text;
  if (run.triggerSource === 'rebound_exhausted') text = 'Stopped re-routing — needs a manual pick';
  else if (assigned && ['approved', 'modified', 'auto_assigned'].includes(run.decision)) text = `Assigned to ${assigned}`;
  else if (run.decision === 'pending_review' && (top?.techName || top?.name)) text = `Suggested ${top.techName || top.name} (awaiting review)`;
  else if (run.decision === 'rejected') text = 'Suggestion dismissed';
  else if (run.status === 'queued') text = 'Queued for business hours';
  else if (run.status === 'running') text = 'AI is choosing';
  else if (top?.techName || top?.name) text = `Suggested ${top.techName || top.name}`;
  else text = run.status ? `Run ${run.status}` : null;
  return { runId: run.id, text, decision: run.decision || null, status: run.status || null };
}

export default ticketHandBackService;
