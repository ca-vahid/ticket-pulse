import { ChevronsUp } from 'lucide-react';
import { escalationLine, latestEscalation } from '../../utils/handBack';
import { timeAgo } from './ticketUi';

/**
 * QA 10-16 item 1: the ticket says when it was escalated — "Escalated by Alex
 * Doe: needs someone more advanced in Networking / VPN". Read from the ticket's
 * audit rows (the hand-back writes the snapshot there). Plain text, no badge.
 */
export default function EscalationNote({ activities = null, escalation = null, className = '' }) {
  const esc = escalation || latestEscalation(activities);
  if (!esc) return null;
  const line = escalationLine(esc);
  return (
    <p
      className={`flex items-start gap-1.5 text-xs leading-snug text-foreground/85 ${className}`}
      data-testid="escalation-note"
      title={[line, esc.level ? `Their level: ${esc.level}` : null, esc.note ? `Note: ${esc.note}` : null].filter(Boolean).join('\n')}
    >
      <ChevronsUp className="mt-px h-3.5 w-3.5 flex-shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
      <span className="min-w-0">
        {line}
        {esc.at && <span className="ml-1 text-muted-foreground/75">· {timeAgo(esc.at)}</span>}
      </span>
    </p>
  );
}
