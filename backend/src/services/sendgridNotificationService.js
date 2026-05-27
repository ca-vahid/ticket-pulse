import axios from 'axios';
import settingsRepository from './settingsRepository.js';
import { ExternalAPIError, ValidationError } from '../utils/errors.js';

function trim(value) {
  const text = String(value || '').trim();
  return text || null;
}

function sendgridErrorMessage(error) {
  const firstError = error?.response?.data?.errors?.[0];
  if (firstError?.message) return firstError.message;
  return error?.message || 'Request failed';
}

export async function sendAssignmentEmail({ to, subject, body }) {
  const recipient = trim(to);
  const text = trim(body);
  const emailSubject = trim(subject) || 'Ticket Pulse priority assignment';

  if (!recipient) throw new ValidationError('Email recipient is required');
  if (!text) throw new ValidationError('Email body is required');
  const sendgridConfig = await settingsRepository.getSendGridConfig();
  if (!sendgridConfig.apiKey || !sendgridConfig.fromEmail) {
    throw new ValidationError('SendGrid is not configured');
  }

  try {
    const response = await axios.post(
      'https://api.sendgrid.com/v3/mail/send',
      {
        personalizations: [{ to: [{ email: recipient }] }],
        from: { email: sendgridConfig.fromEmail },
        subject: emailSubject,
        content: [{ type: 'text/plain', value: text }],
      },
      {
        headers: {
          Authorization: `Bearer ${sendgridConfig.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      },
    );

    return {
      provider: 'sendgrid',
      providerMessageId: response.headers?.['x-message-id'] || null,
      status: 'accepted',
      to: recipient,
    };
  } catch (error) {
    throw new ExternalAPIError('SendGrid', sendgridErrorMessage(error), error);
  }
}

export default {
  sendAssignmentEmail,
};
