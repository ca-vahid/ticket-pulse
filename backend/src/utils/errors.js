/**
 * Custom error classes for better error handling
 */

export class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400);
    this.details = details;
  }
}

export class AuthenticationError extends AppError {
  // 401 — the caller's CREDENTIALS are missing/invalid. The frontend treats
  // this as "re-authenticate" (silent MSAL recovery, then login redirect).
  constructor(message = 'Authentication failed', code = 'auth_required') {
    super(message, 401);
    this.code = code;
  }
}

export class AuthorizationError extends AppError {
  // 403 — the caller is authenticated but lacks PERMISSION. The frontend must
  // NEVER run auth recovery/sign-out for these; `code` lets it distinguish
  // which gate refused (workspace_access_denied, admin_required, ...).
  constructor(message = 'You do not have permission to perform this action', code = 'forbidden') {
    super(message, 403);
    this.code = code;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 409);
  }
}

export class ServiceBusyError extends AppError {
  constructor(message = 'The service is busy — please try again in a moment') {
    super(message, 503);
  }
}

export class ExternalAPIError extends AppError {
  constructor(service, message, originalError = null) {
    super(`${service} API error: ${message}`, 502);
    this.service = service;
    this.originalError = originalError;
  }
}

export class DatabaseError extends AppError {
  constructor(message, originalError = null) {
    super(`Database error: ${message}`, 500);
    this.originalError = originalError;
  }
}

/**
 * Format error for API response
 */
export function formatErrorResponse(error) {
  const response = {
    success: false,
    message: error.message || 'An unexpected error occurred',
  };

  // Add error details for validation errors
  if (error instanceof ValidationError && error.details) {
    response.details = error.details;
  }

  // Problem code (auth/authorization errors): lets the frontend distinguish
  // "credentials are bad" (401 auth_required) from "no permission" (403
  // workspace_access_denied / admin_required / ...) without string matching.
  if (error instanceof AppError && typeof error.code === 'string' && error.code) {
    response.code = error.code;
  }

  // Add stack trace in development
  if (process.env.NODE_ENV === 'development' && error.stack) {
    response.stack = error.stack;
  }

  return response;
}

/**
 * Check if error is operational (expected) vs programming error
 */
export function isOperationalError(error) {
  if (error instanceof AppError) {
    return error.isOperational;
  }
  return false;
}
