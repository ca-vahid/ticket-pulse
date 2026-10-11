import { formatOnCallDay, formatOnCallMoment } from '../../utils/onCallFormat';
import { firstName, hueOf, progressOf, sameId, solid, tint } from '../../utils/onCallSchedule';
import { Face } from './onCallUi';

/**
 * The weeks ahead as one strip: a block per week in its holder's colour, cut
 * where a cover takes over, with a line where today is. Each block is a button
 * that brings its week into view in the list below. The colour never stands
 * alone: every block names its person, and the list repeats it in words.
 */

const ms = (value) => new Date(value).getTime();

function monthOf(value, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-GB', { month: 'short', ...(timeZone ? { timeZone } : {}) }).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat('en-GB', { month: 'short' }).format(new Date(value));
  }
}

function describe(week, people, timeZone, myId) {
  const scheduled = week.scheduled?.name || 'Nobody yet';
  const covers = (week.covers || []).map((cover) => `${cover.technician?.name || 'Someone'} covers ${formatOnCallMoment(cover.startsAt, timeZone)} to ${formatOnCallMoment(cover.endsAt, timeZone)}`);
  return [
    `${formatOnCallDay(week.startsAt, timeZone)} to ${formatOnCallDay(week.endsAt, timeZone)}: ${scheduled}`,
    sameId(week.scheduled?.id, myId) ? 'your week' : null,
    ...covers,
    week.needsCover ? 'needs cover' : null,
  ].filter(Boolean).join(', ');
}

export default function OnCallRibbon({ weeks, people, hues, now, timeZone, myId, selectedIndex = null, onSelect }) {
  if (!weeks.length) return null;
  let lastMonth = null;
  return (
    <div className="settings-scrollbar -mx-1 overflow-x-auto px-1 pb-1" data-testid="on-call-ribbon">
      <ol className="flex min-w-max gap-1 sm:min-w-0">
        {weeks.map((week, position) => {
          const total = ms(week.endsAt) - ms(week.startsAt);
          const segments = Array.isArray(week.segments) && week.segments.length
            ? week.segments
            : [{ technicianId: week.scheduled?.id ?? null, startsAt: week.startsAt, endsAt: week.endsAt, cover: false }];
          const widest = segments.reduce((best, seg) => ((ms(seg.endsAt) - ms(seg.startsAt)) > (ms(best.endsAt) - ms(best.startsAt)) ? seg : best), segments[0]);
          const face = people[widest.technicianId] || (sameId(widest.technicianId, week.scheduled?.id) ? week.scheduled : null);
          const month = monthOf(week.startsAt, timeZone);
          const showMonth = month !== lastMonth;
          lastMonth = month;
          const mine = segments.some((seg) => sameId(seg.technicianId, myId));
          const holdsNow = position === 0 && ms(week.startsAt) <= now && now < ms(week.endsAt);
          const selected = selectedIndex === week.index;
          return (
            <li key={week.index ?? week.startsAt} className="w-[84px] shrink-0 sm:w-auto sm:min-w-0 sm:flex-1">
              <span className="block h-4 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground" aria-hidden="true">
                {showMonth ? month : ''}
              </span>
              <button
                type="button"
                onClick={() => onSelect?.(week.index)}
                aria-label={describe(week, people, timeZone, myId)}
                aria-pressed={selected}
                data-testid={`on-call-ribbon-week-${week.index}`}
                className={`tp-focus-ring group relative block w-full overflow-hidden rounded-lg border text-left transition-shadow hover:shadow-soft ${selected ? 'border-primary ring-2 ring-primary/30' : 'border-border'}`}
              >
                <span className="flex h-12 w-full" aria-hidden="true">
                  {segments.map((seg) => (
                    <span
                      key={`${seg.technicianId}-${ms(seg.startsAt)}`}
                      className="relative h-full"
                      style={{ width: `${((ms(seg.endsAt) - ms(seg.startsAt)) / total) * 100}%`, backgroundColor: tint(hueOf(hues, seg.technicianId), 0.22) }}
                    >
                      <span className="absolute inset-x-0 bottom-0 h-1" style={{ backgroundColor: solid(hueOf(hues, seg.technicianId)) }} />
                    </span>
                  ))}
                </span>
                {holdsNow && (
                  <span
                    className="absolute inset-y-0 w-0.5 bg-foreground"
                    style={{ left: `${progressOf(week.startsAt, week.endsAt, now) * 100}%` }}
                    data-testid="on-call-ribbon-now"
                    aria-hidden="true"
                  />
                )}
                <span className="pointer-events-none absolute inset-0 flex items-center gap-1.5 px-1.5" aria-hidden="true">
                  <Face person={face} size="h-6 w-6" textSize="text-[9px]" />
                  <span className={`min-w-0 truncate text-[11px] text-foreground ${mine ? 'font-semibold' : ''}`}>
                    {firstName(face?.name) || 'Nobody'}
                  </span>
                </span>
                {week.needsCover && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-amber-500 dark:bg-amber-400" aria-hidden="true" />}
              </button>
              <span className="mt-1 block truncate text-[11px] tabular-nums text-muted-foreground" aria-hidden="true">
                {formatOnCallDay(week.startsAt, timeZone).replace(/^\w+\s/, '')}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
