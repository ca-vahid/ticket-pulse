import { Ban, MonitorCog, Sparkles } from 'lucide-react';
import { cn } from '../../lib/utils';
import { MOTION_LABELS, useMotionMode } from '../../utils/motionPreference';

export const MOTION_CHOICES = [
  { value: 'on', Icon: Sparkles },
  { value: 'system', Icon: MonitorCog },
  { value: 'off', Icon: Ban },
];

/**
 * Motion segment (16 Sep 2026): On (default) / System / Off. Sits under the
 * page-width segment in the account menu; applies immediately and keeps the
 * menu open. Same roles convention as ThemeControl / LayoutControl.
 */
export default function MotionControl({ itemRole = 'menuitemradio', className = '' }) {
  const { mode, setMode } = useMotionMode();
  const groupRole = itemRole === 'radio' ? 'radiogroup' : 'group';
  return (
    <div className={cn('px-3 py-2', className)} data-testid="motion-control">
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Motion</p>
      <div role={groupRole} aria-label="Motion" className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5">
        {MOTION_CHOICES.map(({ value, Icon }) => {
          const checked = mode === value;
          return (
            <button
              key={value}
              type="button"
              role={itemRole}
              aria-checked={checked}
              title={MOTION_LABELS[value].hint}
              onClick={() => setMode(value)}
              className={cn(
                'tp-focus-ring inline-flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-semibold transition-colors',
                checked ? 'bg-card text-foreground shadow-subtle' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {MOTION_LABELS[value].label}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{MOTION_LABELS[mode]?.hint}</p>
    </div>
  );
}
