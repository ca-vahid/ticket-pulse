import { jest } from '@jest/globals';

/** Ticket tasks (QA 07-16 #3) — origin routing, FS proxy, notification. */

const prismaMock = {
  ticket: { findFirst: jest.fn() },
  ticketTask: {
    findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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

describe('due-time parsing (QA 08-04 #8a)', () => {
  beforeEach(() => {
    prismaMock.ticket.findFirst.mockResolvedValue(TP_TICKET);
    prismaMock.technician.findFirst.mockResolvedValue(null);
  });

  test('legacy date-only payload anchors at 5:00 PM LOCAL (not UTC midnight)', async () => {
    await ticketTaskService.create(1, 1, { title: 'Legacy due', dueAt: '2026-08-10' }, {});
    const { dueAt } = prismaMock.ticketTask.create.mock.calls[0][0].data;
    expect(dueAt.getFullYear()).toBe(2026);
    expect(dueAt.getMonth()).toBe(7);
    expect(dueAt.getDate()).toBe(10); // no west-of-Greenwich date shift
    expect(dueAt.getHours()).toBe(17);
    expect(dueAt.getMinutes()).toBe(0);
  });

  test('full ISO datetime payload is stored as that exact instant', async () => {
    const iso = '2026-08-10T21:30:00.000Z';
    await ticketTaskService.create(1, 1, { title: 'Timed due', dueAt: iso }, {});
    const { dueAt } = prismaMock.ticketTask.create.mock.calls[0][0].data;
    expect(dueAt.toISOString()).toBe(iso);
  });

  test('garbage due input is rejected, empty stays null', async () => {
    await expect(ticketTaskService.create(1, 1, { title: 'Bad', dueAt: 'not-a-date' }, {})).rejects.toThrow(/invalid due date/i);
    await ticketTaskService.create(1, 1, { title: 'No due', dueAt: '' }, {});
    expect(prismaMock.ticketTask.create.mock.calls[0][0].data.dueAt).toBeNull();
  });
});

describe('notify-before reminders (QA 08-04 #8b)', () => {
  const REMINDER_TASK = {
    id: 100, origin: 'ticketpulse', status: 'open', title: 'Renew cert',
    description: null, dueAt: new Date(Date.now() + 10 * 60000),
    remindBeforeMinutes: 15, reminderSentAt: null,
    assignedTech: { id: 10, name: 'Alice', email: 'alice@x.io' },
    ticket: { id: 1, workspaceId: 1, origin: 'ticketpulse', subject: 'TP ticket', nativeNumber: 42, freshserviceTicketId: null },
  };

  test('create stores remindBeforeMinutes with a due date, rejects off-preset values', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(TP_TICKET);
    prismaMock.technician.findFirst.mockResolvedValue(null);
    await ticketTaskService.create(1, 1, { title: 'Remind me', dueAt: '2026-08-10T21:00:00.000Z', remindBeforeMinutes: 30 }, {});
    expect(prismaMock.ticketTask.create.mock.calls[0][0].data.remindBeforeMinutes).toBe(30);
    await expect(ticketTaskService.create(1, 1, { title: 'Bad', dueAt: '2026-08-10T21:00:00.000Z', remindBeforeMinutes: 7 }, {}))
      .rejects.toThrow(/notify-before/i);
  });

  test('create ignores a reminder without a due date (nothing to remind about)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(TP_TICKET);
    prismaMock.technician.findFirst.mockResolvedValue(null);
    await ticketTaskService.create(1, 1, { title: 'No due', remindBeforeMinutes: 30 }, {});
    expect(prismaMock.ticketTask.create.mock.calls[0][0].data.remindBeforeMinutes).toBeNull();
  });

  test('PATCHing dueAt re-arms the reminder (reminderSentAt cleared)', async () => {
    prismaMock.ticketTask.findFirst.mockResolvedValue({ id: 100, ticketId: 1, status: 'open', fsTaskId: null, assignedTechId: null });
    prismaMock.ticket.findFirst.mockResolvedValue(TP_TICKET);
    await ticketTaskService.update(100, 1, { dueAt: '2026-08-12T21:00:00.000Z' }, {});
    const { data } = prismaMock.ticketTask.update.mock.calls[0][0];
    expect(data.reminderSentAt).toBeNull();
  });

  test('PATCHing remindBeforeMinutes re-arms too; unrelated patches do not', async () => {
    prismaMock.ticketTask.findFirst.mockResolvedValue({ id: 100, ticketId: 1, status: 'open', fsTaskId: null, assignedTechId: null });
    prismaMock.ticket.findFirst.mockResolvedValue(TP_TICKET);
    await ticketTaskService.update(100, 1, { remindBeforeMinutes: 60 }, {});
    expect(prismaMock.ticketTask.update.mock.calls[0][0].data).toMatchObject({ remindBeforeMinutes: 60, reminderSentAt: null });

    jest.clearAllMocks();
    prismaMock.ticketTask.findFirst.mockResolvedValue({ id: 100, ticketId: 1, status: 'open', fsTaskId: null, assignedTechId: null });
    prismaMock.ticket.findFirst.mockResolvedValue(TP_TICKET);
    await ticketTaskService.update(100, 1, { title: 'Renamed' }, {});
    expect(prismaMock.ticketTask.update.mock.calls[0][0].data).not.toHaveProperty('reminderSentAt');
  });

  test('sendDueReminder emails the assignee and stamps reminderSentAt (race-safe)', async () => {
    const ok = await ticketTaskService.sendDueReminder(REMINDER_TASK);
    expect(ok).toBe(true);
    expect(emailMock.sendTransactionalEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'alice@x.io',
      label: 'task due reminder',
      subject: expect.stringContaining('Task due soon on TP-42'),
    }));
    expect(prismaMock.ticketTask.updateMany).toHaveBeenCalledWith({
      where: { id: 100, reminderSentAt: null },
      data: { reminderSentAt: expect.any(Date) },
    });
  });

  test('sendDueReminder refuses FS-origin, done, already-stamped, and unassigned rows', async () => {
    expect(await ticketTaskService.sendDueReminder({ ...REMINDER_TASK, origin: 'freshservice' })).toBe(false);
    expect(await ticketTaskService.sendDueReminder({ ...REMINDER_TASK, status: 'done' })).toBe(false);
    expect(await ticketTaskService.sendDueReminder({ ...REMINDER_TASK, reminderSentAt: new Date() })).toBe(false);
    expect(await ticketTaskService.sendDueReminder({ ...REMINDER_TASK, assignedTech: null })).toBe(false);
    expect(emailMock.sendTransactionalEmail).not.toHaveBeenCalled();
  });

  test('a failed send leaves reminderSentAt clear for retry', async () => {
    emailMock.sendTransactionalEmail.mockResolvedValueOnce({ sent: false, reason: 'outage' });
    expect(await ticketTaskService.sendDueReminder(REMINDER_TASK)).toBe(false);
    expect(prismaMock.ticketTask.updateMany).not.toHaveBeenCalled();
  });

  test('FS-born create forwards the reminder to FreshService as notify_before seconds', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(FS_TICKET);
    prismaMock.technician.findFirst.mockResolvedValue(AGENT_FS);
    await ticketTaskService.create(3, 1, { title: 'FS remind', assignedTechId: 10, dueAt: '2026-08-10T21:00:00.000Z', remindBeforeMinutes: 30 }, {});
    expect(fsClientMock.createTicketTask).toHaveBeenCalledWith(233398, expect.objectContaining({ notify_before: 1800 }));
  });

  test('TP-born mirror write-back does NOT forward notify_before (TP owns that reminder)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(TP_MIRRORED);
    prismaMock.technician.findFirst.mockResolvedValue(AGENT_FS);
    await ticketTaskService.create(2, 1, { title: 'Mirror remind', assignedTechId: 10, dueAt: '2026-08-10T21:00:00.000Z', remindBeforeMinutes: 30 }, {});
    const payload = fsClientMock.createTicketTask.mock.calls[0][1];
    expect(payload).not.toHaveProperty('notify_before');
  });
});

