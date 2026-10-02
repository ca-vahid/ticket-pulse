import { Link } from 'react-router-dom';
import { PersonAvatar } from '../tickets/ticketUi';

/**
 * Small shared pieces for Onboarding / Offboarding (plans/HR_LIFECYCLE_PLAN.md).
 * Status is a coloured dot + a word — never a pill (Vahid's visual taste).
 */

const DOT = {
  blue: 'bg-blue-500 dark:bg-blue-400',
  green: 'bg-emerald-500 dark:bg-emerald-400',
  amber: 'bg-amber-500 dark:bg-amber-400',
  red: 'bg-red-500 dark:bg-red-400',
  grey: 'bg-muted-foreground/50',
};

export function StatusDot({ tone = 'grey', label, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-foreground/85 ${className}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[tone] || DOT.grey}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export function Person({ name, photoUrl = null, sub = null, size = 'h-6 w-6' }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <PersonAvatar name={name} photoUrl={photoUrl} size={size} />
      <span className="min-w-0">
        <span className="block truncate text-sm text-foreground">{name || 'Unassigned'}</span>
        {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
      </span>
    </span>
  );
}

export function TicketRef({ ticket, className = '' }) {
  if (!ticket) return <span className="text-muted-foreground">—</span>;
  return (
    <Link to={`/tickets/${ticket.id}`} className={`tp-focus-ring rounded font-medium text-primary hover:underline ${className}`}>
      {ticket.ref}
    </Link>
  );
}

export function SectionTitle({ children, hint = null, action = null }) {
  return (
    <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{children}</h2>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {action}
    </div>
  );
}
