import { Liquid } from 'liquidjs';
import jsonLogic from 'json-logic-js';
import sanitizeHtml from 'sanitize-html';
import { randomUUID } from 'node:crypto';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import providerGateway from './aiProviders/providerGateway.js';
import { processDelivery } from './notificationDeliveryService.js';
import notificationWorkflowRepository from './notificationWorkflowRepository.js';
import {
  DEFAULT_LLM_OUTPUT_SCHEMA,
  assertValidWorkflowDefinition,
  normalizeLlmOutputSchema,
  sampleEventContext,
  validateLlmOutputSchema,
} from './notificationWorkflowDefinition.js';
import {
  appendSignatureToEmail,
  getWorkspaceSignature,
} from './notificationWorkflowSignatureService.js';
import { enrichEventContextWithPublicStatusUrl } from './publicTicketStatusService.js';
import {
  enrichEventContextWithNotificationPolicy,
  selectWorkflowsForNotificationTiming,
} from './notificationWorkflowPolicyService.js';

const liquid = new Liquid({
  strictFilters: false,
  strictVariables: false,
});

const MAX_NODE_EXECUTIONS = 60;
const MAX_EMAIL_RECIPIENTS = 25;
const DEFAULT_LLM_MAX_TOKENS = 10000;
const MAX_LLM_MAX_TOKENS = 10000;
const EMAIL_NODE_TYPES = new Set(['send_email']);

function safeJson(value) {
  return JSON.parse(JSON.stringify(value ?? null, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Date) return item.toISOString();
    return item;
  }));
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function elapsedMs(startedAt) {
  return Date.now() - startedAt;
}

function llmMaxTokens(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LLM_MAX_TOKENS;
  return Math.min(Math.max(parsed, 200), MAX_LLM_MAX_TOKENS);
}

function llmTokenDiagnostics(response, requestedMaxTokens) {
  const usage = response?.usage || {};
  const metadata = response?.metadata || {};
  const outputTokens = Number(usage.outputTokens || 0);
  const tokenLimitHit = metadata.tokenLimitHit === true
    || metadata.stopReason === 'max_tokens'
    || metadata.incompleteReason === 'max_output_tokens'
    || (requestedMaxTokens > 0 && outputTokens >= requestedMaxTokens);
  const outputLimitPercent = requestedMaxTokens > 0 && outputTokens > 0
    ? Math.round((outputTokens / requestedMaxTokens) * 100)
    : null;
  return {
    requestedMaxTokens,
    inputTokens: usage.inputTokens || null,
    outputTokens: usage.outputTokens || null,
    totalTokens: usage.totalTokens || null,
    outputLimitPercent,
    stopReason: metadata.stopReason || null,
    incompleteReason: metadata.incompleteReason || null,
    tokenLimitHit,
    nearTokenLimit: !tokenLimitHit && outputLimitPercent !== null && outputLimitPercent >= 90,
  };
}

function uniqueEmails(values) {
  const result = [];
  for (const value of values.flat()) {
    const email = String(value || '').trim();
    if (!email || !email.includes('@')) continue;
    if (result.some((candidate) => candidate.toLowerCase() === email.toLowerCase())) continue;
    result.push(email);
  }
  return result;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textToEmailHtml(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text
    .split(/\n{2,}/)
    .map((paragraph) => {
      const html = escapeHtml(paragraph.trim()).replace(/\n/g, '<br>');
      return html ? `<p>${html}</p>` : '';
    })
    .filter(Boolean)
    .join('');
}

function sanitizeEmailHtml(html) {
  const rendered = String(html || '').trim();
  if (!rendered) return null;
  return sanitizeHtml(rendered, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'h1',
      'h2',
      'span',
      'img',
    ],
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      span: ['style'],
      p: ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
  });
}

function publicStatusUrlFromContext(context) {
  return String(context?.ticket?.publicStatusUrl || context?.publicStatusUrl || '').trim();
}

function raiseUrgencyUrlFromContext(context) {
  return String(
    context?.ticket?.raiseUrgencyUrl
    || context?.ticket?.urgencyRaiseUrl
    || context?.raiseUrgencyUrl
    || '',
  ).trim();
}

function afterHoursSupportUrlFromContext(context) {
  return String(
    context?.afterHoursSupport?.immediateSupportUrl
    || context?.ticket?.afterHoursEscalationUrl
    || context?.afterHoursEscalationUrl
    || context?.afterHoursSupport?.selfEscalationUrl
    || context?.ticket?.selfEscalationUrl
    || context?.selfEscalationUrl
    || '',
  ).trim();
}

