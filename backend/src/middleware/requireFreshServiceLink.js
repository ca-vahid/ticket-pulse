import prisma from '../services/prisma.js';
import { isFreshServiceUnlinked, NOT_LINKED_MESSAGE } from '../utils/workspaceFsBinding.js';

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

export async function requireFreshServiceLink(req, res, next) {
  try {
    if (await isWorkspaceUnlinked(req.workspaceId)) return notLinkedResponse(res);
    return next();
  } catch (err) {
    return next(err);
  }
}

export default requireFreshServiceLink;
