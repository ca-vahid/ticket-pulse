import { jest } from '@jest/globals';

/** Ticket tasks (QA 07-16 #3) — origin routing, FS proxy, notification. */

const prismaMock = {
  ticket: { findFirst: jest.fn() },
  ticketTask: {
    findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(),
    delete: jest.fn(), deleteMany: jest.fn(), aggregate: jest.fn().mockResolvedValue({ _max: { sortOrder: 0 } }),
  },
  technician: { findFirst: jest.fn(), findUnique: jest.fn() },
};
const fsClientMock = {
  createTicketTask: jest.fn().mockResolvedValue({ id: 555 }),
  updateTicketTask: jest.fn().mockResolvedValue({}),
  deleteTicketTask: jest.fn().mockResolvedValue({}),
  listTicketTasks: jest.fn().mockResolvedValue([]),
};
const mirrorMock = { getInteractiveClient: jest.fn().mockResolvedValue(fsClientMock) };
const emailMock = { sendTransactionalEmail: jest.fn().mockResolvedValue({ sent: true }) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorMock }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ sendTransactionalEmail: emailMock.sendTransactionalEmail, default: emailMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: ticketTaskService } = await import('../src/services/ticketTaskService.js');

const TP_TICKET = { id: 1, workspaceId: 1, origin: 'ticketpulse', freshserviceTicketId: null, nativeNumber: 42, subject: 'TP ticket' };
const TP_MIRRORED = { id: 2, workspaceId: 1, origin: 'ticketpulse', freshserviceTicketId: 9000n, nativeNumber: 43, subject: 'Mirrored' };
const FS_TICKET = { id: 3, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: 233398n, nativeNumber: null, subject: 'FS ticket' };
const AGENT_FS = { id: 10, name: 'Alice', email: 'alice@x.io', freshserviceId: 7001n };
const AGENT_LOCAL = { id: 11, name: 'Bob (local)', email: 'bob@x.io', freshserviceId: null };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketTask.aggregate.mockResolvedValue({ _max: { sortOrder: 0 } });
  fsClientMock.createTicketTask.mockResolvedValue({ id: 555 });
  mirrorMock.getInteractiveClient.mockResolvedValue(fsClientMock);
  // create returns the row with the assignedTech relation echoed for shape().
  // A `select` on update returns the FULL row, so track the last row and merge
  // the patch onto it (matching Prisma behavior).
  let lastRow = null;
  prismaMock.ticketTask.create.mockImplementation(({ data }) => {
    lastRow = { id: 100, ...data, assignedTech: data.assignedTechId === 10 ? AGENT_FS : (data.assignedTechId === 11 ? AGENT_LOCAL : null) };
    return Promise.resolve(lastRow);
  });
  prismaMock.ticketTask.update.mockImplementation(({ data }) => {
    lastRow = { ...(lastRow || { id: 100 }), ...data };
    return Promise.resolve(lastRow);
  });
});

describe('ticketTaskService.create', () => {
  test('TP-born unmirrored ticket: task stays local, assignee emailed, no FS call', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(TP_TICKET);
    prismaMock.technician.findFirst.mockResolvedValue(AGENT_FS);
    const task = await ticketTaskService.create(1, 1, { title: 'Do the thing', assignedTechId: 10 }, { email: 'c@x.io', name: 'Coord' });
    expect(task.title).toBe('Do the thing');
    expect(fsClientMock.createTicketTask).not.toHaveBeenCalled();
    expect(emailMock.sendTransactionalEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'alice@x.io' }));
  });

  test('TP-born MIRRORED ticket with FS agent: writes the task back to FreshService', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(TP_MIRRORED);
    prismaMock.technician.findFirst.mockResolvedValue(AGENT_FS);
    await ticketTaskService.create(2, 1, { title: 'Mirror me', assignedTechId: 10 }, { email: 'c@x.io' });
    expect(fsClientMock.createTicketTask).toHaveBeenCalledWith(9000, expect.objectContaining({ title: 'Mirror me', agent_id: 7001, status: 1 }));
  });

  test('TP-born MIRRORED ticket with LOCAL agent: task stays TP-only (no FS write)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(TP_MIRRORED);
    prismaMock.technician.findFirst.mockResolvedValue(AGENT_LOCAL);
    await ticketTaskService.create(2, 1, { title: 'Local only', assignedTechId: 11 }, { email: 'c@x.io' });
    expect(fsClientMock.createTicketTask).not.toHaveBeenCalled();
  });

  test('FS-born ticket: task is created in FreshService (which notifies), not emailed by us', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(FS_TICKET);
    prismaMock.technician.findFirst.mockResolvedValue(AGENT_FS);
    const task = await ticketTaskService.create(3, 1, { title: 'FS task', assignedTechId: 10 }, { email: 'c@x.io' });
    expect(fsClientMock.createTicketTask).toHaveBeenCalledWith(233398, expect.objectContaining({ title: 'FS task', agent_id: 7001 }));
    expect(task.fsTaskId).toBe('555');
    expect(emailMock.sendTransactionalEmail).not.toHaveBeenCalled();
  });

  test('rejects an empty title', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(TP_TICKET);
    await expect(ticketTaskService.create(1, 1, { title: '   ' }, {})).rejects.toThrow(/title is required/i);
  });
});
