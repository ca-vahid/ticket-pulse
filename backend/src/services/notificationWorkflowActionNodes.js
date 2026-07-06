import prisma from './prisma.js';
import logger from '../utils/logger.js';

/**
 * Executors for the Phase 3 orchestrator action nodes (assign, webhook, child
 * ticket, approval) + assignment strategies. Kept out of the engine file so
 * the engine stays a runner; every executor is origin-aware and returns a
 * plain JSON-able output object (never throws for business-level skips —
 * throwing is reserved for onError='fail' semantics).
 */

const WORKFLOW_ACTOR = Object.freeze({ name: 'Notification workflow', email: null });

// ---------------------------------------------------------------- assignment

async function activeTechnicians(workspaceId) {
  return prisma.technician.findMany({
    where: { workspaceId, isActive: true },
    select: { id: true, name: true },
    orderBy: { id: 'asc' },
  });
}

/**
 * Stateless assignment strategies:
 *  - least_loaded: fewest Open/Pending tickets right now (tie → lowest id).
 *  - round_robin: least-recently assigned (never-assigned first) — approximates
 *    rotation without a cursor to persist.
 */
export async function resolveAssignmentTarget(workspaceId, assignTo = {}) {
  const mode = assignTo.mode || 'none';
  if (mode === 'tech') {
    const techId = Number(assignTo.technicianId);
    if (!Number.isFinite(techId) || techId <= 0) return { error: 'No technician configured' };
    const tech = await prisma.technician.findFirst({
      where: { id: techId, workspaceId, isActive: true },
      select: { id: true, name: true },
    });
    return tech ? { techId: tech.id, techName: tech.name, mode } : { error: 'Configured technician is not active in this workspace' };
  }

  const techs = await activeTechnicians(workspaceId);
  if (techs.length === 0) return { error: 'No active technicians in this workspace' };

  if (mode === 'least_loaded') {
    const counts = await prisma.ticket.groupBy({
      by: ['assignedTechId'],
      where: { workspaceId, status: { in: ['Open', 'Pending'] }, assignedTechId: { in: techs.map((t) => t.id) } },
      _count: { _all: true },
    });
    const byTech = new Map(counts.map((c) => [c.assignedTechId, c._count._all]));
    let best = null;
    for (const tech of techs) {
      const load = byTech.get(tech.id) || 0;
      if (!best || load < best.load) best = { tech, load };
    }
    return { techId: best.tech.id, techName: best.tech.name, mode, load: best.load };
  }

  if (mode === 'round_robin') {
    const latest = await prisma.ticketAssignmentEpisode.groupBy({
      by: ['technicianId'],
      where: { workspaceId, technicianId: { in: techs.map((t) => t.id) } },
      _max: { startedAt: true },
    });
    const lastByTech = new Map(latest.map((row) => [row.technicianId, row._max.startedAt?.getTime() || 0]));
    let best = null;
    for (const tech of techs) {
      const last = lastByTech.get(tech.id) || 0; // never assigned → 0 → first pick
      if (!best || last < best.last) best = { tech, last };
    }
    return { techId: best.tech.id, techName: best.tech.name, mode };
  }

  return { error: `Unknown assignment mode "${mode}"` };
}

/** Apply an assignment origin-aware: TP-born via ticketService, FS-born via the FS write-back. */
export async function applyWorkflowAssignment(ticket, techId) {
  const { default: ticketService } = await import('./ticketService.js');
  if (ticket.origin === 'ticketpulse') {
    await ticketService.assignTicket(ticket.id, ticket.workspaceId, techId, WORKFLOW_ACTOR);
    return { via: 'ticketpulse' };
  }
  // FS-born: responder write-back through the existing confirmed-update path.
  await ticketService.updateFsTicket(ticket.id, ticket.workspaceId, { assignedTechId: techId }, WORKFLOW_ACTOR);
  return { via: 'freshservice_writeback' };
}

// ------------------------------------------------------------------ webhook

const PRIVATE_HOST_PATTERN = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

export function webhookUrlProblem(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    return 'Webhook URL is not a valid URL';
  }
  if (!['http:', 'https:'].includes(url.protocol)) return 'Webhook URL must be http(s)';
  if (process.env.NOTIFICATION_WEBHOOK_ALLOW_PRIVATE !== 'true' && PRIVATE_HOST_PATTERN.test(url.hostname)) {
    return 'Webhook URL points at a private/internal address';
  }
  return null;
}

