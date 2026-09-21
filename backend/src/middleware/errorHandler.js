import logger from '../utils/logger.js';
import { formatErrorResponse, isOperationalError, isDatabaseConnectivityError, DatabaseUnavailableError } from '../utils/errors.js';
import { AppError, NotFoundError } from '../utils/errors.js';

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

  // Upload limits are the sender's problem, not a crash (18 Sep 2026: a Field
  // Equipment agent pasted an e-mail with embedded pictures into a note, the
  // body blew multer's 1 MB field limit, and they got a raw 500 "Field value
  // too long" plus a "consider restarting" line in the log — twice — and gave up).
  if (err?.name === 'MulterError') {
    const messages = {
      LIMIT_FIELD_VALUE: 'That message is too large to send. Pictures pasted into the text make it huge — attach them as files instead, then try again.',
      LIMIT_FILE_SIZE: 'One of the attached files is too large.',
      LIMIT_FILE_COUNT: 'Too many files attached at once.',
      LIMIT_UNEXPECTED_FILE: 'Too many files attached at once.',
    };
    // An AppError, so isOperationalError() recognises it and nobody is told to restart the process.
    const friendly = new AppError(
      messages[err.code] || 'That upload could not be accepted.',
      err.code === 'LIMIT_FIELD_VALUE' || err.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
    );
    friendly.code = String(err.code || 'upload_rejected').toLowerCase();
    err = friendly;
  }

  // A client that hung up before the body arrived (body-parser's raw-body
  // 'request.aborted', e.g. the presence beacon of a tab being closed) is not
  // a crash either (21 Sep 2026: one "consider restarting" line per closed tab).
  if (err?.type === 'request.aborted') {
    const aborted = new AppError('The request was cancelled by the client before it finished sending.', 400);
    aborted.code = 'request_aborted';
    err = aborted;
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
