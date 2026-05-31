import axios from 'axios';
import nodemailer from 'nodemailer';
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

function classifySendgridError(error) {
  const status = error?.response?.status || null;
  const retryable = !status || status === 429 || status >= 500;
  return {
    status,
    retryable,
    errorClass: retryable ? 'retryable_provider_error' : 'permanent_provider_error',
  };
}

function smtpErrorMessage(error) {
  return error?.response || error?.message || 'Request failed';
}

function classifySmtpError(error) {
  const status = error?.responseCode || null;
  const retryable = !status || [421, 450, 451, 452].includes(status) || status >= 500;
  return {
    status,
    retryable,
    errorClass: retryable ? 'retryable_provider_error' : 'permanent_provider_error',
  };
}

function normalizeEmailList(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => trim(item))
    .filter(Boolean)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === item.toLowerCase()) === index);
}

function mapEmails(values) {
  return normalizeEmailList(values).map((email) => ({ email }));
}

function hasApiConfig(sendgridConfig) {
  return Boolean(sendgridConfig.apiKey && sendgridConfig.fromEmail);
}

function hasSmtpConfig(sendgridConfig) {
  return Boolean(
    sendgridConfig.smtpConfigured
    && sendgridConfig.smtpHost
    && sendgridConfig.smtpUser
    && sendgridConfig.smtpPassword
    && sendgridConfig.smtpFromEmail,
  );
}

function customArgsToHeaders(customArgs) {
  if (!customArgs || typeof customArgs !== 'object') return {};
  return Object.entries(customArgs).reduce((headers, [key, value]) => {
    const safeKey = String(key).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 48);
    if (!safeKey) return headers;
    const headerValue = typeof value === 'string' ? value : JSON.stringify(value);
    return {
      ...headers,
      [`X-Ticket-Pulse-${safeKey}`]: String(headerValue || '').slice(0, 500),
    };
  }, {});
}

async function sendViaSendgridApi({
  sendgridConfig,
  toRecipients,
  ccRecipients,
  bccRecipients,
  from,
  replyTo,
  emailSubject,
  htmlBody,
  textBody,
  customArgs,
}) {
  const personalization = { to: mapEmails(toRecipients) };
  const ccMapped = mapEmails(ccRecipients);
  const bccMapped = mapEmails(bccRecipients);
  if (ccMapped.length > 0) personalization.cc = ccMapped;
  if (bccMapped.length > 0) personalization.bcc = bccMapped;
  if (customArgs && typeof customArgs === 'object') personalization.custom_args = customArgs;

  const content = [];
  if (textBody) content.push({ type: 'text/plain', value: textBody });
  if (htmlBody) content.push({ type: 'text/html', value: htmlBody });

  const payload = {
    personalizations: [personalization],
    from: { email: trim(from) || sendgridConfig.fromEmail },
    subject: emailSubject,
    content,
  };
  const normalizedReplyTo = trim(replyTo);
  if (normalizedReplyTo) payload.reply_to = { email: normalizedReplyTo };

  const response = await axios.post(
    'https://api.sendgrid.com/v3/mail/send',
    payload,
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
    to: toRecipients,
  };
}

async function sendViaSmtp({
  sendgridConfig,
  toRecipients,
  ccRecipients,
  bccRecipients,
  from,
  replyTo,
  emailSubject,
  htmlBody,
  textBody,
  customArgs,
}) {
  const transporter = nodemailer.createTransport({
    host: sendgridConfig.smtpHost,
    port: sendgridConfig.smtpPort || 587,
    secure: Number(sendgridConfig.smtpPort) === 465,
    auth: {
      user: sendgridConfig.smtpUser,
      pass: sendgridConfig.smtpPassword,
    },
  });

  const info = await transporter.sendMail({
    from: trim(from) || sendgridConfig.smtpFromEmail,
    to: toRecipients,
    cc: ccRecipients.length > 0 ? ccRecipients : undefined,
    bcc: bccRecipients.length > 0 ? bccRecipients : undefined,
    subject: emailSubject,
    text: textBody || undefined,
    html: htmlBody || undefined,
    replyTo: trim(replyTo) || undefined,
    headers: customArgsToHeaders(customArgs),
  });

  return {
    provider: 'sendgrid_smtp',
    providerMessageId: info.messageId || null,
    status: 'accepted',
    to: toRecipients,
  };
}

export async function sendEmail({
  to,
  cc = [],
  bcc = [],
  from = null,
  replyTo = null,
  subject,
  html = null,
  text = null,
  customArgs = null,
}) {
  const toRecipients = normalizeEmailList(to);
  const ccRecipients = normalizeEmailList(cc);
  const bccRecipients = normalizeEmailList(bcc);
  const textBody = trim(text);
  const htmlBody = trim(html);
  const emailSubject = trim(subject) || 'Ticket Pulse notification';

  if (toRecipients.length === 0) throw new ValidationError('Email recipient is required');
  if (!textBody && !htmlBody) throw new ValidationError('Email body is required');
  const sendgridConfig = await settingsRepository.getSendGridConfig();
  if (!hasApiConfig(sendgridConfig) && !hasSmtpConfig(sendgridConfig)) {
    throw new ValidationError('SendGrid is not configured');
  }

  try {
    const deliveryParams = {
      sendgridConfig,
      toRecipients,
      ccRecipients,
      bccRecipients,
      from,
      replyTo,
      emailSubject,
      htmlBody,
      textBody,
      customArgs,
    };
    return hasApiConfig(sendgridConfig)
      ? sendViaSendgridApi(deliveryParams)
      : sendViaSmtp(deliveryParams);
  } catch (error) {
    const smtpMode = !hasApiConfig(sendgridConfig) && hasSmtpConfig(sendgridConfig);
    const classified = smtpMode ? classifySmtpError(error) : classifySendgridError(error);
    const wrapped = new ExternalAPIError(smtpMode ? 'SendGrid SMTP' : 'SendGrid', smtpMode ? smtpErrorMessage(error) : sendgridErrorMessage(error), error);
    wrapped.providerStatus = classified.status;
    wrapped.retryable = classified.retryable;
    wrapped.errorClass = classified.errorClass;
    throw wrapped;
  }
}

export async function sendAssignmentEmail({ to, subject, body }) {
  return sendEmail({
    to,
    subject: subject || 'Ticket Pulse priority assignment',
    text: body,
  });
}

export default {
  sendEmail,
  sendAssignmentEmail,
};
