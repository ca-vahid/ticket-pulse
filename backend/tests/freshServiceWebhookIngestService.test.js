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
  default: freshServiceWebhookIngestService,
  WebhookIngestError,
} = await import('../src/services/freshServiceWebhookIngestService.js');

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
    const result = await freshServiceWebhookIngestService.handleTicketWebhook({
      workspaceSlug: 'it',
      freshserviceTicketId: '224183',
      suppliedSecret: 'secret',
    });

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

    await expect(freshServiceWebhookIngestService.handleTicketWebhook({
      workspaceSlug: 'it',
      freshserviceTicketId: '224183',
      suppliedSecret: 'secret',
    })).rejects.toMatchObject({ code: 'workspace_mismatch', statusCode: 403 });

    expect(workspaceWebhookServiceMock.recordRejected).toHaveBeenCalledWith(2, 'workspace_mismatch');
    expect(syncServiceMock.syncFreshServiceTicketSnapshot).not.toHaveBeenCalled();
  });

  test('surfaces FreshService fetch failures as retryable webhook errors', async () => {
    const error = new Error('rate limited');
    error.response = { status: 429 };
    clientMock.fetchTicketSnapshot.mockRejectedValue(error);

    await expect(freshServiceWebhookIngestService.handleTicketWebhook({
      workspaceSlug: 'it',
      freshserviceTicketId: '224183',
      suppliedSecret: 'secret',
    })).rejects.toMatchObject({ code: 'freshservice_429', statusCode: 502 });

    expect(workspaceWebhookServiceMock.recordError).toHaveBeenCalledWith(2, 'FreshService ticket fetch failed with HTTP 429');
  });

  test('maps FS_QUEUE_TIMEOUT to a 503 so FreshService retries the delivery', async () => {
    const error = new Error('FreshService rate-limit queue timeout after 15000ms');
    error.code = 'FS_QUEUE_TIMEOUT';
    clientMock.fetchTicketSnapshot.mockRejectedValue(error);

    await expect(freshServiceWebhookIngestService.handleTicketWebhook({
      workspaceSlug: 'it',
      freshserviceTicketId: '224183',
      suppliedSecret: 'secret',
    })).rejects.toMatchObject({ code: 'freshservice_queue_timeout', statusCode: 503 });

    expect(workspaceWebhookServiceMock.recordError).toHaveBeenCalledWith(2, expect.stringContaining('queue timed out'));
  });

  test('maps a queue timeout thrown from the shared sync path to 503 as well', async () => {
    const error = new Error('Request timed out waiting in the FreshService rate-limit queue');
    syncServiceMock.syncFreshServiceTicketSnapshot.mockRejectedValue(error);

    await expect(freshServiceWebhookIngestService.handleTicketWebhook({
      workspaceSlug: 'it',
      freshserviceTicketId: '224183',
      suppliedSecret: 'secret',
    })).rejects.toMatchObject({ code: 'freshservice_queue_timeout', statusCode: 503 });
  });
});
