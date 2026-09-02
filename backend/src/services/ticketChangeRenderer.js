import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { escapeHtml } from '../utils/htmlContent.js';
import { actorKindOf } from '../utils/actorKind.js';

/**
 * Shared field-change renderer (MEGA 09-01 Phase TU, TU-5).
 *
 * ONE place that turns a `{ field: { from, to } }` diff — from
 * updateTicketFields, customFieldService.setValues, updateFsTicket, an API
 * resubmission, the workflow update_ticket node, or the FS sync diff — into
 * the payload the `ticket.fields_updated` workflow event carries:
 *
 *   changes          { field: { from, to, label, fromLabel, toLabel } }
 *   changesList      [{ field, label, from, to, fromLabel, toLabel }]
 *   changesTableHtml <table>Field | Before | After</table>
 *   changesText      "Priority: Medium (2) → High (3)" lines
 *
 * Category / group / technician ids resolve to NAMES (best-effort, never
 * throws). Description renders as "changed" only — never the body, so a
 * workflow email can't leak a requester's text into the wrong inbox.
 *
 * Also home of the resubmission diff-note renderers (moved out of
 * ticketResubmissionService so both surfaces read the same labels).
 */

export const FIELD_LABELS = Object.freeze({
  subject: 'Subject',
  description: 'Description',
  priority: 'Priority',
  ticketType: 'Type',
  impact: 'Impact',
  urgency: 'Urgency',
  source: 'Source',
  category: 'Category',
  subCategory: 'Subcategory',
  ticketCategory: 'Ticket category',
  internalCategoryId: 'Category',
  internalSubcategoryId: 'Subcategory',
  tpSkill: 'Category',
  tpSubskill: 'Subcategory',
  group: 'Group',
  groupId: 'Group',
  internalGroup: 'Internal group',
  internalGroupId: 'Internal group',
  requester: 'Requester',
  requesterId: 'Requester',
  ccEmails: 'Also for (cc)',
  dueBy: 'Due by',
  frDueBy: 'First response due',
  status: 'Status',
  assignee: 'Assignee',
  assignedTechId: 'Assignee',
  externalRef: 'External reference',
});

/** Built-in changedFields keys offered by the condition builder (custom fields append `customFields.<key>`). */
export const BUILTIN_CHANGE_FIELDS = Object.freeze([
  'subject', 'description', 'priority', 'ticketType', 'impact', 'urgency', 'source',
  'category', 'subCategory', 'ticketCategory', 'internalCategoryId', 'internalSubcategoryId',
  'groupId', 'internalGroupId', 'requester', 'ccEmails', 'dueBy', 'frDueBy',
]);

/** Event-facing actor kinds (condition enum). The audit-row vocabulary is wider. */
export const EVENT_ACTOR_KINDS = Object.freeze(['human', 'api', 'system', 'workflow', 'freshservice']);

const PRIORITY_NAMES = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
const LEVEL_NAMES = { 1: 'Low', 2: 'Medium', 3: 'High' };
const ID_FIELDS = new Set(['internalCategoryId', 'internalSubcategoryId', 'groupId', 'internalGroupId', 'assignedTechId', 'requesterId']);

export function labelFor(field) {
  const key = String(field || '');
  if (key.startsWith('customFields.')) return `Custom field: ${key.slice('customFields.'.length)}`;
  return FIELD_LABELS[key] || key;
}

/** Human cell text for a raw value. */
export function cell(field, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'priority' && PRIORITY_NAMES[v]) return `${PRIORITY_NAMES[v]} (${v})`;
  if ((field === 'impact' || field === 'urgency') && LEVEL_NAMES[v]) return `${LEVEL_NAMES[v]} (${v})`;
  if (field === 'description') return v === true || (typeof v === 'object' && v?.changed) ? 'changed' : String(v);
  if (Array.isArray(v)) return v.length ? v.map((x) => String(x)).join(', ') : '—';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '—' : v.toISOString();
  if (typeof v === 'object') {
    // Requester / tech objects from updateTicketFields ({ id, name, email }).
    if (v.name || v.email) return v.email && v.name ? `${v.name} (${v.email})` : String(v.name || v.email);
    return JSON.stringify(v);
  }
  return String(v);
}

/** Map the wide audit-row actor kinds onto the event enum. */
export function eventActorKind(kind) {
  const k = String(kind || '').trim();
  if (k === 'freshservice_sync' || k === 'freshservice') return 'freshservice';
  if (k === 'reconcile' || k === 'mirror' || k === 'ai') return 'system';
  return EVENT_ACTOR_KINDS.includes(k) ? k : 'system';
}

/** Default `event.source` label for an actor when the caller has no better one. */
export function defaultChangeSource(actor, kind, { workflowId = null } = {}) {
  if (kind === 'api') return `api:${actor?.name || actor?.email || 'key'}`;
  if (kind === 'workflow') return workflowId ? `workflow:${workflowId}` : 'workflow';
  if (kind === 'freshservice') return 'freshservice_sync';
  if (kind === 'human') return 'app';
  return 'system';
}

