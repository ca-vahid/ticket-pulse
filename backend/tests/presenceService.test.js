import { jest } from '@jest/globals';

/** Ticket presence (gap plan 2 P4.1): in-memory registry, TTL sweep, broadcasts. */

const broadcastMock = jest.fn();

jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  sseManager: { broadcast: broadcastMock },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  heartbeatPresence, leavePresence, presenceSnapshot, sweepStalePresence, resetPresence,
} = await import('../src/services/presenceService.js');

beforeEach(() => {
  jest.clearAllMocks();
  resetPresence();
});

describe('presence registry', () => {
  test('a new viewer broadcasts a workspace-scoped presence event', () => {
    heartbeatPresence(1, 42, { email: 'ana@x.com', name: 'Ana' });
    expect(broadcastMock).toHaveBeenCalledWith('presence', {
      workspaceId: 1,
      ticketId: 42,
      viewers: [{ email: 'ana@x.com', name: 'Ana' }],
    }, 1);
  });

  test('repeat heartbeats refresh silently (no broadcast spam)', () => {
    heartbeatPresence(1, 42, { email: 'ana@x.com', name: 'Ana' });
    broadcastMock.mockClear();
    heartbeatPresence(1, 42, { email: 'ana@x.com', name: 'Ana' });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  test('heartbeat returns the full viewer set for the ticket', () => {
    heartbeatPresence(1, 42, { email: 'ana@x.com', name: 'Ana' });
    const viewers = heartbeatPresence(1, 42, { email: 'bo@x.com', name: 'Bo' });
    expect(viewers).toHaveLength(2);
    expect(viewers.map((v) => v.email).sort()).toEqual(['ana@x.com', 'bo@x.com']);
  });

  test('leave removes the viewer and broadcasts the remainder', () => {
    heartbeatPresence(1, 42, { email: 'ana@x.com', name: 'Ana' });
    heartbeatPresence(1, 42, { email: 'bo@x.com', name: 'Bo' });
    broadcastMock.mockClear();
    leavePresence(1, 42, 'ana@x.com');
    expect(broadcastMock).toHaveBeenCalledWith('presence', expect.objectContaining({
      ticketId: 42,
      viewers: [{ email: 'bo@x.com', name: 'Bo' }],
    }), 1);
    leavePresence(1, 42, 'bo@x.com');
    expect(presenceSnapshot(1)).toEqual({});
  });

  test('snapshot is workspace-scoped', () => {
    heartbeatPresence(1, 42, { email: 'ana@x.com', name: 'Ana' });
    heartbeatPresence(2, 42, { email: 'zed@x.com', name: 'Zed' });
    expect(presenceSnapshot(1)).toEqual({ 42: [{ email: 'ana@x.com', name: 'Ana' }] });
    expect(presenceSnapshot(2)).toEqual({ 42: [{ email: 'zed@x.com', name: 'Zed' }] });
  });

  test('the sweep expires viewers whose heartbeats stopped', () => {
    heartbeatPresence(1, 42, { email: 'ana@x.com', name: 'Ana' });
    broadcastMock.mockClear();
    sweepStalePresence(Date.now() + 76_000);
    expect(presenceSnapshot(1)).toEqual({});
    expect(broadcastMock).toHaveBeenCalledWith('presence', expect.objectContaining({
      ticketId: 42,
      viewers: [],
    }), 1);
  });

  test('leaving an unknown viewer is a silent no-op', () => {
    leavePresence(1, 99, 'ghost@x.com');
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
