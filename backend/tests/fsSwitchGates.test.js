import { jest } from '@jest/globals';

/**
 * FreshService switch (FreshService exit A1, 25 Nov 2026): the smaller gates.
 * Config, route gate, webhook, attachments, thread pull, groups, CSAT and the
 * history backfill each stop for a workspace switched OFF, and run as today
 * (counted) in Shadow.
 */

const modes = new Map();
const gateCalls = [];
const modeOf = (ws) => modes.get(Number(ws)) || 'connected';
jest.unstable_mockModule('../src/services/fsModeService.js', () => ({
  getModeRecord: jest.fn(async (ws) => ({ mode: modeOf(ws) })),
  isFreshServiceOff: jest.fn(async (ws) => modeOf(ws) === 'off'),
  fsGate: jest.fn(async (ws, purpose) => { gateCalls.push([Number(ws), purpose]); return modeOf(ws) !== 'off'; }),
  onModeChange: jest.fn(() => () => {}),
}));

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  appSettings: { findUnique: jest.fn(), upsert: jest.fn() },
  ticket: { findUnique: jest.fn(), update: jest.fn() },
  ticketAttachment: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  group: { aggregate: jest.fn(), upsert: jest.fn(), updateMany: jest.fn() },
  $queryRawUnsafe: jest.fn(),
};
const fsClient = { getTicket: jest.fn(), fetchTicketConversations: jest.fn(), fetchTicketSnapshot: jest.fn(), listGroups: jest.fn() };
const mirrorMock = { getClient: jest.fn(async () => fsClient), getInteractiveClient: jest.fn(async () => fsClient) };
const webhookMock = {
  getStoredConfig: jest.fn(), recordReceived: jest.fn(), recordRejected: jest.fn(), recordAccepted: jest.fn(),
  recordError: jest.fn(), verifySecret: jest.fn(), headerName: 'x-tp-secret',
};
const workspaceRepoMock = { getBySlug: jest.fn() };
const syncServiceMock = { syncFreshServiceTicketSnapshot: jest.fn(), _pollForUnassignedTickets: jest.fn(), backfillDateRange: jest.fn(), runningWorkspaces: new Map() };
const blob = { download: jest.fn(), exists: jest.fn(), uploadData: jest.fn(), downloadToBuffer: jest.fn() };
const listBlobsFlat = jest.fn();
const axiosGet = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorMock }));
jest.unstable_mockModule('../src/services/workspaceWebhookService.js', () => ({ default: webhookMock }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: workspaceRepoMock }));
jest.unstable_mockModule('../src/services/syncService.js', () => ({ default: syncServiceMock }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { bulkUpsert: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn(() => fsClient) }));
jest.unstable_mockModule('@azure/storage-blob', () => ({
  BlobServiceClient: { fromConnectionString: () => ({ getContainerClient: () => ({ getBlockBlobClient: () => blob, listBlobsFlat }) }) },
}));
jest.unstable_mockModule('axios', () => ({ default: { get: axiosGet } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: settingsRepository } = await import('../src/services/settingsRepository.js');
const { requireFreshServiceLink, requireFreshServiceOn } = await import('../src/middleware/requireFreshServiceLink.js');
const { default: webhookIngest } = await import('../src/services/freshServiceWebhookIngestService.js');
const { default: attachmentService, storeFsAttachmentsForTicket, countUnstoredFsAttachments, FS_OFF_FILE_MESSAGE } = await import('../src/services/attachmentService.js');
const { default: fsThreadPullService } = await import('../src/services/fsThreadPullService.js');
const { default: groupSyncService } = await import('../src/services/groupSyncService.js');
const { default: csatService } = await import('../src/services/csatService.js');
const { default: historyBackfillService } = await import('../src/services/historyBackfillService.js');

const OFF = 5;
const LIVE = 1;
const SHADOW = 4;

beforeEach(() => {
  jest.clearAllMocks();
  modes.clear();
  modes.set(OFF, 'off');
  modes.set(SHADOW, 'shadow');
  gateCalls.length = 0;
  process.env.AZURE_STORAGE_CONNECTION_STRING = 'UseDevelopmentStorage=true';
  attachmentService._containerClient = null;
  prismaMock.workspace.findUnique.mockImplementation(async ({ where }) => ({ id: where.id, freshserviceWorkspaceId: 1000208182n, defaultTimezone: 'America/Vancouver' }));
  prismaMock.appSettings.findUnique.mockImplementation(async ({ where }) => ({ key: where.key, value: where.key === 'freshservice_domain' ? 'example' : 'key' }));
  prismaMock.appSettings.upsert.mockResolvedValue({});
});

function res() {
  const r = { statusCode: 200, body: null };
  r.status = jest.fn((c) => { r.statusCode = c; return r; });
  r.json = jest.fn((b) => { r.body = b; return r; });
  return r;
}

describe('config and route gates', () => {
  test('getFreshServiceConfigForWorkspace: off reads as not linked (freshserviceOff true); connected and Shadow as linked', async () => {
    await expect(settingsRepository.getFreshServiceConfigForWorkspace(OFF)).resolves.toMatchObject({ freshserviceLinked: false, freshserviceOff: true, workspaceId: '1000208182' });
    await expect(settingsRepository.getFreshServiceConfigForWorkspace(LIVE)).resolves.toMatchObject({ freshserviceLinked: true, freshserviceOff: false });
    await expect(settingsRepository.getFreshServiceConfigForWorkspace(SHADOW)).resolves.toMatchObject({ freshserviceLinked: true });
  });

  test('requireFreshServiceLink: off is 409 freshservice_off; never connected keeps freshservice_not_linked', async () => {
    const r1 = res(); const next1 = jest.fn();
    await requireFreshServiceLink({ workspaceId: OFF }, r1, next1);
    expect(r1.statusCode).toBe(409);
    expect(r1.body).toEqual({ success: false, code: 'freshservice_off', message: 'FreshService is switched off for this workspace.' });
    expect(next1).not.toHaveBeenCalled();

    prismaMock.workspace.findUnique.mockResolvedValueOnce({ freshserviceWorkspaceId: 0n });
    const r2 = res(); const next2 = jest.fn();
    await requireFreshServiceLink({ workspaceId: 10 }, r2, next2);
    expect(r2.body.code).toBe('freshservice_not_linked');

    const r3 = res(); const next3 = jest.fn();
    await requireFreshServiceLink({ workspaceId: SHADOW }, r3, next3);
    expect(next3).toHaveBeenCalledWith();
  });

  test('requireFreshServiceOn (ticket-type check): off 409, Shadow counted and passed', async () => {
    const gate = requireFreshServiceOn('ticket_types');
    const r1 = res();
    await gate({ workspaceId: OFF }, r1, jest.fn());
    expect(r1.body.code).toBe('freshservice_off');
    const next = jest.fn();
    await gate({ workspaceId: SHADOW }, res(), next);
    expect(next).toHaveBeenCalledWith();
    expect(gateCalls).toContainEqual([SHADOW, 'ticket_types']);
  });
});

describe('webhook', () => {
  const ws = (id) => ({ id, slug: `ws${id}`, isActive: true, freshserviceWorkspaceId: 1000208182n });
  beforeEach(() => {
    webhookMock.getStoredConfig.mockResolvedValue({ enabled: true });
    webhookMock.verifySecret.mockResolvedValue(true);
  });

  test('off: acknowledged (queued false), recorded as rejected freshservice_off, nothing fetched', async () => {
    workspaceRepoMock.getBySlug.mockResolvedValue(ws(OFF));
    const out = await webhookIngest.handleTicketWebhook({ workspaceSlug: 'ws5', freshserviceTicketId: '4242', suppliedSecret: 's' });
    expect(out).toMatchObject({ accepted: true, queued: false, dropped: 'freshservice_off' });
    await expect(out.pending).resolves.toMatchObject({ synced: false, rejected: 'freshservice_off' });
    expect(webhookMock.recordRejected).toHaveBeenCalledWith(OFF, 'freshservice_off');
    expect(fsClient.fetchTicketSnapshot).not.toHaveBeenCalled();
    expect(syncServiceMock.syncFreshServiceTicketSnapshot).not.toHaveBeenCalled();
  });

  test('a bad secret is still refused before the switch is consulted', async () => {
    workspaceRepoMock.getBySlug.mockResolvedValue(ws(OFF));
    webhookMock.verifySecret.mockResolvedValue(false);
    await expect(webhookIngest.handleTicketWebhook({ workspaceSlug: 'ws5', freshserviceTicketId: '4242', suppliedSecret: 'x' })).rejects.toMatchObject({ code: 'invalid_secret' });
  });

  test('Shadow: ingested as today and counted "webhook"', async () => {
    workspaceRepoMock.getBySlug.mockResolvedValue(ws(SHADOW));
    fsClient.fetchTicketSnapshot.mockResolvedValue({ id: 4242, workspace_id: 1000208182 });
    syncServiceMock.syncFreshServiceTicketSnapshot.mockResolvedValue({ ticket: { id: 1, assignedTechId: 3 } });
    syncServiceMock._pollForUnassignedTickets.mockResolvedValue({ triggered: 0 });
    const out = await webhookIngest.handleTicketWebhook({ workspaceSlug: 'ws4', freshserviceTicketId: '4242', suppliedSecret: 's' });
    expect(out.queued).toBe(true);
    await expect(out.pending).resolves.toMatchObject({ synced: true });
    expect(gateCalls).toContainEqual([SHADOW, 'webhook']);
  });
});

describe('attachments', () => {
  const fsRow = { id: 8, ticketId: 70, workspaceId: OFF, source: 'freshservice', blobName: 'fs/ws-5/att-555-scan.pdf', fileName: 'scan.pdf', contentType: 'application/pdf', sizeBytes: 10, threadEntryId: null };
  const notFound = Object.assign(new Error('BlobNotFound'), { statusCode: 404 });

  test('off + never stored: 409 with the plain message; FreshService is not asked', async () => {
    prismaMock.ticketAttachment.findFirst.mockResolvedValue(fsRow);
    prismaMock.ticket.findUnique.mockResolvedValue({ freshserviceTicketId: 99n, workspaceId: OFF });
    blob.download.mockRejectedValue(notFound);
    await expect(attachmentService.openDownload(8, 70, OFF)).rejects.toMatchObject({ statusCode: 409, message: FS_OFF_FILE_MESSAGE });
    expect(FS_OFF_FILE_MESSAGE).toBe('This file was never copied from FreshService, and FreshService is off for this workspace.');
    expect(mirrorMock.getInteractiveClient).not.toHaveBeenCalled();
    // bufferFor keeps its "null when unavailable" contract for its callers.
    blob.downloadToBuffer.mockRejectedValue(notFound);
    await expect(attachmentService.bufferFor(fsRow)).resolves.toBeNull();
    expect(fsClient.getTicket).not.toHaveBeenCalled();
  });

  test('off + stored: downloads as today', async () => {
    prismaMock.ticketAttachment.findFirst.mockResolvedValue(fsRow);
    blob.download.mockResolvedValue({ readableStreamBody: 'stream' });
    await expect(attachmentService.openDownload(8, 70, OFF)).resolves.toEqual({ attachment: fsRow, stream: 'stream' });
  });

  test('storeFsAttachmentsForTicket stores the FS-only files with one ticket read', async () => {
    prismaMock.ticketAttachment.findMany.mockResolvedValue([
      { ...fsRow, id: 1, workspaceId: LIVE, blobName: 'fs/ws-1/att-101-a.pdf', fileName: 'a.pdf' },
      { ...fsRow, id: 2, workspaceId: LIVE, blobName: 'fs/ws-1/att-102-b.png', fileName: 'b.png', threadEntryId: 40 },
      { ...fsRow, id: 3, workspaceId: LIVE, blobName: 'fs/ws-1/att-103-c.txt', fileName: 'c.txt' },
    ]);
    blob.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    prismaMock.ticket.findUnique.mockResolvedValue({ freshserviceTicketId: 99n, workspaceId: LIVE });
    fsClient.getTicket.mockResolvedValue({ attachments: [{ id: 101, attachment_url: 'https://files.example.com/101' }] });
    fsClient.fetchTicketConversations.mockResolvedValue([{ id: 7, attachments: [{ id: 102, attachment_url: 'https://files.example.com/102' }] }]);
    axiosGet.mockResolvedValue({ data: Buffer.from('bytes') });
    blob.uploadData.mockResolvedValue({});

    await expect(storeFsAttachmentsForTicket(70)).resolves.toEqual({ total: 3, stored: 2, alreadyStored: 1, failed: 0 });
    expect(fsClient.getTicket).toHaveBeenCalledTimes(1);
    expect(fsClient.fetchTicketConversations).toHaveBeenCalledTimes(1);
    expect(blob.uploadData).toHaveBeenCalledTimes(2);
  });

  test('storeFsAttachmentsForTicket is best effort: a FreshService failure is counted, not thrown', async () => {
    prismaMock.ticketAttachment.findMany.mockResolvedValue([{ ...fsRow, id: 1 }]);
    blob.exists.mockResolvedValue(false);
    prismaMock.ticket.findUnique.mockResolvedValue({ freshserviceTicketId: 99n, workspaceId: OFF });
    await expect(storeFsAttachmentsForTicket(70)).resolves.toMatchObject({ total: 1, stored: 0, failed: 1 });
  });
});

describe('countUnstoredFsAttachments (the Off preflight number)', () => {
  async function* names(list) { for (const name of list) yield { name }; }

  beforeEach(() => {
    attachmentService._unstoredCache?.clear();
    attachmentService._unstoredInflight?.clear();
  });

  test('counts the FS-hosted rows with no stored blob: one listing per folder, no FreshService call', async () => {
    prismaMock.ticketAttachment.findMany.mockResolvedValueOnce([
      { id: 1, blobName: 'fs/ws-5/att-1-a.pdf' }, // stored
      { id: 2, blobName: 'fs/ws-5/att-2-b.png' }, // not stored
      { id: 3, blobName: 'fs/ws-5/att-3-c.txt' }, // not stored
      { id: 4, blobName: 'fs/ws-2/att-4-d.pdf' }, // ticket moved from workspace 2; stored under its old folder
    ]);
    listBlobsFlat.mockImplementation(({ prefix }) => names(prefix === 'fs/ws-5/' ? ['fs/ws-5/att-1-a.pdf', 'fs/ws-5/att-9-other.pdf'] : ['fs/ws-2/att-4-d.pdf']));

    await expect(countUnstoredFsAttachments(OFF, { fresh: true })).resolves.toBe(2);
    expect(prismaMock.ticketAttachment.findMany).toHaveBeenCalledTimes(1); // a short page ends the walk
    expect(prismaMock.ticketAttachment.findMany).toHaveBeenCalledWith({
      where: { workspaceId: OFF, source: 'freshservice', id: { gt: 0 } },
      select: { id: true, blobName: true },
      orderBy: { id: 'asc' },
      take: 5000,
    });
    expect(listBlobsFlat.mock.calls.map(([o]) => o.prefix).sort()).toEqual(['fs/ws-2/', 'fs/ws-5/']);
    expect(blob.exists).not.toHaveBeenCalled();
    expect(mirrorMock.getInteractiveClient).not.toHaveBeenCalled();
    expect(fsClient.getTicket).not.toHaveBeenCalled();
  });

  test('rows are read a page at a time (id cursor), each folder listed once', async () => {
    const page1 = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, blobName: `fs/ws-5/att-${i + 1}-f.pdf` }));
    prismaMock.ticketAttachment.findMany
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce([{ id: 5001, blobName: 'fs/ws-5/att-5001-f.pdf' }]);
    listBlobsFlat.mockImplementation(() => names(['fs/ws-5/att-1-f.pdf']));
    await expect(countUnstoredFsAttachments(OFF, { fresh: true })).resolves.toBe(5000);
    expect(prismaMock.ticketAttachment.findMany.mock.calls[1][0].where.id).toEqual({ gt: 5000 });
    expect(listBlobsFlat).toHaveBeenCalledTimes(1);
  });

  test('cached for 10 minutes per workspace; { fresh: true } recounts; storing files forgets the count', async () => {
    prismaMock.ticketAttachment.findMany.mockResolvedValue([{ id: 1, blobName: 'fs/ws-5/att-1-a.pdf' }]);
    listBlobsFlat.mockImplementation(() => names([]));
    await expect(countUnstoredFsAttachments(OFF)).resolves.toBe(1);
    await expect(countUnstoredFsAttachments(OFF)).resolves.toBe(1);
    expect(prismaMock.ticketAttachment.findMany).toHaveBeenCalledTimes(1);

    listBlobsFlat.mockImplementation(() => names(['fs/ws-5/att-1-a.pdf']));
    await expect(countUnstoredFsAttachments(OFF, { fresh: true })).resolves.toBe(0);
    expect(prismaMock.ticketAttachment.findMany).toHaveBeenCalledTimes(2);
    await expect(countUnstoredFsAttachments(OFF)).resolves.toBe(0); // the fresh count refreshed the cache

    const realNow = Date.now;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 11 * 60 * 1000);
    try {
      await countUnstoredFsAttachments(OFF);
      expect(prismaMock.ticketAttachment.findMany).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }

    attachmentService._forgetUnstoredCount(OFF);
    await countUnstoredFsAttachments(OFF);
    expect(prismaMock.ticketAttachment.findMany).toHaveBeenCalledTimes(4);
  });

  test('concurrent panel loads share one count', async () => {
    prismaMock.ticketAttachment.findMany.mockResolvedValue([{ id: 1, blobName: 'fs/ws-5/att-1-a.pdf' }]);
    listBlobsFlat.mockImplementation(() => names([]));
    await Promise.all([countUnstoredFsAttachments(OFF), countUnstoredFsAttachments(OFF), countUnstoredFsAttachments(OFF)]);
    expect(prismaMock.ticketAttachment.findMany).toHaveBeenCalledTimes(1);
  });

  test('no FS files: 0 without touching storage; no storage configured: every row counts', async () => {
    prismaMock.ticketAttachment.findMany.mockResolvedValueOnce([]);
    await expect(countUnstoredFsAttachments(OFF, { fresh: true })).resolves.toBe(0);
    expect(listBlobsFlat).not.toHaveBeenCalled();

    delete process.env.AZURE_STORAGE_CONNECTION_STRING;
    prismaMock.ticketAttachment.findMany.mockResolvedValueOnce([{ id: 1, blobName: 'fs/ws-5/att-1-a.pdf' }, { id: 2, blobName: 'fs/ws-5/att-2-b.png' }]);
    await expect(countUnstoredFsAttachments(OFF, { fresh: true })).resolves.toBe(2);
    expect(listBlobsFlat).not.toHaveBeenCalled();
  });
});

