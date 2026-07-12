import { useEffect, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { useTicketTypes } from '../../hooks/useTicketTypes';

/**
 * AND/OR condition-group builder for workflow condition nodes. Edits the
 * structured `conditionGroup` the engine compiles to json-logic at run time —
 * so coordinators build compound rules like "(urgent AND unassigned) OR
 * Halifax" without hand-writing JSONLogic (the raw-rule textarea remains the
 * advanced escape hatch below this in the panel).
 *
 * Field/operator catalog mirrors backend notificationConditionModel.js —
 * KEEP IN SYNC when adding fields there.
 */

export const CG_FIELDS = [
  { value: 'ticket.status', label: 'Ticket status', type: 'enum', options: ['Open', 'Pending', 'Resolved', 'Closed'] },
  { value: 'ticket.priorityLabel', label: 'Priority', type: 'enum', options: ['Low', 'Medium', 'High', 'Urgent'] },
  { value: 'ticket.origin', label: 'Ticket origin', type: 'enum', options: ['ticketpulse', 'freshservice'] },
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
  { value: 'ticket.ageMinutes', label: 'Ticket age (minutes)', type: 'duration' },
  { value: 'ticket.dueInMinutes', label: 'Minutes until due (negative = overdue)', type: 'duration' },
  { value: 'ticket.frDueInMinutes', label: 'Minutes until first-response due', type: 'duration' },
  { value: 'assignedAgent.email', label: 'Assigned agent email', type: 'string' },
  { value: 'assignedAgent.name', label: 'Assigned agent name', type: 'string' },
  { value: 'requester.email', label: 'Requester email', type: 'string' },
  { value: 'requester.department', label: 'Requester department', type: 'string' },
  { value: 'requester.officeLocation', label: 'Requester office', type: 'string' },
  { value: 'requester.city', label: 'Requester city', type: 'string' },
  { value: 'event.statusFrom', label: 'Status changed from', type: 'string' },
  { value: 'event.statusTo', label: 'Status changed to', type: 'string' },
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
  list: [
    ['has_any', 'has any of'], ['has_all', 'has all of'], ['has_none', 'has none of'],
    ['is_empty', 'is empty'], ['is_not_empty', 'is not empty'],
  ],
};

const VALUELESS = new Set(['is_empty', 'is_not_empty', 'is_true', 'is_false']);
const LIST_OPERATORS = new Set(['in', 'not_in', 'has_any', 'has_all', 'has_none']);

// Custom-field definitions extend the catalog as `custom:<key>` string fields
// (mirrors the backend's dynamic fieldSpec). Fetched once per session.
let customFieldCache = null;
function useConditionFields() {
  const { activeTypes } = useTicketTypes();
  const [fields, setFields] = useState(customFieldCache
    ? [...CG_FIELDS, ...customFieldCache]
    : CG_FIELDS);
  useEffect(() => {
    if (customFieldCache) return;
    ticketsAPI.customFieldDefinitions()
      .then((res) => {
        customFieldCache = (res?.data || []).map((d) => ({
          value: `custom:${d.key}`, label: `Custom: ${d.label}`, type: 'string',
        }));
        if (customFieldCache.length) setFields([...CG_FIELDS, ...customFieldCache]);
      })
      .catch(() => { customFieldCache = []; });
  }, []);
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

export function emptyGroup() {
  return { logic: 'all', conditions: [emptyRow()] };
}

const isGroup = (entry) => entry && typeof entry === 'object' && Array.isArray(entry.conditions);

function LogicToggle({ logic, onChange }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-indigo-200 text-[11px] font-semibold" role="radiogroup" aria-label="Match mode">
      {[['all', 'ALL'], ['any', 'ANY']].map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={logic === value}
          onClick={() => onChange(value)}
          className={`px-2.5 py-1 transition-colors ${logic === value ? 'bg-indigo-600 text-white' : 'bg-white text-indigo-600 hover:bg-indigo-50'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ValueInput({ row, onChange, fields }) {
  const spec = fieldSpecIn(fields, row.field);
  if (VALUELESS.has(row.operator)) return null;

  if (LIST_OPERATORS.has(row.operator)) {
    const listValue = Array.isArray(row.value) ? row.value.join(', ') : String(row.value ?? '');
    return (
      <input
        value={listValue}
        onChange={(e) => onChange(e.target.value.split(',').map((v) => v.trim()).filter(Boolean))}
        placeholder="value, value, …"
        aria-label="Values (comma-separated)"
        className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-900"
      />
    );
  }
  if (spec.type === 'enum' && spec.options) {
    return (
      <select
        value={String(row.value ?? spec.options[0])}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Value"
        className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-900"
      >
        {spec.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
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
        className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-900 tabular-nums"
      />
    );
  }
  return (
    <input
      value={String(row.value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      placeholder={row.operator === 'matches_regex' ? 'pattern (case-insensitive)' : 'value'}
      aria-label="Value"
      className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-900"
    />
  );
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
        className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-900"
      >
        {fields.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
      </select>
      <select
        value={row.operator}
        onChange={(e) => onChange({ ...row, operator: e.target.value, ...(VALUELESS.has(e.target.value) ? { value: undefined } : {}) })}
        aria-label="Operator"
        className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-900"
      >
        {operators.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <div>{VALUELESS.has(row.operator) ? <span className="text-xs text-slate-400 pl-1">—</span> : <ValueInput row={row} onChange={(value) => onChange({ ...row, value })} fields={fields} />}</div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove condition"
        className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500"
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
    <div className={`rounded-lg border p-2.5 space-y-2 ${nested ? 'border-indigo-200 bg-indigo-50/40' : 'border-slate-200 bg-white'}`}>
      <div className="flex items-center gap-2">
        <LogicToggle logic={group.logic} onChange={(logic) => onChange({ ...group, logic })} />
        <span className="text-[11px] text-slate-500">{group.logic === 'all' ? 'every condition must match' : 'any condition may match'}</span>
        {nested && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove group"
            className="ml-auto rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-500"
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
          <p className="text-xs italic text-slate-400 px-1">No conditions — matches every ticket.</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onChange({ ...group, conditions: [...group.conditions, emptyRow()] })}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
        >
          <Plus className="h-3 w-3" /> Condition
        </button>
        {!nested && (
          <button
            type="button"
            onClick={() => onChange({ ...group, conditions: [...group.conditions, { logic: 'any', conditions: [emptyRow()] }] })}
            className="inline-flex items-center gap-1 rounded-md border border-indigo-200 px-2 py-1 text-[11px] font-medium text-indigo-600 hover:bg-indigo-50"
          >
            <Plus className="h-3 w-3" /> Group
          </button>
        )}
      </div>
    </div>
  );
}

export default function ConditionGroupBuilder({ value, onChange, onClear }) {
  const fields = useConditionFields();
  const group = isGroup(value) ? value : null;

  if (!group) {
    return (
      <button
        type="button"
        onClick={() => onChange(emptyGroup())}
        className="w-full rounded-lg border border-dashed border-indigo-300 bg-indigo-50/50 px-3 py-2.5 text-left text-sm font-medium text-indigo-700 hover:bg-indigo-50"
      >
        + Build conditions visually (AND/OR groups)
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <GroupEditor group={group} onChange={onChange} fields={fields} />
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-slate-400">Structured conditions override the raw JSONLogic rule below.</p>
        <button
          type="button"
          onClick={onClear}
          className="text-[11px] font-medium text-slate-500 hover:text-red-600"
        >
          Remove &amp; use raw rule
        </button>
      </div>
    </div>
  );
}
