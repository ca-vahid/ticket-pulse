import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus, Trash2, X } from 'lucide-react';
import { notificationWorkflowAPI, ticketsAPI } from '../../services/api';
import { useTicketTypes } from '../../hooks/useTicketTypes';
import { useWorkspaceOptional } from '../../contexts/WorkspaceContext';

/**
 * AND/OR condition-group builder for workflow condition nodes. Edits the
 * structured `conditionGroup` the engine compiles to json-logic at run time —
 * so coordinators build compound rules like "(urgent AND unassigned) OR
 * Halifax" without hand-writing JSONLogic. 14 Oct 2026: "is any of" and
 * friends pick real values from a tick list (no typing), and there is no raw
 * rule behind the builder any more (ConditionStepEditor converts old rules).
 *
 * Field/operator catalog mirrors backend notificationConditionModel.js —
 * KEEP IN SYNC when adding fields there.
 */

export const CG_FIELDS = [
  { value: 'ticket.status', label: 'Ticket status', type: 'enum', options: ['Open', 'Pending', 'Resolved', 'Closed'] },
  // Derived base behind any status label — matches "any Open-base status"
  // without enumerating this workspace's custom labels.
  { value: 'ticket.statusBase', label: 'Ticket status base (Open/Pending/Resolved/Closed)', type: 'enum', options: ['Open', 'Pending', 'Resolved', 'Closed'] },
  { value: 'ticket.priorityLabel', label: 'Priority', type: 'enum', options: ['Low', 'Medium', 'High', 'Urgent'] },
  { value: 'ticket.origin', label: 'Ticket origin', type: 'enum', options: ['ticketpulse', 'freshservice'] },
  // How the ticket came to exist (Phase RL, RL-6) — lets a "Ticket arrived"
  // ack skip FreshService sync-ins and hold-queue resolutions.
  { value: 'ticket.createdVia', label: 'Created via', type: 'enum', options: ['app', 'email', 'api', 'freshservice_sync', 'held_reply', 'agent_cc', 'forward'] },
  { value: 'ticket.sourceLabel', label: 'Ticket source (arrival channel)', type: 'enum', options: ['Email', 'Portal', 'Phone', 'Chat', 'API', 'Webhook', 'Agent'] },
  // Per-workspace vocabulary (registry-driven) — string on the backend; the
  // builder swaps in the workspace's type names as enum options at runtime.
  { value: 'ticket.ticketType', label: 'Ticket type', type: 'string' },
  { value: 'ticket.subject', label: 'Subject', type: 'string' },
  { value: 'ticket.descriptionText', label: 'Description', type: 'string' },
  { value: 'ticket.internalCategory', label: 'Category', type: 'string' },
  { value: 'ticket.internalSubcategory', label: 'Subcategory', type: 'string' },
  { value: 'ticket.category', label: 'Category (FreshService)', type: 'string' },
  { value: 'ticket.tags', label: 'Tags', type: 'list' },
  { value: 'ticket.impact', label: 'Impact (1=Low 2=Medium 3=High)', type: 'number' },
  { value: 'ticket.urgency', label: 'Urgency (1=Low 2=Medium 3=High)', type: 'number' },
  { value: 'ticket.sentiment', label: 'Requester sentiment', type: 'enum', options: ['positive', 'neutral', 'frustrated'] },
  { value: 'ticket.isNoise', label: 'Is noise/spam', type: 'boolean' },
  { value: 'ticket.isParked', label: 'Is parked', type: 'boolean' },
  { value: 'ticket.parkKind', label: 'Park kind', type: 'enum', options: ['until_date', 'waiting_on', 'eta', 'auto_help'] },
  // Auto-help integration W3 (plans/AUTO_HELP_INTEGRATION_PLAN.md D).
  { value: 'ticket.resolvedByKind', label: 'Resolved by (kind)', type: 'enum', options: ['agent', 'workflow', 'api', 'automation', 'auto_help'] },
  { value: 'ticket.autoHelp.state', label: 'Auto-help state', type: 'enum', options: ['off', 'pending', 'skipped', 'no_match', 'not_answerable', 'drafted', 'staged', 'sent', 'dismissed', 'withdrawn', 'superseded', 'failed'] },
  { value: 'ticket.autoHelp.expected', label: 'Auto-help will answer by itself', type: 'boolean' },
  { value: 'ticket.autoHelp.mode', label: 'Auto-help mode', type: 'enum', options: ['shadow', 'approve', 'auto'] },
  { value: 'ticket.autoHelp.playbook', label: 'Auto-help playbook', type: 'string' },
  { value: 'ticket.autoHelp.outcome', label: 'Auto-help outcome', type: 'enum', options: ['resolved_silence', 'resolved_confirmed', 'help_requested', 'reopened', 'agent_took_over', 'no_reply_left_open', 'loop_stopped', 'withdrawn', 'superseded_by'] },
  { value: 'ticket.ageMinutes', label: 'Ticket age (minutes)', type: 'duration' },
  { value: 'ticket.dueInMinutes', label: 'Minutes until due (negative = overdue)', type: 'duration' },
  { value: 'ticket.frDueInMinutes', label: 'Minutes until first-response due', type: 'duration' },
  // QA 09-18 #5: reply clocks (read from the conversation when evaluated).
  { value: 'ticket.lastRequesterReplyMinutes', label: 'Minutes since the requester last wrote', type: 'duration' },
  { value: 'ticket.lastAgentReplyMinutes', label: 'Minutes since an agent last replied', type: 'duration' },
  { value: 'assignedAgent.email', label: 'Assigned agent email', type: 'string' },
  { value: 'assignedAgent.name', label: 'Assigned agent name', type: 'string' },
  { value: 'requester.email', label: 'Requester email', type: 'string' },
  { value: 'requester.department', label: 'Requester department', type: 'string' },
  { value: 'requester.officeLocation', label: 'Requester office', type: 'string' },
  { value: 'requester.city', label: 'Requester city', type: 'string' },
  { value: 'requester.onStraightTalkList', label: 'Requester is on the Straight-Talk List', type: 'boolean' },
  { value: 'event.statusFrom', label: 'Status changed from', type: 'string' },
  { value: 'event.statusTo', label: 'Status changed to', type: 'string' },
  // Event provenance flags (MEGA 09-01) — absent counts as false.
  { value: 'event.systemNote', label: 'Note was written by the system', type: 'boolean' },
  // "Ticket intake settled" (Auto-help integration W1) + the reopen guard (W3).
  { value: 'event.intakeProvisional', label: 'Intake verdict is provisional (night run)', type: 'boolean' },
  { value: 'event.intakeDecision', label: 'Intake decision', type: 'enum', options: ['pending_review', 'auto_assigned', 'classified_only', 'priority_only', 'noise_dismissed'] },
  { value: 'event.intakeNonActionable', label: 'Intake judged not actionable', type: 'boolean' },
  { value: 'event.intakeSource', label: 'Intake settled by', type: 'enum', options: ['pipeline', 'manual'] },
  { value: 'event.autoHelpReplyVerdict', label: 'Reply after an Auto-help close reads as', type: 'enum', options: ['confirmed', 'help', 'auto_reply'] },
  { value: 'event.replyVerdict', label: 'Reply to a closed ticket reads as', type: 'enum', options: ['thanks', 'auto_reply', 'reply'] },
  { value: 'event.senderIsAgent', label: 'Reply sender is an agent', type: 'boolean' },
  { value: 'event.isSurveyResponse', label: 'Reply is a survey response', type: 'boolean' },
  // "Ticket updated (fields)" payload (MEGA 09-01 Phase TU, TU-7). The server
  // catalog appends this workspace's custom-field keys to changedFields.
  { value: 'event.changedFields', label: 'Changed fields (fields_updated)', type: 'list', options: ['subject', 'description', 'priority', 'ticketType', 'impact', 'urgency', 'source', 'category', 'subCategory', 'ticketCategory', 'internalCategoryId', 'internalSubcategoryId', 'groupId', 'internalGroupId', 'requester', 'ccEmails', 'dueBy', 'frDueBy'] },
  { value: 'event.actorKind', label: 'Updated by (kind)', type: 'enum', options: ['human', 'api', 'system', 'workflow', 'freshservice'] },
  { value: 'event.source', label: 'Update source', type: 'string' },
  { value: 'event.changedCount', label: 'Changed field count', type: 'number' },
  { value: 'event.reopened', label: 'Reopened by this update', type: 'boolean' },
  { value: 'availability.isBusinessHours', label: 'During business hours', type: 'boolean' },
  { value: 'availability.isAfterHours', label: 'After hours', type: 'boolean' },
  { value: 'availability.isHoliday', label: 'On a holiday', type: 'boolean' },
  { value: 'workspace.name', label: 'Workspace', type: 'string' },
];

