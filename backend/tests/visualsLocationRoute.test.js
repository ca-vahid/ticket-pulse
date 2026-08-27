import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * PATCH /api/visuals/agents/:id/location (QA 08-24 #1 — MP4):
 *  - response carries { location, resolved, lat, lng } resolved against the
 *    shared office table (mirror of frontend/src/utils/officeLocations.js)
 *  - "lat,lng" text is range-validated and stored normalized
 *  - unrecognized free text is still stored (admin's call) but resolved:false
 */

const updateSpy = jest.fn();

jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({
  default: {
    update: updateSpy,
    getAll: jest.fn().mockResolvedValue([]),
    getAllActive: jest.fn().mockResolvedValue([]),
  },
}));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAuth: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: visualsRouter } = await import('../src/routes/visuals.routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/visuals', visualsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  });
  return app;
}

beforeEach(() => {
  updateSpy.mockReset();
  updateSpy.mockImplementation(async (id, data) => ({ id, name: 'Victor Vega', location: data.location }));
});

describe('PATCH /api/visuals/agents/:id/location', () => {
  test('known city (suffix + case tolerant) → resolved:true with coordinates', async () => {
    const res = await request(buildApp()).patch('/api/visuals/agents/7/location').send({ location: '  Santiago, Chile ' });
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(7, { location: 'Santiago, Chile' });
    expect(res.body.data).toEqual({
      id: 7, name: 'Victor Vega', location: 'Santiago, Chile', resolved: true, lat: -33.4489, lng: -70.6693,
    });
    expect(res.body.message).toBe('Location updated successfully');
  });

  test('unrecognized text is stored but flagged resolved:false with null coordinates', async () => {
    const res = await request(buildApp()).patch('/api/visuals/agents/7/location').send({ location: 'Atlantis' });
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(7, { location: 'Atlantis' });
    expect(res.body.data).toMatchObject({ location: 'Atlantis', resolved: false, lat: null, lng: null });
    expect(res.body.message).toMatch(/not a known city/);
  });

  test('"lat,lng" text is normalized and resolves as exact coordinates', async () => {
    const res = await request(buildApp()).patch('/api/visuals/agents/7/location').send({ location: ' -33.44890001, -70.6693 ' });
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(7, { location: '-33.4489,-70.6693' });
    expect(res.body.data).toMatchObject({ location: '-33.4489,-70.6693', resolved: true, lat: -33.4489, lng: -70.6693 });
  });

  test('out-of-range coordinates → 400, nothing stored', async () => {
    for (const bad of ['95,10', '10,181', '-91, 0']) {
      const res = await request(buildApp()).patch('/api/visuals/agents/7/location').send({ location: bad });
      expect(`${bad}:${res.status}`).toBe(`${bad}:400`);
      expect(res.body.message).toMatch(/lat in -90\.\.90/);
    }
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test('empty string clears the location (resolved:false, no warning message)', async () => {
    const res = await request(buildApp()).patch('/api/visuals/agents/7/location').send({ location: '' });
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(7, { location: null });
    expect(res.body.data).toMatchObject({ location: null, resolved: false, lat: null, lng: null });
    expect(res.body.message).toBe('Location updated successfully');
  });

  test('validation: non-string, over-long, bad id', async () => {
    expect((await request(buildApp()).patch('/api/visuals/agents/7/location').send({ location: 42 })).status).toBe(400);
    expect((await request(buildApp()).patch('/api/visuals/agents/7/location').send({ location: 'x'.repeat(101) })).status).toBe(400);
    expect((await request(buildApp()).patch('/api/visuals/agents/abc/location').send({ location: 'Calgary' })).status).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
