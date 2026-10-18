import { CalendarRange } from 'lucide-react';
import { WINDOW_CHOICES } from './createdWindow';

/**
 * Toolbar date window (QA 10-16 #7): 7d · 30d · 90d · All, one small segmented
 * group beside the layout switch. Picking one becomes the person's default.
 * Finished tickets older than the window are hidden; open work always shows.
 */
export default function CreatedWindowControl({ value, custom = false, searching = false, onPick, className = '' }) {
  const hint = 'Created in the last… Finished tickets older than this are hidden; tickets still being worked always show.';
  return (
    <div
      className={`items-stretch rounded-lg border border-input bg-card overflow-hidden ${searching ? 'opacity-70' : ''} ${className}`}
      role="group"
      aria-label="Created in the last"
      title={searching ? 'A search looks at every date' : hint}
      data-testid="created-window"
    >
      <CalendarRange className="ml-2 mr-0.5 h-4 w-4 flex-shrink-0 self-center text-muted-foreground/75" aria-hidden="true" />
      {WINDOW_CHOICES.map((c) => {
        const on = !custom && value === c.key;
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onPick?.(c.key)}
            aria-pressed={on}
            aria-label={c.label}
            title={c.key === 'all' ? 'Every ticket, whatever its age' : `Created in the last ${c.label} (open work always shows)`}
            className={`tp-focus-ring inline-flex items-center px-2 py-1.5 text-xs font-semibold tabular-nums transition-colors ${on ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300' : 'text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted/50'}`}
          >
            {c.short}
          </button>
        );
      })}
      {(custom || searching) && (
        <span className="inline-flex items-center px-2 text-xs text-muted-foreground" data-testid="created-window-note">
          {custom ? 'Custom dates' : 'All dates'}
        </span>
      )}
    </div>
  );
}
