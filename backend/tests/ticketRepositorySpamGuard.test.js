import { jest } from '@jest/globals';

/**
 * MEGA 09-01 Phase TU-3d/e — ticketRepository.upsert:
 *  - never downgrades a Spam/Deleted row from a LIST snapshot (no explicit
 *    spam:false / deleted:false) — the 956-identical-Open→Spam-rows flap;
 *  - no explicit updatedAt stamp, and a no-op re-sync writes nothing at all.
 */

const prismaMock = {
  ticket: {
    updateMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: ticketRepository, changedUpsertKeys } = await import('../src/services/ticketRepository.js');

const SPAM_ROW = {
  id: 11,
  origin: 'freshservice',
  freshserviceTicketId: BigInt(240001),
  subject: 'Win a prize',
  status: 'Spam',
  priority: 3,
  workspaceId: 2,
};

describe('ticketRepository.upsert Spam/Deleted protection (TU-3d)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 });
  });

  test('a list-snapshot payload (no spam flag) leaves a Spam row untouched', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(SPAM_ROW);

    const result = await ticketRepository.upsert({ freshserviceTicketId: 240001, subject: 'Win a prize', status: 'Open', workspaceId: 2 });

    expect(result).toBe(SPAM_ROW);
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('a Deleted row is protected the same way', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ ...SPAM_ROW, status: 'Deleted' });
    await ticketRepository.upsert({ freshserviceTicketId: 240001, subject: 'Win a prize', status: 'Open', workspaceId: 2 });
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
  });

  test('an explicit spam:false (detail payload) may downgrade the row again', async () => {
    prismaMock.ticket.findUnique
      .mockResolvedValueOnce(SPAM_ROW)
      .mockResolvedValueOnce({ ...SPAM_ROW, status: 'Open' });

    const result = await ticketRepository.upsert({ freshserviceTicketId: 240001, subject: 'Win a prize', status: 'Open', workspaceId: 2, spam: false });

    expect(prismaMock.ticket.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { freshserviceTicketId: BigInt(240001), origin: 'freshservice', status: { notIn: ['Deleted'] } },
      data: expect.objectContaining({ status: 'Open' }),
    }));
    expect(result.status).toBe('Open');
  });

  test('a payload that says spam:true still flips an Open row to Spam', async () => {
    prismaMock.ticket.findUnique
      .mockResolvedValueOnce({ ...SPAM_ROW, status: 'Open' })
      .mockResolvedValueOnce(SPAM_ROW);

    const result = await ticketRepository.upsert({ freshserviceTicketId: 240001, subject: 'Win a prize', status: 'Spam', workspaceId: 2, spam: true });

    expect(prismaMock.ticket.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Spam' }),
    }));
    expect(result.status).toBe('Spam');
  });
});

describe('ticketRepository.upsert no-op detection (TU-3e)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 });
  });

  const stored = {
    id: 12,
    origin: 'freshservice',
    freshserviceTicketId: BigInt(240002),
    subject: 'Printer jammed',
    description: null,
    descriptionText: null,
    status: 'Open',
    priority: 2,
    assignedTechId: 7,
    isSelfPicked: false,
    assignedBy: null,
    requesterFreshserviceId: BigInt(9001),
    assignedAt: new Date('2026-09-01T10:00:00Z'),
    resolvedAt: null,
    closedAt: null,
    dueBy: null,
    frDueBy: null,
    source: 1,
    category: null,
    subCategory: null,
    ticketCategory: null,
    tpSkill: null,
    tpSubskill: null,
    department: null,
    isEscalated: false,
    timeSpentMinutes: null,
    billableMinutes: null,
    nonBillableMinutes: null,
    resolutionTimeSeconds: null,
    firstAssignedAt: null,
    freshserviceUpdatedAt: new Date('2026-09-01T10:00:00Z'),
    toEmails: ['help@example.com'],
    ccEmails: [],
    replyCcEmails: [],
    fwdEmails: [],
    workspaceId: 1,
    updatedAt: new Date('2026-09-01T10:00:01Z'),
  };
  const sameSnapshot = {
    freshserviceTicketId: 240002,
    subject: 'Printer jammed',
    status: 'Open',
    priority: 2,
    assignedTechId: 7,
    requesterId: 9001,
    assignedAt: new Date('2026-09-01T10:00:00Z'),
    source: 1,
    isEscalated: false,
    freshserviceUpdatedAt: new Date('2026-09-01T10:00:00Z'),
    toEmails: ['help@example.com'],
    ccEmails: [],
    replyCcEmails: [],
    fwdEmails: [],
    workspaceId: 1,
  };

  test('an identical re-sync performs NO write (so updated_at cannot move)', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(stored);

    const result = await ticketRepository.upsert(sameSnapshot);

    expect(result).toBe(stored);
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.ticket.create).not.toHaveBeenCalled();
  });

  test('a real change writes — without an explicit updatedAt in the payload', async () => {
    prismaMock.ticket.findUnique
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce({ ...stored, status: 'Pending' });

    await ticketRepository.upsert({ ...sameSnapshot, status: 'Pending' });

    expect(prismaMock.ticket.updateMany).toHaveBeenCalledTimes(1);
    const { data } = prismaMock.ticket.updateMany.mock.calls[0][0];
    expect(data.status).toBe('Pending');
    expect(data).not.toHaveProperty('updatedAt');
  });

  test('webhook ingest counters (atomic increments) always count as a change', async () => {
    prismaMock.ticket.findUnique.mockResolvedValueOnce(stored).mockResolvedValueOnce(stored);
    await ticketRepository.upsert({ ...sameSnapshot, incrementWebhookIngestCount: true });
    expect(prismaMock.ticket.updateMany).toHaveBeenCalledTimes(1);
  });

  test('changedUpsertKeys compares Dates by time, BigInts by value, arrays structurally', () => {
    expect(changedUpsertKeys(
      { assignedAt: new Date('2026-09-01T10:00:00Z'), requesterFreshserviceId: BigInt(9001), toEmails: ['a@x'], status: 'Open', subject: undefined },
      { assignedAt: new Date('2026-09-01T10:00:00.000Z'), requesterFreshserviceId: BigInt(9001), toEmails: ['a@x'], status: 'Open', subject: 'x' },
    )).toEqual([]);
    expect(changedUpsertKeys({ status: 'Closed', ccEmails: ['b@x'] }, { status: 'Open', ccEmails: [] })).toEqual(['status', 'ccEmails']);
    expect(changedUpsertKeys({ dueBy: null }, { dueBy: new Date() })).toEqual(['dueBy']);
  });
});
