import { ArrowRight, CalendarPlus, Mail, MessageSquare } from 'lucide-react';
import { formatOnCallDay, formatOnCallMoment } from '../../utils/onCallFormat';
import {
  currentStretch, dayWords, durationWords, firstName, hueOf, myTurn, progressOf, sameId, solid, startsInWords, tint,
} from '../../utils/onCallSchedule';
import { DotWord, Face, FaceName } from './onCallUi';

/**
 * The top of the on-call page: who has the phone right now and until when,
 * who takes it next, and the signed-in person's own turn. Everything here is
 * read-only; "now" is passed in so the countdown follows the page's clock.
 */

const actionLink = 'tp-focus-ring inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted';
const label = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';

function ShiftTrack({ stretch, now, hue, timeZone }) {
  const done = progressOf(stretch.startsAt, stretch.endsAt, now);
  const percent = Math.round(done * 100);
  return (
    <div className="mt-5" data-testid="on-call-shift-track">
      <div
        role="progressbar"
        aria-label="How far through this turn"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="relative h-2 overflow-hidden rounded-full"
        style={{ backgroundColor: tint(hue, 0.18) }}
      >
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(2, percent)}%`, backgroundColor: solid(hue) }} />
      </div>
      <div className="mt-1.5 flex justify-between gap-3 text-[11px] tabular-nums text-muted-foreground">
        <span>Since {formatOnCallMoment(stretch.startsAt, timeZone)}</span>
        <span>{formatOnCallMoment(stretch.endsAt, timeZone)}</span>
      </div>
    </div>
  );
}

/** Who has the phone on each of the next seven nights, starting tonight. */
function SevenNights({ days, today, people, hues, myId }) {
  const from = days.findIndex((day) => day.date === today);
  const nights = from < 0 ? [] : days.slice(from, from + 7);
  if (nights.length < 2) return null;
  return (
    <div className="mt-5 border-t border-border/70 pt-4" data-testid="on-call-nights">
      <p className="text-[11px] font-medium text-muted-foreground">The next seven nights</p>
      <ol className="mt-2 grid grid-cols-7 gap-1">
        {nights.map((day, i) => {
          const person = people[day.technicianId] || null;
          const [weekday, dayNumber] = dayWords(day.date).split(' ');
          const mine = sameId(day.technicianId, myId);
          const name = person?.name || 'Nobody';
          return (
            <li
              key={day.date}
              title={[dayWords(day.date), name, day.holiday, day.needsCover ? 'needs cover' : null].filter(Boolean).join(', ')}
              className={`flex min-w-0 flex-col items-center rounded-lg px-0.5 py-1.5 text-center ${i === 0 ? 'bg-muted/70' : ''}`}
            >
              <span className={`text-[10px] uppercase tracking-wide ${i === 0 ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{i === 0 ? 'Tonight' : weekday}</span>
              <span className="text-[11px] tabular-nums text-muted-foreground">{dayNumber}</span>
              <Face person={person} size="h-7 w-7" textSize="text-[9px]" hue={hueOf(hues, day.technicianId)} className="mt-1" />
              <span className={`mt-1 w-full truncate text-[11px] text-foreground ${mine ? 'font-semibold' : ''}`}>{mine ? 'You' : firstName(name)}</span>
              <span className="mt-0.5 flex h-2 items-center gap-1" aria-hidden="true">
                {day.holiday && <span className="h-1.5 w-1.5 rotate-45 bg-foreground/60" />}
                {day.needsCover && <span className="h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400" />}
              </span>
              <span className="sr-only">{[day.holiday, day.needsCover ? 'needs cover' : null].filter(Boolean).join(', ')}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function NowCard({ data, people, hues, now, timeZone, myId, today }) {
  const current = data.current || {};
  const holder = current.technician ? { ...current.technician, ...(people[current.technician.id] || {}) } : null;
  const scheduled = current.scheduled ? { ...current.scheduled, ...(people[current.scheduled.id] || {}) } : null;
  const covering = holder && current.cover && scheduled && !sameId(scheduled.id, holder.id) ? scheduled : null;
  const mine = holder && sameId(holder.id, myId);
  const hue = hueOf(hues, holder?.id);
  const stretch = holder ? currentStretch(data.weeks, now) : null;
  // A cover that runs into the same person's own week is one turn: say when they really hand over.
  const until = stretch && sameId(stretch.technicianId, holder?.id) && (!current.until || new Date(stretch.endsAt) > new Date(current.until))
    ? stretch.endsAt
    : current.until;
  const left = until ? durationWords(now, new Date(until).getTime()) : '';
  const before = data.previous && !covering && stretch && sameId(stretch.technicianId, holder?.id)
    ? people[data.previous.technicianId] || null
    : null;
  // "Took over from" only when the turn began at the last handover with somebody else.
  const tookOver = before && !sameId(before.id, holder?.id) && new Date(stretch.startsAt).getTime() === new Date(data.previous.endsAt).getTime() ? before : null;

  if (!holder) {
    return (
      <section aria-labelledby="on-call-now" className="tp-card p-5 sm:p-6">
        <h2 id="on-call-now" className={label}>On call now</h2>
        <div className="mt-3 flex items-start gap-3">
          <Face person={null} size="h-14 w-14" />
          <div className="min-w-0">
            <DotWord tone="amber">Nobody has the phone</DotWord>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              Nobody is on call right now.
              {current.onLeaveNoCover && scheduled?.name ? ` ${scheduled.name} is away and has no cover yet.` : ''}
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="on-call-now" className="tp-card relative overflow-hidden p-5 sm:p-6">
      <span className="pointer-events-none absolute inset-x-0 top-0 h-24" style={{ background: `linear-gradient(180deg, ${tint(hue, 0.14)}, transparent)` }} aria-hidden="true" />
      <div className="relative">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="on-call-now" className={label}>On call now</h2>
          <DotWord tone="green" live>Has the phone</DotWord>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3" data-testid="on-call-now">
          <Face person={holder} size="h-16 w-16" textSize="text-lg" hue={hue} />
          <div className="min-w-0 flex-1 basis-56">
            <p className="truncate text-xl font-semibold leading-tight text-foreground">{holder.name}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-muted-foreground">
              {mine && <span className="font-medium text-foreground">That is you</span>}
              {until && (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  {mine && <span aria-hidden="true">·</span>}
                  <span>until {formatOnCallMoment(until, timeZone)}</span>
                </span>
              )}
              {left && <span className="whitespace-nowrap tabular-nums" data-testid="on-call-left">({left} left)</span>}
            </p>
            {covering && <p className="mt-1 text-sm text-muted-foreground">Covering for {covering.name}</p>}
            {tookOver && <p className="mt-1 text-sm text-muted-foreground">Took over from {tookOver.name}</p>}
            {holder.location && <p className="mt-1 text-xs text-muted-foreground">{holder.location}</p>}
          </div>
          {!mine && holder.email && (
            <div className="flex flex-wrap gap-2">
              <a className={actionLink} href={`https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(holder.email)}`} target="_blank" rel="noreferrer" aria-label={`Chat with ${holder.name} in Teams`}>
                <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                Teams
              </a>
              <a className={actionLink} href={`mailto:${holder.email}`} aria-label={`E-mail ${holder.name}`}>
                <Mail className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                E-mail
              </a>
            </div>
          )}
        </div>
        {stretch && <ShiftTrack stretch={stretch} now={now} hue={hue} timeZone={timeZone} />}
        <SevenNights days={Array.isArray(data.days) ? data.days : []} today={today} people={people} hues={hues} myId={myId} />
      </div>
    </section>
  );
}

function NextUp({ data, people, hues, now, timeZone, myId }) {
  const next = data.next;
  const person = next ? people[next.technicianId] || { id: next.technicianId, name: `Technician ${next.technicianId}` } : null;
  return (
    <section aria-labelledby="on-call-next" className="tp-card p-4 sm:p-5" data-testid="on-call-next">
      <h2 id="on-call-next" className={label}>Next</h2>
      {person ? (
        <div className="mt-3 flex items-center gap-2">
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/75" aria-hidden="true" />
          <FaceName
            person={person}
            size="h-9 w-9"
            hue={hueOf(hues, person.id)}
            strong
            sub={`${sameId(person.id, myId) ? 'You take over' : 'takes over'} ${formatOnCallMoment(next.startsAt, timeZone)}`}
          />
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">No change of hands in the weeks shown.</p>
      )}
      {person && <p className="mt-1.5 pl-6 text-xs tabular-nums text-muted-foreground" data-testid="on-call-next-in">{startsInWords(next.startsAt, now)}</p>}
    </section>
  );
}

function MyTurn({ data, now, timeZone, myId, onDownloadMine }) {
  const turn = myTurn(data.weeks, myId, now);
  const inRotation = data.me?.inRotation === true;
  let line;
  let sub = null;
  if (myId == null) {
    line = 'You are not a technician of this workspace.';
    sub = 'On-call weeks go to the people in the rotation.';
  } else if (turn?.now) {
    line = 'You have the phone now';
    sub = `until ${formatOnCallMoment(turn.endsAt, timeZone)}`;
  } else if (turn) {
    line = `${formatOnCallDay(turn.startsAt, timeZone)} to ${formatOnCallDay(turn.endsAt, timeZone)}`;
    sub = `${turn.cover ? 'You cover' : 'Your next turn'}, ${startsInWords(turn.startsAt, now)}`;
  } else if (inRotation) {
    line = 'No turn in the weeks shown';
    sub = 'Your next week is further out.';
  } else {
    line = 'You are not in the rotation';
    sub = 'A workspace admin sets the order.';
  }
  return (
    <section aria-labelledby="on-call-mine" className="tp-card p-4 sm:p-5" data-testid="on-call-mine">
      <h2 id="on-call-mine" className={label}>Your turn</h2>
      <p className="mt-2 text-sm font-semibold text-foreground">{line}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      {turn && (
        <button type="button" onClick={onDownloadMine} className={`${actionLink} mt-3`}>
          <CalendarPlus className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          Add my turns to my calendar
        </button>
      )}
    </section>
  );
}

export default function OnCallHero({ data, people, hues, now, timeZone, myId, today, onDownloadMine }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
      <NowCard data={data} people={people} hues={hues} now={now} timeZone={timeZone} myId={myId} today={today} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
        <NextUp data={data} people={people} hues={hues} now={now} timeZone={timeZone} myId={myId} />
        <MyTurn data={data} now={now} timeZone={timeZone} myId={myId} onDownloadMine={onDownloadMine} />
      </div>
    </div>
  );
}
