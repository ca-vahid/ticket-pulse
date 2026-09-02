import axios from 'axios';
import nodemailer from 'nodemailer';
import settingsRepository from './settingsRepository.js';
import emailHealthService from './emailHealthService.js';
import logger from '../utils/logger.js';
import { ExternalAPIError, ValidationError } from '../utils/errors.js';
import { formatSender, sanitizeFromName } from '../utils/emailSender.js';
import { buildOutboundMessageId, domainOfAddress, normalizeMessageId } from './emailThreadingService.js';

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

/**
 * Drop every address in `list` that already appears in `taken`
 * (case-insensitive). SendGrid rejects a message whose to/cc/bcc share an
 * address ("Each email address in the personalization block should be
 * unique"), and SMTP servers would deliver twice — so the provider guard
 * lives here, not in each caller (Phase CC, QA 08-26 #1).
 */
function withoutAddresses(list, taken) {
  const seen = new Set(taken.map((email) => email.toLowerCase()));
  return list.filter((email) => !seen.has(email.toLowerCase()));
}

// SendGrid caps the whole message at 30 MB; keep headroom for body + base64
// overhead. Callers pre-filter per file (the reply path keeps ≤3 MB/file).
export const MAX_ATTACHMENT_PAYLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Normalize caller attachments into one shape for both delivery paths.
 * Accepts the Graph-style `{name, contentType, contentBytes}` the reply path
 * already builds AND the plainer `{filename, type, content}`; `content` may
 * be a base64 string or a Buffer. Empty/oversized entries are dropped and
 * reported through `dropped` so callers can log honestly instead of
 * silently losing files.
 */
function normalizeAttachments(value) {
  const list = Array.isArray(value) ? value : [];
  const kept = [];
  const dropped = [];
  let totalBase64Bytes = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const filename = trim(item.filename || item.name) || 'attachment';
    const contentType = trim(item.contentType || item.type) || 'application/octet-stream';
    const raw = item.contentBytes ?? item.content;
    const contentBase64 = Buffer.isBuffer(raw) ? raw.toString('base64') : trim(raw);
    if (!contentBase64) {
      dropped.push({ filename, reason: 'empty' });
      continue;
    }
    if (totalBase64Bytes + contentBase64.length > MAX_ATTACHMENT_PAYLOAD_BYTES) {
      dropped.push({ filename, reason: 'payload_cap' });
      continue;
    }
    totalBase64Bytes += contentBase64.length;
    const contentId = trim(item.contentId || item.cid) || null;
    kept.push({ filename, contentType, contentBase64, ...(contentId ? { contentId } : {}) });
  }
  return { attachments: kept, dropped };
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

/**
 * RFC 5322 threading headers for the wire (Mega 08-31 Phase MB-1b/1h):
 * our own Message-ID (so ingest rung 1 can match replies to SendGrid-sent
 * mail) plus In-Reply-To / References. All optional; returns {} when none.
 */
function threadingHeaders({ messageId, inReplyTo, references }) {
  const headers = {};
  const mid = normalizeMessageId(messageId);
  if (mid) headers['Message-ID'] = mid;
  const irt = normalizeMessageId(inReplyTo);
  if (irt) headers['In-Reply-To'] = irt;
  const refs = (Array.isArray(references) ? references : [references])
    .map(normalizeMessageId).filter(Boolean);
  if (refs.length > 0) headers.References = refs.join(' ');
  return headers;
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
  fromName,
  replyTo,
  emailSubject,
  htmlBody,
  textBody,
  customArgs,
  attachments,
  threading = {},
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
  // SendGrid v3 attachments: base64 content + filename + type (+ disposition).
  const apiAttachments = attachments.map((a) => ({
    content: a.contentBase64,
    filename: a.filename,
    type: a.contentType,
    disposition: a.contentId ? 'inline' : 'attachment',
    ...(a.contentId ? { content_id: a.contentId } : {}),
  }));

  // SendGrid v3 supports from.name natively — never stuff the display name
  // into from.email (that breaks sender verification matching). Callers
  // without a workspace-resolved name fall back to the global default that
  // getSendGridConfig already carries.
  const fromAddress = trim(from) || sendgridConfig.fromEmail;
  const senderName = sanitizeFromName(fromName) || sanitizeFromName(sendgridConfig.fromName);
  const payload = {
    personalizations: [personalization],
    from: senderName ? { email: fromAddress, name: senderName } : { email: fromAddress },
    subject: emailSubject,
    content,
  };
  if (apiAttachments.length > 0) payload.attachments = apiAttachments;
  const normalizedReplyTo = trim(replyTo);
  if (normalizedReplyTo) payload.reply_to = { email: normalizedReplyTo };
  // Custom headers ride the top-level `headers` map (SendGrid keeps a
  // caller-supplied Message-ID; custom_args stay on the personalization).
  const wireHeaders = threadingHeaders(threading);
  if (Object.keys(wireHeaders).length > 0) payload.headers = wireHeaders;

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
    messageId: wireHeaders['Message-ID'] || null,
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
  fromName,
  replyTo,
  emailSubject,
  htmlBody,
  textBody,
  customArgs,
  attachments,
  threading = {},
}) {
  const wireHeaders = threadingHeaders(threading);
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
    // RFC 5322 `"Name" <addr>` (nodemailer passes the header through);
    // falls back to the global default name from getSendGridConfig.
    from: formatSender({
      name: sanitizeFromName(fromName) || sanitizeFromName(sendgridConfig.fromName),
      email: trim(from) || sendgridConfig.smtpFromEmail,
    }),
    to: toRecipients,
    cc: ccRecipients.length > 0 ? ccRecipients : undefined,
    bcc: bccRecipients.length > 0 ? bccRecipients : undefined,
    subject: emailSubject,
    text: textBody || undefined,
    html: htmlBody || undefined,
    replyTo: trim(replyTo) || undefined,
    headers: customArgsToHeaders(customArgs),
    // nodemailer sets these as proper headers (and generates a Message-ID
    // of its own when we pass none).
    messageId: wireHeaders['Message-ID'] || undefined,
    inReplyTo: wireHeaders['In-Reply-To'] || undefined,
    references: wireHeaders.References || undefined,
    // nodemailer attachments: Buffer content + filename + contentType.
    attachments: attachments.length > 0
      ? attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.contentBase64, 'base64'),
        contentType: a.contentType,
        ...(a.contentId ? { cid: a.contentId, contentDisposition: 'inline' } : {}),
      }))
      : undefined,
  });

  return {
    provider: 'sendgrid_smtp',
    providerMessageId: info.messageId || null,
    messageId: wireHeaders['Message-ID'] || normalizeMessageId(info.messageId) || null,
    status: 'accepted',
    to: toRecipients,
  };
}

