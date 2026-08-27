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

  test('passes the sender display name natively as from.name on the API path', async () => {
    settingsRepositoryMock.getSendGridConfig.mockResolvedValue({
      apiKey: 'SG.test',
      fromEmail: 'ticketpulse@example.com',
      configured: true,
      mode: 'api',
    });
    axiosPostMock.mockResolvedValue({ headers: {} });

    await sendEmail({
      to: 'requester@example.com',
      subject: 'Ticket arrived',
      text: 'Hello',
      fromName: 'Ticket Pulse IT',
    });

    expect(axiosPostMock).toHaveBeenCalledWith(
      'https://api.sendgrid.com/v3/mail/send',
      expect.objectContaining({
        // Name rides in from.name — never stuffed into from.email.
        from: { email: 'ticketpulse@example.com', name: 'Ticket Pulse IT' },
      }),
      expect.anything(),
    );
  });

  test('formats the sender as an RFC 5322 mailbox string on the SMTP path', async () => {
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
    sendMailMock.mockResolvedValue({ messageId: 'smtp-message-2' });

    await sendEmail({
      to: 'requester@example.com',
      subject: 'Ticket arrived',
      text: 'Hello',
      fromName: 'Ticket Pulse Accounting',
    });

    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({
      from: '"Ticket Pulse Accounting" <ticketpulse@example.com>',
    }));
  });

  test('falls back to the global default name when the caller passes none', async () => {
    settingsRepositoryMock.getSendGridConfig.mockResolvedValue({
      apiKey: 'SG.test',
      fromEmail: 'ticketpulse@example.com',
      fromName: 'Ticket Pulse',
      configured: true,
      mode: 'api',
    });
    axiosPostMock.mockResolvedValue({ headers: {} });

    await sendEmail({
      to: 'requester@example.com',
      subject: 'Ticket arrived',
      text: 'Hello',
    });

    expect(axiosPostMock).toHaveBeenCalledWith(
      'https://api.sendgrid.com/v3/mail/send',
      expect.objectContaining({
        from: { email: 'ticketpulse@example.com', name: 'Ticket Pulse' },
      }),
      expect.anything(),
    );
  });

  // Phase CC (QA 08-26 #1): cc + attachments on both delivery paths, and the
  // provider guard that keeps an address out of to AND cc.
  describe('cc + attachments', () => {
    const apiConfig = { apiKey: 'SG.test', fromEmail: 'ticketpulse@example.com', configured: true, mode: 'api' };
    const smtpConfig = {
      apiKey: null, fromEmail: null, smtpConfigured: true, smtpHost: '127.0.0.1', smtpPort: 2525,
      smtpUser: 'sink', smtpPassword: 'sink', smtpFromEmail: 'ticketpulse@example.com', configured: true, mode: 'smtp',
    };
    const pdfBase64 = Buffer.from('%PDF-1.4').toString('base64');

    test('API path: personalizations.cc carries the cc and attachments[] uses the SendGrid v3 shape', async () => {
      settingsRepositoryMock.getSendGridConfig.mockResolvedValue(apiConfig);
      axiosPostMock.mockResolvedValue({ headers: { 'x-message-id': 'api-cc-1' } });

      await sendEmail({
        to: 'requester@example.com',
        cc: ['boss@example.com', 'Boss@Example.com', 'colleague@example.com'],
        subject: 'Re: Laptop [TP-1042]',
        html: '<p>Looping in</p>',
        attachments: [{ name: 'invoice.pdf', contentType: 'application/pdf', contentBytes: pdfBase64 }],
      });

      const [, payload] = axiosPostMock.mock.calls[0];
      expect(payload.personalizations[0]).toEqual(expect.objectContaining({
        to: [{ email: 'requester@example.com' }],
        cc: [{ email: 'boss@example.com' }, { email: 'colleague@example.com' }],
      }));
      expect(payload.attachments).toEqual([
        { content: pdfBase64, filename: 'invoice.pdf', type: 'application/pdf', disposition: 'attachment' },
      ]);
    });

    test('API path: a cc/bcc address already in `to` is dropped (SendGrid rejects duplicates across the personalization)', async () => {
      settingsRepositoryMock.getSendGridConfig.mockResolvedValue(apiConfig);
      axiosPostMock.mockResolvedValue({ headers: {} });

      await sendEmail({
        to: ['requester@example.com'],
        cc: ['REQUESTER@example.com', 'boss@example.com'],
        bcc: ['boss@example.com', 'audit@example.com'],
        subject: 'dedupe',
        text: 'Hello',
      });

      const [, payload] = axiosPostMock.mock.calls[0];
      expect(payload.personalizations[0].cc).toEqual([{ email: 'boss@example.com' }]);
      expect(payload.personalizations[0].bcc).toEqual([{ email: 'audit@example.com' }]);
      expect(payload.attachments).toBeUndefined();
    });

    test('API path: cc that collapses entirely onto `to` yields no cc key at all', async () => {
      settingsRepositoryMock.getSendGridConfig.mockResolvedValue(apiConfig);
      axiosPostMock.mockResolvedValue({ headers: {} });

      await sendEmail({ to: 'requester@example.com', cc: ['requester@example.com'], subject: 's', text: 'Hello' });

      const [, payload] = axiosPostMock.mock.calls[0];
      expect(payload.personalizations[0]).not.toHaveProperty('cc');
    });

    test('SMTP path: cc rides the envelope, to/cc are deduped, and attachments become nodemailer Buffers', async () => {
      settingsRepositoryMock.getSendGridConfig.mockResolvedValue(smtpConfig);
      sendMailMock.mockResolvedValue({ messageId: 'smtp-cc-1' });

      await sendEmail({
        to: 'requester@example.com',
        cc: ['boss@example.com', 'requester@example.com'],
        subject: 'Re: Laptop [TP-1042]',
        html: '<p>Looping in</p>',
        attachments: [
          { filename: 'notes.txt', type: 'text/plain', content: Buffer.from('hello') },
          { name: 'invoice.pdf', contentType: 'application/pdf', contentBytes: pdfBase64 },
          { name: 'empty.bin', contentType: 'application/octet-stream', contentBytes: '' },
        ],
      });

      expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({
        to: ['requester@example.com'],
        cc: ['boss@example.com'],
        attachments: [
          { filename: 'notes.txt', content: Buffer.from('hello'), contentType: 'text/plain' },
          { filename: 'invoice.pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' },
        ],
      }));
      expect(axiosPostMock).not.toHaveBeenCalled();
    });

    test('SMTP path: no attachments → attachments undefined (unchanged envelope for existing callers)', async () => {
      settingsRepositoryMock.getSendGridConfig.mockResolvedValue(smtpConfig);
      sendMailMock.mockResolvedValue({ messageId: 'smtp-cc-2' });

      await sendEmail({ to: 'requester@example.com', subject: 's', text: 'Hello' });

      expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({ attachments: undefined, cc: undefined }));
    });
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
