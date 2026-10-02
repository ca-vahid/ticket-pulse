import { describe, expect, test } from '@jest/globals';
import { priorityChangedExtra } from '../src/services/ticketLifecycleNotificationService.js';
import { NOTIFICATION_EVENT_TYPES } from '../src/services/notificationWorkflowDefinition.js';

/**
 * QA 10-01 #9 — "Add a trigger for Priority Changed in mail workflows."
 * ticket.priority_changed rides on the field-change event (the place that
 * already tells a real update from Ticket Pulse's own write-back echo):
 * agents in the app, the API and FreshService-side edits fire it; a
 * workflow's own write does not (no cascades).
 */

describe('ticket.priority_changed', () => {
  test('registered as an event type', () => {
    expect(NOTIFICATION_EVENT_TYPES).toContain('ticket.priority_changed');
  });

  test('raised: Medium -> Urgent carries from/to, labels, direction and who', () => {
    const extra = priorityChangedExtra({ actorKind: 'human', actorName: 'Adrian Lo', source: 'ticketpulse_native', changes: { priority: { from: 2, to: 4, label: 'Priority' } } });
    expect(extra).toEqual({ from: 2, to: 4, fromLabel: 'Medium', toLabel: 'Urgent', raised: true, direction: 'raised', actorKind: 'human', actorName: 'Adrian Lo', source: 'ticketpulse_native' });
  });

  test('lowered: High -> Low', () => {
    expect(priorityChangedExtra({ changes: { priority: { from: '3', to: '1' } } })).toMatchObject({ raised: false, direction: 'lowered', fromLabel: 'High', toLabel: 'Low' });
  });

  test('other fields only, no move, or junk values: nothing', () => {
    expect(priorityChangedExtra({ changes: { dueBy: { from: null, to: '2026-10-02' } } })).toBeNull();
    expect(priorityChangedExtra({ changes: { priority: { from: 2, to: 2 } } })).toBeNull();
    expect(priorityChangedExtra({ changes: { priority: { from: null, to: 3 } } })).toBeNull();
    expect(priorityChangedExtra(null)).toBeNull();
  });

  test('a workflow write keeps its workflowId so the dispatcher can skip it', () => {
    expect(priorityChangedExtra({ workflowId: 12, changes: { priority: { from: 1, to: 4 } } })).toMatchObject({ workflowId: 12 });
  });
});
