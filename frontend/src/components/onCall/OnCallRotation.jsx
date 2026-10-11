import { ChevronRight, Repeat } from 'lucide-react';
import { formatOnCallDay } from '../../utils/onCallFormat';
import { hueOf, nextOwnWeek, sameId } from '../../utils/onCallSchedule';
import { Face } from './onCallUi';

/**
 * The rotation itself: the people in the order they take the phone, and when
 * each one's next week starts. It is an order, not a ranking: nothing here
 * counts or compares what anybody did.
 */
export default function OnCallRotation({ order, weeks, people, hues, timeZone, myId, scheduledNowId }) {
  if (!order.length) return null;
  return (
    <ol className="flex flex-wrap items-stretch gap-y-3" data-testid="on-call-rotation">
      {order.map((id, i) => {
        const person = people[id] || { id, name: `Technician ${id}` };
        const now = sameId(id, scheduledNowId);
        const next = nextOwnWeek(now ? weeks.slice(1) : weeks, id);
        const mine = sameId(id, myId);
        return (
          <li key={id} className="flex items-center" data-testid={`on-call-rotation-${id}`}>
            <div className={`flex w-[104px] flex-col items-center rounded-lg px-2 py-2 text-center ${now ? 'bg-muted' : ''}`}>
              <Face person={person} size="h-10 w-10" textSize="text-xs" hue={hueOf(hues, id)} />
              <span className={`mt-1.5 w-full truncate text-xs text-foreground ${mine ? 'font-semibold' : ''}`} title={person.name}>{person.name}</span>
              <span className="mt-0.5 w-full truncate text-[11px] tabular-nums text-muted-foreground">
                {now ? 'This week' : next ? formatOnCallDay(next.startsAt, timeZone).replace(/^\w+\s/, '') : 'Later'}
              </span>
            </div>
            {i < order.length - 1
              ? <ChevronRight className="mx-0.5 h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
              : order.length > 1 && <Repeat className="mx-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-label="then back to the first person" />}
          </li>
        );
      })}
    </ol>
  );
}