export async function executeWebhookNode(node, { renderedBody, dryRun = false }) {
  const url = String(node.data?.url || '').trim();
  const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(node.data?.method || '').toUpperCase())
    ? String(node.data.method).toUpperCase()
    : 'POST';
  const timeoutMs = Math.min(30000, Math.max(1000, Number(node.data?.timeoutMs) || 5000));

  const problem = webhookUrlProblem(url);
  if (problem) return { skipped: true, reason: problem };
  if (dryRun) return { dryRun: true, wouldCall: { url, method, timeoutMs } };

  const headers = { 'content-type': 'application/json', ...(node.data?.headers || {}) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(method === 'GET' ? {} : { body: renderedBody || '{}' }),
      signal: controller.signal,
      redirect: 'error',
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      // Truncated snippet only — webhook responses are audit context, not data.
      responseSnippet: text ? text.slice(0, 2000) : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------- child ticket

export async function executeCreateChildTicketNode(node, eventContext, { renderedSubject, renderedDescription, dryRun = false }) {
  const parentId = Number(eventContext.ticket?.id);
  if (!Number.isFinite(parentId) || parentId <= 0) return { skipped: true, reason: 'No ticket in event context' };
  const subject = String(renderedSubject || '').trim();
  if (!subject) return { skipped: true, reason: 'No subject configured' };
  if (dryRun) return { dryRun: true, wouldCreate: { subject } };

  const parent = await prisma.ticket.findUnique({
    where: { id: parentId },
    select: { id: true, workspaceId: true, requesterId: true, nativeNumber: true, freshserviceTicketId: true, origin: true },
  });
  if (!parent) return { skipped: true, reason: 'Parent ticket not found' };
  const parentRef = parent.origin === 'ticketpulse' && parent.nativeNumber
    ? `TP-${parent.nativeNumber}`
    : `#${parent.freshserviceTicketId || parent.id}`;

  try {
    const { default: ticketService } = await import('./ticketService.js');
    const created = await ticketService.createTicket(parent.workspaceId, {
      requesterId: parent.requesterId || undefined,
      subject,
      description: `${renderedDescription || ''}\n\n— Created by a workflow from ticket ${parentRef}.`.trim(),
      priority: Number(node.data?.priority) || 2,
      internalCategoryId: Number(node.data?.internalCategoryId) || undefined,
      notifyRequester: node.data?.notifyRequester === true,
    }, WORKFLOW_ACTOR);
    return { createdTicketId: created.id, displayRef: created.displayRef || null, parentRef };
  } catch (error) {
    logger.warn(`Workflow create_child_ticket failed: ${error.message}`);
    return { skipped: true, reason: error.message };
  }
}

// ---------------------------------------------------------------- approval

export async function executeRequestApprovalNode(node, eventContext, { renderedNote, dryRun = false }) {
  const ticketId = Number(eventContext.ticket?.id);
  const approvalCategoryId = Number(node.data?.approvalCategoryId);
  if (!Number.isFinite(ticketId) || ticketId <= 0) return { skipped: true, reason: 'No ticket in event context' };
  if (!Number.isFinite(approvalCategoryId) || approvalCategoryId <= 0) {
    return { skipped: true, reason: 'No approval category configured' };
  }
  if (dryRun) return { dryRun: true, wouldRequest: { approvalCategoryId } };

  const workspaceId = Number(eventContext.workspace?.id);
  try {
    const { default: ticketApprovalService } = await import('./ticketApprovalService.js');
    const result = await ticketApprovalService.request(ticketId, workspaceId, {
      approvalCategoryId,
      note: renderedNote || 'Requested automatically by a workflow.',
    }, WORKFLOW_ACTOR);
    return { requested: true, approvals: result.count ?? null };
  } catch (error) {
    // "already an open request" and friends are business skips, not failures.
    return { skipped: true, reason: error.message };
  }
}

// ----------------------------------------------------------- group recipients

/** Resolve `internal_group:<id>` recipient tokens to member emails. */
export async function resolveInternalGroupEmails(tokens = []) {
  const groupIds = (Array.isArray(tokens) ? tokens : [])
    .map((token) => String(token || '').match(/^internal_group:(\d+)$/)?.[1])
    .filter(Boolean)
    .map(Number);
  if (groupIds.length === 0) return [];
  try {
    const members = await prisma.groupMember.findMany({
      where: { groupId: { in: groupIds } },
      select: { technician: { select: { email: true, isActive: true } } },
    });
    return members
      .filter((m) => m.technician?.isActive && m.technician?.email)
      .map((m) => m.technician.email);
  } catch (error) {
    logger.warn(`internal_group recipient resolution failed (non-fatal): ${error.message}`);
    return [];
  }
}

export default {
  resolveAssignmentTarget,
  applyWorkflowAssignment,
  executeWebhookNode,
  executeCreateChildTicketNode,
  executeRequestApprovalNode,
  resolveInternalGroupEmails,
  webhookUrlProblem,
};
