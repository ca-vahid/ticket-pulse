import logger from '../utils/logger.js';
import { formatErrorResponse, isOperationalError } from '../utils/errors.js';

/**
 * Global error handling middleware
 * Must be added AFTER all routes
 */
export function errorHandler(err, req, res, _next) {
  // Log the error
  logger.error('Error occurred:', {
    message: err.message,
    stack: err.stack,
    statusCode: err.statusCode,
    path: req.path,
    method: req.method,
    ip: req.ip,
  });

  // Determine status code
  const statusCode = err.statusCode || 500;

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
  const error = new Error(`Route not found: ${req.method} ${req.path}`);
  error.statusCode = 404;
  next(error);
}
