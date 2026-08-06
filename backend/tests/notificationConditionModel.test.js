import jsonLogic from 'json-logic-js';
import {
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  CUSTOM_FIELD_CONDITION_TYPES,
  compileConditionGroup,
  groupReferencesCustomFields,
  registerCustomFieldConditionOps,
  validateConditionGroup,
} from '../src/services/notificationConditionModel.js';
import { TICKET_SOURCE, ticketSourceLabel } from '../src/utils/ticketOrigin.js';

// Mirror the engine's custom regex op so compile→evaluate parity holds here.
jsonLogic.add_operation('regex_match', (value, pattern) => {
  try { return new RegExp(String(pattern), 'i').test(String(value ?? '')); } catch { return false; }
});
// The typed custom-field coercion ops come from the model itself (single
// source of truth) — register them exactly like the engine does.
registerCustomFieldConditionOps(jsonLogic);

const scope = {
  ticket: {
    status: 'Open',
    priorityLabel: 'Urgent',
    origin: 'freshservice',
    source: 1,
    sourceLabel: 'Email',
    subject: 'VPN license renewal',
    isNoise: false,
    ageMinutes: 95,
    dueInMinutes: -30, // overdue
    internalCategory: { name: 'Software & Apps' },
  },
  requester: { email: 'rita@example.com', department: 'Engineering', officeLocation: 'Calgary' },
  assignedAgent: null,
  event: { type: 'ticket.status_changed', extra: { from: 'Open', to: 'Pending' } },
  availability: { isBusinessHours: true, isAfterHours: false, isHoliday: false },
  workspace: { name: 'IT' },
};

const evaluate = (group) => Boolean(jsonLogic.apply(compileConditionGroup(group), scope));

describe('condition compile → evaluate parity', () => {
  test('single row operators behave', () => {
    expect(evaluate({ logic: 'all', conditions: [{ field: 'ticket.status', operator: 'is', value: 'Open' }] })).toBe(true);
    expect(evaluate({ logic: 'all', conditions: [{ field: 'ticket.status', operator: 'is_not', value: 'Open' }] })).toBe(false);
    expect(evaluate({ logic: 'all', conditions: [{ field: 'ticket.subject', operator: 'contains', value: 'license' }] })).toBe(true);
    expect(evaluate({ logic: 'all', conditions: [{ field: 'ticket.subject', operator: 'not_contains', value: 'printer' }] })).toBe(true);
    expect(evaluate({ logic: 'all', conditions: [{ field: 'ticket.priorityLabel', operator: 'in', value: ['High', 'Urgent'] }] })).toBe(true);
    expect(evaluate({ logic: 'all', conditions: [{ field: 'ticket.priorityLabel', operator: 'not_in', value: ['Low'] }] })).toBe(true);
    expect(evaluate({ logic: 'all', conditions: [{ field: 'assignedAgent.email', operator: 'is_empty' }] })).toBe(true);
    expect(evaluate({ logic: 'all', conditions: [{ field: 'requester.email', operator: 'is_not_empty' }] })).toBe(true);
    expect(evaluate({ logic: 'all', conditions: [{ field: 'ticket.isNoise', operator: 'is_false' }] })).toBe(true);
    expect(evaluate({ logic: 'all', conditions: [{ field: 'availability.isBusinessHours', operator: 'is_true' }] })).toBe(true);
    expect(evaluate({ logic: 'all', conditions: [{ field: 'ticket.subject', operator: 'matches_regex', value: 'vpn|citrix' }] })).toBe(true);
  });

  test('arrival-channel labels: FS codes pass through, TP extension range maps, unknowns degrade', () => {
    expect(ticketSourceLabel(1)).toBe('Email');
    expect(ticketSourceLabel(TICKET_SOURCE.AGENT)).toBe('Agent');
    expect(ticketSourceLabel(TICKET_SOURCE.API)).toBe('API');
    expect(ticketSourceLabel(1001)).toBe('API (FreshService)'); // org-custom FS code, named (QA 07-14 #5)
    expect(ticketSourceLabel(9999)).toBe('Source 9999'); // truly unknown still degrades
    expect(ticketSourceLabel(null)).toBeNull();
    // TP extension values can never collide with FS's 1–10 space.
    expect(Object.values(TICKET_SOURCE).filter((v) => v >= 100)).toEqual(expect.arrayContaining([100, 101, 103]));
  });

  test('ticket source (arrival channel, QA 07-07 #1) conditions evaluate', () => {
    expect(CONDITION_FIELDS['ticket.sourceLabel']).toEqual(expect.objectContaining({
      type: 'enum', path: 'ticket.sourceLabel',
    }));
    expect(CONDITION_FIELDS['ticket.sourceLabel'].options).toEqual(
      expect.arrayContaining(['Email', 'Portal', 'Phone', 'API', 'Webhook', 'Agent']),
    );
    expect(evaluate({ logic: 'all', conditions: [{ field: 'ticket.sourceLabel', operator: 'is', value: 'Email' }] })).toBe(true);
    expect(evaluate({ logic: 'all', conditions: [{ field: 'ticket.sourceLabel', operator: 'in', value: ['Phone', 'Email'] }] })).toBe(true);
    expect(evaluate({ logic: 'all', conditions: [{ field: 'ticket.sourceLabel', operator: 'is', value: 'Agent' }] })).toBe(false);
  });

  test('relative-time fields: age and overdue', () => {
    // "older than an hour AND already overdue"
    expect(evaluate({
      logic: 'all',
      conditions: [
        { field: 'ticket.ageMinutes', operator: 'gt', value: 60 },
        { field: 'ticket.dueInMinutes', operator: 'lt', value: 0 },
      ],
    })).toBe(true);
    expect(evaluate({ logic: 'all', conditions: [{ field: 'ticket.ageMinutes', operator: 'lt', value: 60 }] })).toBe(false);
  });

  test('changed from / changed to via event.extra', () => {
    expect(evaluate({
      logic: 'all',
      conditions: [
        { field: 'event.statusFrom', operator: 'is', value: 'Open' },
        { field: 'event.statusTo', operator: 'is', value: 'Pending' },
      ],
    })).toBe(true);
  });

  test('nested (A AND B) OR (C) groups', () => {
    const group = {
      logic: 'any',
      conditions: [
        {
          logic: 'all',
          conditions: [
            { field: 'ticket.priorityLabel', operator: 'is', value: 'Urgent' },
            { field: 'assignedAgent.email', operator: 'is_empty' },
          ],
        },
        { field: 'requester.officeLocation', operator: 'is', value: 'Halifax' },
      ],
    };
    expect(evaluate(group)).toBe(true); // first sub-group matches

    const noMatch = {
      logic: 'any',
      conditions: [
        {
          logic: 'all',
          conditions: [
            { field: 'ticket.priorityLabel', operator: 'is', value: 'Low' },
            { field: 'assignedAgent.email', operator: 'is_empty' },
          ],
        },
        { field: 'requester.officeLocation', operator: 'is', value: 'Halifax' },
      ],
    };
    expect(evaluate(noMatch)).toBe(false);
  });

  test('empty group matches everything; single condition needs no wrapper', () => {
    expect(compileConditionGroup({ logic: 'all', conditions: [] })).toBe(true);
    const rule = compileConditionGroup({ logic: 'all', conditions: [{ field: 'ticket.status', operator: 'is', value: 'Open' }] });
    expect(rule).toEqual({ '==': [{ var: 'ticket.status' }, 'Open'] });
  });
});

