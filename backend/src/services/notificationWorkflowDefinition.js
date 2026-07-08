import { z } from 'zod';
import { ValidationError } from '../utils/errors.js';

/**
 * Registered workflow trigger events and WHERE each one is emitted. Keep this
 * map honest — an event listed here but fired nowhere is a silent no-op for
 * every workflow built on it (that bug shipped once already).
 *
 *   ticket.created / .assigned / .reassigned / .resolved_closed / .status_changed
 *     → derived in ticketLifecycleNotificationService.deriveTicketLifecycleEvents,
 *       dispatched by emitTicketLifecycleNotifications from BOTH the FS sync
 *       upsert path (syncService) and the TP-native write paths (ticketService
 *       _notifyLifecycle).
 *   ticket.reply_received   → mailboxIngestService (inbound requester email)
 *   ticket.note_added       → ticketService._addThreadEntry (private notes)
 *   ticket.public_reply_added → ticketService._addThreadEntry (agent public replies)
 *   approval.requested / .decided / .clarification_requested
 *     → ticketApprovalService.emitApprovalEvent
 */
export const NOTIFICATION_EVENT_TYPES = [
  'ticket.created',
  'ticket.assigned',
  'ticket.reassigned',
  'ticket.resolved_closed',
  // Native-ticketing events (Phase 5): fired by the ticket engine / mailbox ingest
  'ticket.reply_received',
  'ticket.note_added',
  'ticket.status_changed',
  'ticket.public_reply_added',
  // Approvals (Phase 6)
  'approval.requested',
  'approval.decided',
  'approval.clarification_requested',
  // Time-based triggers → notificationTimeTriggerService worker (per-ticket
  // scans; threshold config lives on the trigger node, so the worker
  // dispatches with onlyWorkflowId)
  'ticket.aging',
  'ticket.sla_pre_breach',
  'ticket.sla_breach',
  // Scheduled (ticketless) trigger: fires once per configured slot in the
  // workspace timezone with a `digest` context (open/unassigned/overdue counts
  // + oldest open tickets) for daily/weekly digest emails.
  'schedule.time',
  // Manual-only (QA 07-07 #3): never fired by lifecycle events or workers.
  // Runs only via a Run-workflow node (reusable sub-workflow) or the admin
  // run-for-ticket dispatch.
  'manual',
];

/** Trigger types fired by the time-trigger worker, not by lifecycle events. */
export const TIME_TRIGGER_EVENT_TYPES = [
  'ticket.aging',
  'ticket.sla_pre_breach',
  'ticket.sla_breach',
];

// --------------------------------------------------------------------------
// Installable workflow templates (LLM-as-email use cases). Installing creates
// a DISABLED draft variant the admin reviews, adjusts, publishes and enables —
// templates never auto-run.
// --------------------------------------------------------------------------

function templateNodes(nodes, edges) {
  return {
    version: 2,
    metadata: { installedFromTemplate: true },
    nodes: nodes.map((node, i) => ({ position: { x: 80 + i * 240, y: 80 }, ...node })),
    edges,
  };
}