const OPERATORS_BY_TYPE = {
  string: [
    ['is', 'is'], ['is_not', 'is not'], ['contains', 'contains'], ['not_contains', "doesn't contain"],
    ['in', 'is any of'], ['not_in', 'is none of'], ['is_empty', 'is empty'], ['is_not_empty', 'is not empty'],
    ['matches_regex', 'matches regex'],
  ],
  enum: [
    ['is', 'is'], ['is_not', 'is not'], ['in', 'is any of'], ['not_in', 'is none of'],
    ['is_empty', 'is empty'], ['is_not_empty', 'is not empty'],
  ],
  boolean: [['is_true', 'is true'], ['is_false', 'is false']],
  duration: [['gt', 'more than'], ['lt', 'less than'], ['gte', 'at least'], ['lte', 'at most']],
  number: [['is', 'is'], ['is_not', 'is not'], ['gt', 'more than'], ['lt', 'less than'], ['gte', 'at least'], ['lte', 'at most']],
  // Date-typed custom fields (FR 08-05 Phase 1b).
  date: [['before', 'is before'], ['after', 'is after'], ['is_empty', 'is empty'], ['is_not_empty', 'is not empty']],
  list: [
    ['has_any', 'has any of'], ['has_all', 'has all of'], ['has_none', 'has none of'],
    ['is_empty', 'is empty'], ['is_not_empty', 'is not empty'],
  ],
};

