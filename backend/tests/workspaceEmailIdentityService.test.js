import { jest } from '@jest/globals';

const prismaMock = {
  workspaceEmailIdentity: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  mailboxConnection: {
    findFirst: jest.fn(),
  },
};

const settingsRepositoryMock = {
  getSendGridConfig: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: settingsRepositoryMock,
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  resolveFromName,
  resolveReplyFromName,
  getSenderIdentity,
  upsertSenderIdentity,
  clearSenderIdentityCache,
} = await import('../src/services/workspaceEmailIdentityService.js');
const { formatSender } = await import('../src/utils/emailSender.js');

describe('workspaceEmailIdentityService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearSenderIdentityCache();
    settingsRepositoryMock.getSendGridConfig.mockResolvedValue({
      fromEmail: 'ticketpulse@bgcengineering.ca',
      fromName: 'Ticket Pulse',
      smtpFromEmail: null,
    });
    prismaMock.workspaceEmailIdentity.findUnique.mockResolvedValue(null);
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
  });

  describe('resolveFromName', () => {
    test('prefers the workspace override', async () => {
      prismaMock.workspaceEmailIdentity.findUnique.mockResolvedValue({ fromName: 'Ticket Pulse IT' });
      await expect(resolveFromName(1)).resolves.toBe('Ticket Pulse IT');
      expect(prismaMock.workspaceEmailIdentity.findUnique).toHaveBeenCalledWith({
        where: { workspaceId: 1 },
        select: { fromName: true },
      });
    });

    test('inherits the global default when the workspace has no override', async () => {
      settingsRepositoryMock.getSendGridConfig.mockResolvedValue({ fromName: 'Ticket Pulse Global' });
      await expect(resolveFromName(3)).resolves.toBe('Ticket Pulse Global');
    });

    test('resolves the global default for null workspaceId (cross-workspace sends)', async () => {
      await expect(resolveFromName(null)).resolves.toBe('Ticket Pulse');
      expect(prismaMock.workspaceEmailIdentity.findUnique).not.toHaveBeenCalled();
    });

    test('falls back to the hard default when everything fails', async () => {
      prismaMock.workspaceEmailIdentity.findUnique.mockRejectedValue(new Error('db down'));
      await expect(resolveFromName(1)).resolves.toBe('Ticket Pulse');
    });

    test('caches resolutions until the cache is cleared', async () => {
      prismaMock.workspaceEmailIdentity.findUnique.mockResolvedValue({ fromName: 'Ticket Pulse IT' });
      await resolveFromName(1);
      await resolveFromName(1);
      expect(prismaMock.workspaceEmailIdentity.findUnique).toHaveBeenCalledTimes(1);

      clearSenderIdentityCache();
      await resolveFromName(1);
      expect(prismaMock.workspaceEmailIdentity.findUnique).toHaveBeenCalledTimes(2);
    });

    test('sanitizes stored overrides before use', async () => {
      prismaMock.workspaceEmailIdentity.findUnique.mockResolvedValue({ fromName: '  Ticket <Pulse>\nIT  ' });
      await expect(resolveFromName(1)).resolves.toBe('Ticket Pulse IT');
    });
  });

  describe('getSenderIdentity', () => {
    test('returns override, global default, effective name, and addresses', async () => {
      prismaMock.workspaceEmailIdentity.findUnique.mockResolvedValue({
        fromName: 'Ticket Pulse IT',
        updatedBy: 'admin@example.com',
        updatedAt: new Date('2026-08-18T00:00:00Z'),
      });
      prismaMock.mailboxConnection.findFirst.mockResolvedValue({ address: 'ticketpulse@bgcengineering.ca' });

      const identity = await getSenderIdentity(1);
      expect(identity).toEqual(expect.objectContaining({
        workspaceId: 1,
        fromName: 'Ticket Pulse IT',
        globalFromName: 'Ticket Pulse',
        effectiveFromName: 'Ticket Pulse IT',
        fromEmail: 'ticketpulse@bgcengineering.ca',
        mailboxAddress: 'ticketpulse@bgcengineering.ca',
        updatedBy: 'admin@example.com',
      }));
    });

    test('reports inherit state when no override row exists', async () => {
      const identity = await getSenderIdentity(2);
      expect(identity).toEqual(expect.objectContaining({
        fromName: null,
        effectiveFromName: 'Ticket Pulse',
        mailboxAddress: null,
      }));
    });
  });

  describe('upsertSenderIdentity', () => {
    test('stores a sanitized override and busts the cache', async () => {
      prismaMock.workspaceEmailIdentity.upsert.mockResolvedValue({});
      await resolveFromName(1); // warm the cache with the inherited default
      prismaMock.workspaceEmailIdentity.findUnique.mockResolvedValue({ fromName: 'Ticket Pulse IT' });

      await upsertSenderIdentity(1, { fromName: '  Ticket Pulse IT ' }, { email: 'admin@example.com' });

      expect(prismaMock.workspaceEmailIdentity.upsert).toHaveBeenCalledWith({
        where: { workspaceId: 1 },
        update: { fromName: 'Ticket Pulse IT', updatedBy: 'admin@example.com' },
        create: { workspaceId: 1, fromName: 'Ticket Pulse IT', updatedBy: 'admin@example.com' },
      });
      await expect(resolveFromName(1)).resolves.toBe('Ticket Pulse IT');
    });

    test('blank name clears back to inherit', async () => {
      prismaMock.workspaceEmailIdentity.upsert.mockResolvedValue({});
      await upsertSenderIdentity(1, { fromName: '   ' }, null);
      expect(prismaMock.workspaceEmailIdentity.upsert).toHaveBeenCalledWith(expect.objectContaining({
        update: { fromName: null, updatedBy: null },
      }));
    });

    test('rejects a missing workspace id', async () => {
      await expect(upsertSenderIdentity(null, { fromName: 'X' })).rejects.toThrow('workspaceId is required');
    });

    // Phase SN2: toggle-only saves leave the display-name override alone.
    test('a toggle-only patch does not touch fromName', async () => {
      prismaMock.workspaceEmailIdentity.upsert.mockResolvedValue({});
      await upsertSenderIdentity(1, { replyUsesAgentName: false }, { email: 'admin@example.com' });
      expect(prismaMock.workspaceEmailIdentity.upsert).toHaveBeenCalledWith({
        where: { workspaceId: 1 },
        update: { replyUsesAgentName: false, updatedBy: 'admin@example.com' },
        create: { workspaceId: 1, fromName: null, replyUsesAgentName: false, updatedBy: 'admin@example.com' },
      });
    });
  });

  // Mega 08-30 Phase SN1/SN3 — requester replies go out under the agent's name.
  describe('resolveReplyFromName', () => {
    test('returns the sanitized agent name when the toggle is on (default, no row)', async () => {
      await expect(resolveReplyFromName(1, '  Susan Xu ')).resolves.toBe('Susan Xu');
    });

    test('toggle off → the workspace identity', async () => {
      prismaMock.workspaceEmailIdentity.findUnique.mockResolvedValue({ fromName: 'Ticket Pulse IT', replyUsesAgentName: false });
      await expect(resolveReplyFromName(1, 'Susan Xu')).resolves.toBe('Ticket Pulse IT');
    });

    test('null / blank / email-only actor → workspace identity fallback', async () => {
      prismaMock.workspaceEmailIdentity.findUnique.mockResolvedValue({ fromName: 'Ticket Pulse IT', replyUsesAgentName: true });
      await expect(resolveReplyFromName(1, null)).resolves.toBe('Ticket Pulse IT');
      await expect(resolveReplyFromName(1, '   ')).resolves.toBe('Ticket Pulse IT');
      await expect(resolveReplyFromName(1, 'coord@example.com')).resolves.toBe('Ticket Pulse IT');
    });

    test('CRLF / angle brackets in the agent name are stripped before the header', async () => {
      const name = await resolveReplyFromName(1, 'Evil\r\nBcc: x@example.com <spoof>');
      expect(name).toBe('Evil Bcc: x@example.com spoof');
      expect(formatSender({ name, email: 'ticketpulse@bgcengineering.ca' })).toBe('"Evil Bcc: x@example.com spoof" <ticketpulse@bgcengineering.ca>');
    });

    test('a toggle read failure resolves to the default (agent name), never blocks', async () => {
      prismaMock.workspaceEmailIdentity.findUnique.mockRejectedValue(new Error('db down'));
      await expect(resolveReplyFromName(1, 'Susan Xu')).resolves.toBe('Susan Xu');
    });

    test('getSenderIdentity exposes the toggle (default ON without a row)', async () => {
      await expect(getSenderIdentity(1)).resolves.toMatchObject({ replyUsesAgentName: true });
      prismaMock.workspaceEmailIdentity.findUnique.mockResolvedValue({ fromName: null, replyUsesAgentName: false });
      await expect(getSenderIdentity(1)).resolves.toMatchObject({ replyUsesAgentName: false });
    });
  });

  // Approvals / workflows / sync-health keep the workspace identity — only
  // the requester-reply seam in ticketService switches to resolveReplyFromName.
  test('only _emailRequesterReply uses resolveReplyFromName; every other sender keeps resolveFromName', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = (p) => fs.readFileSync(path.resolve('src/services', p), 'utf8');
    for (const file of ['transactionalEmailService.js', 'notificationDeliveryService.js', 'watcherNotificationService.js']) {
      const text = src(file);
      expect(text).toContain('resolveFromName(');
      expect(text).not.toContain('resolveReplyFromName');
    }
    const ticketService = src('ticketService.js');
    expect((ticketService.match(/resolveReplyFromName\(/g) || []).length).toBe(1);
    expect(ticketService).toContain('resolveReplyFromName(ticket.workspaceId, entry.actorName)');
  });
});