describe('condition validation', () => {
  test('accepts a well-formed nested group', () => {
    expect(validateConditionGroup({
      logic: 'any',
      conditions: [
        { logic: 'all', conditions: [{ field: 'ticket.status', operator: 'is', value: 'Open' }] },
        { field: 'ticket.priorityLabel', operator: 'in', value: ['Urgent'] },
      ],
    })).toEqual([]);
  });

  test('rejects unknown fields, wrong operators, missing values, bad regex, over-nesting', () => {
    expect(validateConditionGroup({ logic: 'all', conditions: [{ field: 'nope', operator: 'is', value: 1 }] })
      .join(' ')).toMatch(/unknown field/i);
    expect(validateConditionGroup({ logic: 'all', conditions: [{ field: 'ticket.isNoise', operator: 'contains', value: 'x' }] })
      .join(' ')).toMatch(/not valid/i);
    expect(validateConditionGroup({ logic: 'all', conditions: [{ field: 'ticket.status', operator: 'is' }] })
      .join(' ')).toMatch(/needs a value/i);
    expect(validateConditionGroup({ logic: 'all', conditions: [{ field: 'ticket.subject', operator: 'matches_regex', value: '(' }] })
      .join(' ')).toMatch(/invalid regular expression/i);
    expect(validateConditionGroup({
      logic: 'all',
      conditions: [{
        logic: 'any',
        conditions: [{ logic: 'all', conditions: [{ field: 'ticket.status', operator: 'is', value: 'Open' }] }],
      }],
    }).join(' ')).toMatch(/nest/i);
  });

  test('every catalog field type has an operator set', () => {
    for (const [key, spec] of Object.entries(CONDITION_FIELDS)) {
      expect(CONDITION_OPERATORS[spec.type]).toBeDefined();
      expect(spec.path).toBeTruthy();
      expect(spec.label).toBeTruthy();
      expect(key).toBeTruthy();
    }
  });
});

