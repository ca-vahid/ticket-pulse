import { jest } from '@jest/globals';

const prismaMock = {
  publicTicketStatusSettings: {
    upsert: jest.fn(),
  },
  publicTicketStatusLink: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
  },
  publicTicketStatusView: {
    create: jest.fn(),
  },
  ticket: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  urgentEscalationEvent: {
    findFirst: jest.fn(),
  },
  urgentEscalationPolicy: {
    findUnique: jest.fn(),
  },
  $transaction: jest.fn((operations) => Promise.all(operations)),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Business hours for "did this request come in after hours?" (QA 10-23 #1).
const availabilityMock = { isBusinessHours: jest.fn() };
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({ default: availabilityMock }));

const {
  buildPublicTicketStatusUrl,
  computeTicketEta,
  ensurePublicTicketStatusLink,
  normalizePublicTicketStatusSettings,
  previewPublicTicketStatus,
} = await import('../src/services/publicTicketStatusService.js');

describe('public ticket status service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    availabilityMock.isBusinessHours.mockResolvedValue({ isBusinessHours: false });
    prismaMock.publicTicketStatusSettings.upsert.mockResolvedValue({
      enabled: true,
      expiryDays: 60,
      showRequesterName: false,
      showRequesterEmail: false,
      showAssignedAgent: true,
      showAssignedAgentAvatar: true,
      showSummary: true,
      showPriority: true,
      showCategory: true,
      showWorkspaceStats: true,
      etaLookbackDays: 180,
      etaMinSampleSize: 8,
      etaPercentile: 75,
    });
  });

  test('normalizes workspace public status settings with safe bounds', () => {
    const settings = normalizePublicTicketStatusSettings({
      enabled: true,
      expiryDays: null,
      etaLookbackDays: 10,
      etaMinSampleSize: 200,
      etaPercentile: 99,
      showRequesterEmail: true,
    });

    expect(settings.expiryDays).toBeNull();
    expect(settings.etaLookbackDays).toBe(30);
    expect(settings.etaMinSampleSize).toBe(100);
    expect(settings.etaPercentile).toBe(95);
    expect(settings.showRequesterEmail).toBe(true);
  });

  test('computes ETA from the best matching historical tier using configured percentile', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([
      { resolutionTimeSeconds: 3600 },
      { resolutionTimeSeconds: 7200 },
      { resolutionTimeSeconds: 10800 },
      { resolutionTimeSeconds: 14400 },
    ]);

    const eta = await computeTicketEta({
      id: 44,
      workspaceId: 1,
      priority: 3,
      assessedPriority: 'High',
      internalCategoryId: 10,
      internalSubcategoryId: 12,
      createdAt: new Date('2026-05-29T18:00:00Z'),
    }, {
      etaLookbackDays: 180,
      etaMinSampleSize: 3,
      etaPercentile: 75,
    });

    expect(eta.estimatedSeconds).toBe(10800);
    expect(eta.matchTier).toBe('internal_subcategory_priority');
    expect(eta.sampleSize).toBe(4);
    expect(prismaMock.ticket.findMany).toHaveBeenCalledTimes(1);
  });

  test('pauses overdue ETA display for pending tickets', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([
      { resolutionTimeSeconds: 3600 },
      { resolutionTimeSeconds: 7200 },
      { resolutionTimeSeconds: 10800 },
    ]);

    const eta = await computeTicketEta({
      id: 45,
      workspaceId: 1,
      priority: 2,
      status: 'Pending',
      createdAt: new Date('2026-05-01T18:00:00Z'),
    }, {
      etaLookbackDays: 180,
      etaMinSampleSize: 3,
      etaPercentile: 75,
    });

    expect(eta.paused).toBe(true);
    expect(eta.overdue).toBe(false);
    expect(eta.remainingLabel).toBe('Paused while pending');
  });

  test('shows actual resolution instead of overdue for closed tickets without explicit close timestamps', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([
      { resolutionTimeSeconds: 3600 },
      { resolutionTimeSeconds: 7200 },
      { resolutionTimeSeconds: 10800 },
    ]);

    const eta = await computeTicketEta({
      id: 46,
      workspaceId: 1,
      priority: 4,
      status: 'Closed',
      createdAt: new Date('2026-02-12T21:40:34Z'),
      updatedAt: new Date('2026-05-29T20:35:40Z'),
      resolutionTimeSeconds: 8140,
    }, {
      etaLookbackDays: 180,
      etaMinSampleSize: 3,
      etaPercentile: 75,
    });

    expect(eta.state).toBe('resolved');
    expect(eta.overdue).toBe(false);
    expect(eta.actualResolutionSeconds).toBe(8140);
    expect(eta.actualResolutionLabel).toBe('2h 16m');
    expect(eta.completedAt).toBe('2026-02-12T23:56:14.000Z');
  });

  test('still exposes completion state when there is no matching ETA history', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([]);

    const eta = await computeTicketEta({
      id: 47,
      workspaceId: 1,
      priority: 4,
      status: 'Resolved',
      createdAt: new Date('2026-05-29T18:00:00Z'),
      resolutionTimeSeconds: 5400,
    }, {
      etaLookbackDays: 180,
      etaMinSampleSize: 3,
      etaPercentile: 75,
    });

    expect(eta.state).toBe('resolved');
    expect(eta.matchTier).toBe('none');
    expect(eta.displayLabel).toBe('1h 30m');
    expect(eta.overdue).toBe(false);
  });

  test('reuses the stored raw token so workflow templates can keep rendering the permanent ticket URL', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 88, workspaceId: 1 });
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue({
      id: 5,
      workspaceId: 1,
      ticketId: 88,
      token: 'stored-token',
      enabled: true,
      revokedAt: null,
      expiresAt: null,
    });

    const link = await ensurePublicTicketStatusLink({
      workspaceId: 1,
      ticketId: 88,
      baseUrl: 'https://ticketpulse.example',
    });

    expect(link.existing).toBe(true);
    expect(link.url).toBe(buildPublicTicketStatusUrl('stored-token', 'https://ticketpulse.example'));
  });
});

