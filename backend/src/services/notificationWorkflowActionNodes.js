import sanitizeHtml from 'sanitize-html';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import statusService from './statusService.js';
import { prettifyKeyLabel } from './customFieldService.js';
import {
  ADD_NOTE_ACCENTS,
  ADD_NOTE_MAX_FIELDS,
  ADD_NOTE_MAX_TITLE_CHARS,
  ADD_NOTE_PLACEMENTS,
} from './notificationWorkflowDefinition.js';

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
    // Open/Pending-BASE names from the workspace registry (Phase 8b) so
    // custom-status tickets still count toward a technician's load.
    const counts = await prisma.ticket.groupBy({
      by: ['assignedTechId'],
      where: {
        workspaceId,
        status: { in: await statusService.statusNamesForBase(workspaceId, ['Open', 'Pending']) },
        assignedTechId: { in: techs.map((t) => t.id) },
      },
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

const PRIVATE_HOST_PATTERN = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[?::1\]?$)/i;
// IPv6 loopback/link-local/unique-local, incl. IPv4-mapped forms.
const PRIVATE_IPV6_PATTERN = /^(::1|f[cd][0-9a-f]{2}:|fe80:|::ffff:(0*:)?(127\.|10\.|192\.168\.|169\.254\.))/i;

/** Detect private/internal targets given as a non-dotted-quad IP literal:
 *  decimal (2130706433), hex (0x7f000001), or octal (0177.0.0.1). These bypass
 *  the dotted-decimal prefix checks above. */
function isNumericPrivateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '');
  let n = null;
  if (/^0x[0-9a-f]+$/i.test(h)) n = parseInt(h, 16);
  else if (/^0[0-7]+$/.test(h)) n = parseInt(h, 8);
  else if (/^\d+$/.test(h)) n = Number(h);
  if (n === null || !Number.isFinite(n) || n < 0 || n > 0xffffffff) return false;
  const oct = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return oct[0] === 127 || oct[0] === 10 || oct[0] === 0
    || (oct[0] === 192 && oct[1] === 168)
    || (oct[0] === 169 && oct[1] === 254)
    || (oct[0] === 172 && oct[1] >= 16 && oct[1] <= 31)
    || (oct[0] === 100 && oct[1] >= 64 && oct[1] <= 127);
}

