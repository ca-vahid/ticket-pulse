import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * "View as" (QA 10-08 #2): a super admin looks at Ticket Pulse the way a
 * workspace role, or a named person, sees it.
 *
 *   role    the admin keeps their own identity (their e-mail stays the actor
 *           of every write) but holds exactly ONE workspace with the chosen
 *           role. requireAuth runs the request inside this context and
 *           workspaceRepository.getAccessRole answers from it, so every gate,
 *           service and payload sees the reduced role.
 *   person  the session user IS the other person (their access, their
 *           workspaces, their agent profiles); requireAuth refuses every
 *           write, so nothing is ever done in their name.
 *
 * The marker lives on the session user AND in the JWT (`viewAs`), because a
 * cookie-blocked browser is identified by the token alone.
 */
const store = new AsyncLocalStorage();

/** Roles a super admin can try on. 'agent' = a technician with no access row. */
export const VIEW_AS_ROLES = Object.freeze(['readonly', 'viewer', 'reviewer', 'admin', 'agent']);
export const VIEW_AS_ROLE_LABELS = Object.freeze({
  readonly: 'Read-only', viewer: 'Standard', reviewer: 'Reviewer', admin: 'Workspace admin', agent: 'Agent (technician, no access row)',
});

export function runWithViewAs(viewAs, email, fn) {
  return store.run({ viewAs, email: String(email || '').toLowerCase() }, fn);
}

/** The marker of the request being handled, or null. */
export function currentViewAs() {
  return store.getStore()?.viewAs || null;
}

/**
 * The workspace role a role view imposes on (email, workspace):
 *   undefined  no override — read the database as usual
 *   null       no access row in this view
 *   string     the role being tried on
 */
export function viewAsRoleOverride(viewAs, viewerEmail, email, workspaceId) {
  if (!viewAs || viewAs.mode !== 'role') return undefined;
  if (String(email || '').toLowerCase() !== String(viewerEmail || '').toLowerCase()) return undefined;
  if (viewAs.role === 'agent') return null;
  return Number(workspaceId) === Number(viewAs.workspaceId) ? viewAs.role : null;
}

export function roleOverrideForRequest(email, workspaceId) {
  const ctx = store.getStore();
  if (!ctx?.viewAs) return undefined;
  return viewAsRoleOverride(ctx.viewAs, ctx.email, email, workspaceId);
}

/** Only the fields that travel in the session and the token. */
export function cleanViewAs(v) {
  if (!v || !['role', 'person'].includes(v.mode) || !v.by) return null;
  return {
    mode: v.mode,
    by: String(v.by).toLowerCase(),
    byName: v.byName ? String(v.byName).slice(0, 120) : null,
    label: String(v.label || '').slice(0, 160),
    ...(v.mode === 'role' ? { role: v.role, workspaceId: Number(v.workspaceId) } : {}),
    since: v.since || null,
  };
}
