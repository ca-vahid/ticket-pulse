import { BarChart3, Clock, LayoutDashboard, Stamp, Ticket } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { AssignmentNavIcon, MapNavIcon, WorkflowNavIcon } from './NavIcons';

// Single source of truth for the primary navigation destinations, shared by the
// desktop header rail (AppHeader) and the mobile bottom tab bar (MobileTabBar).
// Each destination carries its route, glyph, accent classes (inactive tile +
// hover saturate + active underline hue), and an optional role `gate`.
//
//   gate: 'review'  -> visible to reviewers/admins
//   gate: 'manage'  -> visible to workspace admins (Dashboard, Timeline,
//                      Analytics, Assignment, Mail Workflows, Agent Maps)
//   gate: 'tickets' -> visible when the workspace has native ticketing enabled
//   gate: null      -> visible to everyone (Tickets, Approvals)
//
// ROLE MODEL (QA 08-24 #3, v3.7.02): viewers and reviewers get the ticket
// surface only — Tickets + Approvals. Viewers SEE AI suggestions but cannot
// act on them; reviewers approve/dismiss AI suggestions and manage approval
// categories (Approvals → Categories tab). Everything else — Dashboard,
// Technician detail, Timeline, Analytics, Agent Maps, Assignment Review, Mail
// Workflows, Settings — is workspace-admin (or global-admin) territory, the
// same as "No access" for everyone else. Agents (technician-only, no
// workspace_access row) were already on this footprint and are unchanged.
export const NAV_DESTINATIONS = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    path: '/dashboard',
    Icon: LayoutDashboard,
    tile: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-400/30 dark:bg-blue-500/15 dark:text-blue-200',
    hover: 'hover:border-blue-300 hover:bg-blue-100',
    bar: 'bg-blue-600',
    gate: 'manage',
  },
  {
    id: 'tickets',
    label: 'Tickets',
    path: '/tickets',
    Icon: Ticket,
    tile: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-400/30 dark:bg-sky-500/15 dark:text-sky-200',
    hover: 'hover:border-sky-300 hover:bg-sky-100',
    bar: 'bg-sky-600',
    // Visible in every workspace: even FS-only workspaces (native ticketing off)
    // sync FreshService tickets that are viewable/triageable here. Native
    // ticketing only controls in-app ticket *creation*, not this page's value.
    gate: null,
  },
  {
    id: 'timeline',
    label: 'Timeline',
    path: '/timeline',
    Icon: Clock,
    tile: 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-400/30 dark:bg-indigo-500/15 dark:text-indigo-200',
    hover: 'hover:border-indigo-300 hover:bg-indigo-100',
    bar: 'bg-indigo-600',
    gate: 'manage',
  },
  {
    id: 'analytics',
    label: 'Analytics',
    path: '/analytics',
    Icon: BarChart3,
    tile: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-200',
    hover: 'hover:border-emerald-300 hover:bg-emerald-100',
    bar: 'bg-emerald-600',
    gate: 'manage',
  },
  {
    id: 'assignments',
    label: 'Assignment',
    path: '/assignments',
    Icon: AssignmentNavIcon,
    tile: 'border-[#ddccf8] bg-[#f1ebfd] text-[#7c3aed] dark:border-[#8b5cf6]/35 dark:bg-[#8b5cf6]/15 dark:text-[#c4b5fd]',
    hover: 'hover:border-[#cdb3f6] hover:bg-[#e9ddfc]',
    bar: 'bg-[#7c3aed]',
    gate: 'manage',
  },
  {
    id: 'workflows',
    label: 'Mail Workflows',
    path: '/workflows',
    Icon: WorkflowNavIcon,
    tile: 'border-[#f6cbdd] bg-[#fceaf1] text-[#d6457f] dark:border-[#ec4899]/35 dark:bg-[#ec4899]/15 dark:text-[#f9a8d4]',
    hover: 'hover:border-[#f0b6cf] hover:bg-[#f9dbe8]',
    bar: 'bg-[#d6457f]',
    gate: 'manage',
  },
  {
    id: 'map',
    label: 'Agent Maps',
    path: '/visuals',
    Icon: MapNavIcon,
    tile: 'border-[#f8d5a8] bg-[#fdeede] text-[#e07b22] dark:border-[#f97316]/35 dark:bg-[#f97316]/15 dark:text-[#fdba74]',
    hover: 'hover:border-[#f4c486] hover:bg-[#fbe3c8]',
    bar: 'bg-[#e07b22]',
    gate: 'manage',
  },
  {
    id: 'approvals',
    label: 'Approvals',
    path: '/approvals',
    Icon: Stamp,
    tile: 'border-[#c9e2d4] bg-[#e9f6ef] text-[#0f7b52] dark:border-[#10b981]/35 dark:bg-[#10b981]/15 dark:text-[#6ee7b7]',
    hover: 'hover:border-[#aed6c1] hover:bg-[#ddf0e6]',
    bar: 'bg-[#0f7b52]',
    gate: null,
    badgeKey: 'approvals', // pending-count overlay (see AppHeader useApprovalCount)
  },
];