/**
 * Resolve id-typed values (category, group, tech) to names. Best-effort: any
 * lookup failure leaves the raw id in place. Returns { key: { from, to } }
 * label overrides keyed by field.
 */
async function resolveIdLabels(changes, workspaceId) {
  const labels = {};
  const need = Object.entries(changes || {}).filter(([field]) => ID_FIELDS.has(field));
  if (!need.length) return labels;
  const lookups = {
    internalCategoryId: (id) => prisma.competencyCategory.findUnique({ where: { id: Number(id) }, select: { name: true } }).then((r) => r?.name ?? null),
    internalSubcategoryId: (id) => prisma.competencyCategory.findUnique({ where: { id: Number(id) }, select: { name: true } }).then((r) => r?.name ?? null),
    internalGroupId: (id) => prisma.group.findUnique({ where: { id: Number(id) }, select: { name: true } }).then((r) => r?.name ?? null),
    groupId: (id) => prisma.group.findFirst({
      where: { freshserviceId: BigInt(String(id)), ...(workspaceId ? { workspaceId: Number(workspaceId) } : {}) },
      select: { name: true },
    }).then((r) => r?.name ?? null),
    assignedTechId: (id) => prisma.technician.findUnique({ where: { id: Number(id) }, select: { name: true } }).then((r) => r?.name ?? null),
    requesterId: (id) => prisma.requester.findUnique({ where: { id: Number(id) }, select: { name: true, email: true } })
      .then((r) => (r ? cell('requester', r) : null)),
  };
  for (const [field, change] of need) {
    const fn = lookups[field];
    if (!fn) continue;
    const resolve = async (v) => {
      if (v === null || v === undefined || v === '' || typeof v === 'object') return null;
      try { return await fn(v); } catch { return null; }
    };
    const [fromLabel, toLabel] = await Promise.all([resolve(change?.from), resolve(change?.to)]);
    if (fromLabel !== null || toLabel !== null) labels[field] = { from: fromLabel, to: toLabel };
  }
  return labels;
}

/**
 * Normalize a raw diff into the event shape. `resolveNames` (default true)
 * looks ids up in the DB; pass false for pure/offline rendering.
 */
export async function normalizeTicketChanges(rawChanges, { workspaceId = null, resolveNames = true } = {}) {
  const out = {};
  const raw = rawChanges && typeof rawChanges === 'object' ? rawChanges : {};
  const idLabels = resolveNames ? await resolveIdLabels(raw, workspaceId).catch(() => ({})) : {};
  for (const [field, change] of Object.entries(raw)) {
    if (!change || typeof change !== 'object') continue;
    if (field === 'description' || change.changed === true) {
      out[field] = { from: null, to: null, label: labelFor(field), fromLabel: '—', toLabel: 'changed', changed: true };
      continue;
    }
    const from = change.from === undefined ? null : change.from;
    const to = change.to === undefined ? null : change.to;
    const resolved = idLabels[field] || {};
    out[field] = {
      from,
      to,
      label: labelFor(field),
      fromLabel: resolved.from ?? cell(field, from),
      toLabel: resolved.to ?? cell(field, to),
    };
  }
  return out;
}

export function changesToList(changes) {
  return Object.entries(changes || {}).map(([field, c]) => ({
    field,
    label: c.label || labelFor(field),
    from: c.from ?? null,
    to: c.to ?? null,
    fromLabel: c.fromLabel ?? cell(field, c.from),
    toLabel: c.toLabel ?? cell(field, c.to),
  }));
}