export const WORKFLOW_TEMPLATES = [
  {
    key: 'ai_first_reply_draft',
    name: 'AI first-reply draft (human approves)',
    description: 'On new tickets, the LLM drafts a grounded first reply and stages it on the ticket for an agent to approve, edit, or dismiss. Nothing sends automatically.',
    triggerType: 'ticket.created',
    build: () => templateNodes([
      { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
      {
        id: 'draft',
        type: 'llm_generate',
        data: {
          label: 'Draft first reply',
          prompt: 'Draft a first reply to the requester for this new ticket. Acknowledge the specific problem, state what will happen next in plain language, and ask for any obviously missing detail. Do not promise timelines.\n\nTicket: #{{ ticket.freshserviceTicketId }} {{ ticket.subject }}\nDescription: {{ ticket.descriptionText }}\nRequester: {{ requester.name }}',
          outputMode: 'draft_email',
          promoteToEmail: false,
          maxTokens: 10000,
          temperature: 0.3,
        },
      },
      { id: 'propose', type: 'propose_reply', data: { label: 'Stage for approval' } },
      { id: 'end', type: 'stop', data: {} },
    ], [
      { id: 'e1', source: 'trigger', target: 'draft' },
      { id: 'e2', source: 'draft', target: 'propose' },
      { id: 'e3', source: 'propose', target: 'end' },
    ]),
  },
  {
    key: 'resolution_summary_autosend',
    name: 'Resolution summary (auto-send at high confidence)',
    description: 'On resolve/close, the LLM writes a plain-language "what happened / what we did" summary for the requester. Sends automatically only at high confidence — otherwise it stages as a draft for approval.',
    triggerType: 'ticket.resolved_closed',
    build: () => templateNodes([
      { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.resolved_closed' } },
      { id: 'recipients', type: 'recipient_resolver', data: { to: ['requester'], cc: [], bcc: [] } },
      {
        id: 'summary',
        type: 'llm_generate',
        data: {
          label: 'Write resolution summary',
          prompt: 'Write a short resolution summary email for the requester: what the problem was, what was done, and how to reopen if it recurs. State only facts present in the context. Include a confidence field reflecting how sure you are the summary is accurate.\n\nTicket: #{{ ticket.freshserviceTicketId }} {{ ticket.subject }}',
          outputMode: 'draft_email',
          promoteToEmail: true,
          maxTokens: 10000,
          temperature: 0.3,
        },
      },
      {
        id: 'template',
        type: 'template_render',
        data: {
          contentSource: 'llm_with_template_fallback',
          subject: 'Your ticket #{{ ticket.freshserviceTicketId }} has been resolved',
          html: '<p>Your ticket <strong>#{{ ticket.freshserviceTicketId }}</strong> ({{ ticket.subject }}) has been resolved.</p><p>Reply to this email if the problem comes back.</p>',
          text: 'Your ticket #{{ ticket.freshserviceTicketId }} ({{ ticket.subject }}) has been resolved.\n\nReply to this email if the problem comes back.',
          plainTextMode: 'auto',
        },
      },
      {
        id: 'send',
        type: 'send_email',
        data: { label: 'Send (gated)', provider: 'sendgrid', minLlmConfidence: 'high', includeFooter: true, includeHeader: false },
      },
    ], [
      { id: 'e1', source: 'trigger', target: 'recipients' },
      { id: 'e2', source: 'recipients', target: 'summary' },
      { id: 'e3', source: 'summary', target: 'template' },
      { id: 'e4', source: 'template', target: 'send' },
    ]),
  },
  {
    key: 'follow_up_nudge',
    name: 'Follow-up nudge (24h after agent reply)',
    description: 'A day after an agent replies, if the ticket is still open, send the requester a polite templated check-in. Template-driven — no free generation.',
    triggerType: 'ticket.public_reply_added',
    build: () => templateNodes([
      { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.public_reply_added' } },
      { id: 'wait', type: 'delay', data: { label: 'Wait a day', minutes: 1440 } },
      {
        id: 'still-open',
        type: 'condition',
        data: {
          conditionGroup: {
            logic: 'all',
            conditions: [{ field: 'ticket.status', operator: 'in', value: ['Open', 'Pending'] }],
          },
        },
      },
      { id: 'recipients', type: 'recipient_resolver', data: { to: ['requester'], cc: [], bcc: [] } },
      {
        id: 'template',
        type: 'template_render',
        data: {
          contentSource: 'template_only',
          subject: 'Still need help with ticket #{{ ticket.freshserviceTicketId }}?',
          html: '<p>Just checking in on your ticket <strong>#{{ ticket.freshserviceTicketId }}</strong> ({{ ticket.subject }}).</p><p>If our last reply solved it, no action is needed. If you still need help, just reply to this email.</p>',
          text: 'Just checking in on your ticket #{{ ticket.freshserviceTicketId }} ({{ ticket.subject }}).\n\nIf our last reply solved it, no action is needed. If you still need help, just reply to this email.',
          plainTextMode: 'auto',
        },
      },
      { id: 'send', type: 'send_email', data: { provider: 'sendgrid', includeFooter: true, includeHeader: false } },
      { id: 'end', type: 'stop', data: {} },
    ], [
      { id: 'e1', source: 'trigger', target: 'wait' },
      { id: 'e2', source: 'wait', target: 'still-open' },
      { id: 'e3', source: 'still-open', sourceHandle: 'true', target: 'recipients' },
      { id: 'e4', source: 'still-open', sourceHandle: 'false', target: 'end' },
      { id: 'e5', source: 'recipients', target: 'template' },
      { id: 'e6', source: 'template', target: 'send' },
    ]),
  },
  {
    key: 'daily_open_tickets_digest',
    name: 'Daily open-tickets digest',
    description: 'Every morning, email a configured list a plain-language digest: open/unassigned/overdue counts and the oldest open tickets. Deterministic template — no AI. Configure the recipients and send time after installing.',
    triggerType: 'schedule.time',
    build: () => templateNodes([
      { id: 'trigger', type: 'trigger', data: { triggerType: 'schedule.time', frequency: 'daily', time: '08:30' } },
      {
        id: 'recipients',
        type: 'recipient_resolver',
        data: { to: ['custom_emails'], cc: [], bcc: [], customEmails: [] },
      },
      {
        id: 'template',
        type: 'template_render',
        data: {
          contentSource: 'template_only',
          subject: 'Ticket digest — {{ digest.openCount }} open · {{ digest.overdueCount }} overdue',
          html: [
            '<p><strong>{{ workspace.name }}</strong> ticket digest:</p>',
            '<ul>',
            '<li><strong>{{ digest.openCount }}</strong> open ({{ digest.unassignedCount }} unassigned)</li>',
            '<li><strong>{{ digest.overdueCount }}</strong> overdue · {{ digest.dueTodayCount }} due today</li>',
            '</ul>',
            '{% if digest.oldestOpen.size > 0 %}<p><strong>Oldest open tickets:</strong></p><ul>',
            '{% for t in digest.oldestOpen %}<li>{{ t.ref }} — {{ t.subject }} ({{ t.status }}, {{ t.assignee }}, {{ t.ageDays }}d old)</li>{% endfor %}',
            '</ul>{% endif %}',
          ].join(''),
          text: [
            '{{ workspace.name }} ticket digest:',
            '- {{ digest.openCount }} open ({{ digest.unassignedCount }} unassigned)',
            '- {{ digest.overdueCount }} overdue, {{ digest.dueTodayCount }} due today',
            '',
            '{% for t in digest.oldestOpen %}{{ t.ref }} - {{ t.subject }} ({{ t.status }}, {{ t.assignee }}, {{ t.ageDays }}d old)',
            '{% endfor %}',
          ].join('\n'),
          plainTextMode: 'manual',
          appendPublicStatusLink: false,
          appendRaiseUrgencyLink: false,
          appendAfterHoursSupportLink: false,
          appendFeedbackLink: false,
        },
      },
      { id: 'send', type: 'send_email', data: { provider: 'sendgrid', includeFooter: false, includeHeader: false, appendPublicStatusLink: false } },
    ], [
      { id: 'e1', source: 'trigger', target: 'recipients' },
      { id: 'e2', source: 'recipients', target: 'template' },
      { id: 'e3', source: 'template', target: 'send' },
    ]),
  },
  {
    key: 'sla_breach_manager_alert',
    name: 'SLA breach alert to managers (LLM digest)',
    description: 'When a ticket blows its SLA, email a manager list an LLM-written situation digest: what the ticket is, who has it, why it matters. Configure the recipient emails after installing.',
    triggerType: 'ticket.sla_breach',
    build: () => templateNodes([
      { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.sla_breach' } },
      {
        id: 'recipients',
        type: 'recipient_resolver',
        data: { to: ['custom_emails'], cc: [], bcc: [], customEmails: [] },
      },
      {
        id: 'digest',
        type: 'llm_generate',
        data: {
          label: 'Write breach digest',
          prompt: 'Write a concise internal alert for IT coordinators: this ticket has breached its SLA. Summarize the issue, current status, assignee (or unassigned), and one suggested next action. Coaching tone — factual, no blame.\n\nTicket: #{{ ticket.freshserviceTicketId }} {{ ticket.subject }}\nStatus: {{ ticket.status }} · Assignee: {{ assignedAgent.name }}',
          outputMode: 'draft_email',
          promoteToEmail: true,
          maxTokens: 10000,
          temperature: 0.3,
        },
      },
      {
        id: 'template',
        type: 'template_render',
        data: {
          contentSource: 'llm_with_template_fallback',
          subject: 'SLA breached: #{{ ticket.freshserviceTicketId }} {{ ticket.subject }}',
          html: '<p>Ticket <strong>#{{ ticket.freshserviceTicketId }}</strong> ({{ ticket.subject }}) has breached its SLA. Status: {{ ticket.status }}.</p>',
          text: 'Ticket #{{ ticket.freshserviceTicketId }} ({{ ticket.subject }}) has breached its SLA. Status: {{ ticket.status }}.',
          plainTextMode: 'auto',
        },
      },
      { id: 'send', type: 'send_email', data: { provider: 'sendgrid', includeFooter: false, includeHeader: false, appendPublicStatusLink: false } },
    ], [
      { id: 'e1', source: 'trigger', target: 'recipients' },
      { id: 'e2', source: 'recipients', target: 'digest' },
      { id: 'e3', source: 'digest', target: 'template' },
      { id: 'e4', source: 'template', target: 'send' },
    ]),
  },
];

export const AFTER_HOURS_WORKFLOW_KEY = 'ticket_created_after_hours';

export const DEFAULT_WORKFLOW_SPECS = [
  { key: defaultWorkflowKey('ticket.created'), triggerType: 'ticket.created', scheduleMode: 'standard' },
  { key: AFTER_HOURS_WORKFLOW_KEY, triggerType: 'ticket.created', scheduleMode: 'after_hours' },
  { key: defaultWorkflowKey('ticket.assigned'), triggerType: 'ticket.assigned', scheduleMode: 'standard' },
  { key: defaultWorkflowKey('ticket.reassigned'), triggerType: 'ticket.reassigned', scheduleMode: 'standard' },
  { key: defaultWorkflowKey('ticket.resolved_closed'), triggerType: 'ticket.resolved_closed', scheduleMode: 'standard' },
  // Seeded "reopen on requester reply" — customizable per workspace (decision #11)
  { key: 'ticket_reply_received_reopen', triggerType: 'ticket.reply_received', scheduleMode: 'standard' },
];

export const NOTIFICATION_NODE_REGISTRY = Object.freeze({
  trigger: {
    label: 'Trigger',
    terminal: false,
    inputHandles: [],
    outputHandles: ['default'],
  },
  condition: {
    label: 'Condition',
    terminal: false,
    inputHandles: ['default'],
    outputHandles: ['true', 'false'],
  },
  recipient_resolver: {
    label: 'Recipients',
    terminal: false,
    inputHandles: ['default'],
    outputHandles: ['default'],
  },
  llm_generate: {
    label: 'LLM generate',
    terminal: false,
    inputHandles: ['default'],
    outputHandles: ['default'],
  },
  template_render: {
    label: 'Template',
    terminal: false,
    inputHandles: ['default'],
    outputHandles: ['default'],
  },
  update_ticket: {
    label: 'Update ticket',
    terminal: false,
    inputHandles: ['default'],
    outputHandles: ['default'],
  },
  // N-way switch: output handles are the configured branch keys + 'otherwise'
  // (validated dynamically against node.data.branches).
  branch: {
    label: 'Branch',
    terminal: false,
    inputHandles: ['default'],
    outputHandles: 'dynamic',
  },
  delay: {
    label: 'Wait / delay',
    terminal: false,
    inputHandles: ['default'],
    outputHandles: ['default'],
  },
  call_webhook: {
    label: 'Call webhook',
    terminal: false,
    inputHandles: ['default'],
    outputHandles: ['default'],
  },
  create_child_ticket: {
    label: 'Create child ticket',
    terminal: false,
    inputHandles: ['default'],
    outputHandles: ['default'],
  },
  request_approval: {
    label: 'Request approval',
    terminal: false,
    inputHandles: ['default'],
    outputHandles: ['default'],
  },
  // Stage the upstream LLM draft as a proposed reply on the ticket for a
  // human to approve/edit/send — the draft→approve pattern.
  propose_reply: {
    label: 'Propose reply (human approves)',
    terminal: false,
    inputHandles: ['default'],
    outputHandles: ['default'],
  },
  // Invoke another PUBLISHED workflow inline (one level deep, no recursion).
  // The child may be disabled — disabled only stops its own trigger firing,
  // which is exactly what a reusable "subflow" wants.
  run_workflow: {
    label: 'Run workflow',
    terminal: false,
    inputHandles: ['default'],
    outputHandles: ['default'],
  },
  send_email: {
    label: 'Send email',
    terminal: true,
    inputHandles: ['default'],
    outputHandles: [],
  },
  stop: {
    label: 'Stop',
    terminal: true,
    inputHandles: ['default'],
    outputHandles: [],
  },
});

export const NOTIFICATION_NODE_TYPES = Object.keys(NOTIFICATION_NODE_REGISTRY);

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
      description: 'Final rich HTML email body without workspace headers, footers, or signatures.',
    },
    text: {
      type: 'string',
      title: 'Plain text body',
      description: 'Plain-text fallback body without workspace headers, footers, or signatures.',
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
  // v1 = original graphs; v2 = graphs using structured condition groups and/or
  // the newer trigger/node types. Loaded identically today — the version only
  // marks intent so a future migration can tell them apart.
  version: z.union([z.literal(1), z.literal(2)]).default(1),
  nodes: z.array(workflowNodeSchema).min(2).max(30),
  edges: z.array(workflowEdgeSchema).max(60).default([]),
  metadata: z.record(z.any()).default({}),
});

function normalizedSourceHandle(edge) {
  return String(edge.sourceHandle || 'default').trim().toLowerCase() || 'default';
}

function graphIndexes(definition) {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const outgoing = new Map(definition.nodes.map((node) => [node.id, []]));
  const incoming = new Map(definition.nodes.map((node) => [node.id, []]));

  for (const edge of definition.edges) {
    if (outgoing.has(edge.source)) outgoing.get(edge.source).push(edge);
    if (incoming.has(edge.target)) incoming.get(edge.target).push(edge);
  }

  return { nodes, outgoing, incoming };
}

function reachableNodeIds(triggerNode, outgoing) {
  const reachable = new Set();
  const stack = [triggerNode.id];
  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    for (const edge of outgoing.get(nodeId) || []) {
      stack.push(edge.target);
    }
  }
  return reachable;
}

function detectCycles(definition, outgoing) {
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(nodeId, path) {
    if (visiting.has(nodeId)) {
      const start = path.indexOf(nodeId);
      cycles.push([...path.slice(start), nodeId].join(' -> '));
      return;
    }
    if (visited.has(nodeId)) return;

    visiting.add(nodeId);
    for (const edge of outgoing.get(nodeId) || []) {
      visit(edge.target, [...path, edge.target]);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  for (const node of definition.nodes) {
    visit(node.id, [node.id]);
  }

  return cycles;
}

function upstreamNodeTypes(nodeId, nodes, incoming) {
  const types = new Set();
  const seen = new Set();
  const stack = [...(incoming.get(nodeId) || []).map((edge) => edge.source)];

  while (stack.length > 0) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const node = nodes.get(current);
    if (!node) continue;
    types.add(node.type);
    for (const edge of incoming.get(current) || []) {
      stack.push(edge.source);
    }
  }

  return types;
}

function upstreamNodeIds(nodeId, incoming) {
  const seen = new Set();
  const stack = [...(incoming.get(nodeId) || []).map((edge) => edge.source)];
  while (stack.length > 0) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of incoming.get(current) || []) {
      stack.push(edge.source);
    }
  }
  return seen;
}

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

  const ACTION_NODE_TYPES = ['send_email', 'update_ticket', 'call_webhook', 'create_child_ticket', 'request_approval', 'propose_reply'];
  if (!definition.nodes.some((node) => ACTION_NODE_TYPES.includes(node.type))) {
    errors.push(`Workflow must include at least one action node (${ACTION_NODE_TYPES.join(', ')})`);
  }

  for (const edge of definition.edges) {
    if (!ids.has(edge.source)) errors.push(`Edge ${edge.id} has unknown source ${edge.source}`);
    if (!ids.has(edge.target)) errors.push(`Edge ${edge.id} has unknown target ${edge.target}`);
  }

  if (errors.length > 0) return errors;

  const { nodes, outgoing, incoming } = graphIndexes(definition);

  for (const edge of definition.edges) {
    const sourceNode = nodes.get(edge.source);
    const registry = NOTIFICATION_NODE_REGISTRY[sourceNode.type];
    const handle = normalizedSourceHandle(edge);
    if (registry.terminal) {
      errors.push(`Terminal node ${sourceNode.id} cannot have outgoing edge ${edge.id}`);
      continue;
    }
    if (registry.outputHandles === 'dynamic') {
      // Branch nodes: valid handles = configured branch keys + 'otherwise'.
      const branchKeys = new Set((sourceNode.data?.branches || []).map((b) => String(b.key || '').toLowerCase()));
      branchKeys.add('otherwise');
      if (!branchKeys.has(handle)) {
        errors.push(`Edge ${edge.id} uses unknown branch "${handle}" on ${sourceNode.type} node ${sourceNode.id}`);
      }
    } else if (!registry.outputHandles.includes(handle)) {
      errors.push(`Edge ${edge.id} uses unsupported sourceHandle ${handle} for ${sourceNode.type} node ${sourceNode.id}`);
    }
    const targetNode = nodes.get(edge.target);
    const targetHandle = String(edge.targetHandle || 'default').trim().toLowerCase() || 'default';
    const allowedInputHandles = NOTIFICATION_NODE_REGISTRY[targetNode.type]?.inputHandles || ['default'];
    if (!allowedInputHandles.includes(targetHandle)) {
      errors.push(`Edge ${edge.id} uses unsupported targetHandle ${targetHandle} for ${targetNode.type} node ${targetNode.id}`);
    }
  }

  const trigger = triggerNodes[0] || null;
  const reachable = trigger ? reachableNodeIds(trigger, outgoing) : new Set();
  for (const node of definition.nodes) {
    if (trigger && !reachable.has(node.id)) {
      errors.push(`Node ${node.id} is unreachable from the trigger`);
    }

    const registry = NOTIFICATION_NODE_REGISTRY[node.type];
    const edges = outgoing.get(node.id) || [];
    if (reachable.has(node.id) && !registry.terminal && edges.length === 0) {
      errors.push(`Node ${node.id} must route to another node or a stop node`);
    }

    if (node.type === 'condition' && reachable.has(node.id)) {
      const handles = new Set(edges.map((edge) => normalizedSourceHandle(edge)));
      if (!handles.has('true')) errors.push(`Condition node ${node.id} must define a true branch`);
      if (!handles.has('false')) errors.push(`Condition node ${node.id} must define a false branch`);
    }

    if (node.type === 'branch' && reachable.has(node.id)) {
      const branches = Array.isArray(node.data?.branches) ? node.data.branches : [];
      if (branches.length === 0) errors.push(`Branch node ${node.id} needs at least one branch`);
      if (branches.length > 8) errors.push(`Branch node ${node.id} has too many branches (max 8)`);
      const keys = new Set();
      for (const b of branches) {
        const key = String(b?.key || '').trim().toLowerCase();
        if (!key) errors.push(`Branch node ${node.id} has a branch without a key`);
        else if (keys.has(key)) errors.push(`Branch node ${node.id} has duplicate branch key "${key}"`);
        keys.add(key);
      }
      const handles = new Set(edges.map((edge) => normalizedSourceHandle(edge)));
      if (!handles.has('otherwise')) {
        errors.push(`Branch node ${node.id} must route its "otherwise" path (no silent dead ends)`);
      }
    }

    if (node.type === 'delay' && reachable.has(node.id)) {
      const minutes = Number(node.data?.minutes);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 7 * 24 * 60) {
        errors.push(`Delay node ${node.id} must wait between 1 minute and 7 days`);
      }
    }

    if (node.type === 'run_workflow' && reachable.has(node.id)) {
      const workflowId = Number(node.data?.workflowId);
      if (!Number.isFinite(workflowId) || workflowId <= 0) {
        errors.push(`Run-workflow node ${node.id} must reference a workflow`);
      }
    }

    if (node.type === 'trigger' && node.data?.triggerType === 'schedule.time') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(node.data?.time || ''))) {
        errors.push(`Schedule trigger ${node.id} needs a time in HH:mm (24h)`);
      }
      if (!['daily', 'weekly'].includes(node.data?.frequency || 'daily')) {
        errors.push(`Schedule trigger ${node.id} frequency must be daily or weekly`);
      }
      if ((node.data?.frequency || 'daily') === 'weekly') {
        const weekday = Number(node.data?.weekday);
        if (!(weekday >= 0 && weekday <= 6)) {
          errors.push(`Schedule trigger ${node.id} needs a weekday (0=Sunday … 6=Saturday)`);
        }
      }
    }
  }

  for (const cycle of detectCycles(definition, outgoing)) {
    errors.push(`Workflow graph contains a cycle: ${cycle}`);
  }

  for (const node of definition.nodes.filter((candidate) => candidate.type === 'send_email')) {
    const upstream = upstreamNodeTypes(node.id, nodes, incoming);
    if (!upstream.has('recipient_resolver')) {
      errors.push(`Send email node ${node.id} must have an upstream recipient resolver`);
    }
    if (!upstream.has('template_render') && !upstream.has('llm_generate')) {
      errors.push(`Send email node ${node.id} must have an upstream template or LLM email source`);
    }
  }

  for (const node of definition.nodes.filter((candidate) => candidate.type === 'propose_reply')) {
    const upstream = upstreamNodeTypes(node.id, nodes, incoming);
    // A staged draft can come from the LLM or a rendered template — either
    // upstream source is a legitimate human-approval flow (QA 07-07 #5).
    if (!upstream.has('llm_generate') && !upstream.has('template_render')) {
      errors.push(`Propose-reply node ${node.id} needs an upstream draft source — add an LLM generate or Template step before it`);
    }
  }

  // Content addressing: contentFrom (send_email / propose_reply) and llmFrom
  // (template_render) must reference a content producer that runs BEFORE the
  // consumer — otherwise there is nothing to consume at execution time.
  for (const node of definition.nodes) {
    const refs = [];
    if (['send_email', 'propose_reply'].includes(node.type) && node.data?.contentFrom) {
      refs.push({ ref: String(node.data.contentFrom), allowed: ['llm_generate', 'template_render'], label: 'Content source' });
    }
    if (node.type === 'template_render' && node.data?.llmFrom) {
      refs.push({ ref: String(node.data.llmFrom), allowed: ['llm_generate'], label: 'LLM source' });
    }
    for (const { ref, allowed, label } of refs) {
      const target = nodes.get(ref);
      if (!target) {
        errors.push(`${label} on node ${node.id} references a step that no longer exists ("${ref}")`);
        continue;
      }
      if (!allowed.includes(target.type)) {
        errors.push(`${label} on node ${node.id} must point at ${allowed.length > 1 ? 'an LLM generate or Template step' : 'an LLM generate step'} ("${ref}" is a ${target.type})`);
        continue;
      }
      if (!upstreamNodeIds(node.id, incoming).has(ref)) {
        errors.push(`${label} on node ${node.id} must reference a step earlier in the flow ("${ref}" does not run before it)`);
      }
    }
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
    'ticket.reply_received': 'Requester replied',
    'ticket.note_added': 'Internal note added',
    'ticket.status_changed': 'Status changed',
    'ticket.public_reply_added': 'Agent replied to requester',
    'approval.requested': 'Approval requested',
    'approval.decided': 'Approval decided',
    'approval.clarification_requested': 'Approval clarification requested',
    'ticket.aging': 'Ticket unresolved for N hours',
    'ticket.sla_pre_breach': 'SLA about to breach',
    'ticket.sla_breach': 'SLA breached',
    'schedule.time': 'On a schedule (digest)',
    manual: 'Manual / sub-workflow only',
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

  // "Reopen on requester reply" is an ACTION workflow (no email): if the
  // requester replies to a Resolved/Closed ticket, reopen it. Fully editable —
  // admins can add conditions, change the target status, or bolt on an email.
  if (triggerType === 'ticket.reply_received') {
    return {
      version: 1,
      metadata: {
        label: 'Reopen on requester reply',
        generatedBy: 'ticket-pulse-default',
        scheduleMode,
        offHoursWorkflow: false,
        description: 'When a requester replies to a resolved or closed ticket, reopen it so the reply is not missed.',
      },
      nodes: [
        { id: 'trigger', type: 'trigger', position: { x: 0, y: 60 }, data: { triggerType } },
        {
          id: 'is-resolved',
          type: 'condition',
          position: { x: 260, y: 60 },
          data: {
            label: 'Ticket already resolved or closed?',
            rule: { in: [{ var: 'ticket.status' }, ['Resolved', 'Closed']] },
          },
        },
        {
          id: 'reopen',
          type: 'update_ticket',
          position: { x: 540, y: 0 },
          data: { setStatus: 'Open', note: 'Reopened automatically — the requester replied.' },
        },
        { id: 'done', type: 'stop', position: { x: 800, y: 0 }, data: {} },
        { id: 'skip', type: 'stop', position: { x: 540, y: 150 }, data: {} },
      ],
      edges: [
        { id: 'e-trigger', source: 'trigger', target: 'is-resolved' },
        { id: 'e-true', source: 'is-resolved', target: 'reopen', sourceHandle: 'true' },
        { id: 'e-reopen', source: 'reopen', target: 'done' },
        { id: 'e-false', source: 'is-resolved', target: 'skip', sourceHandle: 'false' },
      ],
    };
  }

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
        // Scheduled triggers carry default slot config so a fresh workflow
        // validates before the admin tunes it.
        data: triggerType === 'schedule.time'
          ? { triggerType, frequency: 'daily', time: '08:30' }
          : { triggerType },
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
          appendFeedbackLink: false,
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
          appendFeedbackLink: triggerType === 'ticket.resolved_closed',
          includeHeader: false,
          headerBlockId: null,
          includeFooter: true,
          footerBlockId: null,
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
      feedbackUrl: 'https://ticketpulse.example/feedback/sample-token',
      publicStatusExpiresAt: '2026-07-28T18:42:00.000Z',
      agentNotes: 'Agent Name (2026-05-29): Reset the VPN profile and confirmed the user can connect from home. Asked the user to report back if timeouts return.',
    },
    requester: {
      id: 40,
      name: 'Requester Name',
      email: 'requester@example.com',
      department: 'Vancouver',
      freshserviceDepartment: 'Vancouver',
      jobTitle: 'Project Manager',
      freshserviceJobTitle: 'Project Manager',
      entraDepartment: 'Operations',
      entraJobTitle: 'Project Manager',
      officeLocation: 'Vancouver',
      city: 'Vancouver',
      state: 'CA-BC',
      provinceState: 'CA-BC',
      stateName: 'British Columbia',
      country: 'Canada',
      countryCode: 'CA',
      locationSummary: 'Vancouver, British Columbia, Canada',
      locationSource: 'entra',
      timeZone: 'Pacific Time (US & Canada)',
      timeZoneIana: 'America/Vancouver',
      language: 'en',
      freshserviceLanguage: 'en',
      profileSyncedAt: '2026-05-29T18:30:00.000Z',
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
    feedbackUrl: 'https://ticketpulse.example/feedback/sample-token',
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
    variable('ticket.feedbackUrl', 'Feedback URL', 'Ticket', 'Requester-facing satisfaction feedback link for this ticket.', 'https://ticketpulse.example/feedback/sample-token'),
    variable('publicStatusUrl', 'Public status URL', 'Ticket', 'Shortcut to the requester-facing public ticket status link.', 'https://ticketpulse.example/ticket-status/sample-token'),
    variable('raiseUrgencyUrl', 'Raise urgency URL', 'Ticket', 'Shortcut to the business-hours raise urgency link.', 'https://ticketpulse.example/ticket-urgency/sample-token'),
    variable('selfEscalationUrl', 'Immediate support URL', 'Ticket', 'Backward-compatible shortcut to the after-hours immediate support link.', 'https://ticketpulse.example/ticket-escalation/sample-token'),
    variable('afterHoursEscalationUrl', 'After-hours immediate support URL', 'Ticket', 'Shortcut to the after-hours immediate support link.', 'https://ticketpulse.example/ticket-escalation/sample-token'),
    variable('feedbackUrl', 'Feedback URL', 'Ticket', 'Shortcut to the requester-facing satisfaction feedback link.', 'https://ticketpulse.example/feedback/sample-token'),
    variable('requester.name', 'Requester name', 'Requester', 'Requester display name.', 'Requester Name'),
    variable('requester.email', 'Requester email', 'Requester', 'Requester email address.', 'requester@example.com'),
    variable('requester.department', 'Requester FreshService department/location', 'Requester', 'FreshService requester department_names value. In this workspace it is often an office/location label.', 'Vancouver'),
    variable('requester.freshserviceDepartment', 'Requester FreshService department/location', 'Requester', 'Explicit alias for the FreshService requester department/location label.', 'Vancouver'),
    variable('requester.jobTitle', 'Requester job title', 'Requester', 'Best available requester job title; FreshService value first, then Entra fallback.', 'Project Manager'),
    variable('requester.freshserviceJobTitle', 'Requester FreshService job title', 'Requester', 'FreshService requester job title where synced.', 'Project Manager'),
    variable('requester.entraDepartment', 'Requester Entra department', 'Requester', 'Microsoft Entra department value when available.', 'Operations'),
    variable('requester.entraJobTitle', 'Requester Entra job title', 'Requester', 'Microsoft Entra job title value when available.', 'Project Manager'),
    variable('requester.officeLocation', 'Requester office location', 'Requester', 'Microsoft Entra officeLocation value, falling back to a safe FreshService location label when Entra is unavailable.', 'Vancouver'),
    variable('requester.city', 'Requester city', 'Requester', 'Microsoft Entra city value, or a conservative city parsed from FreshService requester department/location.', 'Vancouver'),
    variable('requester.state', 'Requester province/state code', 'Requester', 'Microsoft Entra state value such as CA-BC, CA-AB, or US-CO.', 'CA-BC'),
    variable('requester.provinceState', 'Requester province/state code', 'Requester', 'Alias for requester.state for prompts that prefer province/state wording.', 'CA-BC'),
    variable('requester.stateName', 'Requester province/state name', 'Requester', 'Friendly province/state name derived from the Entra state code when recognized.', 'British Columbia'),
    variable('requester.country', 'Requester country', 'Requester', 'Microsoft Entra country value when available.', 'Canada'),
    variable('requester.countryCode', 'Requester country code', 'Requester', 'Two-letter country code from Entra usageLocation or derived from country.', 'CA'),
    variable('requester.locationKey', 'Requester location', 'Requester', 'Normalized requester site key for workflow routing. Brisbane normalizes to AU-BRISBANE.', 'AU-BRISBANE'),
    variable('requester.regionKey', 'Requester region', 'Requester', 'Normalized requester region key for workflow routing. Brisbane normalizes to AU-BRISBANE.', 'AU-BRISBANE'),
    variable('requester.locationSummary', 'Requester location summary', 'Requester', 'Best short location string for LLM prompts and templates.', 'Vancouver, British Columbia, Canada'),
    variable('requester.locationSource', 'Requester location source', 'Requester', 'Source for location fields: entra or freshservice_department.', 'entra'),
    variable('requester.timeZone', 'Requester FreshService timezone', 'Requester', 'FreshService requester timezone display name. Kept as fallback; some values may be stale.', 'Pacific Time (US & Canada)'),
    variable('requester.timeZoneIana', 'Requester timezone', 'Requester', 'Best IANA timezone derived from Entra location first, then FreshService timezone fallback.', 'America/Vancouver'),
    variable('requester.language', 'Requester language', 'Requester', 'Best available requester language or preferred language.', 'en'),
    variable('requester.freshserviceLanguage', 'Requester FreshService language', 'Requester', 'FreshService requester language value.', 'en'),
    variable('requester.profileSyncedAt', 'Requester profile synced at', 'Requester', 'Timestamp of the latest cached Entra profile lookup.', '2026-05-29T18:30:00.000Z'),
    variable('assignedAgent.name', 'Assigned agent name', 'Agent', 'Current assigned agent name.', 'Agent Name'),
    variable('assignedAgent.email', 'Assigned agent email', 'Agent', 'Current assigned agent email.', 'agent@example.com'),
    variable('previousAgent.name', 'Previous agent name', 'Agent', 'Previous agent name for reassignment events.', ''),
    variable('previousAgent.email', 'Previous agent email', 'Agent', 'Previous agent email for reassignment events.', ''),
    variable('ticket.agentNotes', 'Agent notes (private)', 'Agent', 'Recent private/internal agent notes from the ticket thread, newest last. Empty unless "Private notes" is enabled in LLM Context > Privacy & redaction. Have the LLM summarize these in requester-friendly language - never quote them verbatim.', 'Agent Name (2026-06-09): Replaced the faulty dock and confirmed VPN connects on the new profile.'),
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
  if (spec.key === 'ticket_reply_received_reopen') {
    return {
      key: spec.key,
      name: 'Reopen on requester reply',
      description: 'When a requester replies to a resolved or closed ticket, reopen it so the reply is not missed. Fully customizable — no email is sent by default.',
      triggerType: spec.triggerType,
      scheduleMode: spec.scheduleMode || 'standard',
    };
  }
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
