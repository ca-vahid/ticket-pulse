import { z } from 'zod';
import { ValidationError } from '../utils/errors.js';

export const NOTIFICATION_EVENT_TYPES = [
  'ticket.created',
  'ticket.assigned',
  'ticket.reassigned',
  'ticket.resolved_closed',
];

export const AFTER_HOURS_WORKFLOW_KEY = 'ticket_created_after_hours';

export const DEFAULT_WORKFLOW_SPECS = [
  { key: defaultWorkflowKey('ticket.created'), triggerType: 'ticket.created', scheduleMode: 'standard' },
  { key: AFTER_HOURS_WORKFLOW_KEY, triggerType: 'ticket.created', scheduleMode: 'after_hours' },
  { key: defaultWorkflowKey('ticket.assigned'), triggerType: 'ticket.assigned', scheduleMode: 'standard' },
  { key: defaultWorkflowKey('ticket.reassigned'), triggerType: 'ticket.reassigned', scheduleMode: 'standard' },
  { key: defaultWorkflowKey('ticket.resolved_closed'), triggerType: 'ticket.resolved_closed', scheduleMode: 'standard' },
];

export const NOTIFICATION_NODE_TYPES = [
  'trigger',
  'condition',
  'recipient_resolver',
  'llm_generate',
  'template_render',
  'send_email',
  'stop',
];

export const DEFAULT_LLM_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'html', 'text'],
  properties: {
    subject: {
      type: 'string',
      title: 'Subject',
      description: 'Final email subject line.',
    },
    html: {
      type: 'string',
      title: 'HTML body',
      description: 'Final rich HTML email body without the workspace signature.',
    },
    text: {
      type: 'string',
      title: 'Plain text body',
      description: 'Plain-text fallback body without the workspace signature.',
    },
    confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      title: 'Confidence',
      description: 'Optional confidence in the generated email content.',
    },
    citedSignals: {
      type: 'array',
      title: 'Cited signals',
      description: 'Optional evidence IDs or signal names used to shape the response.',
      items: { type: 'string' },
    },
    unsupportedClaimsRemoved: {
      type: 'array',
      title: 'Unsupported claims removed',
      description: 'Optional unsupported outage or impact claims removed from requester-facing copy.',
      items: { type: 'string' },
    },
  },
};

const REQUIRED_LLM_OUTPUT_FIELDS = ['subject', 'html', 'text'];
const ALLOWED_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);
const TEMPLATE_CONTENT_SOURCES = new Set([
  'llm_with_template_fallback',
  'template_only',
  'llm_only',
  'advanced_liquid',
]);

const idSchema = z.string().trim().min(1).max(120);

const workflowNodeSchema = z.object({
  id: idSchema,
  type: z.enum(NOTIFICATION_NODE_TYPES),
  position: z.object({
    x: z.number(),
    y: z.number(),
  }).optional(),
  data: z.record(z.any()).default({}),
});

const workflowEdgeSchema = z.object({
  id: idSchema,
  source: idSchema,
  target: idSchema,
  sourceHandle: z.string().trim().max(40).optional().nullable(),
  targetHandle: z.string().trim().max(40).optional().nullable(),
  label: z.string().trim().max(80).optional().nullable(),
});

export const workflowDefinitionSchema = z.object({
  version: z.literal(1).default(1),
  nodes: z.array(workflowNodeSchema).min(2).max(30),
  edges: z.array(workflowEdgeSchema).max(60).default([]),
  metadata: z.record(z.any()).default({}),
});

