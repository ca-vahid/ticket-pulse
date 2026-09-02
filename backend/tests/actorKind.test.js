import { actorKindOf, deriveActorKind, isMachineActorKind } from '../src/utils/actorKind.js';

/** MEGA 09-01 TU-1 — write-time + read-time actor-kind attribution. */

describe('actorKindOf (write-time)', () => {
  test('API keys and the public API role → api', () => {
    expect(actorKindOf({ email: 'apikey:tp_live_abc', name: 'Coreshack intake', role: 'api' })).toBe('api');
    expect(actorKindOf({ email: 'apikey:tp_live_abc', name: 'Coreshack intake' })).toBe('api');
  });

  test('system actors → system; workflow actor → workflow', () => {
    expect(actorKindOf({ email: 'mailbox@ticketpulse.internal', name: 'Ticket Pulse Mail', role: 'system' })).toBe('system');
    expect(actorKindOf({ name: 'Ticket Pulse duplicate guard' })).toBe('system');
    expect(actorKindOf(null)).toBe('system');
    expect(actorKindOf({ name: 'Notification workflow', email: null })).toBe('workflow');
    expect(actorKindOf({ name: 'Notification workflow', email: null, role: 'workflow' })).toBe('workflow');
  });

  test('admins / members / agents / technicians → human', () => {
    expect(actorKindOf({ email: 'ada@example.com', name: 'Ada', role: 'admin' })).toBe('human');
    expect(actorKindOf({ email: 'a@example.com', name: 'Agent', role: 'agent', technicianId: 7 })).toBe('human');
    expect(actorKindOf({ email: 'm@example.com', name: 'Member', kind: 'member' })).toBe('human');
  });

  test('an explicit actorKind on the actor wins', () => {
    expect(actorKindOf({ name: 'Ada', email: 'ada@example.com', actorKind: 'ai' })).toBe('ai');
  });
});

describe('deriveActorKind (read-time, legacy rows)', () => {
  test('explicit details.actorKind is trusted', () => {
    expect(deriveActorKind({ performedBy: 'System', details: { actorKind: 'reconcile' } })).toBe('reconcile');
  });

  test('legacy "System" status/assignment rows were sync echo; other "System" rows are system', () => {
    expect(deriveActorKind({ activityType: 'status_changed', performedBy: 'System', details: { oldStatus: 'Open', newStatus: 'Closed', note: 'Status changed from Open to Closed' } })).toBe('freshservice_sync');
    expect(deriveActorKind({ activityType: 'status_changed', performedBy: 'System', details: { newStatus: 'Spam', note: 'Ticket was marked as spam in FreshService (spam=true)' } })).toBe('reconcile');
    expect(deriveActorKind({ activityType: 'noise_flagged', performedBy: 'System', details: {} })).toBe('system');
  });

  test('named machine writers', () => {
    expect(deriveActorKind({ activityType: 'mirror_conflict', performedBy: 'Mirror reconciliation', details: { drift: [] } })).toBe('mirror');
    expect(deriveActorKind({ activityType: 'workflow_updated_ticket', performedBy: 'Notification workflow', details: {} })).toBe('workflow');
    expect(deriveActorKind({ activityType: 'fields_updated', performedBy: 'Ticket Pulse', details: { source: 'ticketpulse_native', actorEmail: null } })).toBe('system');
    expect(deriveActorKind({ activityType: 'created', performedBy: 'Ticket Pulse Mail', details: {} })).toBe('system');
    expect(deriveActorKind({ activityType: 'status_changed', performedBy: 'FreshService', details: { note: 'Status reconciled from FreshService on open: Open → Closed' } })).toBe('reconcile');
    expect(deriveActorKind({ activityType: 'status_changed', performedBy: 'Dominic Bautista (FreshService)', details: {} })).toBe('freshservice_sync');
  });

  test('apikey pseudo-emails → api; sync sources → freshservice_sync; real people → human', () => {
    expect(deriveActorKind({ activityType: 'fields_updated', performedBy: 'Coreshack intake', details: { actorEmail: 'apikey:tp_live_x', source: 'ticketpulse_native' } })).toBe('api');
    expect(deriveActorKind({ activityType: 'assigned', performedBy: 'System', details: { source: 'assignment_fast_sync' } })).toBe('freshservice_sync');
    expect(deriveActorKind({ activityType: 'coordinator_assigned', performedBy: 'Vahid H', details: { actorFsId: 100 } })).toBe('freshservice_sync');
    expect(deriveActorKind({ activityType: 'fields_updated', performedBy: 'Ada Admin', details: { source: 'ticketpulse_native', actorEmail: 'ada@example.com' } })).toBe('human');
  });

  test('machine kinds', () => {
    expect(isMachineActorKind('human')).toBe(false);
    expect(isMachineActorKind('api')).toBe(false);
    for (const k of ['system', 'workflow', 'freshservice_sync', 'reconcile', 'mirror', 'ai']) expect(isMachineActorKind(k)).toBe(true);
  });
});
