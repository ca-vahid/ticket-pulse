import prisma from './prisma.js';
import workspaceRepository from './workspaceRepository.js';
import logger from '../utils/logger.js';
import { workspaceLinkName } from '../utils/ticketLink.js';

/**
 * Short ticket links (14 Oct 2026): ticketpulse.bgcsaas.com/it/1876, /it/TP-1876,
 * /TP-1876 or /246762 open the ticket. TP numbers come from one sequence shared by
 * every workspace, so the workspace part only narrows the search; FreshService
 * numbers are unique in the FreshService account. A bare number can be either
 * kind: every match the user may open is returned and the page lets them choose.
 */

const REF_RE = /^(?:(tp)[-\s]?|#)?(\d{1,12})$/i;

/** "TP-1876" | "tp1876" | "1876" | "#246762" -> { tp: bool, n } ; anything else -> null. */
export function parseTicketRef(raw) {
  const text = String(raw ?? '').trim();
  const m = text.match(REF_RE);
  if (!m) return null;
  const n = Number(m[2]);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return { tp: Boolean(m[1]), n };
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * The workspace a link names: its link name ("acct"), slug ("accounting-team") or name
 * ("Accounting Team"), any case. Old long links keep working after a link name is set.
 */
export function findWorkspace(workspaces, key) {
  const k = norm(key);
  if (!k) return null;
  return workspaces.find((w) => norm(workspaceLinkName(w.id)) === k)
    || workspaces.find((w) => norm(w.slug) === k)
    || workspaces.find((w) => norm(w.name) === k)
    || workspaces.find((w) => norm(w.name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') === k)
    || null;
}

async function workspacesFor(user) {
  if (user?.role === 'admin') return workspaceRepository.getAll();
  if (!user?.email) return [];
  return workspaceRepository.getMergedWorkspaces(user.email);
}

/**
 * Resolve a short link for this user. Tickets in workspaces the user cannot open
 * are never returned (a link must not reveal that a ticket exists elsewhere).
 * Returns { status: 'ok', matches: [...] } | { status: 'bad_ref' } | { status: 'unknown_workspace' }.
 */
export async function resolveTicketShortLink({ ref, workspace = null, user }) {
  const parsed = parseTicketRef(ref);
  if (!parsed) return { status: 'bad_ref' };

  const allowed = (await workspacesFor(user)) || [];
  let scope = allowed;
  if (workspace) {
    const ws = findWorkspace(allowed, workspace);
    if (!ws) return { status: 'unknown_workspace' };
    scope = [ws];
  }
  const ids = scope.map((w) => w.id);
  if (ids.length === 0) return { status: 'ok', matches: [] };

  const or = [{ nativeNumber: parsed.n }];
  if (!parsed.tp) or.push({ freshserviceTicketId: BigInt(parsed.n) });
  const rows = await Promise.resolve()
    .then(() => prisma.ticket.findMany({
      where: { workspaceId: { in: ids }, OR: or },
      select: { id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true, status: true },
      take: 10,
    }))
    .catch((err) => {
      logger.warn(`Short link lookup failed for "${String(ref).slice(0, 30)}": ${err.message}`);
      throw err;
    });

  const byId = new Map(allowed.map((w) => [w.id, w]));
  const matches = rows.map((t) => {
    const ws = byId.get(t.workspaceId) || {};
    const isTp = t.origin === 'ticketpulse' && t.nativeNumber !== null && t.nativeNumber !== undefined;
    return {
      ticketId: t.id,
      workspaceId: t.workspaceId,
      workspaceName: ws.name || null,
      workspaceSlug: workspaceLinkName(t.workspaceId) || ws.slug || null,
      ref: isTp ? `TP-${t.nativeNumber}` : `#${t.freshserviceTicketId ?? t.id}`,
      // How the link matched: a TP number, or a FreshService number.
      matchedAs: t.nativeNumber === parsed.n ? 'tp' : 'freshservice',
      subject: t.subject || '',
      status: t.status || null,
    };
  });
  // TP number first when a bare number matches both kinds.
  matches.sort((a, b) => (a.matchedAs === b.matchedAs ? 0 : a.matchedAs === 'tp' ? -1 : 1));
  return { status: 'ok', matches };
}

/** Top-level page names a workspace slug must never take, or its short links would be shadowed. */
export const RESERVED_WORKSPACE_SLUGS = Object.freeze([
  'login', 'auth', 'workspace', 'workspaces', 'dashboard', 'tickets', 'technician', 'timeline', 'analytics',
  'assignments', 'settings', 'visuals', 'knowledge', 'approval', 'approval-reply', 'approvals', 'availability',
  'onboarding', 'on-call', 'profile', 'mail-alerts', 'notifications', 'my-competencies', 'requesters',
  'workflows', 'feedback', 'summit', 'summit-taxonomy', 'ticket-status', 'ticket-escalation', 'ticket-urgency',
  'api', 'health', 'assets', 'brand', 'branding-mockups', 'demo-avatars', 'downloads', 'feedback-themes',
]);

export default { parseTicketRef, findWorkspace, resolveTicketShortLink, RESERVED_WORKSPACE_SLUGS };
