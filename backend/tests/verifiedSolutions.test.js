import { jest } from '@jest/globals';

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  group: { findFirst: jest.fn(), findMany: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  ticketAssignmentEpisode: { create: jest.fn(), updateMany: jest.fn() },
  ticketThreadEntry: { create: jest.fn() },
  notificationDelivery: { create: jest.fn() },
  ticketActivity: { findMany: jest.fn() },
  // Per-workspace type registry (ticket-types plan): IT-style vocabulary.
  ticketTypeDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Incident', aliases: ['incident', 'issue'], isActive: true, aiAssignable: true, isDefault: true, fsTypeValue: 'Incident', sortOrder: 0 },
      { id: 2, workspaceId: 1, name: 'Service Request', aliases: ['service request', 'sr'], isActive: true, aiAssignable: true, isDefault: false, fsTypeValue: 'Service Request', sortOrder: 1 },
    ]),
  },
  // Per-workspace status registry (Phase 8a): canonical 4 by default;
  // custom-status tests override + invalidate the statusService cache.
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', color: 'blue', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', color: 'amber', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', color: 'emerald', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', color: 'slate', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  slaPolicy: { findFirst: jest.fn() },
  assignmentPipelineRun: { findFirst: jest.fn() },
  // Per-user email signatures (Phase D): default = no signature row.
  userEmailSignature: { findUnique: jest.fn() },
  $queryRaw: jest.fn(),
};
const noiseRuleServiceMock = { evaluate: jest.fn() };
const ticketActivityRepositoryMock = { create: jest.fn() };
const ticketThreadRepositoryMock = { listForTicket: jest.fn() };
const lifecycleMock = { emitTicketLifecycleNotifications: jest.fn(), emitTicketEvent: jest.fn().mockResolvedValue({ status: 'completed' }) };
const requesterRepositoryMock = { findByEmail: jest.fn(), createNative: jest.fn() };
const sendgridMock = { sendEmail: jest.fn() };
const sseBroadcastMock = jest.fn();
const runPipelineMock = jest.fn();
const fsClientMock = {
  createReply: jest.fn(),
  addNote: jest.fn(),
  updateTicketFields: jest.fn(),
  getTicket: jest.fn(),
  fetchRequester: jest.fn(),
};
const mirrorServiceMock = {
  enqueueTicketCreate: jest.fn().mockResolvedValue({ id: 1 }),
  enqueueFieldSync: jest.fn().mockResolvedValue({ id: 2 }),
  enqueueThreadEntry: jest.fn().mockResolvedValue({ id: 3 }),
  getClient: jest.fn().mockResolvedValue(fsClientMock),
  getInteractiveClient: jest.fn().mockResolvedValue(fsClientMock),
  resolveDepartmentId: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: noiseRuleServiceMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: ticketActivityRepositoryMock }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: ticketThreadRepositoryMock }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: requesterRepositoryMock }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: sendgridMock }));
// Graph mailbox lane (Phase MB-1): off by default so the legacy SendGrid
// assertions hold; individual tests arm isConfigured + a mailbox connection.
const graphMailClientMock = { isConfigured: jest.fn(() => false), sendMailAsMailbox: jest.fn() };
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: graphMailClientMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: sseBroadcastMock },
}));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({
  default: { runPipeline: runPipelineMock },
}));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({
  default: { getUserProfile: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: mirrorServiceMock,
}));
// Attachment storage (Phase CC attachment tests): "configured", accepts any
// upload, returns a stored row so the reply path can build mailable copies.
const attachmentServiceMock = {
  isConfigured: jest.fn(() => true),
  validateUpload: jest.fn(),
  upload: jest.fn(async ({ fileName, contentType }) => ({ id: 77, fileName, contentType })),
  ingestForFsTicket: jest.fn(async () => ({ ingested: 0 })),
};
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({
  default: attachmentServiceMock,
  MAX_ATTACHMENT_BYTES: 100 * 1024 * 1024,
  MAX_ATTACHMENTS_PER_TICKET: 20,
}));

