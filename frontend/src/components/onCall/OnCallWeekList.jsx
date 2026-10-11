import { useEffect, useRef } from 'react';
import { ArrowRight, PartyPopper, Plane } from 'lucide-react';
import { formatOnCallMoment, formatOnCallRange } from '../../utils/onCallFormat';
import { dayWords, hueOf, localDateOf, sameId, solid, weekWord } from '../../utils/onCallSchedule';
import { AmberWord, Face, FaceName } from './onCallUi';

/**
 * The weeks as a list, in words: when, whose week, who covers which part,
 * the holidays inside it and the days the scheduled person is away. The same
 * facts as the ribbon and the calendar, readable top to bottom and by a
 * screen reader.
 */

function CoverLine({ cover, people, hues, timeZone, myId }) {
  const who = cover.technician ? { ...cover.technician, ...(people[cover.technician.id] || {}) } : null;
  const mine = sameId(who?.id, myId);
  return (
    <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
      <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/75" aria-hidden="true" />
      <Face person={who} size="h-5 w-5" textSize="text-[8px]" hue={hueOf(hues, who?.id)} className="-mt-0.5" />
      <span className="min-w-0">
        {mine ? 'You cover' : `${who?.name || 'Someone'} covers`}
        {' '}{formatOnCallMoment(cover.startsAt, timeZone)} to {formatOnCallMoment(cover.endsAt, timeZone)}
        {cover.note ? ` · ${cover.note}` : ''}
      </span>
    </p>
  );
}

function WeekRow({ week, position, people, hues, timeZone, myId, holidays, selected, rowRef }) {
  const scheduled = week.scheduled ? { ...week.scheduled, ...(people[week.scheduled.id] || {}) } : null;
  const mine = sameId(scheduled?.id, myId);
  const covers = Array.isArray(week.covers) ? week.covers : [];
  const open = week.openRequest && week.openRequest.status === 'open' ? week.openRequest : null;
  const leaveDays = Array.isArray(week.leaveDays) ? week.leaveDays : [];
  const hue = hueOf(hues, scheduled?.id);
  return (
    <li
      ref={rowRef}
      data-testid={`on-call-week-${week.index}`}
      data-selected={selected ? 'true' : undefined}
      className={`relative flex flex-wrap items-start gap-x-4 gap-y-2 py-3.5 pl-4 pr-2 transition-colors ${selected ? 'bg-primary/5' : ''} ${position === 0 ? 'bg-muted/40' : ''}`}
    >
      <span className="absolute inset-y-2 left-0 w-1 rounded-full" style={{ backgroundColor: solid(hue) }} aria-hidden="true" />
      <div className="w-full sm:w-52 sm:flex-none">
        <p className={`text-xs ${position === 0 ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{weekWord(position)}</p>
        <p className="mt-0.5 text-sm tabular-nums text-foreground/85">{formatOnCallRange(week.startsAt, week.endsAt, timeZone)}</p>
      </div>
      <div className="min-w-0 flex-1 basis-56">
        <FaceName person={scheduled} hue={hue} strong={mine} />
        {covers.map((cover) => <CoverLine key={cover.id} cover={cover} people={people} hues={hues} timeZone={timeZone} myId={myId} />)}
        {leaveDays.length > 0 && (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <Plane className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/75" aria-hidden="true" />
            <span>Away {leaveDays.map(dayWords).join(', ')}</span>
          </p>
        )}
        {holidays.map((holiday) => (
          <p key={holiday.date} className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <PartyPopper className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/75" aria-hidden="true" />
            <span>{holiday.name}, {dayWords(holiday.date)}</span>
          </p>
        ))}
      </div>
      <div className="flex flex-col items-start gap-1 sm:items-end">
        {mine && <span className="text-xs font-semibold text-foreground">Your week</span>}
        {week.needsCover && <AmberWord>Needs cover</AmberWord>}
        {week.needsCover && open && (
          <span className="text-xs text-muted-foreground">
            Asked {open.askedCount} {open.askedCount === 1 ? 'person' : 'people'}{open.declinedCount ? ` · ${open.declinedCount} declined` : ''}
          </span>
        )}
      </div>
    </li>
  );
}

export default function OnCallWeekList({ weeks, holidays = [], people, hues, timeZone, myId, selectedIndex = null, selectedAt = 0 }) {
  const selectedRef = useRef(null);
  // A week picked on the ribbon comes into view (each pick, even the same week twice).
  useEffect(() => {
    if (selectedIndex == null) return;
    const el = selectedRef.current;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, selectedAt]);

  // A holiday on the handover day belongs to both weeks: each person holds part of it.
  const holidaysOf = (week) => {
    const from = localDateOf(week.startsAt, timeZone);
    const to = localDateOf(week.endsAt, timeZone);
    return holidays.filter((holiday) => holiday.date >= from && holiday.date <= to);
  };

  if (!weeks.length) return <p className="text-sm text-muted-foreground">No weeks are scheduled yet.</p>;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {weeks.map((week, position) => {
        const selected = selectedIndex === week.index;
        return (
          <WeekRow
            key={week.index ?? week.startsAt}
            week={week}
            position={position}
            people={people}
            hues={hues}
            timeZone={timeZone}
            myId={myId}
            holidays={holidaysOf(week)}
            selected={selected}
            rowRef={selected ? selectedRef : undefined}
          />
        );
      })}
    </ul>
  );
}
