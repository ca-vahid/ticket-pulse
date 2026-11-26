import prisma from '../services/prisma.js';
import { fsGate, getModeRecord } from '../services/fsModeService.js';
import { isFreshServiceUnlinked, NOT_LINKED_MESSAGE, OFF_MESSAGE } from '../utils/workspaceFsBinding.js';

/**
 * Route gate for "pull from FreshService" actions (QA 11-24 #4 review): sync
 * week, backfills, ticket-type sync, assignment sync-now. A workspace made
 * with "New workspace" has no FreshService link (id 0), so its FS config has
 * no workspace filter — these actions would read every FreshService workspace
 * and the ticket upsert would move other workspaces' tickets into it. Its
 * creator is its admin, so requireAdmin alone does not stop them.
 *
 * 409 freshservice_not_linked for such a workspace. A real FS id always
 * passes (utils/workspaceFsBinding.js); no workspace id → passes (the
 * workspace middleware answers that).
 */
export async function isWorkspaceUnlinked(workspaceId) {
  if (!workspaceId) return false;
  const row = await prisma.workspace.findUnique({
    where: { id: Number(workspaceId) },
    select: { freshserviceWorkspaceId: true },
  });
  return isFreshServiceUnlinked(row);
}

export function notLinkedResponse(res) {
  return res.status(409).json({ success: false, code: 'freshservice_not_linked', message: NOT_LINKED_MESSAGE });
}

/** A linked workspace whose FreshService mode is 'off' (FreshService exit A1). */
export async function isWorkspaceFreshServiceOff(workspaceId) {
  if (!workspaceId) return false;
  return (await getModeRecord(workspaceId)).mode === 'off';
}

export function offResponse(res) {
  return res.status(409).json({ success: false, code: 'freshservice_off', message: OFF_MESSAGE });
}

/**
 * Route gate for a FreshService call that answers "not linked" itself (the
 * ticket-type check): refuses a workspace switched off (409 freshservice_off)
 * and, in Shadow, counts `purpose`. Unlinked workspaces pass to the route.
 */
export function requireFreshServiceOn(purpose = 'other') {
  return async function freshServiceOnGate(req, res, next) {
    try {
      if (!req.workspaceId) return next();
      const { mode } = await getModeRecord(req.workspaceId);
      if (mode === 'off') return offResponse(res);
      if (mode === 'shadow') await fsGate(req.workspaceId, purpose);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Also refuses a workspace switched off (25 Nov 2026): 409 freshservice_off.
 * The mode read is cached and falls back to 'connected' on a read error, so
 * a live workspace is never blocked by a hiccup.
 */
export async function requireFreshServiceLink(req, res, next) {
  try {
    if (await isWorkspaceUnlinked(req.workspaceId)) return notLinkedResponse(res);
    if (await isWorkspaceFreshServiceOff(req.workspaceId)) return offResponse(res);
    return next();
  } catch (err) {
    return next(err);
  }
}

export default requireFreshServiceLink;
