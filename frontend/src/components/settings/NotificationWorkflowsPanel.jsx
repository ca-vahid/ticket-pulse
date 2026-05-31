import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import MonacoEditor from '@monaco-editor/react';
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
  useDefaultLayout,
} from 'react-resizable-panels';
import {
  AlertCircle,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Code,
  Clipboard,
  Eye,
  FileJson,
  FlaskConical,
  History,
  Mail,
  Map as MapIcon,
  Maximize2,
  PanelRight,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  ToggleLeft,
  ToggleRight,
  Type,
  Upload,
  UploadCloud,
  Wand2,
  XCircle,
} from 'lucide-react';
import { notificationWorkflowAPI } from '../../services/api';

const EVENT_LABELS = {
  'ticket.created': 'Ticket arrived',
  'ticket.assigned': 'Ticket assigned',
  'ticket.reassigned': 'Ticket reassigned',
  'ticket.resolved_closed': 'Resolved or closed',
};

const NODE_LABELS = {
  trigger: 'Trigger',
  condition: 'Condition',
  recipient_resolver: 'Recipients',
  llm_generate: 'LLM generate',
  template_render: 'Template',
  send_email: 'Send email',
  stop: 'Stop',
};

const NODE_COLORS = {
  trigger: '#2563eb',
  condition: '#d97706',
  recipient_resolver: '#059669',
  llm_generate: '#7c3aed',
  template_render: '#0f766e',
  send_email: '#dc2626',
  stop: '#6b7280',
};

const DEFAULT_LLM_MAX_TOKENS = 10000;
const AFTER_HOURS_WORKFLOW_KEY = 'ticket_created_after_hours';

const DEFAULT_AFTER_HOURS_POLICY = {
  afterHoursEnabled: false,
  holidaysEnabled: true,
  suppressStandardTicketCreated: true,
  offHoursWorkflowKey: AFTER_HOURS_WORKFLOW_KEY,
  emergencySupportUrl: '',
  emergencySupportLabel: 'Request after-hours support',
  offHoursMessage: 'Our team is currently outside regular business hours. We will review your request when business hours resume.',
  holidayMessage: 'Our team is currently observing a holiday. We will review your request when business hours resume.',
};

const DEFAULT_LLM_OUTPUT_SCHEMA = {
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

const TEMPLATE_CONTENT_SOURCES = [
  ['llm_with_template_fallback', 'LLM output with fallback', 'Use generated subject/body when available; otherwise use the template fields below.'],
  ['template_only', 'Template only', 'Ignore LLM output and render the template fields only.'],
  ['llm_only', 'LLM output only', 'Send only the generated LLM subject/body.'],
  ['advanced_liquid', 'Advanced Liquid', 'Render these fields as raw Liquid for custom logic.'],
];

const PREVIEW_TICKET_PRIORITY_FILTERS = [
  { value: 'all', label: 'All priorities' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

const PREVIEW_TICKET_STATUS_FILTERS = [
  { value: 'all', label: 'All statuses' },
  { value: 'Open', label: 'Open' },
  { value: 'Pending', label: 'Pending' },
  { value: 'Resolved', label: 'Resolved' },
  { value: 'Closed', label: 'Closed' },
];

const MOCK_AUDIT_RANGES = [
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7d' },
  { value: '30d', label: 'Last 30d' },
  { value: 'all', label: 'All time' },
];

const LLM_TOOL_POLICY_MODES = [
  { value: 'off', label: 'Off', description: 'Use only the workflow prompt and template.' },
  { value: 'context_only', label: 'Context only', description: 'Add redacted ticket, thread, similar-ticket, and signal context.' },
  { value: 'tools_enabled', label: 'Context + tools', description: 'Allow bounded read-only Ticket Pulse evidence tools before final email submission.' },
];

const DEFAULT_LLM_TOOL_POLICY = {
  mode: 'context_only',
  enabledTools: ['get_notification_context', 'get_ticket_thread_summary', 'find_similar_tickets', 'detect_related_ticket_spike'],
  toolSettings: {
    context: {
      includeThreadHistory: true,
      includeSimilarTickets: true,
      includeOutageSignals: true,
      maxThreadEntries: 6,
      maxSimilarTickets: 5,
      lookbackHours: [1, 4, 24],
    },
    outageSignals: {
      watchThreshold: 3,
      possibleBroaderIssueThreshold: 5,
      distinctRequesterThreshold: 3,
      distinctDepartmentThreshold: 2,
    },
    safety: {
      maxContextBytes: 40000,
      maxToolOutputBytes: 12000,
    },
  },
  maxTurns: 4,
  maxToolCalls: 6,
  totalTimeoutMs: 20000,
  perToolTimeoutMs: 3000,
  includePrivateNotes: false,
  redactionEnabled: true,
};

const MOCK_AUDIT_STATUSES = [
  { value: 'all', label: 'All statuses' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'running', label: 'Running' },
];

function cls(...parts) {
  return parts.filter(Boolean).join(' ');
}

function statusClass(status) {
  if (status === 'completed' || status === 'sent') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (status === 'failed') return 'bg-red-50 text-red-700 border-red-200';
  if (status === 'mocked') return 'bg-sky-50 text-sky-700 border-sky-200';
  if (status === 'running' || status === 'queued') return 'bg-amber-50 text-amber-700 border-amber-200';
  return 'bg-gray-50 text-gray-700 border-gray-200';
}

function formatDate(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleString();
}

function rangeStartIso(range) {
  const now = Date.now();
  if (range === '24h') return new Date(now - 24 * 60 * 60 * 1000).toISOString();
  if (range === '30d') return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  if (range === 'all') return null;
  return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
}

function auditTicketLabel(run) {
  const ticket = run?.ticket || {};
  const ticketId = ticket.freshserviceTicketId || run?.eventContext?.ticket?.freshserviceTicketId || ticket.id || run?.ticketId;
  return ticketId ? `#${ticketId}` : 'No ticket';
}

function auditTicketSubject(run) {
  return run?.ticket?.subject || run?.eventContext?.ticket?.subject || 'No subject captured';
}

function deliveryRecipientCount(delivery) {
  return [
    ...(delivery?.toRecipients || []),
    ...(delivery?.ccRecipients || []),
    ...(delivery?.bccRecipients || []),
  ].length;
}

function auditDeliveryForRun(run) {
  return (run?.deliveries || []).find((delivery) => delivery.status === 'mocked')
    || run?.deliveries?.[0]
    || null;
}

function auditLlmForRun(run) {
  const attempt = (run?.aiProviderAttempts || []).find((entry) => entry.operation === 'notification_workflow_generation')
    || run?.aiProviderAttempts?.[0]
    || null;
  if (attempt) {
    return {
      provider: attempt.provider,
      model: attempt.model,
      status: attempt.status,
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
      durationMs: attempt.durationMs,
    };
  }
  const llmStep = (run?.steps || []).find((step) => step.nodeType === 'llm_generate');
  return llmStep?.output?.llm || null;
}

function recipientLine(label, values) {
  const items = values || [];
  return `${label}: ${items.length ? items.join(', ') : 'None'}`;
}

function routingWindowTone(mode) {
  if (mode === 'holiday') return 'border-violet-200 bg-violet-50 text-violet-950';
  if (mode === 'after_hours') return 'border-amber-200 bg-amber-50 text-amber-950';
  if (mode === 'standard') return 'border-emerald-200 bg-emerald-50 text-emerald-950';
  return 'border-slate-200 bg-slate-50 text-slate-700';
}

function routingWindowAccent(mode) {
  if (mode === 'holiday') return 'bg-violet-500';
  if (mode === 'after_hours') return 'bg-amber-500';
  if (mode === 'standard') return 'bg-emerald-500';
  return 'bg-slate-400';
}

function timeOrFallback(value, fallback = 'Not scheduled') {
  return value || fallback;
}

function cloneDefinition(definition) {
  return JSON.parse(JSON.stringify(definition || { version: 1, nodes: [], edges: [], metadata: {} }));
}

function displayPositionForNode(node, definition, index) {
  const hasLlm = (definition?.nodes || []).some((candidate) => candidate.type === 'llm_generate');
  const byId = hasLlm ? {
    trigger: { x: 0, y: 80 },
    'skip-noise': { x: 280, y: 80 },
    recipients: { x: 560, y: 80 },
    'llm-generate': { x: 840, y: 80 },
    template: { x: 1120, y: 80 },
    send: { x: 1400, y: 80 },
    'stop-skipped': { x: 560, y: 260 },
  } : {
    trigger: { x: 0, y: 80 },
    'skip-noise': { x: 280, y: 80 },
    recipients: { x: 560, y: 80 },
    template: { x: 840, y: 80 },
    send: { x: 1120, y: 80 },
    'stop-skipped': { x: 560, y: 260 },
  };
  return node.position || byId[node.id] || { x: index * 280, y: 80 };
}

function flowNodesFromDefinition(definition, selectedNodeId) {
  return (definition?.nodes || []).map((node, index) => ({
    id: node.id,
    type: 'default',
    position: displayPositionForNode(node, definition, index),
    data: {
      nodeType: node.type,
      label: (
        <div className="min-w-[140px]">
          <div className="text-[11px] uppercase tracking-wide text-gray-500">{NODE_LABELS[node.type] || node.type}</div>
          <div className="truncate text-sm font-semibold text-gray-900">{node.data?.label || node.data?.notificationType || node.id}</div>
        </div>
      ),
    },
    style: {
      border: selectedNodeId === node.id ? `2px solid ${NODE_COLORS[node.type] || '#2563eb'}` : '1px solid #d1d5db',
      borderLeft: `5px solid ${NODE_COLORS[node.type] || '#6b7280'}`,
      borderRadius: 8,
      background: '#ffffff',
      width: 180,
      minHeight: 62,
      boxShadow: selectedNodeId === node.id ? '0 8px 24px rgba(15, 23, 42, 0.14)' : '0 1px 2px rgba(15, 23, 42, 0.08)',
    },
  }));
}

function flowEdgesFromDefinition(definition) {
  return (definition?.edges || []).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.sourceHandle || edge.label || undefined,
    type: 'smoothstep',
    animated: edge.sourceHandle === 'true',
    style: { stroke: edge.sourceHandle === 'false' ? '#9ca3af' : '#2563eb' },
  }));
}

function templateUsesLlm(data = {}) {
  return [data.subject, data.html, data.text].some((value) => String(value || '').includes('state.llm'));
}

function extractLegacyFallback(value = '') {
  const text = String(value || '');
  const match = text.match(/^\{% if state\.llm\.email\.[a-zA-Z0-9_]+ %\}\{\{ state\.llm\.email\.[a-zA-Z0-9_]+ \}\}\{% else %\}([\s\S]*)\{% endif %\}$/);
  return match ? match[1] : text;
}

function normalizeTemplateData(data = {}) {
  const preservedPlainTextMode = data.plainTextMode || (data.text ? 'custom' : 'auto');
  if (!templateUsesLlm(data) || data.contentSource) {
    return {
      ...data,
      contentSource: data.contentSource || 'template_only',
      plainTextMode: preservedPlainTextMode,
    };
  }
  return {
    ...data,
    subject: extractLegacyFallback(data.subject),
    html: extractLegacyFallback(data.html),
    text: extractLegacyFallback(data.text),
    contentSource: 'llm_with_template_fallback',
    plainTextMode: preservedPlainTextMode,
  };
}

function addLlmFallbacksToTemplate(data = {}) {
  return {
    ...normalizeTemplateData(data),
    contentSource: 'llm_with_template_fallback',
  };
}

function normalizeEditorDefinition(definition) {
  const next = cloneDefinition(definition);
  for (const node of next.nodes || []) {
    if (node.type === 'template_render') {
      node.data = normalizeTemplateData(node.data || {});
    }
    if (node.type === 'llm_generate') {
      node.data = {
        ...(node.data || {}),
        outputSchema: node.data?.outputSchema || DEFAULT_LLM_OUTPUT_SCHEMA,
        maxTokens: node.data?.maxTokens || DEFAULT_LLM_MAX_TOKENS,
        temperature: node.data?.temperature ?? 0.3,
      };
    }
  }
  return next;
}

function stripHtmlClient(value = '') {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizePreviewHtmlClient(value = '') {
  return String(value || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
}

function validateSchemaClient(schema) {
  const errors = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return ['Schema must be a JSON object'];
  }
  if (schema.type !== 'object') errors.push('Schema type must be object');
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = schema.properties || {};
  for (const field of ['subject', 'html', 'text']) {
    if (!required.includes(field)) errors.push(`${field} must be required`);
    if (properties[field]?.type !== 'string') errors.push(`${field} must be a string property`);
  }
  for (const [field, config] of Object.entries(properties)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) errors.push(`${field} must be a valid identifier`);
    if (!['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(config?.type)) {
      errors.push(`${field} has unsupported type ${config?.type || 'missing'}`);
    }
  }
  return errors;
}

function applyDisplayLayoutToDraft(definition) {
  const hasLlm = (definition?.nodes || []).some((node) => node.type === 'llm_generate');
  for (const [index, node] of (definition?.nodes || []).entries()) {
    node.position = displayPositionForNode(node, { nodes: hasLlm ? [{ type: 'llm_generate' }] : [] }, index);
  }
}

function formatJson(value) {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value ?? '');
  }
}

function summarizePreviewStep(step) {
  const output = step?.output || {};
  if (step?.nodeType === 'trigger') return output.eventType || 'Workflow started';
  if (step?.nodeType === 'condition') return output.passed ? 'Condition passed' : 'Condition failed';
  if (step?.nodeType === 'recipient_resolver') {
    const recipients = output.recipients || {};
    return `To: ${(recipients.to || []).join(', ') || 'none'}`;
  }
  if (step?.nodeType === 'llm_generate') {
    if (output.failed) return output.error || 'LLM generation returned an issue';
    if (output.skipped) return output.reason || 'LLM skipped';
    const llm = output.llm || {};
    return [llm.provider, llm.model].filter(Boolean).join(' / ') || 'LLM generated email content';
  }
  if (step?.nodeType === 'template_render') return output.email?.subject || 'Template rendered';
  if (step?.nodeType === 'send_email') return output.reason || 'Email delivery simulated';
  if (step?.nodeType === 'stop') return output.reason || 'Workflow stopped';
  return step?.status || 'Step completed';
}

function previewAuditId(preview) {
  return preview?.auditId || (preview?.runId ? `TP-NWF-${preview.runId}` : null);
}

function previewStepIssue(step) {
  const output = step?.output || {};
  const expectedPreviewSend = step?.nodeType === 'send_email' && output.skipped && output.reason === 'Preview only';
  if (step?.status === 'failed' || step?.error) {
    return {
      tone: 'red',
      label: 'Failed',
      detail: step.error || output.error || 'Step failed before it produced output.',
    };
  }
  if (output.failed) {
    return {
      tone: 'red',
      label: 'Needs attention',
      detail: output.error || 'Step completed but returned a failed result.',
    };
  }
  if (expectedPreviewSend) return null;
  if (output.skipped || output.stopped) {
    return {
      tone: 'amber',
      label: output.stopped ? 'Stopped' : 'Skipped',
      detail: output.reason || 'Step did not continue the workflow.',
    };
  }
  return null;
}

function previewToneClasses(tone) {
  if (tone === 'red') {
    return {
      card: 'border-red-200 bg-red-50/60',
      badge: 'border-red-200 bg-red-100 text-red-700',
      icon: 'text-red-600',
      panel: 'border-red-200 bg-red-50 text-red-800',
    };
  }
  if (tone === 'amber') {
    return {
      card: 'border-amber-200 bg-amber-50/60',
      badge: 'border-amber-200 bg-amber-100 text-amber-800',
      icon: 'text-amber-600',
      panel: 'border-amber-200 bg-amber-50 text-amber-800',
    };
  }
  if (tone === 'blue') {
    return {
      card: 'border-blue-200 bg-blue-50/60',
      badge: 'border-blue-200 bg-blue-100 text-blue-800',
      icon: 'text-blue-600',
      panel: 'border-blue-200 bg-blue-50 text-blue-800',
    };
  }
  return {
    card: 'border-emerald-200 bg-white',
    badge: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    icon: 'text-emerald-600',
    panel: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  };
}

function llmFromPreview(preview, steps) {
  const llmStep = steps.find((step) => step.nodeType === 'llm_generate');
  return llmStep?.output?.llm || preview?.state?.llm || llmStep?.output || null;
}

function collectPreviewIssues(preview, steps, email, recipients) {
  const issues = [];
  if (preview?.status === 'failed' || preview?.error) {
    issues.push({
      tone: 'red',
      title: 'Preview run failed',
      detail: preview.error || 'The engine stopped before completing the workflow.',
    });
  }
  for (const step of steps) {
    const issue = previewStepIssue(step);
    if (issue) {
      issues.push({
        ...issue,
        title: `${NODE_LABELS[step.nodeType] || step.nodeType}: ${step.nodeId}`,
      });
    }
  }
  const llm = llmFromPreview(preview, steps);
  if (llm?.failed && !issues.some((issue) => issue.detail === llm.error)) {
    issues.push({
      tone: 'red',
      title: 'LLM output failed validation',
      detail: llm.error || 'The LLM response did not match the required output schema.',
    });
  }
  if (llm?.tokenLimitHit) {
    issues.push({
      tone: 'amber',
      title: 'LLM output hit token limit',
      detail: llm.tokenLimitWarning || 'The provider reported that generation reached the configured output token cap.',
    });
  } else if (llm?.tokenDiagnostics?.nearTokenLimit) {
    issues.push({
      tone: 'amber',
      title: 'LLM output near token limit',
      detail: `The response used ${llm.tokenDiagnostics.outputLimitPercent}% of the configured output token cap.`,
    });
  }
  if ((llm?.repairedFields || []).length > 0) {
    issues.push({
      tone: 'amber',
      title: 'LLM output was repaired',
      detail: `Missing field${llm.repairedFields.length === 1 ? '' : 's'} repaired from available output: ${llm.repairedFields.join(', ')}.`,
    });
  }
  if (preview && !email) {
    issues.push({
      tone: 'amber',
      title: 'No final email rendered',
      detail: 'The preview did not produce final subject/body content.',
    });
  }
  if (preview && email && !(email.html || email.text)) {
    issues.push({
      tone: 'red',
      title: 'Email body is empty',
      detail: 'The send step would not have enough content to send.',
    });
  }
  if (preview && email && (recipients.to || []).length === 0) {
    issues.push({
      tone: 'amber',
      title: 'No original recipients',
      detail: 'The preview can render an email, but the workflow recipient step resolved no To recipients.',
    });
  }
  for (const [key, diagnostic] of Object.entries(email?.actionLinks || {})) {
    const label = {
      publicStatus: 'Public status action block',
      raiseUrgency: 'Business-hours urgency action block',
      afterHoursSupport: 'After-hours support action block',
    }[key] || key;
    if (diagnostic?.skipped) {
      issues.push({
        tone: 'amber',
        title: `${label} skipped`,
        detail: diagnostic.reason || 'This action block was enabled but not rendered.',
      });
    } else if (diagnostic?.forced && diagnostic?.liveWouldSkipReason) {
      issues.push({
        tone: 'amber',
        title: `${label} forced for test`,
        detail: `The test preview rendered this block. Live sends would skip it: ${diagnostic.liveWouldSkipReason}`,
      });
    } else if (diagnostic?.warning) {
      issues.push({
        tone: 'amber',
        title: `${label} warning`,
        detail: diagnostic.warning,
      });
    }
  }
  return issues;
}

