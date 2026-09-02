import jsonLogic from 'json-logic-js';
import {
  buildDefaultWorkflowDefinition,
  validateWorkflowDefinition,
} from '../src/services/notificationWorkflowDefinition.js';
import { CONDITION_FIELDS, compileConditionGroup, validateConditionGroup } from '../src/services/notificationConditionModel.js';

/**
 * MEGA 09-01 Phase TU-3g / RO-6 — event provenance condition fields and the
 * VISIBLE "skip system notes" guard on the seeded "Internal note added"
 * workflow (a Power Apps resubmission diff note must not mail the assignee).
 */

describe('event provenance condition fields', () => {
  test('systemNote / senderIsAgent / isSurveyResponse are boolean fields on event.extra', () => {
    expect(CONDITION_FIELDS['event.systemNote']).toEqual(expect.objectContaining({ type: 'boolean', path: 'event.extra.systemNote' }));
    expect(CONDITION_FIELDS['event.senderIsAgent']).toEqual(expect.objectContaining({ type: 'boolean', path: 'event.extra.senderIsAgent' }));
    expect(CONDITION_FIELDS['event.isSurveyResponse']).toEqual(expect.objectContaining({ type: 'boolean', path: 'event.extra.isSurveyResponse' }));
  });

  test('"is false" passes when the flag is false OR absent, fails when true', () => {
    const group = { logic: 'all', conditions: [{ field: 'event.systemNote', operator: 'is_false' }] };
    expect(validateConditionGroup(group).errors ?? []).toEqual([]);
    const rule = compileConditionGroup(group);
    expect(jsonLogic.apply(rule, { event: { extra: { systemNote: false } } })).toBe(true);
    expect(jsonLogic.apply(rule, { event: { extra: {} } })).toBe(true);
    expect(jsonLogic.apply(rule, { event: {} })).toBe(true);
    expect(jsonLogic.apply(rule, { event: { extra: { systemNote: true } } })).toBe(false);
  });

  test('the seeded reopen guard (not an agent, not a survey) evaluates as expected', () => {
    const rule = compileConditionGroup({
      logic: 'all',
      conditions: [
        { field: 'event.senderIsAgent', operator: 'is_false' },
        { field: 'event.isSurveyResponse', operator: 'is_false' },
      ],
    });
    expect(jsonLogic.apply(rule, { event: { extra: { senderIsAgent: false, isSurveyResponse: false } } })).toBe(true);
    expect(jsonLogic.apply(rule, { event: { extra: { entryId: 1 } } })).toBe(true); // mailbox ingest shape
    expect(jsonLogic.apply(rule, { event: { extra: { senderIsAgent: true, isSurveyResponse: false } } })).toBe(false);
    expect(jsonLogic.apply(rule, { event: { extra: { senderIsAgent: false, isSurveyResponse: true } } })).toBe(false);
  });
});

describe('seeded "Internal note added" default carries a visible system-note guard', () => {
  test('condition node sits between the noise guard and the recipients, and the definition validates', () => {
    const definition = buildDefaultWorkflowDefinition('ticket.note_added');
    const guard = definition.nodes.find((n) => n.id === 'skip-system-notes');
    expect(guard).toEqual(expect.objectContaining({
      type: 'condition',
      data: expect.objectContaining({
        conditionGroup: { logic: 'all', conditions: [{ field: 'event.systemNote', operator: 'is_false' }] },
      }),
    }));
    expect(definition.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'skip-noise', sourceHandle: 'true', target: 'skip-system-notes' }),
      expect.objectContaining({ source: 'skip-system-notes', sourceHandle: 'true', target: 'recipients' }),
      expect.objectContaining({ source: 'skip-system-notes', sourceHandle: 'false', target: 'stop-skipped' }),
    ]));
    const result = validateWorkflowDefinition(definition, { triggerType: 'ticket.note_added' });
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });

  test('other default workflows are untouched', () => {
    for (const type of ['ticket.created', 'ticket.assigned', 'ticket.resolved_closed', 'ticket.public_reply_added']) {
      const definition = buildDefaultWorkflowDefinition(type);
      expect(definition.nodes.some((n) => n.id === 'skip-system-notes')).toBe(false);
      expect(validateWorkflowDefinition(definition, { triggerType: type }).errors).toEqual([]);
    }
  });
});
