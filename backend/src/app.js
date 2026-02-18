import express from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import connectPgSimple from 'connect-pg-simple';
import pg from 'pg';
import config from './config/index.js';
import logger from './utils/logger.js';
import { setupBigIntSerialization } from './utils/bigIntSerializer.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import routes from './routes/index.js';
import scheduledSyncService from './services/scheduledSyncService.js';
import settingsRepository from './services/settingsRepository.js';
import availabilityService from './services/availabilityService.js';
import llmConfigService from './services/llmConfigService.js';

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
      secure: true, // Must be true when sameSite is 'none'
      httpOnly: true,
      maxAge: config.session.maxAge,
      sameSite: 'none', // Required for cross-origin requests (SWA → App Service)
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

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Server is healthy',
    timestamp: new Date().toISOString(),
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

    // Initialize default business hours for auto-response
    await availabilityService.initializeDefaultBusinessHours();
    logger.info('Availability service initialized');

    // Initialize default LLM configuration
    try {
      await llmConfigService.initializeDefaultConfig();
      logger.info('LLM configuration initialized');
    } catch (error) {
      logger.warn('Failed to initialize LLM config, will use defaults:', error);
    }

    // Check if FreshService is configured
    const isConfigured = await settingsRepository.isFreshServiceConfigured();

    if (isConfigured) {
      logger.info('FreshService is configured, starting scheduled sync');
      await scheduledSyncService.start();
    } else {
      logger.warn('FreshService not configured. Please configure in settings.');
    }

    logger.info('Server initialization complete');
  } catch (error) {
    logger.error('Server initialization failed:', error);
    // Don't exit - allow server to start even if initialization fails
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

