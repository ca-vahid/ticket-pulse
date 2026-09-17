import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/** 17 Sep 2026 — the agent's inbox copy of a requester reply (replaces what the it@ group mailbox used to show). */
const prismaMock = {
  technician: { findUnique: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn() },
  workspace: { findUnique: jest.fn(async () => ({ name: 'IT' })) },
};
const settingsMock = { get: jest.fn(async () => null), set: jest.fn(async () => {}) };
const sendMock = jest.fn(async () => ({ sent: true, via: 'sendgrid' }));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ sendTransactionalEmail: sendMock, default: { sendTransactionalEmail: sendMock } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const svc = await import('../src/services/requesterReplyCopyService.js');
const { copyAgentsOnRequesterReply, copyRecipientsFor, parseAddressList, renderRequesterReplyCopyEmail, invalidateRequesterReplyCopyCache } = svc;

const ticket = { id: 44036, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: 241459n, subject: 'Field Email Address/Account', assignedTechId: 56 };
const entry = { id: 3215300, bodyHtml: '<p>Thanks, that works.</p>', bodyText: 'Thanks, that works.' };
const on = async (key) => (key === 'requester_reply_copy_ws1' ? '1' : key === 'requester_reply_copy_extra_ws1' ? 'helpdesk-team@x.io, bad, HelpDesk-Team@x.io' : null);

beforeEach(() => {
  jest.clearAllMocks();
  invalidateRequesterReplyCopyCache();
  settingsMock.get.mockImplementation(async () => null);
  prismaMock.technician.findUnique.mockResolvedValue({ email: 'agent@x.io', name: 'Ada Agent', isActive: true });
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
});

describe('parseAddressList', () => {
  test('dedupes case-insensitively, drops junk, caps at ten', () => {
    expect(parseAddressList('a@x.io, A@x.io; b@x.io junk')).toEqual(['a@x.io', 'b@x.io']);
    expect(parseAddressList(Array.from({ length: 12 }, (_, i) => `u${i}@x.io`).join(','))).toHaveLength(10);
  });
});

describe('copyRecipientsFor', () => {
  test('assigned technician first, never the sender, extras appended', async () => {
    const r = await copyRecipientsFor(ticket, { senderEmail: 'olina@x.io', extra: ['team@x.io', 'olina@x.io'] });
    expect(r.to).toEqual(['agent@x.io', 'team@x.io']);
    expect(r.primary).toEqual({ email: 'agent@x.io', name: 'Ada Agent', why: 'assigned' });
  });

  test('unassigned → the agent who last replied', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ actorEmail: 'Neville@x.io', actorName: 'Neville Vyland' });
    const r = await copyRecipientsFor({ ...ticket, assignedTechId: null }, { extra: [] });
    expect(r.to).toEqual(['neville@x.io']);
    expect(r.primary.why).toBe('last_replier');
  });

  test('inactive assignee and nobody who replied → nobody', async () => {
    prismaMock.technician.findUnique.mockResolvedValue({ email: 'gone@x.io', name: 'Gone', isActive: false });
    const r = await copyRecipientsFor(ticket, { extra: [] });
    expect(r.to).toEqual([]);
  });
});

describe('copyAgentsOnRequesterReply', () => {
  test('off by default: nothing is sent', async () => {
    const r = await copyAgentsOnRequesterReply(ticket, entry, { fromEmail: 'olina@x.io', fromName: 'Olina' });
    expect(r).toEqual({ sent: false, reason: 'off' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  test('on: one mail to the agent + the extra list, subject carries the ref, body carries the reply and the link, Reply-To threads via the ticket', async () => {
    settingsMock.get.mockImplementation(on);
    const r = await copyAgentsOnRequesterReply(ticket, entry, { fromEmail: 'olina@x.io', fromName: 'Olina Meaker' });
    expect(r.sent).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0];
    expect(call.to).toEqual(['agent@x.io', 'helpdesk-team@x.io']);
    expect(call.subject).toBe('Re: Field Email Address/Account [#241459]');
    expect(call.ticket).toBe(ticket);
    expect(call.label).toBe('requester_reply_copy');
    expect(call.html).toContain('Olina Meaker');
    expect(call.html).toContain('Thanks, that works.');
    expect(call.html).toContain('/tickets/44036');
    expect(call.html).toContain('Requester replied');
  });

  test('a send failure never throws', async () => {
    settingsMock.get.mockImplementation(on);
    sendMock.mockRejectedValueOnce(new Error('SendGrid down'));
    const r = await copyAgentsOnRequesterReply(ticket, entry, { fromEmail: 'olina@x.io' });
    expect(r.sent).toBe(false);
    expect(r.error).toMatch(/SendGrid down/);
  });
});

describe('renderRequesterReplyCopyEmail', () => {
  test('escapes user text and flags the last-replier fallback', () => {
    const html = renderRequesterReplyCopyEmail({ workspaceName: 'IT', ticket: { subject: 'x <b>y</b>' }, ref: '#1', appUrl: 'https://app/tickets/1', fromName: 'R <script>', fromEmail: 'r@x.io', bodyText: 'a < b', primary: { why: 'last_replier' } });
    expect(html).toContain('x &lt;b&gt;y&lt;/b&gt;');
    expect(html).toContain('R &lt;script&gt;');
    expect(html).toContain('a &lt; b');
    expect(html).toContain('unassigned — you replied last');
    expect(html).toContain('href="https://app/tickets/1"');
  });
});
