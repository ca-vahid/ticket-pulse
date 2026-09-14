import { jest } from '@jest/globals';

const workspaceRepositoryMock = {
  getBySlug: jest.fn(),
};
const settingsRepositoryMock = {
  getFreshServiceConfigForWorkspace: jest.fn(),
};
const workspaceWebhookServiceMock = {
  getStoredConfig: jest.fn(),
  verifySecret: jest.fn(),
  recordReceived: jest.fn(),
  recordAccepted: jest.fn(),
  recordRejected: jest.fn(),
  recordError: jest.fn(),
};
const syncServiceMock = {
  syncFreshServiceTicketSnapshot: jest.fn(),
  _pollForUnassignedTickets: jest.fn(),
};
const clientMock = {
  fetchTicketSnapshot: jest.fn(),
};
const createFreshServiceClientMock = jest.fn(() => clientMock);

jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: workspaceRepositoryMock,
}));

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: settingsRepositoryMock,
}));

jest.unstable_mockModule('../src/services/workspaceWebhookService.js', () => ({
  default: workspaceWebhookServiceMock,
}));

jest.unstable_mockModule('../src/services/syncService.js', () => ({
  default: syncServiceMock,
}));

jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: createFreshServiceClientMock,
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  default: freshServiceWebhookIngestService, WebhookIngestError, INGEST_RETRY_DELAYS_MS,
} = await import('../src/services/freshServiceWebhookIngestService.js');
// Retries are real-time waits in production; tests run them back-to-back.
INGEST_RETRY_DELAYS_MS.splice(0, INGEST_RETRY_DELAYS_MS.length, 0, 0, 0);