function actionBlockTableHtml({
  tone = 'blue',
  title,
  body,
  buttonLabel,
  url,
  rows = [],
  footnote = null,
}) {
  const escapedUrl = escapeHtml(url);
  const palette = {
    blue: {
      border: '#bfdbfe',
      background: '#eff6ff',
      heading: '#1e3a8a',
      text: '#334155',
      button: '#1d4ed8',
      buttonText: '#ffffff',
      rowBackground: '#ffffff',
    },
    amber: {
      border: '#fed7aa',
      background: '#fff7ed',
      heading: '#7c2d12',
      text: '#7c2d12',
      button: '#c2410c',
      buttonText: '#ffffff',
      rowBackground: '#ffffff',
    },
    red: {
      border: '#fecaca',
      background: '#fef2f2',
      heading: '#7f1d1d',
      text: '#7f1d1d',
      button: '#dc2626',
      buttonText: '#ffffff',
      rowBackground: '#ffffff',
    },
  }[tone] || {};
  const rowHtml = rows
    .filter((row) => row?.label && row?.value)
    .map((row) => [
      '<tr>',
      `<td style="padding:10px 12px;border-top:1px solid ${palette.border};font-size:13px;font-weight:700;color:${palette.heading};width:34%;">${escapeHtml(row.label)}</td>`,
      `<td style="padding:10px 12px;border-top:1px solid ${palette.border};font-size:13px;color:${palette.text};">${row.html || escapeHtml(row.value)}</td>`,
      '</tr>',
    ].join(''))
    .join('');
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;margin:22px 0 16px;">',
    '<tr>',
    `<td style="border:2px solid ${palette.border};background:${palette.background};padding:0;">`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">',
    '<tr>',
    `<td style="padding:16px 18px 10px;font-family:Arial,Helvetica,sans-serif;color:${palette.text};">`,
    `<div style="font-size:16px;font-weight:700;color:${palette.heading};line-height:1.35;">${escapeHtml(title)}</div>`,
    `<div style="margin-top:8px;font-size:14px;line-height:1.55;">${escapeHtml(body)}</div>`,
    '</td>',
    '</tr>',
    rowHtml ? `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${palette.rowBackground};">${rowHtml}</table></td></tr>` : '',
    '<tr>',
    '<td style="padding:14px 18px 16px;font-family:Arial,Helvetica,sans-serif;">',
    `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:${palette.button};color:${palette.buttonText};font-size:14px;font-weight:700;line-height:20px;text-decoration:none;padding:10px 16px;border-radius:4px;">${escapeHtml(buttonLabel)}</a>`,
    footnote ? `<div style="margin-top:12px;font-size:12px;line-height:1.5;color:#64748b;">${escapeHtml(footnote)}</div>` : '',
    '</td>',
    '</tr>',
    '</table>',
    '</td>',
    '</tr>',
    '</table>',
  ].join('');
}

function publicStatusLinkBlockHtml(url) {
  return actionBlockTableHtml({
    tone: 'blue',
    title: 'Check the latest ticket status',
    body: 'Use this Ticket Pulse link to see the latest status, current assignee, and estimated resolution window for your ticket.',
    buttonLabel: 'View ticket status and estimate',
    url,
    rows: [
      { label: 'Status page', value: 'Always shows the latest Ticket Pulse status for this ticket.' },
      { label: 'Assignment', value: 'The assigned person may change as the team works through the request.' },
    ],
    footnote: 'This link stays with the ticket even if it moves between people.',
  });
}

function publicStatusLinkBlockText(url) {
  return [
    'Check the latest ticket status',
    '',
    'You can use this link to see the latest status, current assignee, and estimated resolution window for your ticket:',
    url,
    '',
    'The assigned person may change as the team works through the request. This link will keep showing the latest Ticket Pulse status for this ticket.',
  ].join('\n');
}

function raiseUrgencyLinkBlockHtml(url) {
  return actionBlockTableHtml({
    tone: 'amber',
    title: 'Need this reviewed as urgent?',
    body: 'If this ticket needs priority attention during business hours, you can raise it to Urgent from Ticket Pulse.',
    buttonLabel: 'Raise ticket urgency',
    url,
    rows: [
      { label: 'Business-hours only', value: 'This does not request after-hours emergency support.' },
      { label: 'Notification path', value: 'The assigned agent may be notified through their High/Urgent preferences.' },
    ],
  });
}

function raiseUrgencyLinkBlockText(url) {
  return [
    'Need this reviewed as urgent?',
    '',
    'If this ticket needs priority attention during business hours, you can raise it to Urgent from Ticket Pulse. This does not request after-hours emergency support:',
    url,
  ].join('\n');
}

function afterHoursSupportLinkBlockHtml(url, context = {}) {
  const activeContact = context?.afterHoursSupport?.activeContact || {};
  const phone = String(activeContact.phone || '').trim();
  const phoneHtml = phone
    ? `<a href="tel:${escapeHtml(phone.replace(/[^\d+]/g, ''))}" style="color:#991b1b;font-weight:700;text-decoration:none;">${escapeHtml(phone)}</a>`
    : '<span style="color:#991b1b;font-weight:700;">Phone not configured</span>';
  return actionBlockTableHtml({
    tone: 'red',
    title: 'Need immediate after-hours support?',
    body: 'If this cannot wait until the next business-hours window, use this Ticket Pulse link to review the after-hours response window and request immediate support.',
    buttonLabel: 'Request immediate support',
    url,
    rows: [
      { label: 'Active contact', value: activeContact.name || 'After-hours support' },
      { label: 'Phone', value: phone || 'Phone not configured', html: phoneHtml },
      { label: 'Response window', value: 'The request is sent to the configured after-hours escalation roster after confirmation.' },
    ],
    footnote: activeContact.rotationLabel || null,
  });
}

function afterHoursSupportLinkBlockText(url, context = {}) {
  const activeContact = context?.afterHoursSupport?.activeContact || {};
  const phone = String(activeContact.phone || '').trim();
  return [
    'Need immediate after-hours support?',
    '',
    'If this cannot wait until the next business-hours window, use this Ticket Pulse link to review the after-hours response window and request immediate support:',
    phone ? `Active after-hours phone: ${phone}` : 'Active after-hours phone: not configured',
    url,
    activeContact.rotationLabel ? `Contact selection: ${activeContact.rotationLabel}` : null,
  ].join('\n');
}

