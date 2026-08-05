import jsonLogic from 'json-logic-js';
import {
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  compileConditionGroup,
  validateConditionGroup,
} from '../src/services/notificationConditionModel.js';
import { TICKET_SOURCE, ticketSourceLabel } from '../src/utils/ticketOrigin.js';

// Mirror the engine's custom regex op so compile→evaluate parity holds here.
jsonLogic.add_operation('regex_match', (value, pattern) => {
  try { return new RegExp(String(pattern), 'i').test(String(value ?? '')); } catch { return false; }
});

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
