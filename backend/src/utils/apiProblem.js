/**
 * RFC 9457 "Problem Details" helpers for the public API (/api/v1).
 * Every error the versioned API returns is `application/problem+json` with a
 * stable machine-readable `code`, a human `title`/`detail`, the HTTP `status`,
 * the request `instance` path, and the `request_id` for support correlation.
 */
import logger from './logger.js';
import { AppError } from './errors.js';

const TYPE_BASE = 'https://ticketpulse.bgcsaas.com/api/v1/errors/';

export class ApiProblem extends Error {
  constructor({ status = 500, code = 'error', title, detail = null, errors = null, headers = null }) {
    super(detail || title || code);
    this.name = 'ApiProblem';
    this.status = status;
    this.code = code;
    this.title = title || code;
    this.detail = detail;
    this.errors = errors;
    this.headers = headers;
  }
}

// Convenience factories for the common cases.
export const problems = {
  unauthorized: (detail, code = 'unauthorized') => new ApiProblem({ status: 401, code, title: 'Unauthorized', detail }),
  forbidden: (detail, code = 'forbidden') => new ApiProblem({ status: 403, code, title: 'Forbidden', detail }),
  notFound: (detail = 'Resource not found') => new ApiProblem({ status: 404, code: 'not_found', title: 'Not found', detail }),
  badRequest: (detail, errors = null) => new ApiProblem({ status: 400, code: 'invalid_request', title: 'Invalid request', detail, errors }),
  conflict: (detail) => new ApiProblem({ status: 409, code: 'conflict', title: 'Conflict', detail }),
  preconditionFailed: (detail) => new ApiProblem({ status: 412, code: 'precondition_failed', title: 'Precondition failed', detail }),
  rateLimited: (detail, retryAfter) => new ApiProblem({ status: 429, code: 'rate_limited', title: 'Too many requests', detail, headers: { 'Retry-After': String(retryAfter) } }),
  unavailable: (detail) => new ApiProblem({ status: 503, code: 'service_unavailable', title: 'Service unavailable', detail }),
};

const CODE_BY_STATUS = {
  400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden',
  404: 'not_found', 409: 'conflict', 412: 'precondition_failed',
  429: 'rate_limited', 502: 'upstream_error', 503: 'service_unavailable',
};

/** Coerce any thrown error into an ApiProblem. */
export function toProblem(err) {
  if (err instanceof ApiProblem) return err;
  if (err instanceof AppError) {
    const status = err.statusCode || 500;
    return new ApiProblem({
      status,
      code: CODE_BY_STATUS[status] || (status >= 500 ? 'internal_error' : 'error'),
      title: status >= 500 ? 'Internal error' : (err.name || 'Error').replace(/Error$/, ''),
      detail: status >= 500 ? 'An unexpected error occurred.' : err.message,
      errors: err.details || null,
    });
  }
  return new ApiProblem({ status: 500, code: 'internal_error', title: 'Internal error', detail: 'An unexpected error occurred.' });
}

export function sendProblem(res, err) {
  const problem = toProblem(err);
  const requestId = res.getHeader('X-Request-Id') || null;
  const body = {
    type: `${TYPE_BASE}${problem.code}`,
    title: problem.title,
    status: problem.status,
    code: problem.code,
    detail: problem.detail || undefined,
    instance: res.req?.originalUrl || undefined,
    request_id: requestId || undefined,
  };
  if (problem.errors) body.errors = problem.errors;
  if (problem.headers) for (const [k, v] of Object.entries(problem.headers)) res.set(k, v);
  return res.status(problem.status).type('application/problem+json').json(body);
}

/** Express error-handling middleware for the /api/v1 sub-router. */
export function apiProblemHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const problem = toProblem(err);
  if (problem.status >= 500) {
    logger.error(`API v1 error on ${req.method} ${req.originalUrl}: ${err.message}`, { stack: err.stack });
  }
  return sendProblem(res, problem);
}
