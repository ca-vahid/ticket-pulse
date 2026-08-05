import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { TICKET_ORIGIN, ticketDisplayRef } from '../utils/ticketOrigin.js';
import { sendTransactionalEmail } from './transactionalEmailService.js';

// Local status <-> FreshService task status. FS: 1 Open, 2 In Progress, 3 Completed.
const STATUSES = ['open', 'in_progress', 'done'];
const TO_FS_STATUS = { open: 1, in_progress: 2, done: 3 };
const FROM_FS_STATUS = { 1: 'open', 2: 'in_progress', 3: 'done' };

// "Notify before" choices (QA 08-04 #8b) — mirrors the FreshService modal:
// Never / 15 / 30 / 45 minutes / 1 hour / 2 hours.
const REMINDER_MINUTES = [15, 30, 45, 60, 120];

const TASK_SELECT = {
  id: true, ticketId: true, title: true, description: true, status: true,
  assignedTechId: true, dueAt: true, notifyAgent: true, notifiedAt: true,
  remindBeforeMinutes: true, reminderSentAt: true,
  origin: true, fsTaskId: true, sortOrder: true, createdByName: true,
  completedAt: true, createdAt: true, updatedAt: true,
  assignedTech: { select: { id: true, name: true, photoUrl: true, email: true, freshserviceId: true } },
};

/**
 * Parse a task due input robustly (QA 08-04 #8a). The UI now posts a full ISO
 * datetime, but legacy/API callers may still send a bare "YYYY-MM-DD" — which
 * `new Date()` would read as UTC MIDNIGHT (shifting the visible date/time for
 * anyone west of Greenwich). Bare dates are instead anchored at 5:00 PM
 * server-local — the same end-of-business default the picker uses.
 */
function parseDueAt(value) {
  if (value === null || value === undefined || value === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  const date = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 17, 0, 0, 0)
    : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError('Invalid due date');
  return date;
}

/** Normalize a remindBeforeMinutes input: null (never) or one of the presets. */
function parseRemindBefore(value) {
  if (value === null || value === undefined || value === '') return null;
  const minutes = Number(value);
  if (!REMINDER_MINUTES.includes(minutes)) {
    throw new ValidationError(`Notify-before must be one of: ${REMINDER_MINUTES.join(', ')} minutes`);
  }
  return minutes;
}