const { default: ticketService } = await import('../src/services/ticketService.js');

/**
 * Verified solutions (QA 09-22 #6): mark / unmark on any ticket, and the
 * "in this category" suggestions with the most specific match first.
 */
const actor = { email: 'coord@example.com', name: 'Cora Coordinator', role: 'viewer', technicianId: null, kind: 'member' };
const closedFsTicket = {
  id: 501, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: BigInt(243614), nativeNumber: null, status: 'Closed',
  resolutionNote: 'Reseated the fibre patch and cleared the port errors', solutionNote: null, solutionVerifiedAt: null, solutionVerifiedBy: null,
  internalCategoryId: 7, internalSubcategoryId: 70, category: 'Network',
};

describe('ticketService.setSolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticket.findFirst.mockResolvedValue({ ...closedFsTicket });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...closedFsTicket, ...data, requester: null, assignedTech: null }));
    ticketActivityRepositoryMock.create.mockResolvedValue({});
  });

  test('marks a closed FS-born ticket, defaults the note to the resolution note, audits and broadcasts', async () => {
    const out = await ticketService.setSolution(501, 1, { verified: true, note: '' }, actor);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { solutionVerifiedAt: expect.any(Date), solutionVerifiedBy: 'Cora Coordinator', solutionNote: 'Reseated the fibre patch and cleared the port errors' },
    }));
    expect(ticketActivityRepositoryMock.create).toHaveBeenCalledWith(expect.objectContaining({ activityType: 'solution_verified' }));
    expect(sseBroadcastMock).toHaveBeenCalled();
    expect(out.displayRef).toBe('#243614');
  });

  test('a typed note wins over the resolution note; unmarking clears everything', async () => {
    await ticketService.setSolution(501, 1, { verified: true, note: '  Port 12 was flapping — replaced the SFP  ' }, actor);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ solutionNote: 'Port 12 was flapping — replaced the SFP' }),
    }));
    await ticketService.setSolution(501, 1, { verified: false }, actor);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { solutionVerifiedAt: null, solutionVerifiedBy: null, solutionNote: null },
    }));
    expect(ticketActivityRepositoryMock.create).toHaveBeenLastCalledWith(expect.objectContaining({ activityType: 'solution_cleared' }));
  });
});

describe('ticketService.solutionSuggestions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 501, internalCategoryId: 7, internalSubcategoryId: 70, category: 'Network' });
  });

  test('subcategory matches first, then the category; the ticket itself and earlier hits are excluded', async () => {
    prismaMock.ticket.findMany
      .mockResolvedValueOnce([{ id: 600, origin: 'freshservice', freshserviceTicketId: BigInt(240001), nativeNumber: null, subject: 'Switch port errors', solutionNote: 'SFP', solutionVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 601, origin: 'ticketpulse', freshserviceTicketId: null, nativeNumber: 1200, subject: 'VLAN mismatch', solutionNote: 'Trunk', solutionVerifiedAt: new Date() }])
      .mockResolvedValue([]);
    const out = await ticketService.solutionSuggestions(501, 1);
    expect(out.scope).toBe('subcategory');
    expect(out.items.map((i) => [i.displayRef, i.matchedOn])).toEqual([['#240001', 'subcategory'], ['TP-1200', 'category']]);
    const [first, second] = prismaMock.ticket.findMany.mock.calls.map((c) => c[0].where);
    expect(first).toEqual(expect.objectContaining({ workspaceId: 1, internalSubcategoryId: 70, solutionVerifiedAt: { not: null }, id: { notIn: [501] } }));
    expect(second.id.notIn).toEqual([501, 600]);
    expect(second.internalCategoryId).toBe(7);
  });

  test('a ticket with no category at all gets an empty answer, not an error', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 502, internalCategoryId: null, internalSubcategoryId: null, category: null });
    const out = await ticketService.solutionSuggestions(502, 1);
    expect(out).toEqual({ items: [], scope: null, hasCategory: false });
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });
});
