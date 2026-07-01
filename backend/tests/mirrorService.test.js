import { jest } from '@jest/globals';

const prismaMock = {
  mirrorJob: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
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
};
const settingsMock = {
  getFreshServiceConfigForWorkspace: jest.fn().mockResolvedValue({ domain: 'demo', apiKey: 'key' }),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: jest.fn(() => clientMock),
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
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
  mirrorService._clients.clear();
  settingsMock.getFreshServiceConfigForWorkspace.mockResolvedValue({ domain: 'demo', apiKey: 'key' });
  prismaMock.mirrorJob.update.mockResolvedValue({});
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.requester.update.mockResolvedValue({});
  clientMock.addNote.mockResolvedValue({ conversation: { id: 777 } });
});

describe('mirrorService job processing', () => {
  test('create_ticket pushes the full snapshot, saves the FS id, backfills the requester', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ ...baseTicket });
    clientMock.createTicket.mockResolvedValue({ id: 90001, requester_id: 555001 });

    const ok = await mirrorService._processJob({ id: 1, ticketId: 501, workspaceId: 1, kind: 'create_ticket', attempts: 0 });

    expect(ok).toBe(true);
    expect(clientMock.createTicket).toHaveBeenCalledWith(expect.objectContaining({
      email: 'rita@example.com',
      subject: 'Projector flickers',
      status: 2,
      priority: 3,
      workspace_id: 10,
      custom_fields: {
        lf_ticket_pulse_category: 'Devices & Hardware',
        lf_ticket_pulse_subcategory: 'Peripherals',
      },
    }));
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
    expect(clientMock.addNote).toHaveBeenCalledWith(90001, expect.stringContaining('on it'), { isPrivate: false });

    prismaMock.ticketThreadEntry.findUnique.mockResolvedValue({
      id: 9002, isPrivate: true, actorName: 'Cora', bodyText: 'internal', mirrorState: 'pending',
    });
    await mirrorService._processJob({ id: 5, ticketId: 501, workspaceId: 1, kind: 'thread_entry', threadEntryId: 9002, attempts: 0 });
    expect(clientMock.addNote).toHaveBeenLastCalledWith(90001, expect.stringContaining('internal'), { isPrivate: true });
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
