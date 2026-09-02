/**
 * Actor-kind attribution for ticket activity rows (MEGA 09-01 Phase RO-1/TU-1).
 *
 * Every `ticket_activities` row now carries `details.actorKind` so the History
 * tab can tell a human edit from sync echo, reconcile noise, mirror bookkeeping,
 * AI persistence, or a workflow write — and hide the machine rows by default.
 *
 *   human            — an admin / member / agent acting in Ticket Pulse
 *   api              — the public API (incl. Power Apps), actor.role === 'api'
 *                      or an `apikey:<prefix>` pseudo-email
 *   system           — Ticket Pulse itself (mail intake, duplicate guard, SYSTEM_ACTOR)
 *   workflow         — the notification/ticket workflow engine
 *   freshservice_sync — a change observed in FreshService by the sync (the FS
 *                      actor's name rides on `performedBy` when known)
 *   reconcile        — the periodic / on-open reconcile sweeps
 *   mirror           — TP-born fallback-mirror bookkeeping (mirror_conflict…)
 *   ai               — the assignment / triage pipeline
 *
 * Pure module (no imports) so sync, mirror, pipeline and ticket services can all
 * share it without import cycles.
 */

export const ACTOR_KINDS = Object.freeze([
  'human', 'api', 'system', 'workflow', 'freshservice_sync', 'reconcile', 'mirror', 'ai',
]);

/** Machine kinds — hidden by the History tab's default "Hide machine activity". */
export const MACHINE_ACTOR_KINDS = Object.freeze(['system', 'workflow', 'freshservice_sync', 'reconcile', 'mirror', 'ai']);

const SYSTEM_ACTOR_NAMES = new Set([
  'system',
  'ticket pulse',
  'ticket pulse mail',
  'ticket pulse duplicate guard',
]);
const WORKFLOW_ACTOR_NAMES = new Set(['notification workflow', 'ticket workflow']);
const FS_SOURCES = new Set(['assignment_fast_sync', 'freshservice_sync', 'freshservice_sync_snapshot', 'freshservice_activity', 'freshservice_webhook']);
const HUMAN_ROLES = new Set(['admin', 'member', 'agent', 'reviewer', 'coordinator', 'manager']);

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Kind of the actor performing a write NOW (write-time attribution). Used by
 * `ticketService._audit` for every audited action; machine writers that don't
 * go through `_audit` stamp their kind explicitly.
 */
export function actorKindOf(actor) {
  if (!actor || typeof actor !== 'object') return 'system';
  const role = lower(actor.role);
  const email = lower(actor.email);
  const name = lower(actor.name);
  if (actor.actorKind && ACTOR_KINDS.includes(actor.actorKind)) return actor.actorKind;
  if (role === 'api' || email.startsWith('apikey:')) return 'api';
  if (role === 'workflow' || WORKFLOW_ACTOR_NAMES.has(name)) return 'workflow';
  if (role === 'system' || email.endsWith('@ticketpulse.internal') || SYSTEM_ACTOR_NAMES.has(name)) return 'system';
  if (HUMAN_ROLES.has(role) || actor.technicianId || actor.userId || actor.id) return 'human';
  if (email || name) return 'human';
  return 'system';
}

/**
 * Kind of a STORED activity row (read-time attribution). Trusts an explicit
 * `details.actorKind`; otherwise applies the legacy heuristic so rows written
 * before this release still classify sensibly.
 */
export function deriveActorKind(row) {
  if (!row || typeof row !== 'object') return 'system';
  const details = row.details && typeof row.details === 'object' ? row.details : {};
  if (details.actorKind && ACTOR_KINDS.includes(details.actorKind)) return details.actorKind;

  const performedBy = lower(row.performedBy);
  const actorEmail = lower(details.actorEmail);
  const source = lower(details.source);
  const via = lower(details.via);

  if (actorEmail.startsWith('apikey:') || performedBy.startsWith('apikey:') || via === 'api_v1') return 'api';
  if (performedBy === 'mirror reconciliation' || row.activityType === 'mirror_conflict') return 'mirror';
  if (WORKFLOW_ACTOR_NAMES.has(performedBy) || row.activityType === 'workflow_updated_ticket') return 'workflow';
  if (FS_SOURCES.has(source) || via === 'freshservice' || performedBy.endsWith('(freshservice)')) return 'freshservice_sync';
  if (performedBy === 'freshservice') {
    return /reconcil/i.test(String(details.note || '')) ? 'reconcile' : 'freshservice_sync';
  }
  if (performedBy === 'system') {
    // Legacy sync-diff rows ("Status changed from X to Y") vs reconcile sweeps.
    if (/reconcil|no longer exists|trashed|marked as spam/i.test(String(details.note || ''))) return 'reconcile';
    if (row.activityType === 'status_changed' || row.activityType === 'assigned') return 'freshservice_sync';
    return 'system';
  }
  if (SYSTEM_ACTOR_NAMES.has(performedBy)) return 'system';
  // FS-sourced episode events written by _writeEventActivities carry the FS
  // actor's name with no email — they observed a FreshService action.
  if (details.actorFsId && !actorEmail && source !== 'ticketpulse_native') return 'freshservice_sync';
  return 'human';
}

export function isMachineActorKind(kind) {
  return MACHINE_ACTOR_KINDS.includes(kind);
}

export default { actorKindOf, deriveActorKind, isMachineActorKind, ACTOR_KINDS, MACHINE_ACTOR_KINDS };
