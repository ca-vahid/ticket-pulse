import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import ticketService from './ticketService.js';

const TICK_MS = 60 * 1000;
const MAX_ACTIVATIONS_PER_TICK = 20;

/**
 * Scheduled tickets (T3.4). A scheduled ticket is a stored createTicket
 * payload, replayed verbatim at its activation time — so AI triage, noise
 * rules, notification workflows and the FS mirror all run exactly like a
 * normal create, and no half-born ticket rows sit in the queue meanwhile.
 *
 * Auto-activation failures park the row in status 'error' (no hot retry
 * loop); "Activate now" in the UI retries from pending or error.
 */
class ScheduledTicketService {
  constructor() {
    this._timer = null;
    this._running = false;
  }

  start() {
    if (this._timer || process.env.SCHEDULED_TICKETS_ENABLED === 'false') return;
    this._timer = setInterval(() => {
      this.activateDue().catch((err) => logger.warn(`Scheduled-ticket tick failed (non-fatal): ${err.message}`));
    }, TICK_MS);
    this._timer.unref?.();
    logger.info('Scheduled-ticket activation worker started (tick 60s)');
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async schedule(workspaceId, { payload, scheduledForAt }, actor) {
    const when = new Date(scheduledForAt);
    if (Number.isNaN(when.getTime())) throw new ValidationError('scheduledForAt must be a valid date');
    if (when.getTime() <= Date.now() + 60 * 1000) {
      throw new ValidationError('Schedule at least a minute into the future');
    }
    // Fail-fast on bad input at schedule time, not at 6am on activation day.
    await ticketService.validateCreateInput(workspaceId, payload);

    const row = await prisma.scheduledTicket.create({
      data: {
        workspaceId,
        payload,
        scheduledForAt: when,
        createdBy: actor?.email || null,
        createdByName: actor?.name || null,
      },
    });
    logger.info(`Ticket scheduled for ${when.toISOString()} (id ${row.id}, ws ${workspaceId}) by ${actor?.email || 'unknown'}`);
    return row;
  }

  async list(workspaceId) {
    return prisma.scheduledTicket.findMany({
      where: { workspaceId, status: { in: ['pending', 'error'] } },
      orderBy: { scheduledForAt: 'asc' },
    });
  }

  async recentlyActivated(workspaceId, take = 10) {
    return prisma.scheduledTicket.findMany({
      where: { workspaceId, status: 'activated' },
      orderBy: { activatedAt: 'desc' },
      take,
    });
  }

  async activate(id, workspaceId, actor, { via = 'manual' } = {}) {
    const row = await prisma.scheduledTicket.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundError('Scheduled ticket not found');
    if (!['pending', 'error'].includes(row.status)) {
      throw new ValidationError(`This scheduled ticket is already ${row.status}`);
    }

    // Atomic claim so a manual click racing the worker can't double-create.
    const claimed = await prisma.scheduledTicket.updateMany({
      where: { id: row.id, status: { in: ['pending', 'error'] } },
      data: { status: 'activating' },
    });
    if (claimed.count === 0) throw new ValidationError('This scheduled ticket is already being activated');

    try {
      const ticket = await ticketService.createTicket(workspaceId, row.payload, {
        email: actor?.email || row.createdBy,
        name: actor?.name || row.createdByName || 'Scheduled ticket',
      });
      const updated = await prisma.scheduledTicket.update({
        where: { id: row.id },
        data: { status: 'activated', activatedAt: new Date(), ticketId: ticket.id, lastError: null },
      });
      // Staged files become real attachments (same blobs) and ride the FS
      // mirror like any upload (gap plan 2 P2). Best-effort — activation never
      // fails on attachment adoption.
      try {
        const { default: attachmentService } = await import('./attachmentService.js');
        const adopted = await attachmentService.adoptStaged(row.id, ticket.id, workspaceId);
        if (adopted.length && ticket.origin === 'ticketpulse') {
          const { default: mirrorService } = await import('./mirrorService.js');
          for (const a of adopted) mirrorService.enqueueAttachment(workspaceId, ticket.id, a.id).catch(() => {});
        }
        if (adopted.length) logger.info(`Scheduled ticket ${row.id}: ${adopted.length} staged attachment(s) adopted onto ${ticket.displayRef}`);
      } catch (err) {
        logger.warn(`Staged-attachment adoption failed (non-fatal) for schedule ${row.id}: ${err.message}`);
      }
      logger.info(`Scheduled ticket ${row.id} activated → ${ticket.displayRef} (${via})`);
      return { scheduled: updated, ticket };
    } catch (err) {
      // Auto path parks in 'error' (visible, no retry loop); manual retries land back the same way.
      await prisma.scheduledTicket.update({
        where: { id: row.id },
        data: { status: 'error', lastError: err.message?.slice(0, 2000) || 'activation failed' },
      }).catch(() => {});
      throw err;
    }
  }

  async cancel(id, workspaceId, actor) {
    const row = await prisma.scheduledTicket.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundError('Scheduled ticket not found');
    if (!['pending', 'error'].includes(row.status)) {
      throw new ValidationError(`This scheduled ticket is already ${row.status}`);
    }
    const updated = await prisma.scheduledTicket.update({
      where: { id: row.id },
      data: { status: 'cancelled' },
    });
    // Staged files are orphans once cancelled — clean blobs + rows.
    import('./attachmentService.js')
      .then(({ default: attachmentService }) => attachmentService.discardStaged(row.id, workspaceId))
      .catch(() => {});
    logger.info(`Scheduled ticket ${row.id} cancelled by ${actor?.email || 'unknown'}`);
    return updated;
  }

  async activateDue() {
    if (this._running) return { skipped: true };
    this._running = true;
    try {
      const due = await prisma.scheduledTicket.findMany({
        where: {
          status: 'pending',
          scheduledForAt: { lte: new Date() },
          workspace: { isActive: true, nativeTicketingEnabled: true },
        },
        orderBy: { scheduledForAt: 'asc' },
        take: MAX_ACTIVATIONS_PER_TICK,
      });
      let activated = 0;
      for (const row of due) {
        try {
          await this.activate(row.id, row.workspaceId, { email: row.createdBy, name: row.createdByName }, { via: 'auto' });
          activated += 1;
        } catch (err) {
          logger.warn(`Scheduled ticket ${row.id} failed to activate: ${err.message}`);
        }
      }
      return { due: due.length, activated };
    } finally {
      this._running = false;
    }
  }
}

export default new ScheduledTicketService();
