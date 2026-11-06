/**
 * Who is asking the Teams assistant (plans/TEAMS_BOT_COMMANDS_PLAN.md, P1).
 *
 * The bot has no session, so the same identity a sign-in builds is built
 * here once per message, from the e-mail Teams gave us:
 *  - super admin: the e-mail is on the admin_emails list (getAdminEmails, the
 *    list sign-in uses) -> role 'admin', every workspace;
 *  - otherwise resolveUserAccess(email, 'viewer'): workspace_access rows plus
 *    the workspaces where they are an active agent — exactly the picker the
 *    app shows them;
 *  - their active technician rows in those workspaces (for "my tickets").
 *
 * Tools get this context and nothing from the model: the model can never
 * name someone else to "look as". A manager who only approves (no access row,
 * no agent profile) gets an empty workspace list: the ticket tools see
 * nothing, while the approval and time-away tools still work because they
 * filter by the asker's own e-mail, like the e-mail links they already get.
 */
import prisma from './prisma.js';

const lc = (s) => String(s || '').trim().toLowerCase();

export async function buildAccessContext(email) {
  const key = lc(email);
  if (!key) return null;
  const auth = await import('../routes/auth.routes.js');
  const supers = await auth.getAdminEmails().catch(() => []);
  const superAdmin = (supers || []).map(lc).includes(key);
  // viewAs null: a bot message is never "View as".
  const resolved = await auth.resolveUserAccess(key, superAdmin ? 'admin' : 'viewer', null);
  const workspaces = (resolved?.availableWorkspaces || [])
    .filter((w) => Number(w?.id) > 0)
    .map((w) => ({
      id: Number(w.id),
      name: w.name || `Workspace ${w.id}`,
      slug: w.slug || null,
      role: w.role || null,
      // Same split as resolveTicketActor: admin | member (an access row) | agent (an agent profile only).
      kind: superAdmin || w.role === 'admin' ? 'admin' : (w.role === 'agent' ? 'agent' : 'member'),
    }));
  const visible = new Set(workspaces.map((w) => w.id));
  const techs = visible.size
    ? await prisma.technician.findMany({
      where: { isActive: true, email: { equals: key, mode: 'insensitive' }, workspaceId: { in: [...visible] } },
      select: { id: true, name: true, workspaceId: true, timezone: true },
      orderBy: { workspaceId: 'asc' },
      take: 20,
    }).catch(() => [])
    : [];
  return {
    email: key,
    name: techs[0]?.name || null,
    superAdmin,
    role: resolved?.role || (superAdmin ? 'admin' : 'viewer'),
    workspaces,
    techs,
    tz: techs[0]?.timezone || 'America/Vancouver',
    // The `user` the availability service expects (same shape as req.user).
    user: { email: key, role: resolved?.role || (superAdmin ? 'admin' : 'viewer'), name: techs[0]?.name || null },
  };
}

/** A workspace the person named ("in Accounting", "IT"), matched against their own list only. */
export function matchWorkspace(name, workspaces = []) {
  const want = lc(name).replace(/^(the|in|for)\s+/, '').replace(/\s+(workspace|team)$/, '');
  if (!want) return null;
  const simple = (s) => lc(s).replace(/[^a-z0-9]+/g, '');
  const w = simple(want);
  return workspaces.find((x) => simple(x.name) === w || simple(x.slug) === w)
    || workspaces.find((x) => simple(x.name).startsWith(w) || (w.length >= 3 && simple(x.name).includes(w)))
    || null;
}

export default { buildAccessContext, matchWorkspace };
