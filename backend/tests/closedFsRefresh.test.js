import { describe, expect, test } from '@jest/globals';

/**
 * QA 11-06 #2: opening a closed FreshService-born ticket refreshes its files and
 * thread from FreshService (the original e-mail's attachments only arrive with the
 * FS ticket detail), at most once per ticket every six hours.
 */
const { closedFsRefreshDue, closedFsRefreshWanted } = await import('../src/services/ticketService.js');

describe('which opens refresh a closed ticket from FreshService', () => {
  const closedFs = { id: 18853, origin: 'freshservice', freshserviceTicketId: 170683n, status: 'Closed' };
  test('a person opening a closed FreshService ticket: yes', () => {
    expect(closedFsRefreshWanted(closedFs, true)).toBe(true);
  });
  test('an API read (reconcile: false): never, so integrations make no FreshService calls', () => {
    expect(closedFsRefreshWanted(closedFs, false)).toBe(false);
  });
  test('Ticket Pulse-born, Deleted, Spam, or no FreshService id: no', () => {
    expect(closedFsRefreshWanted({ ...closedFs, origin: 'ticketpulse' }, true)).toBe(false);
    expect(closedFsRefreshWanted({ ...closedFs, status: 'Deleted' }, true)).toBe(false);
    expect(closedFsRefreshWanted({ ...closedFs, status: 'Spam' }, true)).toBe(false);
    expect(closedFsRefreshWanted({ ...closedFs, freshserviceTicketId: null }, true)).toBe(false);
  });
});

describe('closed FS-born ticket refresh on open', () => {
  test('the first open refreshes; a re-open within six hours does not', () => {
    const t0 = 1_800_000_000_000;
    expect(closedFsRefreshDue(424242, t0)).toBe(true);
    expect(closedFsRefreshDue(424242, t0 + 60_000)).toBe(false);
    expect(closedFsRefreshDue(424242, t0 + 5.9 * 3600e3)).toBe(false);
  });

  test('after six hours it refreshes again, and tickets are tracked separately', () => {
    const t0 = 1_800_000_000_000;
    expect(closedFsRefreshDue(515151, t0)).toBe(true);
    expect(closedFsRefreshDue(616161, t0)).toBe(true);
    expect(closedFsRefreshDue(515151, t0 + 6 * 3600e3 + 1)).toBe(true);
  });
});
