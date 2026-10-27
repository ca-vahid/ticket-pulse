import { jest } from '@jest/globals';

/**
 * QA 10-27 — list filters behind two Tickets page fixes:
 *  - #5 Requester filter: ?requesterId= takes one id or a comma list.
 *  - #4 Board columns: a board column sends its own statuses; inside a
 *    segment ("Unassigned", "Open", …) those statuses narrow the segment's
 *    status scope instead of being replaced by it.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  queueCardConfig: { findUnique: jest.fn(), upsert: jest.fn() },
  ticketFormConfig: { findUnique: jest.fn(), upsert: jest.fn(), delete: jest.fn() },
  userPreference: { findUnique: jest.fn(), upsert: jest.fn() },
  customFieldDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  group: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  approvalCategory: { findMany: jest.fn().mockResolvedValue([]) },
  ticketTag: { findMany: jest.fn().mockResolvedValue([]) },
  categoryGroupLink: { findMany: jest.fn().mockResolvedValue([]) },
  ticketTypeDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 7, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 7, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 7, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 7, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  slaPolicy: { findFirst: jest.fn() },
  workspaceAccess: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  $queryRaw: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: {
    enqueueTicketCreate: jest.fn(), enqueueFieldSync: jest.fn(), enqueueThreadEntry: jest.fn(),
    reconcileTicket: jest.fn(), getClient: jest.fn(), getInteractiveClient: jest.fn(),
  },
}));
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({ default: { mergedInto: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/scheduledTicketService.js', () => ({ default: {} }));

const { default: ticketService } = await import('../src/services/ticketService.js');

beforeEach(() => {
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 7, defaultTimezone: 'America/Vancouver' });
});

describe('requester filter (QA 10-27 #5)', () => {
  test('one id stays an equality match', async () => {
    const where = await ticketService.buildListWhere(7, { requesterId: '41' });
    expect(where.requesterId).toBe(41);
  });

  test('a comma list becomes an IN over the distinct valid ids', async () => {
    const where = await ticketService.buildListWhere(7, { requesterId: '41,42,41,abc,-3' });
    expect(where.requesterId).toEqual({ in: [41, 42] });
  });

  test('nothing valid → no requester clause', async () => {
    const where = await ticketService.buildListWhere(7, { requesterId: 'x,0' });
    expect(where.requesterId).toBeUndefined();
  });
});

describe('board column statuses inside a segment (QA 10-27 #4)', () => {
  test('a status pick narrows the segment scope to the picked names', async () => {
    const where = await ticketService.buildListWhere(7, { segment: 'unassigned', status: 'Pending', parkedSplit: '1' });
    expect(where.status).toEqual({ in: ['Pending'] });
    expect(where.assignedTechId).toBeNull();
    expect(where.parkedUntil).toBeNull();
  });

  test('a pick outside the segment scope matches nothing', async () => {
    const where = await ticketService.buildListWhere(7, { segment: 'resolved', status: 'Open', parkedSplit: '1' });
    expect(where.status).toEqual({ in: [] });
  });

  test('without a status pick the segment scope is unchanged', async () => {
    const where = await ticketService.buildListWhere(7, { segment: 'open' });
    expect(where.status).toEqual({ in: ['Open', 'Pending'] });
  });

  test('without a segment the status pick is unchanged', async () => {
    const where = await ticketService.buildListWhere(7, { status: 'Pending,Resolved', parkedSplit: '1' });
    expect(where.status).toEqual({ in: ['Pending', 'Resolved'] });
  });
});
