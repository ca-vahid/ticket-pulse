import { jest } from '@jest/globals';

/**
 * Phantom requester guard (QA 09-09).
 *
 * A QA run of the Project Accounting Power App posted a ticket through
 * POST /api/v1/tickets with a GUESSED requester address —
 * susan.xu@bgcengineering.ca, when her login is sxu@. resolveRequester asked
 * Graph to enrich it, got a 404, swallowed the 404, and created the row
 * anyway. From then on a fabricated "Susan Xu" shadowed the real one in every
 * requester picker, and the weekly enrichment job kept re-404ing it forever.
 *
 * The three cases these pin, in order of how much damage getting them wrong
 * would do:
 *   1. ABSENT internal address  -> refuse. (the bug)
 *   2. ALIAS on a live mailbox  -> allow. Two real BGC addresses (skumar@,
 *      aschevers@) are aliases on other mailboxes; a UPN-only check would
 *      have rejected two real employees' tickets.
 *   3. Graph UNAVAILABLE        -> allow. Failing closed on an outage would
 *      stop every integration from filing tickets.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  requester: { findMany: jest.fn() },
};
const repoMock = { findByEmail: jest.fn(), createNative: jest.fn() };
const adMock = { resolveAddress: jest.fn(), getUserProfile: jest.fn(), searchUsers: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: repoMock }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: adMock }));

const { default: ticketService } = await import('../src/services/ticketService.js');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: ['bgcengineering.ca', 'cambioearth.com'] });
  repoMock.findByEmail.mockResolvedValue(null);
  repoMock.createNative.mockImplementation(async (d) => ({ id: 999, ...d }));
  adMock.searchUsers.mockResolvedValue([]);
});

describe('resolveRequester — internal addresses must exist', () => {
  test('the reported case is refused, not created', async () => {
    adMock.resolveAddress.mockResolvedValue({ status: 'absent' });
    await expect(ticketService.resolveRequester(5, {
      requesterEmail: 'susan.xu@bgcengineering.ca',
      requesterName: 'Susan Xu',
    })).rejects.toThrow(/is not a mailbox in this organisation/);
    expect(repoMock.createNative).not.toHaveBeenCalled();
  });

  test('the refusal names the person they probably meant', async () => {
    adMock.resolveAddress.mockResolvedValue({ status: 'absent' });
    adMock.searchUsers.mockResolvedValue([{ mail: 'SXu@bgcengineering.ca', displayName: 'Susan Xu' }]);
    await expect(ticketService.resolveRequester(5, { requesterEmail: 'susan.xu@bgcengineering.ca' }))
      .rejects.toThrow(/Did you mean SXu@bgcengineering.ca \(Susan Xu\)\?/);
  });

  test('a failing suggestion lookup still produces the refusal', async () => {
    adMock.resolveAddress.mockResolvedValue({ status: 'absent' });
    adMock.searchUsers.mockRejectedValue(new Error('graph blew up'));
    await expect(ticketService.resolveRequester(5, { requesterEmail: 'nobody@bgcengineering.ca' }))
      .rejects.toThrow(/is not a mailbox/);
  });

  test('an ALIAS on a live mailbox is allowed — this is skumar@ and aschevers@', async () => {
    adMock.resolveAddress.mockResolvedValue({
      status: 'alias', owner: 'KSriskandakumar@bgcengineering.ca',
      displayName: 'Kumar Sriskandakumar', jobTitle: 'Principal Geotechnical Engineer', department: 'Vancouver',
    });
    const out = await ticketService.resolveRequester(1, { requesterEmail: 'skumar@bgcengineering.ca' });
    expect(out.id).toBe(999);
    expect(repoMock.createNative).toHaveBeenCalledWith(expect.objectContaining({
      email: 'skumar@bgcengineering.ca',
      jobTitle: 'Principal Geotechnical Engineer',
    }));
  });

  test('Graph being unavailable does NOT block ticket creation', async () => {
    adMock.resolveAddress.mockResolvedValue({ status: 'unavailable' });
    const out = await ticketService.resolveRequester(1, { requesterEmail: 'newstarter@bgcengineering.ca', requesterName: 'New Starter' });
    expect(out.id).toBe(999);
    // Created unverified, and with no fabricated enrichment.
    expect(repoMock.createNative).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New Starter', entraProfile: null,
    }));
  });

  test('a found internal address is created with its real title', async () => {
    adMock.resolveAddress.mockResolvedValue({
      status: 'found', owner: 'SXu@bgcengineering.ca', displayName: 'Susan Xu',
      jobTitle: 'IT Coordinator', department: 'Vancouver',
    });
    await ticketService.resolveRequester(1, { requesterEmail: 'sxu@bgcengineering.ca' });
    expect(repoMock.createNative).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Susan Xu', jobTitle: 'IT Coordinator', department: 'Vancouver',
    }));
  });

  test('EXTERNAL addresses are untouched — an unknown external requester is normal', async () => {
    adMock.getUserProfile.mockResolvedValue(null);
    const out = await ticketService.resolveRequester(1, {
      requesterEmail: 'susan.iocono@libertymutual.com', requesterName: 'Susan Iocono',
    });
    expect(out.id).toBe(999);
    // The internal resolver is never consulted for an outside domain.
    expect(adMock.resolveAddress).not.toHaveBeenCalled();
    // …and the miss is recorded as a miss rather than left ambiguous.
    expect(repoMock.createNative).toHaveBeenCalledWith(expect.objectContaining({ entraMissing: true }));
  });

  test('an existing requester is returned without any directory call', async () => {
    repoMock.findByEmail.mockResolvedValue({ id: 2511, email: 'sxu@bgcengineering.ca' });
    const out = await ticketService.resolveRequester(1, { requesterEmail: 'SXu@bgcengineering.ca' });
    expect(out.id).toBe(2511);
    expect(adMock.resolveAddress).not.toHaveBeenCalled();
  });

  test('a workspace with no internal domains configured checks nothing', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: [] });
    adMock.getUserProfile.mockResolvedValue(null);
    await ticketService.resolveRequester(1, { requesterEmail: 'anyone@bgcengineering.ca' });
    expect(adMock.resolveAddress).not.toHaveBeenCalled();
    expect(repoMock.createNative).toHaveBeenCalled();
  });
});

describe('searchRequesters — suppressed rows leave the pickers', () => {
  test('the query excludes suppressed requesters', async () => {
    prismaMock.requester.findMany.mockResolvedValue([]);
    await ticketService.searchRequesters('susan');
    const where = prismaMock.requester.findMany.mock.calls[0][0].where;
    expect(where.isActive).toBe(true);
    // Suppression is separate from isActive on purpose: the FreshService
    // requester sync writes isActive from FreshService on every cycle, so a
    // deactivation would be undone on the next sync.
    expect(where.suppressedAt).toBeNull();
  });
});
