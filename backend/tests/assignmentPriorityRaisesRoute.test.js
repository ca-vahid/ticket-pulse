import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * QA 11-23 item 2: GET /api/assignment/priority-raises — the weekly "the
 * requester raised it" list. Reviewer (coordinator) or admin, scoped to the
 * selected workspace, read-only.
 */

const listMock = jest.fn();
let allowReviewer = true;

jest.unstable_mockModule('../src/services/priorityHistoryService.js', () => ({
  listRequesterPriorityRaises: listMock,
}));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireReviewer: (_req, res, next) => (allowReviewer ? next() : res.status(403).json({ success: false, message: 'Reviewer access required' })),
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: router } = await import('../src/routes/assignmentPriorityRaises.routes.js');

function buildApp(workspaceId = 1) {
  const app = express();
  app.use((req, _res, next) => { req.workspaceId = workspaceId; next(); });
  app.use('/api/assignment', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  return app;
}

const ROW = {
  ticketId: 11, displayRef: 'TP-1042', subject: 'Cannot sign in to Teams', aiPriority: 'Medium',
  raisedTo: 'Urgent', raisedAt: '2026-11-23T18:17:00.000Z', requesterName: 'Dana Fox',
};

beforeEach(() => {
  jest.clearAllMocks();
  allowReviewer = true;
  listMock.mockResolvedValue([ROW]);
});

test('returns the contract rows for the selected workspace (default 7 days)', async () => {
  const res = await request(buildApp(3)).get('/api/assignment/priority-raises');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, data: [ROW], days: 7 });
  expect(listMock).toHaveBeenCalledWith({ workspaceId: 3, days: 7 });
});

test('days is clamped to 1..90', async () => {
  await request(buildApp()).get('/api/assignment/priority-raises?days=400');
  expect(listMock).toHaveBeenLastCalledWith({ workspaceId: 1, days: 90 });
  await request(buildApp()).get('/api/assignment/priority-raises?days=0');
  expect(listMock).toHaveBeenLastCalledWith({ workspaceId: 1, days: 1 });
  await request(buildApp()).get('/api/assignment/priority-raises?days=abc');
  expect(listMock).toHaveBeenLastCalledWith({ workspaceId: 1, days: 7 });
});

test('below coordinator: 403, nothing read', async () => {
  allowReviewer = false;
  const res = await request(buildApp()).get('/api/assignment/priority-raises');
  expect(res.status).toBe(403);
  expect(listMock).not.toHaveBeenCalled();
});

test('read-only: no write verbs', async () => {
  const res = await request(buildApp()).post('/api/assignment/priority-raises').send({});
  expect(res.status).toBe(404);
});
