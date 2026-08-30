import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * FR 08-07 item 8 — edit internal notes. Guards (author-or-admin, notes only,
 * never system), edit-history append + editedAt/editedBy stamps, origin-aware
 * re-mirroring (TP-born → thread_entry_update job; FS-born TP-authored note →
 * direct FS updateConversation; no FS id → local only), no ticket.note_added
 * re-fire, and the FR #9 note marker on FS-born note creates.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn() },
  ticketThreadEntry: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
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

const { default: ticketService, TP_NOTE_MARKER } = await import('../src/services/ticketService.js');

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
  fsClientMock.updateConversation.mockResolvedValue({ conversation: { id: 555 } });
});

describe('ticketService.updateNote guards', () => {
  test('the author can edit their own note (case-insensitive email match)', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ ...baseNote, actorEmail: 'TERRY@Example.com' });

    const { entry } = await ticketService.updateNote(501, 1, 9002, { bodyHtml: '<p>new text</p>' }, author);

    expect(prismaMock.ticketThreadEntry.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 9002 },
      data: expect.objectContaining({
        bodyHtml: '<p>new text</p>',
        bodyText: 'new text',
        content: 'new text',
        editedAt: expect.any(Date),
        editedBy: 'terry@example.com',
      }),
    }));
    expect(entry.bodyHtml).toBe('<p>new text</p>');
  });

  test('another non-admin agent is refused', async () => {
    await expect(ticketService.updateNote(501, 1, 9002, { bodyHtml: '<p>hijack</p>' }, otherAgent))
      .rejects.toThrow(/author or an admin/i);
    expect(prismaMock.ticketThreadEntry.update).not.toHaveBeenCalled();
  });

  test('an admin who is not the author can edit', async () => {
    await ticketService.updateNote(501, 1, 9002, { bodyHtml: '<p>admin fix</p>' }, admin);
    expect(prismaMock.ticketThreadEntry.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ editedBy: 'ada@example.com' }),
    }));
  });

  test('system notes are immutable even for admins', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ ...baseNote, authorType: 'system' });
    await expect(ticketService.updateNote(501, 1, 9002, { bodyHtml: '<p>x</p>' }, admin))
      .rejects.toThrow(/system/i);
  });

  test('replies cannot be edited — only internal notes', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ ...baseNote, eventType: 'reply', isPrivate: false });
    await expect(ticketService.updateNote(501, 1, 9002, { bodyHtml: '<p>x</p>' }, author))
      .rejects.toThrow(/internal notes/i);
  });

  test('an empty body is rejected', async () => {
    await expect(ticketService.updateNote(501, 1, 9002, { bodyHtml: '   ' }, author))
      .rejects.toThrow(/body is required/i);
  });
});

describe('ticketService.updateNote history, audit and events', () => {
  test('appends the PRIOR body to rawPayload.editHistory and preserves existing payload keys', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({
      ...baseNote,
      rawPayload: {
        cc_emails: ['keep@example.com'],
        editHistory: [{ bodyHtml: '<p>v1</p>', bodyText: 'v1', editedAt: '2026-08-07T00:00:00.000Z', editedBy: 'terry@example.com' }],
      },
    });

    await ticketService.updateNote(501, 1, 9002, { bodyHtml: '<p>v3</p>' }, author);

    const { data } = prismaMock.ticketThreadEntry.update.mock.calls[0][0];
    expect(data.rawPayload.cc_emails).toEqual(['keep@example.com']);
    expect(data.rawPayload.editHistory).toHaveLength(2);
    expect(data.rawPayload.editHistory[1]).toEqual(expect.objectContaining({
      bodyHtml: '<p>old text</p>',
      bodyText: 'old text',
      editedBy: 'terry@example.com',
      editedAt: expect.any(String),
    }));
  });

  test('audits note.edited, broadcasts the change, and does NOT re-fire ticket.note_added', async () => {
    await ticketService.updateNote(501, 1, 9002, { bodyHtml: '<p>edited</p>' }, author);

    expect(ticketActivityRepositoryMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'note.edited',
      details: expect.objectContaining({ entryId: 9002, preview: 'edited' }),
    }));
    expect(sseBroadcastMock).toHaveBeenCalledWith('ticket-change', expect.objectContaining({
      action: 'note', entryId: 9002, edited: true,
    }), 1);
    expect(emitTicketEventMock).not.toHaveBeenCalled();
  });
});

