import { jest } from '@jest/globals';

// 24 Nov 2026 — "Everyone on the original e-mail", the ticketService side:
//  - the people an agent took off a reply's Cc are kept with the reply
//    (rawPayload.cc_removed), so later workflow mail leaves them off;
//  - a mail-in ticket's To/Cc go on the row at creation, because the
//    "Ticket arrived" workflows run inside createTicket.
// Invented names and example.com only.

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  group: { findFirst: jest.fn(), findMany: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  ticketAssignmentEpisode: { create: jest.fn(), updateMany: jest.fn() },
  ticketThreadEntry: { create: jest.fn() },
  notificationDelivery: { create: jest.fn() },
  ticketTypeDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Incident', aliases: [], isActive: true, aiAssignable: true, isDefault: true, fsTypeValue: 'Incident', sortOrder: 0 },
    ]),
  },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
      { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
    ]),
  },
  slaPolicy: { findFirst: jest.fn() },
  assignmentPipelineRun: { findFirst: jest.fn() },
  $queryRaw: jest.fn(),
};
const ticketActivityRepositoryMock = { create: jest.fn() };
const requesterRepositoryMock = { findByEmail: jest.fn(), createNative: jest.fn() };
const noiseRuleServiceMock = { evaluate: jest.fn() };
const lifecycleMock = { emitTicketLifecycleNotifications: jest.fn() };
const sendgridMock = { sendEmail: jest.fn() };
const fsClientMock = { createReply: jest.fn(), addNote: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: noiseRuleServiceMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: ticketActivityRepositoryMock }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: requesterRepositoryMock }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: sendgridMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
const mirrorEnqueueCreate = jest.fn().mockResolvedValue({ id: 1 });
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: {
    enqueueTicketCreate: mirrorEnqueueCreate,
    enqueueFieldSync: jest.fn().mockResolvedValue({ id: 2 }),
    enqueueThreadEntry: jest.fn().mockResolvedValue({ id: 3 }),
    getClient: jest.fn().mockResolvedValue(fsClientMock),
    getInteractiveClient: jest.fn().mockResolvedValue(fsClientMock),
  },
}));

const { default: ticketService } = await import('../src/services/ticketService.js');

const actor = { email: 'eli.park@example.com', name: 'Eli Park', role: 'viewer', technicianId: null, kind: 'member' };
const nativeTicket = {
  id: 501,
  workspaceId: 1,
  origin: 'ticketpulse',
  nativeNumber: 1042,
  freshserviceTicketId: null,
  subject: 'Shared drive access',
  status: 'Open',
  priority: 3,
  createdAt: new Date('2026-11-24T10:00:00Z'),
  assignedTechId: null,
  firstPublicAgentReplyAt: null,
  ccEmails: ['priya.nair@example.com', 'lead@example.com'],
  requester: { id: 40, name: 'Dana Fox', email: 'dana.fox@example.com' },
  assignedTech: null,
  internalCategory: null,
  internalSubcategory: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket });
  prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...nativeTicket, ...data }));
  prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9001, ...data }));
  prismaMock.notificationDelivery.create.mockResolvedValue({});
  ticketActivityRepositoryMock.create.mockResolvedValue({});
  sendgridMock.sendEmail.mockResolvedValue({ provider: 'sendgrid', providerMessageId: 'sg-1' });
});

test('a reply that takes someone off the Cc keeps that removal with the reply', async () => {
  await ticketService.addReply(501, 1, { bodyText: 'On it', cc: ['lead@example.com'], ccRemoved: ['Priya.Nair@example.com'] }, actor);
  const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
  expect(data.rawPayload).toEqual({
    to_emails: ['dana.fox@example.com'],
    cc_emails: ['lead@example.com'],
    cc_removed: ['priya.nair@example.com'],
  });
});

