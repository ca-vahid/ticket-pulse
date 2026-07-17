import express from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import os from 'os';
import { createRequire } from 'module';
import connectPgSimple from 'connect-pg-simple';
import pg from 'pg';
import config from './config/index.js';
import logger from './utils/logger.js';
import { setupBigIntSerialization } from './utils/bigIntSerializer.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import routes from './routes/index.js';
import prisma from './services/prisma.js';
import scheduledSyncService from './services/scheduledSyncService.js';
import settingsRepository from './services/settingsRepository.js';
import availabilityService from './services/availabilityService.js';
import llmConfigService from './services/llmConfigService.js';
import noiseRuleService from './services/noiseRuleService.js';
import notificationWorkflowRunWatchdogService from './services/notificationWorkflowRunWatchdogService.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

// Setup BigInt serialization for JSON responses
setupBigIntSerialization();

const { Pool } = pg;
const PgSession = connectPgSimple(session);

// Create Express app
const app = express();

// Trust proxy (needed for session cookies in production behind reverse proxy)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for SSE
  crossOriginEmbedderPolicy: false,
}));

// CORS configuration
app.use(
  cors({
    origin: config.cors.origin,
    credentials: true, // Allow cookies
  }),
);

// Body parsing middleware. Branding settings carry uploaded images as data URLs (logo <= ~512 KB
// plus an optional feedback-page background <= ~700 KB in one PUT), so allow up to 3 MB.
app.use(express.json({ limit: '3mb' }));
app.use(express.urlencoded({ extended: true, limit: '3mb' }));

// Session configuration with PostgreSQL store
const pgPool = new Pool({
  connectionString: config.database.url,
  max: 5,
});

app.use(
  session({
    store: new PgSession({
      pool: pgPool,
      tableName: 'session', // Will be created automatically
    }),
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: config.isProduction,
      httpOnly: true,
      maxAge: config.session.maxAge,
      sameSite: config.isProduction ? 'none' : 'lax',
    },
  }),
);

// Request logging middleware (exclude polling endpoints to reduce log spam)
app.use((req, res, next) => {
  // Skip logging for frequent polling endpoints
  if (
    req.path !== '/api/sync/status'
    && !/^\/api\/assignment\/daily-review\/runs\/\d+\/progress$/.test(req.path)
  ) {
    logger.http(`${req.method} ${req.path}`, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  }
  next();
});

const APP_START_TIME = Date.now();

// Monitoring-compatible health endpoint (AI Monitor integration)
// Always returns HTTP 200; overall status is determined by the JSON body.
app.get('/health', async (req, res) => {
  if (config.monitor.key && req.headers['x-monitor-key'] !== config.monitor.key) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const checks = {};
  let overallStatus = 'healthy';

  const degradeOverall = (checkStatus) => {
    if (checkStatus === 'unhealthy') overallStatus = 'unhealthy';
    else if (checkStatus === 'degraded' && overallStatus !== 'unhealthy') overallStatus = 'degraded';
  };

  // --- Database check ---
  try {
    const dbStart = Date.now();
    await prisma.$queryRawUnsafe('SELECT 1');
    const responseTime = Date.now() - dbStart;
    const dbStatus = responseTime > 2000 ? 'unhealthy' : responseTime > 200 ? 'degraded' : 'healthy';
    checks.database = { status: dbStatus, responseTime, message: 'Connected to PostgreSQL' };
    degradeOverall(dbStatus);
  } catch (err) {
    checks.database = { status: 'unhealthy', message: err.message };
    overallStatus = 'unhealthy';
  }

  // --- Memory check ---
  const totalMem = Math.round(os.totalmem() / 1048576);
  const freeMem = Math.round(os.freemem() / 1048576);
  const memPct = ((totalMem - freeMem) / totalMem) * 100;
  const memStatus = memPct > 95 ? 'unhealthy' : memPct > 80 ? 'degraded' : 'healthy';
  checks.memory = {
    status: memStatus,
    totalMB: totalMem,
    usedMB: totalMem - freeMem,
    freePercent: Math.round(100 - memPct),
  };
  degradeOverall(memStatus);

  // --- Process memory (heap) ---
  const heapUsed = Math.round(process.memoryUsage().heapUsed / 1048576);
  const heapTotal = Math.round(process.memoryUsage().heapTotal / 1048576);
  checks.processMemory = {
    status: 'healthy',
    heapUsedMB: heapUsed,
    heapTotalMB: heapTotal,
  };

  // --- Leak-hunt instrumentation (Jul 9 OOM incident) ---
  // Sizes of every registered in-process collection; whichever climbs in
  // step with heapUsed across samples is the leak.
  try {
    const { snapshot } = await import('./services/memoryDiagnostics.js');
    checks.memoryDiagnostics = snapshot();
  } catch { /* diagnostics are best-effort */ }

  res.json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    app: {
      name: 'ticket-pulse',
      version: pkg.version,
      environment: config.env,
    },
    uptime: Math.floor((Date.now() - APP_START_TIME) / 1000),
    checks,
  });
});