describe('ticketService.updateNote re-mirroring', () => {
  test('TP-born mirrored note (mirror-<id>) queues a thread_entry_update job — no direct FS call', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({
      ...baseNote, externalEntryId: 'mirror-777', mirrorState: 'mirrored',
    });

    await ticketService.updateNote(501, 1, 9002, { bodyHtml: '<p>edited</p>' }, author);

    expect(mirrorServiceMock.enqueueThreadEntryUpdate).toHaveBeenCalledWith(1, 501, 9002);
    expect(fsClientMock.updateConversation).not.toHaveBeenCalled();
  });

  test('TP-authored note on an FS-BORN ticket (fs-conv-<id>) updates FreshService directly with the note marker', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({
      ...nativeTicket, origin: 'freshservice', freshserviceTicketId: BigInt(9),
    });
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({
      ...baseNote, externalEntryId: 'fs-conv-555', mirrorState: 'mirrored',
    });

    await ticketService.updateNote(501, 1, 9002, { bodyHtml: '<p>edited on fs-born</p>' }, author);

    expect(mirrorServiceMock.getInteractiveClient).toHaveBeenCalledWith(1);
    expect(fsClientMock.updateConversation).toHaveBeenCalledWith(555, {
      body: expect.stringContaining(TP_NOTE_MARKER),
    });
    expect(fsClientMock.updateConversation).toHaveBeenCalledWith(555, {
      body: expect.stringContaining('<p>edited on fs-born</p>'),
    });
    expect(mirrorServiceMock.enqueueThreadEntryUpdate).not.toHaveBeenCalled();
  });

  // Phase DR1/DR5: the canonical `fs-conversation:<id>` stamp the live write
  // now mints resolves exactly like the legacy `fs-conv-<id>` above.
  test('TP-authored note stamped fs-conversation:<id> (canonical) also updates FreshService directly', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({
      ...nativeTicket, origin: 'freshservice', freshserviceTicketId: BigInt(9),
    });
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({
      ...baseNote, externalEntryId: 'fs-conversation:555', mirrorState: 'mirrored',
    });

    await ticketService.updateNote(501, 1, 9002, { bodyHtml: '<p>edited canonical</p>' }, author);

    expect(fsClientMock.updateConversation).toHaveBeenCalledWith(555, {
      body: expect.stringContaining('<p>edited canonical</p>'),
    });
    expect(mirrorServiceMock.enqueueThreadEntryUpdate).not.toHaveBeenCalled();
  });

  test('a note with no FS id edits locally only', async () => {
    await ticketService.updateNote(501, 1, 9002, { bodyHtml: '<p>local only</p>' }, author);
    expect(fsClientMock.updateConversation).not.toHaveBeenCalled();
    expect(mirrorServiceMock.enqueueThreadEntryUpdate).not.toHaveBeenCalled();
    expect(prismaMock.ticketThreadEntry.update).toHaveBeenCalled();
  });

  test('an FS queue timeout on the FS-born path aborts BEFORE the local write (503, nothing changed)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({
      ...nativeTicket, origin: 'freshservice', freshserviceTicketId: BigInt(9),
    });
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ ...baseNote, externalEntryId: 'fs-conv-555' });
    const queueTimeout = new Error('timed out waiting in the rate-limit queue');
    queueTimeout.code = 'FS_QUEUE_TIMEOUT';
    fsClientMock.updateConversation.mockRejectedValue(queueTimeout);

    await expect(ticketService.updateNote(501, 1, 9002, { bodyHtml: '<p>busy</p>' }, author))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(prismaMock.ticketThreadEntry.update).not.toHaveBeenCalled();
  });
});

describe('FS-born note creates carry the TP note marker (FR 08-07 #9)', () => {
  beforeEach(() => {
    prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9001, ...data }));
  });

  test('addPrivateNote on an FS-born ticket prefixes the FS body with the marker; the local entry stays clean', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({
      ...nativeTicket, origin: 'freshservice', freshserviceTicketId: BigInt(9),
    });
    fsClientMock.addNote.mockResolvedValue({ conversation: { id: 42002 } });

    const { entry } = await ticketService.addPrivateNote(501, 1, { bodyText: 'fs-born internal' }, author);

    const [, sentBody] = fsClientMock.addNote.mock.calls[0];
    expect(sentBody.startsWith('<p style=')).toBe(true);
    expect(sentBody).toContain(TP_NOTE_MARKER);
    expect(sentBody).toContain('Terry Tech');
    expect(sentBody).toContain('fs-born internal');
    // Local cache keeps the clean body — the marker is FS-side noise control.
    expect(entry.bodyHtml == null || !entry.bodyHtml.includes(TP_NOTE_MARKER)).toBe(true);
    expect(entry.bodyText).toBe('fs-born internal');
  });

  test('FS-born public replies go unmarked (requester-facing)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({
      ...nativeTicket, origin: 'freshservice', freshserviceTicketId: BigInt(9),
    });
    fsClientMock.createReply.mockResolvedValue({ conversation: { id: 42003 } });

    await ticketService.addReply(501, 1, { bodyText: 'hello requester' }, author);

    const [, replyBody] = fsClientMock.createReply.mock.calls[0];
    expect(replyBody).not.toContain(TP_NOTE_MARKER);
  });
});

describe('migration ↔ model sync (thread_entry_edits)', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  test('schema.prisma maps editedAt/editedBy onto edited_at/edited_by', () => {
    const schema = fs.readFileSync(path.join(repoRoot, 'prisma', 'schema.prisma'), 'utf8');
    const model = schema.slice(schema.indexOf('model TicketThreadEntry'), schema.indexOf('@@map("ticket_thread_entries")'));
    expect(model).toMatch(/editedAt\s+DateTime\?\s+@map\("edited_at"\)/);
    expect(model).toMatch(/editedBy\s+String\?\s+@map\("edited_by"\)\s+@db\.VarChar\(255\)/);
  });

  test('the idempotent migration adds both columns to ticket_thread_entries', () => {
    const sql = fs.readFileSync(
      path.join(repoRoot, 'prisma', 'migrations', '20260808000000_thread_entry_edits', 'migration.sql'),
      'utf8',
    );
    expect(sql).toContain('ALTER TABLE "ticket_thread_entries" ADD COLUMN IF NOT EXISTS "edited_at" TIMESTAMP(3);');
    expect(sql).toContain('ALTER TABLE "ticket_thread_entries" ADD COLUMN IF NOT EXISTS "edited_by" VARCHAR(255);');
  });
});
