import { ColorSwatch, trimNum } from './availabilityUi';

/**
 * Balances for the balance-tracked leave types: the remaining days large, the
 * arithmetic small underneath ("of 15 · 3 taken · 2 booked · 1 pending").
 * Flat columns divided by hairlines — no boxes per number.
 */
export default function BalancesRow({ balances = [], leaveTypes = [] }) {
  if (!balances.length) return null;
  const typeById = new Map(leaveTypes.map((t) => [t.id, t]));
  return (
    <section aria-label="Balances" className="mb-5 flex flex-wrap gap-x-8 gap-y-4 border-b border-border pb-5" data-testid="availability-balances">
      {balances.map((b) => {
        const type = typeById.get(b.leaveTypeId);
        const entitled = Number(b.entitled || 0) + Number(b.adjustments || 0);
        const remaining = Number(b.remaining || 0);
        return (
          <div key={`${b.leaveTypeId}-${b.year}`} className="min-w-[9rem]">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ColorSwatch color={type?.color} />
              {b.name || type?.name} · {b.year}
            </p>
            <p className={`mt-0.5 text-3xl font-semibold tabular-nums ${remaining < 0 ? 'text-red-600 dark:text-red-300' : 'text-foreground'}`}>
              {trimNum(remaining)}
              <span className="ml-1 text-sm font-normal text-muted-foreground">{Math.abs(remaining) === 1 ? 'day left' : 'days left'}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              of {trimNum(entitled)} · {trimNum(b.taken)} taken · {trimNum(b.scheduled)} booked · {trimNum(b.pending)} pending
            </p>
          </div>
        );
      })}
    </section>
  );
}
