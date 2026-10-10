import { jest } from '@jest/globals';

/**
 * Urgent response — notices (plans/URGENT_RESPONSE_PLAN.md): tellPeople by
 * Teams and/or e-mail (the ticket link, or a path on the public address), and
 * the text to the on-call person's verified phone. Nothing throws.
 */
const prismaMock = {
  technician: { findMany: jest.fn() },
  workspace: { findUnique: jest.fn() },
  technicianNotificationPreference: { findUnique: jest.fn() },
};
const sendWorkflowMessage = jest.fn();
const sendTransactionalEmail = jest.fn();
const sendSms = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/teamsNotificationService.js', () => ({ default: { sendWorkflowMessage } }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ sendTransactionalEmail }));
jest.unstable_mockModule('../src/services/twilioNotificationService.js', () => ({ sendSms }));

const { default: notifier } = await import('../src/services/urgentResponse/notifier.js');

const PEOPLE = [
  { id: 11, name: 'Andrew Fong', email: 'afong@example.com', isActive: true, assignableOnly: false },
  { id: 22, name: 'Maria Lee', email: 'mlee@example.com', isActive: true, assignableOnly: false },
  { id: 33, name: 'No Mail', email: null, isActive: true, assignableOnly: false },
  { id: 44, name: 'Gone Person', email: 'gone@example.com', isActive: false, assignableOnly: false },
  { id: 55, name: 'Other Team', email: 'other@example.com', isActive: false, assignableOnly: true },
];
const TICKET = { id: 500, origin: 'freshservice', freshserviceTicketId: 242611n, nativeNumber: null, subject: 'VPN is down' };
const ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV, PUBLIC_APP_URL: 'https://tp.example.com/' };
  prismaMock.technician.findMany.mockImplementation(async ({ where }) => PEOPLE.filter((p) => where.id.in.includes(p.id)));
  prismaMock.workspace.findUnique.mockResolvedValue({ name: 'IT' });
  sendWorkflowMessage.mockResolvedValue({ sent: 2, skipped: 0, failed: 0, firstError: null, off: null });
  sendTransactionalEmail.mockResolvedValue({ sent: true, via: 'graph' });
  sendSms.mockResolvedValue({ sid: 'SM1' });
});
afterAll(() => { process.env = ENV; });

