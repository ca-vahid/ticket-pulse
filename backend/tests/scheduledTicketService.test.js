import { jest } from '@jest/globals';

const prismaMock = {
  scheduledTicket: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
};
const ticketServiceMock = {
  validateCreateInput: jest.fn(),
  createTicket: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));

const { default: scheduledTicketService } = await import('../src/services/scheduledTicketService.js');
const { ValidationError } = await import('../src/utils/errors.js');

describe('scheduledTicketService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('schedule rejects past/near dates before touching the payload', async () => {
    await expect(scheduledTicketService.schedule(
      1,
      { payload: { subject: 'x' }, scheduledForAt: new Date(Date.now() - 1000).toISOString() },
      { email: 'a@b.c' },
    )).rejects.toThrow(/future/);
    expect(ticketServiceMock.validateCreateInput).not.toHaveBeenCalled();
    expect(prismaMock.scheduledTicket.create).not.toHaveBeenCalled();
  });

  test('schedule validates the payload up front and stores it', async () => {
    ticketServiceMock.validateCreateInput.mockResolvedValue({});
    prismaMock.scheduledTicket.create.mockResolvedValue({ id: 7 });
    const when = new Date(Date.now() + 3600_000);

    const row = await scheduledTicketService.schedule(
      1,
      { payload: { subject: 'Printer sweep' }, scheduledForAt: when.toISOString() },
      { email: 'a@b.c', name: 'A' },
    );

    expect(ticketServiceMock.validateCreateInput).toHaveBeenCalledWith(1, { subject: 'Printer sweep' });
    expect(prismaMock.scheduledTicket.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ workspaceId: 1, createdBy: 'a@b.c', createdByName: 'A' }),
    }));
    expect(row.id).toBe(7);
  });

  test('schedule bubbles payload validation errors (fail at schedule time, not 6am)', async () => {
    ticketServiceMock.validateCreateInput.mockRejectedValue(new ValidationError('A requester is required'));
    await expect(scheduledTicketService.schedule(
      1,
      { payload: {}, scheduledForAt: new Date(Date.now() + 3600_000).toISOString() },
      {},
    )).rejects.toThrow(/requester/);
    expect(prismaMock.scheduledTicket.create).not.toHaveBeenCalled();
  });

  test('activate claims atomically and replays through createTicket', async () => {
    prismaMock.scheduledTicket.findFirst.mockResolvedValue({
      id: 9, workspaceId: 1, status: 'pending', payload: { subject: 's' }, createdBy: 'a@b.c', createdByName: 'A',
    });
    prismaMock.scheduledTicket.updateMany.mockResolvedValue({ count: 1 });
    ticketServiceMock.createTicket.mockResolvedValue({ id: 501, displayRef: 'TP-2000' });
    prismaMock.scheduledTicket.update.mockResolvedValue({ id: 9, status: 'activated', ticketId: 501 });

    const result = await scheduledTicketService.activate(9, 1, { email: 'me@b.c', name: 'Me' });

    expect(prismaMock.scheduledTicket.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 9, status: { in: ['pending', 'error'] } },
      data: { status: 'activating' },
    }));
    expect(ticketServiceMock.createTicket).toHaveBeenCalledWith(1, { subject: 's' }, expect.objectContaining({ email: 'me@b.c' }));
    expect(result.ticket.id).toBe(501);
  });

  test('activate refuses a row someone else already claimed', async () => {
    prismaMock.scheduledTicket.findFirst.mockResolvedValue({ id: 9, workspaceId: 1, status: 'pending', payload: {} });
    prismaMock.scheduledTicket.updateMany.mockResolvedValue({ count: 0 });
    await expect(scheduledTicketService.activate(9, 1, {})).rejects.toThrow(/already being activated/);
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
  });

  test('activation failure parks the row in error (no hot retry loop)', async () => {
    prismaMock.scheduledTicket.findFirst.mockResolvedValue({ id: 9, workspaceId: 1, status: 'pending', payload: {} });
    prismaMock.scheduledTicket.updateMany.mockResolvedValue({ count: 1 });
    ticketServiceMock.createTicket.mockRejectedValue(new Error('boom'));
    prismaMock.scheduledTicket.update.mockResolvedValue({});

    await expect(scheduledTicketService.activate(9, 1, {})).rejects.toThrow('boom');
    expect(prismaMock.scheduledTicket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'error' }),
    }));
  });

  test('cancel only allowed from pending/error', async () => {
    prismaMock.scheduledTicket.findFirst.mockResolvedValue({ id: 9, workspaceId: 1, status: 'activated' });
    await expect(scheduledTicketService.cancel(9, 1, {})).rejects.toThrow(/already activated/);
  });
});
