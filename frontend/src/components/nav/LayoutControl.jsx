import { Maximize2, MoveHorizontal, Square } from 'lucide-react';
import { cn } from '../../lib/utils';
import { LAYOUT_LABELS, useLayoutWidth } from '../../contexts/LayoutContext';

export const LAYOUT_CHOICES = [
  { value: 'full', Icon: Maximize2 },
  { value: 'comfortable', Icon: MoveHorizontal },
  { value: 'classic', Icon: Square },
];

/**
 * Three-way layout width segment (full-width train, 16 Sep 2026). Sits under
 * the theme segment in the account menu; applies immediately, keeps the menu
 * open so the person can compare. Same roles convention as ThemeControl.
 */
export default function LayoutControl({ itemRole = 'menuitemradio', className = '' }) {
  const { width, setWidth } = useLayoutWidth();
  const groupRole = itemRole === 'radio' ? 'radiogroup' : 'group';
  return (
    <div className={cn('px-3 py-2', className)} data-testid="layout-control">
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Page width</p>
      <div role={groupRole} aria-label="Page width" className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5">
        {LAYOUT_CHOICES.map(({ value, Icon }) => {
          const checked = width === value;
          return (
            <button
              key={value}
              type="button"
              role={itemRole}
              aria-checked={checked}
              title={LAYOUT_LABELS[value].hint}
              onClick={() => setWidth(value)}
              className={cn(
                'tp-focus-ring inline-flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-semibold transition-colors',
                checked ? 'bg-card text-foreground shadow-subtle' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {LAYOUT_LABELS[value].label.replace(' width', '')}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{LAYOUT_LABELS[width]?.hint}</p>
    </div>
  );
}
