import jsonLogic from 'json-logic-js';
import {
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  compileConditionGroup,
  validateConditionGroup,
} from '../src/services/notificationConditionModel.js';

// Mirror the engine's custom regex op so compile→evaluate parity holds here.
jsonLogic.add_operation('regex_match', (value, pattern) => {
  try { return new RegExp(String(pattern), 'i').test(String(value ?? '')); } catch { return false; }
});

const scope = {
  ticket: {
    status: 'Open',
    priorityLabel: 'Urgent',
    origin: 'freshservice',
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
