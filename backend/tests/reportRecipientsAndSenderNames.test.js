import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const prismaMock = { workspaceAccess: { findMany: jest.fn() } };
const settingsMock = { get: jest.fn() };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));

const { reportRecipients, superAdminEmails } = await import('../src/services/reportRecipients.js');
const { systemSenderName, SYSTEM_SENDER_NAMES } = await import('../src/services/transactionalEmailService.js');

describe('reportRecipients', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ADMIN_EMAILS;
  });

  it('is the workspace admins plus every super admin, without duplicates', async () => {
    prismaMock.workspaceAccess.findMany.mockResolvedValue([{ email: 'Admin.One@example.com' }, { email: 'boss@example.com' }]);
    settingsMock.get.mockResolvedValue('boss@example.com, qa@example.com');
    expect(await reportRecipients(1)).toEqual(['admin.one@example.com', 'boss@example.com', 'qa@example.com']);
    expect(prismaMock.workspaceAccess.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 1, role: 'admin' } }));
  });

  it('falls back to the ADMIN_EMAILS list when the setting is empty', async () => {
    settingsMock.get.mockResolvedValue('');
    process.env.ADMIN_EMAILS = 'one@example.com,two@example.com';
    expect(await superAdminEmails()).toEqual(['one@example.com', 'two@example.com']);
  });

  it('still reaches the super admins when the workspace has no admins or the lookup fails', async () => {
    prismaMock.workspaceAccess.findMany.mockRejectedValue(new Error('pool timeout'));
    settingsMock.get.mockResolvedValue('boss@example.com');
    expect(await reportRecipients(3)).toEqual(['boss@example.com']);
  });
});

describe('systemSenderName', () => {
  it('names approval e-mails "Ticket Pulse Approval"', () => {
    for (const label of ['approval', 'approval decision', 'approval hand-off', 'approval clarification', 'approval answer']) {
      expect(systemSenderName(label)).toBe(SYSTEM_SENDER_NAMES.approval);
    }
    expect(SYSTEM_SENDER_NAMES.approval).toBe('Ticket Pulse Approval');
  });

  it('names reports, alerts and staff notices', () => {
    expect(systemSenderName('noise-close-digest')).toBe('Ticket Pulse Reports');
    expect(systemSenderName('urgent-response-digest')).toBe('Ticket Pulse Reports');
    expect(systemSenderName('mailbox-hold-digest')).toBe('Ticket Pulse Reports');
    expect(systemSenderName('sync-health-alert')).toBe('Ticket Pulse Alerts');
    expect(systemSenderName('park wake')).toBe('Ticket Pulse Notifications');
    expect(systemSenderName('auto-help handover')).toBe('Ticket Pulse Notifications');
  });

  it('leaves requester-facing and unknown e-mails to the workspace sender name', () => {
    for (const label of ['workflow', 'assignment', 'requester_reply_copy', 'reply', 'email', '', null]) {
      expect(systemSenderName(label)).toBeNull();
    }
  });
});