describe('freshServiceWebhookIngestService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workspaceRepositoryMock.getBySlug.mockResolvedValue({
      id: 2,
      slug: 'it',
      isActive: true,
      freshserviceWorkspaceId: BigInt(10),
    });
    workspaceWebhookServiceMock.getStoredConfig.mockResolvedValue({
      workspaceId: 2,
      enabled: true,
      secretHash: 'hashed',
    });
    workspaceWebhookServiceMock.verifySecret.mockResolvedValue(true);
    settingsRepositoryMock.getFreshServiceConfigForWorkspace.mockResolvedValue({
      domain: 'example',
      apiKey: 'key',
    });
    clientMock.fetchTicketSnapshot.mockResolvedValue({
      id: 224183,
      workspace_id: 10,
      subject: 'Needs assignment',
    });
    syncServiceMock.syncFreshServiceTicketSnapshot.mockResolvedValue({
      ticket: {
        id: 501,
        assignedTechId: null,
        isNoise: false,
      },
    });
    syncServiceMock._pollForUnassignedTickets.mockResolvedValue({
      skipped: false,
      triggered: 1,
      ticketIds: [501],
    });
  });

  test('accepts a valid webhook through FreshService fetch, shared sync, and assignment polling', async () => {
    const ack = await freshServiceWebhookIngestService.handleTicketWebhook({
      workspaceSlug: 'it',
      freshserviceTicketId: '224183',
      suppliedSecret: 'secret',
    });
    // Ack-fast (Simorgh 13.1-2): the reply FreshService waits on is immediate;
    // the ingest runs behind it and its outcome is awaitable in-process.
    expect(ack).toEqual(expect.objectContaining({ accepted: true, queued: true, freshserviceTicketId: '224183' }));
    const result = await ack.pending;

    expect(result).toEqual(expect.objectContaining({
      accepted: true,
      freshserviceTicketId: '224183',
      ticketId: 501,
      synced: true,
      assignmentTriggered: true,
    }));
    expect(workspaceWebhookServiceMock.recordReceived).toHaveBeenCalledWith(2);
    // Webhook lane hardening (FR 08-07 #13): bounded queue wait so a congested
    // FS rate-limit queue fails fast instead of hanging the delivery.
    expect(createFreshServiceClientMock).toHaveBeenCalledWith('example', 'key', expect.objectContaining({
      priority: 'high',
      queueTimeoutMs: 15000,
    }));
    expect(clientMock.fetchTicketSnapshot).toHaveBeenCalledWith('224183');
    expect(syncServiceMock.syncFreshServiceTicketSnapshot).toHaveBeenCalledWith(2, expect.objectContaining({ id: 224183 }), expect.objectContaining({
      source: 'freshservice_webhook',
      clearReadCache: true,
    }));
    expect(syncServiceMock._pollForUnassignedTickets).toHaveBeenCalledWith(2, expect.objectContaining({
      ticketIdsOverride: [501],
      maxPerCycleOverride: 1,
      triggerSourceOverride: 'webhook',
      waitForCompletion: false,
    }));
    expect(workspaceWebhookServiceMock.recordAccepted).toHaveBeenCalledWith(2);
  });

  test('rejects invalid secrets before fetching FreshService', async () => {
    workspaceWebhookServiceMock.verifySecret.mockResolvedValue(false);

    await expect(freshServiceWebhookIngestService.handleTicketWebhook({
      workspaceSlug: 'it',
      freshserviceTicketId: '224183',
      suppliedSecret: 'wrong',
    })).rejects.toThrow(WebhookIngestError);

    expect(workspaceWebhookServiceMock.recordRejected).toHaveBeenCalledWith(2, 'invalid_secret');
    expect(clientMock.fetchTicketSnapshot).not.toHaveBeenCalled();
    expect(syncServiceMock.syncFreshServiceTicketSnapshot).not.toHaveBeenCalled();
  });

  test('rejects FreshService tickets that belong to a different workspace', async () => {
    clientMock.fetchTicketSnapshot.mockResolvedValue({
      id: 224183,
      workspace_id: 999,
      subject: 'Wrong workspace',
    });

    const ack = await freshServiceWebhookIngestService.handleTicketWebhook({
      workspaceSlug: 'it',
      freshserviceTicketId: '224183',
      suppliedSecret: 'secret',
    });
    expect(ack.queued).toBe(true);
    const outcome = await ack.pending;
    expect(outcome).toMatchObject({ accepted: true, synced: false, rejected: 'workspace_mismatch' });

    expect(workspaceWebhookServiceMock.recordRejected).toHaveBeenCalledWith(2, 'workspace_mismatch');
    expect(syncServiceMock.syncFreshServiceTicketSnapshot).not.toHaveBeenCalled();
  });

  test('a non-retryable FreshService failure is recorded, not thrown (the ack already went out)', async () => {
    const error = new Error('rate limited');
    error.response = { status: 429 };
    clientMock.fetchTicketSnapshot.mockRejectedValue(error);

    const ack = await freshServiceWebhookIngestService.handleTicketWebhook({
      workspaceSlug: 'it',
      freshserviceTicketId: '224183',
      suppliedSecret: 'secret',
    });
    const outcome = await ack.pending;
    expect(outcome).toMatchObject({ accepted: true, synced: false, attempts: 1 });
    expect(clientMock.fetchTicketSnapshot).toHaveBeenCalledTimes(1);
    expect(workspaceWebhookServiceMock.recordError).toHaveBeenCalledWith(2, 'FreshService ticket fetch failed with HTTP 429');
  });

  test('a 404 (ticket not yet readable) is retried, and succeeds on the next read', async () => {
    // Exactly the FreshService "Failed → Success" trail Simorgh reported: the
    // first fetch of a just-created ticket 404s; a moment later it is there.
    const notYet = new Error('not found');
    notYet.response = { status: 404 };
    clientMock.fetchTicketSnapshot
      .mockRejectedValueOnce(notYet)
      .mockResolvedValueOnce({ id: 224183, workspace_id: 10, subject: 'Fresh' });

    const ack = await freshServiceWebhookIngestService.handleTicketWebhook({
      workspaceSlug: 'it',
      freshserviceTicketId: '224183',
      suppliedSecret: 'secret',
    });
    const outcome = await ack.pending;
    expect(outcome).toMatchObject({ synced: true, ticketId: 501 });
    expect(clientMock.fetchTicketSnapshot).toHaveBeenCalledTimes(2);
    expect(workspaceWebhookServiceMock.recordAccepted).toHaveBeenCalledWith(2);
    expect(workspaceWebhookServiceMock.recordError).not.toHaveBeenCalled();
  });

  test('retries are bounded: a ticket that never appears is recorded as an error after the schedule', async () => {
    const notYet = new Error('not found');
    notYet.response = { status: 404 };
    clientMock.fetchTicketSnapshot.mockRejectedValue(notYet);

    const ack = await freshServiceWebhookIngestService.handleTicketWebhook({
      workspaceSlug: 'it',
      freshserviceTicketId: '224183',
      suppliedSecret: 'secret',
    });
    const outcome = await ack.pending;
    expect(outcome).toMatchObject({ synced: false, attempts: INGEST_RETRY_DELAYS_MS.length + 1 });
    expect(workspaceWebhookServiceMock.recordError).toHaveBeenCalledWith(2, 'FreshService ticket fetch failed with HTTP 404');
  });

  test('a queue timeout is retried in-process instead of bounced back to FreshService', async () => {
    const error = new Error('FreshService rate-limit queue timeout after 15000ms');
    error.code = 'FS_QUEUE_TIMEOUT';
    clientMock.fetchTicketSnapshot.mockRejectedValue(error);

    const ack = await freshServiceWebhookIngestService.handleTicketWebhook({
      workspaceSlug: 'it',
      freshserviceTicketId: '224183',
      suppliedSecret: 'secret',
    });
    const outcome = await ack.pending;
    expect(outcome).toMatchObject({ synced: false, attempts: INGEST_RETRY_DELAYS_MS.length + 1 });
    expect(workspaceWebhookServiceMock.recordError).toHaveBeenCalledWith(2, expect.stringContaining('queue timed out'));
  });

  test('a queue timeout from the shared sync path is retried the same way', async () => {
    const error = new Error('Request timed out waiting in the FreshService rate-limit queue');
    syncServiceMock.syncFreshServiceTicketSnapshot.mockRejectedValue(error);

    const ack = await freshServiceWebhookIngestService.handleTicketWebhook({
      workspaceSlug: 'it',
      freshserviceTicketId: '224183',
      suppliedSecret: 'secret',
    });
    const outcome = await ack.pending;
    expect(outcome.synced).toBe(false);
    expect(syncServiceMock.syncFreshServiceTicketSnapshot).toHaveBeenCalledTimes(INGEST_RETRY_DELAYS_MS.length + 1);
  });
});
