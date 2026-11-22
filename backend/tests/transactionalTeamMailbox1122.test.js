import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * 22 Nov 2026: a workflow e-mail about a ticket leaves from the ticket's team
 * mailbox in a workspace with one mailbox per team (Accounting: AP and AR) —
 * the same pick agent replies use since 4.3.91. Only the address changes; the
 * From name rules stay. Invented addresses on example.com only.
 */
const AP = { id: 1, workspaceId: 2, address: 'ap@example.com', isPrimary: true, isEnabled: true, mode: 'both', defaultGroupId: 1001n, defaultInternalGroupId: null };
const AR = { id: 2, workspaceId: 2, address: 'ar@example.com', isPrimary: false, isEnabled: true, mode: 'both', defaultGroupId: 1002n, defaultInternalGroupId: 77 };
const SOLO = { id: 3, workspaceId: 3, address: 'it@example.com', isPrimary: true, isEnabled: true, mode: 'both', defaultGroupId: 2001n, defaultInternalGroupId: null };
let rows = [AP, AR, SOLO];

const matches = (where) => (r) => r.workspaceId === where.workspaceId && r.isEnabled && (!where.mode || where.mode.in.includes(r.mode));
const ordered = (list) => [...list].sort((a, b) => (Number(b.isPrimary) - Number(a.isPrimary)) || (a.id - b.id));
const prismaMock = {
  mailboxConnection: {
    findFirst: jest.fn(async ({ where }) => ordered(rows.filter(matches(where)))[0] || null),
    findMany: jest.fn(async ({ where }) => ordered(rows.filter(matches(where)))),
  },
  ticketThreadEntry: { findMany: jest.fn(async () => []), update: jest.fn(async () => ({})) },
};
const sendMailAsMailbox = jest.fn(async () => ({ internetMessageId: '<g@example.com>' }));
const isConfigured = jest.fn(() => true);
const sendgridSend = jest.fn(async () => ({ provider: 'sendgrid', messageId: '<tp-1@example.com>' }));
const resolveFromName = jest.fn(async () => 'Accounting');

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/workspaceEmailIdentityService.js', () => ({ resolveFromName, default: { resolveFromName } }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: { isConfigured, sendMailAsMailbox } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: sendgridSend }, sendEmail: sendgridSend }));
jest.unstable_mockModule('../src/services/emailHealthService.js', () => ({ default: { recordSuccess: jest.fn(async () => {}), recordFailure: jest.fn(async () => {}) } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { getSendGridConfig: jest.fn(async () => ({ fromEmail: 'ticketpulse@example.com' })), get: jest.fn(async () => null) },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { deliverTransactionalEmail, plannedSenderAddress } = await import('../src/services/transactionalEmailService.js');

const arTicket = { workspaceId: 2, groupId: 1002n, internalGroupId: null };
const apTicket = { workspaceId: 2, groupId: 1001n, internalGroupId: null };
const threadTicket = { id: 501, workspaceId: 2, origin: 'ticketpulse', nativeNumber: 1042, freshserviceTicketId: null };
const send = (over = {}) => deliverTransactionalEmail({
  workspaceId: 2, to: 'priya.nair@example.com', subject: 'We received your request', html: '<p>Thanks</p>', label: 'workflow', ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  rows = [AP, AR, SOLO];
  isConfigured.mockReturnValue(true);
});

describe('Graph lane', () => {
  test('an AR-group ticket in a two-mailbox workspace leaves from the AR mailbox (Reply-To too)', async () => {
    const result = await send({ mailboxTicket: arTicket, ticket: threadTicket });
    expect(sendMailAsMailbox).toHaveBeenCalledWith('ar@example.com', expect.objectContaining({
      fromName: 'Accounting', replyTo: 'ar+tp1042@example.com',
    }));
    expect(result.from).toBe('ar@example.com');
  });

  test('an internal-group ticket matches by the mailbox internal group', async () => {
    await send({ mailboxTicket: { workspaceId: 2, groupId: null, internalGroupId: 77 } });
    expect(sendMailAsMailbox).toHaveBeenCalledWith('ar@example.com', expect.anything());
  });

  test('an AP ticket, a ticket of no team, and no ticket at all: the primary, as before', async () => {
    await send({ mailboxTicket: apTicket });
    expect(sendMailAsMailbox).toHaveBeenLastCalledWith('ap@example.com', expect.anything());
    await send({ mailboxTicket: { workspaceId: 2, groupId: 9999n, internalGroupId: null } });
    expect(sendMailAsMailbox).toHaveBeenLastCalledWith('ap@example.com', expect.anything());
    prismaMock.mailboxConnection.findMany.mockClear();
    await send();
    expect(sendMailAsMailbox).toHaveBeenLastCalledWith('ap@example.com', expect.anything());
    // No ticket: the old single pick, not the team lookup.
    expect(prismaMock.mailboxConnection.findMany).not.toHaveBeenCalled();
  });

  test('a single-mailbox workspace is unchanged whatever the group', async () => {
    await send({ workspaceId: 3, mailboxTicket: { workspaceId: 3, groupId: 1002n, internalGroupId: null } });
    expect(sendMailAsMailbox).toHaveBeenLastCalledWith('it@example.com', expect.anything());
  });

  test('a ticket from another workspace never picks that workspace mailbox', async () => {
    await send({ workspaceId: 3, mailboxTicket: arTicket });
    expect(sendMailAsMailbox).toHaveBeenLastCalledWith('it@example.com', expect.anything());
  });

  test('a failed team lookup falls back to the primary', async () => {
    prismaMock.mailboxConnection.findMany.mockRejectedValueOnce(new Error('db down'));
    await send({ mailboxTicket: arTicket });
    expect(sendMailAsMailbox).toHaveBeenLastCalledWith('ap@example.com', expect.anything());
  });
});

describe('SendGrid lane', () => {
  beforeEach(() => isConfigured.mockReturnValue(false));

  test('an AR ticket leaves from the AR address with the AR Reply-To; the name is the same', async () => {
    const result = await send({ mailboxTicket: arTicket, ticket: threadTicket });
    expect(sendgridSend).toHaveBeenCalledWith(expect.objectContaining({
      from: 'ar@example.com', replyTo: 'ar+tp1042@example.com', fromName: 'Accounting',
    }));
    expect(result.from).toBe('ar@example.com');
  });

  test('an AP ticket and no ticket: the primary address, as before', async () => {
    await send({ mailboxTicket: apTicket, ticket: threadTicket });
    expect(sendgridSend).toHaveBeenLastCalledWith(expect.objectContaining({ from: 'ap@example.com', replyTo: 'ap+tp1042@example.com' }));
    await send();
    expect(sendgridSend).toHaveBeenLastCalledWith(expect.objectContaining({ from: 'ap@example.com', replyTo: null }));
  });

  test('a from address pinned on the step still wins', async () => {
    await send({ mailboxTicket: arTicket, from: 'billing@example.com' });
    expect(sendgridSend).toHaveBeenLastCalledWith(expect.objectContaining({ from: 'billing@example.com' }));
  });

  test('an agent-facing e-mail (no threading ticket) gets the team address but no Reply-To', async () => {
    await send({ mailboxTicket: arTicket });
    expect(sendgridSend).toHaveBeenLastCalledWith(expect.objectContaining({ from: 'ar@example.com', replyTo: null }));
  });
});

describe('plannedSenderAddress (what Preview and Shadow show)', () => {
  test('names the team mailbox on Graph', async () => {
    await expect(plannedSenderAddress({ workspaceId: 2, mailboxTicket: arTicket })).resolves.toEqual({ address: 'ar@example.com', via: 'msgraph' });
    await expect(plannedSenderAddress({ workspaceId: 2, mailboxTicket: apTicket })).resolves.toEqual({ address: 'ap@example.com', via: 'msgraph' });
    await expect(plannedSenderAddress({ workspaceId: 2 })).resolves.toEqual({ address: 'ap@example.com', via: 'msgraph' });
  });

  test('on SendGrid: a pinned from, else the team mailbox, else the global sender', async () => {
    isConfigured.mockReturnValue(false);
    await expect(plannedSenderAddress({ workspaceId: 2, mailboxTicket: arTicket, from: 'billing@example.com' })).resolves.toEqual({ address: 'billing@example.com', via: 'sendgrid' });
    await expect(plannedSenderAddress({ workspaceId: 2, mailboxTicket: arTicket })).resolves.toEqual({ address: 'ar@example.com', via: 'sendgrid' });
    rows = [];
    await expect(plannedSenderAddress({ workspaceId: 2, mailboxTicket: arTicket })).resolves.toEqual({ address: 'ticketpulse@example.com', via: 'sendgrid' });
  });

  test('never throws', async () => {
    prismaMock.mailboxConnection.findFirst.mockRejectedValueOnce(new Error('db down'));
    await expect(plannedSenderAddress({ workspaceId: 2 })).resolves.toBeNull();
  });
});
