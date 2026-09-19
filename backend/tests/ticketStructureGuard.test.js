import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * "Own tickets only" (Simorgh B6 — Vahid, 19 Sep 2026). Simorgh promises to
 * structure only tickets it created; Ticket Pulse now keeps that promise too.
 */
const prismaMock = { ticketActivity: { findMany: jest.fn() }, ticket: { findMany: jest.fn() } };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { assertClientMayStructure, ticketsNotCreatedBy, guardApplies, NOT_CLIENT_TICKET } = await import('../src/services/ticketStructureGuard.js');

const SIMORGH = { name: 'Simorgh', keyPrefix: 'tpc_890e', oauthClientId: 10, structureOwnTicketsOnly: true };
const OPEN_CLIENT = { name: 'Power App', keyPrefix: 'tpc_pa', oauthClientId: 4, structureOwnTicketsOnly: false };
const created = (ticketId, by) => ({ ticketId, details: { actorEmail: by } });

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketActivity.findMany.mockResolvedValue([created(1, 'apikey:tpc_890e'), created(2, 'vhaeri@bgcengineering.ca'), created(3, 'apikey:tpc_pa')]);
  prismaMock.ticket.findMany.mockResolvedValue([
    { id: 2, origin: 'ticketpulse', nativeNumber: 1602, freshserviceTicketId: null },
    { id: 3, origin: 'ticketpulse', nativeNumber: 1603, freshserviceTicketId: null },
  ]);
});

describe('who is guarded', () => {
  test('only clients with the flag', () => {
    expect(guardApplies(SIMORGH)).toBe(true);
    expect(guardApplies(OPEN_CLIENT)).toBe(false);
    expect(guardApplies(null)).toBe(false);
    expect(guardApplies({ structureOwnTicketsOnly: true })).toBe(false); // no principal to match on
  });

  test('an unrestricted client is never looked up', async () => {
    await assertClientMayStructure(OPEN_CLIENT, [1, 2, 3], 'merge');
    expect(prismaMock.ticketActivity.findMany).not.toHaveBeenCalled();
  });
});

describe('what counts as mine', () => {
  test('the `created` history row stamped apikey:<client id> by the v1 create path', async () => {
    expect(await ticketsNotCreatedBy(SIMORGH, [1, 2, 3])).toEqual([2, 3]);
  });

  test('a ticket with no created row at all is not mine', async () => {
    expect(await ticketsNotCreatedBy(SIMORGH, [1, 99])).toEqual([99]);
  });

  test('garbage ids are ignored, duplicates collapse', async () => {
    expect(await ticketsNotCreatedBy(SIMORGH, [1, 1, 'x', null, 0])).toEqual([]);
  });
});

describe('the refusal', () => {
  test('is a 403 with code not_client_ticket that names the tickets by reference', async () => {
    await expect(assertClientMayStructure(SIMORGH, [1, 2], 'merge')).rejects.toMatchObject({
      statusCode: 403, code: NOT_CLIENT_TICKET, message: expect.stringMatching(/may only merge tickets it created.*TP-1602/),
    });
  });

  test('all mine → passes', async () => {
    await expect(assertClientMayStructure(SIMORGH, [1], 'split')).resolves.toBeUndefined();
  });

  test('a human ticket the client only POINTS at is not checked when the caller leaves it out', async () => {
    // The routes pass only the tickets an operation changes (a related_to link
    // checks the URL side only); this pins that the guard checks exactly its input.
    await expect(assertClientMayStructure(SIMORGH, [1], 'link')).resolves.toBeUndefined();
    expect(prismaMock.ticketActivity.findMany.mock.calls[0][0].where.ticketId).toEqual({ in: [1] });
  });
});
