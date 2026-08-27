import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Phase HD3 (QA 08-25 #3) — POST /autoresponse/holidays/load-canadian:
 * accepts `{years:[]}` (and the legacy `{year}`), defaults to this year +
 * next, and answers with created/skipped counts the UI can toast.
 */

const availabilityServiceMock = {
  loadCanadianHolidaysForYears: jest.fn(),
  getHolidays: jest.fn(),
};

jest.unstable_mockModule('../src/middleware/errorHandler.js', () => ({
  asyncHandler: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
}));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.workspaceId = 3; next(); },
}));
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({ default: availabilityServiceMock }));
jest.unstable_mockModule('../src/services/queueStatsService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/autoResponseRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/config/index.js', () => ({ default: { sync: { defaultTimezone: 'America/Los_Angeles' } } }));

const { default: router } = await import('../src/routes/autoresponse.routes.js');

const app = express();
app.use(express.json());
app.use('/api/autoresponse', router);

const thisYear = new Date().getUTCFullYear();

beforeEach(() => {
  jest.clearAllMocks();
  availabilityServiceMock.loadCanadianHolidaysForYears.mockImplementation(async (years) => {
    const list = Array.isArray(years) ? years : (years ? [years] : [thisYear, thisYear + 1]);
    return { years: list, created: 5 * list.length, skipped: 7 * list.length, perYear: list.map((year) => ({ year, created: 5, skipped: 7 })) };
  });
});

describe('POST /api/autoresponse/holidays/load-canadian', () => {
  test('no body → this year + next, workspace-scoped, counts + human message', async () => {
    const res = await request(app).post('/api/autoresponse/holidays/load-canadian').send({});

    expect(res.status).toBe(200);
    expect(availabilityServiceMock.loadCanadianHolidaysForYears).toHaveBeenCalledWith(null, 3);
    expect(res.body.data).toEqual(expect.objectContaining({ years: [thisYear, thisYear + 1], created: 10, skipped: 14 }));
    expect(res.body.message).toBe(`Canadian holidays ${thisYear}–${thisYear + 1}: 10 added, 14 already present`);
  });

  test('{years:[2026,2027]} is forwarded as given', async () => {
    const res = await request(app).post('/api/autoresponse/holidays/load-canadian').send({ years: [2026, 2027] });

    expect(res.status).toBe(200);
    expect(availabilityServiceMock.loadCanadianHolidaysForYears).toHaveBeenCalledWith([2026, 2027], 3);
    expect(res.body.data.years).toEqual([2026, 2027]);
    expect(res.body.message).toBe('Canadian holidays 2026–2027: 10 added, 14 already present');
  });

  test('legacy {year} still works and labels a single year', async () => {
    const res = await request(app).post('/api/autoresponse/holidays/load-canadian').send({ year: 2026 });

    expect(availabilityServiceMock.loadCanadianHolidaysForYears).toHaveBeenCalledWith(2026, 3);
    expect(res.body.message).toBe('Canadian holidays 2026: 5 added, 7 already present');
  });

  test('an empty years array falls back to the default window', async () => {
    await request(app).post('/api/autoresponse/holidays/load-canadian').send({ years: [] });
    expect(availabilityServiceMock.loadCanadianHolidaysForYears).toHaveBeenCalledWith(null, 3);
  });
});
