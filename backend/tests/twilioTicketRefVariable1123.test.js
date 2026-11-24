import { jest } from '@jest/globals';

/**
 * QA 11-23: WhatsApp content variables render {{ticketRef}} (the ticket's own
 * reference) beside the unchanged {{ticketId}} (bare FreshService number), and
 * {{link}} is the Ticket Pulse link the alert built — end to end from the
 * delivery payload's whatsappVariables to the Twilio form.
 */

const settingsRepositoryMock = { getTwilioConfig: jest.fn() };
const axiosPostMock = jest.fn().mockResolvedValue({ data: { sid: 'SM1', status: 'queued' } });
jest.unstable_mockModule('axios', () => ({ default: { post: axiosPostMock } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { sendWhatsApp, __testing } = await import('../src/services/twilioNotificationService.js');

const VARIABLES = {
  priority: 'Urgent',
  ticketId: '250001',
  ticketRef: 'TP-1042',
  link: 'https://tp.example.com/it/TP-1042',
};

test('renderTemplateValue fills ticketRef, ticketId and link', () => {
  expect(__testing.renderTemplateValue('{{ticketRef}} ({{ticketId}}) is {{priority}}: {{link}}', VARIABLES))
    .toBe('TP-1042 (250001) is Urgent: https://tp.example.com/it/TP-1042');
  expect(__testing.renderTemplateValue('{{ticketRef}}', {})).toBe('');
});

test('sendWhatsApp puts the rendered variables on the Twilio form', async () => {
  settingsRepositoryMock.getTwilioConfig.mockResolvedValue({
    accountSid: 'AC123', authToken: 'secret', fromNumber: '+16045550100',
    whatsappSender: '+16045550100', whatsappMessagingServiceSid: null, whatsappContentSid: 'HX123',
    whatsappContentVariables: '{"1":"{{message}}","2":"{{ticketRef}}","3":"{{link}}","4":"{{ticketId}}"}',
  });
  await sendWhatsApp({ to: '+16045550101', body: 'TP-1042 is now Urgent priority and assigned to you.', variables: VARIABLES });
  const form = axiosPostMock.mock.calls[0][1];
  expect(JSON.parse(form.get('ContentVariables'))).toEqual({
    1: 'TP-1042 is now Urgent priority and assigned to you.',
    2: 'TP-1042',
    3: 'https://tp.example.com/it/TP-1042',
    4: '250001',
  });
});
