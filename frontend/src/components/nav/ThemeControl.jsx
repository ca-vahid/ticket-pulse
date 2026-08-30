import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useTheme } from '../../contexts/ThemeContext';

// Sun / Moon / Monitor = Light / Dark / System, in that order (the two
// explicit choices first, "follow the OS" last).
export const THEME_CHOICES = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

export const THEME_EARLY_ACCESS_NOTE = 'Early access — some screens are still light.';

/**
 * Three-way theme segment (Phase DM-A). Lives inside the account menu
 * (AppHeader) and the phone "More" sheet (MobileTabBar); selecting a choice
 * applies it immediately and deliberately does NOT close the menu, so the
 * user can compare and settle. `itemRole` follows the host: 'menuitemradio'
 * inside a role="menu", 'radio' inside the dialog sheet.
 */
export default function ThemeControl({ itemRole = 'menuitemradio', className = '' }) {
  const { theme, setTheme } = useTheme();
  const groupRole = itemRole === 'radio' ? 'radiogroup' : 'group';
  return (
    <div className={cn('px-3 py-2', className)} data-testid="theme-control">
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Theme</p>
      <div role={groupRole} aria-label="Theme" className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5">
        {THEME_CHOICES.map(({ value, label, Icon }) => {
          const checked = theme === value;
          return (
            <button
              key={value}
              type="button"
              role={itemRole}
              aria-checked={checked}
              onClick={() => setTheme(value)}
              className={cn(
                'tp-focus-ring inline-flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-semibold transition-colors',
                checked
                  ? 'bg-card text-foreground shadow-subtle'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{THEME_EARLY_ACCESS_NOTE}</p>
    </div>
  );
}
