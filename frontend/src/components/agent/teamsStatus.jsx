import { formatPacificWhen } from '../../utils/ticketDates';

/**
 * MEGA 11-14 Part C: one person's Teams status, the same words on the admin's
 * Settings → Teams list and on the person's own Teams panel. The server
 * derives it (teamsNotificationService.deriveTeamsStatus):
 *   connected | disconnected | blocked | not_connected
 */
export const TEAMS_STATUS = {
  connected: { label: 'Connected', dot: 'bg-emerald-500', text: 'text-muted-foreground' },
  blocked: { label: 'Blocked by Teams policy', dot: 'bg-red-500', text: 'text-red-700 dark:text-red-200' },
  disconnected: { label: 'Disconnected', dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
  not_connected: { label: 'Not connected yet', dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
};

export const statusOf = (s) => TEAMS_STATUS[s] || TEAMS_STATUS.not_connected;

const cards = (n) => `${n} card${n === 1 ? '' : 's'}`;

/** "Last refused Tue 17 Nov, 9:14 AM · 12 cards missed in 7 days · paused until …" */
export function blockedDetail(p, now = new Date()) {
  const bits = [];
  if (p?.lastBlockedAt) bits.push(`last refused ${formatPacificWhen(p.lastBlockedAt, now)}`);
  if (p?.missed7d) bits.push(`${cards(p.missed7d)} missed in 7 days`);
  if (p?.emailedInstead7d) bits.push(`${p.emailedInstead7d} sent by e-mail instead`);
  if (p?.backoffUntil) bits.push(`Ticket Pulse tries again ${formatPacificWhen(p.backoffUntil, now)}`);
  const text = bits.join(' · ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

/** The words for what a Teams admin changes (Teams admin center path). */
export const TEAMS_ADMIN_STEPS = 'In the Teams admin center: Teams apps → Permission policies → the policy assigned to the person → allow Ticket Pulse.';
