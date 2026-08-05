import { jest } from '@jest/globals';

const prismaMock = {
  mirrorJob: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  ticket: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  ticketThreadEntry: { findUnique: jest.fn(), update: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  requester: { update: jest.fn() },
};
const clientMock = {
  createTicket: jest.fn(),
  updateTicket: jest.fn(),
  addNote: jest.fn(),
  fetchTicketSafe: jest.fn(),
  fetchTicketConversations: jest.fn(),
  listCustomObjects: jest.fn(),
  listCustomObjectRecords: jest.fn(),
};
const settingsMock = {
  getFreshServiceConfigForWorkspace: jest.fn().mockResolvedValue({ domain: 'demo', apiKey: 'key' }),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({
  default: { buffersForThreadEntry: jest.fn().mockResolvedValue([]) },
}));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn().mockResolvedValue({}) } }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: jest.fn(() => clientMock),
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
const emitTicketEventMock = jest.fn().mockResolvedValue({ status: 'completed' });
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: emitTicketEventMock },
  emitTicketEvent: emitTicketEventMock,
}));

const { default: mirrorService } = await import('../src/services/mirrorService.js');

const baseTicket = {
  id: 501,
  workspaceId: 1,
  origin: 'ticketpulse',
  nativeNumber: 1042,
  freshserviceTicketId: null,
  subject: 'Projector flickers',
  description: '<p>flickers</p>',
  descriptionText: 'flickers',
  status: 'Open',
  priority: 3,
  groupId: null,
  createdAt: new Date(),
  workspace: {
    id: 1,
    freshserviceWorkspaceId: BigInt(10),
    tpSkillCustomField: 'lf_ticket_pulse_category',
    tpSubskillCustomField: 'lf_ticket_pulse_subcategory',
  },
  requester: { id: 40, email: 'rita@example.com', freshserviceId: null },
  assignedTech: null,
  internalCategory: { name: 'Devices & Hardware' },
  internalSubcategory: { name: 'Peripherals' },
};

beforeEach(() => {
  jest.clearAllMocks();
  // The dev .env disables the mirror; the outbox worker itself is what we're
  // exercising here, so force-enable it for the drain path.
  process.env.NATIVE_TICKET_MIRROR_ENABLED = 'true';
  mirrorService._clients.clear();
  settingsMock.getFreshServiceConfigForWorkspace.mockResolvedValue({ domain: 'demo', apiKey: 'key' });
  prismaMock.mirrorJob.update.mockResolvedValue({});
  prismaMock.mirrorJob.updateMany.mockResolvedValue({ count: 1 }); // claim succeeds by default
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.requester.update.mockResolvedValue({});
  clientMock.addNote.mockResolvedValue({ conversation: { id: 777 } });
  // TP skill/subskill lookup fields resolve NAMES → FS custom-object record
  // display ids (sending the name makes FreshService store "none").
  clientMock.listCustomObjects.mockResolvedValue([
    { id: 1, title: 'Ticket Pulse Skills' },
    { id: 2, title: 'Ticket Pulse Subskills' },
  ]);
  clientMock.listCustomObjectRecords.mockImplementation((objectId) => {
    if (objectId === 1) return Promise.resolve([{ data: { name: 'Devices & Hardware', bo_display_id: 6001 } }]);
    if (objectId === 2) return Promise.resolve([{ data: { name: 'Peripherals', bo_display_id: 6002 } }]);
    return Promise.resolve([]);
  });
});

