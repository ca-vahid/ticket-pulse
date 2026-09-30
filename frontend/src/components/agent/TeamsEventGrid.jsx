/**
 * "What am I told about" grid (plans/TEAMS_NOTIFICATIONS_PLAN.md) — shared by
 * the agent's Teams panel and the admin's workspace defaults. One row per
 * event, grouped; each row picks Teams / Digest / Off with a small segmented
 * control. Words, not badges.
 */
const MODES = [
  { key: 'teams', label: 'Teams' },
  { key: 'digest', label: 'Digest' },
  { key: 'off', label: 'Off' },
];

export default function TeamsEventGrid({ events = [], onChange, disabled = false, extra = null }) {
  const groups = [];
  for (const e of events) {
    let g = groups.find((x) => x.name === e.group);
    if (!g) { g = { name: e.group, rows: [] }; groups.push(g); }
    g.rows.push(e);
  }
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.name}>
          <div className="mb-1 text-xs font-semibold text-muted-foreground">{g.name}</div>
          <ul className="divide-y divide-border border-y border-border">
            {g.rows.map((e) => (
              <li key={e.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-foreground">{e.label}</div>
                  {e.workspaceDefault && e.workspaceDefault !== e.mode && (
                    <div className="text-[11px] text-muted-foreground/75">Workspace default: {MODES.find((m) => m.key === e.workspaceDefault)?.label}</div>
                  )}
                  {extra?.(e)}
                </div>
                <div role="radiogroup" aria-label={e.label} className="inline-flex flex-shrink-0 overflow-hidden rounded-md border border-input">
                  {MODES.map((m) => {
                    const on = e.mode === m.key;
                    return (
                      <button
                        key={m.key}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        disabled={disabled}
                        onClick={() => !on && onChange(e.key, m.key)}
                        className={`tp-focus-ring px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50 ${on
                          ? (m.key === 'off' ? 'bg-muted text-foreground' : 'bg-primary text-primary-foreground')
                          : 'bg-card text-muted-foreground hover:bg-muted hover:text-foreground'} ${m.key !== 'teams' ? 'border-l border-input' : ''}`}
                      >
                        {m.label}
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
