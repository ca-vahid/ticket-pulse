import { BarChart3, Clock, LayoutDashboard } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { AssignmentNavIcon, MapNavIcon, WorkflowNavIcon } from './NavIcons';

// Single source of truth for the primary navigation destinations, shared by the
// desktop header rail (AppHeader) and the mobile bottom tab bar (MobileTabBar).
// Each destination carries its route, glyph, accent classes (inactive tile +
// hover saturate + active underline hue), and an optional role `gate`.
//
//   gate: 'review'  -> visible to reviewers/admins (Assignment Review)
//   gate: 'manage'  -> visible to workspace admins (Mail Workflows)
//   gate: null      -> visible to everyone
export const NAV_DESTINATIONS = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    path: '/dashboard',
    Icon: LayoutDashboard,
    tile: 'border-blue-200 bg-blue-50 text-blue-700',
    hover: 'hover:border-blue-300 hover:bg-blue-100',
    bar: 'bg-blue-600',
    gate: null,
  },
  {
    id: 'timeline',
    label: 'Timeline',
    path: '/timeline',
    Icon: Clock,
    tile: 'border-indigo-200 bg-indigo-50 text-indigo-700',
    hover: 'hover:border-indigo-300 hover:bg-indigo-100',
    bar: 'bg-indigo-600',
    gate: null,
  },
  {
    id: 'analytics',
    label: 'Analytics',
    path: '/analytics',
    Icon: BarChart3,
    tile: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    hover: 'hover:border-emerald-300 hover:bg-emerald-100',
    bar: 'bg-emerald-600',
    gate: null,
  },
  {
    id: 'assignments',
    label: 'Assignment',
    path: '/assignments',
    Icon: AssignmentNavIcon,
    tile: 'border-[#ddccf8] bg-[#f1ebfd] text-[#7c3aed]',
    hover: 'hover:border-[#cdb3f6] hover:bg-[#e9ddfc]',
    bar: 'bg-[#7c3aed]',
    gate: 'review',
  },
  {
    id: 'workflows',
    label: 'Mail Workflows',
    path: '/workflows',
    Icon: WorkflowNavIcon,
    tile: 'border-[#f6cbdd] bg-[#fceaf1] text-[#d6457f]',
    hover: 'hover:border-[#f0b6cf] hover:bg-[#f9dbe8]',
    bar: 'bg-[#d6457f]',
    gate: 'manage',
  },
  {
    id: 'map',
    label: 'Agent Map',
    path: '/visuals',
    Icon: MapNavIcon,
    tile: 'border-[#f8d5a8] bg-[#fdeede] text-[#e07b22]',
    hover: 'hover:border-[#f4c486] hover:bg-[#fbe3c8]',
    bar: 'bg-[#e07b22]',
    gate: null,
  },
];

// Shared "current page" tile look — matches the supplied grey "clicked" artwork.
export const NAV_ACTIVE_TILE = 'border-[#d7dade] bg-[#eef0f2] text-[#9aa0aa]';

export function useWorkspaceRole() {
  const { user } = useAuth();
  const { currentWorkspace, availableWorkspaces } = useWorkspace();
  if (user?.role === 'admin') return 'admin';
  const ws = availableWorkspaces?.find((w) => w.id === currentWorkspace?.id);
  return ws?.role || 'viewer';
}

// Returns the role-filtered destination list. A gated destination is always
// included when it is the currently active page (so a directly-visited page
// still shows its own tile), mirroring the previous header behavior.
export function useNavDestinations(activeId = null) {
  const wsRole = useWorkspaceRole();
  const canReview = wsRole === 'admin' || wsRole === 'reviewer';
  const canManage = wsRole === 'admin';
  return NAV_DESTINATIONS.filter((dest) => {
    if (dest.id === activeId) return true;
    if (dest.gate === 'review') return canReview;
    if (dest.gate === 'manage') return canManage;
    return true;
  });
}
