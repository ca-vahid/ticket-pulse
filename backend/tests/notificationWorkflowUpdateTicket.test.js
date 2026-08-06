import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_NODE_REGISTRY,
  DEFAULT_WORKFLOW_SPECS,
  buildDefaultWorkflowDefinition,
  validateWorkflowDefinition,
} from '../src/services/notificationWorkflowDefinition.js';

describe('Phase 5: generalized workflow events + update_ticket action', () => {
  test('new native-ticketing events are registered', () => {
    expect(NOTIFICATION_EVENT_TYPES).toEqual(expect.arrayContaining([
      'ticket.reply_received',
      'ticket.note_added',
      'ticket.status_changed',
    ]));
  });

  test('update_ticket is a registered non-terminal node type', () => {
    expect(NOTIFICATION_NODE_REGISTRY.update_ticket).toEqual(expect.objectContaining({
      terminal: false,
      inputHandles: ['default'],
      outputHandles: ['default'],
    }));
  });

  test('the seeded "reopen on requester reply" default spec exists', () => {
    expect(DEFAULT_WORKFLOW_SPECS).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'ticket_reply_received_reopen', triggerType: 'ticket.reply_received' }),
    ]));
  });

  test('the seeded reopen definition validates', () => {
    const definition = buildDefaultWorkflowDefinition('ticket.reply_received');
    const result = validateWorkflowDefinition(definition, { triggerType: 'ticket.reply_received' });
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);

    const updateNode = definition.nodes.find((n) => n.type === 'update_ticket');
    expect(updateNode.data.setStatus).toBe('Open');
    const condition = definition.nodes.find((n) => n.type === 'condition');
    expect(condition.data.rule).toEqual({ in: [{ var: 'ticket.status' }, ['Resolved', 'Closed']] });
  });

  test('action-only workflows (update_ticket, no send_email) are valid now', () => {
    const definition = {
      version: 1,
      metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.status_changed' } },
        { id: 'bump', type: 'update_ticket', data: { setPriority: 4 } },
        { id: 'end', type: 'stop', data: {} },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'bump' },
        { id: 'e2', source: 'bump', target: 'end' },
      ],
    };
    const result = validateWorkflowDefinition(definition, { triggerType: 'ticket.status_changed' });
    expect(result.errors).toEqual([]);
  });

  test('workflows still need at least one action node', () => {
    const definition = {
      version: 1,
      metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        { id: 'end', type: 'stop', data: {} },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'end' }],
    };
    const result = validateWorkflowDefinition(definition, { triggerType: 'ticket.created' });
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/action node/i);
  });

  test('legacy email workflows remain valid (regression)', () => {
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const result = validateWorkflowDefinition(definition, { triggerType: 'ticket.created' });
    expect(result.errors).toEqual([]);
  });
});

// FR 08-05 Phase 1b: update_ticket can set the category BY NAME (templates and
// API-intake mappings can't know workspace IDs) — save-time validation checks
// shape only; resolution happens against the workspace taxonomy at run time.
describe('update_ticket category by name (FR 08-05 Phase 1b)', () => {
  function categoryDefinition(updateData) {
    return {
      version: 2,
      metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        { id: 'route', type: 'update_ticket', data: updateData },
        { id: 'end', type: 'stop', data: {} },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'route' },
        { id: 'e2', source: 'route', target: 'end' },
      ],
    };
  }

  test('a category name (with optional child subcategory name) validates', () => {
    expect(validateWorkflowDefinition(
      categoryDefinition({ setCategoryName: 'Project Setup' }),
      { triggerType: 'ticket.created' },
    ).errors).toEqual([]);
    expect(validateWorkflowDefinition(
      categoryDefinition({ setCategoryName: 'Project Setup', setSubcategoryName: 'New Project' }),
      { triggerType: 'ticket.created' },
    ).errors).toEqual([]);
  });

  test('blank or over-long names are rejected at save time', () => {
    expect(validateWorkflowDefinition(
      categoryDefinition({ setCategoryName: '   ' }),
      { triggerType: 'ticket.created' },
    ).errors.join(' ')).toMatch(/category name/i);
    expect(validateWorkflowDefinition(
      categoryDefinition({ setCategoryName: 'x'.repeat(121) }),
      { triggerType: 'ticket.created' },
    ).errors.join(' ')).toMatch(/max 120/i);
  });

  test('a subcategory name without its parent category name is rejected', () => {
    expect(validateWorkflowDefinition(
      categoryDefinition({ setSubcategoryName: 'New Project' }),
      { triggerType: 'ticket.created' },
    ).errors.join(' ')).toMatch(/needs its parent category name/i);
  });
});
