import { jest } from '@jest/globals';

/**
 * 16 Sep 2026 outage (15:59–16:16 UTC): the App Service lost its path to the
 * database. Two things made it worse than it had to be, both pinned here:
 *  1. workspaceRepository.getAccessRole / hasActiveTechnician swallowed the
 *     DB error and answered "no access" → 12 users saw a 403.
 *  2. every failing request logged a stack + "Non-operational error detected.
 *     Consider restarting the process." (460 lines) instead of one 503.
 */

const prismaMock = {
  workspaceAccess: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn() },
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const { default: workspaceRepository } = await import('../src/services/workspaceRepository.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { DatabaseError, DatabaseUnavailableError, AuthorizationError, isDatabaseConnectivityError } = await import('../src/utils/errors.js');

const poolTimeout = () => Object.assign(new Error('\nInvalid `prisma.workspaceAccess.findUnique()` invocation:\n\n\nTimed out fetching a new connection from the connection pool. More info: http://pris.ly/d/connection-pool (Current connection pool timeout: 10, connection limit: 9)'), { name: 'PrismaClientKnownRequestError', code: 'P2024' });

const fakeRes = () => {
  const res = { headersSent: false, statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

beforeEach(() => { jest.clearAllMocks(); });

describe('access lookups during a database outage', () => {
  test('getAccessRole throws a DatabaseError instead of answering "no access"', async () => {
    prismaMock.workspaceAccess.findUnique.mockRejectedValue(poolTimeout());
    await expect(workspaceRepository.getAccessRole('mblackstock@bgcengineering.ca', 1)).rejects.toBeInstanceOf(DatabaseError);
  });

  test('hasActiveTechnician throws instead of answering "not a technician"', async () => {
    prismaMock.technician.findFirst.mockRejectedValue(poolTimeout());
    await expect(workspaceRepository.hasActiveTechnician('aho@bgcengineering.ca', 1)).rejects.toBeInstanceOf(DatabaseError);
  });

  test('a real "no row" still answers null / false', async () => {
    prismaMock.workspaceAccess.findUnique.mockResolvedValue(null);
    prismaMock.technician.findFirst.mockResolvedValue(null);
    await expect(workspaceRepository.getAccessRole('x@bgcengineering.ca', 1)).resolves.toBeNull();
    await expect(workspaceRepository.hasActiveTechnician('x@bgcengineering.ca', 1)).resolves.toBe(false);
  });
});

describe('errorHandler maps connectivity failures to 503 database_unavailable', () => {
  const req = { path: '/api/tickets', method: 'GET', ip: '1.2.3.4' };

  test('a raw Prisma pool timeout → 503, retry message, one warn line, no "consider restarting"', () => {
    const res = fakeRes();
    errorHandler(poolTimeout(), req, res, () => {});
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual(expect.objectContaining({ success: false, code: 'database_unavailable', message: expect.stringMatching(/retry in a minute/) }));
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringMatching(/^Database unavailable: Timed out fetching a new connection/), expect.objectContaining({ code: 'P2024' }));
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  test('a DatabaseError wrapping P1001 (server unreachable) → 503 as well', () => {
    const res = fakeRes();
    const wrapped = new DatabaseError('Failed to check workspace access', Object.assign(new Error("Can't reach database server at `ticket-pulse-pg`"), { code: 'P1001' }));
    errorHandler(wrapped, req, res, () => {});
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('database_unavailable');
  });

  test('an ordinary DatabaseError (constraint, bad query) stays a 500', () => {
    const res = fakeRes();
    errorHandler(new DatabaseError('Failed to update workspace', Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })), req, res, () => {});
    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBeUndefined();
  });

  test('a 403 is untouched', () => {
    const res = fakeRes();
    errorHandler(new AuthorizationError('You do not have access to this workspace', 'workspace_access_denied'), req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('workspace_access_denied');
  });

  test('isDatabaseConnectivityError recognises the pg-pool ETIMEDOUT and initialization errors too', () => {
    expect(isDatabaseConnectivityError(new Error('read ETIMEDOUT'))).toBe(true);
    expect(isDatabaseConnectivityError(Object.assign(new Error('x'), { name: 'PrismaClientInitializationError' }))).toBe(true);
    expect(isDatabaseConnectivityError(new Error('Unique constraint failed'))).toBe(false);
    expect(new DatabaseUnavailableError().statusCode).toBe(503);
  });
});
