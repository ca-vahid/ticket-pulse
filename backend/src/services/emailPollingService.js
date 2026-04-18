import cron from 'node-cron';
import graphMailClient from '../integrations/graphMailClient.js';
import assignmentRepository from './assignmentRepository.js';
import assignmentPipelineService from './assignmentPipelineService.js';
import prisma from './prisma.js';
import logger from '../utils/logger.js';

class EmailPollingService {
  constructor() {
    this._jobs = new Map(); // workspaceId -> cronJob
    this._status = new Map(); // workspaceId -> { lastCheck, emailsFound, errors }
  }

  async startAll() {
    if (!graphMailClient.isConfigured()) {
      logger.info('Email polling: Azure Graph API not configured, skipping');
      return;
    }

    const configs = await prisma.assignmentConfig.findMany({
      where: { emailPollingEnabled: true, monitoredMailbox: { not: null } },
      include: { workspace: { select: { name: true, slug: true } } },
    });

    for (const cfg of configs) {
      this.startForWorkspace(cfg);
    }

    logger.info(`Email polling started for ${configs.length} workspace(s)`);
  }

  startForWorkspace(config) {
    const wsId = config.workspaceId;

    this.stopForWorkspace(wsId);

    if (!config.emailPollingEnabled || !config.monitoredMailbox) return;
    if (!graphMailClient.isConfigured()) return;

    const intervalSec = Math.max(15, config.emailPollingIntervalSec || 60);
    const cronExpression = `*/${Math.max(1, Math.floor(intervalSec / 60)) || 1} * * * *`;
    // For sub-minute intervals, use setInterval instead of cron
    if (intervalSec < 60) {
      const interval = setInterval(() => {
        this._poll(wsId, config.monitoredMailbox).catch((err) =>
          logger.error('Email poll tick failed', { workspaceId: wsId, error: err.message }),
        );
      }, intervalSec * 1000);

      this._jobs.set(wsId, { type: 'interval', handle: interval });
      logger.info(`Email polling started for workspace ${wsId} (${config.monitoredMailbox}) every ${intervalSec}s`);
      return;
    }

    const job = cron.schedule(cronExpression, () => {
      this._poll(wsId, config.monitoredMailbox).catch((err) =>
        logger.error('Email poll tick failed', { workspaceId: wsId, error: err.message }),
      );
    });

    this._jobs.set(wsId, { type: 'cron', handle: job });
    logger.info(`Email polling started for workspace ${wsId} (${config.monitoredMailbox}) every ${intervalSec}s`);
  }

  stopForWorkspace(wsId) {
    const existing = this._jobs.get(wsId);
    if (!existing) return;

    if (existing.type === 'interval') {
      clearInterval(existing.handle);
    } else if (existing.type === 'cron') {
      existing.handle.stop();
    }

    this._jobs.delete(wsId);
    logger.info(`Email polling stopped for workspace ${wsId}`);
  }

  stopAll() {
    for (const [wsId] of this._jobs) {
      this.stopForWorkspace(wsId);
    }
  }

  getStatus(wsId) {
    return {
      running: this._jobs.has(wsId),
      ...(this._status.get(wsId) || { lastCheck: null, emailsFound: 0, lastError: null }),
    };
  }

  /**
   * Manually trigger a poll cycle for a workspace.
   */
  async pollNow(wsId) {
    const config = await assignmentRepository.getConfig(wsId);
    if (!config?.monitoredMailbox) {
      return { success: false, message: 'No monitored mailbox configured' };
    }
    return this._poll(wsId, config.monitoredMailbox);
  }

