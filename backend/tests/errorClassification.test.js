import {
  classifyProviderError,
  sanitizeProviderErrorMessage,
} from '../src/services/aiProviders/errorClassification.js';

describe('provider error classification', () => {
  test('classifies retryable provider errors', () => {
    const rateLimit = new Error('rate limit exceeded');
    rateLimit.status = 429;
    expect(classifyProviderError(rateLimit)).toMatchObject({
      errorClass: 'rate_limited',
      retryable: true,
      statusCode: 429,
    });

    const timeout = new Error('request timeout');
    expect(classifyProviderError(timeout)).toMatchObject({
      errorClass: 'api_timeout',
      retryable: true,
    });

    const providerDown = new Error('upstream unavailable');
    providerDown.statusCode = 529;
    expect(classifyProviderError(providerDown)).toMatchObject({
      errorClass: 'provider_down',
      retryable: true,
    });
  });

  test('does not retry prompt or schema failures', () => {
    const badRequest = new Error('bad request');
    badRequest.status = 400;
    expect(classifyProviderError(badRequest)).toMatchObject({
      errorClass: 'bad_request',
      retryable: false,
    });

    const schema = new Error('schema validation failed');
    schema.code = 'schema_validation';
    expect(classifyProviderError(schema)).toMatchObject({
      errorClass: 'schema_validation',
      retryable: false,
    });
  });

  test('redacts API keys from stored messages', () => {
    const openAiLikeKey = ['sk', 'testSecret'].join('-');
    const anthropicLikeKey = ['ant', 'testSecret'].join('-');
    expect(sanitizeProviderErrorMessage(`failed with ${openAiLikeKey} and ${anthropicLikeKey}`))
      .toBe('failed with [redacted] and [redacted]');
  });
});
