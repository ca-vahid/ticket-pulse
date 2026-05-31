import { jest } from '@jest/globals';

const axiosPostMock = jest.fn();
const sendMailMock = jest.fn();
const createTransportMock = jest.fn(() => ({
  sendMail: sendMailMock,
}));
const settingsRepositoryMock = {
  getSendGridConfig: jest.fn(),
};

jest.unstable_mockModule('axios', () => ({
  default: {
    post: axiosPostMock,
  },
}));

jest.unstable_mockModule('nodemailer', () => ({
  default: {
    createTransport: createTransportMock,
  },
}));

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: settingsRepositoryMock,
}));

const { sendEmail } = await import('../src/services/sendgridNotificationService.js');

describe('sendgridNotificationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sends through SendGrid API when API credentials are configured', async () => {
    settingsRepositoryMock.getSendGridConfig.mockResolvedValue({
      apiKey: 'SG.test',
      fromEmail: 'ticketpulse@example.com',
      configured: true,
      mode: 'api',
    });
    axiosPostMock.mockResolvedValue({
      headers: {
        'x-message-id': 'api-message-1',
      },
    });

    const result = await sendEmail({
      to: 'requester@example.com',
      subject: 'Ticket arrived',
      text: 'Hello',
      customArgs: { workflowId: 7 },
    });

    expect(result).toEqual(expect.objectContaining({
      provider: 'sendgrid',
      providerMessageId: 'api-message-1',
      status: 'accepted',
      to: ['requester@example.com'],
    }));
    expect(axiosPostMock).toHaveBeenCalledWith(
      'https://api.sendgrid.com/v3/mail/send',
      expect.objectContaining({
        from: { email: 'ticketpulse@example.com' },
        subject: 'Ticket arrived',
        personalizations: [
          expect.objectContaining({
            to: [{ email: 'requester@example.com' }],
            custom_args: { workflowId: 7 },
          }),
        ],
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer SG.test',
        }),
      }),
    );
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  test('falls back to configured SendGrid SMTP when API credentials are absent', async () => {
    settingsRepositoryMock.getSendGridConfig.mockResolvedValue({
      apiKey: null,
      fromEmail: null,
      smtpConfigured: true,
      smtpHost: 'smtp.sendgrid.net',
      smtpPort: 587,
      smtpUser: 'apikey',
      smtpPassword: 'smtp-secret',
      smtpFromEmail: 'ticketpulse@example.com',
      configured: true,
      mode: 'smtp',
    });
    sendMailMock.mockResolvedValue({
      messageId: 'smtp-message-1',
    });

    const result = await sendEmail({
      to: ['requester@example.com', 'requester@example.com'],
      cc: 'agent@example.com',
      subject: 'Ticket assigned',
      html: '<p>Hello</p>',
      customArgs: { workflowRunId: 12 },
    });

    expect(result).toEqual(expect.objectContaining({
      provider: 'sendgrid_smtp',
      providerMessageId: 'smtp-message-1',
      status: 'accepted',
      to: ['requester@example.com'],
    }));
    expect(createTransportMock).toHaveBeenCalledWith({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: {
        user: 'apikey',
        pass: 'smtp-secret',
      },
    });
    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({
      from: 'ticketpulse@example.com',
      to: ['requester@example.com'],
      cc: ['agent@example.com'],
      subject: 'Ticket assigned',
      html: '<p>Hello</p>',
      headers: {
        'X-Ticket-Pulse-workflowRunId': '12',
      },
    }));
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  test('rejects send attempts when no email provider configuration is available', async () => {
    settingsRepositoryMock.getSendGridConfig.mockResolvedValue({
      apiKey: null,
      fromEmail: null,
      smtpConfigured: false,
      configured: false,
      mode: 'missing',
    });

    await expect(sendEmail({
      to: 'requester@example.com',
      subject: 'Ticket arrived',
      text: 'Hello',
    })).rejects.toThrow('SendGrid is not configured');
  });
});