// FR 08-05 Phase 1b: `custom:<key>` rows typed from the workspace's
// CustomFieldDefinition types — numeric/date/boolean comparisons coerce BOTH
// sides; unknown keys keep the legacy string semantics.
describe('typed custom-field conditions', () => {
  const customFieldTypes = {
    budget: 'number',
    kickoff_date: 'date',
    is_billable: 'boolean',
    client_name: 'text',
    tier: 'select',
  };
  const cfScope = {
    ticket: {
      customFields: {
        budget: '1500', // number stored as a string — coercion must handle it
        kickoff_date: '2026-08-01T00:00:00.000Z',
        is_billable: true,
        client_name: 'Coyote Landslide',
        tier: 'Gold',
        source_request_type: 'Project Setup', // no definition → string fallback
      },
    },
  };
  const evalTyped = (row, scope = cfScope) => Boolean(jsonLogic.apply(
    compileConditionGroup({ logic: 'all', conditions: [row] }, { customFieldTypes }),
    scope,
  ));

  test('number: comparisons coerce stored strings and condition strings alike', () => {
    expect(evalTyped({ field: 'custom:budget', operator: 'gt', value: 1000 })).toBe(true);
    expect(evalTyped({ field: 'custom:budget', operator: 'gt', value: '1000' })).toBe(true);
    expect(evalTyped({ field: 'custom:budget', operator: 'gt', value: 2000 })).toBe(false);
    expect(evalTyped({ field: 'custom:budget', operator: 'lte', value: 1500 })).toBe(true);
    expect(evalTyped({ field: 'custom:budget', operator: 'is', value: '1500' })).toBe(true);
    expect(evalTyped({ field: 'custom:budget', operator: 'is_not', value: 1500 })).toBe(false);
    // Missing / non-numeric values never match a numeric comparison.
    expect(evalTyped({ field: 'custom:budget', operator: 'gt', value: 0 }, { ticket: { customFields: {} } })).toBe(false);
    expect(evalTyped({ field: 'custom:budget', operator: 'is', value: 'abc' })).toBe(false);
  });

  test('date: before / after compare instants across ISO shapes', () => {
    expect(evalTyped({ field: 'custom:kickoff_date', operator: 'before', value: '2026-09-01' })).toBe(true);
    expect(evalTyped({ field: 'custom:kickoff_date', operator: 'after', value: '2026-07-01' })).toBe(true);
    expect(evalTyped({ field: 'custom:kickoff_date', operator: 'after', value: '2026-09-01' })).toBe(false);
    // Unparseable target or missing stored value → fails closed.
    expect(evalTyped({ field: 'custom:kickoff_date', operator: 'before', value: 'not a date' })).toBe(false);
    expect(evalTyped({ field: 'custom:kickoff_date', operator: 'before', value: '2026-09-01' }, { ticket: { customFields: {} } })).toBe(false);
  });

  test('boolean: is_true / is_false coerce like customFieldService (true / "true")', () => {
    expect(evalTyped({ field: 'custom:is_billable', operator: 'is_true' })).toBe(true);
    expect(evalTyped({ field: 'custom:is_billable', operator: 'is_false' })).toBe(false);
    const stringy = { ticket: { customFields: { is_billable: 'true' } } };
    expect(evalTyped({ field: 'custom:is_billable', operator: 'is_true' }, stringy)).toBe(true);
    expect(evalTyped({ field: 'custom:is_billable', operator: 'is_false' }, { ticket: { customFields: {} } })).toBe(true);
  });

  test('text and select definitions keep string/enum semantics', () => {
    expect(evalTyped({ field: 'custom:client_name', operator: 'contains', value: 'Coyote' })).toBe(true);
    expect(evalTyped({ field: 'custom:tier', operator: 'is', value: 'Gold' })).toBe(true);
    expect(evalTyped({ field: 'custom:tier', operator: 'in', value: ['Gold', 'Silver'] })).toBe(true);
  });

  test('unknown definitions (and calls without types) fall back to string', () => {
    expect(evalTyped({ field: 'custom:source_request_type', operator: 'is', value: 'Project Setup' })).toBe(true);
    // No types supplied at all — legacy behavior byte-for-byte.
    const rule = compileConditionGroup({ logic: 'all', conditions: [{ field: 'custom:budget', operator: 'is', value: '1500' }] });
    expect(rule).toEqual({ '==': [{ var: 'ticket.customFields.budget' }, '1500'] });
    expect(Boolean(jsonLogic.apply(rule, cfScope))).toBe(true);
  });

  test('validation: typed operator sets per definition type, string fallback otherwise', () => {
    const options = { customFieldTypes };
    expect(validateConditionGroup({ logic: 'all', conditions: [{ field: 'custom:budget', operator: 'gt', value: 100 }] }, options)).toEqual([]);
    expect(validateConditionGroup({ logic: 'all', conditions: [{ field: 'custom:kickoff_date', operator: 'before', value: '2026-09-01' }] }, options)).toEqual([]);
    expect(validateConditionGroup({ logic: 'all', conditions: [{ field: 'custom:is_billable', operator: 'is_true' }] }, options)).toEqual([]);
    // contains is a string operator — invalid on a number-typed field…
    expect(validateConditionGroup({ logic: 'all', conditions: [{ field: 'custom:budget', operator: 'contains', value: '15' }] }, options)
      .join(' ')).toMatch(/not valid/i);
    // …and gt is invalid on an untyped (string-fallback) custom field.
    expect(validateConditionGroup({ logic: 'all', conditions: [{ field: 'custom:budget', operator: 'gt', value: 100 }] })
      .join(' ')).toMatch(/not valid/i);
    // before/after still need a value.
    expect(validateConditionGroup({ logic: 'all', conditions: [{ field: 'custom:kickoff_date', operator: 'before' }] }, options)
      .join(' ')).toMatch(/needs a value/i);
  });

  test('groupReferencesCustomFields spots custom rows at any depth', () => {
    expect(groupReferencesCustomFields({ logic: 'all', conditions: [{ field: 'ticket.status', operator: 'is', value: 'Open' }] })).toBe(false);
    expect(groupReferencesCustomFields({
      logic: 'any',
      conditions: [{ logic: 'all', conditions: [{ field: 'custom:budget', operator: 'gt', value: 1 }] }],
    })).toBe(true);
    expect(groupReferencesCustomFields(null)).toBe(false);
  });

  test('every custom-field definition type maps to a condition type with operators', () => {
    for (const conditionType of Object.values(CUSTOM_FIELD_CONDITION_TYPES)) {
      expect(CONDITION_OPERATORS[conditionType]).toBeDefined();
    }
  });
});

