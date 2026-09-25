import { jest } from '@jest/globals';

/**
 * Realtime reliability Phase 1: the "sync already in progress" early-return in
 * performFullSync used to be a fully silent no-op — the 200 {status:'skipped'}
 * response was ignored by the header button and NO event ever reached open
 * dashboards. It must now broadcast `sync-skipped` to the workspace channel.
 */

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: syncService } = await import('../src/services/syncService.js');
const { sseManager } = await import('../src/routes/sse.routes.js');

describe('performFullSync — sync-skipped broadcast', () => {
  afterEach(() => {
    syncService.runningWorkspaces.clear();
    jest.restoreAllMocks();
  });

  test('skip path returns {status:skipped} AND broadcasts sync-skipped to the workspace channel', async () => {
    const broadcastSpy = jest.spyOn(sseManager, 'broadcast').mockImplementation(() => {});
    syncService.runningWorkspaces.set(7, Date.now());

    const result = await syncService.performFullSync({ workspaceId: 7 });

    expect(result.status).toBe('skipped');
    // The broadcast rides a lazy dynamic import — flush the microtask chain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broadcastSpy).toHaveBeenCalledWith(
      'sync-skipped',
      expect.objectContaining({ workspaceId: 7, reason: expect.any(String) }),
      7,
    );
  });
});

describe('performFullSync — lock released when the run cannot even start', () => {
  afterEach(() => {
    syncService.runningWorkspaces.clear();
    jest.restoreAllMocks();
  });

  test('a failed sync-log insert releases the workspace lock (Field Equipment, 24 Sep 15:14 PT)', async () => {
    const { default: syncLogRepository } = await import('../src/services/syncLogRepository.js');
    jest.spyOn(syncLogRepository, 'createLog').mockRejectedValue(new Error('Failed to create sync log'));

    await expect(syncService.performFullSync({ workspaceId: 4 })).rejects.toThrow(/Failed to create sync log/);
    // The next cycle must run, not skip as "already in progress" for 20 minutes.
    expect(syncService.runningWorkspaces.has(4)).toBe(false);
  });
});