// Mount API routes
// Auth routes are public
app.use('/api', routes);

// Protected routes - require authentication
// Note: Individual routes can override this with requireAuth middleware
// For now, we'll apply auth to specific routes in the route files

// 404 handler for undefined routes
app.use(notFoundHandler);

// Global error handler (must be last)
app.use(errorHandler);

// Initialize server
async function initialize() {
  try {
    logger.info('Initializing server...');

    // Initialize default settings
    await settingsRepository.initializeDefaults();
    logger.info('Default settings initialized');

    // Initialize default business hours and LLM config per active workspace
    const workspaceRepo = (await import('./services/workspaceRepository.js')).default;
    const activeWorkspaces = await workspaceRepo.getAllActive();
    for (const ws of activeWorkspaces) {
      await availabilityService.initializeDefaultBusinessHours(ws.id);
      try {
        await llmConfigService.initializeDefaultConfig(ws.id);
      } catch (error) {
        logger.warn(`Failed to initialize LLM config for workspace ${ws.id}, will use defaults:`, error);
      }
    }
    logger.info('Availability and LLM configuration initialized for all active workspaces');

    // Seed default IT noise rules only; other workspaces intentionally start empty.
    try {
      await noiseRuleService.seedDefaults();
      logger.info('Noise rules initialized');
    } catch (noiseError) {
      logger.warn('Noise rules initialization failed (non-fatal):', noiseError.message || noiseError);
    }

    // Start sync for all active workspaces (checks FreshService config internally)
    const isConfigured = await settingsRepository.isFreshServiceConfigured();

    if (!config.sync.enableScheduledSync) {
      logger.warn('Scheduled sync auto-start disabled by environment', {
        environment: config.env,
        enableScheduledSync: config.sync.enableScheduledSync,
      });
    } else if (isConfigured) {
      logger.info('FreshService is configured, starting scheduled sync for all workspaces');
      await scheduledSyncService.start();
    } else {
      logger.warn('FreshService not configured. Please configure in settings.');
    }

    // Assignment queue-drain worker — independent of the FS sync cron so
    // business-hours-queued runs always process when hours resume, even if FS
    // sync is off/paused. Gated by the same automation switch to keep dev quiet.
    if (config.sync.enableScheduledSync) {
      try {
        const { default: assignmentPipelineService } = await import('./services/assignmentPipelineService.js');
        assignmentPipelineService.startQueueDrainWorker();
      } catch (e) {
        logger.warn('Assignment queue-drain worker failed to start (non-fatal):', e.message);
      }
    }

    // Memory-leak instrumentation (Jul 9 OOM incident): 5-minute [mem] log
    // lines + gauges over the collections that background workers own.
    try {
      const { startMemoryDiagnostics, registerGauge } = await import('./services/memoryDiagnostics.js');
      const { default: syncService } = await import('./services/syncService.js');
      const { default: mirrorService } = await import('./services/mirrorService.js');
      const { sseManager } = await import('./routes/sse.routes.js');
      registerGauge('sync.embeddedRequesterNames', () => syncService._embeddedRequesterNames?.size ?? -1);
      registerGauge('sync.tpLookupCache', () => syncService._ticketPulseLookupCache?.size ?? -1);
      registerGauge('sync.progressByWorkspace', () => syncService.progressByWorkspace?.size ?? -1);
      registerGauge('mirror.clients', () => (mirrorService._clients?.size ?? 0) + (mirrorService._interactiveClients?.size ?? 0));
      registerGauge('mirror.inFlight', () => mirrorService._inFlightTickets?.size ?? -1);
      registerGauge('sse.channels', () => sseManager.channels?.size ?? -1);
      registerGauge('sse.clients', () => {
        let n = 0;
        for (const clients of sseManager.channels?.values() ?? []) n += clients.size;
        return n;
      });
      startMemoryDiagnostics();
    } catch (e) {
      logger.warn('Memory diagnostics failed to start (non-fatal):', e.message);
    }

    // Reconcile any backfill runs left in 'running' state from a prior crash/restart.
    // The backfill loop only lives in-process, so a 'running' row at boot is orphaned.
    try {
      const prismaModule = await import('./services/prisma.js');
      const orphans = await prismaModule.default.backfillRun.updateMany({
        where: { status: 'running' },
        data: {
          status: 'interrupted',
          progressStep: 'Server restarted before backfill completed',
          progressPhase: 'interrupted',
          completedAt: new Date(),
        },
      });
      if (orphans.count > 0) {
        logger.warn(`Marked ${orphans.count} orphaned backfill run(s) as 'interrupted' on startup`);
      }
    } catch (e) {
      logger.warn('Backfill run reconciliation failed (non-fatal):', e.message);
    }

    // Reconcile assignment pipeline runs left 'running' at boot. A run only
    // executes in-process, so any 'running' row now was orphaned by this
    // restart — otherwise the ticket pins on "AI matching…" forever and its
    // live view has no stream to show.
    try {
      const { default: assignmentPipelineService } = await import('./services/assignmentPipelineService.js');
      const rec = await assignmentPipelineService.reconcileStuckAnalysisRuns({ olderThanMs: 0 });
      if (rec.recovered > 0) {
        logger.warn(`Recovered ${rec.recovered} orphaned assignment pipeline run(s) as 'failed' on startup`);
      }
    } catch (e) {
      logger.warn('Assignment pipeline run reconciliation failed (non-fatal):', e.message);
    }

    try {
      const staleRuns = await notificationWorkflowRunWatchdogService.reconcileStaleRuns();
      if (staleRuns.runCount > 0) {
        logger.warn(`Marked ${staleRuns.runCount} stale notification workflow run(s) as failed on startup`);
      }
      notificationWorkflowRunWatchdogService.start();
    } catch (e) {
      logger.warn('Notification workflow stale-run reconciliation failed (non-fatal):', e.message);
    }

    // Native-ticketing fallback mirror: pushes TP-born ticket copies to FreshService.
    try {
      const { default: mirrorService } = await import('./services/mirrorService.js');
      mirrorService.start();
      // Inbound reconcile (FS→TP replies on TP-born tickets) is read-only and
      // runs even when the outbound mirror is disabled.
      mirrorService.startReconcile();
    } catch (e) {
      logger.warn('FreshService mirror worker failed to start (non-fatal):', e.message);
    }

    // Native-ticketing mailbox ingest: email-to-ticket + email-updates-ticket.
    try {
      const { default: mailboxIngestService } = await import('./services/mailboxIngestService.js');
      mailboxIngestService.start();
    } catch (e) {
      logger.warn('Mailbox ingest worker failed to start (non-fatal):', e.message);
    }

    // Scheduled tickets: activates due payloads through the normal create path.
    try {
      const { default: scheduledTicketService } = await import('./services/scheduledTicketService.js');
      scheduledTicketService.start();
    } catch (e) {
      logger.warn('Scheduled-ticket worker failed to start (non-fatal):', e.message);
    }

    // Time-based workflow triggers: ticket.aging / sla_pre_breach / sla_breach.
    try {
      const { default: notificationTimeTriggerService } = await import('./services/notificationTimeTriggerService.js');
      notificationTimeTriggerService.start();
    } catch (e) {
      logger.warn('Notification time-trigger worker failed to start (non-fatal):', e.message);
    }

    // Custom agent alerts: coalescing flush worker (storm protection).
    try {
      const { default: agentAlertService } = await import('./services/agentAlertService.js');
      agentAlertService.start();
    } catch (e) {
      logger.warn('Agent-alert flush worker failed to start (non-fatal):', e.message);
    }

    logger.info('Server initialization complete');
  } catch (error) {
    logger.error('Server initialization failed:', error);
    // Last resort: still try to start the sync service
    try {
      const isConfigured = await settingsRepository.isFreshServiceConfigured();
      if (config.sync.enableScheduledSync && isConfigured) {
        logger.info('Attempting to start scheduled sync despite initialization error');
        await scheduledSyncService.start();
      } else if (!config.sync.enableScheduledSync) {
        logger.warn('Skipping scheduled sync fallback because auto-start is disabled by environment');
      }
    } catch (syncError) {
      logger.error('Failed to start scheduled sync after initialization error:', syncError);
    }
  }
}

// Start server
const PORT = config.port;

app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
  logger.info(`Environment: ${config.env}`);
  logger.info(`Database: ${config.database.url.split('@')[1] || 'configured'}`);

  // Initialize after server starts
  initialize();
});

// Crash visibility (Jul 9): Node kills the process on unhandled rejections
// and uncaught exceptions with no app-level record of WHY. Log the cause;
// rejections are logged-and-survived (Express keeps serving), exceptions are
// logged then exit so the platform restarts us into a clean state.
process.on('unhandledRejection', (reason) => {
  logger.error('UNHANDLED REJECTION (survived — fix the missing .catch):', {
    message: reason?.message || String(reason),
    stack: reason?.stack,
  });
});
process.on('uncaughtException', (err) => {
  logger.error('UNCAUGHT EXCEPTION (fatal — restarting):', { message: err?.message, stack: err?.stack });
  setTimeout(() => process.exit(1), 500).unref();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');

  scheduledSyncService.stop();
  notificationWorkflowRunWatchdogService.stop();
  pgPool.end();

  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');

  scheduledSyncService.stop();
  notificationWorkflowRunWatchdogService.stop();
  pgPool.end();

  process.exit(0);
});

export default app;
