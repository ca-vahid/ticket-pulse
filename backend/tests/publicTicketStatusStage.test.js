import { jest } from '@jest/globals';

// QA 10-19 #6 — the requester status page decides "where is my request" from
// the status FIRST. A ticket closed with nobody assigned is Closed (not
// Received); skipped steps say so; reopened, merged, pending, parked,
// deleted/spam, FS numeric codes and expired links each land somewhere honest.

const prismaMock = {
  publicTicketStatusSettings: { upsert: jest.fn() },
  publicTicketStatusLink: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  publicTicketStatusView: { create: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  ticketLink: { findFirst: jest.fn() },
  ticketStatusDefinition: { findMany: jest.fn() },
  urgentEscalationEvent: { findFirst: jest.fn() },
  urgentEscalationPolicy: { findUnique: jest.fn() },
  publicFeedbackSettings: { findUnique: jest.fn() },
  $transaction: jest.fn((operations) => Promise.all(operations)),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  computeTicketEta,
  ensurePublicTicketStatusLink,
  previewPublicTicketStatus,
  publicLifecycleBase,
  publicProgress,
} = await import('../src/services/publicTicketStatusService.js');

const states = (progress) => progress.steps.map((step) => step.state);
const labels = (progress) => progress.steps.map((step) => step.label);

const ticketRow = (overrides = {}) => ({
  id: 501,
  workspaceId: 1,
  origin: 'ticketpulse',
  nativeNumber: 10018,
  freshserviceTicketId: null,
  subject: 'Laptop dock does not wake the screens',
  status: 'Open',
  priority: 2,
  createdAt: new Date('2026-10-14T16:00:00Z'),
  requesterId: 40,
  assignedTechId: null,
  assignedTech: null,
  assignedAt: null,
  firstAssignedAt: null,
  resolvedAt: null,
  closedAt: null,
  reopenedAt: null,
  parkedUntil: null,
  parkKind: null,
  workspace: { id: 1, name: 'IT', defaultTimezone: 'America/Vancouver' },
  requester: { name: 'Priya Nair', email: 'priya.nair@example.com' },
  ...overrides,
});

const assignee = { assignedTechId: 7, assignedTech: { id: 7, name: 'Sam Okafor', photoUrl: null } };

function resetMocks() {
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
  prismaMock.ticketLink.findFirst.mockResolvedValue(null);
  prismaMock.ticketStatusDefinition.findMany.mockResolvedValue([]);
  prismaMock.urgentEscalationEvent.findFirst.mockResolvedValue(null);
  prismaMock.urgentEscalationPolicy.findUnique.mockResolvedValue(null);
  prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(null);
}

describe('public status stage: closed or resolved without an assignee', () => {
  beforeEach(resetMocks);

  test('closed with nobody ever assigned is Closed, with the skipped steps marked', () => {
    const progress = publicProgress(ticketRow({ status: 'Closed', closedAt: new Date('2026-10-14T17:00:00Z') }));
    expect(progress.stage).toBe('closed');
    expect(progress.headline).toBe('Closed');
    expect(progress.tone).toBe('resolved');
    expect(states(progress)).toEqual(['complete', 'skipped', 'complete']);
    expect(labels(progress)).toEqual(['Received', 'In progress', 'Closed']);
  });

  test('closed even when the closed_at timestamp is missing (status decides, not timestamps)', () => {
    const progress = publicProgress(ticketRow({ status: 'Closed', closedAt: null, resolvedAt: null }));
    expect(progress.stage).toBe('closed');
  });

  test('resolved after an assignment: every step complete', () => {
    const progress = publicProgress(ticketRow({ ...assignee, status: 'Resolved', assignedAt: new Date('2026-10-14T16:10:00Z') }));
    expect(progress.stage).toBe('resolved');
    expect(states(progress)).toEqual(['complete', 'complete', 'complete']);
  });

  test('a past assignment still counts after the agent was cleared', () => {
    const progress = publicProgress(ticketRow({ status: 'Resolved', firstAssignedAt: new Date('2026-10-14T16:10:00Z') }));
    expect(states(progress)).toEqual(['complete', 'complete', 'complete']);
  });

  test('preview payload of a closed, never-assigned ticket says Closed end to end', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(ticketRow({ status: 'Closed', closedAt: new Date('2026-10-14T17:00:00Z') }));
    const payload = await previewPublicTicketStatus(1, 501);
    expect(payload.progress.stage).toBe('closed');
    expect(payload.ticket.statusTone).toBe('resolved');
    expect(payload.timeline.map((item) => item.key)).toEqual(['received', 'closed']);
    expect(payload.eta.isComplete).toBe(true);
  });
});

