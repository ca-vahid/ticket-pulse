import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError } from '../utils/errors.js';

/**
 * Autofill v2 (MEGA 09-02 Phase AF2) — TicketIntakeRun persistence.
 *
 * ai_provider_attempts only stores tokens/timing; this table keeps WHAT the
 * model proposed (the full `data` the route returned), what the resolvers
 * made of it, and — once the agent creates the ticket — which proposals the
 * created ticket actually kept (`resolved.applied`). Images are never
 * stored: request_summary holds names/sizes and the first 500 chars of text.
 */

const TEXT_PREVIEW_CHARS = 500;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function presentRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ticketId: row.ticketId ?? null,
    ticket: row.ticket
      ? { id: row.ticket.id, nativeNumber: row.ticket.nativeNumber ?? null, subject: row.ticket.subject ?? null }
      : undefined,
    actorEmail: row.actorEmail ?? null,
    actorName: row.actorName ?? null,
    textChars: row.textChars ?? 0,
    imageCount: row.imageCount ?? 0,
    provider: row.provider ?? null,
    model: row.model ?? null,
    durationMs: row.durationMs ?? null,
    inputTokens: row.inputTokens ?? null,
    outputTokens: row.outputTokens ?? null,
    requestSummary: row.requestSummary ?? null,
    result: row.result ?? null,
    resolved: row.resolved ?? null,
    createdAt: row.createdAt,
  };
}

function lower(value) {
  return value ? String(value).trim().toLowerCase() : null;
}

/** Which proposals did the created ticket keep? null = the run proposed nothing for that field. */
export function computeApplied(result, ticket) {
  const r = result && typeof result === 'object' ? result : {};
  const proposedRequesterEmail = lower(r.requesterMatch?.candidate?.email)
    || (String(r.requesterNameOrEmail || '').includes('@') ? lower(r.requesterNameOrEmail) : null);
  const ticketRequesterEmail = lower(ticket?.requester?.email);
  const ticketCategory = ticket?.internalCategory?.name
    ? `${ticket.internalCategory.name}${ticket.internalSubcategory?.name ? ` > ${ticket.internalSubcategory.name}` : ''}`
    : null;
  const proposedAssigneeId = r.assigneeMatch?.technician?.id ?? null;
  const ticketAssigneeId = ticket?.assignedTechId ?? ticket?.assignedTech?.id ?? null;

  return {
    subject: r.subject ? String(r.subject).trim() === String(ticket?.subject || '').trim() : null,
    requester: proposedRequesterEmail ? proposedRequesterEmail === ticketRequesterEmail : null,
    category: r.categoryHint ? lower(r.categoryHint) === lower(ticketCategory) : null,
    priority: r.priorityHint ? Number(r.priorityHint) === Number(ticket?.priority) : null,
    type: r.typeHint ? lower(r.typeHint) === lower(ticket?.ticketType) : null,
    assignee: proposedAssigneeId ? proposedAssigneeId === ticketAssigneeId : null,
  };
}

class TicketIntakeRunService {
  /**
   * Persist one extraction. Never throws — a bookkeeping failure must not
   * fail an Autofill the agent is waiting on; the caller gets `null`.
   */
  async record({ workspaceId, actor = null, text = '', images = [], data, meta = {} }) {
    try {
      const row = await prisma.ticketIntakeRun.create({
        data: {
          workspaceId,
          actorEmail: actor?.email ? String(actor.email).toLowerCase() : null,
          actorName: actor?.name || null,
          textChars: Number(meta.textChars ?? text.length) || 0,
          imageCount: Number(meta.imageCount ?? images.length) || 0,
          provider: meta.provider || null,
          model: meta.model || null,
          durationMs: Number.isFinite(meta.durationMs) ? Math.round(meta.durationMs) : null,
          inputTokens: Number.isFinite(meta.inputTokens) ? meta.inputTokens : null,
          outputTokens: Number.isFinite(meta.outputTokens) ? meta.outputTokens : null,
          requestSummary: {
            sourceSummary: data?.sourceSummary || null,
            textPreview: String(text || '').slice(0, TEXT_PREVIEW_CHARS),
            images: images.map((img) => ({
              name: img.fileName || null,
              size: img.buffer?.length || img.size || 0,
              type: img.mimeType || null,
            })),
          },
          result: data ?? {},
          resolved: {
            requesterMatch: data?.requesterMatch ?? null,
            assigneeMatch: data?.assigneeMatch ?? null,
            conversingAgent: data?.conversingAgent ?? null,
            categoryLevel: data?.categoryLevel ?? null,
          },
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      logger.warn(`Intake run not recorded (non-fatal): ${err.message}`);
      return null;
    }
  }

  /** Validate a client-supplied run id BEFORE the ticket is created. Returns the run row. */
  async assertLinkable(runId, workspaceId) {
    const id = Number(runId);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('intakeRunId must be a positive integer');
    const run = await prisma.ticketIntakeRun.findFirst({
      where: { id, workspaceId },
      select: { id: true, ticketId: true, result: true, resolved: true },
    });
    if (!run) throw new ValidationError('Unknown intakeRunId for this workspace');
    if (run.ticketId) throw new ValidationError(`Intake run ${id} is already linked to ticket ${run.ticketId}`);
    return run;
  }

  /**
   * Link a run to the ticket it produced and record which proposals the
   * ticket kept. Non-fatal (logs + returns null) so a bookkeeping failure
   * never fails the create that already happened.
   */
  async linkToTicket(runId, workspaceId, ticket) {
    try {
      const run = await this.assertLinkable(runId, workspaceId);
      const resolved = run.resolved && typeof run.resolved === 'object' ? run.resolved : {};
      const applied = computeApplied(run.result, ticket);
      const updated = await prisma.ticketIntakeRun.update({
        where: { id: run.id },
        data: {
          ticketId: ticket.id,
          resolved: { ...resolved, applied, linkedAt: new Date().toISOString() },
        },
        select: { id: true, ticketId: true, resolved: true },
      });
      return updated;
    } catch (err) {
      logger.warn(`Intake run ${runId} not linked to ticket ${ticket?.id} (non-fatal): ${err.message}`);
      return null;
    }
  }

  async listForTicket(ticketId, workspaceId) {
    const rows = await prisma.ticketIntakeRun.findMany({
      where: { ticketId, workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return rows.map(presentRun);
  }

  async listRecent(workspaceId, limit = DEFAULT_LIST_LIMIT) {
    const take = Math.min(MAX_LIST_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIST_LIMIT));
    const rows = await prisma.ticketIntakeRun.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take,
      include: { ticket: { select: { id: true, nativeNumber: true, subject: true } } },
    });
    return rows.map(presentRun);
  }
}

const ticketIntakeRunService = new TicketIntakeRunService();
export default ticketIntakeRunService;
