import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * In-app profile photos (QA 09-22 #7): own upload, admin upload, revert to
 * the directory photo, and the sync leaving custom photos alone.
 */
const prismaMock = {
  technician: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
};
const azureMock = { isConfigured: jest.fn(() => false), getUserPhoto: jest.fn(), getUserProfile: jest.fn(), getUserPhotos: jest.fn(), getUserProfiles: jest.fn() };
let currentUser = { email: 'sxu@bgcengineering.ca', role: 'agent' };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: azureMock }));
jest.unstable_mockModule('../src/services/dashboardReadCache.js', () => ({ clearReadCache: jest.fn() }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.user = currentUser; req.workspaceId = 1; next(); },
  requireAdmin: (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ success: false, message: 'Admin access required' })),
}));

const { default: photosRoutes } = await import('../src/routes/photos.routes.js');

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/photos', photosRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message }));
  return app;
}

const PIXEL = `data:image/jpeg;base64,${Buffer.from('not-really-a-jpeg-but-fine-for-the-route').toString('base64')}`;
const ME = { id: 42, name: 'Susan Xu', email: 'sxu@bgcengineering.ca', photoUrl: null, photoSource: null, photoSyncedAt: null, workspaceId: 1 };

beforeEach(() => {
  jest.clearAllMocks();
  currentUser = { email: 'sxu@bgcengineering.ca', role: 'agent' };
  prismaMock.technician.findFirst.mockResolvedValue({ ...ME });
  prismaMock.technician.update.mockImplementation(({ data }) => Promise.resolve({ ...ME, ...data }));
});

describe('PUT /api/photos/me', () => {
  test('stores the data URL on the caller\'s own technician row as a custom photo', async () => {
    const res = await request(buildApp()).put('/api/photos/me').send({ dataUrl: PIXEL });
    expect(res.status).toBe(200);
    expect(prismaMock.technician.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: 1, isActive: true, email: { equals: 'sxu@bgcengineering.ca', mode: 'insensitive' } }),
    }));
    expect(prismaMock.technician.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 42 }, data: expect.objectContaining({ photoUrl: PIXEL, photoSource: 'custom' }),
    }));
    expect(res.body.data.photoSource).toBe('custom');
  });

  test('rejects a non-image and an oversized image with 400; no technician row → 404', async () => {
    let res = await request(buildApp()).put('/api/photos/me').send({ dataUrl: 'data:text/html;base64,PGI+' });
    expect(res.status).toBe(400);
    const big = `data:image/png;base64,${'A'.repeat(420 * 1024)}`;
    res = await request(buildApp()).put('/api/photos/me').send({ dataUrl: big });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/too large/);
    prismaMock.technician.findFirst.mockResolvedValue(null);
    res = await request(buildApp()).put('/api/photos/me').send({ dataUrl: PIXEL });
    expect(res.status).toBe(404);
    expect(prismaMock.technician.update).not.toHaveBeenCalled();
  });

  test('DELETE reverts to the directory photo (none when Entra is off)', async () => {
    const res = await request(buildApp()).delete('/api/photos/me');
    expect(res.status).toBe(200);
    expect(prismaMock.technician.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ photoUrl: null, photoSource: null }),
    }));
  });
});

describe('admin uploads for the roster', () => {
  test('an agent cannot set someone else\'s photo; an admin can, within the workspace', async () => {
    let res = await request(buildApp()).put('/api/photos/77').send({ dataUrl: PIXEL });
    expect(res.status).toBe(403);
    currentUser = { email: 'vhaeri@bgcengineering.ca', role: 'admin' };
    prismaMock.technician.findFirst.mockResolvedValue({ ...ME, id: 77, email: 'aregli@bgcengineering.ca' });
    res = await request(buildApp()).put('/api/photos/77').send({ dataUrl: PIXEL });
    expect(res.status).toBe(200);
    expect(prismaMock.technician.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 77, workspaceId: 1 } }));
    expect(prismaMock.technician.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 77 }, data: expect.objectContaining({ photoSource: 'custom' }) }));
  });
});

describe('directory sync leaves custom photos alone', () => {
  test('POST /sync/:id on a custom photo returns without touching the row', async () => {
    currentUser = { email: 'vhaeri@bgcengineering.ca', role: 'admin' };
    azureMock.isConfigured.mockReturnValue(true);
    prismaMock.technician.findUnique.mockResolvedValue({ id: 42, email: 'sxu@bgcengineering.ca', name: 'Susan Xu', location: null, photoSource: 'custom', photoUrl: PIXEL });
    const res = await request(buildApp()).post('/api/photos/sync/42');
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/uploaded their own photo/);
    expect(azureMock.getUserPhoto).not.toHaveBeenCalled();
    expect(prismaMock.technician.update).not.toHaveBeenCalled();
  });

  test('the bulk sync query excludes custom photos', async () => {
    currentUser = { email: 'vhaeri@bgcengineering.ca', role: 'admin' };
    azureMock.isConfigured.mockReturnValue(true);
    prismaMock.technician.findMany.mockResolvedValue([]);
    const res = await request(buildApp()).post('/api/photos/sync').send({});
    expect(res.status).toBe(200);
    expect(prismaMock.technician.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: [{ photoSource: null }, { photoSource: { not: 'custom' } }] }),
    }));
  });
});
