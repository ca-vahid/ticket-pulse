import { jest } from '@jest/globals';

const prismaMock = {
  mailboxConnection: {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));

const { pickOutboundMailbox, pickIngestMailbox, setPrimaryMailbox, OUTBOUND_MAILBOX_ORDER } = await import('../src/services/mailboxPicker.js');

// Mega 08-31 Phase MB-1g: ONE centralized outbound picker replacing five
// ad-hoc `findFirst` call sites — primary first, then oldest id.
describe('mailboxPicker.pickOutboundMailbox', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (fn) => fn(prismaMock));
  });

  test('asks for enabled send-capable connections ordered isPrimary desc, id asc', async () => {
    prismaMock.mailboxConnection.findFirst.mockResolvedValue({ id: 7, address: 'patickets@bgcengineering.ca', isPrimary: true });

    const picked = await pickOutboundMailbox(5);

    expect(picked).toEqual(expect.objectContaining({ id: 7, address: 'patickets@bgcengineering.ca' }));
    expect(prismaMock.mailboxConnection.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: 5, isEnabled: true, mode: { in: ['send', 'both'] } },
      orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
    });
    expect(OUTBOUND_MAILBOX_ORDER).toEqual([{ isPrimary: 'desc' }, { id: 'asc' }]);
  });

  test('requireSend:false drops the mode filter but keeps the ordering', async () => {
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
    await pickOutboundMailbox('3', { requireSend: false });
    expect(prismaMock.mailboxConnection.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: 3, isEnabled: true },
      orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
    });
  });

  test('a missing / non-numeric workspace short-circuits to null without a query', async () => {
    expect(await pickOutboundMailbox(null)).toBeNull();
    expect(await pickOutboundMailbox(undefined)).toBeNull();
    expect(await pickOutboundMailbox('abc')).toBeNull();
    expect(prismaMock.mailboxConnection.findFirst).not.toHaveBeenCalled();
  });

  test('the primary wins even when it is not the oldest row (ordering is what the DB honours)', async () => {
    // Simulate the DB applying the orderBy: the picker must not re-sort or
    // second-guess — whatever findFirst returns under that order is the answer.
    const rows = [
      { id: 1, address: 'old@x.com', isPrimary: false },
      { id: 9, address: 'starred@x.com', isPrimary: true },
    ];
    prismaMock.mailboxConnection.findFirst.mockImplementation(async ({ orderBy }) => {
      const sorted = [...rows].sort((a, b) => (Number(b.isPrimary) - Number(a.isPrimary)) || (a.id - b.id));
      expect(orderBy[0]).toEqual({ isPrimary: 'desc' });
      return sorted[0];
    });
    expect((await pickOutboundMailbox(1)).address).toBe('starred@x.com');
  });
});

describe('mailboxPicker.pickIngestMailbox', () => {
  beforeEach(() => jest.clearAllMocks());

  test('asks for enabled ingest-capable connections with the same primary-first ordering', async () => {
    prismaMock.mailboxConnection.findFirst.mockResolvedValue({ id: 4, address: 'patickets@bgcengineering.ca', mode: 'ingest' });
    expect((await pickIngestMailbox(5)).address).toBe('patickets@bgcengineering.ca');
    expect(prismaMock.mailboxConnection.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: 5, isEnabled: true, mode: { in: ['ingest', 'both'] } },
      orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
    });
    expect(await pickIngestMailbox(null)).toBeNull();
  });
});

describe('mailboxPicker.setPrimaryMailbox', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (fn) => fn(prismaMock));
    prismaMock.mailboxConnection.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.mailboxConnection.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
  });

  test('setting primary clears every other primary in the workspace inside one transaction', async () => {
    const row = await setPrimaryMailbox(5, 12, true);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.mailboxConnection.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 5, isPrimary: true, NOT: { id: 12 } },
      data: { isPrimary: false },
    });
    expect(prismaMock.mailboxConnection.update).toHaveBeenCalledWith({ where: { id: 12 }, data: { isPrimary: true } });
    expect(row).toEqual({ id: 12, isPrimary: true });
  });

  test('clearing primary only touches that row', async () => {
    await setPrimaryMailbox(5, 12, false);
    expect(prismaMock.mailboxConnection.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.mailboxConnection.update).toHaveBeenCalledWith({ where: { id: 12 }, data: { isPrimary: false } });
  });
});