export function webhookUrlProblem(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    return 'Webhook URL is not a valid URL';
  }
  if (!['http:', 'https:'].includes(url.protocol)) return 'Webhook URL must be http(s)';
  if (process.env.NOTIFICATION_WEBHOOK_ALLOW_PRIVATE !== 'true') {
    const host = url.hostname;
    if (PRIVATE_HOST_PATTERN.test(host) || PRIVATE_IPV6_PATTERN.test(host) || isNumericPrivateHost(host)) {
      return 'Webhook URL points at a private/internal address';
    }
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

// ------------------------------------------------------------- Teams message

const TEAMS_MAX_RECIPIENTS = 25;

/** Active technicians of the ticket's group (internal group first, else its FreshService group). */
async function ticketGroupEmails(ticket, workspaceId) {
  try {
    let source = ticket;
    // The event context does not always carry the group columns.
    if (ticket?.id && ticket.internalGroupId === undefined && ticket.groupId === undefined) {
      source = await prisma.ticket.findUnique({ where: { id: Number(ticket.id) }, select: { internalGroupId: true, groupId: true } }) || ticket;
    }
    let groupId = Number(source?.internalGroupId) || null;
    if (!groupId && source?.groupId && /^\d+$/.test(String(source.groupId))) {
      const group = await prisma.group.findFirst({ where: { workspaceId, freshserviceId: BigInt(source.groupId) }, select: { id: true } });
      groupId = group?.id || null;
    }
    if (!groupId) return [];
    const members = await prisma.groupMember.findMany({
      where: { groupId },
      select: { technician: { select: { email: true, isActive: true } } },
    });
    return members.filter((m) => m.technician?.isActive && m.technician?.email).map((m) => m.technician.email);
  } catch (error) {
    logger.warn(`Teams message: ticket group lookup failed (non-fatal): ${error.message}`);
    return [];
  }
}

/**
 * send_teams_message (QA 10-08 #3): the Ticket Pulse bot messages IT team
 * members 1:1. Recipients = listed people + members of the chosen internal
 * groups + roles read from the ticket (its assignee, its group). Only active
 * technicians of the workspace are messaged (the service enforces it), the
 * workspace Teams switch is respected, and a run never messages the same
 * person twice. Output carries counts only — never an address (the run log is
 * redacted and teams_deliveries is the per-person record).
 */
export async function executeSendTeamsMessageNode(node, eventContext, { renderedTitle, renderedBody, workspaceId, runId = null, dryRun = false } = {}) {
  const ws = Number(workspaceId || eventContext?.workspace?.id || eventContext?.ticket?.workspaceId);
  const body = String(renderedBody || '').trim();
  if (!body) return { skipped: true, reason: 'No message configured' };
  const roles = Array.isArray(node.data?.roles) ? node.data.roles : [];
  const emails = new Set();
  for (const e of Array.isArray(node.data?.people) ? node.data.people : []) {
    const v = String(e || '').trim().toLowerCase();
    if (v.includes('@')) emails.add(v);
  }
  const groupTokens = (Array.isArray(node.data?.groups) ? node.data.groups : []).filter((g) => Number(g) > 0).map((g) => `internal_group:${Number(g)}`);
  for (const e of await resolveInternalGroupEmails(groupTokens)) emails.add(String(e).toLowerCase());
  if (roles.includes('assigned_agent') && eventContext?.assignedAgent?.email) emails.add(String(eventContext.assignedAgent.email).toLowerCase());
  if (roles.includes('ticket_group')) for (const e of await ticketGroupEmails(eventContext?.ticket, ws)) emails.add(String(e).toLowerCase());

  const recipients = [...emails].slice(0, TEAMS_MAX_RECIPIENTS);
  if (!recipients.length) return { skipped: true, reason: 'Nobody to tell: no person, group member, assignee or ticket-group member was found' };
  const title = String(renderedTitle || '').trim() || 'Ticket Pulse';
  if (dryRun) return { dryRun: true, wouldSend: { recipients: recipients.length, title: title.slice(0, 150) } };

  const { default: teams } = await import('./teamsNotificationService.js');
  const ticketId = Number(eventContext?.ticket?.id) || null;
  const result = await teams.sendWorkflowMessage({
    workspaceId: ws,
    emails: recipients,
    title,
    body,
    ticketId,
    ticketRef: eventContext?.ticket?.displayRef || null,
    includeTicketLink: node.data?.includeTicketLink !== false,
    refKey: `wf:${runId ?? 'x'}:${node.id}`.slice(0, 120),
  });
  if (result.off) return { skipped: true, reason: result.off };
  if (!result.sent && result.failed) throw new Error(result.firstError || 'Teams message could not be sent');
  return { sent: result.sent, skippedPeople: result.skipped, failedPeople: result.failed, recipients: recipients.length, ...(result.firstError ? { note: result.firstError } : {}) };
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

// ------------------------------------------------------------------ add note

/**
 * Server-side sanitizer for text-mode workflow notes. Conservative allowlist
 * kept consistent with the frontend's DOMPurify config for thread bodies:
 * structural/table/list/inline tags plus href/class/style/target survive;
 * script, event handlers (on*), and form controls (button/input/form) are
 * stripped. sanitize-html drops every attribute not allowlisted, which covers
 * the on* family, and discards script content entirely.
 */
export function sanitizeWorkflowNoteHtml(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: [
      'p', 'div', 'span', 'a', 'table', 'tr', 'td', 'th',
      'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'br', 'hr', 'code', 'pre',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'class', 'style'],
      '*': ['class', 'style'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
  }).trim();
}

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function truncateRendered(value, max = ADD_NOTE_MAX_TITLE_CHARS) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function fieldValueText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/** Plain-text card fallback: title/intro lines then "Label: value" lines. */
function fieldCardBodyText({ title, intro, fields }) {
  return [
    ...(title ? [title] : []),
    ...(intro ? [intro] : []),
    ...fields.map((field) => `${field.label}: ${fieldValueText(field.value)}`),
  ].join('\n');
}

/** Sanitizer-safe HTML table fallback for renderers that don't know the
 * field_card discriminator (peek previews, exports). */
function fieldCardBodyHtml({ title, intro, fields }) {
  const rows = fields
    .map((field) => `<tr><th>${escapeHtml(field.label)}</th><td>${escapeHtml(fieldValueText(field.value))}</td></tr>`)
    .join('');
  return [
    '<div class="tp-field-card-fallback">',
    title ? `<p><strong>${escapeHtml(title)}</strong></p>` : '',
    intro ? `<p>${escapeHtml(intro)}</p>` : '',
    `<table>${rows}</table>`,
    '</div>',
  ].join('');
}

/**
 * `add_note` action node (Custom Fields Activation Phase 1): write a protected
 * system note — and/or a pinned card — onto the event's ticket.
 *
 * RE-ENTRANCY: the write is a DIRECT prisma.ticketThreadEntry.create using the
 * approval system-note pattern (ticketApprovalService._decide) on purpose. It
 * must NOT go through ticketService._addThreadEntry, which emits the
 * `ticket.note_added` workflow event — a note-writing workflow triggered by
 * note_added would loop forever. Writing directly means no lifecycle event, no
 * FS mirror job (mirrorState: null), and no way for this node to re-trigger
 * any workflow, by construction.
 */
export async function executeAddNoteNode(node, eventContext, {
  renderedBody = null,
  renderedTitle = null,
  renderedIntro = null,
  workflowId = null,
  workflowName = null,
  runId = null,
  dryRun = false,
} = {}) {
  const ticketId = Number(eventContext.ticket?.id);
  if (!Number.isFinite(ticketId) || ticketId <= 0) return { skipped: true, reason: 'No ticket in event context' };

  const mode = node.data?.mode;
  if (!['text', 'field_card'].includes(mode)) {
    return { skipped: true, reason: 'add_note node has no mode configured' };
  }
  const placement = ADD_NOTE_PLACEMENTS.includes(node.data?.placement) ? node.data.placement : 'note';
  const accent = ADD_NOTE_ACCENTS.includes(node.data?.accent) ? node.data.accent : null;
  const title = truncateRendered(renderedTitle);
  const intro = truncateRendered(renderedIntro);

  // ---- text mode: Liquid already rendered by the engine; sanitize here.
  if (mode === 'text') {
    const bodyHtml = sanitizeWorkflowNoteHtml(renderedBody);
    if (!bodyHtml) return { skipped: true, reason: 'Rendered note body is empty after sanitization' };
    const bodyText = sanitizeHtml(bodyHtml, { allowedTags: [], allowedAttributes: {} }).trim();
    if (dryRun) {
      return { dryRun: true, wouldAddNote: { mode, placement: 'note', bodyPreview: bodyText.slice(0, 300) } };
    }
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, workspaceId: true },
    });
    if (!ticket) return { skipped: true, reason: 'Ticket not found' };
    const entry = await writeSystemNote(ticket, { bodyHtml, bodyText, rawPayload: null });
    return {
      noteEntryId: entry.id,
      mode,
      placement: 'note',
      // Pinned cards are structured (kind='field_card') — free HTML can't pin.
      ...(placement !== 'note' ? { pinnedSkipped: 'Only field-card notes can be pinned' } : {}),
    };
  }

  // ---- field_card mode: structured payload per the frozen client contract.
  const keys = [...new Set((Array.isArray(node.data?.fields) ? node.data.fields : [])
    .map((key) => String(key || '').trim()).filter(Boolean))]
    .slice(0, ADD_NOTE_MAX_FIELDS);
  if (keys.length === 0) return { skipped: true, reason: 'add_note field card has no fields configured' };
  if (dryRun) {
    return { dryRun: true, wouldAddNote: { mode, placement, fields: keys, ...(title ? { title } : {}) } };
  }

  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, workspaceId: true, customFields: true },
  });
  if (!ticket) return { skipped: true, reason: 'Ticket not found' };

  // Inactive definitions included — a retired definition still owns its key's
  // label/type. Keys with no definition fall back to a prettified label.
  const definitions = await prisma.customFieldDefinition.findMany({
    where: { workspaceId: ticket.workspaceId, key: { in: keys } },
  });
  const defByKey = new Map(definitions.map((d) => [d.key, d]));
  const includeEmpty = node.data?.includeEmpty === true;
  const values = ticket.customFields || {};
  const fields = [];
  const skippedEmpty = [];
  for (const key of keys) {
    const definition = defByKey.get(key) || null;
    const raw = values[key];
    const hasValue = raw !== null && raw !== undefined && raw !== '';
    if (!hasValue && !includeEmpty) {
      skippedEmpty.push(key);
      continue;
    }
    fields.push({
      key,
      label: definition?.label || prettifyKeyLabel(key),
      type: definition?.type || 'text',
      value: hasValue ? raw : null, // snapshot: what the workflow saw at write time
    });
  }
  if (fields.length === 0) {
    return { skipped: true, reason: 'No custom-field values to show (every selected field is empty)', skippedEmpty };
  }

  // Frozen contract — the frontend FieldCardNote/PinnedIntakeCard renderers
  // are built against this exact shape. Do not add/rename keys casually.
  const rawPayload = {
    kind: 'field_card',
    v: 1,
    title,
    intro,
    accent,
    fields,
    workflowId,
    runId,
    workflowName,
  };
  const bodyText = fieldCardBodyText({ title, intro, fields });
  const bodyHtml = fieldCardBodyHtml({ title, intro, fields });

  const output = { mode, placement, fieldCount: fields.length, ...(skippedEmpty.length ? { skippedEmpty } : {}) };

  if (placement === 'note' || placement === 'both') {
    const entry = await writeSystemNote(ticket, { bodyHtml, bodyText, rawPayload });
    output.noteEntryId = entry.id;
  }

  if (placement === 'pinned' || placement === 'both') {
    if (!Number.isFinite(Number(workflowId)) || Number(workflowId) <= 0) {
      output.pinnedSkipped = 'No workflow id on this run — pinned cards key on (ticket, kind, workflow)';
    } else {
      // Re-runs refresh the payload and clear any dismissal (per contract).
      const card = await prisma.ticketPinnedCard.upsert({
        where: {
          ticketId_kind_workflowId: { ticketId: ticket.id, kind: 'field_card', workflowId: Number(workflowId) },
        },
        create: {
          ticketId: ticket.id,
          kind: 'field_card',
          payload: rawPayload,
          workflowId: Number(workflowId),
        },
        update: { payload: rawPayload, dismissedAt: null, dismissedBy: null },
      });
      output.pinnedCardId = card.id;
    }
  }

  return output;
}

/** Direct system-note write — see executeAddNoteNode's re-entrancy note. */
async function writeSystemNote(ticket, { bodyHtml, bodyText, rawPayload }) {
  return prisma.ticketThreadEntry.create({
    data: {
      ticketId: ticket.id,
      workspaceId: ticket.workspaceId,
      source: 'ticketpulse_user',
      eventType: 'note',
      actorName: 'Notification workflow',
      actorEmail: null,
      authorType: 'system',
      incoming: false,
      isPrivate: true,
      visibility: 'private',
      bodyText,
      bodyHtml,
      content: bodyText,
      occurredAt: new Date(),
      mirrorState: null, // never mirrored to the FreshService fallback copy
      ...(rawPayload ? { rawPayload } : {}),
    },
  });
}

export default {
  resolveAssignmentTarget,
  applyWorkflowAssignment,
  executeWebhookNode,
  executeCreateChildTicketNode,
  executeRequestApprovalNode,
  executeAddNoteNode,
  executeSendTeamsMessageNode,
  sanitizeWorkflowNoteHtml,
  resolveInternalGroupEmails,
  webhookUrlProblem,
};
