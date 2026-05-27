import { jest } from '@jest/globals';

const axiosPostMock = jest.fn();
const settingsRepositoryMock = {
  getTwilioConfig: jest.fn(),
};

jest.unstable_mockModule('axios', () => ({
  default: {
    post: axiosPostMock,
  },
}));

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: settingsRepositoryMock,
}));

const { sendWhatsApp } = await import('../src/services/twilioNotificationService.js');

describe('twilioNotificationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axiosPostMock.mockResolvedValue({
      data: {
        sid: 'SM123',
        status: 'queued',
      },
    });
    settingsRepositoryMock.getTwilioConfig.mockResolvedValue({
      accountSid: 'AC123',
      authToken: 'secret',
      fromNumber: '+16045550100',
      voiceFromNumber: '+16045550100',
      whatsappSender: '+16045550100',
      whatsappMessagingServiceSid: null,
      whatsappContentSid: 'HX123',
      whatsappContentVariables: '{"1":"{{message}}","2":"{{priority}}","3":"{{ticketId}}","4":"{{link}}"}',
    });
  });

  test('sends WhatsApp alerts with ContentSid and rendered content variables', async () => {
    const result = await sendWhatsApp({
      to: '+16045550101',
      body: 'Ticket #222999 High priority has been assigned to you.',
      variables: {
        priority: 'High',
        ticketId: '222999',
        link: 'https://example.freshservice.com/a/tickets/222999',
      },
    });

    expect(result).toEqual({
      provider: 'twilio',
      providerMessageId: 'SM123',
      status: 'queued',
      to: 'whatsapp:+16045550101',
    });
    const params = axiosPostMock.mock.calls[0][1];
    expect(params.get('From')).toBe('whatsapp:+16045550100');
    expect(params.get('To')).toBe('whatsapp:+16045550101');
    expect(params.get('ContentSid')).toBe('HX123');
    expect(JSON.parse(params.get('ContentVariables'))).toEqual({
      1: 'Ticket #222999 High priority has been assigned to you.',
      2: 'High',
      3: '222999',
      4: 'https://example.freshservice.com/a/tickets/222999',
    });
    expect(params.has('Body')).toBe(false);
  });

  test('uses MessagingServiceSid instead of From when configured', async () => {
    settingsRepositoryMock.getTwilioConfig.mockResolvedValue({
      accountSid: 'AC123',
      authToken: 'secret',
      fromNumber: '+16045550100',
      whatsappSender: null,
      whatsappMessagingServiceSid: 'MG123',
      whatsappContentSid: 'HX123',
      whatsappContentVariables: '{"1":"{{message}}"}',
    });

    await sendWhatsApp({
      to: '+16045550101',
      body: 'Ticket Pulse test',
    });

    const params = axiosPostMock.mock.calls[0][1];
    expect(params.get('MessagingServiceSid')).toBe('MG123');
    expect(params.has('From')).toBe(false);
  });

  test('requires a WhatsApp content template for business-initiated sends', async () => {
    settingsRepositoryMock.getTwilioConfig.mockResolvedValue({
      accountSid: 'AC123',
      authToken: 'secret',
      fromNumber: '+16045550100',
      whatsappSender: '+16045550100',
      whatsappMessagingServiceSid: null,
      whatsappContentSid: null,
      whatsappContentVariables: '{"1":"{{message}}"}',
    });

    await expect(sendWhatsApp({
      to: '+16045550101',
      body: 'Ticket Pulse test',
    })).rejects.toThrow(/twilio_whatsapp_content_sid/);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });
});
