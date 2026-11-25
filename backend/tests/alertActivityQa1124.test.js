import { jest } from '@jest/globals';

/**
 * QA 11-24 item 9: every alert sent about a ticket leaves one "alert sent" row
 * on its Activity tab (who, how, why, and any fallback), and the priority
 * workflow sees the priority the ticket has now.
 */

const prismaMock = {
  notificationDelivery: { findMany: jest.fn() },
  ticketActivity: { create: jest.fn() },
  ticketPriorityEvent: { findUnique: jest.fn(), create: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  alertSentence, alertReason, channelWords, recordAlertActivity, recordAlertActivityForDeliveries,
} = await import('../src/services/alertActivityService.js');

describe('alert sentences', () => {
  test('channels read as words', () => {
    expect(channelWords(['email'])).toBe('e-mail');
    expect(channelWords(['email', 'sms'])).toBe('e-mail and SMS');
    expect(channelWords(['email', 'sms', 'phone_call'])).toBe('e-mail, SMS and phone call');
  });

  test('why: assignee and the alert setting', () => {
    expect(alertReason({ kind: 'priority', threshold: 'urgent_only' })).toBe('assignee, subscribed to Urgent alerts');
    expect(alertReason({ kind: 'assignment', threshold: 'high_urgent' })).toBe('assigned to them, subscribed to High and Urgent alerts');
    expect(alertReason({ kind: 'escalation', escalationType: 'self_service' })).toBe('the requester escalated the ticket');
    expect(alertReason({ kind: 'custom', subscriptionLabel: 'Network, High+' })).toBe('subscribed to the alert "Network, High+"');
  });

  test('the QA sentence', () => {
    expect(alertSentence({
      kind: 'priority', priority: 'Urgent', technicianName: 'Jordan Lee', sent: ['email', 'sms'], reason: 'assignee, subscribed to Urgent alerts',
    })).toBe('Urgent-priority alert sent to Jordan Lee by e-mail and SMS: assignee, subscribed to Urgent alerts');
  });

  test('partial and total failure say so', () => {
    expect(alertSentence({ kind: 'priority', priority: 'High', technicianName: 'Sam Park', sent: ['email'], failed: [{ channel: 'sms' }] }))
      .toBe('High-priority alert sent to Sam Park by e-mail (SMS failed)');
    expect(alertSentence({ kind: 'assignment', priority: 'Urgent', technicianName: 'Sam Park', failed: [{ channel: 'email' }] }))
      .toBe('Urgent-priority assignment alert to Sam Park could not be sent by e-mail');
  });
});

describe('recordAlertActivity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticketActivity.create.mockImplementation(async ({ data }) => ({ id: 900, ...data }));
  });

  test('one row per person: sentence, channels, delivery ids and the fallback reason', async () => {
    prismaMock.notificationDelivery.findMany.mockResolvedValue([
      { id: 1, ticketId: 501, technicianId: 17, channel: 'email', status: 'sent', error: null, assessedPriority: 'Urgent', payload: { emailLayout: 'plain', fallbackReason: 'The ticket could not be read when the alert was sent, so it went as a plain one-line message.' } },
      { id: 2, ticketId: 501, technicianId: 17, channel: 'sms', status: 'sent', error: null, assessedPriority: 'Urgent', payload: {} },
    ]);

    const rows = await recordAlertActivityForDeliveries(['k:email', 'k:sms'], {
      kind: 'priority', priority: 'Urgent', technicianName: 'Jordan Lee', reason: 'assignee, subscribed to Urgent alerts',
    });

    expect(rows).toHaveLength(1);
    const { data } = prismaMock.ticketActivity.create.mock.calls[0][0];
    expect(data).toEqual(expect.objectContaining({ ticketId: 501, activityType: 'alert_sent', performedBy: 'Ticket Pulse' }));
    expect(data.details).toEqual(expect.objectContaining({
      sentence: 'Urgent-priority alert sent to Jordan Lee by e-mail and SMS: assignee, subscribed to Urgent alerts',
      kind: 'priority',
      technicianId: 17,
      technicianName: 'Jordan Lee',
      channels: { sent: ['email', 'sms'], failed: [], queued: [] },
      deliveryIds: [1, 2],
      actorKind: 'system',
      fallbackReasons: [{ channel: 'email', reason: expect.stringMatching(/plain one-line message/) }],
    }));
  });

  test('several people on one ticket: one row each, each with their own name', async () => {
    prismaMock.notificationDelivery.findMany.mockResolvedValue([
      { id: 3, ticketId: 501, technicianId: 17, channel: 'sms', status: 'sent', payload: {} },
      { id: 4, ticketId: 501, technicianId: 18, channel: 'sms', status: 'failed', error: 'Twilio 21614', payload: {} },
    ]);
    await recordAlertActivityForDeliveries(['a', 'b'], {
      kind: 'escalation', priority: 'Urgent', technicianNames: { 17: 'Jordan Lee', 18: 'Sam Park' }, reason: 'after-hours urgent escalation',
    });
    const sentences = prismaMock.ticketActivity.create.mock.calls.map(([arg]) => arg.data.details.sentence);
    expect(sentences).toEqual([
      'Urgent escalation sent to Jordan Lee by SMS: after-hours urgent escalation',
      'Urgent escalation to Sam Park could not be sent by SMS: after-hours urgent escalation',
    ]);
  });

  test('never throws, and writes nothing without deliveries', async () => {
    prismaMock.ticketActivity.create.mockRejectedValue(new Error('db down'));
    await expect(recordAlertActivity({ ticketId: 501, kind: 'custom', deliveries: [{ channel: 'email', sent: true }] })).resolves.toBeNull();
    await expect(recordAlertActivity({ ticketId: 501, kind: 'custom', deliveries: [] })).resolves.toBeNull();
    prismaMock.notificationDelivery.findMany.mockRejectedValue(new Error('db down'));
    await expect(recordAlertActivityForDeliveries(['x'], {})).resolves.toEqual([]);
  });
});
