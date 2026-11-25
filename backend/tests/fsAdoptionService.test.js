import { jest } from '@jest/globals';

// FreshService exit A3 (25 Nov 2026): adoption of FS-born tickets.

const fsMode = { mode: 'connected' };
const fsGate = jest.fn(async () => fsMode.mode !== 'off');
jest.unstable_mockModule('../src/services/fsModeService.js', () => ({
  default: {},
  fsGate,
  isFreshServiceOff: jest.fn(async () => fsMode.mode === 'off'),
  onModeChange: jest.fn(() => () => {}),
  getMode: jest.fn(async () => fsMode.mode),
  getModeRecord: jest.fn(async () => ({ mode: fsMode.mode })),
  setMode: jest.fn(),
  getShadowReport: jest.fn(async () => ({ since: null, counts: {}, total: 0 })),
  flushShadow: jest.fn(),
  FS_MODES: ['connected', 'shadow', 'off'],
  FS_PURPOSES: [],
  modeSettingKey: (ws) => `freshservice_mode_ws${ws}`,
  shadowSettingKey: (ws) => `freshservice_shadow_ws${ws}`,
  _resetFsModeCache: jest.fn(),
}));

const prismaMock = {
  ticket: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), updateMany: jest.fn() },
  ticketActivity: { create: jest.fn() },
  ticketAttachment: { count: jest.fn() },
  $queryRaw: jest.fn(),
};
prismaMock.$transaction = jest.fn(async (fn) => fn(prismaMock));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const ticketServiceMock = { _nextNativeNumber: jest.fn(async () => 2001), _broadcast: jest.fn() };
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
const attachmentServiceMock = { storeFsAttachmentsForTicket: jest.fn(async () => ({ stored: 2 })) };
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: attachmentServiceMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: {
    listStatuses: jest.fn(async () => [
      { name: 'Open', baseStatus: 'Open' },
      { name: 'Fixed', baseStatus: 'Resolved' },
      { name: 'Archived', baseStatus: 'Closed' },
    ]),
  },
}));

const { default: fsAdoptionService, adoptionReasonFor, isAdoptedTicket } = await import('../src/services/fsAdoptionService.js');
const { NotFoundError, ValidationError } = await import('../src/utils/errors.js');

const fsBorn = (over = {}) => ({
  id: 77, workspaceId: 1, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 245001n,
  mirrorState: null, subject: 'Printer jam', status: 'Open', ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  fsMode.mode = 'connected';
  prismaMock.$transaction.mockImplementation(async (fn) => fn(prismaMock));
});

