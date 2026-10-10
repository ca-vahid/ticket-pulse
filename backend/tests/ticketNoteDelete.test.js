import { jest } from '@jest/globals';

/**
 * QA 10-09 item 6 — "Allow regular users to delete their own notes".
 * deleteNote was admin-only. Now: the note's author (matched on the entry's
 * actor e-mail) or an admin. Everything else about deletion is unchanged —
 * Ticket Pulse tickets only, internal notes only, never system notes — and
 * someone else's note is a 403, not a 400.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn() },
  ticketThreadEntry: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), delete: jest.fn() },
  technician: { findFirst: jest.fn() },
  ticketAssignmentEpisode: { create: jest.fn(), updateMany: jest.fn() },
  ticketTypeDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  notificationDelivery: { create: jest.fn() },
  $queryRaw: jest.fn(),
};
const attachmentServiceMock = { removeForThreadEntry: jest.fn().mockResolvedValue({ removed: 0 }), isConfigured: jest.fn(() => false) };
const ticketActivityRepositoryMock = { create: jest.fn().mockResolvedValue({}) };
const emitTicketEventMock = jest.fn().mockResolvedValue({ status: 'completed' });
const lifecycleMock = {
  emitTicketLifecycleNotifications: jest.fn().mockResolvedValue({ status: 'completed' }),
  emitTicketEvent: emitTicketEventMock,
};
const sendgridMock = { sendEmail: jest.fn() };
const sseBroadcastMock = jest.fn();
const fsClientMock = {
  createReply: jest.fn(),
  addNote: jest.fn(),
  updateConversation: jest.fn(),
};
const mirrorServiceMock = {
  enqueueTicketCreate: jest.fn().mockResolvedValue({ id: 1 }),
  enqueueFieldSync: jest.fn().mockResolvedValue({ id: 2 }),
  enqueueThreadEntry: jest.fn().mockResolvedValue({ id: 3 }),
  enqueueThreadEntryUpdate: jest.fn().mockResolvedValue({ id: 4 }),
  enqueueThreadEntryDelete: jest.fn().mockResolvedValue({ id: 5 }),
  getClient: jest.fn().mockResolvedValue(fsClientMock),
  getInteractiveClient: jest.fn().mockResolvedValue(fsClientMock),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: ticketActivityRepositoryMock }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: sendgridMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: sseBroadcastMock },
}));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({
  default: { runPipeline: jest.fn() },
}));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({
  default: { getUserProfile: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorServiceMock }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: attachmentServiceMock }));

const { default: ticketService } = await import('../src/services/ticketService.js');

const author = { email: 'terry@example.com', name: 'Terry Tech', role: 'viewer', workspaceRole: 'member', technicianId: 7, kind: 'member' };
const otherAgent = { email: 'olga@example.com', name: 'Olga Other', role: 'viewer', workspaceRole: 'member', technicianId: 8, kind: 'member' };
const admin = { email: 'ada@example.com', name: 'Ada Admin', role: 'admin', workspaceRole: 'admin', technicianId: null, kind: 'admin' };

const nativeTicket = {
  id: 501,
  workspaceId: 1,
  origin: 'ticketpulse',
  nativeNumber: 1042,
  freshserviceTicketId: null,
  subject: 'Projector flickers',
  status: 'Open',
  priority: 2,
  assignedTechId: null,
  requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
  assignedTech: null,
  internalCategory: null,
  internalSubcategory: null,
};

const baseNote = {
  id: 9002,
  ticketId: 501,
  workspaceId: 1,
  externalEntryId: null,
  source: 'ticketpulse_user',
  eventType: 'note',
  actorName: 'Terry Tech',
  actorEmail: 'terry@example.com',
  authorType: 'agent',
  isPrivate: true,
  visibility: 'private',
  content: 'old text',
  bodyHtml: '<p>old text</p>',
  bodyText: 'old text',
  rawPayload: null,
  mirrorState: 'pending',
};

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket });
  prismaMock.ticket.update.mockResolvedValue({ ...nativeTicket });
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ ...baseNote });
  prismaMock.ticketThreadEntry.update.mockImplementation(({ data }) => Promise.resolve({ ...baseNote, ...data }));
  prismaMock.ticketThreadEntry.delete.mockResolvedValue({ id: 9002 });
});

const fsTicket = { ...nativeTicket, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 240001n };
const readOnly = { email: 'rita@example.com', name: 'Rita Readonly', role: 'viewer', workspaceRole: 'readonly', technicianId: null, kind: 'member' };
// A technician with no workspace role (the plain "agent" seat).
const plainAgent = { email: 'terry@example.com', name: 'Terry Tech', role: 'viewer', workspaceRole: null, technicianId: 7, kind: 'agent' };

const del = (actor, entryId = 9002) => ticketService.deleteNote(501, 1, entryId, actor);
const expectNothingDeleted = () => {
  expect(prismaMock.ticketThreadEntry.delete).not.toHaveBeenCalled();
  expect(attachmentServiceMock.removeForThreadEntry).not.toHaveBeenCalled();
  expect(mirrorServiceMock.enqueueThreadEntryDelete).not.toHaveBeenCalled();
};

describe('ticketService.deleteNote — who may delete', () => {
  test('the author deletes their own note (e-mail match is case-insensitive)', async () => {
    const out = await del({ ...author, email: 'Terry@Example.com' });

    expect(out).toEqual({ deleted: true, entryId: 9002 });
    expect(attachmentServiceMock.removeForThreadEntry).toHaveBeenCalledWith(9002, 1);
    expect(prismaMock.ticketThreadEntry.delete).toHaveBeenCalledWith({ where: { id: 9002 } });
    const audit = ticketActivityRepositoryMock.create.mock.calls.map(([row]) => row).find((row) => row.activityType === 'note.deleted');
    expect(audit.details).toMatchObject({ entryId: 9002, byAuthor: true, actorEmail: 'Terry@Example.com' });
  });

  test('a technician with no workspace role deletes their own note too', async () => {
    await expect(del(plainAgent)).resolves.toEqual({ deleted: true, entryId: 9002 });
  });

  test('someone else\u2019s note is refused with a 403 and nothing is deleted', async () => {
    await expect(del(otherAgent)).rejects.toMatchObject({ statusCode: 403, code: 'not_note_author' });
    expectNothingDeleted();
  });

  test('an admin still deletes anyone\u2019s note', async () => {
    await expect(del(admin)).resolves.toEqual({ deleted: true, entryId: 9002 });
    const audit = ticketActivityRepositoryMock.create.mock.calls.map(([row]) => row).find((row) => row.activityType === 'note.deleted');
    expect(audit.details.byAuthor).toBe(false);
  });

  test('a workspace admin (not a super admin) deletes anyone\u2019s note', async () => {
    await expect(del({ ...otherAgent, workspaceRole: 'admin' })).resolves.toEqual({ deleted: true, entryId: 9002 });
  });

  test('a note with no author e-mail (synced or automated) is nobody\u2019s own', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ ...baseNote, actorEmail: null, actorFreshserviceId: 77n });
    await expect(del({ ...author, email: null })).rejects.toMatchObject({ statusCode: 403 });
    await expect(del(author)).rejects.toMatchObject({ statusCode: 403 });
    expectNothingDeleted();
    await expect(del(admin)).resolves.toMatchObject({ deleted: true });
  });

  test('the read-only role is refused even for a note carrying its own e-mail', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ ...baseNote, actorEmail: readOnly.email });
    await expect(del(readOnly)).rejects.toMatchObject({ statusCode: 403, code: 'read_only' });
    expectNothingDeleted();
  });
});

describe('ticketService.deleteNote — what can be deleted is unchanged', () => {
  test('FreshService-born tickets: nobody deletes notes here, author or admin', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsTicket });
    await expect(del(author)).rejects.toThrow('Notes can only be deleted on Ticket Pulse tickets');
    await expect(del(admin)).rejects.toThrow('Notes can only be deleted on Ticket Pulse tickets');
    expectNothingDeleted();
  });

  test.each(['reply', 'forward', 'customer_reply', 'private_note'])('a %s is not a deletable note, even for its author', async (eventType) => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ ...baseNote, eventType });
    await expect(del(author)).rejects.toThrow('Only internal notes can be deleted');
    await expect(del(admin)).rejects.toThrow('Only internal notes can be deleted');
    expectNothingDeleted();
  });

  test('system and approval notes stay, even for an admin', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ ...baseNote, authorType: 'system' });
    await expect(del(admin)).rejects.toThrow('System and approval notes cannot be deleted');
    expectNothingDeleted();
  });

  test('a note on another ticket or workspace is not found', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
    await expect(del(author)).rejects.toThrow('Note not found on this ticket');
    expect(prismaMock.ticketThreadEntry.findFirst.mock.calls[0][0].where).toEqual({ id: 9002, ticketId: 501, workspaceId: 1 });
  });

  test('the author\u2019s delete of a mirrored note also queues the FreshService copy for deletion', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ ...baseNote, externalEntryId: 'mirror-555' });
    await del(author);
    expect(mirrorServiceMock.enqueueThreadEntryDelete).toHaveBeenCalledWith(1, 501, '555');
  });
});
