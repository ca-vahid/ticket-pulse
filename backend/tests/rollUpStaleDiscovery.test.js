import { describe, expect, test } from '@jest/globals';
import { isStaleDiscovery } from '../src/services/ticketRollUpService.js';

// 2 Oct 2026: opening an old FreshService parent fetched its child links and
// e-mailed "ready to close" for a child closed long ago. Stale discoveries on
// FreshService parents are marked but not e-mailed; Ticket Pulse parents always are.
describe('isStaleDiscovery', () => {
  const now = Date.parse('2026-10-02T21:36:00Z');
  const daysAgo = (d) => new Date(now - d * 86400e3).toISOString();
  test('FS parent whose children all closed over a day ago → stale (no e-mail)', () => {
    expect(isStaleDiscovery({ origin: 'freshservice' }, [{ closedAt: daysAgo(30) }, { resolvedAt: daysAgo(3) }], now)).toBe(true);
  });
  test('a child closed within the day → real news (e-mail)', () => {
    expect(isStaleDiscovery({ origin: 'freshservice' }, [{ closedAt: daysAgo(30) }, { closedAt: daysAgo(0.1) }], now)).toBe(false);
  });
  test('Ticket Pulse parents always e-mail', () => {
    expect(isStaleDiscovery({ origin: 'ticketpulse' }, [{ closedAt: daysAgo(30) }], now)).toBe(false);
  });
  test('no dates at all → not stale (e-mail as before)', () => {
    expect(isStaleDiscovery({ origin: 'freshservice' }, [{}], now)).toBe(false);
  });
});