function validateGraph(definition, triggerType) {
  const errors = [];
  const ids = new Set();

  for (const node of definition.nodes) {
    if (ids.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    ids.add(node.id);
  }

  const triggerNodes = definition.nodes.filter((node) => node.type === 'trigger');
  if (triggerNodes.length !== 1) {
    errors.push('Workflow must have exactly one trigger node');
  } else if (triggerNodes[0].data?.triggerType !== triggerType) {
    errors.push(`Trigger node must use triggerType ${triggerType}`);
  }

  if (!definition.nodes.some((node) => node.type === 'send_email')) {
    errors.push('Workflow must include at least one send_email node');
  }

  for (const edge of definition.edges) {
    if (!ids.has(edge.source)) errors.push(`Edge ${edge.id} has unknown source ${edge.source}`);
    if (!ids.has(edge.target)) errors.push(`Edge ${edge.id} has unknown target ${edge.target}`);
  }

  for (const node of definition.nodes) {
    if (node.type === 'llm_generate') {
      const schemaResult = validateLlmOutputSchema(node.data?.outputSchema || DEFAULT_LLM_OUTPUT_SCHEMA);
      if (!schemaResult.success) {
        errors.push(...schemaResult.errors.map((error) => `LLM node ${node.id}: ${error}`));
      }
    }

    if (node.type === 'template_render') {
      const source = node.data?.contentSource;
      if (source && !TEMPLATE_CONTENT_SOURCES.has(source)) {
        errors.push(`Template node ${node.id}: unsupported contentSource ${source}`);
      }
    }
  }

  return errors;
}

export function validateLlmOutputSchema(schema) {
  const errors = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { success: false, errors: ['Output schema must be a JSON object'] };
  }
  if (schema.type !== 'object') errors.push('Output schema type must be object');
  if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    errors.push('Output schema must define properties');
  }

  const properties = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const field of REQUIRED_LLM_OUTPUT_FIELDS) {
    if (!required.includes(field)) errors.push(`Output schema must require ${field}`);
    if (!properties[field]) {
      errors.push(`Output schema must define ${field}`);
    } else if (properties[field].type !== 'string') {
      errors.push(`Output schema field ${field} must be a string`);
    }
  }

  for (const [field, config] of Object.entries(properties)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
      errors.push(`Output schema field ${field} must use letters, numbers, or underscores and cannot start with a number`);
    }
    const type = config?.type;
    if (!ALLOWED_SCHEMA_TYPES.has(type)) {
      errors.push(`Output schema field ${field} has unsupported type ${type || 'missing'}`);
    }
  }

  return { success: errors.length === 0, errors };
}

export function normalizeLlmOutputSchema(schema = null) {
  const candidate = schema && typeof schema === 'object' ? schema : {};
  return {
    ...DEFAULT_LLM_OUTPUT_SCHEMA,
    ...candidate,
    type: 'object',
    additionalProperties: false,
    required: [...new Set([...(Array.isArray(candidate.required) ? candidate.required : []), ...REQUIRED_LLM_OUTPUT_FIELDS])],
    properties: {
      ...DEFAULT_LLM_OUTPUT_SCHEMA.properties,
      ...(candidate.properties || {}),
      subject: DEFAULT_LLM_OUTPUT_SCHEMA.properties.subject,
      html: DEFAULT_LLM_OUTPUT_SCHEMA.properties.html,
      text: DEFAULT_LLM_OUTPUT_SCHEMA.properties.text,
    },
  };
}

