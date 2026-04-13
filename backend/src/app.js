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

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
  if (req.path !== '/api/sync/status') {
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

    // Seed default noise rules (non-critical, must not block sync startup)
    try {
      await noiseRuleService.seedDefaults();
      logger.info('Noise rules initialized');
    } catch (noiseError) {
      logger.warn('Noise rules initialization failed (non-fatal):', noiseError.message || noiseError);
    }

    // Start sync for all active workspaces (checks FreshService config internally)
    const isConfigured = await settingsRepository.isFreshServiceConfigured();

    if (isConfigured) {
      logger.info('FreshService is configured, starting scheduled sync for all workspaces');
      await scheduledSyncService.start();
    } else {
      logger.warn('FreshService not configured. Please configure in settings.');
    }

    logger.info('Server initialization complete');
  } catch (error) {
    logger.error('Server initialization failed:', error);
    // Last resort: still try to start the sync service
    try {
      const isConfigured = await settingsRepository.isFreshServiceConfigured();
      if (isConfigured) {
        logger.info('Attempting to start scheduled sync despite initialization error');
        await scheduledSyncService.start();
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

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');

  scheduledSyncService.stop();
  pgPool.end();

  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');

  scheduledSyncService.stop();
  pgPool.end();

  process.exit(0);
});

export default app;

