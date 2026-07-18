import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { TICKET_ORIGIN, ticketDisplayRef } from '../utils/ticketOrigin.js';
import { sendTransactionalEmail } from './transactionalEmailService.js';

// Local status <-> FreshService task status. FS: 1 Open, 2 In Progress, 3 Completed.
const STATUSES = ['open', 'in_progress', 'done'];
const TO_FS_STATUS = { open: 1, in_progress: 2, done: 3 };
const FROM_FS_STATUS = { 1: 'open', 2: 'in_progress', 3: 'done' };

const TASK_SELECT = {
  id: true, ticketId: true, title: true, description: true, status: true,
  assignedTechId: true, dueAt: true, notifyAgent: true, notifiedAt: true,
  origin: true, fsTaskId: true, sortOrder: true, createdByName: true,
  completedAt: true, createdAt: true, updatedAt: true,
  assignedTech: { select: { id: true, name: true, photoUrl: true, email: true, freshserviceId: true } },
};

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
    const dueAt = input?.dueAt ? new Date(input.dueAt) : null;
    const notifyAgent = input?.notifyAgent !== false;

    const maxOrder = await prisma.ticketTask.aggregate({ where: { ticketId, workspaceId }, _max: { sortOrder: true } });
    const base = {
      workspaceId, ticketId, title,
      description: input?.description ? String(input.description) : null,
      status, assignedTechId: assignee?.id ?? null, dueAt, notifyAgent,
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

  async update(taskId, workspaceId, patch, actor = null) {
    const task = await prisma.ticketTask.findFirst({ where: { id: Number(taskId), workspaceId }, select: TASK_SELECT });
    if (!task) throw new NotFoundError('Task not found');
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
    if (patch.dueAt !== undefined) data.dueAt = patch.dueAt ? new Date(patch.dueAt) : null;
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
      await this._fsUpdate(ticket, task, data).catch((err) => logger.warn(`FS task update failed (non-fatal): ${err.message}`));
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

  async remove(taskId, workspaceId) {
    const task = await prisma.ticketTask.findFirst({ where: { id: Number(taskId), workspaceId } });
    if (!task) throw new NotFoundError('Task not found');
    if (task.fsTaskId) {
      const ticket = await this._ticket(task.ticketId, workspaceId);
      if (ticket.freshserviceTicketId) {
        const client = await this._fsClient(workspaceId);
        await client?.deleteTicketTask(Number(ticket.freshserviceTicketId), Number(task.fsTaskId))
          .catch((err) => logger.warn(`FS task delete failed (non-fatal): ${err.message}`));
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

  _toFsPayload(base, assignee) {
    const payload = { title: base.title, status: TO_FS_STATUS[base.status] || 1 };
    if (base.description) payload.description = base.description;
    if (base.dueAt) payload.due_date = new Date(base.dueAt).toISOString();
    if (assignee?.freshserviceId) payload.agent_id = Number(assignee.freshserviceId);
    return payload;
  }

  async _fsCreate(ticket, base, assignee) {
    const client = await this._fsClient(ticket.workspaceId);
    if (!client) throw new ValidationError('FreshService is not configured for this workspace');
    return client.createTicketTask(Number(ticket.freshserviceTicketId), this._toFsPayload(base, assignee));
  }

  async _fsUpdate(ticket, task, data) {
    const client = await this._fsClient(ticket.workspaceId);
    if (!client) return;
    const patch = {};
    if (data.title !== undefined) patch.title = data.title;
    if (data.description !== undefined) patch.description = data.description || '';
    if (data.status !== undefined) patch.status = TO_FS_STATUS[data.status] || 1;
    if (data.dueAt !== undefined) patch.due_date = data.dueAt ? new Date(data.dueAt).toISOString() : null;
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

  /** Email a TP-born task's assignee (idempotent via notifiedAt). */
  async _maybeNotify(ticket, row, assignee) {
    if (!row.notifyAgent || row.notifiedAt || !assignee?.email) return null;
    const ref = ticketDisplayRef(ticket);
    const esc = (s) => String(s || '').replace(/</g, '&lt;');
    const publicBase = process.env.PUBLIC_APP_URL || process.env.FRONTEND_PUBLIC_URL || process.env.APP_URL || process.env.CORS_ORIGIN || 'http://localhost:5173';
    const html = [
      `<p>You’ve been assigned a task on ticket <b>${ref}</b>${ticket.subject ? ` (“${esc(ticket.subject)}”)` : ''}.</p>`,
      `<p><b>${esc(row.title)}</b></p>`,
      row.description ? `<p>${esc(row.description)}</p>` : '',
      row.dueAt ? `<p>Due: ${new Date(row.dueAt).toLocaleString()}</p>` : '',
      `<p><a href="${publicBase}/tickets/${ticket.id}">Open the ticket</a> to see the full task list.</p>`,
    ].join('');
    await sendTransactionalEmail({
      workspaceId: ticket.workspaceId, to: assignee.email, label: 'task assignment',
      subject: `New task on ${ref}: ${row.title}`, html,
    });
    return prisma.ticketTask.update({ where: { id: row.id }, data: { notifiedAt: new Date() }, select: TASK_SELECT });
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
        description: t.description || null,
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
export { TicketTaskService, STATUSES };
