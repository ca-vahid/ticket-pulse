import prisma from './prisma.js';
import logger from '../utils/logger.js';
import {
  NOTIFICATION_WORKFLOW_RUN_CLEANUP_INTERVAL_MS,
  NOTIFICATION_WORKFLOW_STALE_TIMEOUT_CODE,
  STALE_NOTIFICATION_WORKFLOW_RUN_TIMEOUT_MS,
  describeNotificationWorkflowTimeout,
} from './notificationWorkflowRunTimeouts.js';

const ACTIVE_RUN_STATUSES = ['running', 'queued'];

function staleRunError(timeoutMs) {
  return `${NOTIFICATION_WORKFLOW_STALE_TIMEOUT_CODE}: Notification workflow run was still active after ${describeNotificationWorkflowTimeout(timeoutMs)} and was marked failed by the watchdog.`;
}

function durationFrom(startedAt, completedAt) {
  return Math.max(0, completedAt.getTime() - new Date(startedAt).getTime());
}

class NotificationWorkflowRunWatchdogService {
  constructor() {
    this.interval = null;
    this.inProgress = false;
  }

  async reconcileStaleRuns({
    timeoutMs = STALE_NOTIFICATION_WORKFLOW_RUN_TIMEOUT_MS,
    completedAt = new Date(),
  } = {}) {
    const cutoff = new Date(completedAt.getTime() - timeoutMs);
    const runs = await prisma.notificationWorkflowRun.findMany({
      where: {
        status: { in: ACTIVE_RUN_STATUSES },
        startedAt: { lt: cutoff },
      },
      select: {
        id: true,
        workspaceId: true,
        startedAt: true,
        status: true,
      },
      orderBy: { startedAt: 'asc' },
      take: 100,
    });

    if (runs.length === 0) {
      return { runCount: 0, stepCount: 0, runIds: [] };
    }

    const runIds = runs.map((run) => run.id);
    const steps = await prisma.notificationWorkflowStepRun.findMany({
      where: {
        runId: { in: runIds },
        status: { in: ACTIVE_RUN_STATUSES },
      },
      select: {
        id: true,
        startedAt: true,
      },
    });
    const error = staleRunError(timeoutMs);

    await prisma.$transaction([
      ...steps.map((step) => prisma.notificationWorkflowStepRun.update({
        where: { id: step.id },
        data: {
          status: 'failed',
          completedAt,
          durationMs: durationFrom(step.startedAt, completedAt),
          error,
        },
      })),
      prisma.aiProviderAttempt.updateMany({
        where: {
          notificationWorkflowRunId: { in: runIds },
          status: 'running',
        },
        data: {
          status: 'failed',
          completedAt,
          errorClass: 'api_timeout',
          errorMessage: error,
        },
      }),
      ...runs.map((run) => prisma.notificationWorkflowRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          completedAt,
          durationMs: durationFrom(run.startedAt, completedAt),
          error,
        },
      })),
    ]);

    logger.warn('Marked stale notification workflow run(s) as failed', {
      runCount: runs.length,
      stepCount: steps.length,
      runIds,
      timeoutMs,
    });

    return {
      runCount: runs.length,
      stepCount: steps.length,
      runIds,
    };
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(async () => {
      if (this.inProgress) return;
      this.inProgress = true;
      try {
        await this.reconcileStaleRuns();
      } catch (error) {
        logger.warn('Notification workflow stale-run watchdog failed', {
          error: error.message,
        });
      } finally {
        this.inProgress = false;
      }
    }, NOTIFICATION_WORKFLOW_RUN_CLEANUP_INTERVAL_MS);
    this.interval.unref?.();
    logger.info('Notification workflow stale-run watchdog started', {
      intervalMs: NOTIFICATION_WORKFLOW_RUN_CLEANUP_INTERVAL_MS,
      staleTimeoutMs: STALE_NOTIFICATION_WORKFLOW_RUN_TIMEOUT_MS,
    });
  }

  stop() {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
    this.inProgress = false;
  }
}

export { NotificationWorkflowRunWatchdogService };
export default new NotificationWorkflowRunWatchdogService();
