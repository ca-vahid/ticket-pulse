import { Link } from 'react-router-dom';
import { PersonAvatar } from '../tickets/ticketUi';
import { useRequesterPhoto } from '../../hooks/useRequesterPhoto';

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

/** A person from an HR notice: their directory photo when we know their e-mail, initials otherwise. */
export function NoticePerson({ name, email = null, sub = null, size = 'h-8 w-8' }) {
  const photo = useRequesterPhoto(email);
  return <Person name={name} photoUrl={photo} sub={sub} size={size} />;
}

/** The people holding a set of tickets: overlapping faces, then "+n". */
export function AvatarStack({ people = [], max = 4 }) {
  if (!people.length) return <span className="text-xs text-muted-foreground">Nobody yet</span>;
  const shown = people.slice(0, max);
  return (
    <span className="inline-flex items-center" title={people.map((p) => p.name).join(', ')}>
      <span className="flex -space-x-1.5">
        {shown.map((p) => (
          <span key={p.id} className="rounded-full ring-2 ring-card">
            <PersonAvatar name={p.name} photoUrl={p.photoUrl} size="h-6 w-6" textSize="text-[10px]" />
          </span>
        ))}
      </span>
      <span className="ml-2 truncate text-xs text-muted-foreground">
        {people.length === 1 ? people[0].name : `${people.length} people`}
        {people.length > max ? ` (+${people.length - max})` : ''}
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
