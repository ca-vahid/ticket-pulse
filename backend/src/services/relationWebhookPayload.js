import { ticketDisplayRef } from '../utils/ticketOrigin.js';

/**
 * Payload shapes for the relation and task webhooks (Simorgh ask 3 + their
 * Phase-B requests of 19 Sep 2026: workspace id and the ticket's externalRef
 * on every task event, assignee and completion time on the task).
 *
 * The dispatcher wraps this as { type, event, timestamp, workspaceId, data }.
 */
export function ticketRef(t) {
  if (!t) return null;
  return {
    id: t.id,
    ref: t.displayRef || ticketDisplayRef(t),
    subject: t.subject ?? null,
    status: t.status ?? null,
    externalRef: t.externalRef ?? null,
    workspaceId: t.workspaceId ?? null,
  };
}

export function actorRef(actor) {
  if (!actor) return null;
  const email = actor.email || null;
  const kind = actor.role === 'api' || String(email || '').startsWith('apikey:') ? 'api'
    : actor.role === 'workflow' ? 'workflow'
      : actor.role === 'system' || actor.role === 'automation' ? 'system'
        : 'human';
  return { kind, name: actor.name || null, email: email && !email.startsWith('apikey:') ? email : null, technicianId: actor.technicianId ?? null };
}

export function taskRef(task) {
  if (!task) return null;
  const assignee = task.assignee || (task.assignedTech ? { id: task.assignedTech.id, name: task.assignedTech.name, email: task.assignedTech.email || null } : null);
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    externalRef: task.externalRef ?? null,
    assignee: assignee ? { id: assignee.id, name: assignee.name, email: assignee.email || null } : null,
    dueAt: task.dueAt ? new Date(task.dueAt).toISOString() : null,
    completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : null,
    createdAt: task.createdAt ? new Date(task.createdAt).toISOString() : null,
    updatedAt: task.updatedAt ? new Date(task.updatedAt).toISOString() : null,
  };
}

export function taskEventPayload(ticket, task, actor, extra = {}) {
  return { workspaceId: ticket?.workspaceId ?? null, ticket: ticketRef(ticket), task: taskRef(task), actor: actorRef(actor), ...extra };
}

export default { ticketRef, actorRef, taskRef, taskEventPayload };