test('an ordinary reply carries no cc_removed key', async () => {
  await ticketService.addReply(501, 1, { bodyText: 'On it' }, actor);
  const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
  expect(data.rawPayload).not.toHaveProperty('cc_removed');
});

describe('createTicket: a mail-in ticket carries its To/Cc from the first write', () => {
  beforeEach(() => {
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, name: 'IT', isActive: true, nativeTicketingEnabled: true });
    requesterRepositoryMock.findByEmail.mockResolvedValue({ id: 40, name: 'Dana Fox', email: 'dana.fox@example.com', department: 'Finance', freshserviceId: null });
    noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: false, ruleId: null });
    prismaMock.$queryRaw.mockResolvedValue([{ nextval: 1042 }]);
    prismaMock.ticket.create.mockImplementation(({ data }) => Promise.resolve({
      id: 501, ...data, requester: { id: 40, name: 'Dana Fox', email: 'dana.fox@example.com' }, assignedTech: null, internalCategory: null, internalSubcategory: null,
    }));
    lifecycleMock.emitTicketLifecycleNotifications.mockResolvedValue({ status: 'completed' });
  });

  test('mailRecipients land on the created row, before ticket.created fires', async () => {
    await ticketService.createTicket(1, { subject: 'Shared drive access', requesterEmail: 'dana.fox@example.com' }, actor, {
      mailRecipients: { toEmails: ['IT@example.com', 'priya.nair@example.com', 'priya.nair@example.com'], ccEmails: ['lead@example.com'] },
    });
    const { data } = prismaMock.ticket.create.mock.calls[0][0];
    expect(data.toEmails).toEqual(['it@example.com', 'priya.nair@example.com']);
    expect(data.ccEmails).toEqual(['lead@example.com']);
    // The lifecycle (and so the "Ticket arrived" workflows) runs after the row exists.
    expect(prismaMock.ticket.create.mock.invocationCallOrder[0])
      .toBeLessThan(lifecycleMock.emitTicketLifecycleNotifications.mock.invocationCallOrder[0]);
    // The FreshService copy is told to leave the mail-in Cc off its create.
    expect(mirrorEnqueueCreate).toHaveBeenCalledWith(expect.objectContaining({ id: 501 }), { mailCcEmails: ['lead@example.com'] });
  });

  test('Cc typed by a person (not from the e-mail) goes to the copy as before', async () => {
    await ticketService.createTicket(1, { subject: 'Shared drive access', requesterEmail: 'dana.fox@example.com', ccEmails: ['lead@example.com'] }, actor, {
      mailRecipients: { toEmails: ['priya.nair@example.com'], ccEmails: ['other@example.com'] },
    });
    expect(mirrorEnqueueCreate).toHaveBeenCalledWith(expect.objectContaining({ id: 501 }));
    expect(mirrorEnqueueCreate.mock.calls[0]).toHaveLength(1);
  });

  test('without mailRecipients nothing changes (app, API, Teams)', async () => {
    await ticketService.createTicket(1, { subject: 'Shared drive access', requesterEmail: 'dana.fox@example.com', ccEmails: ['lead@example.com'] }, actor);
    const { data } = prismaMock.ticket.create.mock.calls[0][0];
    expect(data.toEmails).toBeUndefined();
    expect(data.ccEmails).toEqual(['lead@example.com']);
  });

  test('mailRecipients is never read from the request body', async () => {
    await ticketService.createTicket(1, {
      subject: 'Shared drive access', requesterEmail: 'dana.fox@example.com', mailRecipients: { toEmails: ['sneaky@example.com'] },
    }, actor);
    const { data } = prismaMock.ticket.create.mock.calls[0][0];
    expect(data.toEmails).toBeUndefined();
  });
});

test('internal notes never record a removal', async () => {
  await ticketService.addPrivateNote(501, 1, { bodyText: 'context', ccRemoved: ['priya.nair@example.com'] }, actor);
  const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
  expect(data.rawPayload).toBeUndefined();
});
