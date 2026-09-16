import logger from '../utils/logger.js';
import { formatErrorResponse, isOperationalError, isDatabaseConnectivityError, DatabaseUnavailableError } from '../utils/errors.js';
import { NotFoundError } from '../utils/errors.js';

/**
 * Global error handling middleware
 * Must be added AFTER all routes
 */
export function errorHandler(err, req, res, _next) {
  // A database that cannot be reached is an outage, not a programming error
  // and never a permission problem: answer 503 with a retry message (the
  // frontend retries 5xx-transient codes) and log ONE warn line, not a stack
  // plus "consider restarting" for every request (16 Sep 2026: 460 of those).
  if (!(err instanceof DatabaseUnavailableError) && isDatabaseConnectivityError(err)) {
    logger.warn(`Database unavailable: ${String(err?.originalError?.message || err?.message || '').split('\n').filter(Boolean).pop()}`, {
      path: req.path, method: req.method, code: err?.originalError?.code || err?.code || null,
    });
    err = new DatabaseUnavailableError(err);
  }

  // Determine status code
  const statusCode = err.statusCode || 500;

  // Log by severity. A 404 (health probes on "/", a ticket that lives in
  // another workspace) and other expected client errors are not incidents;
  // logging them at error level with a stack buried the real ones.
  if (statusCode === 404) {
    logger.info(`Not found: ${req.method} ${req.path}`, { statusCode, ip: req.ip });
  } else if (statusCode >= 400 && statusCode < 500) {
    logger.warn('Client error:', { message: err.message, statusCode, path: req.path, method: req.method, ip: req.ip });
  } else if (err instanceof DatabaseUnavailableError) {
    // Already logged as one warn line above (or by the thrower) — no stack per request.
  } else {
    logger.error('Error occurred:', {
      message: err.message,
      stack: err.stack,
      statusCode,
      path: req.path,
      method: req.method,
      ip: req.ip,
    });
  }

  if (res.headersSent) {
    logger.error('Error occurred after response headers were sent; closing response', {
      message: err.message,
      path: req.path,
      method: req.method,
    });
    try {
      res.end();
    } catch {
      // Response is already closed.
    }
    return;
  }

  // Format error response
  const response = formatErrorResponse(err);

  // Send response
  res.status(statusCode).json(response);

  // If it's a non-operational error, we might want to restart the process
  if (!isOperationalError(err)) {
    logger.error('Non-operational error detected. Consider restarting the process.');
    // In production, you might want to:
    // 1. Send alert to monitoring service
    // 2. Gracefully shutdown the server
    // 3. Let process manager (PM2, Docker, Kubernetes) restart it
  }
}

/**
 * Middleware to catch async errors
 * Wraps async route handlers to catch rejected promises
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 404 handler for undefined routes
 */
export function notFoundHandler(req, res, next) {
  const error = new NotFoundError(`Route not found: ${req.method} ${req.path}`);
  next(error);
}