describe('mirrorService job processing', () => {
  test('create_ticket pushes the full snapshot, saves the FS id, backfills the requester', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ ...baseTicket });
    clientMock.createTicket.mockResolvedValue({ id: 90001, requester_id: 555001 });
    clientMock.updateTicket.mockResolvedValue({ id: 90001 });

    const ok = await mirrorService._processJob({ id: 1, ticketId: 501, workspaceId: 1, kind: 'create_ticket', attempts: 0 });

    expect(ok).toBe(true);
    // Create WITHOUT the TP category custom fields — FreshService rejects those
    // lookup fields on create; they're set via a follow-up update below.
    expect(clientMock.createTicket).toHaveBeenCalledWith(expect.objectContaining({
      email: 'rita@example.com',
      subject: 'Projector flickers',
      status: 2,
      priority: 3,
      workspace_id: 10,
    }));
    expect(clientMock.createTicket).toHaveBeenCalledWith(expect.not.objectContaining({
      custom_fields: expect.anything(),
    }));
    // The follow-up update carries the RESOLVED custom-object record ids, not names.
    expect(clientMock.updateTicket).toHaveBeenCalledWith(90001, {
      custom_fields: {
        lf_ticket_pulse_category: 6001,
        lf_ticket_pulse_subcategory: 6002,
      },
    });
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 501 },
      data: expect.objectContaining({
        freshserviceTicketId: BigInt(90001),
        mirrorState: 'mirrored',
      }),
    }));
    expect(prismaMock.requester.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 40 },
      data: { freshserviceId: BigInt(555001) },
    }));
    // Intro note marks the FS copy as a mirror
    expect(clientMock.addNote).toHaveBeenCalledWith(90001, expect.stringContaining('TP-1042'), { isPrivate: true });
  });

  test('update_fields before the FS copy exists fails and reschedules (ordering preserved)', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ ...baseTicket, freshserviceTicketId: null });

    const ok = await mirrorService._processJob({ id: 2, ticketId: 501, workspaceId: 1, kind: 'update_fields', attempts: 0 });

    expect(ok).toBe(false);
    expect(clientMock.updateTicket).not.toHaveBeenCalled();
    expect(prismaMock.mirrorJob.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed', attempts: 1 }),
    }));
  });

  test('update_fields maps status labels to FS codes and clears responder when unassigned', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({
      ...baseTicket, freshserviceTicketId: BigInt(90001), status: 'Resolved', assignedTech: null,
    });
    clientMock.updateTicket.mockResolvedValue({ id: 90001 });

    const ok = await mirrorService._processJob({ id: 3, ticketId: 501, workspaceId: 1, kind: 'update_fields', attempts: 0 });

    expect(ok).toBe(true);
    expect(clientMock.updateTicket).toHaveBeenCalledWith(90001, expect.objectContaining({
      status: 4,
      responder_id: null,
    }));
  });

  test('public replies mirror as PUBLIC notes (no requester email), internal notes as private', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ ...baseTicket, freshserviceTicketId: BigInt(90001) });
    prismaMock.ticketThreadEntry.findUnique.mockResolvedValue({
      id: 9001, isPrivate: false, actorName: 'Cora', bodyHtml: '<p>on it</p>', mirrorState: 'pending',
    });
    prismaMock.ticketThreadEntry.update.mockResolvedValue({});

    await mirrorService._processJob({ id: 4, ticketId: 501, workspaceId: 1, kind: 'thread_entry', threadEntryId: 9001, attempts: 0 });
    expect(clientMock.addNote).toHaveBeenCalledWith(90001, expect.stringContaining('on it'), { isPrivate: false, attachments: [] });

    prismaMock.ticketThreadEntry.findUnique.mockResolvedValue({
      id: 9002, isPrivate: true, actorName: 'Cora', bodyText: 'internal', mirrorState: 'pending',
    });
    await mirrorService._processJob({ id: 5, ticketId: 501, workspaceId: 1, kind: 'thread_entry', threadEntryId: 9002, attempts: 0 });
    expect(clientMock.addNote).toHaveBeenLastCalledWith(90001, expect.stringContaining('internal'), { isPrivate: true, attachments: [] });
  });

  test('dead-letters after max attempts and flags the ticket mirrorState=error', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ ...baseTicket });
    clientMock.createTicket.mockRejectedValue(new Error('FS is down'));

    const ok = await mirrorService._processJob({ id: 6, ticketId: 501, workspaceId: 1, kind: 'create_ticket', attempts: 7 });

    expect(ok).toBe(false);
    expect(prismaMock.mirrorJob.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'dead' }),
    }));
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ mirrorState: 'error' }),
    }));
  });

  test('a job whose claim is lost (another drain took it) is skipped without executing', async () => {
    prismaMock.mirrorJob.updateMany.mockResolvedValue({ count: 0 }); // competing drain claimed first
    prismaMock.ticket.findUnique.mockResolvedValue({ ...baseTicket });

    const ok = await mirrorService._processJob({ id: 7, ticketId: 501, workspaceId: 1, kind: 'create_ticket', attempts: 0 });

    expect(ok).toBe(false);
    expect(clientMock.createTicket).not.toHaveBeenCalled(); // no duplicate FS ticket
    expect(prismaMock.mirrorJob.update).not.toHaveBeenCalled(); // job left to its owner
  });

  test('drain keeps per-ticket ordering: a failed job blocks later jobs for that ticket only', async () => {
    prismaMock.mirrorJob.findMany.mockResolvedValue([
      { id: 10, ticketId: 501, workspaceId: 1, kind: 'update_fields', attempts: 0 }, // fails (no FS id)
      { id: 11, ticketId: 501, workspaceId: 1, kind: 'thread_entry', threadEntryId: 1, attempts: 0 }, // must be skipped
      { id: 12, ticketId: 502, workspaceId: 1, kind: 'update_fields', attempts: 0 }, // other ticket proceeds
    ]);
    prismaMock.ticket.findUnique
      .mockResolvedValueOnce({ ...baseTicket, id: 501, freshserviceTicketId: null })
      .mockResolvedValueOnce({ ...baseTicket, id: 502, freshserviceTicketId: BigInt(90002) });
    clientMock.updateTicket.mockResolvedValue({});

    const result = await mirrorService.drain();

    expect(result.processed).toBe(2); // job 11 skipped
    expect(clientMock.updateTicket).toHaveBeenCalledTimes(1);
    expect(clientMock.updateTicket).toHaveBeenCalledWith(90002, expect.any(Object));
  });

  test('enqueueFieldSync dedupes pending jobs per ticket', async () => {
    prismaMock.mirrorJob.findFirst.mockResolvedValue({ id: 99 });
    const job = await mirrorService.enqueueFieldSync(1, 501);
    expect(job).toEqual({ id: 99 });
    expect(prismaMock.mirrorJob.create).not.toHaveBeenCalled();
  });
});