const VALUELESS = new Set(['is_empty', 'is_not_empty', 'is_true', 'is_false']);
const LIST_OPERATORS = new Set(['in', 'not_in', 'has_any', 'has_all', 'has_none']);

// Custom-field definitions extend the catalog as TYPED `custom:<key>` fields
// (mirrors backend fieldSpec + CUSTOM_FIELD_CONDITION_TYPES): number/date/
// boolean defs get their operators + inputs; select defs become enums.
// Fetched once per session — the server condition-field catalog (which now
// also serves custom fields, per workspace) wins on overlap.
const CF_CONDITION_TYPES = { text: 'string', number: 'number', boolean: 'boolean', date: 'date', select: 'enum' };
const customFieldCache = new Map(); // workspaceId -> fields[] (QA 10-06 #7: per workspace)
// Server-resolved field catalog (Phase 8c): the backend serves the condition
// fields with dynamicOptions resolved per workspace — ticket.status lists the
// workspace's status registry (custom statuses included). Cached per
// workspace; CG_FIELDS stays the offline/first-paint fallback.
const serverFieldsCache = new Map(); // workspaceId -> fields[]

export const CONDITION_FIELDS_CHANGED = 'tp:condition-fields-changed';

/**
 * Status-registry / custom-field CRUD changes the options — drop the caches
 * and tell any builder on screen to fetch again (QA 10-06 #7: a custom field
 * added in Ticket Ops never reached an open workflow editor).
 */
export function invalidateConditionFieldsCache() {
  serverFieldsCache.clear();
  customFieldCache.clear();
  try { window.dispatchEvent(new CustomEvent(CONDITION_FIELDS_CHANGED)); } catch { /* no window (tests) */ }
}

