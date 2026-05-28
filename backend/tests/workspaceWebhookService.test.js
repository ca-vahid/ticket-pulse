import { jest } from '@jest/globals';

const webhookRepoMock = {
  ensureForWorkspace: jest.fn(),
  getByWorkspaceId: jest.fn(),
  update: jest.fn(),
  incrementReceipt: jest.fn(),
  recordAccepted: jest.fn(),
  recordRejected: jest.fn(),
  recordError: jest.fn(),
};

jest.unstable_mockModule('../src/services/workspaceWebhookRepository.js', () => ({
  default: webhookRepoMock,
}));

const { default: workspaceWebhookService } = await import('../src/services/workspaceWebhookService.js');

describe('workspaceWebhookService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    webhookRepoMock.ensureForWorkspace.mockResolvedValue({
      id: 10,
      workspaceId: 2,
      enabled: false,
      secretHash: null,
      secretLast4: null,
      receivedCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      errorCount: 0,
    });
    webhookRepoMock.getByWorkspaceId.mockResolvedValue({
      id: 10,
      workspaceId: 2,
      enabled: false,
      secretHash: null,
      secretLast4: null,
      receivedCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      errorCount: 0,
    });
    webhookRepoMock.update.mockImplementation((workspaceId, data) => Promise.resolve({
      id: 10,
      workspaceId,
      enabled: Boolean(data.enabled),
      secretHash: data.secretHash || null,
      secretLast4: data.secretLast4 || null,
      receivedCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      errorCount: 0,
      ...data,
    }));
  });

  test('generates and hashes a secret when enabling a config without one', async () => {
    const result = await workspaceWebhookService.updateConfig(2, { enabled: true });

    expect(result.secret).toMatch(/^tpwh_/);
    expect(result.secretLast4).toBe(result.secret.slice(-4));
    expect(result.hasSecret).toBe(true);
    expect(webhookRepoMock.update).toHaveBeenCalledWith(2, expect.objectContaining({
      enabled: true,
      secretHash: expect.any(String),
      secretLast4: result.secret.slice(-4),
    }));
    expect(await workspaceWebhookService.verifySecret({
      secretHash: webhookRepoMock.update.mock.calls[0][1].secretHash,
    }, result.secret)).toBe(true);
  });

  test('does not expose an existing raw secret when toggling enabled state', async () => {
    webhookRepoMock.getByWorkspaceId.mockResolvedValue({
      id: 10,
      workspaceId: 2,
      enabled: false,
      secretHash: '$2b$12$existing',
      secretLast4: 'abcd',
      receivedCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      errorCount: 0,
    });

    const result = await workspaceWebhookService.updateConfig(2, { enabled: true });

    expect(result.secret).toBeNull();
    expect(webhookRepoMock.update).toHaveBeenCalledWith(2, { enabled: true });
  });

  test('rotateSecret returns the new raw secret once and stores only hash metadata', async () => {
    const result = await workspaceWebhookService.rotateSecret(2);

    expect(result.secret).toMatch(/^tpwh_/);
    expect(result.secretLast4).toBe(result.secret.slice(-4));
    expect(webhookRepoMock.update).toHaveBeenCalledWith(2, expect.objectContaining({
      secretHash: expect.any(String),
      secretLast4: result.secret.slice(-4),
    }));
  });
});