function actionLinkOptions(options = {}) {
  const mode = options.actionLinkRenderMode || (options.forceActionLinks ? 'force_all_enabled' : 'live');
  return {
    ...options,
    forceActionLinks: mode === 'force_all_enabled',
    actionLinkRenderMode: mode,
  };
}

function isAfterHoursWorkflowMode(options = {}) {
  return options.workflowScheduleMode === 'after_hours';
}

function isBusinessHoursContext(context = {}) {
  const availability = context.availability || {};
  if (availability.isHoliday === true) return false;
  if (availability.isBusinessHours === true) return true;
  if (availability.isAfterHours === true) return false;
  return true;
}

function isAfterHoursContext(context = {}, options = {}) {
  const availability = context.availability || {};
  return isAfterHoursWorkflowMode(options)
    || availability.isHoliday === true
    || availability.isAfterHours === true
    || availability.isBusinessHours === false;
}

function actionLinkDiagnostic(email = {}, key, diagnostic) {
  return {
    ...email,
    actionLinks: {
      ...(email.actionLinks || {}),
      [key]: diagnostic,
    },
  };
}

function skipActionLink(email, key, legacyPrefix, reason, extra = {}) {
  return actionLinkDiagnostic({
    ...email,
    [`${legacyPrefix}LinkSkipped`]: true,
    [`${legacyPrefix}LinkSkipReason`]: reason,
  }, key, {
    requested: true,
    applied: false,
    skipped: true,
    reason,
    ...extra,
  });
}

function applyActionLink(email, key, legacyFields, url, htmlBlock, textBlock, diagnostic = {}) {
  const html = [email.html, htmlBlock].filter(Boolean).join('\n');
  const text = [email.text || stripHtml(email.html), textBlock].filter(Boolean).join('\n\n');
  return actionLinkDiagnostic({
    ...email,
    ...legacyFields,
    html: html || null,
    text: text || null,
  }, key, {
    requested: true,
    applied: true,
    skipped: false,
    url,
    ...diagnostic,
  });
}

function appendPublicStatusLinkToEmail(email = {}, context = {}, enabled = false, options = {}) {
  if (!enabled || email.publicStatusLinkApplied) return email;
  const url = publicStatusUrlFromContext(context);
  if (!url) {
    return skipActionLink(
      email,
      'publicStatus',
      'publicStatus',
      'No public ticket status URL is available for this ticket',
      { actionLinkRenderMode: actionLinkOptions(options).actionLinkRenderMode },
    );
  }

  return applyActionLink(
    email,
    'publicStatus',
    { publicStatusLinkApplied: true, publicStatusUrl: url },
    url,
    publicStatusLinkBlockHtml(url),
    publicStatusLinkBlockText(url),
    { actionLinkRenderMode: actionLinkOptions(options).actionLinkRenderMode },
  );
}

function appendRaiseUrgencyLinkToEmail(email = {}, context = {}, enabled = false, options = {}) {
  const effectiveOptions = actionLinkOptions(options);
  if (!enabled || email.raiseUrgencyLinkApplied) return email;
  const url = raiseUrgencyUrlFromContext(context);
  if (!url) {
    return skipActionLink(
      email,
      'raiseUrgency',
      'raiseUrgency',
      'No business-hours urgency URL is available for this ticket. Check the workspace urgent escalation settings.',
      { actionLinkRenderMode: effectiveOptions.actionLinkRenderMode },
    );
  }
  const liveAllowed = isBusinessHoursContext(context);
  const liveWouldSkipReason = liveAllowed
    ? null
    : 'Business-hours urgency links are hidden outside business hours. Use the after-hours immediate support link instead.';
  if (!effectiveOptions.forceActionLinks && liveWouldSkipReason) {
    return skipActionLink(email, 'raiseUrgency', 'raiseUrgency', liveWouldSkipReason, {
      url,
      actionLinkRenderMode: effectiveOptions.actionLinkRenderMode,
    });
  }

  return applyActionLink(
    email,
    'raiseUrgency',
    { raiseUrgencyLinkApplied: true, raiseUrgencyUrl: url },
    url,
    raiseUrgencyLinkBlockHtml(url),
    raiseUrgencyLinkBlockText(url),
    {
      forced: effectiveOptions.forceActionLinks && Boolean(liveWouldSkipReason),
      liveWouldSkipReason,
      actionLinkRenderMode: effectiveOptions.actionLinkRenderMode,
    },
  );
}