export async function sendEmail({
  to,
  cc = [],
  bcc = [],
  from = null,
  fromName = null,
  replyTo = null,
  subject,
  html = null,
  text = null,
  customArgs = null,
  context = null,
  workspaceId = null,
  attachments: rawAttachments = [],
  // Threading (Mega 08-31 Phase MB-1b/1h): pass an explicit Message-ID, or a
  // `ticketIdForMessageId` and one is minted as `<tp-<ticketId>-<random>@<from
  // domain>>`; In-Reply-To / References ride along when given. The result
  // echoes `messageId` so callers can store it on the thread entry.
  messageId = null,
  ticketIdForMessageId = null,
  inReplyTo = null,
  references = [],
}) {
  const toRecipients = normalizeEmailList(to);
  // Provider guard (Phase CC3): an address may appear in exactly one of
  // to/cc/bcc — SendGrid rejects duplicates across the personalization,
  // and SMTP would deliver the same message twice.
  const ccRecipients = withoutAddresses(normalizeEmailList(cc), toRecipients);
  const bccRecipients = withoutAddresses(normalizeEmailList(bcc), [...toRecipients, ...ccRecipients]);
  const { attachments, dropped: droppedAttachments } = normalizeAttachments(rawAttachments);
  if (droppedAttachments.length > 0) {
    logger.warn(`sendEmail: ${droppedAttachments.length} attachment(s) not sent (${droppedAttachments.map((d) => `${d.filename}: ${d.reason}`).join(', ')})`);
  }
  const textBody = trim(text);
  const htmlBody = trim(html);
  const emailSubject = trim(subject) || 'Ticket Pulse notification';

  if (toRecipients.length === 0) throw new ValidationError('Email recipient is required');
  if (!textBody && !htmlBody) throw new ValidationError('Email body is required');
  const sendgridConfig = await settingsRepository.getSendGridConfig();
  if (!hasApiConfig(sendgridConfig) && !hasSmtpConfig(sendgridConfig)) {
    throw new ValidationError('SendGrid is not configured');
  }

  const smtpMode = !hasApiConfig(sendgridConfig) && hasSmtpConfig(sendgridConfig);
  const provider = smtpMode ? 'sendgrid_smtp' : 'sendgrid';
  const fromAddress = trim(from) || (smtpMode ? sendgridConfig.smtpFromEmail : sendgridConfig.fromEmail);
  const threading = {
    messageId: normalizeMessageId(messageId)
      || (ticketIdForMessageId ? buildOutboundMessageId(ticketIdForMessageId, domainOfAddress(fromAddress)) : null),
    inReplyTo,
    references,
  };
  const startedAt = Date.now();
  try {
    const deliveryParams = {
      sendgridConfig,
      toRecipients,
      ccRecipients,
      bccRecipients,
      from,
      fromName,
      replyTo,
      emailSubject,
      htmlBody,
      textBody,
      customArgs,
      attachments,
      threading,
    };
    const result = smtpMode
      ? await sendViaSmtp(deliveryParams)
      : await sendViaSendgridApi(deliveryParams);
    await emailHealthService.recordSuccess({
      workspaceId, channel: 'email', context, provider,
      durationMs: Date.now() - startedAt, recipients: toRecipients,
    });
    return result;
  } catch (error) {
    const classified = smtpMode ? classifySmtpError(error) : classifySendgridError(error);
    const wrapped = new ExternalAPIError(smtpMode ? 'SendGrid SMTP' : 'SendGrid', smtpMode ? smtpErrorMessage(error) : sendgridErrorMessage(error), error);
    wrapped.providerStatus = classified.status;
    wrapped.retryable = classified.retryable;
    wrapped.errorClass = classified.errorClass;
    await emailHealthService.recordFailure({
      workspaceId, channel: 'email', context, provider,
      error: wrapped, durationMs: Date.now() - startedAt, recipients: toRecipients,
    });
    throw wrapped;
  }
}

export async function sendAssignmentEmail({ to, subject, body, fromName = null, context = 'assignment' }) {
  return sendEmail({
    to,
    subject: subject || 'Ticket Pulse priority assignment',
    text: body,
    fromName,
    context,
  });
}

export default {
  sendEmail,
  sendAssignmentEmail,
};
