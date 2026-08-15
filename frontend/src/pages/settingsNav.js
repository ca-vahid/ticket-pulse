import {
  Bell,
  BarChart3,
  Bot,
  Brain,
  Camera,
  CalendarDays,
  Clock,
  DatabaseBackup,
  Download,
  ExternalLink,
  EyeOff,
  Globe,
  Inbox,
  KeyRound,
  LayoutDashboard,
  MessageSquare,
  PenLine,
  Plug,
  RefreshCw,
  Shield,
  Siren,
  Stamp,
  Users,
  Users2,
  VolumeX,
  Wand2,
} from 'lucide-react';

/**
 * Settings navigation model (Phase A1): the section list, its role gates, and
 * the role-aware resolution logic — extracted from Settings.jsx so the role
 * flows are unit-testable without rendering the whole page.
 *
 * minRole: 'global' = global admin only, 'admin' = workspace admin+,
 * 'reviewer' = reviewer+, 'viewer' = anyone with workspace access.
 * Grouped by area, alphabetical within each group, so a long list stays
 * scannable (QA 07-20 #9). The `group` label renders as a section header.
 */
export const ALL_SETTINGS_NAV_ITEMS = [
  // Integrations
  { id: 'api-keys', label: 'API Keys', Icon: KeyRound, minRole: 'admin', group: 'Integrations' },
  { id: 'freshservice', label: 'FreshService', Icon: Plug, minRole: 'global', group: 'Integrations' },
  { id: 'ticket-mailboxes', label: 'Ticket Mailboxes', Icon: Inbox, minRole: 'admin', group: 'Integrations' },
  { id: 'webhooks', label: 'Webhooks', Icon: KeyRound, minRole: 'admin', group: 'Integrations' },
  // Tickets & AI
  { id: 'ai-routing', label: 'AI & Routing', Icon: Brain, minRole: 'admin', group: 'Tickets & AI' },
  { id: 'ai-providers', label: 'AI Providers', Icon: Bot, minRole: 'admin', group: 'Tickets & AI' },
  { id: 'approval-categories', label: 'Approval Categories', Icon: Stamp, minRole: 'reviewer', group: 'Tickets & AI' },
  { id: 'noise-rules', label: 'Noise Rules', Icon: VolumeX, minRole: 'admin', group: 'Tickets & AI' },
  { id: 'ticket-ops', label: 'Ticket Ops', Icon: Wand2, minRole: 'admin', group: 'Tickets & AI' },
  { id: 'urgent-escalation', label: 'Urgent Escalation', Icon: Siren, minRole: 'admin', group: 'Tickets & AI' },
  // Notifications & Public
  { id: 'feedback-page', label: 'Feedback', Icon: MessageSquare, minRole: 'admin', group: 'Notifications & Public' },
  // Workspace admins can reach this to see Email delivery health (QA 07-23 #3);
  // the global provider secrets inside are still gated to global admins below.
  { id: 'notification-providers', label: 'Notifications', Icon: Bell, minRole: 'admin', group: 'Notifications & Public' },
  { id: 'public-ticket-status', label: 'Public Status', Icon: ExternalLink, minRole: 'admin', group: 'Notifications & Public' },
  // Team & Scheduling
  { id: 'business-hours', label: 'Business Hours', Icon: Clock, minRole: 'admin', group: 'Team & Scheduling' },
  { id: 'groups', label: 'Groups', Icon: Users2, minRole: 'admin', group: 'Team & Scheduling' },
  { id: 'agents', label: 'Members', Icon: Users, minRole: 'admin', group: 'Team & Scheduling' },
  { id: 'photos', label: 'Photos & Locations', Icon: Camera, minRole: 'admin', group: 'Team & Scheduling' },
  { id: 'calendar-leave', label: 'Shared Calendar', Icon: CalendarDays, minRole: 'admin', group: 'Team & Scheduling' },
  { id: 'signatures', label: 'Signatures', Icon: PenLine, minRole: 'admin', group: 'Team & Scheduling' },
  { id: 'tech-schedules', label: 'Tech Schedules', Icon: CalendarDays, minRole: 'admin', group: 'Team & Scheduling' },
  { id: 'tech-visibility', label: 'Tech Visibility', Icon: EyeOff, minRole: 'admin', group: 'Team & Scheduling' },
  { id: 'vacation-tracker', label: 'Vacation Tracker', Icon: CalendarDays, minRole: 'admin', group: 'Team & Scheduling' },
  // Sync & Data
  { id: 'backfill', label: 'Backfill', Icon: Download, minRole: 'admin', group: 'Sync & Data' },
  { id: 'backup-restore', label: 'Backup & Restore', Icon: DatabaseBackup, minRole: 'admin', group: 'Sync & Data' },
  { id: 'sync-ops', label: 'Sync Operations', Icon: BarChart3, minRole: 'admin', group: 'Sync & Data' },
  { id: 'sync', label: 'Sync Settings', Icon: RefreshCw, minRole: 'admin', group: 'Sync & Data' },
  // Workspace
  { id: 'admins', label: 'Admins', Icon: Shield, minRole: 'global', group: 'Workspace' },
  { id: 'ai-usage', label: 'AI Usage & Cost', Icon: BarChart3, minRole: 'global', group: 'Workspace' },
  { id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard, minRole: 'viewer', group: 'Workspace' },
  { id: 'workspace-access', label: 'Workspace Access', Icon: KeyRound, minRole: 'admin', group: 'Workspace' },
  { id: 'workspaces', label: 'Workspaces', Icon: Globe, minRole: 'global', group: 'Workspace' },
];

/**
 * Role-filtered section list. Global-'agent' users get NO sections at all —
 * their configuration home is the agent portal, and every Settings entry
 * point hides behind canAccessSettings(user) (navDestinations.jsx); this
 * empty list is the belt-and-braces guard for deep links, rendered as the
 * "No settings available for your role" card.
 */
export function filterSettingsNavItems({ isAgent = false, isGlobalAdmin = false, isWsAdmin = false, isWsReviewer = false } = {}) {
  if (isAgent) return [];
  return ALL_SETTINGS_NAV_ITEMS.filter((item) => {
    if (item.minRole === 'global') return isGlobalAdmin;
    if (item.minRole === 'admin') return isWsAdmin;
    if (item.minRole === 'reviewer') return isWsReviewer;
    return true; // viewer
  });
}

/**
 * Resolve which section actually renders: the requested one (hash/click) only
 * if it survived the role filter, else the first visible section, else null
 * (→ the friendly empty-state card). Never resolves to a hidden section.
 */
export function resolveActiveSettingsItem(navigationItems, requestedId) {
  return navigationItems.find((item) => item.id === requestedId) || navigationItems[0] || null;
}