describe('a task with nobody named belongs to the ticket owner (Simorgh B7, 19 Sep 2026)', () => {
  const OWNER = { id: 7, name: 'Anton Kuzmychev', email: 'akuzmychev@x.io' };
  const OWNED = { ...TP_TICKET, assignedTechId: 7, assignedTech: OWNER };

  test('no assignee → the ticket owner is e-mailed, as the owner', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(OWNED);
    prismaMock.ticketTask.findFirst.mockResolvedValue(null);
    await ticketTaskService.create(1, 1, { title: 'Isolate LAPTOP-4471' }, { email: 'apikey:tpc_890e', name: 'Simorgh', role: 'api' });
    expect(emailMock.sendTransactionalEmail).toHaveBeenCalledTimes(1);
    const mail = emailMock.sendTransactionalEmail.mock.calls[0][0];
    expect(mail.to).toBe('akuzmychev@x.io');
    expect(mail.html).toMatch(/A task was added to your ticket .*TP-42/);
    expect(mail.html).toMatch(/yours as the ticket owner/);
  });

  test('no assignee and no owner → nobody to tell, task still created', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...TP_TICKET, assignedTechId: null, assignedTech: null });
    prismaMock.ticketTask.findFirst.mockResolvedValue(null);
    const task = await ticketTaskService.create(1, 1, { title: 'Orphan' }, { email: 'c@x.io' });
    expect(task.title).toBe('Orphan');
    expect(emailMock.sendTransactionalEmail).not.toHaveBeenCalled();
  });

  test('a named assignee is still the one e-mailed, not the owner', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(OWNED);
    prismaMock.technician.findFirst.mockResolvedValue(AGENT_FS);
    prismaMock.ticketTask.findFirst.mockResolvedValue(null);
    await ticketTaskService.create(1, 1, { title: 'Named', assignedTechId: 10 }, { email: 'c@x.io' });
    expect(emailMock.sendTransactionalEmail.mock.calls[0][0].to).toBe('alice@x.io');
  });

  test('the due reminder falls back to the ticket owner', async () => {
    const row = { id: 5, title: 'Reset password', status: 'open', origin: 'ticketpulse', dueAt: new Date(Date.now() + 10 * 60000), remindBeforeMinutes: 15, reminderSentAt: null, assignedTech: null, ticket: { ...TP_TICKET, assignedTech: OWNER } };
    expect(await ticketTaskService.sendDueReminder(row)).toBe(true);
    expect(emailMock.sendTransactionalEmail.mock.calls[0][0].to).toBe('akuzmychev@x.io');
  });

  test('…and stays silent when the task has no assignee and the ticket no owner', async () => {
    const row = { id: 5, title: 'x', status: 'open', origin: 'ticketpulse', dueAt: new Date(), remindBeforeMinutes: 15, reminderSentAt: null, assignedTech: null, ticket: { ...TP_TICKET, assignedTech: null } };
    expect(await ticketTaskService.sendDueReminder(row)).toBe(false);
  });

  test('a new owner is told about the open unassigned tasks, in one e-mail', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(OWNED);
    prismaMock.ticketTask.findMany.mockResolvedValue([
      { id: 1, title: 'Isolate LAPTOP-4471', dueAt: new Date('2026-09-19T21:00:00Z'), status: 'open' },
      { id: 2, title: 'Revoke sessions', dueAt: null, status: 'in_progress' },
    ]);
    expect(await ticketTaskService.notifyOwnerOfOpenTasks(1, 1, OWNER)).toBe(true);
    const mail = emailMock.sendTransactionalEmail.mock.calls[0][0];
    expect(mail.subject).toBe('TP-42: 2 open tasks are now yours');
    expect(mail.html).toMatch(/Isolate LAPTOP-4471/);
    expect(mail.html).toMatch(/Revoke sessions/);
    expect(prismaMock.ticketTask.findMany.mock.calls[0][0].where).toMatchObject({ status: { not: 'done' }, assignedTechId: null });
  });

  test('no open unassigned tasks → no handover e-mail', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(OWNED);
    prismaMock.ticketTask.findMany.mockResolvedValue([]);
    expect(await ticketTaskService.notifyOwnerOfOpenTasks(1, 1, OWNER)).toBe(false);
    expect(emailMock.sendTransactionalEmail).not.toHaveBeenCalled();
  });
});