function ActionLinkDiagnostics({ diagnostics }) {
  const items = [
    ['publicStatus', 'Public status', 'blue'],
    ['raiseUrgency', 'Raise urgency', 'amber'],
    ['afterHoursSupport', 'After-hours support', 'red'],
  ]
    .map(([key, label, tone]) => ({ key, label, tone, diagnostic: diagnostics?.[key] }))
    .filter((item) => item.diagnostic?.requested);
  if (!items.length) return null;
  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Action block diagnostics</div>
      <div className="grid gap-2 md:grid-cols-3">
        {items.map(({ key, label, tone, diagnostic }) => {
          const applied = diagnostic.applied && !diagnostic.skipped;
          const color = diagnostic.skipped
            ? 'border-amber-200 bg-amber-50 text-amber-800'
            : diagnostic.forced || diagnostic.warning
              ? 'border-blue-200 bg-blue-50 text-blue-800'
              : 'border-emerald-200 bg-emerald-50 text-emerald-800';
          return (
            <div key={key} className={cls('rounded-md border px-3 py-2 text-xs', color)}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{label}</span>
                <span className="rounded-full bg-white/70 px-2 py-0.5 font-semibold">
                  {diagnostic.skipped ? 'Skipped' : diagnostic.forced ? 'Forced test' : applied ? 'Rendered' : 'Checked'}
                </span>
              </div>
              <div className="mt-1 leading-5">
                {diagnostic.reason || diagnostic.warning || diagnostic.liveWouldSkipReason || 'Ready'}
              </div>
              {key === 'afterHoursSupport' && diagnostic.activeContact && (
                <div className="mt-1 text-[11px] opacity-80">
                  Contact: {diagnostic.activeContact.name || 'none'}{diagnostic.activeContact.phone ? `, ${diagnostic.activeContact.phone}` : ''}
                </div>
              )}
              {tone === 'red' && diagnostic.url && (
                <div className="mt-1 truncate font-mono text-[10px] opacity-70">{diagnostic.url}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PreviewMetric({ label, value, tone = 'gray' }) {
  const toneClass = tone === 'red'
    ? 'border-red-200 bg-red-50 text-red-800'
    : tone === 'amber'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : tone === 'emerald'
        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
        : tone === 'blue'
          ? 'border-blue-200 bg-blue-50 text-blue-800'
          : 'border-gray-200 bg-gray-50 text-gray-800';
  return (
    <div className={cls('rounded-md border px-3 py-2', toneClass)}>
      <div className="text-[11px] font-semibold uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold">{value || 'None'}</div>
    </div>
  );
}

function ticketPreviewSubtitle(ticket) {
  return [
    ticket?.requester?.name || ticket?.requester?.email,
    ticket?.assignedAgent?.name ? `Assigned: ${ticket.assignedAgent.name}` : null,
    ticket?.priorityLabel,
    ticket?.status,
  ].filter(Boolean).join(' | ');
}

function PreviewStepCard({ step }) {
  const nodeLabel = NODE_LABELS[step.nodeType] || step.nodeType;
  const issue = previewStepIssue(step);
  const tone = issue?.tone || (step.status === 'running' ? 'blue' : 'emerald');
  const classes = previewToneClasses(tone);
  return (
    <div className={cls('rounded-md border p-3 shadow-sm', classes.card)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{nodeLabel}</div>
          <div className="truncate text-sm font-semibold text-gray-900">{step.nodeId}</div>
          <div className="mt-1 text-xs text-gray-600">{summarizePreviewStep(step)}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={cls('rounded-full border px-2 py-0.5 text-xs font-medium', statusClass(step.status))}>
            {step.status}
          </span>
          {issue && (
            <span className={cls('rounded-full border px-2 py-0.5 text-[11px] font-semibold', classes.badge)}>
              {issue.label}
            </span>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500">
        {Number.isFinite(step.durationMs) && <span>{step.durationMs} ms</span>}
        {step.error && <span className="text-red-600">{step.error}</span>}
      </div>
      {issue && (
        <div className={cls('mt-3 flex gap-2 rounded-md border px-3 py-2 text-xs', classes.panel)}>
          <AlertCircle className={cls('mt-0.5 h-3.5 w-3.5 shrink-0', classes.icon)} />
          <span>{issue.detail}</span>
        </div>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-medium text-gray-600">Inspect input/output</summary>
        <div className="mt-2 grid gap-2">
          <pre className="max-h-40 overflow-auto rounded-md bg-gray-950 p-2 text-[11px] leading-5 text-gray-100">{formatJson(step.input)}</pre>
          <pre className="max-h-56 overflow-auto rounded-md bg-gray-950 p-2 text-[11px] leading-5 text-gray-100">{formatJson(step.output)}</pre>
        </div>
      </details>
    </div>
  );
}

function VariablePicker({
  variables,
  search,
  onSearch,
  onInsert,
  activeTarget,
}) {
  const filtered = (variables || []).filter((variable) => {
    const haystack = [
      variable.path,
      variable.token,
      variable.label,
      variable.group,
      variable.description,
    ].join(' ').toLowerCase();
    return haystack.includes(String(search || '').toLowerCase());
  });
  const groups = filtered.reduce((acc, variable) => {
    const group = variable.group || 'Variables';
    if (!acc[group]) acc[group] = [];
    acc[group].push(variable);
    return acc;
  }, {});

  return (
    <div className="rounded-md border border-gray-200 bg-white">
      <div className="border-b border-gray-100 p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2.5 h-3.5 w-3.5 text-gray-400" />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search variables"
            className="w-full rounded-md border border-gray-200 py-2 pl-7 pr-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div className="mt-1 text-[11px] text-gray-500">
          {activeTarget ? 'Click a variable to insert it into the active field.' : 'Focus a prompt or template field, or click to copy.'}
        </div>
      </div>
      <div className="max-h-72 space-y-3 overflow-auto p-2">
        {Object.keys(groups).length === 0 && (
          <div className="rounded-md border border-dashed border-gray-200 p-3 text-center text-xs text-gray-500">
            No matching variables.
          </div>
        )}
        {Object.entries(groups).map(([group, items]) => (
          <div key={group}>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{group}</div>
            <div className="space-y-1">
              {items.map((variable) => (
                <button
                  key={variable.path}
                  type="button"
                  onClick={() => onInsert(variable)}
                  className="w-full rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-left hover:bg-gray-100"
                  title={variable.description}
                >
                  <div className="flex items-center gap-1.5">
                    <Clipboard className="h-3.5 w-3.5 shrink-0 text-gray-500" />
                    <span className="truncate text-xs font-medium text-gray-800">{variable.label || variable.path}</span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-gray-600">{variable.token}</div>
                  {variable.example && <div className="mt-0.5 truncate text-[11px] text-gray-400">Example: {variable.example}</div>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const PROSE_EDITOR_OPTIONS = {
  minimap: { enabled: false },
  wordWrap: 'on',
  fontSize: 14,
  lineNumbers: 'on',
  scrollBeyondLastLine: false,
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  acceptSuggestionOnEnter: 'off',
  tabCompletion: 'off',
  wordBasedSuggestions: 'off',
  parameterHints: { enabled: false },
  hover: { enabled: false },
  links: false,
  inlineSuggest: { enabled: false },
};

function FullContentEditorModal({
  open,
  title,
  description,
  language = 'html',
  value,
  variables,
  variableSearch,
  onVariableSearch,
  onInsertVariable,
  onChange,
  onSave,
  onClose,
}) {
  const editorRef = useRef(null);
  if (!open) return null;

  const insertVariable = (variable) => {
    const token = variable.token || variable;
    const editor = editorRef.current;
    if (!editor) {
      onInsertVariable?.(variable);
      return;
    }
    const selection = editor.getSelection();
    const range = selection || {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    };
    editor.executeEdits('insert-variable', [{ range, text: token, forceMoveMarkers: true }]);
    editor.focus();
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-gray-950/60 p-4">
      <div className="flex h-[86vh] w-full max-w-7xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-950">{title}</h3>
            {description && <p className="mt-1 text-sm text-gray-500">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Close
          </button>
        </div>
        <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-h-0">
            <MonacoEditor
              height="100%"
              language={language}
              value={value || ''}
              onMount={(editorInstance) => {
                editorRef.current = editorInstance;
              }}
              onChange={(next) => onChange(next || '')}
              options={PROSE_EDITOR_OPTIONS}
            />
          </div>
          <aside className="min-h-0 overflow-auto border-l border-gray-200 bg-gray-50 p-3">
            <VariablePicker
              variables={variables}
              search={variableSearch}
              onSearch={onVariableSearch}
              onInsert={insertVariable}
              activeTarget="full-editor"
            />
          </aside>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            className="rounded-md bg-gray-950 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800"
          >
            Apply to workflow
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewModal({
  open,
  preview,
  running,
  error,
  tickets,
  ticketsLoading,
  ticketSearch,
  ticketPage,
  ticketPriority,
  ticketStatus,
  selectedTicket,
  testSending,
  testResult,
  onClose,
  onTicketSearchChange,
  onTicketPriorityChange,
  onTicketStatusChange,
  onTicketPageChange,
  onSelectTicket,
  onRunPreview,
  onSendTestEmail,
  forceActionLinks,
  onForceActionLinksChange,
}) {
  const [showTicketPicker, setShowTicketPicker] = useState(false);
  const [copiedAuditId, setCopiedAuditId] = useState(false);
  const hasPreview = Boolean(preview);

  useEffect(() => {
    if (!open) {
      setShowTicketPicker(false);
      setCopiedAuditId(false);
      return;
    }
    if (hasPreview) setShowTicketPicker(false);
  }, [open, hasPreview, preview?.runId, preview?.auditId]);

  if (!open) return null;

  const steps = preview?.steps || [];
  const email = preview?.state?.email || null;
  const recipients = preview?.state?.recipients || {};
  const llmStep = steps.find((step) => step.nodeType === 'llm_generate');
  const llmOutput = llmFromPreview(preview, steps);
  const auditId = previewAuditId(preview);
  const issues = collectPreviewIssues(preview, steps, email, recipients);
  const failedSteps = steps.filter((step) => step.status === 'failed' || step.output?.failed).length;
  const warningSteps = steps.filter((step) => previewStepIssue(step)?.tone === 'amber').length;
  const completedSteps = steps.filter((step) => step.status === 'completed').length;
  const showPicker = showTicketPicker || !selectedTicket || (!preview && !running);
  const healthTone = issues.some((issue) => issue.tone === 'red') ? 'red' : issues.length > 0 ? 'amber' : preview ? 'emerald' : 'gray';
  const copiedLabel = copiedAuditId ? 'Copied' : 'Copy ID';

  async function copyAuditId() {
    if (!auditId) return;
    try {
      await navigator.clipboard.writeText(auditId);
      setCopiedAuditId(true);
      window.setTimeout(() => setCopiedAuditId(false), 1500);
    } catch {
      setCopiedAuditId(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/45 p-4">
      <div className="mx-auto flex h-full max-w-7xl flex-col overflow-hidden rounded-md bg-white shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-5 py-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Workflow Preview</div>
            <h3 className="text-lg font-semibold text-gray-900">Live step audit</h3>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-500">
              <span>Real workspace ticket, real LLM generation, no workflow-recipient email. Uses current unsaved editor changes.</span>
              {auditId && (
                <button
                  type="button"
                  onClick={copyAuditId}
                  className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 font-mono text-xs font-semibold text-blue-700 hover:bg-blue-100"
                  title="Copy audit ID"
                >
                  <Clipboard className="h-3.5 w-3.5" />
                  {auditId}
                  <span className="font-sans text-[11px]">{copiedLabel}</span>
                </button>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onRunPreview}
              disabled={running || !selectedTicket}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {running ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {preview ? 'Run again' : 'Run preview'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <XCircle className="h-4 w-4" />
              Close
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {running && (
            <div className="mb-4 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
              <RefreshCw className="h-4 w-4 animate-spin" />
              Running workflow preview. LLM calls can take a moment.
            </div>
          )}
          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2">
            <label className="inline-flex items-start gap-2 text-sm text-blue-950">
              <input
                type="checkbox"
                checked={forceActionLinks === true}
                onChange={(event) => onForceActionLinksChange(event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-blue-300 text-blue-600 focus:ring-blue-500"
              />
              <span>
                <span className="font-semibold">Show all checked action blocks for testing</span>
                <span className="block text-xs text-blue-700">Test preview can force timing-gated sections so copy, links, and styling are visible.</span>
              </span>
            </label>
            <span className="rounded-full border border-blue-300 bg-white px-2 py-1 text-xs font-semibold text-blue-700">
              Live sends remain timing-aware
            </span>
          </div>

          {preview && (
            <section className="mb-4 rounded-md border border-gray-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Troubleshooting Summary</div>
                  <h4 className="text-base font-semibold text-gray-900">
                    {issues.length > 0 ? `${issues.length} item${issues.length === 1 ? '' : 's'} need review` : 'Preview completed cleanly'}
                  </h4>
                </div>
                {auditId && (
                  <button
                    type="button"
                    onClick={copyAuditId}
                    className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                  >
                    <Clipboard className="h-3.5 w-3.5" />
                    {copiedAuditId ? 'Copied audit ID' : 'Copy audit ID'}
                  </button>
                )}
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
                <PreviewMetric label="Run status" value={preview.status} tone={healthTone} />
                <PreviewMetric label="Audit ID" value={auditId} tone="gray" />
                <PreviewMetric label="Steps" value={`${completedSteps}/${steps.length} completed`} tone={failedSteps ? 'red' : warningSteps ? 'amber' : 'emerald'} />
                <PreviewMetric label="LLM" value={[llmOutput?.provider, llmOutput?.model].filter(Boolean).join(' / ') || 'Not recorded'} tone={llmOutput?.failed ? 'red' : 'gray'} />
                <PreviewMetric label="Recipients" value={(recipients.to || []).join(', ') || 'None'} tone={(recipients.to || []).length ? 'gray' : 'amber'} />
              </div>
              {issues.length > 0 && (
                <div className="mt-3 grid gap-2 lg:grid-cols-2">
                  {issues.map((issue, index) => {
                    const classes = previewToneClasses(issue.tone);
                    return (
                      <div key={`${issue.title}-${index}`} className={cls('rounded-md border px-3 py-2 text-sm', classes.panel)}>
                        <div className="flex gap-2">
                          <AlertCircle className={cls('mt-0.5 h-4 w-4 shrink-0', classes.icon)} />
                          <div className="min-w-0">
                            <div className="font-semibold">{issue.title}</div>
                            <div className="mt-0.5 text-xs opacity-90">{issue.detail}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {!showPicker && selectedTicket && (
            <section className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold uppercase tracking-wide text-blue-700">Selected test ticket</div>
                  <div className="truncate text-sm font-semibold text-gray-900">#{selectedTicket.freshserviceTicketId} {selectedTicket.subject || 'No subject'}</div>
                  <div className="mt-0.5 truncate text-xs text-gray-600">{ticketPreviewSubtitle(selectedTicket)}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowTicketPicker(true)}
                  className="rounded-md border border-blue-200 bg-white px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                >
                  Change ticket
                </button>
              </div>
            </section>
          )}

          {showPicker && (
            <section className="mb-4 rounded-md border border-gray-200 bg-white p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold text-gray-900">Preview Ticket</h4>
                  <p className="text-xs text-gray-500">Search current-workspace tickets and choose the real ticket context for this preview.</p>
                </div>
                <button
                  type="button"
                  onClick={onRunPreview}
                  disabled={running || !selectedTicket}
                  className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
                >
                  {running ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Run with selected ticket
                </button>
              </div>
              <div className="mb-3 grid gap-2 lg:grid-cols-[minmax(0,1fr)_180px_170px]">
                <label className="min-w-0">
                  <span className="sr-only">Search preview tickets</span>
                  <input
                    value={ticketSearch}
                    onChange={(event) => onTicketSearchChange(event.target.value)}
                    placeholder="Search by ticket number, subject, requester, assignee, or category"
                    className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                  />
                </label>
                <label>
                  <span className="sr-only">Filter by priority</span>
                  <select
                    value={ticketPriority}
                    onChange={(event) => onTicketPriorityChange(event.target.value)}
                    className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                  >
                    {PREVIEW_TICKET_PRIORITY_FILTERS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="sr-only">Filter by status</span>
                  <select
                    value={ticketStatus}
                    onChange={(event) => onTicketStatusChange(event.target.value)}
                    className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                  >
                    {PREVIEW_TICKET_STATUS_FILTERS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {ticketsLoading && (
                  <div className="rounded-md border border-dashed border-gray-300 px-3 py-6 text-center text-sm text-gray-500">
                  Loading tickets...
                  </div>
                )}
                {!ticketsLoading && (tickets?.items || []).length === 0 && (
                  <div className="rounded-md border border-dashed border-gray-300 px-3 py-6 text-center text-sm text-gray-500">
                  No matching tickets in this workspace.
                  </div>
                )}
                {!ticketsLoading && (tickets?.items || []).map((ticket) => (
                  <button
                    key={ticket.id}
                    type="button"
                    onClick={() => {
                      onSelectTicket(ticket);
                      setShowTicketPicker(false);
                    }}
                    className={cls(
                      'min-w-0 rounded-md border px-3 py-2 text-left transition hover:bg-gray-50',
                      selectedTicket?.id === ticket.id ? 'border-blue-400 bg-blue-50 ring-2 ring-blue-100' : 'border-gray-200 bg-white',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-gray-900">#{ticket.freshserviceTicketId} {ticket.subject || 'No subject'}</div>
                        <div className="mt-1 truncate text-xs text-gray-500">{ticketPreviewSubtitle(ticket)}</div>
                      </div>
                      {ticket.isNoise && <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">Noise</span>}
                    </div>
                    <div className="mt-2 text-[11px] text-gray-400">Created {formatDate(ticket.createdAt || ticket.updatedAt)}</div>
                  </button>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
                <span>{tickets?.total || 0} tickets</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onTicketPageChange(Math.max(1, ticketPage - 1))}
                    disabled={ticketPage <= 1 || ticketsLoading}
                    className="rounded-md border border-gray-200 px-2 py-1 font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                  Previous
                  </button>
                  <span>Page {ticketPage} of {tickets?.totalPages || 1}</span>
                  <button
                    type="button"
                    onClick={() => onTicketPageChange(Math.min(tickets?.totalPages || 1, ticketPage + 1))}
                    disabled={ticketPage >= (tickets?.totalPages || 1) || ticketsLoading}
                    className="rounded-md border border-gray-200 px-2 py-1 font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                  Next
                  </button>
                </div>
              </div>
            </section>
          )}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(390px,0.85fr)]">
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h4 className="text-sm font-semibold text-gray-900">Execution Timeline</h4>
                {preview?.status && (
                  <span className={cls('rounded-full border px-2 py-0.5 text-xs font-medium', statusClass(preview.status))}>
                    {preview.status}
                  </span>
                )}
              </div>
              <div className="space-y-3">
                {steps.length === 0 && (
                  <div className="rounded-md border border-dashed border-gray-300 px-3 py-8 text-center text-sm text-gray-500">
                    {running ? 'Waiting for step output...' : 'Run a preview to see step output.'}
                  </div>
                )}
                {steps.map((step) => <PreviewStepCard key={`${step.nodeId}-${step.nodeType}`} step={step} />)}
              </div>
            </section>

            <aside className="space-y-4">
              <div className="rounded-md border border-gray-200 bg-white p-4">
                <div className="mb-2 flex items-center gap-2">
                  <Bot className="h-4 w-4 text-violet-600" />
                  <h4 className="text-sm font-semibold text-gray-900">LLM Diagnostics</h4>
                </div>
                {llmOutput ? (
                  <div className="space-y-2 text-sm">
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-md bg-gray-50 p-2 text-gray-500">Provider<br /><strong className="text-gray-800">{llmOutput.provider || 'unknown'}</strong></div>
                      <div className="rounded-md bg-gray-50 p-2 text-gray-500">Model<br /><strong className="text-gray-800">{llmOutput.model || 'unknown'}</strong></div>
                    </div>
                    {llmOutput.tokenDiagnostics && (
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div className="rounded-md bg-gray-50 p-2 text-gray-500">Output tokens<br /><strong className="text-gray-800">{llmOutput.tokenDiagnostics.outputTokens || 0}</strong></div>
                        <div className="rounded-md bg-gray-50 p-2 text-gray-500">Token cap<br /><strong className="text-gray-800">{llmOutput.tokenDiagnostics.requestedMaxTokens || 'unknown'}</strong></div>
                        <div className={cls(
                          'rounded-md p-2',
                          llmOutput.tokenLimitHit ? 'bg-amber-50 text-amber-800' : 'bg-gray-50 text-gray-500',
                        )}
                        >
                          Limit status<br /><strong>{llmOutput.tokenLimitHit ? 'Hit limit' : 'OK'}</strong>
                        </div>
                      </div>
                    )}
                    {(llmOutput.failed || llmOutput.error) && (
                      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                        <div className="font-semibold">Schema or provider issue</div>
                        <div className="mt-0.5">{llmOutput.error || 'LLM output did not pass validation.'}</div>
                      </div>
                    )}
                    {llmOutput.tokenLimitWarning && (
                      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        {llmOutput.tokenLimitWarning}
                      </div>
                    )}
                    {llmOutput.fallbackUsed && (
                      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        Fallback provider was used{llmOutput.fallbackReason ? `: ${llmOutput.fallbackReason}` : '.'}
                      </div>
                    )}
                    {(llmOutput.repairedFields || []).length > 0 && (
                      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        Missing LLM field{llmOutput.repairedFields.length === 1 ? '' : 's'} repaired from available output: {llmOutput.repairedFields.join(', ')}.
                      </div>
                    )}
                    <details open className="rounded-md border border-gray-200">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Validated email fields</summary>
                      <pre className="max-h-52 overflow-auto border-t border-gray-100 bg-gray-950 p-2 text-[11px] leading-5 text-gray-100">{formatJson(llmOutput.email || llmStep?.output?.email || null)}</pre>
                    </details>
                    {(llmOutput.raw || llmStep?.output) && (
                      <details className="rounded-md border border-gray-200">
                        <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Raw LLM step output</summary>
                        <pre className="max-h-56 overflow-auto border-t border-gray-100 bg-gray-950 p-2 text-[11px] leading-5 text-gray-100">{formatJson(llmOutput.raw || llmStep?.output)}</pre>
                      </details>
                    )}
                    {llmStep?.output?.prompt && (
                      <details className="rounded-md border border-gray-200">
                        <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Rendered prompt</summary>
                        <pre className="max-h-44 overflow-auto border-t border-gray-100 bg-gray-50 p-2 text-[11px] leading-5 text-gray-700">{llmStep.output.prompt}</pre>
                      </details>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">This workflow has no LLM step, or the LLM step has not completed yet.</p>
                )}
              </div>

              <div className="rounded-md border border-gray-200 bg-white p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-blue-600" />
                    <h4 className="text-sm font-semibold text-gray-900">Email Preview</h4>
                  </div>
                  <button
                    type="button"
                    onClick={onSendTestEmail}
                    disabled={!email || testSending || running}
                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    <Send className="h-3.5 w-3.5" />
                    {testSending ? 'Sending...' : 'Send test to me'}
                  </button>
                </div>
                {testResult && (
                  <div className={cls(
                    'mb-3 rounded-md border px-3 py-2 text-xs',
                    testResult.type === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700',
                  )}
                  >
                    {testResult.text}
                  </div>
                )}
                {email ? (
                  <div className="space-y-3">
                    {email.actionLinks && (
                      <ActionLinkDiagnostics diagnostics={email.actionLinks} />
                    )}
                    <div className="rounded-md bg-gray-50 p-3 text-xs text-gray-600">
                      {auditId && <div><span className="font-semibold text-gray-800">Audit ID:</span> {auditId}</div>}
                      <div><span className="font-semibold text-gray-800">Original To:</span> {(recipients.to || []).join(', ') || 'none'}</div>
                      {(recipients.cc || []).length > 0 && <div><span className="font-semibold text-gray-800">Cc:</span> {recipients.cc.join(', ')}</div>}
                      {(recipients.bcc || []).length > 0 && <div><span className="font-semibold text-gray-800">Bcc:</span> {recipients.bcc.join(', ')}</div>}
                    </div>
                    {!(recipients.to || []).length && (
                      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        No original To recipient was resolved. The test email still sends only to your account.
                      </div>
                    )}
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Subject</div>
                      <div className="mt-1 text-sm font-medium text-gray-900">{email.subject}</div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Rendered Body</div>
                      <div className="mt-1 max-h-96 overflow-auto rounded-md border border-gray-200 p-3 text-sm text-gray-700">
                        {email.html ? (
                          <div dangerouslySetInnerHTML={{ __html: email.html }} />
                        ) : (
                          <pre className="whitespace-pre-wrap font-sans">{email.text}</pre>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-gray-300 px-3 py-8 text-center text-sm text-gray-500">
                    The rendered email will appear after preview completes.
                  </div>
                )}
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}

function SignatureModal({
  open,
  signature,
  draft,
  saving,
  message,
  onClose,
  onChange,
  onSave,
  onImport,
}) {
  if (!open) return null;
  const htmlBytes = new Blob([draft.html || '']).size;
  const maxBytes = signature?.maxHtmlBytes || 524288;
  const tooLarge = htmlBytes > maxBytes;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/45 p-4">
      <div className="mx-auto flex h-full max-w-6xl flex-col overflow-hidden rounded-md bg-white shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-5 py-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Workspace Signature</div>
            <h3 className="text-lg font-semibold text-gray-900">Email signature HTML</h3>
            <p className="text-sm text-gray-500">This signature is appended to workflow emails for the current workspace.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
              <UploadCloud className="h-4 w-4" />
              Upload HTML
              <input
                type="file"
                accept=".html,.htm,text/html"
                onChange={(event) => onImport(event.target.files?.[0])}
                className="hidden"
              />
            </label>
            <button
              type="button"
              onClick={onSave}
              disabled={saving || tooLarge}
              className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save signature
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <XCircle className="h-4 w-4" />
              Close
            </button>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
          <section className="min-h-0 border-r border-gray-200 p-4">
            <label className="mb-3 flex items-center gap-2 text-sm font-medium text-gray-700">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
                className="h-4 w-4 rounded border-gray-300 text-blue-600"
              />
              Enable workspace signature
            </label>
            <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
              <span>HTML source</span>
              <span className={tooLarge ? 'font-semibold text-red-600' : ''}>{Math.round(htmlBytes / 1024)} KB / {Math.round(maxBytes / 1024)} KB</span>
            </div>
            <div className="overflow-hidden rounded-md border border-gray-200">
              <MonacoEditor
                height="calc(100vh - 280px)"
                defaultLanguage="html"
                value={draft.html || ''}
                onChange={(value) => onChange({ ...draft, html: value || '', text: draft.text || stripHtmlClient(value || '') })}
                options={{
                  minimap: { enabled: false },
                  wordWrap: 'on',
                  fontSize: 12,
                  lineNumbers: 'off',
                  scrollBeyondLastLine: false,
                }}
              />
            </div>
            <label className="mt-3 block text-xs font-medium uppercase text-gray-500">Plain text fallback</label>
            <textarea
              value={draft.text || ''}
              onChange={(event) => onChange({ ...draft, text: event.target.value })}
              className="mt-1 h-24 w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </section>
          <section className="min-h-0 overflow-auto p-4">
            {message && (
              <div className={cls(
                'mb-3 rounded-md border px-3 py-2 text-sm',
                message.type === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700',
              )}
              >
                {message.text}
              </div>
            )}
            {tooLarge && (
              <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                Signature HTML is too large. Reduce embedded image size before saving.
              </div>
            )}
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Preview</div>
            <div className="min-h-[420px] rounded-md border border-gray-200 bg-white p-4 text-sm text-gray-800">
              {draft.html ? (
                <div dangerouslySetInnerHTML={{ __html: sanitizePreviewHtmlClient(draft.html) }} />
              ) : (
                <div className="flex h-64 items-center justify-center text-gray-500">Upload or paste signature HTML.</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function MockModeBadge({ compact = false }) {
  return (
    <span className={cls(
      'inline-flex shrink-0 items-center gap-1 rounded-full border border-sky-200 bg-sky-50 font-semibold uppercase tracking-wide text-sky-700',
      compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs',
    )}
    >
      <FlaskConical className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
      Mock
    </span>
  );
}

function WorkflowStatus({ workflow }) {
  const isEnabled = !!workflow?.isEnabled;
  return (
    <span className="flex shrink-0 flex-wrap justify-end gap-1">
      {workflow?.mockModeEnabled && <MockModeBadge compact />}
      <span
        className={cls(
          'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
          isEnabled ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-100 text-slate-500',
        )}
      >
        <span className={cls('h-1.5 w-1.5 rounded-full', isEnabled ? 'bg-emerald-500' : 'bg-slate-400')} />
        {isEnabled ? 'Enabled' : 'Disabled'}
      </span>
    </span>
  );
}

function AfterHoursSchedulePreview({ schedule, loading }) {
  const current = schedule?.current || null;
  const next = schedule?.nextActiveWindow || null;
  const upcoming = schedule?.upcomingActiveWindows || [];
  const mode = current?.mode || 'disabled';
  const activeNow = schedule?.activeNow === true;

  return (
    <div className="rounded-md border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Routing window</div>
          <div className="mt-1 text-sm font-semibold text-slate-950">
            {loading && !schedule ? 'Calculating workspace schedule...' : current?.label || 'After-hours routing disabled'}
          </div>
        </div>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-600">
          {schedule?.timezone || 'Workspace timezone'}
        </span>
      </div>

      <div className={cls('mt-3 rounded-md border p-3', routingWindowTone(mode))}>
        <div className="flex items-center gap-2">
          <span className={cls('h-2.5 w-2.5 rounded-full', routingWindowAccent(mode))} />
          <span className="text-xs font-semibold uppercase tracking-wide">
            {activeNow ? 'Active now' : mode === 'standard' ? 'Standard workflow now' : 'Not active now'}
          </span>
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div className="rounded-md bg-white/70 px-2 py-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide opacity-70">From</div>
            <div className="mt-0.5 text-xs font-semibold">{timeOrFallback(current?.startsAtLocal, activeNow ? 'Already active' : 'No active window')}</div>
          </div>
          <div className="rounded-md bg-white/70 px-2 py-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide opacity-70">Until</div>
            <div className="mt-0.5 text-xs font-semibold">{timeOrFallback(current?.endsAtLocal, current?.mode === 'disabled' ? 'Disabled' : 'Always active')}</div>
          </div>
        </div>
        {current?.duration && (
          <div className="mt-2 text-xs font-medium opacity-80">Window length: {current.duration}</div>
        )}
        {current?.reason && (
          <div className="mt-2 text-xs leading-5 opacity-80">{current.reason}</div>
        )}
      </div>

      <div className="mt-3 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-blue-950">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-blue-700">Next after-hours / holiday window</div>
        {next ? (
          <div className="mt-1 text-xs leading-5">
            <span className="font-semibold">{next.label}</span>
            {next.holidayName ? <span> ({next.holidayName})</span> : null}
            <span> starts {next.startsAtLocal || 'soon'}</span>
            {next.endsAtLocal ? <span> and ends {next.endsAtLocal}</span> : null}
            {next.duration ? <span> ({next.duration})</span> : null}
          </div>
        ) : (
          <div className="mt-1 text-xs leading-5">No upcoming active window is available with the current workspace business-hours setup.</div>
        )}
      </div>

      {upcoming.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Upcoming windows</div>
          {upcoming.slice(0, 3).map((window, index) => (
            <div key={`${window.startsAt || index}-${window.endsAt || index}`} className="flex items-center justify-between gap-3 rounded-md border border-slate-100 bg-slate-50 px-2.5 py-2 text-xs text-slate-700">
              <div className="min-w-0">
                <div className="font-semibold text-slate-900">{window.label}{window.holidayName ? `: ${window.holidayName}` : ''}</div>
                <div className="truncate">{window.startsAtLocal || 'Already active'} to {window.endsAtLocal || 'Always active'}</div>
              </div>
              {window.duration && <span className="shrink-0 rounded-full bg-white px-2 py-0.5 font-semibold text-slate-600">{window.duration}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AfterHoursRoutingPanel({
  afterHoursDraft,
  setAfterHoursDraft,
  afterHoursSchedule,
  afterHoursScheduleLoading,
  onSave,
  saving,
  message,
}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-amber-100 text-amber-700">
              <CalendarClock className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-slate-950">After-hours workflow options</h3>
              <p className="text-xs text-slate-500">
                These controls decide when this workflow receives ticket-arrived events before the workflow steps run.
              </p>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save options
        </button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <button
          type="button"
          onClick={() => setAfterHoursDraft((current) => ({ ...current, afterHoursEnabled: !current.afterHoursEnabled }))}
          className={cls(
            'rounded-md border px-3 py-3 text-left transition',
            afterHoursDraft.afterHoursEnabled ? 'border-amber-300 bg-amber-50 text-amber-950' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
          )}
        >
          <div className="flex items-center gap-2 text-sm font-semibold">
            {afterHoursDraft.afterHoursEnabled ? <ToggleRight className="h-5 w-5 text-amber-700" /> : <ToggleLeft className="h-5 w-5 text-slate-400" />}
            Enable off-hours support
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500">Turn this off for workspaces that do not offer after-hours support.</p>
        </button>
        <button
          type="button"
          onClick={() => setAfterHoursDraft((current) => ({ ...current, holidaysEnabled: !current.holidaysEnabled }))}
          className={cls(
            'rounded-md border px-3 py-3 text-left transition',
            afterHoursDraft.holidaysEnabled ? 'border-violet-300 bg-violet-50 text-violet-950' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
          )}
        >
          <div className="flex items-center gap-2 text-sm font-semibold">
            {afterHoursDraft.holidaysEnabled ? <ToggleRight className="h-5 w-5 text-violet-700" /> : <ToggleLeft className="h-5 w-5 text-slate-400" />}
            Include holidays
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500">Use the workspace holiday calendar as an off-hours route.</p>
        </button>
        <button
          type="button"
          onClick={() => setAfterHoursDraft((current) => ({ ...current, suppressStandardTicketCreated: !current.suppressStandardTicketCreated }))}
          className={cls(
            'rounded-md border px-3 py-3 text-left transition',
            afterHoursDraft.suppressStandardTicketCreated ? 'border-blue-300 bg-blue-50 text-blue-950' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
          )}
        >
          <div className="flex items-center gap-2 text-sm font-semibold">
            {afterHoursDraft.suppressStandardTicketCreated ? <ToggleRight className="h-5 w-5 text-blue-700" /> : <ToggleLeft className="h-5 w-5 text-slate-400" />}
            Replace normal received email
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500">On: only this workflow runs. Off: this and the normal Ticket arrived workflow both run.</p>
        </button>
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
        <AfterHoursSchedulePreview schedule={afterHoursSchedule} loading={afterHoursScheduleLoading} />
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">How this workflow is selected</div>
          <div className="mt-2 space-y-2 text-xs leading-5 text-slate-600">
            <p>Ticket arrives, then Ticket Pulse checks workspace business hours and holidays.</p>
            <p>If this route is active, this workflow receives the event before the standard Ticket arrived workflow is considered.</p>
            <p className="font-semibold text-slate-900">
              Current replacement mode: {afterHoursDraft.suppressStandardTicketCreated ? 'standard received email is replaced' : 'standard received email also runs'}.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div>
          <label className="text-xs font-medium uppercase text-slate-500">Emergency support URL</label>
          <input
            value={afterHoursDraft.emergencySupportUrl || ''}
            onChange={(event) => setAfterHoursDraft((current) => ({ ...current, emergencySupportUrl: event.target.value }))}
            placeholder="https://example.com/request-after-hours-support"
            className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div>
          <label className="text-xs font-medium uppercase text-slate-500">Emergency link label</label>
          <input
            value={afterHoursDraft.emergencySupportLabel || ''}
            onChange={(event) => setAfterHoursDraft((current) => ({ ...current, emergencySupportLabel: event.target.value }))}
            placeholder="Request after-hours support"
            className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div>
          <label className="text-xs font-medium uppercase text-slate-500">After-hours message</label>
          <textarea
            value={afterHoursDraft.offHoursMessage || ''}
            onChange={(event) => setAfterHoursDraft((current) => ({ ...current, offHoursMessage: event.target.value }))}
            className="mt-1 h-24 w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div>
          <label className="text-xs font-medium uppercase text-slate-500">Holiday message</label>
          <textarea
            value={afterHoursDraft.holidayMessage || ''}
            onChange={(event) => setAfterHoursDraft((current) => ({ ...current, holidayMessage: event.target.value }))}
            className="mt-1 h-24 w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
        </div>
      </div>

      {message && (
        <div
          className={cls(
            'mt-3 flex items-center gap-2 rounded-md border px-3 py-2 text-sm',
            message.type === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700',
          )}
        >
          {message.type === 'error' ? <AlertCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
          {message.text}
        </div>
      )}
    </div>
  );
}

function WorkflowList({ workflows, selectedId, onSelect }) {
  return (
    <div className="divide-y divide-slate-100 border-t border-slate-100">
      {workflows.map((workflow) => {
        const lastRun = workflow.runs?.[0];
        const isSelected = selectedId === workflow.id;
        const isEnabled = !!workflow.isEnabled;
        const runs = workflow._count?.runs || 0;
        const lastText = lastRun ? `${lastRun.status} ${formatDate(lastRun.startedAt)}` : 'No runs yet';
        return (
          <button
            key={workflow.id}
            type="button"
            onClick={() => onSelect(workflow.id)}
            className={cls(
              'flex w-full flex-col gap-1.5 border-l-2 px-3 py-2.5 text-left transition hover:bg-slate-50',
              isSelected && 'border-l-blue-500 bg-blue-50/80',
              !isSelected && (isEnabled ? 'border-l-emerald-400 bg-white' : 'border-l-slate-200 bg-slate-50/70'),
            )}
          >
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0">
                <div className={cls('truncate text-sm font-semibold leading-5', isEnabled ? 'text-slate-950' : 'text-slate-700')}>
                  {workflow.name}
                </div>
              </div>
              <WorkflowStatus workflow={workflow} />
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-slate-500">
              <span className="truncate">{EVENT_LABELS[workflow.triggerType] || workflow.triggerType}</span>
              {workflow.key === AFTER_HOURS_WORKFLOW_KEY && (
                <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                  Off-hours
                </span>
              )}
              <span className="rounded-full bg-white/80 px-1.5 py-0.5 font-medium text-slate-500 ring-1 ring-slate-200">v{workflow.publishedVersion || 0}</span>
              <span>{runs} {runs === 1 ? 'run' : 'runs'}</span>
            </div>
            <div className="min-w-0 truncate text-[11px] leading-4 text-slate-500">
              <span className="font-medium text-slate-600">Last:</span>{' '}
              {lastText}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function LlmContextToolsPanel({
  policy,
  draft,
  catalog,
  saving,
  message,
  previewTicketId,
  onPreviewTicketIdChange,
  preview,
  previewLoading,
  testRun,
  testLoading,
  onChange,
  onSettingChange,
  onToggleTool,
  onSave,
  onPreview,
  onTestRun,
}) {
  const context = draft?.toolSettings?.context || DEFAULT_LLM_TOOL_POLICY.toolSettings.context;
  const outage = draft?.toolSettings?.outageSignals || DEFAULT_LLM_TOOL_POLICY.toolSettings.outageSignals;
  const safety = draft?.toolSettings?.safety || DEFAULT_LLM_TOOL_POLICY.toolSettings.safety;
  const enabledTools = Array.isArray(draft?.enabledTools) ? draft.enabledTools : [];
  const hasChanges = JSON.stringify(policy || {}) !== JSON.stringify(draft || {});
  const mode = draft?.mode || 'context_only';
  const summary = preview?.summary || null;
  const bundle = preview?.bundle || null;

  const sourceRows = [
    {
      key: 'includeThreadHistory',
      label: 'Thread history',
      description: 'Recent redacted public ticket conversation entries.',
      enabled: context.includeThreadHistory !== false,
    },
    {
      key: 'includeSimilarTickets',
      label: 'Similar tickets',
      description: 'Recent workspace tickets matching category, department, and keywords.',
      enabled: context.includeSimilarTickets !== false,
    },
    {
      key: 'includeOutageSignals',
      label: 'Outage signals',
      description: 'Deterministic ticket-volume signals and allowed public phrasing.',
      enabled: context.includeOutageSignals !== false,
    },
  ];

  return (
    <section className="shrink-0 border-b border-violet-100 bg-white px-6 py-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(360px,0.9fr)_minmax(420px,1.1fr)]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-violet-700" />
                <h3 className="text-sm font-semibold text-slate-950">LLM context and tools</h3>
                <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700">
                  Workspace
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500">Run richer, redacted evidence and approved read-only tools into notification LLMs before any email is sent.</p>
            </div>
            <button
              type="button"
              onClick={onSave}
              disabled={saving || !hasChanges}
              className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save policy
            </button>
          </div>

          <div className="grid gap-2 md:grid-cols-3">
            {LLM_TOOL_POLICY_MODES.map((option) => {
              const active = mode === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onChange({ mode: option.value })}
                  className={cls(
                    'min-h-[76px] rounded-md border px-3 py-2 text-left transition',
                    active ? 'border-violet-300 bg-violet-50 text-violet-950' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                  )}
                >
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="mt-1 block text-xs leading-4 text-slate-500">{option.description}</span>
                </button>
              );
            })}
          </div>

          <div className="grid gap-2 md:grid-cols-3">
            {sourceRows.map((row) => (
              <button
                key={row.key}
                type="button"
                onClick={() => onSettingChange('context', { [row.key]: !row.enabled })}
                disabled={mode === 'off'}
                className={cls(
                  'rounded-md border px-3 py-2 text-left transition disabled:opacity-50',
                  row.enabled && mode !== 'off' ? 'border-emerald-200 bg-emerald-50 text-emerald-950' : 'border-slate-200 bg-slate-50 text-slate-600',
                )}
              >
                <span className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide">
                  {row.label}
                  {row.enabled && mode !== 'off' ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
                </span>
                <span className="mt-1 block text-xs leading-4 text-slate-500">{row.description}</span>
              </button>
            ))}
          </div>

          <div className="grid gap-2 md:grid-cols-4">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Thread entries
              <input
                type="number"
                min="0"
                max="20"
                value={context.maxThreadEntries ?? 6}
                onChange={(event) => onSettingChange('context', { maxThreadEntries: Number(event.target.value) })}
                className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-900"
              />
            </label>
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Similar tickets
              <input
                type="number"
                min="0"
                max="20"
                value={context.maxSimilarTickets ?? 5}
                onChange={(event) => onSettingChange('context', { maxSimilarTickets: Number(event.target.value) })}
                className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-900"
              />
            </label>
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Watch threshold
              <input
                type="number"
                min="2"
                max="100"
                value={outage.watchThreshold ?? 3}
                onChange={(event) => onSettingChange('outageSignals', { watchThreshold: Number(event.target.value) })}
                className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-900"
              />
            </label>
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Context KB
              <input
                type="number"
                min="5"
                max="100"
                value={Math.round((safety.maxContextBytes || 40000) / 1000)}
                onChange={(event) => onSettingChange('safety', { maxContextBytes: Number(event.target.value) * 1000 })}
                className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-900"
              />
            </label>
          </div>

          <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Safety budget</div>
              <div className="text-[11px] font-medium text-slate-500">Hard limits for every tool-mode generation</div>
            </div>
            <div className="grid gap-2 md:grid-cols-5">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Turns
                <input
                  type="number"
                  min="1"
                  max="8"
                  value={draft.maxTurns ?? 4}
                  onChange={(event) => onChange({ maxTurns: Number(event.target.value) })}
                  className="mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Tool calls
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={draft.maxToolCalls ?? 6}
                  onChange={(event) => onChange({ maxToolCalls: Number(event.target.value) })}
                  className="mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Total sec
                <input
                  type="number"
                  min="2"
                  max="60"
                  value={Math.round((draft.totalTimeoutMs || 20000) / 1000)}
                  onChange={(event) => onChange({ totalTimeoutMs: Number(event.target.value) * 1000 })}
                  className="mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Tool sec
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={Math.round((draft.perToolTimeoutMs || 3000) / 1000)}
                  onChange={(event) => onChange({ perToolTimeoutMs: Number(event.target.value) * 1000 })}
                  className="mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Tool KB
                <input
                  type="number"
                  min="2"
                  max="50"
                  value={Math.round((safety.maxToolOutputBytes || 12000) / 1000)}
                  onChange={(event) => onSettingChange('safety', { maxToolOutputBytes: Number(event.target.value) * 1000 })}
                  className="mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                />
              </label>
            </div>
          </div>

          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
            <div className="font-semibold uppercase tracking-wide">Claim controls</div>
            <div>Global, company-wide, confirmed outage, private-note, tool, provider, and audit wording is blocked from requester-facing fields. Similar-report wording is allowed only after threshold evidence.</div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onChange({ redactionEnabled: !draft.redactionEnabled })}
              className={cls(
                'inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs font-semibold',
                draft.redactionEnabled ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700',
              )}
            >
              {draft.redactionEnabled ? <ToggleRight className="h-3.5 w-3.5" /> : <ToggleLeft className="h-3.5 w-3.5" />}
              Redaction {draft.redactionEnabled ? 'on' : 'off'}
            </button>
            <button
              type="button"
              onClick={() => onChange({ includePrivateNotes: !draft.includePrivateNotes })}
              className={cls(
                'inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs font-semibold',
                draft.includePrivateNotes ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-slate-200 bg-slate-50 text-slate-600',
              )}
            >
              {draft.includePrivateNotes ? <ToggleRight className="h-3.5 w-3.5" /> : <ToggleLeft className="h-3.5 w-3.5" />}
              Private notes {draft.includePrivateNotes ? 'internal evidence' : 'excluded'}
            </button>
          </div>

          {mode === 'tools_enabled' && (
            <div className="grid gap-2 md:grid-cols-2">
              {(catalog || []).map((tool) => {
                const enabled = enabledTools.includes(tool.name);
                return (
                  <button
                    key={tool.name}
                    type="button"
                    onClick={() => onToggleTool(tool.name)}
                    className={cls(
                      'rounded-md border px-3 py-2 text-left transition',
                      enabled ? 'border-violet-200 bg-violet-50 text-violet-950' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide">
                      {tool.label}
                      <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] text-slate-500 ring-1 ring-slate-200">{tool.riskLevel}</span>
                    </span>
                    <span className="mt-1 block text-xs leading-4 text-slate-500">{tool.description}</span>
                  </button>
                );
              })}
            </div>
          )}

          {message && (
            <div className={cls(
              'flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold',
              message.type === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700',
            )}
            >
              {message.type === 'error' ? <AlertCircle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              {message.text}
            </div>
          )}
        </div>

        <div className="min-w-0 rounded-md border border-violet-100 bg-slate-50 p-3">
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <label className="min-w-[180px] flex-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Preview ticket ID
              <input
                value={previewTicketId}
                onChange={(event) => onPreviewTicketIdChange(event.target.value)}
                placeholder="Internal Ticket Pulse ID"
                className="mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm normal-case tracking-normal text-slate-900"
              />
            </label>
            <button
              type="button"
              onClick={onPreview}
              disabled={previewLoading || mode === 'off'}
              className="inline-flex items-center gap-1.5 rounded-md border border-violet-200 bg-white px-3 py-2 text-xs font-semibold text-violet-700 hover:bg-violet-50 disabled:opacity-50"
            >
              {previewLoading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
              Preview context
            </button>
            <button
              type="button"
              onClick={onTestRun}
              disabled={testLoading || mode !== 'tools_enabled' || !previewTicketId}
              className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {testLoading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Run tool test
            </button>
          </div>

          {!preview && (
            <div className="flex min-h-[210px] items-center justify-center rounded-md border border-dashed border-slate-200 bg-white px-4 text-center text-sm text-slate-500">
              Preview a real ticket to inspect the evidence bundle, similar-ticket counts, allowed outage wording, and redaction behavior.
            </div>
          )}

          {preview && (
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-4">
                <PreviewMetric label="Mode" value={summary?.mode || mode} tone="gray" />
                <PreviewMetric label="Signal" value={summary?.signalLevel || 'none'} tone={summary?.signalLevel === 'possible_broader_issue' ? 'amber' : 'gray'} />
                <PreviewMetric label="Thread" value={String(summary?.threadEntryCount || 0)} tone="gray" />
                <PreviewMetric label="Redactions" value={String(summary?.redactionCount || 0)} tone={summary?.redactionCount ? 'amber' : 'gray'} />
              </div>
              <div className="rounded-md border border-slate-200 bg-white p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Similar-ticket windows</div>
                <div className="flex flex-wrap gap-2">
                  {(summary?.similarTicketWindows || []).map((window) => (
                    <span key={window.hours} className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                      {window.hours}h: {window.count}
                    </span>
                  ))}
                  {(summary?.similarTicketWindows || []).length === 0 && <span className="text-xs text-slate-500">No windows returned.</span>}
                </div>
                {(summary?.allowedPublicPhrases || []).length > 0 && (
                  <div className="mt-2 text-xs leading-5 text-slate-600">
                    Allowed wording: {summary.allowedPublicPhrases.join('; ')}
                  </div>
                )}
              </div>
              <pre className="max-h-[220px] overflow-auto rounded-md bg-slate-950 p-3 text-[11px] leading-5 text-slate-100">
                {formatJson(bundle)}
              </pre>
            </div>
          )}

          {testRun && (
            <div className="mt-3 rounded-md border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tool test run</div>
                  <div className="text-sm font-semibold text-slate-950">{testRun.status || 'completed'} {testRun.auditId ? `| ${testRun.auditId}` : ''}</div>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">
                  {(testRun.toolSteps || []).length} tool steps
                </span>
              </div>
              <div className="mt-3 space-y-2">
                {(testRun.toolSteps || []).map((step) => (
                  <div key={step.stepRunId || step.nodeId} className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2 font-semibold text-slate-800">
                      <span>{String(step.nodeId || '').split(':')[1] || step.nodeId}</span>
                      <span className={cls('rounded-full px-2 py-0.5', step.status === 'completed' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700')}>
                        {step.status}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-slate-500">
                      {step.output?.accepted ? 'Final email accepted' : JSON.stringify(step.output || {}).slice(0, 180)}
                    </div>
                  </div>
                ))}
                {(testRun.toolSteps || []).length === 0 && (
                  <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">No tool steps were returned.</div>
                )}
              </div>
              {testRun.state?.email?.subject && (
                <div className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                  Final subject: <span className="font-semibold">{testRun.state.email.subject}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function MockAuditPanel({
  workflows,
  selectedWorkflow,
  runs,
  selectedRun,
  loading,
  error,
  filters,
  onFiltersChange,
  onRefresh,
  onSelectRun,
  onClose,
}) {
  const activeRun = selectedRun || runs?.[0] || null;
  const activeDelivery = auditDeliveryForRun(activeRun);
  const activeLlm = auditLlmForRun(activeRun);
  const activeSteps = activeRun?.steps || [];
  const actionDiagnostics = activeDelivery?.payload?.actionLinks || activeDelivery?.payload?.diagnostics?.actionLinks || null;
  const activeContext = activeSteps.find((step) => step.nodeType === 'llm_generate')?.output?.llm?.context
    || activeSteps.find((step) => step.nodeType === 'llm_generate')?.output?.context
    || null;
  const activeEventLabel = EVENT_LABELS[activeRun?.eventType] || activeRun?.eventType || 'Workflow event';
  const bodyHtml = activeDelivery?.htmlBody || null;
  const bodyText = activeDelivery?.textBody || null;

  return (
    <section className="shrink-0 border-b border-sky-100 bg-gradient-to-r from-sky-50 via-white to-slate-50 px-6 py-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-sky-700" />
            <h3 className="text-sm font-semibold text-slate-950">Mock Audit</h3>
            <span className="rounded-full border border-sky-200 bg-white px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-sky-700">
              {runs?.length || 0} runs
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">Real live events and LLM output, with email delivery suppressed.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-sky-200 bg-white px-3 py-2 text-xs font-semibold text-sky-700 hover:bg-sky-50 disabled:opacity-50"
          >
            {loading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            <ChevronUp className="h-3.5 w-3.5" />
            Collapse
          </button>
        </div>
      </div>

      <div className="mb-3 grid gap-2 xl:grid-cols-[220px_150px_150px_minmax(220px,1fr)]">
        <label>
          <span className="sr-only">Filter mock audit by workflow</span>
          <select
            value={filters.workflowId}
            onChange={(event) => onFiltersChange({ ...filters, workflowId: event.target.value })}
            className="w-full rounded-md border border-sky-100 bg-white px-3 py-2 text-xs font-semibold text-slate-700 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-100"
          >
            <option value="selected">Selected workflow</option>
            <option value="all">All workflows</option>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Filter mock audit by date range</span>
          <select
            value={filters.range}
            onChange={(event) => onFiltersChange({ ...filters, range: event.target.value })}
            className="w-full rounded-md border border-sky-100 bg-white px-3 py-2 text-xs font-semibold text-slate-700 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-100"
          >
            {MOCK_AUDIT_RANGES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Filter mock audit by run status</span>
          <select
            value={filters.status}
            onChange={(event) => onFiltersChange({ ...filters, status: event.target.value })}
            className="w-full rounded-md border border-sky-100 bg-white px-3 py-2 text-xs font-semibold text-slate-700 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-100"
          >
            {MOCK_AUDIT_STATUSES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="relative min-w-0">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
          <span className="sr-only">Search mock audit</span>
          <input
            value={filters.search}
            onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
            placeholder="Ticket, subject, workflow, or event"
            className="w-full rounded-md border border-sky-100 bg-white py-2 pl-8 pr-3 text-xs font-medium text-slate-700 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-100"
          />
        </label>
      </div>

      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          <AlertCircle className="h-3.5 w-3.5" />
          {error}
        </div>
      )}

      <div className="grid min-h-[300px] max-h-[430px] gap-4 overflow-hidden xl:grid-cols-[minmax(330px,0.9fr)_minmax(0,1.3fr)]">
        <div className="min-h-0 overflow-auto rounded-md border border-sky-100 bg-white/80">
          {loading && (
            <div className="flex h-full min-h-[220px] items-center justify-center text-sm text-slate-500">
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              Loading mock audit
            </div>
          )}
          {!loading && (!runs || runs.length === 0) && (
            <div className="flex h-full min-h-[220px] items-center justify-center px-6 text-center text-sm text-slate-500">
              No mock runs match the current filters.
            </div>
          )}
          {!loading && runs?.map((run) => {
            const delivery = auditDeliveryForRun(run);
            const llm = auditLlmForRun(run);
            const contextStep = (run.steps || []).find((step) => step.nodeType === 'llm_generate' && (step.output?.llm?.context || step.output?.context));
            const toolCount = (run.steps || []).filter((step) => step.nodeType === 'llm_tool').length
              || (Array.isArray(llm?.toolEvents) ? llm.toolEvents.length : 0);
            const claimGuard = llm?.guard?.accepted === true;
            const selected = activeRun?.id === run.id;
            return (
              <button
                key={run.id}
                type="button"
                onClick={() => onSelectRun(run)}
                className={cls(
                  'flex w-full flex-col gap-2 border-l-2 border-b border-slate-100 px-3 py-3 text-left transition hover:bg-sky-50/70',
                  selected ? 'border-l-sky-500 bg-sky-50' : 'border-l-transparent bg-white/70',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-950">
                      {auditTicketLabel(run)} {auditTicketSubject(run)}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-slate-500">
                      {EVENT_LABELS[run.eventType] || run.eventType} | {formatDate(run.startedAt)}
                    </div>
                  </div>
                  <span className={cls('shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold', statusClass(run.status))}>
                    {run.status}
                  </span>
                </div>
                <div className="grid gap-1 text-[11px] leading-4 text-slate-500">
                  <span className="truncate">Subject: <span className="font-medium text-slate-700">{delivery?.subject || 'No email rendered'}</span></span>
                  <span className="truncate">Recipients: {deliveryRecipientCount(delivery)} | LLM: {[llm?.provider, llm?.model].filter(Boolean).join(' / ') || 'Not recorded'}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {contextStep && <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700">Context</span>}
                  {toolCount > 0 && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700">Tools {toolCount}</span>}
                  {claimGuard && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Claim guard</span>}
                  {(contextStep || toolCount > 0 || claimGuard) && <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700">Evidence</span>}
                </div>
              </button>
            );
          })}
        </div>

        <div className="min-h-0 overflow-auto rounded-md border border-sky-100 bg-white p-4">
          {!activeRun ? (
            <div className="flex h-full min-h-[240px] items-center justify-center text-sm text-slate-500">Select a mock run.</div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-sky-700">{activeEventLabel}</span>
                    <span className={cls('rounded-full border px-2 py-0.5 text-[11px] font-semibold', statusClass(activeDelivery?.status || activeRun.status))}>
                      {activeDelivery?.status || activeRun.status}
                    </span>
                  </div>
                  <h4 className="mt-1 truncate text-base font-semibold text-slate-950">{auditTicketLabel(activeRun)} {auditTicketSubject(activeRun)}</h4>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {activeRun.auditId || `TP-NWF-${activeRun.id}`} | {activeRun.workflow?.name || selectedWorkflow?.name || 'Workflow'} | {formatDate(activeRun.startedAt)}
                  </div>
                </div>
                <MockModeBadge />
              </div>

              <div className="grid gap-2 md:grid-cols-3">
                <PreviewMetric label="Would send" value={activeDelivery ? 'Yes, suppressed' : 'No delivery row'} tone={activeDelivery ? 'blue' : 'amber'} />
                <PreviewMetric label="Recipients" value={String(deliveryRecipientCount(activeDelivery))} tone={deliveryRecipientCount(activeDelivery) ? 'gray' : 'amber'} />
                <PreviewMetric label="LLM" value={[activeLlm?.provider, activeLlm?.model].filter(Boolean).join(' / ') || 'Not recorded'} tone={activeLlm?.status === 'failed' ? 'red' : 'gray'} />
              </div>

              {activeContext && (
                <section className="rounded-md border border-violet-200 bg-violet-50 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-violet-700">LLM evidence</div>
                    {activeContext.contextHash && (
                      <span className="max-w-[220px] truncate rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-violet-700 ring-1 ring-violet-200">
                        {activeContext.contextHash}
                      </span>
                    )}
                  </div>
                  <div className="grid gap-2 text-xs text-slate-700 sm:grid-cols-4">
                    <div>Mode: <span className="font-semibold">{activeContext.mode || 'context_only'}</span></div>
                    <div>Signal: <span className="font-semibold">{activeContext.signalLevel || 'none'}</span></div>
                    <div>Thread: <span className="font-semibold">{activeContext.threadEntryCount || 0}</span></div>
                    <div>Redactions: <span className="font-semibold">{activeContext.redactionCount || 0}</span></div>
                  </div>
                  {(activeContext.allowedPublicPhrases || []).length > 0 && (
                    <div className="mt-2 text-xs leading-5 text-violet-900">
                      Allowed wording: {activeContext.allowedPublicPhrases.join('; ')}
                    </div>
                  )}
                </section>
              )}

              <section className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Recipients</div>
                <div className="space-y-1 text-xs leading-5 text-slate-700">
                  <div>{recipientLine('To', activeDelivery?.toRecipients)}</div>
                  <div>{recipientLine('Cc', activeDelivery?.ccRecipients)}</div>
                  <div>{recipientLine('Bcc', activeDelivery?.bccRecipients)}</div>
                </div>
              </section>

              <section className="rounded-md border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-3 py-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rendered Email</div>
                  <div className="mt-1 text-sm font-semibold text-slate-950">{activeDelivery?.subject || 'No subject rendered'}</div>
                </div>
                <div className="max-h-64 overflow-auto p-3 text-sm leading-6 text-slate-800">
                  {bodyHtml ? (
                    <div dangerouslySetInnerHTML={{ __html: sanitizePreviewHtmlClient(bodyHtml) }} />
                  ) : bodyText ? (
                    <pre className="whitespace-pre-wrap font-sans text-sm leading-6">{bodyText}</pre>
                  ) : (
                    <div className="text-sm text-slate-500">No email body captured for this run.</div>
                  )}
                </div>
              </section>

              <ActionLinkDiagnostics diagnostics={actionDiagnostics} />

              <section>
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <History className="h-3.5 w-3.5" />
                  Step Timeline
                </div>
                <div className="grid gap-2 lg:grid-cols-2">
                  {activeSteps.map((step) => <PreviewStepCard key={step.id || `${step.nodeId}-${step.startedAt}`} step={step} />)}
                </div>
              </section>

              <section className="rounded-md border border-slate-200 bg-slate-950 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-300">Redacted Event Context</div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-100">{formatJson(activeRun.eventContext)}</pre>
              </section>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function FlowMiniMap({ visible, nodes, selectedNodeId, onClose }) {
  if (!visible) return null;

  const mapWidth = 220;
  const mapHeight = 132;
  const padding = 14;
  const nodeWidth = 180;
  const nodeHeight = 62;
  const drawableNodes = nodes || [];
  const minX = Math.min(...drawableNodes.map((node) => node.position.x), 0);
  const minY = Math.min(...drawableNodes.map((node) => node.position.y), 0);
  const maxX = Math.max(...drawableNodes.map((node) => node.position.x + nodeWidth), nodeWidth);
  const maxY = Math.max(...drawableNodes.map((node) => node.position.y + nodeHeight), nodeHeight);
  const scale = Math.min(
    (mapWidth - padding * 2) / Math.max(maxX - minX, nodeWidth),
    (mapHeight - padding * 2) / Math.max(maxY - minY, nodeHeight),
  );

  const rectForNode = (node) => ({
    x: padding + (node.position.x - minX) * scale,
    y: padding + (node.position.y - minY) * scale,
    width: Math.max(12, nodeWidth * scale),
    height: Math.max(6, nodeHeight * scale),
    color: NODE_COLORS[node.data?.nodeType] || '#64748b',
  });

  return (
    <div className="absolute bottom-4 right-4 z-10 rounded-md border border-gray-200 bg-white p-2 shadow-lg">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Map</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-1.5 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100"
          title="Hide map"
        >
          Hide
        </button>
      </div>
      <svg
        width={mapWidth}
        height={mapHeight}
        viewBox={`0 0 ${mapWidth} ${mapHeight}`}
        className="block rounded border border-gray-100 bg-slate-50"
        aria-label="Workflow minimap"
      >
        <rect x="0" y="0" width={mapWidth} height={mapHeight} fill="#f8fafc" />
        {drawableNodes.map((node) => {
          const rect = rectForNode(node);
          return (
            <rect
              key={node.id}
              x={rect.x}
              y={rect.y}
              width={rect.width}
              height={rect.height}
              rx="3"
              fill={rect.color}
              opacity={node.id === selectedNodeId ? 0.95 : 0.65}
              stroke={node.id === selectedNodeId ? '#111827' : rect.color}
              strokeWidth={node.id === selectedNodeId ? 2 : 1}
            />
          );
        })}
      </svg>
      <button
        type="button"
        onClick={onClose}
        className="sr-only"
        title="Hide minimap"
      >
        Hide map
      </button>
    </div>
  );
}

function NodePalette({ definition, onAddLlm, onRemoveNode, showMiniMap, onToggleMiniMap }) {
  const hasLlm = definition?.nodes?.some((node) => node.type === 'llm_generate');
  return (
    <div className="border-b border-gray-100 px-4 py-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Workflow Steps</div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onAddLlm}
          className="inline-flex items-center gap-1.5 rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100"
        >
          <Plus className="h-3.5 w-3.5" />
          {hasLlm ? 'Select LLM' : 'Add LLM'}
        </button>
        <button
          type="button"
          onClick={onRemoveNode}
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          <XCircle className="h-3.5 w-3.5" />
          Remove selected
        </button>
        <button
          type="button"
          onClick={onToggleMiniMap}
          className={cls(
            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-gray-50',
            showMiniMap ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-700',
          )}
        >
          <MapIcon className="h-3.5 w-3.5" />
          {showMiniMap ? 'Hide map' : 'Show map'}
        </button>
      </div>
    </div>
  );
}

export default function NotificationWorkflowsPanel() {
  const editorLayout = useDefaultLayout({
    id: 'ticket-pulse-notification-workflow-editor',
    panelIds: ['workflow-canvas', 'workflow-inspector'],
  });
  const [workflows, setWorkflows] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(null);
  const [selectedNodeId, setSelectedNodeId] = useState('trigger');
  const [health, setHealth] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewRunning, setPreviewRunning] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [previewTickets, setPreviewTickets] = useState({ items: [], page: 1, pageSize: 10, total: 0, totalPages: 1 });
  const [previewTicketsLoading, setPreviewTicketsLoading] = useState(false);
  const [previewTicketSearch, setPreviewTicketSearch] = useState('');
  const [previewTicketPriority, setPreviewTicketPriority] = useState('all');
  const [previewTicketStatus, setPreviewTicketStatus] = useState('all');
  const [previewTicketPage, setPreviewTicketPage] = useState(1);
  const [selectedPreviewTicket, setSelectedPreviewTicket] = useState(null);
  const [forcePreviewActionLinks, setForcePreviewActionLinks] = useState(true);
  const [previewTestSending, setPreviewTestSending] = useState(false);
  const [previewTestResult, setPreviewTestResult] = useState(null);
  const [conditionText, setConditionText] = useState('');
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showMiniMap, setShowMiniMap] = useState(false);
  const [variableCatalog, setVariableCatalog] = useState([]);
  const [variableSearch, setVariableSearch] = useState('');
  const [activeInsertTarget, setActiveInsertTarget] = useState(null);
  const inputRefs = useRef({});
  const [llmTab, setLlmTab] = useState('prompt');
  const [templateTab, setTemplateTab] = useState('rich');
  const [llmSchemaText, setLlmSchemaText] = useState(formatJson(DEFAULT_LLM_OUTPUT_SCHEMA));
  const [llmSchemaError, setLlmSchemaError] = useState(null);
  const [signatureModalOpen, setSignatureModalOpen] = useState(false);
  const [signature, setSignature] = useState({ enabled: false, html: '', text: '', maxHtmlBytes: 524288 });
  const [signatureDraft, setSignatureDraft] = useState({ enabled: false, html: '', text: '' });
  const [signatureSaving, setSignatureSaving] = useState(false);
  const [signatureMessage, setSignatureMessage] = useState(null);
  const [afterHoursPolicy, setAfterHoursPolicy] = useState(DEFAULT_AFTER_HOURS_POLICY);
  const [afterHoursDraft, setAfterHoursDraft] = useState(DEFAULT_AFTER_HOURS_POLICY);
  const [afterHoursSaving, setAfterHoursSaving] = useState(false);
  const [afterHoursMessage, setAfterHoursMessage] = useState(null);
  const [afterHoursSchedule, setAfterHoursSchedule] = useState(null);
  const [afterHoursScheduleLoading, setAfterHoursScheduleLoading] = useState(false);
  const [llmToolCatalog, setLlmToolCatalog] = useState([]);
  const [llmToolPolicy, setLlmToolPolicy] = useState(DEFAULT_LLM_TOOL_POLICY);
  const [llmToolDraft, setLlmToolDraft] = useState(DEFAULT_LLM_TOOL_POLICY);
  const [llmToolSaving, setLlmToolSaving] = useState(false);
  const [llmToolMessage, setLlmToolMessage] = useState(null);
  const [llmToolsOpen, setLlmToolsOpen] = useState(false);
  const [llmContextPreviewTicketId, setLlmContextPreviewTicketId] = useState('');
  const [llmContextPreview, setLlmContextPreview] = useState(null);
  const [llmContextPreviewLoading, setLlmContextPreviewLoading] = useState(false);
  const [llmToolTestRun, setLlmToolTestRun] = useState(null);
  const [llmToolTestLoading, setLlmToolTestLoading] = useState(false);
  const [contentEditor, setContentEditor] = useState(null);
  const [contentEditorValue, setContentEditorValue] = useState('');
  const [mockAuditOpen, setMockAuditOpen] = useState(false);
  const [mockAuditRuns, setMockAuditRuns] = useState([]);
  const [mockAuditLoading, setMockAuditLoading] = useState(false);
  const [mockAuditError, setMockAuditError] = useState(null);
  const [selectedMockRun, setSelectedMockRun] = useState(null);
  const [mockAuditFilters, setMockAuditFilters] = useState({
    workflowId: 'selected',
    range: '7d',
    status: 'all',
    search: '',
  });

  const selectedNode = useMemo(
    () => draft?.nodes?.find((node) => node.id === selectedNodeId) || draft?.nodes?.[0] || null,
    [draft, selectedNodeId],
  );
  const selectedLlmSchemaText = useMemo(
    () => selectedNode?.type === 'llm_generate'
      ? formatJson(selectedNode.data?.outputSchema || DEFAULT_LLM_OUTPUT_SCHEMA)
      : '',
    [selectedNode?.type, selectedNode?.data?.outputSchema],
  );

  function updateDraft(mutator) {
    setDraft((current) => {
      const next = cloneDefinition(current);
      mutator(next);
      return next;
    });
  }

  function updateNodeData(patch) {
    if (!selectedNode) return;
    updateDraft((next) => {
      const node = next.nodes.find((candidate) => candidate.id === selectedNode.id);
      if (node) node.data = { ...(node.data || {}), ...patch };
    });
  }

  function openContentEditor({ field, title, description, language = 'html' }) {
    if (!selectedNode) return;
    setContentEditor({ field, title, description, language, nodeId: selectedNode.id });
    setContentEditorValue(String(selectedNode.data?.[field] || ''));
  }

  function applyContentEditor() {
    if (!contentEditor) return;
    const node = draft?.nodes?.find((candidate) => candidate.id === contentEditor.nodeId);
    if (!node) {
      setContentEditor(null);
      return;
    }
    updateDraft((next) => {
      const target = next.nodes.find((candidate) => candidate.id === contentEditor.nodeId);
      if (target) target.data = { ...(target.data || {}), [contentEditor.field]: contentEditorValue };
    });
    setSelectedNodeId(contentEditor.nodeId);
    setContentEditor(null);
  }

  function registerInputRef(key, element) {
    if (element) inputRefs.current[key] = element;
  }

  function focusInsertTarget(key) {
    setActiveInsertTarget(key);
  }

  function insertIntoTextValue(currentValue, token, element) {
    const value = String(currentValue || '');
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? start;
    return `${value.slice(0, start)}${token}${value.slice(end)}`;
  }

  const editor = useEditor({
    extensions: [StarterKit],
    content: selectedNode?.type === 'template_render' ? selectedNode.data?.html || '' : '',
    editorProps: {
      attributes: {
        class: 'min-h-[260px] max-h-[420px] overflow-y-auto rounded-md border border-gray-200 bg-white px-3 py-2 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-blue-500',
      },
    },
    onUpdate: ({ editor: activeEditor }) => {
      if (selectedNode?.type === 'template_render') {
        updateNodeData({ html: activeEditor.getHTML() });
      }
    },
  }, [selectedNodeId]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || selectedNode?.type !== 'template_render') return;

    const html = selectedNode.data?.html || '';
    try {
      if (editor.getHTML() !== html) {
        editor.commands.setContent(html, false);
      }
    } catch {
      // TipTap can briefly expose a destroyed editor while React Flow changes selection.
    }
  }, [editor, selectedNode]);

  useEffect(() => {
    if (selectedNode?.type === 'condition') {
      setConditionText(JSON.stringify(selectedNode.data?.rule || true, null, 2));
    } else {
      setConditionText('');
    }
  }, [selectedNode]);

  useEffect(() => {
    if (selectedNode?.type === 'llm_generate') {
      setLlmSchemaText(selectedLlmSchemaText);
      setLlmSchemaError(null);
    }
  }, [selectedNodeId, selectedNode?.type, selectedLlmSchemaText]);

  useEffect(() => {
    if (selectedNode?.type === 'llm_generate') {
      setLlmTab('prompt');
    }
    if (selectedNode?.type === 'template_render') {
      setTemplateTab('rich');
    }
  }, [selectedNodeId, selectedNode?.type]);

  async function loadWorkflows(selectId = null) {
    setLoading(true);
    setMessage(null);
    try {
      const [response, healthResponse, variablesResponse, signatureResponse, afterHoursResponse, llmCatalogResponse, llmPolicyResponse] = await Promise.all([
        notificationWorkflowAPI.list(),
        notificationWorkflowAPI.health(),
        notificationWorkflowAPI.variables(),
        notificationWorkflowAPI.getSignature(),
        notificationWorkflowAPI.getAfterHoursPolicy(),
        notificationWorkflowAPI.getLlmToolCatalog(),
        notificationWorkflowAPI.getLlmToolPolicy(),
      ]);
      const items = response.data || [];
      const policy = { ...DEFAULT_AFTER_HOURS_POLICY, ...(afterHoursResponse.data || {}) };
      const llmPolicy = { ...DEFAULT_LLM_TOOL_POLICY, ...(llmPolicyResponse.data || {}) };
      setVariableCatalog(variablesResponse.data || []);
      setLlmToolCatalog(llmCatalogResponse.data || []);
      setLlmToolPolicy(llmPolicy);
      setLlmToolDraft(llmPolicy);
      setSignature(signatureResponse.data || { enabled: false, html: '', text: '' });
      setSignatureDraft({
        enabled: signatureResponse.data?.enabled || false,
        html: signatureResponse.data?.html || '',
        text: signatureResponse.data?.text || '',
      });
      setAfterHoursPolicy(policy);
      setAfterHoursDraft(policy);
      setWorkflows(items);
      setHealth(healthResponse.data || null);
      const nextId = selectId || selected?.id || items[0]?.id;
      if (nextId) await loadWorkflow(nextId, false);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  }

  async function loadWorkflow(id, refreshList = true) {
    setMessage(null);
    const response = await notificationWorkflowAPI.get(id);
    const workflow = response.data;
    setSelected(workflow);
    setDraft(normalizeEditorDefinition(workflow.draftDefinition));
    setSelectedNodeId(workflow.draftDefinition?.nodes?.[0]?.id || 'trigger');
    setPreview(null);
    setPreviewError(null);
    setPreviewTestResult(null);
    setSelectedMockRun(null);
    if (refreshList) {
      const listResponse = await notificationWorkflowAPI.list();
      setWorkflows(listResponse.data || []);
    }
  }

  function applyWorkflowUpdate(updatedWorkflow, { shouldUpdateDraft = true } = {}) {
    if (!updatedWorkflow) return;
    const normalizedDraft = shouldUpdateDraft
      ? normalizeEditorDefinition(updatedWorkflow.draftDefinition)
      : null;

    setSelected((current) => {
      const next = { ...(current || {}), ...updatedWorkflow };
      if (normalizedDraft) next.draftDefinition = normalizedDraft;
      return next;
    });

    if (normalizedDraft) {
      setDraft(normalizedDraft);
    }

    setWorkflows((current) => current.map((workflow) => (
      workflow.id === updatedWorkflow.id
        ? { ...workflow, ...updatedWorkflow }
        : workflow
    )));
  }

  async function refreshHealth() {
    try {
      const response = await notificationWorkflowAPI.health();
      setHealth(response.data || null);
    } catch {
      // Health badges are useful but should not make save/publish look failed.
    }
  }

  async function loadMockAuditRuns(filters = mockAuditFilters) {
    setMockAuditLoading(true);
    setMockAuditError(null);
    try {
      const workflowId = filters.workflowId === 'selected'
        ? selected?.id
        : filters.workflowId === 'all'
          ? null
          : filters.workflowId;
      const response = await notificationWorkflowAPI.getAuditRuns({
        executionMode: 'mock',
        workflowId: workflowId || undefined,
        from: rangeStartIso(filters.range) || undefined,
        status: filters.status !== 'all' ? filters.status : undefined,
        search: filters.search || undefined,
        limit: 50,
      });
      const items = response.data || [];
      setMockAuditRuns(items);
      setSelectedMockRun((current) => (
        current && items.some((run) => run.id === current.id)
          ? items.find((run) => run.id === current.id)
          : items[0] || null
      ));
    } catch (error) {
      setMockAuditError(error.message);
    } finally {
      setMockAuditLoading(false);
    }
  }

  async function toggleMockMode() {
    if (!selected) return;
    const nextEnabled = !selected.mockModeEnabled;
    if (nextEnabled && !(selected?.publishedVersion > 0)) {
      setMessage({ type: 'error', text: 'Publish the workflow before enabling mock mode' });
      return;
    }
    if (nextEnabled && !selected?.isEnabled) {
      setMessage({ type: 'error', text: 'Enable the workflow before enabling mock mode' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const response = await notificationWorkflowAPI.setMockMode(selected.id, nextEnabled);
      applyWorkflowUpdate(response.data, { shouldUpdateDraft: false });
      setMessage({
        type: 'success',
        text: nextEnabled ? 'Mock mode enabled for this workflow' : 'Mock mode disabled for this workflow',
      });
      if (nextEnabled) {
        setMockAuditOpen(true);
      }
      await Promise.all([
        refreshHealth(),
        nextEnabled || mockAuditOpen ? loadMockAuditRuns(mockAuditFilters) : Promise.resolve(),
      ]);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    loadWorkflows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flowNodes = useMemo(() => flowNodesFromDefinition(draft, selectedNodeId), [draft, selectedNodeId]);
  const flowEdges = useMemo(() => flowEdgesFromDefinition(draft), [draft]);
  const availableVariables = useMemo(() => {
    const byPath = new Map((variableCatalog || []).map((variable) => [variable.path, variable]));
    for (const node of draft?.nodes || []) {
      if (node.type !== 'llm_generate') continue;
      const schema = node.data?.outputSchema || DEFAULT_LLM_OUTPUT_SCHEMA;
      for (const field of Object.keys(schema.properties || {})) {
        if (['subject', 'html', 'text'].includes(field)) continue;
        const path = `state.llm.email.extra.${field}`;
        if (!byPath.has(path)) {
          byPath.set(path, {
            path,
            token: `{{ ${path} }}`,
            label: `LLM ${field}`,
            group: 'LLM Output',
            description: `Optional custom field "${field}" returned by the LLM output schema.`,
            example: '',
          });
        }
      }
    }
    return [...byPath.values()];
  }, [draft, variableCatalog]);
  const selectedIsAfterHoursWorkflow = selected?.key === (afterHoursPolicy.offHoursWorkflowKey || AFTER_HOURS_WORKFLOW_KEY)
    || selected?.draftDefinition?.metadata?.scheduleMode === 'after_hours'
    || selected?.publishedDefinition?.metadata?.scheduleMode === 'after_hours';
  const selectedIsPublished = Number(selected?.publishedVersion || 0) > 0;
  const canEnableMockMode = selectedIsPublished && selected?.isEnabled === true;
  const canToggleMockMode = Boolean(selected?.mockModeEnabled || canEnableMockMode);
  const mockModeButtonTitle = selected?.mockModeEnabled
    ? 'Turn mock mode off.'
    : !selectedIsPublished
      ? 'Publish the workflow, then enable it before turning on mock mode.'
      : selected?.isEnabled !== true
        ? 'Enable the published workflow before turning on mock mode.'
        : 'Run real workflow and LLM, but do not send email.';
  const afterHoursScheduleDraft = useMemo(() => ({
    afterHoursEnabled: afterHoursDraft.afterHoursEnabled,
    holidaysEnabled: afterHoursDraft.holidaysEnabled,
    suppressStandardTicketCreated: afterHoursDraft.suppressStandardTicketCreated,
    offHoursWorkflowKey: afterHoursDraft.offHoursWorkflowKey || AFTER_HOURS_WORKFLOW_KEY,
  }), [
    afterHoursDraft.afterHoursEnabled,
    afterHoursDraft.holidaysEnabled,
    afterHoursDraft.suppressStandardTicketCreated,
    afterHoursDraft.offHoursWorkflowKey,
  ]);

  const refreshAfterHoursSchedule = useCallback(async (policyDraft, { silent = false } = {}) => {
    if (!silent) setAfterHoursScheduleLoading(true);
    try {
      const response = await notificationWorkflowAPI.previewAfterHoursPolicy(policyDraft || {});
      setAfterHoursSchedule(response.data || null);
    } catch (error) {
      setAfterHoursSchedule({
        error: error.message,
        current: {
          mode: 'disabled',
          label: 'Schedule unavailable',
          reason: error.message,
        },
      });
    } finally {
      if (!silent) setAfterHoursScheduleLoading(false);
    }
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      refreshAfterHoursSchedule(afterHoursScheduleDraft, { silent: true });
    }, 350);
    return () => window.clearTimeout(handle);
  }, [afterHoursScheduleDraft, refreshAfterHoursSchedule]);

  async function loadPreviewTickets({
    page = previewTicketPage,
    search = previewTicketSearch,
    priority = previewTicketPriority,
    status = previewTicketStatus,
  } = {}) {
    setPreviewTicketsLoading(true);
    setPreviewError(null);
    try {
      const response = await notificationWorkflowAPI.getPreviewTickets({
        page,
        pageSize: 9,
        search,
        priority,
        status,
      });
      const payload = response.data || { items: [], page, pageSize: 9, total: 0, totalPages: 1 };
      setPreviewTickets(payload);
      if (selectedPreviewTicket && !payload.items.some((ticket) => ticket.id === selectedPreviewTicket.id)) {
        setSelectedPreviewTicket(null);
      }
    } catch (error) {
      setPreviewError(error.message);
    } finally {
      setPreviewTicketsLoading(false);
    }
  }

  useEffect(() => {
    if (!previewModalOpen) return undefined;
    const handle = window.setTimeout(() => {
      loadPreviewTickets({
        page: previewTicketPage,
        search: previewTicketSearch,
        priority: previewTicketPriority,
        status: previewTicketStatus,
      });
    }, 250);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewModalOpen, previewTicketPage, previewTicketSearch, previewTicketPriority, previewTicketStatus]);

  useEffect(() => {
    if (!mockAuditOpen) return undefined;
    const handle = window.setTimeout(() => {
      loadMockAuditRuns(mockAuditFilters);
    }, 250);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mockAuditOpen, selected?.id, mockAuditFilters.workflowId, mockAuditFilters.range, mockAuditFilters.status, mockAuditFilters.search]);

  async function saveDraft() {
    if (!selected || !draft) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await notificationWorkflowAPI.saveDraft(selected.id, {
        name: selected.name,
        description: selected.description,
        definition: draft,
      });
      applyWorkflowUpdate(response.data);
      setMessage({ type: 'success', text: 'Saved' });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  }

  async function publishWorkflow() {
    if (!selected) return;
    setSaving(true);
    setMessage(null);
    try {
      await notificationWorkflowAPI.saveDraft(selected.id, {
        name: selected.name,
        description: selected.description,
        definition: draft,
      });
      const shouldStayEnabled = selected.isEnabled === true;
      const response = await notificationWorkflowAPI.publish(selected.id, {
        changeNote: 'Published from Settings workflow editor',
        enabled: shouldStayEnabled,
      });
      applyWorkflowUpdate(response.data.workflow);
      setMessage({
        type: 'success',
        text: shouldStayEnabled
          ? `Published version ${response.data.version.version}. Workflow remains enabled.`
          : `Published version ${response.data.version.version}. Enable it when you are ready for live execution.`,
      });
      await refreshHealth();
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled() {
    if (!selected) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await notificationWorkflowAPI.setEnabled(selected.id, !selected.isEnabled);
      applyWorkflowUpdate(response.data, { shouldUpdateDraft: false });
      setMessage({ type: 'success', text: response.data.isEnabled ? 'Workflow enabled' : 'Workflow disabled' });
      await refreshHealth();
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  }

  function openPreviewModal() {
    setPreviewModalOpen(true);
    setPreview(null);
    setPreviewError(null);
    setPreviewTestResult(null);
    setPreviewTicketPage(1);
  }

  async function runPreview() {
    if (!selected || !draft) return;
    if (!selectedPreviewTicket) {
      setPreviewError('Select a ticket before running preview');
      return;
    }
    setPreviewModalOpen(true);
    setPreviewRunning(true);
    setPreviewError(null);
    setPreviewTestResult(null);
    setMessage(null);
    try {
      const previewDefinition = currentSessionDefinitionForPreview();
      const response = await notificationWorkflowAPI.test({
        workflowId: selected.id,
        ticketId: selectedPreviewTicket.id,
        definition: previewDefinition,
        executeLlm: true,
        forceActionLinks: forcePreviewActionLinks,
      });
      setPreview(response.data);
    } catch (error) {
      setPreviewError(error.message);
    } finally {
      setPreviewRunning(false);
    }
  }

  async function sendPreviewTestEmail() {
    if (!selected || !preview?.state?.email) return;
    setPreviewTestSending(true);
    setPreviewTestResult(null);
    try {
      const email = preview.state.email;
      const response = await notificationWorkflowAPI.sendTestEmail({
        workflowId: selected.id,
        ticketId: selectedPreviewTicket?.id,
        previewRunId: preview.runId,
        auditId: preview.auditId,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      setPreviewTestResult({
        type: 'success',
        text: `Test email sent to ${response.data?.sentTo || 'your account'}${response.data?.deliveryId ? ` (delivery #${response.data.deliveryId})` : ''}`,
      });
    } catch (error) {
      setPreviewTestResult({ type: 'error', text: error.message });
    } finally {
      setPreviewTestSending(false);
    }
  }

  function addLlmNode() {
    if (!draft) return;
    const existing = draft.nodes.find((node) => node.type === 'llm_generate');
    if (existing) {
      updateDraft((next) => applyDisplayLayoutToDraft(next));
      setSelectedNodeId(existing.id);
      return;
    }
    updateDraft((next) => {
      next.nodes.push({
        id: 'llm-generate',
        type: 'llm_generate',
        position: { x: 840, y: 80 },
        data: {
          label: 'Generate email text',
          prompt: 'Use the ticket context below to improve this notification email. Return JSON with subject, html, and text fields.\n\nTicket: #{{ ticket.freshserviceTicketId }} {{ ticket.subject }}\nRequester: {{ requester.name }} <{{ requester.email }}>\nAssigned agent: {{ assignedAgent.name }}',
          systemPrompt: 'You write concise, professional IT helpdesk notification emails. Return JSON only.',
          outputSchema: DEFAULT_LLM_OUTPUT_SCHEMA,
          maxTokens: DEFAULT_LLM_MAX_TOKENS,
          temperature: 0.3,
        },
      });
      const edgeIndex = next.edges.findIndex((edge) => edge.source === 'recipients' && edge.target === 'template');
      if (edgeIndex >= 0) {
        next.edges.splice(edgeIndex, 1,
          { id: 'recipients-to-llm', source: 'recipients', target: 'llm-generate' },
          { id: 'llm-to-template', source: 'llm-generate', target: 'template' });
      } else {
        next.edges.push({ id: 'llm-to-template', source: 'llm-generate', target: 'template' });
      }
      const templateNode = next.nodes.find((node) => node.id === 'template');
      if (templateNode && !templateUsesLlm(templateNode.data)) {
        templateNode.data = addLlmFallbacksToTemplate(templateNode.data);
      }
      applyDisplayLayoutToDraft(next);
    });
    setSelectedNodeId('llm-generate');
  }

  function removeSelectedNode() {
    if (!selectedNode || ['trigger', 'recipients', 'template', 'send'].includes(selectedNode.id)) {
      setMessage({ type: 'error', text: 'Core trigger, recipient, template, and send nodes cannot be removed' });
      return;
    }
    updateDraft((next) => {
      next.nodes = next.nodes.filter((node) => node.id !== selectedNode.id);
      next.edges = next.edges.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id);
      if (selectedNode.type === 'llm_generate' && !next.edges.some((edge) => edge.source === 'recipients' && edge.target === 'template')) {
        next.edges.push({ id: 'recipients-to-template', source: 'recipients', target: 'template' });
      }
    });
    setSelectedNodeId('trigger');
  }

  function applyConditionRule() {
    try {
      const parsed = JSON.parse(conditionText);
      updateNodeData({ rule: parsed });
      setMessage({ type: 'success', text: 'Condition updated' });
    } catch {
      setMessage({ type: 'error', text: 'Condition must be valid JSONLogic JSON' });
    }
  }

  async function copyVariable(variable) {
    try {
      await navigator.clipboard.writeText(variable);
      setMessage({ type: 'success', text: `Copied ${variable}` });
    } catch {
      setMessage({ type: 'error', text: 'Clipboard is not available' });
    }
  }

  function insertVariable(variable) {
    const token = variable.token || variable;
    const target = activeInsertTarget;
    if (!target) {
      copyVariable(token);
      return;
    }

    if (target === 'template-html-rich' && editor && !editor.isDestroyed) {
      editor.chain().focus().insertContent(token).run();
      return;
    }

    if (target === 'llm-system') {
      const element = inputRefs.current[target];
      updateNodeData({ systemPrompt: insertIntoTextValue(selectedNode?.data?.systemPrompt, token, element) });
      return;
    }

    if (target === 'llm-prompt') {
      const element = inputRefs.current[target];
      updateNodeData({ prompt: insertIntoTextValue(selectedNode?.data?.prompt, token, element) });
      return;
    }

    if (target === 'template-subject') {
      const element = inputRefs.current[target];
      updateNodeData({ subject: insertIntoTextValue(selectedNode?.data?.subject, token, element) });
      return;
    }

    if (target === 'template-html-source') {
      const element = inputRefs.current[target];
      updateNodeData({ html: insertIntoTextValue(selectedNode?.data?.html, token, element) });
      return;
    }

    if (target === 'template-text') {
      const element = inputRefs.current[target];
      updateNodeData({ text: insertIntoTextValue(selectedNode?.data?.text, token, element) });
      return;
    }

    copyVariable(token);
  }

  function applyLlmSchemaText(value) {
    setLlmSchemaText(value || '');
    try {
      const parsed = JSON.parse(value || '{}');
      const errors = validateSchemaClient(parsed);
      if (errors.length > 0) {
        setLlmSchemaError(errors.join('; '));
        return;
      }
      setLlmSchemaError(null);
      updateNodeData({ outputSchema: parsed });
    } catch (error) {
      setLlmSchemaError(error.message || 'Schema must be valid JSON');
    }
  }

  function currentSessionDefinitionForPreview() {
    const next = cloneDefinition(draft);
    if (!next) return next;

    const activeNode = selectedNode
      ? next.nodes.find((candidate) => candidate.id === selectedNode.id)
      : null;

    if (activeNode?.type === 'condition' && conditionText.trim()) {
      try {
        activeNode.data = { ...(activeNode.data || {}), rule: JSON.parse(conditionText) };
      } catch {
        throw new Error('Condition must be valid JSONLogic JSON before preview can run');
      }
    }

    if (activeNode?.type === 'llm_generate' && llmSchemaText.trim()) {
      let parsedSchema;
      try {
        parsedSchema = JSON.parse(llmSchemaText);
      } catch (error) {
        throw new Error(error.message || 'LLM output schema must be valid JSON before preview can run');
      }
      const errors = validateSchemaClient(parsedSchema);
      if (errors.length > 0) {
        throw new Error(`LLM output schema is not ready: ${errors.join('; ')}`);
      }
      activeNode.data = { ...(activeNode.data || {}), outputSchema: parsedSchema };
    }

    if (activeNode?.type === 'template_render' && editor && !editor.isDestroyed) {
      activeNode.data = { ...(activeNode.data || {}), html: editor.getHTML() };
    }

    if (contentEditor?.nodeId && contentEditor.field) {
      const editedNode = next.nodes.find((candidate) => candidate.id === contentEditor.nodeId);
      if (editedNode) {
        editedNode.data = { ...(editedNode.data || {}), [contentEditor.field]: contentEditorValue };
      }
    }

    return next;
  }

  function handleFlowNodesChange(changes) {
    if (!draft) return;
    const positionChanges = changes.filter((change) => change.type === 'position' && change.position);
    if (positionChanges.length === 0) return;
    updateDraft((next) => {
      for (const change of positionChanges) {
        const node = next.nodes.find((candidate) => candidate.id === change.id);
        if (node) node.position = change.position;
      }
    });
  }

  async function saveSignature() {
    setSignatureSaving(true);
    setSignatureMessage(null);
    try {
      const response = await notificationWorkflowAPI.updateSignature(signatureDraft);
      const saved = response.data || { enabled: false, html: '', text: '' };
      setSignature(saved);
      setSignatureDraft({ enabled: saved.enabled, html: saved.html || '', text: saved.text || '' });
      setSignatureMessage({ type: 'success', text: 'Workspace signature saved' });
    } catch (error) {
      setSignatureMessage({ type: 'error', text: error.message || 'Signature save failed' });
    } finally {
      setSignatureSaving(false);
    }
  }

  async function saveAfterHoursPolicy() {
    setAfterHoursSaving(true);
    setAfterHoursMessage(null);
    try {
      const response = await notificationWorkflowAPI.updateAfterHoursPolicy(afterHoursDraft);
      const saved = { ...DEFAULT_AFTER_HOURS_POLICY, ...(response.data || {}) };
      setAfterHoursPolicy(saved);
      setAfterHoursDraft(saved);
      setAfterHoursMessage({ type: 'success', text: 'After-hours workflow routing saved' });
      await refreshAfterHoursSchedule(saved);
      const listResponse = await notificationWorkflowAPI.list();
      setWorkflows(listResponse.data || []);
    } catch (error) {
      setAfterHoursMessage({ type: 'error', text: error.message || 'After-hours routing save failed' });
    } finally {
      setAfterHoursSaving(false);
    }
  }

  function updateLlmToolDraft(patch) {
    setLlmToolDraft((current) => ({
      ...current,
      ...patch,
      toolSettings: {
        ...(current.toolSettings || DEFAULT_LLM_TOOL_POLICY.toolSettings),
        ...(patch.toolSettings || {}),
        context: {
          ...(current.toolSettings?.context || DEFAULT_LLM_TOOL_POLICY.toolSettings.context),
          ...(patch.toolSettings?.context || {}),
        },
        outageSignals: {
          ...(current.toolSettings?.outageSignals || DEFAULT_LLM_TOOL_POLICY.toolSettings.outageSignals),
          ...(patch.toolSettings?.outageSignals || {}),
        },
        safety: {
          ...(current.toolSettings?.safety || DEFAULT_LLM_TOOL_POLICY.toolSettings.safety),
          ...(patch.toolSettings?.safety || {}),
        },
      },
    }));
  }

  function updateLlmToolSetting(section, patch) {
    updateLlmToolDraft({
      toolSettings: {
        [section]: patch,
      },
    });
  }

  function toggleLlmTool(toolName) {
    setLlmToolDraft((current) => {
      const enabledTools = Array.isArray(current.enabledTools) ? current.enabledTools : [];
      const next = enabledTools.includes(toolName)
        ? enabledTools.filter((item) => item !== toolName)
        : [...enabledTools, toolName];
      return { ...current, enabledTools: next };
    });
  }

  async function saveLlmToolPolicy() {
    setLlmToolSaving(true);
    setLlmToolMessage(null);
    try {
      const response = await notificationWorkflowAPI.updateLlmToolPolicy(llmToolDraft);
      const saved = { ...DEFAULT_LLM_TOOL_POLICY, ...(response.data || {}) };
      setLlmToolPolicy(saved);
      setLlmToolDraft(saved);
      setLlmToolMessage({ type: 'success', text: 'LLM context policy saved' });
    } catch (error) {
      setLlmToolMessage({ type: 'error', text: error.message || 'LLM context policy save failed' });
    } finally {
      setLlmToolSaving(false);
    }
  }

  async function previewLlmContext() {
    const ticketId = Number.parseInt(llmContextPreviewTicketId || selectedPreviewTicket?.id, 10);
    if (!Number.isFinite(ticketId) || ticketId <= 0) {
      setLlmToolMessage({ type: 'error', text: 'Enter an internal Ticket Pulse ticket ID for context preview' });
      return;
    }
    setLlmContextPreviewLoading(true);
    setLlmToolMessage(null);
    try {
      const response = await notificationWorkflowAPI.previewLlmContext({
        ticketId,
        workflowId: selected?.id || null,
        policy: llmToolDraft,
      });
      setLlmContextPreview(response.data || null);
    } catch (error) {
      setLlmToolMessage({ type: 'error', text: error.message || 'Context preview failed' });
    } finally {
      setLlmContextPreviewLoading(false);
    }
  }

  async function runLlmToolTest() {
    const ticketId = Number.parseInt(llmContextPreviewTicketId || selectedPreviewTicket?.id, 10);
    if (!selected?.id || !Number.isFinite(ticketId) || ticketId <= 0) {
      setLlmToolMessage({ type: 'error', text: 'Select a workflow and enter an internal Ticket Pulse ticket ID for the tool test' });
      return;
    }
    setLlmToolTestLoading(true);
    setLlmToolMessage(null);
    try {
      const response = await notificationWorkflowAPI.testLlmTools({
        workflowId: selected.id,
        ticketId,
        definition: draft,
        forceActionLinks: true,
      });
      setLlmToolTestRun(response.data || response);
      setLlmToolMessage({ type: 'success', text: 'LLM tool test completed' });
    } catch (error) {
      setLlmToolMessage({ type: 'error', text: error.message || 'LLM tool test failed' });
    } finally {
      setLlmToolTestLoading(false);
    }
  }

  async function importSignatureFile(file) {
    if (!file) return;
    const html = await file.text();
    setSignatureDraft((current) => ({ ...current, enabled: true, html, text: stripHtmlClient(html) }));
  }

  function setRecipientList(field, value, checked) {
    const current = Array.isArray(selectedNode?.data?.[field]) ? selectedNode.data[field] : [];
    const next = checked ? [...new Set([...current, value])] : current.filter((item) => item !== value);
    updateNodeData({ [field]: next });
  }

  function renderInspector() {
    if (!selectedNode) return <div className="p-4 text-sm text-gray-500">Select a workflow node.</div>;

    if (selectedNode.type === 'trigger') {
      return (
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium uppercase text-gray-500">Event</label>
            <div className="mt-1 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900">
              {EVENT_LABELS[selectedNode.data?.triggerType] || selectedNode.data?.triggerType}
            </div>
          </div>
        </div>
      );
    }

    if (selectedNode.type === 'condition') {
      return (
        <div className="space-y-3">
          <label className="text-xs font-medium uppercase text-gray-500">JSONLogic Rule</label>
          <textarea
            value={conditionText}
            onChange={(event) => setConditionText(event.target.value)}
            className="h-52 w-full rounded-md border border-gray-200 px-3 py-2 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
          <button
            type="button"
            onClick={applyConditionRule}
            className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3 py-2 text-xs font-semibold text-white hover:bg-gray-800"
          >
            <CheckCircle2 className="h-4 w-4" />
            Apply condition
          </button>
        </div>
      );
    }

    if (selectedNode.type === 'recipient_resolver') {
      const to = selectedNode.data?.to || [];
      const cc = selectedNode.data?.cc || [];
      const customEmails = (selectedNode.data?.customEmails || []).join(', ');
      const showCustomEmailInput = to.includes('custom_emails') || customEmails.length > 0;
      const recipientGroups = [
        {
          key: 'to',
          label: 'To Recipients',
          values: to,
          options: [
            ['requester', 'Requester'],
            ['assigned_agent', 'Assigned agent'],
            ['custom_emails', 'Custom emails'],
          ],
        },
        {
          key: 'cc',
          label: 'Cc Recipients',
          values: cc,
          options: [
            ['original_ccs', 'Original CCs'],
          ],
        },
      ];
      return (
        <div className="space-y-4">
          {recipientGroups.map((group) => (
            <div key={group.key}>
              <label className="text-xs font-medium uppercase text-gray-500">{group.label}</label>
              <div className="mt-2 grid grid-cols-1 gap-2 text-sm">
                {group.options.map(([value, label]) => (
                  <label key={value} className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={group.values.includes(value)}
                      onChange={(event) => setRecipientList(group.key, value, event.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-blue-600"
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
          {showCustomEmailInput && (
            <div>
              <label className="text-xs font-medium uppercase text-gray-500">Custom Emails</label>
              <input
                value={customEmails}
                onChange={(event) => updateNodeData({
                  customEmails: event.target.value.split(',').map((item) => item.trim()).filter(Boolean),
                })}
                placeholder="ops@example.com, lead@example.com"
                className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
            </div>
          )}
        </div>
      );
    }

    if (selectedNode.type === 'llm_generate') {
      const outputFields = Object.keys((selectedNode.data?.outputSchema || DEFAULT_LLM_OUTPUT_SCHEMA).properties || {});
      return (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1 rounded-md bg-gray-100 p-1">
            {[
              ['prompt', 'Prompt', Wand2],
              ['schema', 'Output Schema', FileJson],
              ['settings', 'Settings', PanelRight],
              ['preview', 'Last Preview', Eye],
            ].map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setLlmTab(id)}
                className={cls(
                  'inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-semibold',
                  llmTab === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:bg-white/70',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          {llmTab === 'prompt' && (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-medium uppercase text-gray-500">System Prompt</label>
                  <button
                    type="button"
                    onClick={() => openContentEditor({
                      field: 'systemPrompt',
                      title: 'Edit system prompt',
                      description: 'Use the variable picker to insert live workflow values. Variables are inserted as Liquid tokens.',
                      language: 'plaintext',
                    })}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                    Full editor
                  </button>
                </div>
                <textarea
                  ref={(element) => registerInputRef('llm-system', element)}
                  value={selectedNode.data?.systemPrompt || ''}
                  onFocus={() => focusInsertTarget('llm-system')}
                  onChange={(event) => updateNodeData({ systemPrompt: event.target.value })}
                  className="h-28 w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                />
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-medium uppercase text-gray-500">User Prompt</label>
                  <button
                    type="button"
                    onClick={() => openContentEditor({
                      field: 'prompt',
                      title: 'Edit LLM user prompt',
                      description: 'Large editor with searchable variables for prompt engineering.',
                      language: 'plaintext',
                    })}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                    Full editor
                  </button>
                </div>
                <textarea
                  ref={(element) => registerInputRef('llm-prompt', element)}
                  value={selectedNode.data?.prompt || ''}
                  onFocus={() => focusInsertTarget('llm-prompt')}
                  onChange={(event) => updateNodeData({ prompt: event.target.value })}
                  className="h-72 w-full rounded-md border border-gray-200 px-3 py-2 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                />
              </div>
              <VariablePicker
                variables={availableVariables}
                search={variableSearch}
                onSearch={setVariableSearch}
                onInsert={insertVariable}
                activeTarget={activeInsertTarget}
              />
            </div>
          )}

          {llmTab === 'schema' && (
            <div className="space-y-3">
              <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                The workflow requires <span className="font-semibold">subject</span>, <span className="font-semibold">html</span>, and <span className="font-semibold">text</span>. Add optional fields under properties to make them available in the template picker.
              </div>
              <div className="overflow-hidden rounded-md border border-gray-200">
                <MonacoEditor
                  height="360px"
                  defaultLanguage="json"
                  value={llmSchemaText}
                  onChange={(value) => applyLlmSchemaText(value || '')}
                  options={{
                    minimap: { enabled: false },
                    wordWrap: 'on',
                    fontSize: 12,
                    scrollBeyondLastLine: false,
                  }}
                />
              </div>
              {llmSchemaError ? (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{llmSchemaError}</div>
              ) : (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                  Schema is valid. Available output fields: {outputFields.join(', ')}
                </div>
              )}
            </div>
          )}

          {llmTab === 'settings' && (
            <div className="space-y-3">
              <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
                Provider and fallback are controlled in <span className="font-semibold">{'Settings > AI Providers > Mail Workflow Generation'}</span>.
              </div>
              <div className="rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900">
                Workspace LLM context mode: <span className="font-semibold">{llmToolPolicy.mode || 'context_only'}</span>. This node uses the workspace policy unless context enrichment is disabled below.
              </div>
              <label className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedNode.data?.contextEnrichmentEnabled !== false}
                  onChange={(event) => updateNodeData({ contextEnrichmentEnabled: event.target.checked })}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600"
                />
                Use workspace LLM context enrichment
              </label>
              <div className="grid gap-2 md:grid-cols-3">
                {[
                  ['includeThreadHistory', 'Thread history'],
                  ['includeSimilarTickets', 'Similar tickets'],
                  ['includeOutageSignals', 'Outage signals'],
                ].map(([field, label]) => (
                  <label key={field} className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedNode.data?.[field] !== false}
                      onChange={(event) => updateNodeData({ [field]: event.target.checked })}
                      className="h-4 w-4 rounded border-gray-300 text-blue-600"
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium uppercase text-gray-500">Max tokens</label>
                  <input
                    type="number"
                    min="200"
                    max="10000"
                    value={selectedNode.data?.maxTokens || DEFAULT_LLM_MAX_TOKENS}
                    onChange={(event) => updateNodeData({ maxTokens: Number.parseInt(event.target.value, 10) || DEFAULT_LLM_MAX_TOKENS })}
                    className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium uppercase text-gray-500">Temperature</label>
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.1"
                    value={selectedNode.data?.temperature ?? 0.3}
                    onChange={(event) => updateNodeData({ temperature: Number(event.target.value) })}
                    className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedNode.data?.failWorkflowOnError === true}
                  onChange={(event) => updateNodeData({ failWorkflowOnError: event.target.checked })}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600"
                />
                Fail workflow if LLM generation fails
              </label>
            </div>
          )}

          {llmTab === 'preview' && (
            <div className="space-y-3">
              {preview?.state?.llm ? (
                <pre className="max-h-[520px] overflow-auto rounded-md bg-gray-950 p-3 text-xs leading-5 text-gray-100">{formatJson(preview.state.llm)}</pre>
              ) : (
                <div className="rounded-md border border-dashed border-gray-300 px-3 py-8 text-center text-sm text-gray-500">
                  Run preview to see LLM provider, fallback, usage, and JSON output.
                </div>
              )}
            </div>
          )}
        </div>
      );
    }

    if (selectedNode.type === 'template_render') {
      const contentSource = selectedNode.data?.contentSource || 'template_only';
      const plainTextMode = selectedNode.data?.plainTextMode || 'auto';
      const autoText = stripHtmlClient(selectedNode.data?.html || '');
      const templateVariables = availableVariables;
      return (
        <div className="space-y-4">
          <div>
            <div className="mb-2 text-xs font-medium uppercase text-gray-500">Content Source</div>
            <div className="grid gap-2">
              {TEMPLATE_CONTENT_SOURCES.map(([value, label, description]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => updateNodeData({ contentSource: value })}
                  className={cls(
                    'rounded-md border px-3 py-2 text-left',
                    contentSource === value ? 'border-blue-300 bg-blue-50 text-blue-900' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
                  )}
                >
                  <div className="text-sm font-semibold">{label}</div>
                  <div className="text-xs text-gray-500">{description}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium uppercase text-gray-500">Subject</label>
              <button
                type="button"
                onClick={() => openContentEditor({
                  field: 'subject',
                  title: 'Edit email subject',
                  description: 'Use Liquid variables for ticket and workflow values.',
                  language: 'plaintext',
                })}
                className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
              >
                <Maximize2 className="h-3.5 w-3.5" />
                Full editor
              </button>
            </div>
            <input
              ref={(element) => registerInputRef('template-subject', element)}
              value={selectedNode.data?.subject || ''}
              onFocus={() => focusInsertTarget('template-subject')}
              onChange={(event) => updateNodeData({ subject: event.target.value })}
              className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </div>

          <div className="flex flex-wrap gap-1 rounded-md bg-gray-100 p-1">
            {[
              ['rich', 'Rich HTML', Type],
              ['source', 'HTML Source', Code],
              ['text', 'Plain Text', FileJson],
              ['preview', 'Rendered Preview', Eye],
            ].map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTemplateTab(id)}
                className={cls(
                  'inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-semibold',
                  templateTab === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:bg-white/70',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
            <div className="min-w-0">
              {templateTab === 'rich' && (
                <div>
                  <label className="text-xs font-medium uppercase text-gray-500">HTML Body</label>
                  <div className="mt-1" onFocus={() => focusInsertTarget('template-html-rich')}>
                    {editor && !editor.isDestroyed ? (
                      <EditorContent editor={editor} />
                    ) : (
                      <div className="min-h-[220px] rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500">
                        Loading editor...
                      </div>
                    )}
                  </div>
                </div>
              )}

              {templateTab === 'source' && (
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-medium uppercase text-gray-500">HTML Source</label>
                    <button
                      type="button"
                      onClick={() => openContentEditor({
                        field: 'html',
                        title: 'Edit HTML email body',
                        description: 'Monaco editor with searchable Liquid variables. Use this for larger rich HTML templates.',
                        language: 'html',
                      })}
                      className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                      Full editor
                    </button>
                  </div>
                  <textarea
                    ref={(element) => registerInputRef('template-html-source', element)}
                    value={selectedNode.data?.html || ''}
                    onFocus={() => focusInsertTarget('template-html-source')}
                    onChange={(event) => updateNodeData({ html: event.target.value })}
                    className="mt-1 h-80 w-full rounded-md border border-gray-200 px-3 py-2 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                  />
                </div>
              )}

              {templateTab === 'text' && (
                <div className="space-y-3">
                  <label className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm">
                    <input
                      type="radio"
                      checked={plainTextMode === 'auto'}
                      onChange={() => updateNodeData({ plainTextMode: 'auto' })}
                      className="h-4 w-4 border-gray-300 text-blue-600"
                    />
                    Auto-generate plain text from HTML
                  </label>
                  <label className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm">
                    <input
                      type="radio"
                      checked={plainTextMode === 'custom'}
                      onChange={() => updateNodeData({ plainTextMode: 'custom', text: selectedNode.data?.text || autoText })}
                      className="h-4 w-4 border-gray-300 text-blue-600"
                    />
                    Custom plain text fallback
                  </label>
                  {plainTextMode === 'custom' ? (
                    <div>
                      <div className="mb-1 flex items-center justify-end">
                        <button
                          type="button"
                          onClick={() => openContentEditor({
                            field: 'text',
                            title: 'Edit plain text fallback',
                            description: 'Plain text fallback with searchable Liquid variables.',
                            language: 'plaintext',
                          })}
                          className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                        >
                          <Maximize2 className="h-3.5 w-3.5" />
                          Full editor
                        </button>
                      </div>
                      <textarea
                        ref={(element) => registerInputRef('template-text', element)}
                        value={selectedNode.data?.text || ''}
                        onFocus={() => focusInsertTarget('template-text')}
                        onChange={(event) => updateNodeData({ text: event.target.value })}
                        className="h-64 w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                      />
                    </div>
                  ) : (
                    <pre className="h-64 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 whitespace-pre-wrap">{autoText || 'Plain text will be generated from the HTML body.'}</pre>
                  )}
                </div>
              )}

              {templateTab === 'preview' && (
                <div className="space-y-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Subject</div>
                    <div className="mt-1 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900">{selectedNode.data?.subject || 'Ticket Pulse notification'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">HTML preview</div>
                    <div className="mt-1 max-h-96 overflow-auto rounded-md border border-gray-200 p-3 text-sm text-gray-700">
                      <div dangerouslySetInnerHTML={{ __html: sanitizePreviewHtmlClient(selectedNode.data?.html || '') }} />
                    </div>
                  </div>
                </div>
              )}
            </div>
            <VariablePicker
              variables={templateVariables}
              search={variableSearch}
              onSearch={setVariableSearch}
              onInsert={insertVariable}
              activeTarget={activeInsertTarget}
            />
          </div>
        </div>
      );
    }

    if (selectedNode.type === 'send_email') {
      const linkOptions = [
        {
          key: 'appendPublicStatusLink',
          title: 'Append public status link before signature',
          description: 'Adds a requester-facing link that shows latest Ticket Pulse status, current assignee, and estimate even if the ticket moves between people.',
          activePreview: 'Check the latest ticket status: View ticket status and estimate. The assigned person may change as the team works through the request; this link stays current.',
          liveRule: 'Live rule: renders whenever a public status URL exists.',
          color: 'blue',
        },
        {
          key: 'appendRaiseUrgencyLink',
          title: 'Append business-hours raise urgency link',
          description: 'Adds a link where the requester can mark the ticket Urgent during business hours. This does not page the after-hours escalation roster.',
          activePreview: 'Need this reviewed as urgent? Raise ticket urgency. The assigned agent may be notified based on their own High/Urgent notification preferences.',
          liveRule: 'Live rule: renders during business hours only.',
          color: 'amber',
        },
        {
          key: 'appendAfterHoursSupportLink',
          title: 'Append after-hours immediate support link',
          description: 'Adds the hosted after-hours page where the requester can review response windows and request immediate support. It only submits during off-hours or holidays.',
          activePreview: 'Need immediate after-hours support? Request immediate support. Ticket Pulse will alert the configured after-hours escalation roster only after confirmation.',
          liveRule: 'Live rule: renders for after-hours/holiday workflows and requires an active contact phone.',
          color: 'red',
        },
      ];
      return (
        <div className="space-y-3">
          {linkOptions.map((option) => {
            const enabled = selectedNode.data?.[option.key] === true;
            const enabledClass = option.color === 'red'
              ? 'border-red-300 bg-red-50 text-red-950'
              : option.color === 'amber'
                ? 'border-amber-300 bg-amber-50 text-amber-950'
                : 'border-blue-300 bg-blue-50 text-blue-950';
            const iconClass = option.color === 'red'
              ? 'text-red-600'
              : option.color === 'amber'
                ? 'text-amber-600'
                : 'text-blue-600';
            const previewClass = option.color === 'red'
              ? 'border-red-200 text-red-900'
              : option.color === 'amber'
                ? 'border-amber-200 text-amber-900'
                : 'border-blue-200 text-blue-900';
            return (
              <button
                key={option.key}
                type="button"
                onClick={() => updateNodeData({ [option.key]: !enabled })}
                className={cls(
                  'flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left transition',
                  enabled ? enabledClass : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
                )}
              >
                {enabled ? (
                  <ToggleRight className={cls('mt-0.5 h-5 w-5 shrink-0', iconClass)} />
                ) : (
                  <ToggleLeft className="mt-0.5 h-5 w-5 shrink-0 text-gray-400" />
                )}
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {option.title}
                    <span className={cls(
                      'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                      enabled ? 'bg-white/80 text-current ring-1 ring-current/20' : 'bg-gray-100 text-gray-500',
                    )}
                    >
                      {enabled ? 'Included' : 'Off'}
                    </span>
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-gray-500">{option.description}</span>
                  <span className="mt-1 block text-xs font-semibold leading-5 text-gray-700">{option.liveRule}</span>
                  <span className="block text-xs leading-5 text-gray-500">Preview/test can force selected blocks so admins can inspect the full email.</span>
                  {enabled && (
                    <span className={cls('mt-2 block rounded-md border bg-white/70 px-3 py-2 text-xs leading-5', previewClass)}>
                      {option.activePreview}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
          <div>
            <label className="text-xs font-medium uppercase text-gray-500">Provider</label>
            <div className="mt-1 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900">SendGrid</div>
          </div>
          <div>
            <label className="text-xs font-medium uppercase text-gray-500">From Address Override</label>
            <input
              value={selectedNode.data?.fromAddress || ''}
              onChange={(event) => updateNodeData({ fromAddress: event.target.value })}
              placeholder="Use configured SendGrid sender"
              className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </div>
        </div>
      );
    }

    return (
      <div>
        <label className="text-xs font-medium uppercase text-gray-500">Reason</label>
        <input
          value={selectedNode.data?.reason || ''}
          onChange={(event) => updateNodeData({ reason: event.target.value })}
          className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center text-sm text-gray-500">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        Loading notification workflows
      </div>
    );
  }

  return (
    <div className="tp-glass-strong m-3 flex h-[calc(100dvh-8.5rem)] min-h-0 max-h-[calc(100dvh-8.5rem)] flex-col overflow-hidden rounded-2xl border border-white/70 sm:m-4">
      <div className="shrink-0 border-b border-white/70 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-gray-900">Notification Workflows</h2>
              {selected?.mockModeEnabled && <MockModeBadge />}
            </div>
            <p className="text-sm text-gray-500">Workspace-scoped email workflows for ticket lifecycle events.</p>
          </div>
          {health && (
            <div className="grid grid-cols-2 gap-2 text-xs xl:grid-cols-4">
              <div className="rounded-lg border border-white/70 bg-white/70 px-3 py-2 shadow-subtle">
                <div className="text-gray-500">SendGrid</div>
                <div className={cls('font-semibold', health.sendgridConfigured ? 'text-emerald-700' : 'text-red-700')}>
                  {health.sendgridConfigured ? `Configured${health.sendgridMode === 'smtp' ? ' (SMTP)' : ''}` : 'Missing'}
                </div>
              </div>
              <div className="rounded-lg border border-white/70 bg-white/70 px-3 py-2 shadow-subtle">
                <div className="text-gray-500">Enabled</div>
                <div className="font-semibold text-gray-900">{health.enabledWorkflows || 0}</div>
              </div>
              <div className="rounded-lg border border-white/70 bg-white/70 px-3 py-2 shadow-subtle">
                <div className="text-gray-500">Mock</div>
                <div className="font-semibold text-sky-700">{health.mockEnabledWorkflows || 0} on / {health.mockedDeliveries7d || 0} 7d</div>
              </div>
              <div className="rounded-lg border border-white/70 bg-white/70 px-3 py-2 shadow-subtle">
                <div className="text-gray-500">Failures 24h</div>
                <div className={cls('font-semibold', health.failedEmailDeliveries24h ? 'text-red-700' : 'text-gray-900')}>
                  {health.failedEmailDeliveries24h || 0}
                </div>
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setSignatureModalOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <Mail className="h-4 w-4" />
              Signature
              {signature?.enabled && <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">On</span>}
            </button>
            <button
              type="button"
              onClick={() => setLlmToolsOpen((current) => !current)}
              className={cls(
                'inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium',
                llmToolsOpen ? 'border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
              )}
            >
              <Bot className="h-4 w-4" />
              LLM context
              <span className="rounded-full bg-white/80 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                {llmToolPolicy?.mode === 'tools_enabled' ? 'Tools' : llmToolPolicy?.mode === 'off' ? 'Off' : 'Context'}
              </span>
              {llmToolsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => loadWorkflows(selected?.id)}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
            <button
              type="button"
              onClick={saveDraft}
              disabled={saving || !selected}
              className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              Save
            </button>
            <button
              type="button"
              onClick={openPreviewModal}
              disabled={saving || previewRunning || !selected}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {previewRunning ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {previewRunning ? 'Previewing' : 'Preview'}
            </button>
            <button
              type="button"
              onClick={publishWorkflow}
              title={selected?.isEnabled ? 'Publish the current draft update and keep this workflow enabled.' : 'Publish the current draft without enabling live execution.'}
              disabled={saving || !selected}
              className="inline-flex h-10 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-slate-400 hover:bg-slate-50 disabled:opacity-50"
            >
              <Upload className="h-4 w-4" />
              {selected?.isEnabled ? 'Publish update' : 'Publish'}
            </button>
            <button
              type="button"
              onClick={() => setMockAuditOpen((current) => !current)}
              disabled={!selected}
              className={cls(
                'inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-semibold disabled:opacity-50',
                mockAuditOpen ? 'border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
              )}
            >
              <History className="h-4 w-4" />
              Mock Audit
              {mockAuditOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={toggleMockMode}
              disabled={saving || !selected || !canToggleMockMode}
              title={mockModeButtonTitle}
              className={cls(
                'inline-flex h-10 items-center gap-1.5 rounded-md px-3 text-sm font-semibold disabled:opacity-50',
                selected?.mockModeEnabled ? 'bg-sky-50 text-sky-700 hover:bg-sky-100' : 'bg-slate-100 text-slate-700 hover:bg-slate-200',
              )}
            >
              {selected?.mockModeEnabled ? <ToggleRight className="h-4 w-4" /> : <FlaskConical className="h-4 w-4" />}
              <span>{selected?.mockModeEnabled ? 'Mock on' : 'Mock mode'}</span>
            </button>
            <button
              type="button"
              onClick={toggleEnabled}
              disabled={saving || !selected || (!selected?.isEnabled && !selectedIsPublished)}
              title={selected?.isEnabled ? 'Disable live workflow execution.' : selectedIsPublished ? 'Enable the latest published workflow version.' : 'Publish the workflow before enabling live execution.'}
              className={cls(
                'inline-flex h-10 items-center gap-1.5 rounded-md px-3 text-sm font-semibold disabled:opacity-50',
                selected?.isEnabled ? 'bg-red-50 text-red-700 hover:bg-red-100' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
              )}
            >
              {selected?.isEnabled ? <ToggleLeft className="h-4 w-4" /> : <ToggleRight className="h-4 w-4" />}
              {selected?.isEnabled ? 'Disable' : selectedIsPublished ? 'Enable' : 'Publish first'}
            </button>
          </div>
        </div>
        {message && (
          <div
            className={cls(
              'mt-3 flex items-center gap-2 rounded-md border px-3 py-2 text-sm',
              message.type === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700',
            )}
          >
            {message.type === 'error' ? <AlertCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
            {message.text}
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        {selectedIsAfterHoursWorkflow && (
          <section className="shrink-0 overflow-y-auto border-b border-amber-100 bg-amber-50/40 px-6 py-4 lg:max-h-[250px]">
            <AfterHoursRoutingPanel
              afterHoursDraft={afterHoursDraft}
              setAfterHoursDraft={setAfterHoursDraft}
              afterHoursSchedule={afterHoursSchedule}
              afterHoursScheduleLoading={afterHoursScheduleLoading}
              onSave={saveAfterHoursPolicy}
              saving={afterHoursSaving}
              message={afterHoursMessage}
            />
          </section>
        )}

        {llmToolsOpen && (
          <LlmContextToolsPanel
            policy={llmToolPolicy}
            draft={llmToolDraft}
            catalog={llmToolCatalog}
            saving={llmToolSaving}
            message={llmToolMessage}
            previewTicketId={llmContextPreviewTicketId}
            onPreviewTicketIdChange={setLlmContextPreviewTicketId}
            preview={llmContextPreview}
            previewLoading={llmContextPreviewLoading}
            testRun={llmToolTestRun}
            testLoading={llmToolTestLoading}
            onChange={updateLlmToolDraft}
            onSettingChange={updateLlmToolSetting}
            onToggleTool={toggleLlmTool}
            onSave={saveLlmToolPolicy}
            onPreview={previewLlmContext}
            onTestRun={runLlmToolTest}
          />
        )}

        {mockAuditOpen && (
          <MockAuditPanel
            workflows={workflows}
            selectedWorkflow={selected}
            runs={mockAuditRuns}
            selectedRun={selectedMockRun}
            loading={mockAuditLoading}
            error={mockAuditError}
            filters={mockAuditFilters}
            onFiltersChange={setMockAuditFilters}
            onRefresh={() => loadMockAuditRuns(mockAuditFilters)}
            onSelectRun={setSelectedMockRun}
            onClose={() => setMockAuditOpen(false)}
          />
        )}

        <div className={cls(
          'grid min-h-0 grid-cols-1 overflow-hidden lg:grid-cols-[220px_minmax(0,1fr)]',
          llmToolsOpen || mockAuditOpen || selectedIsAfterHoursWorkflow
            ? 'h-[560px] shrink-0'
            : 'flex-1',
        )}>
          <aside className="z-10 min-h-0 overflow-y-auto border-r border-gray-200 bg-slate-50/90">
            <div className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-gray-500">Workspace Workflows</div>
            <WorkflowList workflows={workflows} selectedId={selected?.id} onSelect={loadWorkflow} />
          </aside>

          <PanelGroup
            id="ticket-pulse-notification-workflow-editor"
            orientation="horizontal"
            defaultLayout={editorLayout.defaultLayout}
            onLayoutChanged={editorLayout.onLayoutChanged}
            className="min-h-0 min-w-0"
          >
            <Panel id="workflow-canvas" minSize="50%" defaultSize="62%">
              <main className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-r border-gray-200">
                <NodePalette
                  definition={draft}
                  onAddLlm={addLlmNode}
                  onRemoveNode={removeSelectedNode}
                  showMiniMap={showMiniMap}
                  onToggleMiniMap={() => setShowMiniMap((current) => !current)}
                />
                <div className="relative min-h-[360px] flex-1 overflow-hidden bg-gray-50">
                  {draft ? (
                    <ReactFlow
                      nodes={flowNodes}
                      edges={flowEdges}
                      fitView
                      minZoom={0.25}
                      maxZoom={1.6}
                      onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
                      onNodesChange={handleFlowNodesChange}
                    >
                      <FlowMiniMap
                        visible={showMiniMap}
                        nodes={flowNodes}
                        selectedNodeId={selectedNodeId}
                        onClose={() => setShowMiniMap(false)}
                      />
                      <Controls />
                      <Background gap={18} color="#e5e7eb" />
                    </ReactFlow>
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-gray-500">Select a workflow</div>
                  )}
                </div>
              </main>
            </Panel>

            <PanelResizeHandle id="workflow-editor-resizer" className="w-1 bg-gray-100 transition hover:bg-blue-300" />

            <Panel id="workflow-inspector" minSize="30%" maxSize="50%" defaultSize="38%">
              <aside className="flex h-full min-h-0 flex-col overflow-hidden bg-white">
                <div className="shrink-0 border-b border-gray-200 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Inspector</div>
                      <h3 className="text-sm font-semibold text-gray-900">{selectedNode ? NODE_LABELS[selectedNode.type] || selectedNode.type : 'No node selected'}</h3>
                    </div>
                    {selectedNode?.type === 'llm_generate' && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
                        <Bot className="h-3.5 w-3.5" />
                        Auto send
                      </span>
                    )}
                    {selectedNode?.type === 'send_email' && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                        <Send className="h-3.5 w-3.5" />
                        Email
                      </span>
                    )}
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
                  {renderInspector()}
                </div>
              </aside>
            </Panel>
          </PanelGroup>
        </div>
      </div>
      <FullContentEditorModal
        open={Boolean(contentEditor)}
        title={contentEditor?.title}
        description={contentEditor?.description}
        language={contentEditor?.language}
        value={contentEditorValue}
        variables={availableVariables}
        variableSearch={variableSearch}
        onVariableSearch={setVariableSearch}
        onInsertVariable={insertVariable}
        onChange={setContentEditorValue}
        onSave={applyContentEditor}
        onClose={() => setContentEditor(null)}
      />
      <PreviewModal
        open={previewModalOpen}
        preview={preview}
        running={previewRunning}
        error={previewError}
        tickets={previewTickets}
        ticketsLoading={previewTicketsLoading}
        ticketSearch={previewTicketSearch}
        ticketPage={previewTicketPage}
        ticketPriority={previewTicketPriority}
        ticketStatus={previewTicketStatus}
        selectedTicket={selectedPreviewTicket}
        testSending={previewTestSending}
        testResult={previewTestResult}
        onClose={() => setPreviewModalOpen(false)}
        onTicketSearchChange={(value) => {
          setPreviewTicketSearch(value);
          setPreviewTicketPage(1);
        }}
        onTicketPriorityChange={(value) => {
          setPreviewTicketPriority(value);
          setPreviewTicketPage(1);
        }}
        onTicketStatusChange={(value) => {
          setPreviewTicketStatus(value);
          setPreviewTicketPage(1);
        }}
        onTicketPageChange={setPreviewTicketPage}
        onSelectTicket={(ticket) => {
          setSelectedPreviewTicket(ticket);
          setPreview(null);
          setPreviewError(null);
          setPreviewTestResult(null);
        }}
        onRunPreview={runPreview}
        onSendTestEmail={sendPreviewTestEmail}
        forceActionLinks={forcePreviewActionLinks}
        onForceActionLinksChange={setForcePreviewActionLinks}
      />
      <SignatureModal
        open={signatureModalOpen}
        signature={signature}
        draft={signatureDraft}
        saving={signatureSaving}
        message={signatureMessage}
        onClose={() => setSignatureModalOpen(false)}
        onChange={setSignatureDraft}
        onSave={saveSignature}
        onImport={importSignatureFile}
      />
    </div>
  );
}
