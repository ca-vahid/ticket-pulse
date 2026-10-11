import { useMemo, useState } from 'react';
import { dayWords, firstName, hueOf, monthGrids, sameId, solid, tint } from '../../utils/onCallSchedule';
import { handoverTimeLabel } from '../../utils/onCallFormat';
import { Face, HueMark } from './onCallUi';

/**
 * The schedule as month grids: each day takes the colour of whoever has the
 * phone that night. A day on which it changes hands is split corner to corner
 * (morning colour, then night colour). Holidays carry a small mark, the days
 * that need cover an amber one, today a ring. Picking a day spells it out in
 * words underneath, and the legend names every colour.
 */

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function sentenceFor(day, people, myId, handoverTime, today) {
  if (!day) return '';
  const when = day.date === today ? 'tonight' : 'that night';
  const night = people[day.technicianId]?.name || (day.technicianId ? `Technician ${day.technicianId}` : null);
  const morning = people[day.morningTechnicianId]?.name || null;
  const changes = !sameId(day.technicianId, day.morningTechnicianId);
  const who = sameId(day.technicianId, myId) ? 'You have' : `${night || 'Nobody'} has`;
  const parts = [`${dayWords(day.date)}: ${night ? `${who} the phone ${when}${day.cover ? ', as cover' : ''}.` : `Nobody has the phone ${when}.`}`];
  if (changes && morning) parts.push(`${sameId(day.morningTechnicianId, myId) ? 'You have' : `${morning} has`} it until the change of hands${day.cover ? '' : ` (${handoverTimeLabel(handoverTime)} on a handover day)`}.`);
  if (day.holiday) parts.push(`${day.holiday}.`);
  if (day.needsCover) parts.push('The scheduled person is away and nobody covers yet.');
  else if (day.away) parts.push('The scheduled person is away; a cover is in place.');
  return parts.join(' ');
}

function DayCell({ day, people, hues, myId, today, selected, startsRun, onPick }) {
  const hue = hueOf(hues, day.technicianId);
  const morningHue = hueOf(hues, day.morningTechnicianId);
  const changes = !sameId(day.technicianId, day.morningTechnicianId);
  const background = changes
    ? `linear-gradient(135deg, ${tint(morningHue, 0.2)} 0 50%, ${tint(hue, 0.2)} 50% 100%)`
    : tint(hue, 0.2);
  const mine = sameId(day.technicianId, myId);
  const name = people[day.technicianId]?.name || null;
  const label = [
    dayWords(day.date),
    name ? `${name}${day.cover ? ' (cover)' : ''}` : 'nobody',
    day.holiday,
    day.needsCover ? 'needs cover' : null,
    today ? 'today' : null,
  ].filter(Boolean).join(', ');
  return (
    <button
      type="button"
      onClick={() => onPick(day.date)}
      aria-label={label}
      aria-pressed={selected}
      title={label}
      data-testid={`on-call-day-${day.date}`}
      data-today={today ? 'true' : undefined}
      className={`tp-focus-ring relative flex aspect-square w-full flex-col justify-between rounded-md p-1 text-left transition-shadow hover:shadow-subtle ${selected ? 'ring-2 ring-primary' : today ? 'ring-2 ring-foreground/70' : ''}`}
      style={{ background }}
    >
      <span className="flex items-start justify-between gap-0.5">
        <span className={`text-[11px] tabular-nums leading-none ${today ? 'font-bold text-foreground' : mine ? 'font-semibold text-foreground' : 'text-foreground/85'}`}>{day.day}</span>
        {day.needsCover
          ? <span className="h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400" aria-hidden="true" />
          : day.holiday && <span className="h-1.5 w-1.5 rotate-45 bg-foreground/60" aria-hidden="true" />}
      </span>
      <span className="flex items-end justify-between" aria-hidden="true">
        {startsRun ? <Face person={people[day.technicianId] || null} size="h-5 w-5" textSize="text-[8px]" /> : <span />}
        <span className="h-1 w-3 rounded-full" style={{ backgroundColor: solid(hue) }} />
      </span>
    </button>
  );
}

export default function OnCallCalendar({ days, people, hues, myId, today, handoverTime }) {
  const months = useMemo(() => monthGrids(days), [days]);
  const [picked, setPicked] = useState(null);
  const pickedDay = days.find((day) => day.date === (picked || today)) || null;
  // A face on the first day of every run of the same person (and the first day we show).
  const runStarts = useMemo(() => {
    const set = new Set();
    days.forEach((day, i) => { if (i === 0 || !sameId(days[i - 1].technicianId, day.technicianId)) set.add(day.date); });
    return set;
  }, [days]);
  const legend = useMemo(() => {
    const seen = [];
    for (const day of days) if (day.technicianId != null && !seen.some((id) => sameId(id, day.technicianId))) seen.push(day.technicianId);
    return seen;
  }, [days]);

  if (!days.length) return <p className="text-sm text-muted-foreground">No days are scheduled yet.</p>;
  return (
    <div data-testid="on-call-calendar">
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
        {months.map((month) => (
          <div key={month.key} role="group" aria-label={month.label}>
            <p className="mb-2 text-xs font-semibold text-foreground">{month.label}</p>
            <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground" aria-hidden="true">
              {WEEKDAYS.map((d) => <span key={d}>{d}</span>)}
            </div>
            <div className="mt-1 grid grid-cols-7 gap-1">
              {month.rows.flat().map((day, i) => (day ? (
                <DayCell
                  key={day.date}
                  day={day}
                  people={people}
                  hues={hues}
                  myId={myId}
                  today={day.date === today}
                  selected={day.date === picked}
                  startsRun={runStarts.has(day.date)}
                  onPick={setPicked}
                />
              ) : <span key={`${month.key}-pad-${i}`} aria-hidden="true" />))}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-4 min-h-[1.25rem] text-sm text-foreground" role="status" data-testid="on-call-day-detail">
        {sentenceFor(pickedDay, people, myId, handoverTime, today)}
      </p>

      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground" aria-label="Who each colour is">
        {legend.map((id) => (
          <li key={id} className="inline-flex items-center gap-1.5">
            <HueMark hue={hueOf(hues, id)} />
            <span className={sameId(id, myId) ? 'font-semibold text-foreground' : ''}>{firstName(people[id]?.name) || `Technician ${id}`}</span>
          </li>
        ))}
        <li className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rotate-45 bg-foreground/60" aria-hidden="true" />Holiday</li>
        <li className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400" aria-hidden="true" />Needs cover</li>
      </ul>
    </div>
  );
}