describe('externalRef — create-or-return (Simorgh B4)', () => {
  test('a repeat with the same externalRef returns the existing task and creates nothing', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(TP_TICKET);
    prismaMock.ticketTask.findFirst.mockResolvedValue({ id: 77, title: 'Isolate', status: 'open', externalRef: 'simorgh:action:9f2c', assignedTech: null });
    const task = await ticketTaskService.create(1, 1, { title: 'Isolate (retry)', externalRef: 'simorgh:action:9f2c' }, { email: 'c@x.io' });
    expect(task).toMatchObject({ id: 77, existing: true, externalRef: 'simorgh:action:9f2c' });
    expect(prismaMock.ticketTask.create).not.toHaveBeenCalled();
    expect(prismaMock.ticketTask.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { ticketId: 1, workspaceId: 1, externalRef: 'simorgh:action:9f2c' } }));
  });

  test('a new externalRef is stored on the task', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(TP_TICKET);
    prismaMock.ticketTask.findFirst.mockResolvedValue(null);
    await ticketTaskService.create(1, 1, { title: 'Isolate', externalRef: '  simorgh:action:9f2c ' }, { email: 'c@x.io' });
    expect(prismaMock.ticketTask.create.mock.calls[0][0].data.externalRef).toBe('simorgh:action:9f2c');
  });

  test('no externalRef → no lookup, plain create', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(TP_TICKET);
    await ticketTaskService.create(1, 1, { title: 'Plain' }, { email: 'c@x.io' });
    expect(prismaMock.ticketTask.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.ticketTask.create.mock.calls[0][0].data.externalRef).toBeNull();
  });
});