describe('thread pull', () => {
  test('pull() skips an off workspace and an adopted ticket', async () => {
    prismaMock.ticket.findUnique.mockResolvedValueOnce({ id: 1, workspaceId: OFF, origin: 'freshservice', freshserviceTicketId: 11n });
    await expect(fsThreadPullService.pull(1)).resolves.toBe(0);
    prismaMock.ticket.findUnique.mockResolvedValueOnce({ id: 2, workspaceId: LIVE, origin: 'freshservice', freshserviceTicketId: 22n, mirrorState: 'adopted' });
    await expect(fsThreadPullService.pull(2)).resolves.toBe(0);
    expect(mirrorMock.getClient).not.toHaveBeenCalled();
    expect(fsClient.fetchTicketConversations).not.toHaveBeenCalled();
  });

  test('the gap sweep moves past an off workspace\'s phase without scanning', async () => {
    prismaMock.appSettings.findUnique.mockImplementation(async ({ where }) => (
      where.key === 'fs_thread_backfill_state' ? { value: JSON.stringify({ phase: 5, beforeId: 900 }) } : null // phase 5 = workspace 5
    ));
    const out = await fsThreadPullService.sweepStep({ ceiling: 40 });
    expect(out).toEqual({ skipped: 'freshservice_off', phase: 5 });
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
    const saved = JSON.parse(prismaMock.appSettings.upsert.mock.calls.at(-1)[0].update.value);
    expect(saved).toMatchObject({ phase: 6, beforeId: null });
  });
});