export function useConditionFields() {
  const { activeTypes } = useTicketTypes();
  // Tolerant workspace read: the builder also renders in unit tests without a
  // WorkspaceProvider — no workspace just means no server catalog fetch.
  const workspaceId = useWorkspaceOptional()?.currentWorkspace?.id ?? null;
  const [serverFields, setServerFields] = useState(() => serverFieldsCache.get(workspaceId) || null);
  const [customFields, setCustomFields] = useState(() => customFieldCache.get(workspaceId) || []);
  // QA 10-06 #7: the lists were fetched once per browser session, so a custom
  // field added in Ticket Ops (often in another tab) never showed up here.
  // Paint from the cache, then fetch again: on open, when this tab regains
  // focus, and when a field or status is saved in this tab.
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    const bump = () => setRefreshTick((n) => n + 1);
    window.addEventListener(CONDITION_FIELDS_CHANGED, bump);
    window.addEventListener('focus', bump);
    return () => {
      window.removeEventListener(CONDITION_FIELDS_CHANGED, bump);
      window.removeEventListener('focus', bump);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    ticketsAPI.customFieldDefinitions()
      .then((res) => {
        const list = (res?.data || []).map((d) => ({
          value: `custom:${d.key}`,
          label: `Custom: ${d.label}`,
          type: CF_CONDITION_TYPES[d.type] || 'string',
          ...(d.type === 'select' && Array.isArray(d.options) && d.options.length > 0 ? { options: d.options } : {}),
        }));
        customFieldCache.set(workspaceId, list);
        if (!cancelled) setCustomFields(list);
      })
      .catch(() => { /* keep what is on screen */ });
    return () => { cancelled = true; };
  }, [workspaceId, refreshTick]);
  useEffect(() => {
    if (!workspaceId) { setServerFields(null); return undefined; }
    const hit = serverFieldsCache.get(workspaceId);
    if (hit) setServerFields(hit);
    let cancelled = false;
    notificationWorkflowAPI.conditionFields()
      .then((res) => {
        const list = (res?.data || []).filter((f) => f && f.value && f.type);
        if (list.length === 0) return;
        serverFieldsCache.set(workspaceId, list);
        if (!cancelled) setServerFields(list);
      })
      .catch(() => { /* silent — static CG_FIELDS fallback keeps the builder usable */ });
    return () => { cancelled = true; };
  }, [workspaceId, refreshTick]);

  // The server catalog now includes this workspace's custom fields (typed);
  // the session-cached defs fetch fills in when that catalog hasn't landed.
  const base = serverFields || CG_FIELDS;
  const known = new Set(base.map((f) => f.value));
  const fields = [...base, ...customFields.filter((f) => !known.has(f.value))];
  // The ticket-type field is a per-workspace enum once the registry loads —
  // the backend keeps it a string, so any stored value still evaluates.
  if (activeTypes.length) {
    return fields.map((f) => (f.value === 'ticket.ticketType'
      ? { ...f, type: 'enum', options: activeTypes.map((t) => t.name) }
      : f));
  }
  return fields;
}

const fieldSpecIn = (fields, value) => fields.find((f) => f.value === value)
  || (String(value || '').startsWith('custom:') ? { value, label: value, type: 'string' } : fields[0]);
const defaultOperator = (spec) => OPERATORS_BY_TYPE[spec.type][0][0];

export function emptyRow() {
  return { field: 'ticket.status', operator: 'is', value: 'Open' };
}

/** "Is noise/spam is not true" — the row that keeps a step's noise check. */
export function noiseRow() {
  return { field: 'ticket.isNoise', operator: 'is_false', value: null };
}

export function emptyGroup() {
  return { logic: 'all', conditions: [emptyRow()] };
}

const isGroup = (entry) => entry && typeof entry === 'object' && Array.isArray(entry.conditions);