describe('public status stage: custom statuses through the registry', () => {
  beforeEach(resetMocks);

  test('a custom status whose base is Resolved reads as Resolved, unassigned or not', async () => {
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue([
      { name: 'Open', baseStatus: 'Open', isActive: true },
      { name: 'Fixed', baseStatus: 'Resolved', isActive: true },
      { name: 'Awaiting Parts', baseStatus: 'Pending', isActive: true },
    ]);
    prismaMock.ticket.findFirst.mockResolvedValue(ticketRow({ workspaceId: 71, status: 'Fixed' }));
    const payload = await previewPublicTicketStatus(71, 501);
    expect(payload.progress.stage).toBe('resolved');
    expect(payload.progress.headline).toBe('Resolved');
    expect(states(payload.progress)).toEqual(['complete', 'skipped', 'complete']);
    expect(payload.ticket.statusTone).toBe('resolved');
  });

  test('stamped bases decide directly', () => {
    expect(publicProgress(ticketRow({ status: 'Fixed', statusBase: 'Resolved' })).stage).toBe('resolved');
    expect(publicProgress(ticketRow({ status: 'Retired', statusBase: 'Closed' })).stage).toBe('closed');
    expect(publicProgress(ticketRow({ status: 'Needs Rework', statusBase: 'Pending' })).stage).toBe('waiting');
  });

  test('an unknown label that says the work is over is done; one that says nothing keeps its name', () => {
    expect(publicProgress(ticketRow({ status: 'Cancelled' })).stage).toBe('closed');
    expect(publicProgress(ticketRow({ status: 'Completed' })).stage).toBe('resolved');
    expect(publicProgress(ticketRow({ status: 'Retired', closedAt: new Date('2026-10-15T00:00:00Z') })).stage).toBe('closed');
    const scheduled = publicProgress(ticketRow({ status: 'Scheduled' }));
    expect(scheduled.stage).toBe('received');
    expect(scheduled.headline).toBe('Scheduled');
    expect(scheduled.tone).toBe('neutral');
  });
});

describe('public status stage: reopened', () => {
  beforeEach(resetMocks);

  test('reopened after resolve reads as Reopened and in progress, not complete', async () => {
    const reopened = ticketRow({
      ...assignee,
      origin: 'freshservice',
      status: 'Open',
      // FreshService stats keep resolved_at after a reopen.
      resolvedAt: new Date('2026-10-15T10:00:00Z'),
      reopenedAt: new Date('2026-10-16T09:00:00Z'),
      assignedAt: new Date('2026-10-14T16:10:00Z'),
    });
    const progress = publicProgress(reopened);
    expect(progress.stage).toBe('in_progress');
    expect(progress.headline).toBe('Reopened');
    expect(progress.reopened).toBe(true);
    expect(states(progress)).toEqual(['complete', 'current', 'upcoming']);

    const eta = await computeTicketEta(reopened);
    expect(eta.isComplete).toBe(false);
    expect(eta.completedAt).toBeNull();
  });

  test('reopened and still unassigned is back at Received', () => {
    const progress = publicProgress(ticketRow({ status: 'Open', reopenedAt: new Date('2026-10-16T09:00:00Z') }));
    expect(progress.stage).toBe('received');
    expect(progress.headline).toBe('Reopened');
    expect(states(progress)).toEqual(['current', 'upcoming', 'upcoming']);
  });

  test('a reopen in the past does not haunt a ticket that is closed again', () => {
    const progress = publicProgress(ticketRow({ status: 'Closed', reopenedAt: new Date('2026-10-16T09:00:00Z') }));
    expect(progress.headline).toBe('Closed');
    expect(progress.reopened).toBe(false);
  });
});

describe('public status stage: merged', () => {
  beforeEach(resetMocks);

  const mergeLink = (requesterId) => ({
    createdAt: new Date('2026-10-15T12:00:00Z'),
    relatedTicket: { id: 600, origin: 'ticketpulse', nativeNumber: 10020, freshserviceTicketId: null, requesterId },
  });

  test('says where the request continues and links there for the same requester', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(ticketRow({ status: 'Closed' }));
    prismaMock.ticketLink.findFirst.mockResolvedValue(mergeLink(40));
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue({
      token: 'target-token', enabled: true, revokedAt: null, expiresAt: null,
    });
    const payload = await previewPublicTicketStatus(1, 501);
    expect(payload.progress.stage).toBe('merged');
    expect(payload.progress.headline).toBe('Merged');
    expect(payload.progress.mergedInto.displayRef).toBe('TP-10020');
    expect(payload.progress.mergedInto.statusUrl).toMatch(/\/ticket-status\/target-token$/);
    expect(states(payload.progress)).toEqual(['complete', 'skipped', 'complete']);
    expect(payload.timeline.at(-1).key).toBe('merged');
  });

  test('never links to another person\'s request', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(ticketRow({ status: 'Closed' }));
    prismaMock.ticketLink.findFirst.mockResolvedValue(mergeLink(99));
    const payload = await previewPublicTicketStatus(1, 501);
    expect(payload.progress.mergedInto).toEqual({ displayRef: 'TP-10020', statusUrl: null });
    expect(prismaMock.publicTicketStatusLink.findUnique).not.toHaveBeenCalled();
  });

  test('an FS-born source FreshService has not closed yet still points at the target', () => {
    const progress = publicProgress(ticketRow({ status: 'Open' }), {
      mergedInto: { displayRef: '#245100', mergedAt: new Date('2026-10-15T12:00:00Z') },
    });
    expect(progress.stage).toBe('merged');
  });

  test('reopened after the merge goes back to the live stage', () => {
    const progress = publicProgress(ticketRow({ ...assignee, status: 'Open', reopenedAt: new Date('2026-10-16T09:00:00Z') }), {
      mergedInto: { displayRef: '#245100', mergedAt: new Date('2026-10-15T12:00:00Z') },
    });
    expect(progress.stage).toBe('in_progress');
    expect(progress.mergedInto).toBeNull();
  });
});