export function validateWorkflowDefinition(rawDefinition, { triggerType } = {}) {
  if (!NOTIFICATION_EVENT_TYPES.includes(triggerType)) {
    return {
      success: false,
      errors: [`Unsupported trigger type: ${triggerType}`],
      data: null,
    };
  }

  const parsed = workflowDefinitionSchema.safeParse(rawDefinition);
  if (!parsed.success) {
    return {
      success: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'definition'}: ${issue.message}`),
      data: null,
    };
  }

  const graphErrors = validateGraph(parsed.data, triggerType);
  if (graphErrors.length > 0) {
    return { success: false, errors: graphErrors, data: parsed.data };
  }

  return { success: true, errors: [], data: parsed.data };
}

export function assertValidWorkflowDefinition(rawDefinition, { triggerType } = {}) {
  const result = validateWorkflowDefinition(rawDefinition, { triggerType });
  if (!result.success) {
    throw new ValidationError('Notification workflow definition is invalid', result.errors);
  }
  return result.data;
}

function eventLabel(triggerType) {
  return {
    'ticket.created': 'Ticket arrived',
    'ticket.assigned': 'Ticket assigned',
    'ticket.reassigned': 'Ticket reassigned',
    'ticket.resolved_closed': 'Ticket resolved or closed',
  }[triggerType] || triggerType;
}

function defaultRecipients(triggerType) {
  if (triggerType === 'ticket.assigned' || triggerType === 'ticket.reassigned') {
    return ['assigned_agent'];
  }
  return ['requester'];
}

function defaultTemplate(triggerType) {
  if (triggerType === 'ticket.assigned') {
    return {
      subject: 'Ticket assigned: #{{ ticket.freshserviceTicketId }}',
      html: '<p>Ticket <strong>#{{ ticket.freshserviceTicketId }}</strong> has been assigned to {{ assignedAgent.name }}.</p><p>{{ ticket.subject }}</p>',
      text: 'Ticket #{{ ticket.freshserviceTicketId }} has been assigned to {{ assignedAgent.name }}.\n\n{{ ticket.subject }}',
    };
  }

  if (triggerType === 'ticket.reassigned') {
    return {
      subject: 'Ticket reassigned: #{{ ticket.freshserviceTicketId }}',
      html: '<p>Ticket <strong>#{{ ticket.freshserviceTicketId }}</strong> has been reassigned to {{ assignedAgent.name }}.</p><p>{{ ticket.subject }}</p>',
      text: 'Ticket #{{ ticket.freshserviceTicketId }} has been reassigned to {{ assignedAgent.name }}.\n\n{{ ticket.subject }}',
    };
  }

  if (triggerType === 'ticket.resolved_closed') {
    return {
      subject: 'Ticket resolved: #{{ ticket.freshserviceTicketId }}',
      html: '<p>Your ticket <strong>#{{ ticket.freshserviceTicketId }}</strong> has been resolved.</p><p>{{ ticket.subject }}</p>',
      text: 'Your ticket #{{ ticket.freshserviceTicketId }} has been resolved.\n\n{{ ticket.subject }}',
    };
  }

  return {
    subject: 'Ticket received: #{{ ticket.freshserviceTicketId }}',
    html: '<p>We received your ticket <strong>#{{ ticket.freshserviceTicketId }}</strong>.</p><p>{{ ticket.subject }}</p>',
    text: 'We received your ticket #{{ ticket.freshserviceTicketId }}.\n\n{{ ticket.subject }}',
  };
}

function defaultAfterHoursTemplate() {
  return {
    subject: 'We received ticket #{{ ticket.freshserviceTicketId }} outside business hours',
    html: [
      '<p>We received your request <strong>#{{ ticket.freshserviceTicketId }}</strong>.</p>',
      '<p>{{ afterHoursSupport.message }}</p>',
      '<p><strong>{{ ticket.subject }}</strong></p>',
      '{% if availability.nextBusinessTimeLocal %}<p>Our next scheduled business-hours window starts {{ availability.nextBusinessTimeLocal }}.</p>{% endif %}',
      '{% if afterHoursSupport.immediateSupportUrl %}',
      '<p>If this cannot wait until business hours, request immediate after-hours assistance here: <a href="{{ afterHoursSupport.immediateSupportUrl }}">Immediate assistance</a>.</p>',
      '{% elsif afterHoursSupport.selfEscalationUrl %}',
      '<p>If this cannot wait until business hours, request immediate after-hours assistance here: <a href="{{ afterHoursSupport.selfEscalationUrl }}">Immediate assistance</a>.</p>',
      '{% elsif afterHoursSupport.emergencySupportUrl %}',
      '<p>If this needs urgent attention before then, use this link to request after-hours support: <a href="{{ afterHoursSupport.emergencySupportUrl }}">{{ afterHoursSupport.emergencySupportLabel }}</a>.</p>',
      '{% endif %}',
    ].join(''),
    text: [
      'We received your request #{{ ticket.freshserviceTicketId }}.',
      '',
      '{{ afterHoursSupport.message }}',
      '',
      '{{ ticket.subject }}',
      '',
      '{% if availability.nextBusinessTimeLocal %}Our next scheduled business-hours window starts {{ availability.nextBusinessTimeLocal }}.{% endif %}',
      '{% if afterHoursSupport.immediateSupportUrl %}',
      'If this cannot wait until business hours, request immediate after-hours assistance here: {{ afterHoursSupport.immediateSupportUrl }}',
      '{% elsif afterHoursSupport.selfEscalationUrl %}',
      'If this cannot wait until business hours, request immediate after-hours assistance here: {{ afterHoursSupport.selfEscalationUrl }}',
      '{% elsif afterHoursSupport.emergencySupportUrl %}',
      'If this needs urgent attention before then, use this link to request after-hours support: {{ afterHoursSupport.emergencySupportUrl }}',
      '{% endif %}',
    ].join('\n'),
  };
}

export function defaultWorkflowKey(triggerType) {
  return triggerType.replace('ticket.', 'ticket_').replace('.', '_');
}

export function buildDefaultWorkflowDefinition(triggerType, options = {}) {
  const scheduleMode = options.scheduleMode || 'standard';
  const template = scheduleMode === 'after_hours' && triggerType === 'ticket.created'
    ? defaultAfterHoursTemplate()
    : defaultTemplate(triggerType);
  return {
    version: 1,
    metadata: {
      label: eventLabel(triggerType),
      generatedBy: 'ticket-pulse-default',
      scheduleMode,
      offHoursWorkflow: scheduleMode === 'after_hours',
    },
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        position: { x: 0, y: 0 },
        data: { triggerType },
      },
      {
        id: 'skip-noise',
        type: 'condition',
        position: { x: 260, y: 0 },
        data: {
          label: 'Skip noise tickets',
          rule: { '!=': [{ var: 'ticket.isNoise' }, true] },
        },
      },
      {
        id: 'recipients',
        type: 'recipient_resolver',
        position: { x: 520, y: 0 },
        data: {
          to: defaultRecipients(triggerType),
          cc: [],
          bcc: [],
          customEmails: [],
        },
      },
      {
        id: 'template',
        type: 'template_render',
        position: { x: 780, y: 0 },
        data: {
          ...template,
          contentSource: 'template_only',
          plainTextMode: 'auto',
          appendPublicStatusLink: false,
          appendRaiseUrgencyLink: false,
          appendAfterHoursSupportLink: false,
        },
      },
      {
        id: 'send',
        type: 'send_email',
        position: { x: 1040, y: 0 },
        data: {
          provider: 'sendgrid',
          notificationType: triggerType,
          appendPublicStatusLink: true,
          appendRaiseUrgencyLink: scheduleMode === 'standard' && triggerType === 'ticket.created',
          appendAfterHoursSupportLink: scheduleMode === 'after_hours' && triggerType === 'ticket.created',
        },
      },
      {
        id: 'stop-skipped',
        type: 'stop',
        position: { x: 520, y: 180 },
        data: {
          reason: 'Noise ticket skipped',
        },
      },
    ],
    edges: [
      { id: 'trigger-to-condition', source: 'trigger', target: 'skip-noise' },
      { id: 'condition-true-to-recipients', source: 'skip-noise', sourceHandle: 'true', target: 'recipients' },
      { id: 'condition-false-to-stop', source: 'skip-noise', sourceHandle: 'false', target: 'stop-skipped' },
      { id: 'recipients-to-template', source: 'recipients', target: 'template' },
      { id: 'template-to-send', source: 'template', target: 'send' },
    ],
  };
}

export function sampleEventContext(triggerType = 'ticket.created') {
  return {
    event: {
      type: triggerType,
      source: 'preview',
      occurredAt: '2026-05-29T19:00:00.000Z',
    },
    workspace: {
      id: 1,
      name: 'IT',
      timezone: 'America/Vancouver',
    },
    ticket: {
      id: 123,
      freshserviceTicketId: 456,
      subject: 'Cannot access VPN',
      status: 'Open',
      priority: 2,
      priorityLabel: 'High',
      assessedPriority: 'High',
      toEmails: ['helpdesk@example.com'],
      ccEmails: ['manager@example.com'],
      replyCcEmails: ['teamlead@example.com'],
      fwdEmails: [],
      descriptionText: 'User cannot connect to VPN from home.',
      category: 'Access',
      subCategory: 'VPN',
      ticketCategory: 'IT',
      tpSkill: 'Network',
      tpSubskill: 'VPN',
      internalCategory: { name: 'Network' },
      internalSubcategory: { name: 'VPN' },
      isNoise: false,
      createdAt: '2026-05-29T18:30:00.000Z',
      assignedAt: '2026-05-29T18:42:00.000Z',
      resolvedAt: null,
      closedAt: null,
      freshserviceUpdatedAt: '2026-05-29T18:42:00.000Z',
      publicStatusUrl: 'https://ticketpulse.example/ticket-status/sample-token',
      raiseUrgencyUrl: 'https://ticketpulse.example/ticket-urgency/sample-token',
      selfEscalationUrl: 'https://ticketpulse.example/ticket-escalation/sample-token',
      afterHoursEscalationUrl: 'https://ticketpulse.example/ticket-escalation/sample-token',
      publicStatusExpiresAt: '2026-07-28T18:42:00.000Z',
    },
    requester: {
      name: 'Requester Name',
      email: 'requester@example.com',
    },
    assignedAgent: {
      id: 17,
      name: 'Agent Name',
      email: 'agent@example.com',
    },
    previousAgent: null,
    availability: {
      isBusinessHours: true,
      isAfterHours: false,
      isHoliday: false,
      holidayName: null,
      reason: 'Within business hours',
      timezone: 'America/Vancouver',
      checkedAt: '2026-05-29T19:00:00.000Z',
      nextBusinessTime: null,
      nextBusinessTimeLocal: null,
    },
    afterHoursSupport: {
      enabled: false,
      emergencySupportUrl: '',
      selfEscalationUrl: 'https://ticketpulse.example/ticket-escalation/sample-token',
      immediateSupportUrl: 'https://ticketpulse.example/ticket-escalation/sample-token',
      emergencySupportLabel: 'Request after-hours support',
      message: 'Our team is currently outside regular business hours. We will review your request when business hours resume.',
      activeContact: {
        name: 'After-hours Agent',
        phone: '+1 604 830 8980',
        rotationLabel: 'Manual after-hours contact',
        source: 'manual',
      },
    },
    publicStatusUrl: 'https://ticketpulse.example/ticket-status/sample-token',
    raiseUrgencyUrl: 'https://ticketpulse.example/ticket-urgency/sample-token',
    selfEscalationUrl: 'https://ticketpulse.example/ticket-escalation/sample-token',
    afterHoursEscalationUrl: 'https://ticketpulse.example/ticket-escalation/sample-token',
    state: {
      recipients: {
        to: ['requester@example.com'],
        cc: [],
        bcc: [],
      },
      llm: {
        email: {
          subject: 'Re: VPN access problem',
          html: '<p>We received your VPN request.</p>',
          text: 'We received your VPN request.',
          extra: {
            summary: 'VPN access issue',
          },
        },
      },
    },
  };
}

function formatVariable(path) {
  return `{{ ${path} }}`;
}

function variable(path, label, group, description, example = '') {
  return {
    path,
    token: formatVariable(path),
    label,
    group,
    description,
    example,
  };
}

export function notificationVariableCatalog(extraOutputFields = []) {
  const extras = (extraOutputFields || [])
    .map((field) => String(field || '').trim())
    .filter((field) => field && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field))
    .map((field) => variable(
      `state.llm.email.extra.${field}`,
      `LLM ${field}`,
      'LLM Output',
      `Optional custom field "${field}" returned by the LLM output schema.`,
      '',
    ));

  return [
    variable('ticket.freshserviceTicketId', 'Ticket number', 'Ticket', 'FreshService ticket number.', '225001'),
    variable('ticket.subject', 'Subject', 'Ticket', 'Ticket subject line.', 'VPN access problem'),
    variable('ticket.descriptionText', 'Description', 'Ticket', 'Plain-text ticket description.', 'User cannot connect to VPN from home.'),
    variable('ticket.status', 'Status', 'Ticket', 'Ticket status label.', 'Open'),
    variable('ticket.priority', 'Priority ID', 'Ticket', 'FreshService priority numeric value.', '3'),
    variable('ticket.priorityLabel', 'Priority', 'Ticket', 'Human-readable priority.', 'High'),
    variable('ticket.assessedPriority', 'Assessed priority', 'Ticket', 'Ticket Pulse assessed priority where available.', 'Urgent'),
    variable('ticket.toEmails', 'Original To emails', 'Ticket', 'Email addresses from the original FreshService To field.', 'helpdesk@example.com'),
    variable('ticket.ccEmails', 'Original CC emails', 'Ticket', 'Email addresses copied on the original FreshService request.', 'manager@example.com'),
    variable('ticket.replyCcEmails', 'Reply CC emails', 'Ticket', 'FreshService reply CC addresses associated with this ticket.', 'teamlead@example.com'),
    variable('ticket.fwdEmails', 'Forwarded emails', 'Ticket', 'FreshService forwarded email addresses associated with this ticket.', ''),
    variable('ticket.category', 'Category', 'Ticket', 'FreshService category.', 'Access'),
    variable('ticket.subCategory', 'Subcategory', 'Ticket', 'FreshService subcategory.', 'VPN'),
    variable('ticket.ticketCategory', 'Ticket category', 'Ticket', 'Configured custom category field.', 'IT'),
    variable('ticket.tpSkill', 'Ticket Pulse skill', 'Ticket', 'Ticket Pulse skill field.', 'Network'),
    variable('ticket.tpSubskill', 'Ticket Pulse subskill', 'Ticket', 'Ticket Pulse subskill field.', 'VPN'),
    variable('ticket.internalCategory.name', 'Internal category', 'Ticket', 'Ticket Pulse internal taxonomy category.', 'Network'),
    variable('ticket.internalSubcategory.name', 'Internal subcategory', 'Ticket', 'Ticket Pulse internal taxonomy subcategory.', 'VPN'),
    variable('ticket.createdAt', 'Created at', 'Ticket', 'Ticket creation timestamp.', '2026-05-29T18:30:00.000Z'),
    variable('ticket.assignedAt', 'Assigned at', 'Ticket', 'Current assignment timestamp.', '2026-05-29T18:42:00.000Z'),
    variable('ticket.resolvedAt', 'Resolved at', 'Ticket', 'Ticket resolved timestamp.', ''),
    variable('ticket.closedAt', 'Closed at', 'Ticket', 'Ticket closed timestamp.', ''),
    variable('ticket.publicStatusUrl', 'Public status URL', 'Ticket', 'Requester-facing public ticket status link for this ticket.', 'https://ticketpulse.example/ticket-status/sample-token'),
    variable('ticket.raiseUrgencyUrl', 'Raise urgency URL', 'Ticket', 'Requester-facing business-hours link that raises this ticket to Urgent without paging the after-hours roster.', 'https://ticketpulse.example/ticket-urgency/sample-token'),
    variable('ticket.selfEscalationUrl', 'Immediate support URL', 'Ticket', 'Backward-compatible requester-facing after-hours immediate support link for this ticket.', 'https://ticketpulse.example/ticket-escalation/sample-token'),
    variable('ticket.afterHoursEscalationUrl', 'After-hours immediate support URL', 'Ticket', 'Requester-facing after-hours immediate support link for this ticket.', 'https://ticketpulse.example/ticket-escalation/sample-token'),
    variable('ticket.publicStatusExpiresAt', 'Public status expiry', 'Ticket', 'Expiration timestamp for the public status link, or blank if it never expires.', '2026-07-28T18:42:00.000Z'),
    variable('publicStatusUrl', 'Public status URL', 'Ticket', 'Shortcut to the requester-facing public ticket status link.', 'https://ticketpulse.example/ticket-status/sample-token'),
    variable('raiseUrgencyUrl', 'Raise urgency URL', 'Ticket', 'Shortcut to the business-hours raise urgency link.', 'https://ticketpulse.example/ticket-urgency/sample-token'),
    variable('selfEscalationUrl', 'Immediate support URL', 'Ticket', 'Backward-compatible shortcut to the after-hours immediate support link.', 'https://ticketpulse.example/ticket-escalation/sample-token'),
    variable('afterHoursEscalationUrl', 'After-hours immediate support URL', 'Ticket', 'Shortcut to the after-hours immediate support link.', 'https://ticketpulse.example/ticket-escalation/sample-token'),
    variable('requester.name', 'Requester name', 'Requester', 'Requester display name.', 'Requester Name'),
    variable('requester.email', 'Requester email', 'Requester', 'Requester email address.', 'requester@example.com'),
    variable('requester.department', 'Requester department', 'Requester', 'Requester department where synced.', 'Operations'),
    variable('requester.jobTitle', 'Requester job title', 'Requester', 'Requester job title where synced.', 'Coordinator'),
    variable('assignedAgent.name', 'Assigned agent name', 'Agent', 'Current assigned agent name.', 'Agent Name'),
    variable('assignedAgent.email', 'Assigned agent email', 'Agent', 'Current assigned agent email.', 'agent@example.com'),
    variable('previousAgent.name', 'Previous agent name', 'Agent', 'Previous agent name for reassignment events.', ''),
    variable('previousAgent.email', 'Previous agent email', 'Agent', 'Previous agent email for reassignment events.', ''),
    variable('workspace.name', 'Workspace name', 'Workspace', 'Current Ticket Pulse workspace name.', 'IT'),
    variable('workspace.timezone', 'Workspace timezone', 'Workspace', 'Workspace default timezone.', 'America/Vancouver'),
    variable('availability.isBusinessHours', 'Is business hours', 'Availability', 'True when the event occurred during workspace business hours.', 'true'),
    variable('availability.isAfterHours', 'Is after-hours', 'Availability', 'True when the event occurred outside workspace business hours.', 'false'),
    variable('availability.isHoliday', 'Is holiday', 'Availability', 'True when the event occurred on a configured workspace holiday.', 'false'),
    variable('availability.holidayName', 'Holiday name', 'Availability', 'Configured holiday name when the event date is a holiday.', 'Canada Day'),
    variable('availability.reason', 'Availability reason', 'Availability', 'Reason for the business-hours decision.', 'Outside business hours (09:00 - 17:00)'),
    variable('availability.nextBusinessTimeLocal', 'Next business time', 'Availability', 'Next workspace-local business-hours start time.', 'Mon, Jun 1, 9:00 AM'),
    variable('afterHoursSupport.immediateSupportUrl', 'Immediate support URL', 'After-hours Support', 'Ticket Pulse hosted immediate assistance link for requester-triggered after-hours escalation.', 'https://ticketpulse.example/ticket-escalation/sample-token'),
    variable('afterHoursSupport.selfEscalationUrl', 'Self-escalation URL', 'After-hours Support', 'Backward-compatible alias for the hosted immediate assistance link.', 'https://ticketpulse.example/ticket-escalation/sample-token'),
    variable('afterHoursSupport.emergencySupportUrl', 'Emergency support URL', 'After-hours Support', 'Workspace emergency after-hours support request link.', 'https://example.com/emergency-support'),
    variable('afterHoursSupport.emergencySupportLabel', 'Emergency support label', 'After-hours Support', 'Call-to-action label for the emergency support link.', 'Request after-hours support'),
    variable('afterHoursSupport.message', 'Off-hours message', 'After-hours Support', 'Workspace message used in off-hours notifications.', 'Our team is currently outside regular business hours.'),
    variable('afterHoursSupport.activeContact.name', 'Active contact name', 'After-hours Support', 'Current after-hours contact selected by the workspace policy.', 'After-hours Agent'),
    variable('afterHoursSupport.activeContact.phone', 'Active contact phone', 'After-hours Support', 'Verified phone number currently shown for immediate support emails.', '+1 604 830 8980'),
    variable('afterHoursSupport.activeContact.rotationLabel', 'Active contact rotation', 'After-hours Support', 'How the current after-hours contact was selected.', 'Manual after-hours contact'),
    variable('afterHoursSupport.activeContact.source', 'Active contact source', 'After-hours Support', 'manual, weekly_rotation, roster_fallback, legacy_fallback, or none.', 'manual'),
    variable('event.type', 'Event type', 'Event', 'Workflow trigger event type.', 'ticket.assigned'),
    variable('event.occurredAt', 'Event time', 'Event', 'Timestamp used for this workflow run.', '2026-05-29T18:42:00.000Z'),
    variable('state.recipients.to', 'To recipients', 'Recipients', 'Resolved To recipients.', 'requester@example.com'),
    variable('state.recipients.cc', 'Cc recipients', 'Recipients', 'Resolved Cc recipients.', ''),
    variable('state.recipients.bcc', 'Bcc recipients', 'Recipients', 'Resolved Bcc recipients.', ''),
    variable('state.llm.email.subject', 'LLM subject', 'LLM Output', 'Subject returned by the LLM step.', 'Re: VPN access problem'),
    variable('state.llm.email.html', 'LLM HTML', 'LLM Output', 'HTML body returned by the LLM step.', '<p>We received your VPN request.</p>'),
    variable('state.llm.email.text', 'LLM text', 'LLM Output', 'Plain-text body returned by the LLM step.', 'We received your VPN request.'),
    ...extras,
  ];
}

export function defaultWorkflowMetadata(triggerType) {
  return defaultWorkflowMetadataForSpec({
    key: defaultWorkflowKey(triggerType),
    triggerType,
    scheduleMode: 'standard',
  });
}

export function defaultWorkflowMetadataForSpec(spec) {
  const isAfterHours = spec.scheduleMode === 'after_hours';
  return {
    key: spec.key || defaultWorkflowKey(spec.triggerType),
    name: isAfterHours ? 'Ticket arrived after-hours / holiday' : eventLabel(spec.triggerType),
    description: isAfterHours
      ? 'Send the off-hours/holiday acknowledgement with emergency support instructions.'
      : `Send an email notification when ${eventLabel(spec.triggerType).toLowerCase()}.`,
    triggerType: spec.triggerType,
    scheduleMode: spec.scheduleMode || 'standard',
  };
}
