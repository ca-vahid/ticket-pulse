/**
 * Analytics → Automation Ops: what the Urgent rule did in the selected range
 * (plans/URGENT_RESPONSE_PLAN.md). Plain counts grouped by layer; live in
 * normal text, Shadow ("would have") in muted text. Counts only: never a
 * person, never a ranking.
 *
 * `data` = ops.urgentResponse = { mode, live: {...}, shadow: {...} } with the
 * keys redirected, held, moved, toldOwnerAway, teamTold, coordinator,
 * onCallAssigned, undone. When the server also splits `moved` into
 * `raiseMoved` / `clockMoved`, each layer shows its own number.
 */

const MODE = {
  live: { label: 'Live', dot: 'bg-emerald-500 dark:bg-emerald-400' },
  observe: { label: 'Shadow', dot: 'bg-amber-500 dark:bg-amber-400' },
  off: { label: 'Off', dot: 'bg-muted-foreground/50' },
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const fmt = (v) => num(v).toLocaleString();

function groupsFor(sample) {
  const split = sample && (sample.clockMoved != null || sample.raiseMoved != null);
  const raiseMoved = (c) => (c.raiseMoved != null ? num(c.raiseMoved) : Math.max(0, num(c.moved) - num(c.clockMoved)));
  return [
    {
      id: 'assign',
      title: 'When assigning',
      rows: [
        { id: 'redirected', label: 'Given to someone at work instead', value: (c) => num(c.redirected) },
        { id: 'held', label: 'Held, nobody at work', value: (c) => num(c.held) },
      ],
    },
    {
      id: 'raise',
      title: 'When it becomes urgent',
      rows: [
        split
          ? { id: 'raiseMoved', label: 'Moved to someone at work', value: raiseMoved }
          : { id: 'moved', label: 'Moved to someone at work (clock moves included)', value: (c) => num(c.moved) },
        { id: 'toldOwnerAway', label: 'Owner away, team told', value: (c) => num(c.toldOwnerAway) },
        { id: 'onCallAssigned', label: 'Given to the on-call person', value: (c) => num(c.onCallAssigned) },
      ],
    },
    {
      id: 'clock',
      title: 'Untouched clock',
      rows: [
        { id: 'teamTold', label: 'Team told', value: (c) => num(c.teamTold) },
        ...(split ? [{ id: 'clockMoved', label: 'Moved', value: (c) => num(c.clockMoved) }] : []),
        { id: 'coordinator', label: 'Passed to the coordinator', value: (c) => num(c.coordinator) },
      ],
    },
    {
      id: 'undo',
      title: 'Undone',
      rows: [
        { id: 'undone', label: 'Moves undone by a person', value: (c) => num(c.undone) },
      ],
    },
  ];
}

export default function UrgentResponseOps({ data }) {
  if (!data) return null;
  const live = data.live || {};
  const shadow = data.shadow || {};
  const mode = MODE[data.mode] || MODE.off;
  const shadowTotal = Object.values(shadow).reduce((sum, v) => sum + num(v), 0);
  const showShadow = data.mode === 'observe' || shadowTotal > 0;
  const groups = groupsFor({ ...shadow, ...live });

  return (
    <div data-testid="urgent-response-ops">
      <p className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 text-foreground/85">
          <span className={`h-2 w-2 shrink-0 rounded-full ${mode.dot}`} aria-hidden="true" />
          {mode.label}
        </span>
        {showShadow && <span>Shadow numbers are what the rule would have done. Nothing moved and nobody was told.</span>}
      </p>
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-4">
        {groups.map((group) => (
          <section key={group.id} aria-label={group.title} data-testid={`urgent-ops-${group.id}`}>
            <h3 className="mb-1.5 text-[13px] font-semibold text-foreground">{group.title}</h3>
            <dl className="space-y-1.5">
              {group.rows.map((row) => (
                <div key={row.id} className="flex items-baseline justify-between gap-3" data-testid={`urgent-ops-${row.id}`}>
                  <dt className="min-w-0 text-sm text-foreground/85">{row.label}</dt>
                  <dd className="flex flex-none items-baseline gap-2 tabular-nums">
                    <span className="text-sm font-semibold text-foreground">{fmt(row.value(live))}</span>
                    {showShadow && <span className="text-xs text-muted-foreground">Shadow {fmt(row.value(shadow))}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
