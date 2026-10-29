import { jest } from '@jest/globals';

/**
 * @mentions in internal notes (29 Oct 2026): who is kept, who is told, the
 * five-minute coalescing, seen-marking, and the Mentions view filter.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  ticketMention: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 7, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 7, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 7, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 7, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  customFieldDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  $queryRaw: jest.fn(),
};
const sendTransactionalEmail = jest.fn();
const sendAgentAlert = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ sendTransactionalEmail }));
jest.unstable_mockModule('../src/services/teamsNotificationService.js', () => ({ default: { sendAgentAlert } }));
jest.unstable_mockModule('../src/services/replyEmailPictures.js', () => ({
  createInlineBudget: () => ({}),
  inlinePictures: async (html) => html,
  inlineAttachments: () => [],
  faceFor: async () => null,
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
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

const {
  default: mentions, parseMentionIds, noteNamesPerson, renderMentionEmail,
} = await import('../src/services/ticketMentionService.js');
const { default: ticketService } = await import('../src/services/ticketService.js');

const ticket = { id: 65146, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 10682, freshserviceTicketId: null, subject: 'Software purchase' };
const entry = { id: 900, occurredAt: new Date('2026-10-28T22:28:35Z') };
const alexey = { technicianId: 4, name: 'Alexey Lavrenyuk', email: 'alexey@example.com' };
const gaby = { id: 20, name: 'Gaby Tonnova', email: 'gaby@example.com' };
const note = 'Hello @Gaby Tonnova, please pay for the subscription.';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, defaultTimezone: 'America/Vancouver' });
  prismaMock.ticketMention.findMany.mockResolvedValue([]);
  prismaMock.ticketMention.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
  prismaMock.ticketMention.update.mockResolvedValue({});
  sendTransactionalEmail.mockResolvedValue({ sent: true });
  sendAgentAlert.mockResolvedValue({ sent: false, reason: 'teams_not_connected' });
});

describe('reading what the composer sent', () => {
  test('arrays, JSON and comma lists all work; junk and repeats are dropped', () => {
    expect(parseMentionIds([20, '20', 'x', -1, 4])).toEqual([20, 4]);
    expect(parseMentionIds('[20,4]')).toEqual([20, 4]);
    expect(parseMentionIds('20, 4')).toEqual([20, 4]);
    expect(parseMentionIds('')).toEqual([]);
    expect(parseMentionIds(null)).toEqual([]);
  });

  test('the @name must still be in the note (full or first name)', () => {
    expect(noteNamesPerson(note, 'Gaby Tonnova')).toBe(true);
    expect(noteNamesPerson('thanks @gaby', 'Gaby Tonnova')).toBe(true);
    expect(noteNamesPerson('Gaby, please pay', 'Gaby Tonnova')).toBe(false);
  });
});

describe('recording a mention', () => {
  test('Gaby is recorded and e-mailed with the note itself and a link', async () => {
    prismaMock.technician.findMany.mockResolvedValue([gaby]);
    const ids = await mentions.recordForNote({ ticket, entry, actor: alexey, ids: [20], bodyText: note, bodyHtml: `<p>${note}</p>` });
    expect(ids).toEqual([20]);
    expect(prismaMock.technician.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: 1, isActive: true }),
    }));
    expect(prismaMock.ticketMention.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ticketId: 65146, threadEntryId: 900, technicianId: 20, mentionedByTechnicianId: 4 }) });
    await flush();
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    const mail = sendTransactionalEmail.mock.calls[0][0];
    expect(mail.to).toEqual(['gaby@example.com']);
    expect(mail.subject).toBe('Alexey mentioned you on TP-10682: Software purchase');
    expect(mail.fromName).toBe('Alexey Lavrenyuk via Ticket Pulse');
    expect(mail.html).toContain('please pay for the subscription');
    expect(mail.html).toContain('Only agents can see it');
    expect(prismaMock.ticketMention.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ notifiedVia: 'email' }) }));
  });

  test('the author, a removed name and someone outside the workspace are never told', async () => {
    // Only Gaby is an active agent of workspace 1; 99 is not returned.
    prismaMock.technician.findMany.mockResolvedValue([gaby, { id: 4, name: 'Alexey Lavrenyuk', email: 'alexey@example.com' }]);
    const ids = await mentions.recordForNote({ ticket, entry, actor: alexey, ids: [4, 20, 99], bodyText: 'Gaby, please pay (no tag left)' });
    expect(ids).toEqual([]);
    expect(prismaMock.technician.findMany.mock.calls[0][0].where.id.in).toEqual([20, 99]);
    expect(prismaMock.ticketMention.create).not.toHaveBeenCalled();
  });

  test('a second mention within five minutes is recorded but not mailed again', async () => {
    prismaMock.technician.findMany.mockResolvedValue([gaby]);
    prismaMock.ticketMention.findMany.mockResolvedValue([{ technicianId: 20 }]);
    const ids = await mentions.recordForNote({ ticket, entry, actor: alexey, ids: [20], bodyText: note });
    expect(ids).toEqual([20]);
    expect(prismaMock.ticketMention.create).toHaveBeenCalledTimes(1);
    await flush();
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  test('Teams is used too when Gaby has a chat with the bot', async () => {
    prismaMock.technician.findMany.mockResolvedValue([gaby]);
    sendAgentAlert.mockResolvedValue({ sent: true, via: 'teams' });
    await mentions.recordForNote({ ticket, entry, actor: alexey, ids: [20], bodyText: note });
    await flush();
    expect(sendAgentAlert).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 1, title: 'Alexey mentioned you on TP-10682' }));
    expect(prismaMock.ticketMention.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ notifiedVia: 'email,teams' }) }));
  });

  test('a database failure never fails the note', async () => {
    prismaMock.technician.findMany.mockRejectedValue(new Error('relation "ticket_mentions" does not exist'));
    await expect(mentions.recordForNote({ ticket, entry, actor: alexey, ids: [20], bodyText: note })).resolves.toEqual([]);
  });
});

describe('seeing a mention', () => {
  test('opening the ticket returns the unseen mentions and marks them seen', async () => {
    const at = new Date('2026-10-28T22:28:35Z');
    prismaMock.ticketMention.findMany.mockResolvedValue([{ id: 5, threadEntryId: 900, mentionedByName: 'Alexey Lavrenyuk', createdAt: at }]);
    await expect(mentions.takeUnseen(65146, 1, 20)).resolves.toEqual([{ entryId: 900, by: 'Alexey Lavrenyuk', at }]);
    expect(prismaMock.ticketMention.updateMany).toHaveBeenCalledWith({ where: { id: { in: [5] } }, data: { seenAt: expect.any(Date) } });
  });

  test('no agent, or nothing unseen, marks nothing', async () => {
    await expect(mentions.takeUnseen(65146, 1, null)).resolves.toEqual([]);
    await expect(mentions.takeUnseen(65146, 1, 20)).resolves.toEqual([]);
    expect(prismaMock.ticketMention.updateMany).not.toHaveBeenCalled();
  });
});

describe('the Mentions view', () => {
  test('lists tickets where this agent was mentioned in the last 30 days', async () => {
    const where = await ticketService.buildListWhere(1, { mentionedTechnicianId: 20 });
    expect(where.mentions.some.technicianId).toBe(20);
    expect(where.mentions.some.createdAt.gte).toBeInstanceOf(Date);
  });

  test('without a signed-in agent it matches nothing', async () => {
    const where = await ticketService.buildListWhere(1, { mentionedTechnicianId: -1 });
    expect(where.mentions.some.technicianId).toBe(-1);
  });

  test('the normal queue has no mentions filter', async () => {
    const where = await ticketService.buildListWhere(1, {});
    expect(where.mentions).toBeUndefined();
  });
});

describe('the e-mail', () => {
  test('says who, where, that it is internal, and links the ticket', () => {
    const html = renderMentionEmail({ authorName: 'Alexey Lavrenyuk', ref: 'TP-10682', subject: 'Software purchase', appUrl: 'https://app.example/tickets/65146', bodyHtml: '<p>hi</p>' });
    expect(html).toContain('Alexey mentioned you in an internal note on TP-10682 (Software purchase)');
    expect(html).toContain('href="https://app.example/tickets/65146"');
  });
});
