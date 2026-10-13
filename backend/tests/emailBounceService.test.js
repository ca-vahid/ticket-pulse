import { jest } from '@jest/globals';

// Bounce reporting (12 Oct 2026): SendGrid's "accepted" used to be the last thing we knew.
const prismaMock = { notificationDelivery: { findFirst: jest.fn(), update: jest.fn() } };
const settingsMock = { get: jest.fn() };
const ticketServiceMock = { addPrivateNote: jest.fn() };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: bounces, sendgridMessageId } = await import('../src/services/emailBounceService.js');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.notificationDelivery.update.mockResolvedValue({});
  ticketServiceMock.addPrivateNote.mockResolvedValue({});
});

describe('SendGrid events', () => {
  test('the message id is the part before the first dot', () => {
    expect(sendgridMessageId({ sg_message_id: '14c5d75ce93.dfd.64b469.filter0001.16648.5515E0B88.0' })).toBe('14c5d75ce93');
    expect(sendgridMessageId({})).toBeNull();
  });

  test('a bounce marks the delivery and leaves one internal note on the ticket', async () => {
    prismaMock.notificationDelivery.findFirst.mockResolvedValue({ id: 9, ticketId: 62000, workspaceId: 1, status: 'sent', recipient: 'rita@example.com', notificationType: 'native_reply_to_requester' });
    const out = await bounces.handleEvents([
      { event: 'delivered', sg_message_id: 'abc.filter' },
      { event: 'bounce', type: 'bounce', sg_message_id: 'abc123.filter0001', email: 'rita@example.com', reason: '550 5.1.1 The email account does not exist <x>' },
    ]);
    expect(out).toEqual({ seen: 2, failed: 1, matched: 1, noted: 1 });
    expect(prismaMock.notificationDelivery.findFirst.mock.calls[0][0].where).toEqual({ providerMessageId: 'abc123' });
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith({ where: { id: 9 }, data: { status: 'bounced', error: expect.stringContaining('bounce: 550 5.1.1') } });
    const [ticketId, workspaceId, input, , , options] = ticketServiceMock.addPrivateNote.mock.calls[0];
    expect([ticketId, workspaceId]).toEqual([62000, 1]);
    expect(input.bodyHtml).toContain('The reply to rita@example.com bounced');
    expect(input.bodyHtml).toContain('does not exist &lt;x&gt;');
    expect(options).toEqual({ systemNote: true });
  });

  test('a block is told apart from a bounce; a second event for the same delivery adds no second note', async () => {
    prismaMock.notificationDelivery.findFirst.mockResolvedValueOnce({ id: 10, ticketId: 62001, workspaceId: 1, status: 'sent', recipient: 'a@example.com', notificationType: 'workflow' });
    await bounces.handleEvents([{ event: 'bounce', type: 'blocked', sg_message_id: 'm1.x', email: 'a@example.com', reason: 'blocked by policy' }]);
    expect(ticketServiceMock.addPrivateNote.mock.calls[0][2].bodyHtml).toContain('An e-mail from this ticket to a@example.com was blocked by the receiving server');
    ticketServiceMock.addPrivateNote.mockClear();
    prismaMock.notificationDelivery.findFirst.mockResolvedValueOnce({ id: 10, ticketId: 62001, workspaceId: 1, status: 'bounced' });
    const again = await bounces.handleEvents([{ event: 'dropped', sg_message_id: 'm1.x', email: 'a@example.com' }]);
    expect(again).toMatchObject({ matched: 1, noted: 0 });
    expect(ticketServiceMock.addPrivateNote).not.toHaveBeenCalled();
  });

  test('an event for mail we did not record changes nothing, and a failure inside never throws', async () => {
    prismaMock.notificationDelivery.findFirst.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('db'));
    const out = await bounces.handleEvents([{ event: 'bounce', sg_message_id: 'x.y' }, { event: 'bounce', sg_message_id: 'z.y' }]);
    expect(out).toEqual({ seen: 2, failed: 2, matched: 0, noted: 0 });
  });

  test('the token must match the stored one exactly; no stored token means nobody gets in', async () => {
    settingsMock.get.mockResolvedValue('s3cret-token');
    expect(await bounces.verifyToken('s3cret-token')).toBe(true);
    expect(await bounces.verifyToken('s3cret-tokeN')).toBe(false);
    expect(await bounces.verifyToken(undefined)).toBe(false);
    settingsMock.get.mockResolvedValue('');
    expect(await bounces.verifyToken('')).toBe(false);
  });
});