  async _poll(wsId, mailbox) {
    const config = await assignmentRepository.getConfig(wsId);
    // Clamp the lookback window to a safe maximum (default 1 hour). Without
    // this, when the app is restarted after extended downtime,
    // lastEmailCheckAt could be days old and the poller would try to drain
    // a huge mailbox backlog in one tick — flooding the queue with
    // outdated work (alerts, marketing, security notifications, etc.) most
    // of which is no longer actionable. The regular sync service already
    // catches up on tickets that arrived during downtime; we don't need
    // the email poller to act on a stale firehose.
    const MAX_LOOKBACK_MS = 60 * 60 * 1000; // 1 hour
    const fallbackSince = new Date(Date.now() - 5 * 60 * 1000);
    const lastCheck = config?.lastEmailCheckAt;
    let since = lastCheck || fallbackSince;

    if (lastCheck) {
      const ageMs = Date.now() - lastCheck.getTime();
      if (ageMs > MAX_LOOKBACK_MS) {
        const clampedSince = new Date(Date.now() - MAX_LOOKBACK_MS);
        logger.warn('Email polling: lastEmailCheckAt is stale, clamping window', {
          workspaceId: wsId,
          lastCheck: lastCheck.toISOString(),
          ageHours: (ageMs / 3_600_000).toFixed(1),
          clampedTo: clampedSince.toISOString(),
        });
        since = clampedSince;
      }
    }

    let emails;
    try {
      emails = await graphMailClient.getNewEmails(mailbox, since);
    } catch (error) {
      this._status.set(wsId, {
        lastCheck: new Date(),
        emailsFound: 0,
        lastError: error.message,
      });
      throw error;
    }

    if (emails.length === 0) {
      this._status.set(wsId, {
        lastCheck: new Date(),
        emailsFound: 0,
        lastError: null,
      });
      await this._updateLastCheck(wsId, new Date());
      return { success: true, emailsFound: 0, triggered: 0 };
    }

    logger.info('Email polling: found new emails', { workspaceId: wsId, count: emails.length });

    let triggered = 0;
    for (const email of emails) {
      try {
        const ticketId = await this._matchEmailToTicket(email, wsId);
        if (ticketId) {
          const existing = await assignmentRepository.hasActivePipelineRun(ticketId);
          if (!existing) {
            await assignmentPipelineService.runPipeline(ticketId, wsId, 'email');
            triggered++;
            logger.info('Email polling: triggered pipeline', {
              workspaceId: wsId,
              ticketId,
              emailSubject: email.subject,
            });
          }
        }
      } catch (err) {
        logger.warn('Email polling: failed to process email', {
          workspaceId: wsId,
          emailId: email.id,
          subject: email.subject,
          error: err.message,
        });
      }
    }

    const latestReceived = emails.reduce((max, e) => (e.receivedAt > max ? e.receivedAt : max), since);
    await this._updateLastCheck(wsId, latestReceived);

    this._status.set(wsId, {
      lastCheck: new Date(),
      emailsFound: emails.length,
      triggered,
      lastError: null,
    });

    return { success: true, emailsFound: emails.length, triggered };
  }

  /**
   * Match an email to a ticket in the database.
   * Strategy:
   *   1. Parse FreshService ticket ID from subject (e.g., [#12345] or #12345 or Ticket#12345)
   *   2. Fallback: match by sender email + subject + close timestamp
   */
  async _matchEmailToTicket(email, wsId) {
    // Strategy 1: extract ticket ID from subject
    const ticketIdMatch = email.subject.match(/(?:\[?#|Ticket\s*#?)(\d{4,})\]?/i);
    if (ticketIdMatch) {
      const fsTicketId = parseInt(ticketIdMatch[1]);
      const ticket = await prisma.ticket.findFirst({
        where: {
          freshserviceTicketId: BigInt(fsTicketId),
          workspaceId: wsId,
        },
        select: { id: true, assignedTechId: true },
      });
      if (ticket) return ticket.id;
    }

    // Strategy 2: match by sender email + recent creation + similar subject
    const fiveMinAgo = new Date(email.receivedAt.getTime() - 5 * 60 * 1000);
    const fiveMinAfter = new Date(email.receivedAt.getTime() + 5 * 60 * 1000);

    const candidates = await prisma.ticket.findMany({
      where: {
        workspaceId: wsId,
        createdAt: { gte: fiveMinAgo, lte: fiveMinAfter },
      },
      include: { requester: { select: { email: true } } },
      take: 10,
    });

    // Find best match by sender email
    const senderMatch = candidates.find(
      (t) => t.requester?.email?.toLowerCase() === email.from.toLowerCase(),
    );
    if (senderMatch) return senderMatch.id;

    return null;
  }

  async _updateLastCheck(wsId, timestamp) {
    try {
      await prisma.assignmentConfig.update({
        where: { workspaceId: wsId },
        data: { lastEmailCheckAt: timestamp },
      });
    } catch (err) {
      logger.warn('Failed to update lastEmailCheckAt', { workspaceId: wsId, error: err.message });
    }
  }
}

export default new EmailPollingService();
