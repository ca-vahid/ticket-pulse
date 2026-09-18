import { jest } from '@jest/globals';

/**
 * Hourly review, 18 Sep 2026 — a Field Equipment agent pasted an e-mail with
 * embedded pictures into a note. The body blew multer's 1 MB field limit and they
 * got a raw 500 "Field value too long", with "Non-operational error detected.
 * Consider restarting the process." in the log. They tried twice and gave up.
 * An upload limit is the sender's problem: a 4xx with words a person can act on.
 */
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
const { errorHandler } = await import('../src/middleware/errorHandler.js');

const multerError = (code, message) => Object.assign(new Error(message), { name: 'MulterError', code });
const run = (err) => {
  const res = { headersSent: false, statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  errorHandler(err, { path: '/api/tickets/44082/notes', method: 'POST', ip: '1.2.3.4' }, res, () => {});
  return res;
};

beforeEach(() => jest.clearAllMocks());

describe('upload limits are client errors with a usable message', () => {
  test('the production case: an oversized text field → 413, plain words, no restart advice', () => {
    const res = run(multerError('LIMIT_FIELD_VALUE', 'Field value too long'));
    expect(res.statusCode).toBe(413);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/too large to send/i);
    expect(res.body.message).toMatch(/attach them as files/i);
    expect(res.body.message).not.toMatch(/Field value too long/);
    expect(res.body.code).toBe('limit_field_value');
    // Logged as a client warning — not an error with a stack, and never "consider restarting".
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  test('an oversized file → 413', () => {
    const res = run(multerError('LIMIT_FILE_SIZE', 'File too large'));
    expect(res.statusCode).toBe(413);
    expect(res.body.message).toMatch(/attached files is too large/i);
  });

  test('too many files → 400', () => {
    expect(run(multerError('LIMIT_FILE_COUNT', 'Too many files')).statusCode).toBe(400);
    expect(run(multerError('LIMIT_UNEXPECTED_FILE', 'Unexpected field')).statusCode).toBe(400);
  });

  test('an unknown multer code still becomes a 400, never a 500', () => {
    const res = run(multerError('LIMIT_SOMETHING_NEW', 'whatever'));
    expect(res.statusCode).toBe(400);
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  test('a genuine programming error is still a 500 and still flagged', () => {
    const res = run(new TypeError('x is not a function'));
    expect(res.statusCode).toBe(500);
    expect(loggerMock.error).toHaveBeenCalled();
  });
});
