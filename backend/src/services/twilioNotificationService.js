import axios from 'axios';
import settingsRepository from './settingsRepository.js';
import { ExternalAPIError, ValidationError } from '../utils/errors.js';

const TWILIO_API_ROOT = 'https://api.twilio.com/2010-04-01';

function compact(value) {
  const text = String(value || '').trim();
  return text || null;
}

function xmlEscape(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function twilioErrorMessage(error) {
  const data = error?.response?.data;
  if (data?.message) return data.message;
  if (data?.code) return `Twilio error ${data.code}`;
  return error?.message || 'Request failed';
}

function whatsappAddress(number) {
  const text = compact(number);
  if (!text) return null;
  return text.toLowerCase().startsWith('whatsapp:') ? text : `whatsapp:${text}`;
}

function parseContentVariableTemplate(rawTemplate) {
  const raw = compact(rawTemplate) || '{"1":"{{message}}"}';
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('must be a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new ValidationError(`WhatsApp content variables must be valid JSON: ${error.message}`);
  }
}

function renderTemplateValue(value, variables) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('{{message}}', variables.message || '')
    .replaceAll('{{priority}}', variables.priority || '')
    .replaceAll('{{ticketId}}', variables.ticketId || '')
    .replaceAll('{{link}}', variables.link || '');
}

function buildContentVariables(rawTemplate, variables) {
  const template = parseContentVariableTemplate(rawTemplate);
  return Object.fromEntries(
    Object.entries(template).map(([key, value]) => [key, renderTemplateValue(value, variables)]),
  );
}

async function getRequiredConfig({ requireFromNumber = true } = {}) {
  const config = await settingsRepository.getTwilioConfig();
  const accountSid = compact(config.accountSid);
  const authToken = compact(config.authToken);
  const fromNumber = compact(config.fromNumber || config.voiceFromNumber);

  const missing = [
    !accountSid ? 'twilio_account_sid' : null,
    !authToken ? 'twilio_auth_token' : null,
    requireFromNumber && !fromNumber ? 'twilio_from_number' : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new ValidationError(`Twilio is not configured (${missing.join(', ')})`);
  }

  return {
    accountSid,
    authToken,
    fromNumber,
    whatsappSender: compact(config.whatsappSender),
    whatsappMessagingServiceSid: compact(config.whatsappMessagingServiceSid),
    whatsappContentSid: compact(config.whatsappContentSid),
    whatsappContentVariables: compact(config.whatsappContentVariables),
  };
}

async function postTwilioForm(path, form, config) {
  try {
    const response = await axios.post(
      `${TWILIO_API_ROOT}/Accounts/${encodeURIComponent(config.accountSid)}${path}`,
      new URLSearchParams(form),
      {
        auth: {
          username: config.accountSid,
          password: config.authToken,
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
      },
    );
    return response.data || {};
  } catch (error) {
    throw new ExternalAPIError('Twilio', twilioErrorMessage(error), error);
  }
}

export async function sendSms({ to, body }) {
  const recipient = compact(to);
  const message = compact(body);
  if (!recipient) throw new ValidationError('SMS recipient is required');
  if (!message) throw new ValidationError('SMS body is required');

  const twilioConfig = await getRequiredConfig();
  const data = await postTwilioForm('/Messages.json', {
    From: twilioConfig.fromNumber,
    To: recipient,
    Body: message,
  }, twilioConfig);

  return {
    provider: 'twilio',
    providerMessageId: data.sid || null,
    status: data.status || 'accepted',
    to: recipient,
  };
}

export async function sendVerificationSms({ to, code }) {
  return sendSms({
    to,
    body: `Ticket Pulse verification code: ${code}`,
  });
}

export async function sendWhatsApp({ to, body, variables = {} }) {
  const recipient = whatsappAddress(to);
  const message = compact(body);
  if (!recipient) throw new ValidationError('WhatsApp recipient is required');
  if (!message) throw new ValidationError('WhatsApp message is required');

  const twilioConfig = await getRequiredConfig({ requireFromNumber: false });
  const messagingServiceSid = compact(twilioConfig.whatsappMessagingServiceSid);
  const fromAddress = whatsappAddress(twilioConfig.whatsappSender || twilioConfig.fromNumber);
  const contentSid = compact(twilioConfig.whatsappContentSid);

  const missing = [
    !messagingServiceSid && !fromAddress ? 'twilio_whatsapp_sender_or_messaging_service_sid' : null,
    !contentSid ? 'twilio_whatsapp_content_sid' : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new ValidationError(`WhatsApp is not configured (${missing.join(', ')})`);
  }

  const contentVariables = buildContentVariables(twilioConfig.whatsappContentVariables, {
    ...variables,
    message,
  });
  const form = {
    To: recipient,
    ContentSid: contentSid,
    ContentVariables: JSON.stringify(contentVariables),
  };
  if (messagingServiceSid) {
    form.MessagingServiceSid = messagingServiceSid;
  } else {
    form.From = fromAddress;
  }

  const data = await postTwilioForm('/Messages.json', form, twilioConfig);

  return {
    provider: 'twilio',
    providerMessageId: data.sid || null,
    status: data.status || 'accepted',
    to: recipient,
  };
}

export async function placeVoiceCall({ to, message }) {
  const recipient = compact(to);
  const voiceMessage = compact(message);
  if (!recipient) throw new ValidationError('Voice call recipient is required');
  if (!voiceMessage) throw new ValidationError('Voice call message is required');

  const twilioConfig = await getRequiredConfig();
  const twiml = `<Response><Say voice="alice">${xmlEscape(voiceMessage)}</Say></Response>`;
  const data = await postTwilioForm('/Calls.json', {
    From: twilioConfig.fromNumber,
    To: recipient,
    Twiml: twiml,
  }, twilioConfig);

  return {
    provider: 'twilio',
    providerMessageId: data.sid || null,
    status: data.status || 'queued',
    to: recipient,
  };
}

export default {
  sendSms,
  sendVerificationSms,
  sendWhatsApp,
  placeVoiceCall,
};