// Session-scoped marker written by AdminRoute when it bounces a non-admin off
// an admin page; AccessBounceToast reads it once so Tickets can say why.
export const ACCESS_BOUNCE_KEY = 'tp_accessBounce';

/**
 * Effective workspace role for the current user, or `null` while it cannot be
 * determined. Fails CLOSED (Phase RM2): before the workspace list has hydrated,
 * or when the selected workspace is not in the user's list, the answer is
 * `null` — never a fabricated 'viewer' — so admin-only chrome and routes stay
 * hidden until the role is actually known. Callers that need a member-tier
 * answer (canSeeAi etc.) treat any non-null role as membership; agents carry
 * role 'agent' from their technician-derived workspace entry.
 */
export function resolveWorkspaceRole(user, currentWorkspace, availableWorkspaces) {
  if (!user) return null;
  if (user.role === 'admin') return 'admin';
  if (!currentWorkspace?.id) return null;
  const ws = availableWorkspaces?.find((w) => w.id === currentWorkspace.id);
  if (!ws) return null;
  // Membership confirmed but no role label (older session payloads): lowest
  // member tier — never admin.
  return ws.role || 'viewer';
}

export function useWorkspaceRole() {
  const { user } = useAuth();
  const { currentWorkspace, availableWorkspaces } = useWorkspace();
  return resolveWorkspaceRole(user, currentWorkspace, availableWorkspaces);
}

/** Workspace admin (or global admin) — the only tier that sees beyond tickets. */
export function isWorkspaceAdmin(user, wsRole) {
  return Boolean(user) && (user.role === 'admin' || wsRole === 'admin');
}

/**
 * Single source of truth for whether a user gets Settings affordances at all.
 * Since v3.7.02 Settings is workspace-admin only: viewers/reviewers have zero
 * sections (approval categories moved to Approvals → Categories), and
 * global-'agent' users never had any. Every Settings entry point — SideRail,
 * MobileTabBar "More" sheet, AppHeader account menu, the command palette —
 * goes through `useCanAccessSettings()` (or this pure form).
 */
export function canAccessSettings(user, wsRole) {
  if (!user || user.role === 'agent') return false;
  return isWorkspaceAdmin(user, wsRole);
}

export function useCanAccessSettings() {
  const { user } = useAuth();
  const wsRole = useWorkspaceRole();
  return canAccessSettings(user, wsRole);
}

/**
 * Where a signed-in user lands: admins on the Dashboard, everyone else
 * (viewer / reviewer / agent — and an unresolved role) on Tickets. Used by
 * HomeRedirect, PublicRoute, AuthCallback, Login, WorkspacePicker and the
 * SideRail logo so "/dashboard" is no longer hardcoded as the home.
 */
export function homePathFor(user, wsRole) {
  return isWorkspaceAdmin(user, wsRole) ? '/dashboard' : '/tickets';
}

/**
 * Role-filtered destination list. No deep-link escape hatch (v3.7.02): a
 * gated destination is NEVER force-shown just because it is the active page —
 * AdminRoute bounces such visits, and the rail must not advertise a page the
 * role can't open. An unresolved role (`null`) yields only the ungated tiles.
 */
export function useNavDestinations() {
  const { user } = useAuth();
  const wsRole = useWorkspaceRole();
  const canReview = wsRole === 'admin' || wsRole === 'reviewer';
  const canManage = wsRole === 'admin';

  // Agent-role users only work tickets + approvals — everything else in the app
  // is coordinator/manager territory and would just bounce them. Agents can be
  // approval managers and request approvals, so the Approvals inbox is theirs too.
  if (user?.role === 'agent') {
    return NAV_DESTINATIONS.filter((dest) => dest.id === 'tickets' || dest.id === 'approvals');
  }

  return NAV_DESTINATIONS.filter((dest) => {
    if (dest.gate === 'review') return canReview;
    if (dest.gate === 'manage') return canManage;
    return true;
  });
}