describe('tellPeople', () => {
  const base = { workspaceId: 1, technicianIds: [11, 22, 22, 33, 44, 55], title: 'Urgent ticket #242611 moved to Maria Lee', lines: ['#242611: VPN is down', 'Moved from Andrew Fong to Maria Lee by the Urgent rule.'], ticket: TICKET, refKey: 'urgent-moved:500:9' };

  test('Teams and e-mail: people with an address who can still own tickets, never the photo', async () => {
    const out = await notifier.tellPeople(base);
    expect(out).toEqual({ people: 3, teams: { sent: 2, skipped: 0, failed: 0, off: null }, email: { sent: 3, failed: 0 } });
    expect(prismaMock.technician.findMany.mock.calls[0][0]).toMatchObject({ where: { workspaceId: 1, id: { in: [11, 22, 33, 44, 55] } }, take: 5 });
    expect(prismaMock.technician.findMany.mock.calls[0][0].select.photoUrl).toBeUndefined();

    expect(sendWorkflowMessage).toHaveBeenCalledWith({
      workspaceId: 1,
      emails: ['afong@example.com', 'mlee@example.com', 'other@example.com'],
      title: base.title,
      body: base.lines.join('\n\n'),
      ticketId: 500,
      ticketRef: '#242611',
      includeTicketLink: true,
      refKey: 'urgent-moved:500:9',
    });

    // One mail per person, the ticket never passed to the mail call.
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(3);
    const mail = sendTransactionalEmail.mock.calls[0][0];
    expect(mail).toMatchObject({ workspaceId: 1, to: 'afong@example.com', subject: base.title, label: 'urgent response notice' });
    expect(mail.ticket).toBeUndefined();
    expect(mail.html).toContain('https://tp.example.com/tickets/500');
    expect(mail.html).toContain('Open #242611');
    expect(mail.html).toContain('Moved from Andrew Fong to Maria Lee by the Urgent rule.');
    expect(mail.html).toContain('IT workspace');
    expect(mail.text).toContain('Open #242611: https://tp.example.com/tickets/500');
  });

  test('the e-mail has no gradient and no background shorthand in what this file adds; the button is a bgcolor cell with a text colour', async () => {
    await notifier.tellPeople({ ...base, channels: ['email'], technicianIds: [11] });
    const { html } = sendTransactionalEmail.mock.calls[0][0];
    expect(html).not.toMatch(/gradient/i);
    expect(html).toContain('<td bgcolor="#2563eb" style="background-color:#2563eb;border-radius:8px;">');
    expect(html).toMatch(/<a href="https:\/\/tp\.example\.com\/tickets\/500" style="[^"]*color:#ffffff;/);
  });

  test('text is escaped in the e-mail', async () => {
    await notifier.tellPeople({ ...base, channels: ['email'], technicianIds: [11], lines: ['<script>alert(1)</script> & co'] });
    const { html } = sendTransactionalEmail.mock.calls[0][0];
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; co');
  });

  test('no ticket: `link` is a path, prefixed with the public address, and rides in the Teams text', async () => {
    await notifier.tellPeople({ workspaceId: 1, technicianIds: [11], title: 'Andrew Fong needs on-call cover 12–19 Oct. Can you take it?', lines: ['The first person to accept takes it.'], ticket: null, refKey: 'urgent-cover-request:12', channels: ['teams', 'email'], link: '/on-call?request=12' });
    expect(sendWorkflowMessage.mock.calls[0][0]).toMatchObject({
      ticketId: null, ticketRef: null, includeTicketLink: false, body: 'The first person to accept takes it.\n\nhttps://tp.example.com/on-call?request=12',
    });
    expect(sendTransactionalEmail.mock.calls[0][0].html).toContain('https://tp.example.com/on-call?request=12');
    expect(sendTransactionalEmail.mock.calls[0][0].html).toContain('Open Ticket Pulse');
  });

  test('only the channels asked for', async () => {
    expect(await notifier.tellPeople({ ...base, channels: ['email'] })).toMatchObject({ teams: null, email: { sent: 3, failed: 0 } });
    expect(sendWorkflowMessage).not.toHaveBeenCalled();
    jest.clearAllMocks();
    expect(await notifier.tellPeople({ ...base, channels: ['teams', 'pager'] })).toMatchObject({ teams: { sent: 2 }, email: null });
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
    jest.clearAllMocks();
    expect(await notifier.tellPeople({ ...base, channels: [] })).toEqual({ people: 3, teams: null, email: null });
    expect(sendWorkflowMessage).not.toHaveBeenCalled();
  });

  test('Teams switched off is reported, and the e-mail still goes', async () => {
    sendWorkflowMessage.mockResolvedValue({ sent: 0, skipped: 0, failed: 0, firstError: null, off: 'Teams is switched off for this workspace (Settings → Teams)' });
    const out = await notifier.tellPeople(base);
    expect(out.teams).toEqual({ sent: 0, skipped: 0, failed: 0, off: 'Teams is switched off for this workspace (Settings → Teams)' });
    expect(out.email.sent).toBe(3);
  });

  test('nobody to tell: nothing is sent', async () => {
    expect(await notifier.tellPeople({ ...base, technicianIds: [] })).toEqual({ people: 0, teams: null, email: null });
    expect(await notifier.tellPeople({ ...base, technicianIds: [33, 44] })).toEqual({ people: 0, teams: null, email: null });
    expect(prismaMock.technician.findMany).toHaveBeenCalledTimes(1);
    expect(sendWorkflowMessage).not.toHaveBeenCalled();
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  test('never throws: a failing channel is counted, a failing lookup is logged', async () => {
    sendWorkflowMessage.mockRejectedValue(new Error('bot is down'));
    sendTransactionalEmail.mockResolvedValueOnce({ sent: false, error: '403' });
    const out = await notifier.tellPeople(base);
    expect(out).toEqual({ people: 3, teams: { sent: 0, skipped: 0, failed: 3, off: null }, email: { sent: 2, failed: 1 } });

    prismaMock.technician.findMany.mockRejectedValue(new Error('pool timeout'));
    await expect(notifier.tellPeople(base)).resolves.toEqual({ people: 0, teams: null, email: null });
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('notice not sent (urgent-moved:500:9): pool timeout'));
    await expect(notifier.tellPeople()).resolves.toEqual({ people: 0, teams: null, email: null });
  });
});

describe('textOnCall', () => {
  const pref = (extra = {}) => ({ phoneOverride: null, entraMobilePhone: '+16045550101', entraPhone: '+16045550999', phoneVerifiedAt: new Date('2026-09-01T00:00:00Z'), ...extra });

  test('one SMS to the verified phone: the override, then the mobile, then the desk phone', async () => {
    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue(pref());
    expect(await notifier.textOnCall({ id: 22, name: 'Maria Lee' }, 'Ticket Pulse: Urgent ticket #242611 is yours.')).toEqual({ sent: true });
    expect(prismaMock.technicianNotificationPreference.findUnique.mock.calls[0][0].where).toEqual({ technicianId: 22 });
    expect(sendSms).toHaveBeenCalledWith({ to: '+16045550101', body: 'Ticket Pulse: Urgent ticket #242611 is yours.' });

    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue(pref({ phoneOverride: '+17785550000' }));
    await notifier.textOnCall({ id: 22 }, 'x');
    expect(sendSms).toHaveBeenLastCalledWith({ to: '+17785550000', body: 'x' });

    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue(pref({ entraMobilePhone: null }));
    await notifier.textOnCall({ id: 22 }, 'x');
    expect(sendSms).toHaveBeenLastCalledWith({ to: '+16045550999', body: 'x' });
  });

  test('no verified phone, no phone, no row, nobody: reported, nothing sent', async () => {
    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue(pref({ phoneVerifiedAt: null }));
    expect(await notifier.textOnCall({ id: 22 }, 'x')).toEqual({ sent: false, reason: 'no_verified_phone' });
    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue(pref({ entraMobilePhone: null, entraPhone: ' ' }));
    expect(await notifier.textOnCall({ id: 22 }, 'x')).toEqual({ sent: false, reason: 'no_verified_phone' });
    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue(null);
    expect(await notifier.textOnCall({ id: 22 }, 'x')).toEqual({ sent: false, reason: 'no_verified_phone' });
    expect(await notifier.textOnCall(null, 'x')).toEqual({ sent: false, reason: 'no_technician' });
    expect(sendSms).not.toHaveBeenCalled();
  });

  test('never throws: a Twilio failure is reported', async () => {
    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue(pref());
    sendSms.mockRejectedValue(new Error('Twilio 21211'));
    expect(await notifier.textOnCall({ id: 22 }, 'x')).toEqual({ sent: false, reason: 'send_failed', error: 'Twilio 21211' });
    prismaMock.technicianNotificationPreference.findUnique.mockRejectedValue(new Error('pool timeout'));
    expect(await notifier.textOnCall({ id: 22 }, 'x')).toEqual({ sent: false, reason: 'send_failed', error: 'pool timeout' });
  });
});