export function renderChangesTableHtml(changes) {
  const rows = changesToList(changes).map((c) => (
    `<tr><td><strong>${escapeHtml(c.label)}</strong></td><td>${escapeHtml(c.fromLabel)}</td><td>${escapeHtml(c.toLabel)}</td></tr>`
  )).join('');
  if (!rows) return '<p>No field values changed.</p>';
  return `<table><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderChangesText(changes) {
  const lines = changesToList(changes).map((c) => `${c.label}: ${c.fromLabel} → ${c.toLabel}`);
  return lines.length ? lines.join('\n') : 'No field values changed.';
}

/**
 * Build the full `event.extra` for ticket.fields_updated. Never throws — a
 * rendering problem degrades to raw values, not a lost event.
 */
export async function buildFieldsUpdatedExtra({
  ticket,
  changes,
  actor = null,
  actorKind = null,
  actorName = null,
  actorEmail = null,
  source = null,
  auditRowId = null,
  reopened = false,
  workflowId = null,
  resolveNames = true,
} = {}) {
  const kind = eventActorKind(actorKind || actorKindOf(actor));
  let normalized = {};
  try {
    normalized = await normalizeTicketChanges(changes, { workspaceId: ticket?.workspaceId ?? null, resolveNames });
  } catch (err) {
    logger.warn(`ticketChangeRenderer: change normalization failed (raw values kept): ${err.message}`);
    normalized = await normalizeTicketChanges(changes, { resolveNames: false });
  }
  const changedFields = Object.keys(normalized);
  return {
    actorKind: kind,
    actorName: actorName || actor?.name || actor?.email || (kind === 'freshservice' ? 'FreshService' : 'Ticket Pulse'),
    actorEmail: actorEmail ?? (actor?.email && !String(actor.email).startsWith('apikey:') ? actor.email : null),
    source: source || defaultChangeSource(actor, kind, { workflowId }),
    changedFields,
    changedCount: changedFields.length,
    reopened: reopened === true,
    changes: normalized,
    changesList: changesToList(normalized),
    changesTableHtml: renderChangesTableHtml(normalized),
    changesText: renderChangesText(normalized),
    auditRowId: auditRowId ?? null,
    ...(workflowId ? { workflowId } : {}),
  };
}

/**
 * Merge a newer change set into a coalesced one (TU-9): `from` keeps the
 * EARLIEST value, `to` takes the LATEST; a field edited back to where it
 * started nets out and is dropped. Returns a fresh normalized map.
 */
export function mergeChangeSets(earlier, later) {
  const merged = { ...(earlier || {}) };
  for (const [field, change] of Object.entries(later || {})) {
    if (!change || typeof change !== 'object') continue;
    const prev = merged[field];
    if (!prev) { merged[field] = { ...change }; continue; }
    if (prev.changed || change.changed) { merged[field] = { ...prev, ...change, changed: true }; continue; }
    merged[field] = {
      ...change,
      from: prev.from,
      fromLabel: prev.fromLabel,
      to: change.to,
      toLabel: change.toLabel,
      label: change.label || prev.label,
    };
  }
  for (const [field, c] of Object.entries(merged)) {
    if (c.changed) continue;
    if (JSON.stringify(c.from ?? null) === JSON.stringify(c.to ?? null)) delete merged[field];
  }
  return merged;
}

/** Re-derive the list/table/text views after a merge. */
export function renderChangeViews(changes) {
  const changedFields = Object.keys(changes || {});
  return {
    changes,
    changedFields,
    changedCount: changedFields.length,
    changesList: changesToList(changes),
    changesTableHtml: renderChangesTableHtml(changes),
    changesText: renderChangesText(changes),
  };
}

// ------------------------------------------------------------------
// Resubmission diff note (moved from ticketResubmissionService)
// ------------------------------------------------------------------

function matchedByText(matchedBy) {
  if (matchedBy === 'external_ref') return 'matched by externalRef';
  if (matchedBy === 'custom_field_key') return 'matched by the workspace custom-field key';
  if (matchedBy === 'subject_heuristic') return 'matched by requester + subject (heuristic)';
  return 'matched';
}

export function renderDiffNoteHtml({ ctx, changedFields, diff, reopened }) {
  const head = `<p><strong>Resubmitted via API</strong> — key "${escapeHtml(ctx.apiKeyName || ctx.actor?.name || 'api')}", ${escapeHtml(matchedByText(ctx.matchedBy))}${reopened ? ' · <strong>reopened</strong>' : ''}.</p>`;
  const rows = Object.entries(diff).map(([field, { from, to }]) => (
    `<tr><td><strong>${escapeHtml(labelFor(field))}</strong></td><td>${escapeHtml(cell(field, from))}</td><td>${escapeHtml(cell(field, to))}</td></tr>`
  )).join('');
  const table = rows
    ? `<table><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p>No field values changed.</p>';
  const summary = `<p>Changed: ${escapeHtml(changedFields.join(', ') || 'nothing')}.</p>`;
  return `${head}${table}${summary}`;
}

export function renderDiffNoteText({ ctx, changedFields, diff, reopened }) {
  const lines = [`Resubmitted via API — key "${ctx.apiKeyName || ctx.actor?.name || 'api'}", ${matchedByText(ctx.matchedBy)}${reopened ? ' · reopened' : ''}.`];
  for (const [field, { from, to }] of Object.entries(diff)) {
    lines.push(`${labelFor(field)}: ${cell(field, from)} → ${cell(field, to)}`);
  }
  lines.push(`Changed: ${changedFields.join(', ') || 'nothing'}.`);
  return lines.join('\n');
}

export default {
  FIELD_LABELS,
  BUILTIN_CHANGE_FIELDS,
  EVENT_ACTOR_KINDS,
  labelFor,
  cell,
  eventActorKind,
  defaultChangeSource,
  normalizeTicketChanges,
  changesToList,
  renderChangesTableHtml,
  renderChangesText,
  buildFieldsUpdatedExtra,
  mergeChangeSets,
  renderChangeViews,
  renderDiffNoteHtml,
  renderDiffNoteText,
};