function appendAfterHoursSupportLinkToEmail(email = {}, context = {}, enabled = false, options = {}) {
  const effectiveOptions = actionLinkOptions(options);
  if (!enabled || email.afterHoursSupportLinkApplied) return email;
  const url = afterHoursSupportUrlFromContext(context);
  if (!url) {
    return skipActionLink(
      email,
      'afterHoursSupport',
      'afterHoursSupport',
      'No after-hours immediate support URL is available. Check that requester self-escalation is enabled.',
      { actionLinkRenderMode: effectiveOptions.actionLinkRenderMode },
    );
  }
  const activeContact = context?.afterHoursSupport?.activeContact || null;
  const contactPhone = String(activeContact?.phone || '').trim();
  const missingPhoneReason = contactPhone
    ? null
    : 'No active after-hours contact phone is available for requester emails.';
  const liveAllowed = isAfterHoursContext(context, effectiveOptions);
  const liveWouldSkipReason = liveAllowed
    ? missingPhoneReason
    : 'After-hours immediate support links are hidden during business hours unless the after-hours workflow is running.';
  if (!effectiveOptions.forceActionLinks && liveWouldSkipReason) {
    return skipActionLink(email, 'afterHoursSupport', 'afterHoursSupport', liveWouldSkipReason, {
      url,
      activeContact,
      actionLinkRenderMode: effectiveOptions.actionLinkRenderMode,
    });
  }

  return applyActionLink(
    email,
    'afterHoursSupport',
    { afterHoursSupportLinkApplied: true, afterHoursSupportUrl: url },
    url,
    afterHoursSupportLinkBlockHtml(url, context),
    afterHoursSupportLinkBlockText(url, context),
    {
      activeContact,
      missingActiveContactPhone: Boolean(missingPhoneReason),
      warning: missingPhoneReason,
      forced: effectiveOptions.forceActionLinks && Boolean(liveWouldSkipReason),
      liveWouldSkipReason,
      actionLinkRenderMode: effectiveOptions.actionLinkRenderMode,
    },
  );
}

function appendWorkflowActionLinksToEmail(email = {}, context = {}, nodeData = {}, options = {}) {
  const effectiveOptions = actionLinkOptions(options);
  let next = appendPublicStatusLinkToEmail(email, context, nodeData?.appendPublicStatusLink === true, effectiveOptions);
  next = appendRaiseUrgencyLinkToEmail(next, context, nodeData?.appendRaiseUrgencyLink === true, effectiveOptions);
  next = appendAfterHoursSupportLinkToEmail(next, context, nodeData?.appendAfterHoursSupportLink === true, effectiveOptions);
  return next;
}