describe('ticket.statusBase (Phase 8c custom statuses)', () => {
  test('catalog: enum field over the 4 canonical bases; ticket.status keeps its dynamicOptions hook', () => {
    expect(CONDITION_FIELDS['ticket.statusBase']).toEqual(expect.objectContaining({
      type: 'enum',
      path: 'ticket.statusBase',
      options: ['Open', 'Pending', 'Resolved', 'Closed'],
    }));
    expect(CONDITION_FIELDS['ticket.status'].dynamicOptions).toBe('ticket-statuses');
  });

  test('custom status names evaluate as exact strings; statusBase matches "any Pending-base"', () => {
    const customScope = {
      ...scope,
      ticket: { ...scope.ticket, status: 'Needs Rework', statusBase: 'Pending' },
      event: { type: 'ticket.status_changed', extra: { from: 'Open', to: 'Needs Rework', fromBase: 'Open', toBase: 'Pending' } },
    };
    const evalIn = (group) => Boolean(jsonLogic.apply(compileConditionGroup(group), customScope));
    // Exact custom-name match (case-sensitive exact string, base-independent).
    expect(evalIn({ logic: 'all', conditions: [{ field: 'ticket.status', operator: 'is', value: 'Needs Rework' }] })).toBe(true);
    expect(evalIn({ logic: 'all', conditions: [{ field: 'ticket.status', operator: 'is', value: 'Pending' }] })).toBe(false);
    // Base-level match sweeps every Pending-base label without enumerating.
    expect(evalIn({ logic: 'all', conditions: [{ field: 'ticket.statusBase', operator: 'is', value: 'Pending' }] })).toBe(true);
    expect(evalIn({ logic: 'all', conditions: [{ field: 'ticket.statusBase', operator: 'in', value: ['Open', 'Pending'] }] })).toBe(true);
    expect(evalIn({ logic: 'all', conditions: [{ field: 'ticket.statusBase', operator: 'is', value: 'Resolved' }] })).toBe(false);
    // Transition conditions can read the entered status by name.
    expect(evalIn({ logic: 'all', conditions: [{ field: 'event.statusTo', operator: 'is', value: 'Needs Rework' }] })).toBe(true);
  });

  test('statusBase group validates cleanly in the builder', () => {
    expect(validateConditionGroup({
      logic: 'all',
      conditions: [{ field: 'ticket.statusBase', operator: 'is', value: 'Open' }],
    })).toEqual([]);
  });
});
