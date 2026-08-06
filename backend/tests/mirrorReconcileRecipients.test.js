import { jest } from '@jest/globals';

// QA 08-05 #3 — Cc visibility: FS conversation objects imported by mirror
// reconciliation carry to_emails/cc_emails; the created thread entries must
// keep them in rawPayload (the same shape the regular FS conversation sync
// stores) so the UI can render per-message recipients.

const prismaMock = {
  ticket: { findFirst: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn(), create: jest.fn() },
  mirrorJob: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn() },
};
const ticketActivityRepositoryMock = { create: jest.fn().mockResolvedValue({}) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { getFreshServiceConfigForWorkspace: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: ticketActivityRepositoryMock }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: jest.fn(),
}));
jest.unstable_mockModule('../src/services/ticketTypeService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { statusNamesForBase: jest.fn().mockResolvedValue(['Open', 'Pending']) },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: {},
  emitTicketEvent: jest.fn().mockResolvedValue(undefined),
}));

const { default: mirrorService } = await import('../src/services/mirrorService.js');

const ticket = {
  id: 501,
  workspaceId: 1,
  origin: 'ticketpulse',
  nativeNumber: 1042,
  freshserviceTicketId: BigInt(231900),
  assignedTech: null,
};

function fsConv(overrides = {}) {
  return {
    id: 88001,
    body: '<p>From FS</p>',
    body_text: 'From FS',
    private: false,
    incoming: false,
    user_name: 'Terry Tech',
    from_email: 'terry@example.com',
    created_at: '2026-08-05T10:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null); // nothing imported yet
  prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9001, ...data }));
});

describe('mirror reconciliation recipient capture', () => {
  test('conversations with to/cc keep them in rawPayload (FS shape)', async () => {
    const client = {
      fetchTicketConversations: jest.fn().mockResolvedValue([
        fsConv({ to_emails: ['rita@example.com'], cc_emails: ['boss@example.com', 'peer@example.com'] }),
      ]),
    };

    const result = await mirrorService._reconcileTicketAgainstFs(ticket, client);

    expect(result.imported).toBe(1);
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        externalEntryId: 'fs-conv-88001',
        source: 'freshservice_reconciliation',
        rawPayload: {
          to_emails: ['rita@example.com'],
          cc_emails: ['boss@example.com', 'peer@example.com'],
        },
      }),
    }));
  });

  test('cc-only conversations store cc_emails without a to_emails key', async () => {
    const client = {
      fetchTicketConversations: jest.fn().mockResolvedValue([
        fsConv({ cc_emails: ['boss@example.com'] }),
      ]),
    };

    await mirrorService._reconcileTicketAgainstFs(ticket, client);

    const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data.rawPayload).toEqual({ cc_emails: ['boss@example.com'] });
  });

  test('conversations without recipients omit rawPayload entirely', async () => {
    const client = {
      fetchTicketConversations: jest.fn().mockResolvedValue([fsConv()]),
    };

    await mirrorService._reconcileTicketAgainstFs(ticket, client);

    const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data.rawPayload).toBeUndefined();
  });

  test('empty arrays are treated as absent (no rawPayload noise)', async () => {
    const client = {
      fetchTicketConversations: jest.fn().mockResolvedValue([
        fsConv({ to_emails: [], cc_emails: [] }),
      ]),
    };

    await mirrorService._reconcileTicketAgainstFs(ticket, client);

    const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data.rawPayload).toBeUndefined();
  });
});
