import { PersonAvatar } from '../tickets/ticketUi';
import { solid } from '../../utils/onCallSchedule';

/**
 * Small shared pieces of the on-call page (plans/URGENT_RESPONSE_PLAN.md).
 * A person is always a face and a name; a state is a dot and a word, never a
 * pill. Each person keeps one colour across the ribbon, the calendar and the
 * rotation, and the colour is never the only sign: the name is always there.
 */

export function SectionHeading({ id, children, hint = null, action = null }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
      <div>
        <h2 id={id} className="text-[13px] font-semibold text-foreground">{children}</h2>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

const WORD_TONES = {
  amber: ['text-amber-700 dark:text-amber-300', 'bg-amber-500 dark:bg-amber-400'],
  green: ['text-emerald-700 dark:text-emerald-300', 'bg-emerald-500 dark:bg-emerald-400'],
  grey: ['text-muted-foreground', 'bg-muted-foreground/50'],
};

/** A dot and a word. `live` lets the dot breathe (still for people who turned motion down). */
export function DotWord({ tone = 'grey', live = false, children, className = '' }) {
  const [text, dot] = WORD_TONES[tone] || WORD_TONES.grey;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${text} ${className}`}>
      <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden="true">
        {live && <span className={`tp-on-call-breathe absolute inline-flex h-full w-full rounded-full opacity-60 ${dot}`} />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
      </span>
      {children}
    </span>
  );
}

export function AmberWord({ children }) {
  return <DotWord tone="amber">{children}</DotWord>;
}

/** The colour of a person, as a small square beside their name (legend, rotation). */
export function HueMark({ hue, className = '' }) {
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-[3px] ${className}`} style={{ backgroundColor: solid(hue) }} aria-hidden="true" />;
}

/**
 * A face: the directory photo when the API sent one, initials otherwise. With a
 * `hue`, a thin ring in the person's colour ties the face to the schedule.
 */
export function Face({ person, size = 'h-8 w-8', textSize = 'text-[11px]', hue = null, className = '' }) {
  const avatar = <PersonAvatar name={person?.name || null} photoUrl={person?.photoUrl || null} size={size} textSize={textSize} />;
  if (hue == null) return <span className={`inline-flex shrink-0 ${className}`}>{avatar}</span>;
  return (
    <span className={`inline-flex shrink-0 rounded-full p-[2px] ${className}`} style={{ boxShadow: `inset 0 0 0 2px ${solid(hue)}` }}>
      {avatar}
    </span>
  );
}

/** A face with the name beside it, and an optional second line. */
export function FaceName({ person, fallback = 'Nobody yet', sub = null, size = 'h-8 w-8', hue = null, strong = false }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2.5">
      <Face person={person} size={size} hue={hue} />
      <span className="min-w-0">
        <span className={`block truncate text-sm text-foreground ${strong ? 'font-semibold' : ''}`}>{person?.name || fallback}</span>
        {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
      </span>
    </span>
  );
}