describe('adoptTicket', () => {
  test('flips origin, assigns a TP number, marks adopted and KEEPS the FS id as a tombstone', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn());
    prismaMock.ticket.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(fsBorn({ origin: 'ticketpulse', nativeNumber: 2001, mirrorState: 'adopted' }));

    const out = await fsAdoptionService.adoptTicket(77, 1, { actorEmail: 'ada@example.com', reason: 'agent' });

    const { where, data } = prismaMock.ticket.updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: 77, workspaceId: 1, origin: 'freshservice' });
    expect(data).toEqual(expect.objectContaining({ origin: 'ticketpulse', nativeNumber: 2001, mirrorState: 'adopted' }));
    // Never null (or touch) the FreshService id: sync finds rows by it, Simorgh stores it.
    expect(data).not.toHaveProperty('freshserviceTicketId');
    expect(out.freshserviceTicketId).toBe(245001n);
    expect(out.displayRef).toBe('TP-2001');
    expect(out.adopted).toBe(true);
    expect(out.alreadyAdopted).toBe(false);
    expect(isAdoptedTicket(out)).toBe(true);
  });

  test('writes an adopted_from_freshservice history row with the old FS number, reason and who', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn());
    prismaMock.ticket.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(fsBorn({ origin: 'ticketpulse', nativeNumber: 2001, mirrorState: 'adopted' }));

    await fsAdoptionService.adoptTicket(77, 1, { actorEmail: 'ada@example.com', reason: 'switch_off' });

    expect(prismaMock.ticketActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ticketId: 77,
        activityType: 'adopted_from_freshservice',
        details: expect.objectContaining({ fsTicketId: 245001, reason: 'switch_off', adoptedBy: 'ada@example.com' }),
      }),
    });
  });

  test('stores the FreshService files while FreshService answers; never in an Off workspace', async () => {
    for (const [mode, expected] of [['connected', 1], ['off', 0]]) {
      jest.clearAllMocks();
      fsMode.mode = mode;
      prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn());
      prismaMock.ticket.updateMany.mockResolvedValueOnce({ count: 1 });
      prismaMock.ticket.findUnique.mockResolvedValueOnce(fsBorn({ origin: 'ticketpulse', nativeNumber: 2001, mirrorState: 'adopted' }));
      await fsAdoptionService.adoptTicket(77, 1, { reason: 'requester_reply' });
      expect(attachmentServiceMock.storeFsAttachmentsForTicket).toHaveBeenCalledTimes(expected);
    }
  });

  test('a failed file store never undoes the adoption', async () => {
    attachmentServiceMock.storeFsAttachmentsForTicket.mockRejectedValueOnce(new Error('FS 429'));
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn());
    prismaMock.ticket.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(fsBorn({ origin: 'ticketpulse', nativeNumber: 2001, mirrorState: 'adopted' }));
    const out = await fsAdoptionService.adoptTicket(77, 1, {});
    expect(out.adopted).toBe(true);
  });

  test('idempotent: an adopted ticket comes back as it is, nothing written', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn({ origin: 'ticketpulse', nativeNumber: 2001, mirrorState: 'adopted' }));
    const out = await fsAdoptionService.adoptTicket(77, 1, { reason: 'agent' });
    expect(out.alreadyAdopted).toBe(true);
    expect(out.displayRef).toBe('TP-2001');
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.ticketActivity.create).not.toHaveBeenCalled();
    expect(ticketServiceMock._nextNativeNumber).not.toHaveBeenCalled();
  });

  test('a concurrent adoption wins once: the loser returns the adopted row', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(fsBorn())
      .mockResolvedValueOnce(fsBorn({ origin: 'ticketpulse', nativeNumber: 2002, mirrorState: 'adopted' }));
    prismaMock.ticket.updateMany.mockResolvedValueOnce({ count: 0 });
    const out = await fsAdoptionService.adoptTicket(77, 1, {});
    expect(out.alreadyAdopted).toBe(true);
    expect(prismaMock.ticketActivity.create).not.toHaveBeenCalled();
  });

  test('only FS-born tickets of this workspace', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(null);
    await expect(fsAdoptionService.adoptTicket(77, 1, {})).rejects.toBeInstanceOf(NotFoundError);
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn({ origin: 'ticketpulse', nativeNumber: 12, mirrorState: 'mirrored' }));
    await expect(fsAdoptionService.adoptTicket(77, 1, {})).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('previewWorkspace', () => {
  test('counts open FS-born tickets (custom terminal statuses excluded), FS files and a sample ≤ 20', async () => {
    prismaMock.ticket.count.mockResolvedValueOnce(3);
    prismaMock.ticket.findMany.mockResolvedValueOnce([
      fsBorn({ id: 3, freshserviceTicketId: 245003n }),
      fsBorn({ id: 2, freshserviceTicketId: 245002n, status: 'Pending' }),
    ]);
    prismaMock.ticketAttachment.count.mockResolvedValueOnce(9);

    const out = await fsAdoptionService.previewWorkspace(1);

    expect(out).toEqual({
      openFsBorn: 3,
      uncachedAttachments: 9,
      uncachedAttachmentsBasis: 'metadata_rows',
      sample: [
        { id: 3, ref: '#245003', subject: 'Printer jam', status: 'Open' },
        { id: 2, ref: '#245002', subject: 'Printer jam', status: 'Pending' },
      ],
    });
    const where = prismaMock.ticket.count.mock.calls[0][0].where;
    expect(where.origin).toBe('freshservice');
    expect(where.status.notIn).toEqual(expect.arrayContaining(['Closed', 'Resolved', 'Deleted', 'Spam', 'Fixed', 'Archived']));
    expect(where.status.notIn).not.toContain('Open');
    expect(prismaMock.ticket.findMany.mock.calls[0][0].take).toBe(20);
    expect(prismaMock.ticketAttachment.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ workspaceId: 1, source: 'freshservice' }),
    });
  });

  test('uses the attachment service exact count when it offers one', async () => {
    attachmentServiceMock.countUnstoredFsAttachments = jest.fn(async () => 4);
    prismaMock.ticket.count.mockResolvedValueOnce(0);
    prismaMock.ticket.findMany.mockResolvedValueOnce([]);
    const out = await fsAdoptionService.previewWorkspace(1);
    expect(out.uncachedAttachments).toBe(4);
    expect(out.uncachedAttachmentsBasis).toBe('stored_check');
    expect(prismaMock.ticketAttachment.count).not.toHaveBeenCalled();
    delete attachmentServiceMock.countUnstoredFsAttachments;
  });
});

describe('adoptWorkspace', () => {
  test('adopts every open FS-born ticket with reason switch_off, collects failures, reports progress', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const adoptSpy = jest.spyOn(fsAdoptionService, 'adoptTicket')
      .mockResolvedValueOnce({ id: 1, alreadyAdopted: false })
      .mockRejectedValueOnce(new Error('database said no'))
      .mockResolvedValueOnce({ id: 3, alreadyAdopted: false });
    const progress = jest.fn();

    const out = await fsAdoptionService.adoptWorkspace(1, { actorEmail: 'ada@example.com', onProgress: progress });

    expect(out).toEqual({ adopted: 2, failed: [{ id: 2, error: 'database said no' }], total: 3 });
    expect(adoptSpy).toHaveBeenCalledWith(1, 1, { actorEmail: 'ada@example.com', reason: 'switch_off' });
    expect(progress).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenLastCalledWith({ done: 3, total: 3, adopted: 2, failed: 1, ticketId: 3 });
    adoptSpy.mockRestore();
  });

  test('re-running is safe: already adopted tickets are not counted again', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([{ id: 1 }]);
    const adoptSpy = jest.spyOn(fsAdoptionService, 'adoptTicket').mockResolvedValueOnce({ id: 1, alreadyAdopted: true });
    const out = await fsAdoptionService.adoptWorkspace(1, {});
    expect(out).toEqual({ adopted: 0, failed: [], total: 1 });
    adoptSpy.mockRestore();
  });
});

describe('adoptionReasonFor', () => {
  test('API keys, personal keys and integrations write as api_write; people as agent', () => {
    expect(adoptionReasonFor({ role: 'api', email: 'apikey:tpk_abc' })).toBe('api_write');
    expect(adoptionReasonFor({ email: 'ada@example.com', via: { kind: 'personal_key', keyId: 3 } })).toBe('api_write');
    expect(adoptionReasonFor({ role: 'integration', name: 'Some integration' })).toBe('api_write');
    expect(adoptionReasonFor({ role: 'agent', email: 'ada@example.com' })).toBe('agent');
    expect(adoptionReasonFor(null)).toBe('agent');
  });
});