describe('groups, CSAT, history backfill', () => {
  test('group sync: off leaves the cache alone (nothing deactivated)', async () => {
    prismaMock.group.aggregate.mockResolvedValue({ _max: { syncedAt: null } });
    await expect(groupSyncService.syncWorkspaceGroups(OFF, 1000208182n, fsClient)).resolves.toEqual({ skipped: true, reason: 'freshservice_off' });
    expect(fsClient.listGroups).not.toHaveBeenCalled();
    expect(prismaMock.group.updateMany).not.toHaveBeenCalled();
  });

  test('CSAT: off reads no surveys', async () => {
    const repo = { getRecentClosedWithoutCSAT: jest.fn() };
    await expect(csatService.syncRecentCSAT({}, repo, 30, null, OFF)).resolves.toMatchObject({ total: 0, skipped: 'freshservice_off' });
    expect(repo.getRecentClosedWithoutCSAT).not.toHaveBeenCalled();
  });

  test('history backfill: skips quietly for an off workspace and keeps its window', async () => {
    modes.set(1, 'off');
    prismaMock.appSettings.findUnique.mockResolvedValue(null);
    await expect(historyBackfillService.tick(new Date(), { force: true })).resolves.toEqual({ skipped: 'freshservice_off' });
    expect(syncServiceMock.backfillDateRange).not.toHaveBeenCalled();
    expect(prismaMock.appSettings.upsert).not.toHaveBeenCalled();
  });
});