function LogicToggle({ logic, onChange }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-indigo-200 dark:border-indigo-500/30 text-[11px] font-semibold" role="radiogroup" aria-label="Match mode">
      {[['all', 'ALL'], ['any', 'ANY']].map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={logic === value}
          onClick={() => onChange(value)}
          className={`px-2.5 py-1 transition-colors ${logic === value ? 'bg-indigo-600 text-white' : 'bg-card text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/15'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const asList = (value) => (Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]);

/**
 * "is any of" / "has any of" on a field with real values: a tick list in a
 * small popover. The picked values read as plain comma text (no pills). A
 * stored value this workspace no longer offers stays listed, ticked, so it
 * can be seen and unticked.
 */
export function ValueChecklist({ value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef(null);
  const picked = asList(value);
  const pickedKeys = new Set(picked.map(String));
  const optionKeys = new Set(options.map(String));
  const all = [...options, ...picked.filter((v) => !optionKeys.has(String(v)))];
  const needle = query.trim().toLowerCase();
  const shown = needle ? all.filter((opt) => String(opt).toLowerCase().includes(needle)) : all;
  const summary = picked.length ? picked.join(', ') : 'Pick values…';

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false); };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (opt) => {
    const key = String(opt);
    const nextKeys = new Set(pickedKeys);
    if (nextKeys.has(key)) nextKeys.delete(key); else nextKeys.add(key);
    // Keep the workspace's own order, not the click order.
    onChange(all.filter((o) => nextKeys.has(String(o))));
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Values: ${summary}`}
        onClick={() => setOpen((v) => !v)}
        className="tp-focus-ring flex w-full items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-left text-sm text-foreground"
      >
        <span className={`min-w-0 flex-1 truncate ${picked.length ? '' : 'text-muted-foreground'}`} title={picked.length ? summary : undefined}>{summary}</span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="group"
          aria-label="Pick values"
          className="animate-popIn absolute right-0 z-30 mt-1 w-64 max-w-[80vw] rounded-lg border border-border bg-card p-1.5 shadow-soft"
        >
          {all.length > 8 && (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find…"
              aria-label="Find a value"
              className="mb-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground"
            />
          )}
          <div className="settings-scrollbar max-h-56 overflow-y-auto">
            {shown.map((opt) => {
              const key = String(opt);
              return (
                <label key={key} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted">
                  <input
                    type="checkbox"
                    checked={pickedKeys.has(key)}
                    onChange={() => toggle(opt)}
                    className="h-3.5 w-3.5 flex-shrink-0 accent-[hsl(var(--primary))]"
                  />
                  <span className="min-w-0 flex-1 truncate">{key}</span>
                  {!optionKeys.has(key) && <span className="text-[11px] text-muted-foreground">not offered here now</span>}
                </label>
              );
            })}
            {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">Nothing matches.</p>}
          </div>
          <div className="mt-1 flex items-center justify-between border-t border-border px-1 pt-1.5">
            <span className="text-[11px] text-muted-foreground">{picked.length} picked</span>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-0.5 text-xs font-medium text-primary hover:bg-muted">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ValueInput({ row, onChange, fields }) {
  const spec = fieldSpecIn(fields, row.field);
  if (VALUELESS.has(row.operator)) return null;
  const options = Array.isArray(spec.options) ? spec.options : [];

  if (LIST_OPERATORS.has(row.operator)) {
    if (options.length > 0) {
      return <ValueChecklist value={row.value} options={options} onChange={onChange} />;
    }
    // No known values (subject, tags without a list…): type them.
    const listValue = Array.isArray(row.value) ? row.value.join(', ') : String(row.value ?? '');
    return (
      <input
        value={listValue}
        onChange={(e) => onChange(e.target.value.split(',').map((v) => v.trim()).filter(Boolean))}
        placeholder="value, value, …"
        aria-label="Values (comma-separated)"
        className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground"
      />
    );
  }
  if (spec.type === 'enum' && options.length > 0) {
    const current = String(row.value ?? options[0]);
    // A stored value this workspace no longer offers is still shown as itself.
    const choices = options.map(String).includes(current) ? options : [...options, current];
    return (
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Value"
        className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground"
      >
        {choices.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    );
  }
  if (spec.type === 'string' && options.length > 0 && (row.operator === 'is' || row.operator === 'is_not')) {
    // Free text with this workspace's real values offered as suggestions.
    const listId = `cg-values-${String(row.field).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    return (
      <>
        <input
          value={String(row.value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          list={listId}
          placeholder="value"
          aria-label="Value"
          className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground"
        />
        <datalist id={listId}>
          {options.map((opt) => <option key={opt} value={opt} />)}
        </datalist>
      </>
    );
  }
  if (spec.type === 'duration') {
    return (
      <input
        type="number"
        value={row.value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        placeholder="minutes (120 = 2h)"
        aria-label="Minutes"
        className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground tabular-nums"
      />
    );
  }
  if (spec.type === 'number') {
    return (
      <input
        type="number"
        value={row.value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        placeholder="number"
        aria-label="Number"
        className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground tabular-nums"
      />
    );
  }
  if (spec.type === 'date') {
    return (
      <input
        type="date"
        value={String(row.value ?? '').slice(0, 10)}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Date"
        className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground tabular-nums"
      />
    );
  }
  return (
    <input
      value={String(row.value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      placeholder={row.operator === 'matches_regex' ? 'pattern (case-insensitive)' : 'value'}
      aria-label="Value"
      className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground"
    />
  );
}

/** Change the operator, keeping the value in the shape the new operator takes. */
export function withOperator(row, operator, spec = {}) {
  if (VALUELESS.has(operator)) return { ...row, operator, value: undefined };
  if (LIST_OPERATORS.has(operator)) return { ...row, operator, value: asList(row.value) };
  if (Array.isArray(row.value)) {
    const first = row.value[0];
    return { ...row, operator, value: first !== undefined ? first : (spec.type === 'enum' ? spec.options?.[0] : '') };
  }
  return { ...row, operator };
}

function ConditionRow({ row, onChange, onRemove, fields }) {
  const spec = fieldSpecIn(fields, row.field);
  const operators = OPERATORS_BY_TYPE[spec.type];
  return (
    <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1fr)_auto] items-center gap-1.5">
      <select
        value={row.field}
        onChange={(e) => {
          const next = fieldSpecIn(fields, e.target.value);
          onChange({ field: next.value, operator: defaultOperator(next), value: next.type === 'enum' ? next.options?.[0] : '' });
        }}
        aria-label="Field"
        className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground"
      >
        {fields.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
      </select>
      <select
        value={row.operator}
        onChange={(e) => onChange(withOperator(row, e.target.value, spec))}
        aria-label="Operator"
        className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground"
      >
        {operators.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <div>{VALUELESS.has(row.operator) ? <span className="text-xs text-muted-foreground/75 pl-1">—</span> : <ValueInput row={row} onChange={(value) => onChange({ ...row, value })} fields={fields} />}</div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove condition"
        className="rounded-md p-1.5 text-muted-foreground/75 hover:bg-red-50 dark:hover:bg-red-500/15 hover:text-red-500"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function GroupEditor({ group, onChange, onRemove, nested = false, fields }) {
  const patch = (index, entry) => {
    const conditions = group.conditions.slice();
    conditions[index] = entry;
    onChange({ ...group, conditions });
  };
  const removeAt = (index) => {
    onChange({ ...group, conditions: group.conditions.filter((_, i) => i !== index) });
  };

  return (
    <div className={`rounded-lg border p-2.5 space-y-2 ${nested ? 'border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/40 dark:bg-indigo-500/10' : 'border-border bg-card'}`}>
      <div className="flex items-center gap-2">
        <LogicToggle logic={group.logic} onChange={(logic) => onChange({ ...group, logic })} />
        <span className="text-[11px] text-muted-foreground">{group.logic === 'all' ? 'every condition must match' : 'any condition may match'}</span>
        {nested && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove group"
            className="ml-auto rounded-md p-1 text-muted-foreground/75 hover:bg-red-50 dark:hover:bg-red-500/15 hover:text-red-500"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {group.conditions.map((entry, index) => (
          isGroup(entry) ? (
            <GroupEditor
              key={index}
              group={entry}
              nested
              fields={fields}
              onChange={(next) => patch(index, next)}
              onRemove={() => removeAt(index)}
            />
          ) : (
            <ConditionRow
              key={index}
              row={entry}
              fields={fields}
              onChange={(next) => patch(index, next)}
              onRemove={() => removeAt(index)}
            />
          )
        ))}
        {group.conditions.length === 0 && (
          <p className="text-xs italic text-muted-foreground/75 px-1">No conditions — matches every ticket.</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onChange({ ...group, conditions: [...group.conditions, emptyRow()] })}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/50"
        >
          <Plus className="h-3 w-3" /> Condition
        </button>
        {!nested && (
          <button
            type="button"
            onClick={() => onChange({ ...group, conditions: [...group.conditions, { logic: 'any', conditions: [emptyRow()] }] })}
            className="inline-flex items-center gap-1 rounded-md border border-indigo-200 dark:border-indigo-500/30 px-2 py-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/15"
          >
            <Plus className="h-3 w-3" /> Group
          </button>
        )}
      </div>
    </div>
  );
}

export default function ConditionGroupBuilder({ value, onChange, fields: fieldsProp = null }) {
  // QA 10-06 #2: the step's noise check is its own switch now
  // (conditionNoise.jsx) — this builder only edits conditions.
  const loadedFields = useConditionFields();
  const fields = fieldsProp || loadedFields;
  const group = isGroup(value) ? value : null;

  if (!group) {
    return (
      <button
        type="button"
        onClick={() => onChange(emptyGroup())}
        className="w-full rounded-lg border border-dashed border-indigo-300 dark:border-indigo-500/40 bg-indigo-50/50 dark:bg-indigo-500/10 px-3 py-2.5 text-left text-sm font-medium text-indigo-700 dark:text-indigo-200 hover:bg-indigo-50 dark:hover:bg-indigo-500/15"
      >
        + Add a condition
      </button>
    );
  }

  return <GroupEditor group={group} onChange={onChange} fields={fields} />;
}