// Phase 8c: tone/stage decisions key on the registry BASE stamped onto the
// loaded ticket (ticket.statusBase); the old substring heuristics remain the
// fallback for unstamped/unknown FS labels.
describe('base-aware public status (Phase 8c)', () => {
  let statusTone;
  let publicStatusBase;
  beforeAll(async () => {
    ({ statusTone, publicStatusBase } = await import('../src/services/publicTicketStatusService.js'));
  });

  test('stamped registry base wins over the label text', () => {
    // "Needs Rework" contains no pending/open/closed substring — base carries it.
    expect(publicStatusBase({ status: 'Needs Rework', statusBase: 'Pending' })).toBe('Pending');
    expect(statusTone({ status: 'Needs Rework', statusBase: 'Pending' })).toBe('waiting');
    expect(statusTone({ status: 'Fixed', statusBase: 'Resolved' })).toBe('resolved');
    expect(statusTone({ status: 'In Triage', statusBase: 'Open' })).toBe('open');
  });

  test('unstamped tickets and raw labels fall back to the substring/FS-int heuristics', () => {
    expect(statusTone({ status: 'Waiting on Customer', statusBase: null })).toBe('waiting');
    expect(statusTone('Auto-Closed')).toBe('resolved');
    expect(statusTone('4')).toBe('resolved');
    expect(statusTone('Deleted')).toBe('neutral');
    expect(publicStatusBase({ status: 'On Hold' })).toBe('Pending');
  });

  test('computeTicketEta pauses the estimate for a custom Pending-base status', async () => {
    prismaMock.ticket.findMany.mockResolvedValue(
      Array.from({ length: 10 }, () => ({ resolutionTimeSeconds: 3600 })),
    );
    const eta = await computeTicketEta({
      id: 9001,
      workspaceId: 1,
      status: 'Needs Rework',
      statusBase: 'Pending',
      priority: 3,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      resolvedAt: null,
      closedAt: null,
    });
    expect(eta.state).toBe('paused');
    expect(eta.paused).toBe(true);
    expect(eta.pausedReason).toMatch(/Pending/);
  });

  test('computeTicketEta treats a custom Resolved-base status as complete', async () => {
    prismaMock.ticket.findMany.mockResolvedValue(
      Array.from({ length: 10 }, () => ({ resolutionTimeSeconds: 3600 })),
    );
    const eta = await computeTicketEta({
      id: 9002,
      workspaceId: 1,
      status: 'Fixed',
      statusBase: 'Resolved',
      priority: 3,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      resolvedAt: null,
      closedAt: null,
      resolutionTimeSeconds: 5400,
    });
    expect(eta.state).toBe('resolved');
    expect(eta.isComplete).toBe(true);
    expect(eta.statusLabel).toBe('Resolved'); // Resolved base, not Closed
  });
});

