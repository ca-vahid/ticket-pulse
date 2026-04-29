import {
  getActivityRefreshReason,
  shouldRefreshTicketActivities,
} from '../src/services/activitySyncFreshness.js';

const existing = (overrides = {}) => ({
  id: 10,
  assignedTechId: 38,
  assignedBy: 'Ticket Pulse',
  firstAssignedAt: new Date('2026-04-29T16:51:22Z'),
  activitiesSyncFreshserviceUpdatedAt: new Date('2026-04-29T16:51:23Z'),
  activitiesSyncError: null,
  ...overrides,
});

const fsTicket = (overrides = {}) => ({
  id: 220498,
  responder_id: 1000530661,
  updated_at: '2026-04-29T16:51:23Z',
  ...overrides,
});

const prepared = (overrides = {}) => ({
  freshserviceTicketId: 220498,
  assignedFreshserviceId: 1000530661,
  assignedTechId: 38,
  freshserviceUpdatedAt: new Date('2026-04-29T16:51:23Z'),
  ...overrides,
});

describe('activity sync freshness', () => {
  test('refreshes when Freshservice responder changed even if local row was recently updated', () => {
    const reason = getActivityRefreshReason({
      fsTicket: fsTicket({ responder_id: 1000765712, updated_at: '2026-04-29T19:03:09Z' }),
      preparedTicket: prepared({
        assignedFreshserviceId: 1000765712,
        assignedTechId: 49,
        freshserviceUpdatedAt: new Date('2026-04-29T19:03:09Z'),
      }),
      existingTicket: existing({
        assignedTechId: 38,
        updatedAt: new Date('2026-04-29T19:05:00Z'),
        activitiesSyncFreshserviceUpdatedAt: new Date('2026-04-29T16:51:23Z'),
      }),
      activeEpisode: { ticketId: 10, technicianId: 38 },
    });

    expect(reason).toBe('responder_changed');
  });

  test('refreshes unassigned tickets when an active episode is still open locally', () => {
    const reason = getActivityRefreshReason({
      fsTicket: fsTicket({ responder_id: null, updated_at: '2026-04-29T17:12:06Z' }),
      preparedTicket: prepared({
        assignedFreshserviceId: null,
        assignedTechId: null,
        freshserviceUpdatedAt: new Date('2026-04-29T17:12:06Z'),
      }),
      existingTicket: existing({ assignedTechId: 38 }),
      activeEpisode: { ticketId: 10, technicianId: 38 },
    });

    expect(reason).toBe('responder_changed');
  });

  test('refreshes when Freshservice updated_at is newer than the activity watermark', () => {
    expect(shouldRefreshTicketActivities({
      fsTicket: fsTicket({ updated_at: '2026-04-29T17:12:06Z' }),
      preparedTicket: prepared({ freshserviceUpdatedAt: new Date('2026-04-29T17:12:06Z') }),
      existingTicket: existing({
        activitiesSyncFreshserviceUpdatedAt: new Date('2026-04-29T16:51:23Z'),
      }),
      activeEpisode: { ticketId: 10, technicianId: 38 },
    })).toBe(true);
  });

  test('skips when responder, episode, and activity watermark all match', () => {
    expect(getActivityRefreshReason({
      fsTicket: fsTicket(),
      preparedTicket: prepared(),
      existingTicket: existing(),
      activeEpisode: { ticketId: 10, technicianId: 38 },
    })).toBeNull();
  });
});
