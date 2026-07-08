import { jest } from '@jest/globals';

/** Ticket ref resolution (QA 07-07 #6): TP-####, #FS, bare numbers. */

const prismaMock = {
  ticket: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));

const { resolveTicketRef, resolveTicketRefOrThrow } = await import('../src/services/ticketRefResolver.js');

const ROW = { id: 45489, subject: 'VPN', status: 'Open', origin: 'ticketpulse', nativeNumber: 1042, freshserviceTicketId: null };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveTicketRef', () => {
  test('TP-1042 (any casing, with or without dash) resolves by native number', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(ROW);
    for (const ref of ['TP-1042', 'tp-1042', 'tp1042', '  TP-1042  ']) {
      prismaMock.ticket.findFirst.mockClear();
      const hit = await resolveTicketRef(ref, 1);
      expect(hit).toBe(ROW);
      expect(prismaMock.ticket.findFirst.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ workspaceId: 1, nativeNumber: 1042 }),
      );
    }
  });

  test('#231164 resolves ONLY by FreshService number', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(null);
    const hit = await resolveTicketRef('#231164', 1);
    expect(hit).toBeNull();
    expect(prismaMock.ticket.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticket.findFirst.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ freshserviceTicketId: BigInt(231164) }),
    );
  });

  test('a bare number tries FS number, then native, then internal id', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(null) // fs
      .mockResolvedValueOnce(null) // native
      .mockResolvedValueOnce(ROW); // id
    const hit = await resolveTicketRef('45489', 1);
    expect(hit).toBe(ROW);
    const wheres = prismaMock.ticket.findFirst.mock.calls.map((c) => c[0].where);
    expect(wheres[0]).toEqual(expect.objectContaining({ freshserviceTicketId: BigInt(45489) }));
    expect(wheres[1]).toEqual(expect.objectContaining({ nativeNumber: 45489 }));
    expect(wheres[2]).toEqual(expect.objectContaining({ id: 45489 }));
  });

  test('the first match short-circuits (FS number wins over an id collision)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ ...ROW, id: 7 });
    await resolveTicketRef('231164', 1);
    expect(prismaMock.ticket.findFirst).toHaveBeenCalledTimes(1);
  });

  test('garbage refs resolve to null without queries', async () => {
    expect(await resolveTicketRef('not-a-ticket', 1)).toBeNull();
    expect(await resolveTicketRef('-5', 1)).toBeNull();
    expect(prismaMock.ticket.findFirst).not.toHaveBeenCalled();
  });

  test('resolveTicketRefOrThrow names the failing ref and adds displayRef on success', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(null);
    await expect(resolveTicketRefOrThrow('TP-9999', 1)).rejects.toThrow(/TP-9999/);

    prismaMock.ticket.findFirst.mockResolvedValue(ROW);
    const hit = await resolveTicketRefOrThrow('TP-1042', 1);
    expect(hit.displayRef).toBe('TP-1042');
  });
});