// QA 10-15 #7: the requester page shows ONE number — TP-<n> for a Ticket
// Pulse ticket (even with a FreshService fallback copy), #<fs id> otherwise —
// and only the action buttons the workspace actually offers.
describe('public status payload: display number and actions (QA 10-15 #7)', () => {
  const baseTicket = {
    id: 501,
    workspaceId: 1,
    subject: 'Laptop dock does not wake the screens',
    status: 'Open',
    priority: 2,
    createdAt: new Date('2026-10-14T16:00:00Z'),
    workspace: { id: 1, name: 'IT', defaultTimezone: 'America/Vancouver' },
    requester: { name: 'Priya Nair', email: 'priya.nair@example.com' },
    assignedTech: { id: 7, name: 'Sam Okafor', email: 'sam.okafor@example.com', photoUrl: null },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.publicTicketStatusSettings.upsert.mockResolvedValue({
      enabled: true,
      expiryDays: 60,
      showAssignedAgent: true,
      showAssignedAgentAvatar: true,
      showSummary: true,
      showPriority: true,
      showCategory: true,
      showWorkspaceStats: false,
      etaLookbackDays: 180,
      etaMinSampleSize: 8,
      etaPercentile: 75,
    });
    prismaMock.ticket.findMany.mockResolvedValue([]);
    prismaMock.urgentEscalationEvent.findFirst.mockResolvedValue(null);
    prismaMock.urgentEscalationPolicy.findUnique.mockResolvedValue(null);
  });

  test('a Ticket Pulse ticket with a FreshService copy shows its TP number', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({
      ...baseTicket,
      origin: 'ticketpulse',
      nativeNumber: 10018,
      freshserviceTicketId: 245001n,
    });

    const payload = await previewPublicTicketStatus(1, 501);

    expect(payload.ticket.displayRef).toBe('TP-10018');
    expect(payload.ticket.origin).toBe('ticketpulse');
    // Older consumers keep the FreshService id.
    expect(payload.ticket.freshserviceTicketId).toBe('245001');
  });

  test('a FreshService ticket shows #<fs id>', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({
      ...baseTicket,
      origin: 'freshservice',
      nativeNumber: null,
      freshserviceTicketId: 244990n,
    });

    const payload = await previewPublicTicketStatus(1, 501);

    expect(payload.ticket.displayRef).toBe('#244990');
    expect(payload.ticket.origin).toBe('freshservice');
  });

  test('action availability follows the workspace escalation policy', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...baseTicket, origin: 'freshservice', freshserviceTicketId: 1n });

    let payload = await previewPublicTicketStatus(1, 501);
    // No policy row: urgency on by default, after-hours help off by default.
    expect(payload.publicActions.raiseUrgencyAvailable).toBe(true);
    expect(payload.publicActions.immediateSupportAvailable).toBe(false);

    prismaMock.urgentEscalationPolicy.findUnique.mockResolvedValue({
      selfServiceEnabled: true,
      businessUrgencyEnabled: false,
    });
    payload = await previewPublicTicketStatus(1, 501);
    expect(payload.publicActions.raiseUrgencyAvailable).toBe(false);
    expect(payload.publicActions.immediateSupportAvailable).toBe(true);
  });

  test('after-hours help is offered only on a request that came in after hours (QA 10-23 #1)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...baseTicket, origin: 'freshservice', freshserviceTicketId: 1n });
    prismaMock.urgentEscalationPolicy.findUnique.mockResolvedValue({ selfServiceEnabled: true, businessUrgencyEnabled: true });

    availabilityMock.isBusinessHours.mockResolvedValue({ isBusinessHours: true });
    let payload = await previewPublicTicketStatus(1, 501);
    expect(payload.publicActions.immediateSupportAvailable).toBe(false);
    expect(payload.publicActions.receivedAfterHours).toBe(false);
    expect(availabilityMock.isBusinessHours).toHaveBeenCalledWith(new Date(baseTicket.createdAt), expect.any(String), baseTicket.workspaceId ?? null);

    availabilityMock.isBusinessHours.mockResolvedValue({ isBusinessHours: false, reason: 'Holiday: Thanksgiving' });
    payload = await previewPublicTicketStatus(1, 501);
    expect(payload.publicActions.immediateSupportAvailable).toBe(true);

    // The calendar cannot be read: keep the button rather than lose it in an emergency.
    availabilityMock.isBusinessHours.mockRejectedValue(new Error('down'));
    payload = await previewPublicTicketStatus(1, 501);
    expect(payload.publicActions.immediateSupportAvailable).toBe(true);
  });

  test('reports an urgency the requester already raised', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...baseTicket, origin: 'freshservice', freshserviceTicketId: 2n });
    prismaMock.urgentEscalationEvent.findFirst.mockImplementation(({ where }) => Promise.resolve(
      where.source === 'business_urgency'
        ? { id: 3, status: 'sent', createdAt: new Date('2026-10-14T18:30:00Z'), priorityWritebackStatus: null }
        : null,
    ));

    const payload = await previewPublicTicketStatus(1, 501);

    expect(payload.publicActions.urgencyRaised).toBe(true);
    expect(payload.publicActions.urgencyRaisedAt).toBe('2026-10-14T18:30:00.000Z');
    expect(payload.publicActions.immediateSupportRequested).toBe(false);
  });
});