describe('public status stage: pending, on hold and parked', () => {
  beforeEach(resetMocks);

  test('Pending with an agent is On hold at the middle step', () => {
    const progress = publicProgress(ticketRow({ ...assignee, status: 'Pending' }));
    expect(progress.stage).toBe('waiting');
    expect(progress.headline).toBe('On hold');
    expect(progress.tone).toBe('waiting');
    expect(states(progress)).toEqual(['complete', 'current', 'upcoming']);
  });

  test('Pending Response with nobody assigned waits on the requester', () => {
    const progress = publicProgress(ticketRow({ status: 'Pending Response' }));
    expect(progress.headline).toBe('Waiting on you');
    expect(progress.waitingOnRequester).toBe(true);
    expect(labels(progress)[1]).toBe('Waiting on you');
    expect(states(progress)).toEqual(['complete', 'current', 'upcoming']);
  });

  test('a parked open ticket is On hold with the date it comes back', () => {
    const until = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const progress = publicProgress(ticketRow({ ...assignee, parkedUntil: until, parkKind: 'waiting_on' }));
    expect(progress.stage).toBe('waiting');
    expect(progress.headline).toBe('On hold');
    expect(progress.resumeAt).toBe(until.toISOString());
  });

  test('an Auto-help park waits on the requester and shows no date', () => {
    const progress = publicProgress(ticketRow({ parkedUntil: new Date(Date.now() + 86400000), parkKind: 'auto_help' }));
    expect(progress.headline).toBe('Waiting on you');
    expect(progress.resumeAt).toBeNull();
  });

  test('an expired park no longer holds the ticket', () => {
    const progress = publicProgress(ticketRow({ ...assignee, parkedUntil: new Date(Date.now() - 1000), parkKind: 'until_date' }));
    expect(progress.stage).toBe('in_progress');
  });
});

describe('public status stage: the remaining gaps', () => {
  beforeEach(resetMocks);

  test('open and unassigned is Received; an unassigned "In Progress" label is in progress', () => {
    expect(publicProgress(ticketRow()).headline).toBe('Received');
    expect(states(publicProgress(ticketRow()))).toEqual(['current', 'upcoming', 'upcoming']);
    const progress = publicProgress(ticketRow({ status: 'In Progress', statusBase: 'Open' }));
    expect(progress.stage).toBe('in_progress');
    expect(states(progress)).toEqual(['complete', 'current', 'upcoming']);
  });

  test('Deleted and Spam read as Closed and never show the raw word', async () => {
    expect(publicProgress(ticketRow({ status: 'Deleted' })).stage).toBe('closed');
    expect(publicProgress(ticketRow({ status: 'Spam' })).headline).toBe('Closed');
    prismaMock.ticket.findFirst.mockResolvedValue(ticketRow({ status: 'Spam' }));
    const payload = await previewPublicTicketStatus(1, 501);
    expect(payload.ticket.status).toBe('Closed');
    expect(JSON.stringify(payload.progress)).not.toMatch(/Spam/);
  });

  test('FreshService numeric codes map through the base', () => {
    expect(publicLifecycleBase({ status: '5' })).toBe('Closed');
    expect(publicProgress(ticketRow({ status: '4' })).stage).toBe('resolved');
    expect(publicProgress(ticketRow({ status: '3' })).stage).toBe('waiting');
    const open = publicProgress(ticketRow({ status: '2' }));
    expect(open.stage).toBe('received');
    expect(open.headline).toBe('Received');
    // An unmapped tenant code is never shown as a bare number.
    expect(publicProgress(ticketRow({ status: '17' })).headline).toBe('Received');
  });

  test('an expired link is replaced, not re-sent', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 88, workspaceId: 1 });
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue({
      id: 5,
      workspaceId: 1,
      ticketId: 88,
      token: 'stale-token',
      enabled: true,
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });
    prismaMock.publicTicketStatusLink.upsert.mockImplementation(({ update }) => Promise.resolve({ ...update }));
    const link = await ensurePublicTicketStatusLink({ workspaceId: 1, ticketId: 88, baseUrl: 'https://ticketpulse.example' });
    expect(link.existing).toBe(false);
    expect(link.token).not.toBe('stale-token');
    expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});