// FreshService returns task descriptions as HTML (e.g. `<div style="…">…</div>`).
// Store them as readable plain text so the UI doesn't surface raw markup/metadata
// (QA 07-20 #12).
function fsPlainText(html) {
  if (!html) return null;
  const text = String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

function shape(task) {
  if (!task) return task;
  const { fsTaskId, assignedTech, ...rest } = task;
  return {
    ...rest,
    fsTaskId: fsTaskId !== null && fsTaskId !== undefined ? String(fsTaskId) : null,
    assignee: assignedTech ? { id: assignedTech.id, name: assignedTech.name, photoUrl: assignedTech.photoUrl } : null,
  };
}

class TicketTaskService {
  async _ticket(ticketId, workspaceId) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      select: { id: true, workspaceId: true, origin: true, freshserviceTicketId: true, nativeNumber: true, subject: true },
    });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);
    return ticket;
  }

  /** List tasks for a ticket. FS-born tickets pull live from FreshService (and
   *  refresh the local shadow cache); TP-born read from our own table. */
  async listForTicket(ticketId, workspaceId) {
    const ticket = await this._ticket(ticketId, workspaceId);
    if (ticket.origin === TICKET_ORIGIN.FRESHSERVICE && ticket.freshserviceTicketId) {
      await this._syncFromFs(ticket).catch((err) => logger.warn(`FS task sync failed for ${ticketDisplayRef(ticket)} (serving cache): ${err.message}`));
    } else if (ticket.freshserviceTicketId) {
      // TP-born but mirrored to FS: pull back status changes made on the
      // FreshService copy so "mark done in FS" reflects here too (QA 07-17 #7).
      await this._syncMirroredStatusFromFs(ticket).catch((err) => logger.warn(`FS mirror status sync failed for ${ticketDisplayRef(ticket)} (serving cache): ${err.message}`));
    }
    const rows = await prisma.ticketTask.findMany({
      where: { ticketId, workspaceId },
      select: TASK_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return rows.map(shape);
  }

  async create(ticketId, workspaceId, input, actor) {
    const ticket = await this._ticket(ticketId, workspaceId);
    const title = String(input?.title || '').trim();
    if (!title) throw new ValidationError('Task title is required');
    const status = STATUSES.includes(input?.status) ? input.status : 'open';
    const assignedTechId = input?.assignedTechId !== null && input?.assignedTechId !== undefined ? Number(input.assignedTechId) : null;
    const assignee = await this._resolveAssignee(assignedTechId, workspaceId);
    const dueAt = parseDueAt(input?.dueAt);
    const remindBeforeMinutes = parseRemindBefore(input?.remindBeforeMinutes);
    const notifyAgent = input?.notifyAgent !== false;

    const maxOrder = await prisma.ticketTask.aggregate({ where: { ticketId, workspaceId }, _max: { sortOrder: true } });
    const base = {
      workspaceId, ticketId, title,
      description: input?.description ? String(input.description) : null,
      status, assignedTechId: assignee?.id ?? null, dueAt, notifyAgent,
      remindBeforeMinutes: dueAt ? remindBeforeMinutes : null,
      sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
      createdBy: actor?.email || null, createdByName: actor?.name || actor?.email || null,
      completedAt: status === 'done' ? new Date() : null,
    };

    if (ticket.origin === TICKET_ORIGIN.FRESHSERVICE && ticket.freshserviceTicketId) {
      // FS-born: FreshService owns the task (and sends the assignee's email).
      const fsTask = await this._fsCreate(ticket, base, assignee);
      const row = await prisma.ticketTask.create({
        data: { ...base, origin: TICKET_ORIGIN.FRESHSERVICE, fsTaskId: fsTask?.id ? BigInt(fsTask.id) : null, notifiedAt: notifyAgent ? new Date() : null },
        select: TASK_SELECT,
      });
      return shape(row);
    }

    // TP-born: we own it. Mirror to the FS fallback copy when the ticket is
    // mirrored and the assignee has an FS agent id; notify the assignee ourselves.
    const row = await prisma.ticketTask.create({ data: { ...base, origin: TICKET_ORIGIN.TICKETPULSE }, select: TASK_SELECT });
    await this._writeBackToFs(ticket, row).catch((err) => logger.warn(`Task FS write-back failed (non-fatal): ${err.message}`));
    const updated = await this._maybeNotify(ticket, row, assignee);
    return shape(updated || row);
  }

  async update(taskId, workspaceId, patch, actor = null, expectedTicketId = null) {
    const task = await prisma.ticketTask.findFirst({ where: { id: Number(taskId), workspaceId }, select: TASK_SELECT });
    if (!task) throw new NotFoundError('Task not found');
    // Guard against /tickets/<other>/tasks/<taskId> mutating a task that belongs
    // to a different ticket in the same workspace.
    if (expectedTicketId !== null && task.ticketId !== Number(expectedTicketId)) throw new NotFoundError('Task not found on this ticket');
    const ticket = await this._ticket(task.ticketId, workspaceId);

    const data = {};
    if (patch.title !== undefined) {
      const t = String(patch.title || '').trim();
      if (!t) throw new ValidationError('Task title cannot be empty');
      data.title = t;
    }
    if (patch.description !== undefined) data.description = patch.description ? String(patch.description) : null;
    if (patch.status !== undefined) {
      if (!STATUSES.includes(patch.status)) throw new ValidationError(`Status must be one of: ${STATUSES.join(', ')}`);
      data.status = patch.status;
      data.completedAt = patch.status === 'done' ? new Date() : null;
    }
    if (patch.dueAt !== undefined) data.dueAt = parseDueAt(patch.dueAt);
    if (patch.remindBeforeMinutes !== undefined) data.remindBeforeMinutes = parseRemindBefore(patch.remindBeforeMinutes);
    // Re-arm the due reminder whenever the deadline or the notify-before
    // setting moves — the old "sent" stamp described a reminder for a deadline
    // that no longer exists (same rule the SLA trigger stamps follow).
    if (data.dueAt !== undefined || data.remindBeforeMinutes !== undefined) data.reminderSentAt = null;
    if (patch.notifyAgent !== undefined) data.notifyAgent = patch.notifyAgent !== false;
    let reassignedTo = null;
    if (patch.assignedTechId !== undefined) {
      const assignee = await this._resolveAssignee(patch.assignedTechId !== null && patch.assignedTechId !== undefined ? Number(patch.assignedTechId) : null, workspaceId);
      data.assignedTechId = assignee?.id ?? null;
      if (assignee && assignee.id !== task.assignedTechId) { reassignedTo = assignee; data.notifiedAt = null; }
    }
    if (Object.keys(data).length === 0) throw new ValidationError('Nothing to update');

    // FS-born or an FS-mirrored TP task: push the change to FreshService.
    if (task.fsTaskId && ticket.freshserviceTicketId) {
      if (ticket.origin === TICKET_ORIGIN.FRESHSERVICE) {
        // FS owns this task. If the write fails, surface it — otherwise the
        // local row updates optimistically and the next _syncFromFs silently
        // reverts it, so the UI shows "Done" then flips back to "Open".
        await this._fsUpdate(ticket, task, data);
      } else {
        await this._fsUpdate(ticket, task, data).catch((err) => logger.warn(`FS task mirror update failed (non-fatal): ${err.message}`));
      }
    }
    let row = await prisma.ticketTask.update({ where: { id: task.id }, data, select: TASK_SELECT });
    if (data.status !== undefined && data.status !== task.status) {
      await this._logStatusChange(ticket, task, task.status, data.status, actor);
    }
    if (reassignedTo && ticket.origin === TICKET_ORIGIN.TICKETPULSE) {
      row = (await this._maybeNotify(ticket, row, reassignedTo)) || row;
    }
    return shape(row);
  }

  /** Record a task status change on the ticket's Activity timeline. */
  async _logStatusChange(ticket, task, oldStatus, newStatus, actor) {
    const label = { open: 'Open', in_progress: 'In progress', done: 'Done' };
    try {
      await prisma.ticketActivity.create({
        data: {
          ticketId: ticket.id,
          activityType: 'task_status_changed',
          performedBy: actor?.name || actor?.email || 'System',
          performedAt: new Date(),
          details: {
            oldStatus: label[oldStatus] || oldStatus,
            newStatus: label[newStatus] || newStatus,
            note: `Task: ${task.title}`,
            actorName: actor?.name || null,
          },
        },
      });
    } catch (err) {
      logger.warn(`Failed to log task status change (non-fatal): ${err.message}`);
    }
  }

  async remove(taskId, workspaceId, _actor = null, expectedTicketId = null) {
    const task = await prisma.ticketTask.findFirst({ where: { id: Number(taskId), workspaceId } });
    if (!task) throw new NotFoundError('Task not found');
    if (expectedTicketId !== null && task.ticketId !== Number(expectedTicketId)) throw new NotFoundError('Task not found on this ticket');
    if (task.fsTaskId) {
      const ticket = await this._ticket(task.ticketId, workspaceId);
      if (ticket.freshserviceTicketId) {
        const client = await this._fsClient(workspaceId);
        if (ticket.origin === TICKET_ORIGIN.FRESHSERVICE) {
          // FS owns the task — a swallowed failure lets _syncFromFs resurrect
          // the row on the next list. Surface it instead.
          if (client) await client.deleteTicketTask(Number(ticket.freshserviceTicketId), Number(task.fsTaskId));
        } else {
          await client?.deleteTicketTask(Number(ticket.freshserviceTicketId), Number(task.fsTaskId))
            .catch((err) => logger.warn(`FS task mirror delete failed (non-fatal): ${err.message}`));
        }
      }
    }
    await prisma.ticketTask.delete({ where: { id: task.id } });
    return { deleted: true };
  }

  // ---- internals -------------------------------------------------------

  async _resolveAssignee(assignedTechId, workspaceId) {
    if (!assignedTechId) return null;
    const tech = await prisma.technician.findFirst({
      where: { id: assignedTechId, workspaceId },
      select: { id: true, name: true, email: true, freshserviceId: true },
    });
    if (!tech) throw new ValidationError('Assigned agent not found in this workspace');
    return tech;
  }

  async _fsClient(workspaceId) {
    const { default: mirrorService } = await import('./mirrorService.js');
    return mirrorService.getInteractiveClient(workspaceId);
  }

  _toFsPayload(base, assignee, { includeReminder = false } = {}) {
    const payload = { title: base.title, status: TO_FS_STATUS[base.status] || 1 };
    if (base.description) payload.description = base.description;
    if (base.dueAt) payload.due_date = new Date(base.dueAt).toISOString();
    if (assignee?.freshserviceId) payload.agent_id = Number(assignee.freshserviceId);
    // FS-born only: FreshService owns notifications there, so forward the
    // notify-before as FS's own reminder (seconds). TP-born mirror copies never
    // get it — TP sends that reminder itself and FS doubling it would spam.
    if (includeReminder && base.remindBeforeMinutes) payload.notify_before = base.remindBeforeMinutes * 60;
    return payload;
  }

  async _fsCreate(ticket, base, assignee) {
    const client = await this._fsClient(ticket.workspaceId);
    if (!client) throw new ValidationError('FreshService is not configured for this workspace');
    return client.createTicketTask(Number(ticket.freshserviceTicketId), this._toFsPayload(base, assignee, { includeReminder: true }));
  }

  async _fsUpdate(ticket, task, data) {
    const client = await this._fsClient(ticket.workspaceId);
    if (!client) return;
    const fsBorn = ticket.origin === TICKET_ORIGIN.FRESHSERVICE;
    const patch = {};
    if (data.title !== undefined) patch.title = data.title;
    if (data.description !== undefined) patch.description = data.description || '';
    if (data.status !== undefined) patch.status = TO_FS_STATUS[data.status] || 1;
    if (data.dueAt !== undefined) patch.due_date = data.dueAt ? new Date(data.dueAt).toISOString() : null;
    if (fsBorn && data.remindBeforeMinutes !== undefined) patch.notify_before = data.remindBeforeMinutes ? data.remindBeforeMinutes * 60 : null;
    if (data.assignedTechId !== undefined) {
      const assignee = data.assignedTechId ? await prisma.technician.findUnique({ where: { id: data.assignedTechId }, select: { freshserviceId: true } }) : null;
      patch.agent_id = assignee?.freshserviceId ? Number(assignee.freshserviceId) : null;
    }
    if (Object.keys(patch).length > 0) {
      await client.updateTicketTask(Number(ticket.freshserviceTicketId), Number(task.fsTaskId), patch);
    }
  }

  /** TP-born mirror write-back: only when the ticket is mirrored to FS AND the
   *  assignee has an FS agent id (local agents can't be assigned FS tasks). */
  async _writeBackToFs(ticket, row) {
    if (!ticket.freshserviceTicketId) return;
    if (row.assignedTechId && !row.assignedTech?.freshserviceId) return; // local agent — stays TP-only
    const client = await this._fsClient(ticket.workspaceId);
    if (!client) return;
    const fsTask = await client.createTicketTask(
      Number(ticket.freshserviceTicketId),
      this._toFsPayload(row, row.assignedTech),
    );
    if (fsTask?.id) {
      await prisma.ticketTask.update({ where: { id: row.id }, data: { fsTaskId: BigInt(fsTask.id) } });
      row.fsTaskId = BigInt(fsTask.id);
    }
  }

  /** After a TP-born ticket is first mirrored to FreshService, push any tasks
   *  that were created BEFORE the FS copy existed (added within the ~minutes
   *  before the mirror, so `_writeBackToFs` had no freshserviceTicketId to
   *  target and skipped them — QA 07-20 #14). Idempotent: only tasks lacking an
   *  fsTaskId are pushed. Called from mirrorService once the FS id is set. */
  async backfillMirrorTasks(ticketId, workspaceId) {
    const ticket = await this._ticket(ticketId, workspaceId);
    if (!ticket.freshserviceTicketId || ticket.origin !== TICKET_ORIGIN.TICKETPULSE) return { pushed: 0 };
    const pending = await prisma.ticketTask.findMany({
      where: { ticketId, workspaceId, origin: TICKET_ORIGIN.TICKETPULSE, fsTaskId: null },
      select: TASK_SELECT,
    });
    let pushed = 0;
    for (const row of pending) {
      try {
        await this._writeBackToFs(ticket, row);
        if (row.fsTaskId) pushed += 1;
      } catch (err) {
        logger.warn(`Task mirror backfill failed for task ${row.id} (non-fatal): ${err.message}`);
      }
    }
    if (pushed) logger.info(`Backfilled ${pushed} task(s) to FS for ${ticketDisplayRef(ticket)} after mirror`);
    return { pushed };
  }

  /**
   * Shared task email body — the same left-aligned Arial column and slate
   * palette the workflow-engine transactional emails use (640px cap,
   * #1f2937 body / #64748b muted), with the task in a bordered card.
   */
  _taskEmailHtml({ ticket, row, intro, dueTone = '#1f2937' }) {
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const publicBase = process.env.PUBLIC_APP_URL || process.env.FRONTEND_PUBLIC_URL || process.env.APP_URL || process.env.CORS_ORIGIN || 'http://localhost:5173';
    const dueLine = row.dueAt
      ? `<div style="font-size:13px;line-height:19px;color:${dueTone};margin-top:8px;font-weight:700;">Due ${new Date(row.dueAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>`
      : '';
    return [
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#1f2937;max-width:640px;">',
      `<p style="margin:0 0 14px;">${intro}</p>`,
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;max-width:640px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">',
      '<tr><td style="padding:14px 16px;font-family:Arial,Helvetica,sans-serif;">',
      `<div style="font-size:15px;line-height:21px;font-weight:700;color:#0f172a;">${esc(row.title)}</div>`,
      row.description ? `<div style="font-size:13px;line-height:19px;color:#64748b;margin-top:4px;">${esc(row.description)}</div>` : '',
      dueLine,
      '</td></tr></table>',
      `<p style="margin:16px 0 0;"><a href="${publicBase}/tickets/${ticket.id}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#2563eb;color:#ffffff;font-size:13px;line-height:18px;font-weight:700;text-decoration:none;border-radius:8px;padding:10px 18px;">Open the ticket</a></p>`,
      '<p style="margin:16px 0 0;color:#64748b;font-size:12px;line-height:18px;">Sent by Ticket Pulse — you can review the full task list on the ticket.</p>',
      '</div>',
    ].join('');
  }

  /** Email a TP-born task's assignee (idempotent via notifiedAt). */
  async _maybeNotify(ticket, row, assignee) {
    if (!row.notifyAgent || row.notifiedAt || !assignee?.email) return null;
    const ref = ticketDisplayRef(ticket);
    const esc = (s) => String(s || '').replace(/</g, '&lt;');
    const intro = `You’ve been assigned a task on ticket <b>${ref}</b>${ticket.subject ? ` (“${esc(ticket.subject)}”)` : ''}.`;
    const result = await sendTransactionalEmail({
      workspaceId: ticket.workspaceId, to: assignee.email, label: 'task assignment',
      subject: `New task on ${ref}: ${row.title}`,
      html: this._taskEmailHtml({ ticket, row, intro }),
    });
    // Only mark notified if the send actually succeeded — otherwise a transient
    // outage would permanently suppress the retry (notifiedAt is the guard).
    if (!result?.sent) {
      logger.warn(`Task assignment email to ${assignee.email} not sent (${result?.reason || 'unknown'}); leaving notifiedAt clear for retry`);
      return null;
    }
    return prisma.ticketTask.update({ where: { id: row.id }, data: { notifiedAt: new Date() }, select: TASK_SELECT });
  }

  /**
   * Send a "task due soon" reminder for one candidate row (called by the
   * notification time-trigger worker's 5-minute scan).
   *
   * Origin rule: TP sends reminders for `origin='ticketpulse'` rows only —
   * i.e. tasks TP owns, including ones mirrored to the FS fallback copy (the
   * mirror payload deliberately omits notify_before so FS can't double-send).
   * `origin='freshservice'` rows are FS-proxied/shadow rows — whether created
   * through our UI on an FS-born ticket or pulled in by _syncFromFs (those are
   * stored with notifyAgent=false) — and FreshService owns notifications
   * there: we forward the setting as FS `notify_before` at create/update
   * instead. The worker's query already filters on origin; the guard here is
   * defense in depth.
   */
  async sendDueReminder(row) {
    const ticket = row.ticket;
    const assignee = row.assignedTech;
    if (!ticket || !assignee?.email || row.origin !== TICKET_ORIGIN.TICKETPULSE) return false;
    if (row.status === 'done' || !row.dueAt || row.reminderSentAt) return false;
    const ref = ticketDisplayRef(ticket);
    const overdue = new Date(row.dueAt).getTime() <= Date.now();
    const esc = (s) => String(s || '').replace(/</g, '&lt;');
    const intro = overdue
      ? `Heads up — your task on ticket <b>${ref}</b>${ticket.subject ? ` (“${esc(ticket.subject)}”)` : ''} is now due.`
      : `Reminder — your task on ticket <b>${ref}</b>${ticket.subject ? ` (“${esc(ticket.subject)}”)` : ''} is due soon.`;
    const result = await sendTransactionalEmail({
      workspaceId: ticket.workspaceId, to: assignee.email, label: 'task due reminder',
      subject: `${overdue ? 'Task due' : 'Task due soon'} on ${ref}: ${row.title}`,
      html: this._taskEmailHtml({ ticket, row, intro, dueTone: overdue ? '#dc2626' : '#b45309' }),
    });
    if (!result?.sent) {
      logger.warn(`Task due reminder to ${assignee.email} not sent (${result?.reason || result?.error || 'unknown'}); leaving reminderSentAt clear for retry`);
      return false;
    }
    // updateMany + the reminderSentAt-null guard keeps a concurrent scan from
    // double-stamping (and re-sends stay impossible once stamped).
    await prisma.ticketTask.updateMany({ where: { id: row.id, reminderSentAt: null }, data: { reminderSentAt: new Date() } });
    return true;
  }

  /** TP-born mirrored ticket: pull status-only changes back from the FS copy.
   *  We own title/description/assignee/due here, so this touches status only. */
  async _syncMirroredStatusFromFs(ticket) {
    const mirrored = await prisma.ticketTask.findMany({
      where: { ticketId: ticket.id, workspaceId: ticket.workspaceId, fsTaskId: { not: null } },
      select: { id: true, fsTaskId: true, status: true, title: true },
    });
    if (!mirrored.length) return;
    const client = await this._fsClient(ticket.workspaceId);
    if (!client) return;
    const fsTasks = await client.listTicketTasks(Number(ticket.freshserviceTicketId));
    const statusByFsId = new Map(fsTasks.map((t) => [String(t.id), FROM_FS_STATUS[t.status] || 'open']));
    for (const local of mirrored) {
      const fsStatus = statusByFsId.get(String(local.fsTaskId));
      if (!fsStatus || fsStatus === local.status) continue;
      await prisma.ticketTask.update({
        where: { id: local.id },
        data: { status: fsStatus, completedAt: fsStatus === 'done' ? new Date() : null },
      });
      await this._logStatusChange(ticket, local, local.status, fsStatus, { name: 'FreshService' });
    }
  }

  /** Reconcile FS-born ticket's tasks into the local shadow cache. */
  async _syncFromFs(ticket) {
    const client = await this._fsClient(ticket.workspaceId);
    if (!client) return;
    const fsTasks = await client.listTicketTasks(Number(ticket.freshserviceTicketId));
    const existing = await prisma.ticketTask.findMany({ where: { ticketId: ticket.id, workspaceId: ticket.workspaceId }, select: { id: true, fsTaskId: true } });
    const byFsId = new Map(existing.filter((r) => r.fsTaskId !== null && r.fsTaskId !== undefined).map((r) => [String(r.fsTaskId), r.id]));
    const seen = new Set();
    for (let i = 0; i < fsTasks.length; i += 1) {
      const t = fsTasks[i];
      seen.add(String(t.id));
      const assignee = t.agent_id ? await prisma.technician.findFirst({ where: { workspaceId: ticket.workspaceId, freshserviceId: BigInt(t.agent_id) }, select: { id: true } }) : null;
      const data = {
        title: t.title || '(untitled task)',
        description: fsPlainText(t.description),
        status: FROM_FS_STATUS[t.status] || 'open',
        assignedTechId: assignee?.id ?? null,
        dueAt: t.due_date ? new Date(t.due_date) : null,
        sortOrder: i,
        completedAt: t.status === 3 ? (t.updated_at ? new Date(t.updated_at) : new Date()) : null,
      };
      const localId = byFsId.get(String(t.id));
      if (localId) await prisma.ticketTask.update({ where: { id: localId }, data });
      else await prisma.ticketTask.create({ data: { ...data, workspaceId: ticket.workspaceId, ticketId: ticket.id, origin: TICKET_ORIGIN.FRESHSERVICE, fsTaskId: BigInt(t.id), notifyAgent: false } });
    }
    // Drop shadow rows for FS tasks that no longer exist.
    const stale = existing.filter((r) => r.fsTaskId !== null && r.fsTaskId !== undefined && !seen.has(String(r.fsTaskId))).map((r) => r.id);
    if (stale.length) await prisma.ticketTask.deleteMany({ where: { id: { in: stale } } });
  }
}

export default new TicketTaskService();
export { TicketTaskService, STATUSES, REMINDER_MINUTES, parseDueAt, parseRemindBefore };