describe('mirrorService.reconcile', () => {
  test('imports FS-side conversation entries, skips mirror-authored notes, flags drift', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([{
      ...baseTicket,
      freshserviceTicketId: BigInt(90001),
      status: 'Open',
      assignedTech: null,
    }]);
    clientMock.fetchTicketSafe.mockResolvedValue({ id: 90001, status: 4, responder_id: 12345 });
    clientMock.fetchTicketConversations.mockResolvedValue([
      { id: 1, body: '<p><b>[Ticket Pulse mirror]</b> intro</p>', body_text: '[Ticket Pulse mirror] intro', private: true },
      { id: 2, body: '<p>Requester replied in FS during the outage</p>', body_text: 'Requester replied in FS during the outage', incoming: true, private: false, from_email: 'rita@example.com', created_at: '2026-07-01T10:00:00Z' },
    ]);
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
    prismaMock.ticketThreadEntry.create.mockResolvedValue({ id: 1 });

    const result = await mirrorService.reconcile(1);

    expect(result.imported).toBe(1); // mirror-marker entry skipped
    // The imported requester reply fires the workflow event with a stable
    // per-conversation stamp (QA 07-06 #4).
    await new Promise((r) => setTimeout(r, 10)); // emit rides a dynamic import
    expect(emitTicketEventMock).toHaveBeenCalledWith('ticket.reply_received', 501, expect.objectContaining({
      dedupeStamp: 'fs-conv-2',
      source: 'freshservice_reconciliation',
    }));
    expect(result.conflicts).toBe(1); // status + assignee drift on the FS copy
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        externalEntryId: 'fs-conv-2',
        source: 'freshservice_reconciliation',
        incoming: true,
        authorType: 'requester',
      }),
    }));
  });
});

// Phase 8c: TP custom labels reach FreshService through their BASE status.
describe('mirrorService._fsStatusCode (base-mapped FS codes)', () => {
  const registryRows = [
    { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
    { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
    { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
    { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    { id: 5, workspaceId: 1, name: 'Needs Rework', baseStatus: 'Pending', sortOrder: 4, isSystem: false, isActive: true },
  ];

  afterEach(async () => {
    delete prismaMock.ticketStatusDefinition;
    const { invalidateStatusCache } = await import('../src/services/statusService.js');
    invalidateStatusCache();
  });

  test('canonical labels map directly; custom labels map via their registry base', async () => {
    prismaMock.ticketStatusDefinition = { findMany: jest.fn().mockResolvedValue(registryRows) };
    const { invalidateStatusCache } = await import('../src/services/statusService.js');
    invalidateStatusCache();

    expect(await mirrorService._fsStatusCode({ workspaceId: 1, status: 'Open' })).toBe(2);
    expect(await mirrorService._fsStatusCode({ workspaceId: 1, status: 'Closed' })).toBe(5);
    // "Needs Rework" is Pending-base → FS Pending(3).
    expect(await mirrorService._fsStatusCode({ workspaceId: 1, status: 'Needs Rework' })).toBe(3);
  });

  test('unmappable labels return null (callers omit the field — no silent Open)', async () => {
    expect(await mirrorService._fsStatusCode({ workspaceId: 1, status: 'Deleted' })).toBeNull();
    expect(await mirrorService._fsStatusCode({ workspaceId: 1, status: 'Spam' })).toBeNull();
  });
});
