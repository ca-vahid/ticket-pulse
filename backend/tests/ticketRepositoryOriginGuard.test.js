import { jest } from '@jest/globals';

// Dual-origin guardrails: FS-keyed repository writes must never touch TP-born
// tickets (origin='ticketpulse'), even after the fallback mirror assigns them a
// freshserviceTicketId.

const prismaMock = {
  ticket: {
    updateMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn(),
    findMany: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: ticketRepository } = await import('../src/services/ticketRepository.js');

describe('ticketRepository dual-origin guardrails', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('upsert', () => {
    const payload = {
      freshserviceTicketId: 12345,
      subject: 'From FreshService',
      status: 'Open',
      workspaceId: 1,
    };

    test('updates FS-born rows through the origin-filtered updateMany', async () => {
      prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.ticket.findUnique.mockResolvedValue({ id: 1, origin: 'freshservice' });

      const result = await ticketRepository.upsert(payload);

      expect(prismaMock.ticket.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { freshserviceTicketId: BigInt(12345), origin: 'freshservice' },
      }));
      expect(prismaMock.ticket.create).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ id: 1 }));
    });

    test('returns a TP-born row untouched instead of overwriting it', async () => {
      prismaMock.ticket.updateMany.mockResolvedValue({ count: 0 });
      const tpTicket = { id: 2, origin: 'ticketpulse', subject: 'Born in Ticket Pulse' };
      prismaMock.ticket.findUnique.mockResolvedValue(tpTicket);

      const result = await ticketRepository.upsert(payload);

      expect(result).toBe(tpTicket);
      expect(prismaMock.ticket.create).not.toHaveBeenCalled();
      // Only the origin-guarded updateMany may run — never an unfiltered update.
      expect(prismaMock.ticket.update).not.toHaveBeenCalled();
    });

    test('creates the row when no ticket exists for the FS id', async () => {
      prismaMock.ticket.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.ticket.findUnique.mockResolvedValue(null);
      prismaMock.ticket.create.mockResolvedValue({ id: 3, origin: 'freshservice' });

      const result = await ticketRepository.upsert(payload);

      expect(prismaMock.ticket.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ freshserviceTicketId: BigInt(12345) }),
      }));
      expect(result).toEqual(expect.objectContaining({ id: 3 }));
    });

    test('recovers from a concurrent create by retrying the guarded update', async () => {
      prismaMock.ticket.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      prismaMock.ticket.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 4, origin: 'freshservice' });
      const conflict = new Error('unique constraint violation');
      conflict.code = 'P2002';
      prismaMock.ticket.create.mockRejectedValue(conflict);

      const result = await ticketRepository.upsert(payload);

      expect(prismaMock.ticket.updateMany).toHaveBeenCalledTimes(2);
      expect(result).toEqual(expect.objectContaining({ id: 4 }));
    });
  });

  describe('update', () => {
    test('skips FS-keyed field updates on TP-born rows', async () => {
      prismaMock.ticket.findUnique
        .mockResolvedValueOnce({ id: 7, origin: 'ticketpulse' })
        .mockResolvedValueOnce({ id: 7, origin: 'ticketpulse', status: 'Open' });

      const result = await ticketRepository.update(999, { status: 'Closed' });

      expect(prismaMock.ticket.update).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ id: 7, status: 'Open' }));
    });

    test('still updates FS-born rows', async () => {
      prismaMock.ticket.findUnique.mockResolvedValue({ id: 8, origin: 'freshservice' });
      prismaMock.ticket.update.mockResolvedValue({ id: 8, status: 'Closed' });

      const result = await ticketRepository.update(1000, { status: 'Closed' });

      expect(prismaMock.ticket.update).toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ status: 'Closed' }));
    });
  });

  describe('updateByFreshserviceId', () => {
    test('only targets FS-born rows (CSAT sweep etc.)', async () => {
      prismaMock.ticket.updateMany.mockResolvedValue({ count: 0 });

      await ticketRepository.updateByFreshserviceId(777, { csatCheckedAt: new Date() });

      expect(prismaMock.ticket.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          freshserviceTicketId: BigInt(777),
          origin: 'freshservice',
        }),
      }));
    });
  });

  describe('cleanOldTickets', () => {
    test('never bulk-deletes TP-born tickets', async () => {
      prismaMock.ticket.deleteMany.mockResolvedValue({ count: 5 });

      await ticketRepository.cleanOldTickets(90, 1);

      expect(prismaMock.ticket.deleteMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ origin: 'freshservice' }),
      });
    });
  });
});
