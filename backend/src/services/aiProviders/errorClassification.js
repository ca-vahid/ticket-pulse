const RETRYABLE_CLASSES = new Set([
  'config_missing',
  'auth_error',
  'rate_limited',
  'provider_down',
  'api_timeout',
  'stream_stall',
  'unknown',
]);

function statusCodeFromError(error) {
  const value = error?.status || error?.statusCode || error?.response?.status;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export function sanitizeProviderErrorMessage(error) {
  return String(error?.message || error || 'Unknown provider error')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/ant-[A-Za-z0-9_-]+/g, '[redacted]')
    .slice(0, 500);
}

export function classifyProviderError(error) {
  const statusCode = statusCodeFromError(error);
  const message = sanitizeProviderErrorMessage(error);
  const lower = message.toLowerCase();
  let errorClass = 'unknown';

  if (
    lower.includes('api key')
    || lower.includes('not configured')
    || lower.includes('missing')
  ) {
    errorClass = 'config_missing';
  } else if (statusCode === 401 || statusCode === 403 || lower.includes('authentication')) {
    errorClass = 'auth_error';
  } else if (statusCode === 429 || lower.includes('rate limit')) {
    errorClass = 'rate_limited';
  } else if (
    statusCode === 408
    || error?.name === 'TimeoutError'
    || error?.code === 'ETIMEDOUT'
    || lower.includes('timeout')
  ) {
    errorClass = 'api_timeout';
  } else if (lower.includes('stream') && (lower.includes('stall') || lower.includes('timed out'))) {
    errorClass = 'stream_stall';
  } else if (statusCode === 400 || statusCode === 422 || lower.includes('bad request')) {
    errorClass = 'bad_request';
  } else if (error?.code === 'schema_validation' || lower.includes('schema validation')) {
    errorClass = 'schema_validation';
  } else if ((statusCode && statusCode >= 500) || statusCode === 529 || error?.code === 'ECONNRESET') {
    errorClass = 'provider_down';
  }

  return {
    errorClass,
    statusCode,
    message,
    retryable: RETRYABLE_CLASSES.has(errorClass),
  };
}

export function isRetryableProviderError(error) {
  return classifyProviderError(error).retryable;
}
