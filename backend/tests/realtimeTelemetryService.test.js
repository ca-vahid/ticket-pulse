import { jest } from '@jest/globals';

/**
 * Realtime plan Phase 3 — in-memory client-telemetry aggregate: per-day
 * counters, top-affected-users truncation (support hint, never a leaderboard),
 * bounded memory (2 days kept, capped distinct users), migration-free.
 */

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  RealtimeTelemetryService,
  truncateEmail,
  TELEMETRY_DAYS_KEPT,
  TELEMETRY_MAX_USERS_PER_DAY,
  TELEMETRY_TOP_USERS,
} = await import('../src/services/realtimeTelemetryService.js');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-08-15T12:00:00Z');

describe('truncateEmail', () => {
  test('keeps 3 chars of the local part + full domain', () => {
    expect(truncateEmail('adrian.lo@bgcengineering.ca')).toBe('adr…@bgcengineering.ca');
    expect(truncateEmail('AL@bgc.ca')).toBe('al@bgc.ca');
    expect(truncateEmail('')).toBeNull();
  });
});

describe('record + summary', () => {
  test('aggregates counts by type/transport, churn max, and top users', () => {
    const svc = new RealtimeTelemetryService();
    svc.record({ userEmail: 'a@bgc.ca', type: 'downgrade', transport: 'longpoll', churn: 3 }, T0);
    svc.record({ userEmail: 'a@bgc.ca', type: 'downgrade', transport: 'shortpoll', churn: 9 }, T0);
    svc.record({ userEmail: 'b@bgc.ca', type: 'offline' }, T0);
    svc.record({ userEmail: 'b@bgc.ca', type: 'offline-terminal', churn: 2 }, T0);

    const s = svc.summary(T0);
    expect(s.today.downgrades).toBe(2);
    expect(s.today.downgradesByTransport).toEqual({ longpoll: 1, shortpoll: 1 });
    expect(s.today.offline).toBe(1);
    expect(s.today.offlineTerminal).toBe(1);
    expect(s.today.churnMax).toBe(9);
    expect(s.today.affectedUsers).toBe(2);
    expect(s.today.topUsers).toHaveLength(2);
    expect(s.today.topUsers[0]).toEqual({ user: 'a@bgc.ca', events: 2 });
  });

  test('drops unknown types and unknown transports quietly', () => {
    const svc = new RealtimeTelemetryService();
    expect(svc.record({ type: 'nonsense' }, T0)).toBe(false);
    expect(svc.record({ type: 'downgrade', transport: 'carrier-pigeon' }, T0)).toBe(true);
    const s = svc.summary(T0);
    expect(s.today.downgrades).toBe(1);
    expect(s.today.downgradesByTransport).toEqual({ longpoll: 0, shortpoll: 0 });
  });

  test('keeps only today + yesterday (bounded memory)', () => {
    const svc = new RealtimeTelemetryService();
    svc.record({ type: 'offline' }, T0 - 2 * DAY);
    svc.record({ type: 'offline' }, T0 - DAY);
    svc.record({ type: 'offline' }, T0);
    expect(svc.days.size).toBe(TELEMETRY_DAYS_KEPT);
    const s = svc.summary(T0);
    expect(s.today.offline).toBe(1);
    expect(s.yesterday.offline).toBe(1);
  });

  test('caps distinct users per day and top list at 5', () => {
    const svc = new RealtimeTelemetryService();
    for (let i = 0; i < TELEMETRY_MAX_USERS_PER_DAY + 20; i++) {
      svc.record({ userEmail: `user${i}@bgc.ca`, type: 'offline' }, T0);
    }
    const s = svc.summary(T0);
    expect(s.today.affectedUsers).toBe(TELEMETRY_MAX_USERS_PER_DAY);
    expect(s.today.topUsers).toHaveLength(TELEMETRY_TOP_USERS);
  });

  test('summary on an empty day returns zeros, never throws', () => {
    const svc = new RealtimeTelemetryService();
    const s = svc.summary(T0);
    expect(s.today.reports).toBe(0);
    expect(s.yesterday).toBeNull();
    expect(s.sampling).toMatch(/10%/);
  });
});