function schemaTypeMatches(value, type) {
  if (value === null || value === undefined) return false;
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'object') return typeof value === 'object' && !Array.isArray(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateLlmPayloadAgainstSchema(payload, schema) {
  const outputSchema = normalizeLlmOutputSchema(schema || DEFAULT_LLM_OUTPUT_SCHEMA);
  const schemaResult = validateLlmOutputSchema(outputSchema);
  if (!schemaResult.success) {
    throw new Error(schemaResult.errors.join('; '));
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('LLM response must be a JSON object');
  }
  const errors = [];
  for (const field of outputSchema.required || []) {
    const value = payload[field];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      errors.push(`LLM response missing required field ${field}`);
    }
  }
  for (const [field, config] of Object.entries(outputSchema.properties || {})) {
    if (payload[field] === undefined || payload[field] === null) continue;
    if (!schemaTypeMatches(payload[field], config.type)) {
      errors.push(`LLM response field ${field} must be ${config.type}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
  return outputSchema;
}

function normalizeLlmPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload, repairedFields: [] };
  }
  const next = { ...payload };
  const repairedFields = [];
  if ((!next.subject || !String(next.subject).trim()) && next.title) {
    next.subject = next.title;
    repairedFields.push('subject');
  }
  if ((!next.html || !String(next.html).trim()) && next.bodyHtml) {
    next.html = next.bodyHtml;
    repairedFields.push('html');
  }
  if ((!next.text || !String(next.text).trim()) && next.body) {
    next.text = String(next.body).trim();
    repairedFields.push('text');
  }
  if ((!next.text || !String(next.text).trim()) && next.html) {
    next.text = stripHtml(next.html);
    repairedFields.push('text');
  }
  if ((!next.html || !String(next.html).trim()) && next.text) {
    next.html = textToEmailHtml(next.text);
    repairedFields.push('html');
  }
  return { payload: next, repairedFields: [...new Set(repairedFields)] };
}

function extraFieldsFromPayload(payload, schema) {
  const extras = {};
  for (const field of Object.keys(schema.properties || {})) {
    if (['subject', 'html', 'text'].includes(field)) continue;
    if (payload[field] !== undefined) extras[field] = payload[field];
  }
  return extras;
}

function outputSchemaFormat(schema) {
  const normalized = normalizeLlmOutputSchema(schema || DEFAULT_LLM_OUTPUT_SCHEMA);
  return {
    type: 'json_schema',
    name: 'notification_email',
    strict: true,
    schema: normalized,
  };
}

function templateContentSource(node) {
  const explicit = node.data?.contentSource;
  if (explicit) return explicit;
  const fields = [node.data?.subject, node.data?.html, node.data?.text].join('\n');
  return fields.includes('state.llm') ? 'advanced_liquid' : 'template_only';
}

function llmEmailFromState(state) {
  const email = state.llm?.email || {};
  const text = email.text || null;
  return {
    subject: email.subject || null,
    html: email.html || textToEmailHtml(text) || null,
    text,
  };
}

async function renderLiquid(template, context) {
  if (!template) return null;
  return liquid.parseAndRender(String(template), context);
}

function nodeById(definition) {
  return new Map(definition.nodes.map((node) => [node.id, node]));
}

function nextNodeIds(definition, node, output = {}) {
  const edges = definition.edges.filter((edge) => edge.source === node.id);
  if (edges.length === 0) return [];

  if (node.type === 'condition') {
    const wantedHandle = output.passed ? 'true' : 'false';
    const matching = edges.filter((edge) => String(edge.sourceHandle || '').toLowerCase() === wantedHandle);
    if (matching.length > 0) return matching.map((edge) => edge.target);
  }

  return edges
    .filter((edge) => !edge.sourceHandle || edge.sourceHandle === 'default')
    .map((edge) => edge.target);
}

function recipientFromToken(token, context, customEmails) {
  const value = String(token || '').trim();
  if (!value) return [];
  if (value === 'requester') return [context.requester?.email];
  if (value === 'assigned_agent') return [context.assignedAgent?.email];
  if (value === 'previous_agent') return [context.previousAgent?.email];
  if (value === 'custom_emails') return customEmails;
  if (value.includes('@')) return [value];
  return [];
}

function resolveRecipientList(tokens, context, customEmails) {
  const values = Array.isArray(tokens) ? tokens : [tokens];
  return uniqueEmails(values.map((token) => recipientFromToken(token, context, customEmails)));
}

function workflowVersion(workflow) {
  return workflow.versions?.find((version) => version.version === workflow.publishedVersion)
    || workflow.versions?.[0]
    || null;
}

function buildDedupeKey(workflow, eventContext) {
  const event = eventContext.event || {};
  const ticket = eventContext.ticket || {};
  const stamp = event.dedupeStamp || event.occurredAt || new Date().toISOString();
  return [
    'notification-workflow',
    workflow.id,
    workflow.publishedVersion || 0,
    event.type || workflow.triggerType,
    ticket.id || ticket.freshserviceTicketId || 'ticket',
    stamp,
  ].join(':').slice(0, 255);
}

function buildPreviewDedupeKey(workflow, eventContext) {
  const event = eventContext.event || {};
  const ticket = eventContext.ticket || {};
  return [
    'notification-workflow-preview',
    workflow.id,
    event.type || workflow.triggerType,
    ticket.id || ticket.freshserviceTicketId || 'ticket',
    Date.now(),
    randomUUID(),
  ].join(':').slice(0, 255);
}

function auditIdForRun(run) {
  return run?.id ? `TP-NWF-${run.id}` : null;
}

async function createRun({ workflow, version, eventContext, dryRun, triggerSource }) {
  return prisma.notificationWorkflowRun.create({
    data: {
      workspaceId: workflow.workspaceId,
      workflowId: workflow.id,
      workflowVersionId: version?.id || null,
      ticketId: eventContext.ticket?.id || null,
      eventType: eventContext.event?.type || workflow.triggerType,
      eventContext: safeJson(eventContext),
      triggerSource: triggerSource || eventContext.event?.source || null,
      dedupeKey: dryRun ? buildPreviewDedupeKey(workflow, eventContext) : buildDedupeKey(workflow, eventContext),
      dryRun,
    },
  });
}

async function startStep({ workflow, run, node, input, dryRun, previews }) {
  const startedAt = Date.now();
  let preview = null;
  if (dryRun) {
    preview = {
      nodeId: node.id,
      nodeType: node.type,
      stepRunId: null,
      status: 'running',
      input: safeJson(input),
      output: null,
      durationMs: null,
      error: null,
    };
    previews.push(preview);
  }

  if (!run) {
    return { startedAt, row: null, preview };
  }
  const row = await prisma.notificationWorkflowStepRun.create({
    data: {
      workspaceId: workflow.workspaceId,
      runId: run.id,
      nodeId: node.id,
      nodeType: node.type,
      input: safeJson(input),
    },
  });
  if (preview) preview.stepRunId = row.id;
  return { startedAt, row, preview };
}

async function finishStep(step, status, output = null, error = null) {
  const durationMs = elapsedMs(step.startedAt);
  if (step.preview) {
    Object.assign(step.preview, {
      status,
      output: safeJson(output),
      durationMs,
      error: error?.message || null,
    });
  }
  if (!step.row) return;
  await prisma.notificationWorkflowStepRun.update({
    where: { id: step.row.id },
    data: {
      status,
      output: output === undefined ? undefined : safeJson(output),
      completedAt: new Date(),
      durationMs,
      error: error?.message || null,
    },
  });
}

async function executeNode({
  workflow,
  run,
  step,
  node,
  state,
  eventContext,
  dryRun,
  executeLlm,
  actionLinkRenderMode = 'live',
  workflowScheduleMode = null,
}) {
  const scope = { ...eventContext, state };
  const actionLinkAppendOptions = {
    actionLinkRenderMode,
    workflowScheduleMode,
  };

  if (node.type === 'trigger') {
    return { eventType: eventContext.event?.type };
  }

  if (node.type === 'condition') {
    const rule = node.data?.rule || true;
    const passed = Boolean(jsonLogic.apply(rule, scope));
    return { passed, rule };
  }

  if (node.type === 'recipient_resolver') {
    const customEmails = Array.isArray(node.data?.customEmails) ? node.data.customEmails : [];
    const recipients = {
      to: resolveRecipientList(node.data?.to || ['requester'], eventContext, customEmails),
      cc: resolveRecipientList(node.data?.cc || [], eventContext, customEmails),
      bcc: resolveRecipientList(node.data?.bcc || [], eventContext, customEmails),
    };
    state.recipients = recipients;
    return { recipients };
  }

  if (node.type === 'template_render') {
    const contentSource = templateContentSource(node);
    const llmEmail = llmEmailFromState(state);
    const shouldRenderTemplate = contentSource !== 'llm_only';
    const subject = shouldRenderTemplate ? await renderLiquid(node.data?.subject, scope) : null;
    const rawHtml = shouldRenderTemplate ? await renderLiquid(node.data?.html, scope) : null;
    const rawText = shouldRenderTemplate && node.data?.plainTextMode !== 'auto'
      ? await renderLiquid(node.data?.text, scope)
      : null;
    const html = sanitizeEmailHtml(rawHtml);
    const text = String(rawText || stripHtml(html)).trim() || null;
    const useLlm = contentSource === 'llm_only' || contentSource === 'llm_with_template_fallback';
    state.email = {
      ...(state.email || {}),
      subject: useLlm
        ? (llmEmail.subject || String(subject || '').trim() || 'Ticket Pulse notification')
        : (String(subject || '').trim() || 'Ticket Pulse notification'),
      html: useLlm ? (llmEmail.html || html) : html,
      text: useLlm ? (llmEmail.text || text) : text,
    };
    state.email = appendWorkflowActionLinksToEmail(state.email, eventContext, node.data || {}, actionLinkAppendOptions);
    return {
      email: state.email,
      contentSource,
      actionLinks: state.email.actionLinks || {},
      publicStatusLinkApplied: state.email.publicStatusLinkApplied === true,
      publicStatusUrl: state.email.publicStatusUrl || null,
      publicStatusLinkSkipped: state.email.publicStatusLinkSkipped === true,
      publicStatusLinkSkipReason: state.email.publicStatusLinkSkipReason || null,
      raiseUrgencyLinkApplied: state.email.raiseUrgencyLinkApplied === true,
      raiseUrgencyUrl: state.email.raiseUrgencyUrl || null,
      raiseUrgencyLinkSkipped: state.email.raiseUrgencyLinkSkipped === true,
      raiseUrgencyLinkSkipReason: state.email.raiseUrgencyLinkSkipReason || null,
      afterHoursSupportLinkApplied: state.email.afterHoursSupportLinkApplied === true,
      afterHoursSupportUrl: state.email.afterHoursSupportUrl || null,
      afterHoursSupportLinkSkipped: state.email.afterHoursSupportLinkSkipped === true,
      afterHoursSupportLinkSkipReason: state.email.afterHoursSupportLinkSkipReason || null,
    };
  }

  if (node.type === 'llm_generate') {
    const prompt = await renderLiquid(node.data?.prompt, scope);
    if (dryRun && !executeLlm) {
      const skipped = {
        skipped: true,
        reason: 'LLM generation skipped during preview',
        prompt,
      };
      state.llm = skipped;
      return skipped;
    }

    let response = null;
    let parsed = null;
    let tokenDiagnostics = null;
    try {
      const outputSchema = normalizeLlmOutputSchema(node.data?.outputSchema || DEFAULT_LLM_OUTPUT_SCHEMA);
      const maxTokens = llmMaxTokens(node.data?.maxTokens);
      response = await providerGateway.sendJson({
        operation: 'notification_workflow_generation',
        workspaceId: workflow.workspaceId,
        runLinks: run?.id ? { notificationWorkflowRunId: run.id } : {},
        systemPrompt: node.data?.systemPrompt
          || 'You write concise, professional IT helpdesk notification emails. Return JSON with subject, html, and text fields.',
        userMessage: prompt || 'Generate the notification email content from the supplied ticket context.',
        maxTokens,
        temperature: Number.isFinite(Number(node.data?.temperature)) ? Number(node.data.temperature) : 0.3,
        extra: {
          jsonSchema: outputSchema,
          reasoning: { effort: node.data?.reasoningEffort || 'none' },
          text: {
            format: outputSchemaFormat(outputSchema),
            verbosity: node.data?.verbosity || 'medium',
          },
        },
      });
      tokenDiagnostics = llmTokenDiagnostics(response, maxTokens);
      parsed = response.parsed || {};
      const normalized = normalizeLlmPayload(parsed);
      const payload = normalized.payload;
      const schema = validateLlmPayloadAgainstSchema(payload, outputSchema);
      const html = sanitizeEmailHtml(payload.html || payload.bodyHtml)
        || sanitizeEmailHtml(textToEmailHtml(payload.text || payload.body));
      const text = String(payload.text || payload.body || stripHtml(html)).trim() || null;
      state.email = {
        ...(state.email || {}),
        subject: String(payload.subject || '').trim(),
        html,
        text,
      };
      state.llm = {
        provider: response.provider,
        model: response.model,
        fallbackUsed: response.fallbackUsed,
        fallbackReason: response.fallbackReason || null,
        usage: response.usage || null,
        tokenDiagnostics,
        tokenLimitHit: tokenDiagnostics.tokenLimitHit,
        tokenLimitWarning: tokenDiagnostics.tokenLimitHit
          ? `LLM output used ${tokenDiagnostics.outputTokens || 'unknown'} of ${maxTokens} allowed output tokens and may have been truncated.`
          : null,
        repairedFields: normalized.repairedFields,
        raw: normalized.repairedFields.length > 0 ? safeJson(parsed) : null,
        email: {
          subject: state.email.subject || null,
          html: state.email.html || null,
          text: state.email.text || null,
          extra: extraFieldsFromPayload(payload, schema),
        },
      };
      return {
        email: state.email,
        llm: state.llm,
      };
    } catch (error) {
      state.llm = {
        failed: true,
        error: error.message || 'LLM generation failed',
        provider: response?.provider || null,
        model: response?.model || null,
        fallbackUsed: response?.fallbackUsed || false,
        fallbackReason: response?.fallbackReason || null,
        usage: response?.usage || null,
        tokenDiagnostics,
        tokenLimitHit: tokenDiagnostics?.tokenLimitHit === true,
        tokenLimitWarning: tokenDiagnostics?.tokenLimitHit
          ? `LLM output used ${tokenDiagnostics.outputTokens || 'unknown'} of ${tokenDiagnostics.requestedMaxTokens || 'unknown'} allowed output tokens and may have been truncated.`
          : null,
        raw: parsed ? safeJson(parsed) : null,
        email: null,
      };
      if (node.data?.failWorkflowOnError === true) throw error;
      return {
        failed: true,
        error: state.llm.error,
        prompt,
      };
    }
  }

  if (EMAIL_NODE_TYPES.has(node.type)) {
    const recipients = state.recipients || { to: [], cc: [], bcc: [] };
    state.email = appendWorkflowActionLinksToEmail(state.email || {}, eventContext, node.data || {}, actionLinkAppendOptions);
    let signature = null;
    try {
      signature = await getWorkspaceSignature(workflow.workspaceId);
    } catch (error) {
      if (!dryRun) throw error;
      logger.debug('Skipping notification signature during preview because it could not be loaded', {
        workspaceId: workflow.workspaceId,
        error: error.message,
      });
    }
    const email = appendSignatureToEmail(state.email || {}, signature);
    state.email = email;
    const toRecipients = uniqueEmails(recipients.to || []);
    const ccRecipients = uniqueEmails(recipients.cc || []);
    const bccRecipients = uniqueEmails(recipients.bcc || []);
    const subject = email.subject || node.data?.subject || 'Ticket Pulse notification';
    const htmlBody = email.html || null;
    const textBody = email.text || stripHtml(htmlBody);

    if (toRecipients.length === 0) {
      return {
        skipped: true,
        reason: 'No recipient email address resolved',
      };
    }

    const output = {
      provider: node.data?.provider || 'sendgrid',
      toRecipients,
      ccRecipients,
      bccRecipients,
      subject,
      htmlBody,
      textBody,
      notificationType: node.data?.notificationType || eventContext.event?.type || workflow.triggerType,
      actionLinks: email.actionLinks || {},
    };

    if (toRecipients.length + ccRecipients.length + bccRecipients.length > MAX_EMAIL_RECIPIENTS) {
      throw new Error(`Email recipient count exceeds the ${MAX_EMAIL_RECIPIENTS} recipient limit`);
    }

    if (dryRun) {
      return { ...output, skipped: true, reason: 'Preview only' };
    }

    const delivery = await prisma.notificationDelivery.create({
      data: {
        workspaceId: workflow.workspaceId,
        ticketId: eventContext.ticket?.id,
        workflowRunId: run.id,
        workflowStepRunId: step.row?.id || null,
        channel: 'email',
        status: 'queued',
        provider: output.provider,
        eventType: eventContext.event?.type || workflow.triggerType,
        notificationType: output.notificationType,
        assessedPriority: eventContext.ticket?.priorityLabel || eventContext.ticket?.assessedPriority || null,
        recipient: toRecipients[0] || null,
        toRecipients,
        ccRecipients,
        bccRecipients,
        subject,
        htmlBody,
        textBody,
        fromAddress: node.data?.fromAddress || null,
        dedupeKey: `${run.dedupeKey}:email:${node.id}`.slice(0, 255),
        payload: safeJson({
          workflowId: workflow.id,
          workflowVersion: workflow.publishedVersion,
          nodeId: node.id,
          event: eventContext.event,
        }),
      },
    });

    const deliveryResult = await processDelivery(delivery);
    if (!deliveryResult.success) {
      throw new Error(deliveryResult.error || 'Email delivery failed');
    }
    return { ...output, deliveryId: delivery.id, deliveryResult };
  }

  if (node.type === 'stop') {
    return { stopped: true, reason: node.data?.reason || 'Workflow stopped' };
  }

  throw new Error(`Unsupported notification workflow node type: ${node.type}`);
}

export async function executeDefinition({
  workflow,
  definition,
  eventContext,
  dryRun = false,
  executeLlm = false,
  triggerSource = null,
  actionLinkRenderMode = 'live',
  forceActionLinks = false,
}) {
  const normalizedDefinition = assertValidWorkflowDefinition(definition, {
    triggerType: workflow.triggerType,
  });
  let normalizedContext = safeJson(eventContext || sampleEventContext(workflow.triggerType));
  normalizedContext = await enrichEventContextWithPublicStatusUrl(normalizedContext);
  const effectiveActionLinkRenderMode = forceActionLinks ? 'force_all_enabled' : actionLinkRenderMode;
  const workflowScheduleMode = normalizedDefinition.metadata?.scheduleMode
    || workflow?.publishedDefinition?.metadata?.scheduleMode
    || workflow?.draftDefinition?.metadata?.scheduleMode
    || null;
  const startedAt = Date.now();
  const state = {};
  const previews = [];
  const version = workflowVersion(workflow);
  let run = null;

  try {
    run = await createRun({
      workflow,
      version,
      eventContext: normalizedContext,
      dryRun,
      triggerSource,
    });
  } catch (error) {
    if (error?.code === 'P2002') {
      return {
        status: 'skipped',
        reason: 'Duplicate workflow event',
        workflowId: workflow.id,
      };
    }
    throw error;
  }

  const nodes = nodeById(normalizedDefinition);
  const trigger = normalizedDefinition.nodes.find((node) => node.type === 'trigger');
  const queue = [trigger.id];
  const executed = [];

  try {
    while (queue.length > 0) {
      if (executed.length >= MAX_NODE_EXECUTIONS) {
        throw new Error('Workflow exceeded maximum node executions');
      }

      const nodeId = queue.shift();
      const node = nodes.get(nodeId);
      if (!node) throw new Error(`Workflow node not found: ${nodeId}`);

      const step = await startStep({
        workflow,
        run,
        node,
        input: { event: normalizedContext.event, state },
        dryRun,
        previews,
      });

      try {
        const output = await executeNode({
          workflow,
          run,
          step,
          node,
          state,
          eventContext: normalizedContext,
          dryRun,
          executeLlm,
          actionLinkRenderMode: effectiveActionLinkRenderMode,
          workflowScheduleMode,
        });
        await finishStep(step, 'completed', output);
        executed.push({ nodeId: node.id, nodeType: node.type, output });

        if (node.type !== 'stop') {
          queue.push(...nextNodeIds(normalizedDefinition, node, output));
        }
      } catch (stepError) {
        await finishStep(step, 'failed', null, stepError);
        throw stepError;
      }
    }

    if (run) {
      await prisma.notificationWorkflowRun.update({
        where: { id: run.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          durationMs: elapsedMs(startedAt),
        },
      });
    }

    return {
      status: 'completed',
      runId: run?.id || null,
      auditId: auditIdForRun(run),
      workflowId: workflow.id,
      state: safeJson(state),
      steps: dryRun ? previews : executed,
    };
  } catch (error) {
    if (run) {
      await prisma.notificationWorkflowRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          completedAt: new Date(),
          durationMs: elapsedMs(startedAt),
          error: error.message,
        },
      });
    }
    if (dryRun) {
      return {
        status: 'failed',
        runId: run?.id || null,
        auditId: auditIdForRun(run),
        workflowId: workflow.id,
        error: error.message,
        state: safeJson(state),
        steps: previews,
      };
    }
    throw error;
  }
}

export async function executeWorkflow(workflow, eventContext, options = {}) {
  const eventOccurredAt = safeDate(eventContext?.event?.occurredAt);
  const enabledAt = safeDate(workflow.enabledAt);
  if (enabledAt && eventOccurredAt && eventOccurredAt < enabledAt) {
    return {
      status: 'skipped',
      reason: 'Event occurred before workflow was enabled',
      workflowId: workflow.id,
    };
  }

  if (!workflow.publishedDefinition) {
    return {
      status: 'skipped',
      reason: 'Workflow has no published definition',
      workflowId: workflow.id,
    };
  }

  return executeDefinition({
    workflow,
    definition: workflow.publishedDefinition,
    eventContext,
    dryRun: false,
    triggerSource: options.triggerSource,
  });
}

export async function executeForEvent(eventContext, options = {}) {
  const routedContext = await enrichEventContextWithNotificationPolicy(eventContext);
  const workspaceId = routedContext?.workspace?.id;
  const eventType = routedContext?.event?.type;
  if (!workspaceId || !eventType) return { status: 'skipped', reason: 'Missing workspace or event type' };

  const workflows = await notificationWorkflowRepository.listEnabledForEvent(workspaceId, eventType);
  const timing = selectWorkflowsForNotificationTiming(workflows, routedContext);
  const selectedWorkflows = timing.selected || [];
  const results = [];
  for (const workflow of selectedWorkflows) {
    try {
      results.push(await executeWorkflow(workflow, routedContext, {
        triggerSource: options.triggerSource || routedContext.event?.source || null,
      }));
    } catch (error) {
      logger.warn('Notification workflow execution failed', {
        workspaceId,
        workflowId: workflow.id,
        eventType,
        ticketId: routedContext.ticket?.id,
        error: error.message,
      });
      results.push({
        status: 'failed',
        workflowId: workflow.id,
        error: error.message,
      });
    }
  }

  return {
    status: 'completed',
    workflowCount: selectedWorkflows.length,
    availableWorkflowCount: workflows.length,
    suppressedWorkflowCount: timing.suppressed?.length || 0,
    timingMode: timing.mode,
    timingReason: timing.reason,
    availability: routedContext.availability || null,
    results,
  };
}

export async function executePreview({
  workflow,
  definition = null,
  eventContext = null,
  executeLlm = false,
  forceActionLinks = false,
}) {
  return executeDefinition({
    workflow,
    definition: definition || workflow.draftDefinition,
    eventContext: eventContext || sampleEventContext(workflow.triggerType),
    dryRun: true,
    executeLlm,
    triggerSource: 'preview',
    forceActionLinks,
    actionLinkRenderMode: forceActionLinks ? 'force_all_enabled' : 'live',
  });
}

export default {
  executeDefinition,
  executeWorkflow,
  executeForEvent,
  executePreview,
};
