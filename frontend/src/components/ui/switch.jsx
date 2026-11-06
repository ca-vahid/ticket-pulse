import * as React from 'react';
import * as SwitchPrimitives from '@radix-ui/react-switch';
import { cn } from '../../lib/utils';

/**
 * THE app switch (QA 11-05 #1: one on colour, one off colour, one size).
 *
 * - `<button role="switch" aria-checked>` (Radix), so a `<label htmlFor={id}>`
 *   toggles it too.
 * - h-5 w-9 track, card-coloured thumb.
 * - ON is the primary blue. OFF is a neutral track that keeps 3:1 against the
 *   card and the muted panels in BOTH themes (WCAG 1.4.11): muted-foreground at
 *   full strength in light (4.7:1 on white), 70% in dark (4.3:1 on the card).
 * - The thumb glides 0.2 s, and stands still under the app's Motion setting
 *   (`html[data-motion="reduce"]`). No colour transition: it would fight the
 *   light/dark swap.
 *
 * Meaning that used to ride on a switch colour (risky, live, writes to
 * FreshService) goes in words next to the label instead: see <SwitchCue>.
 */
const Switch = React.forwardRef(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      'tp-focus-ring peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full',
      'data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted-foreground dark:data-[state=unchecked]:bg-muted-foreground/70',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        'pointer-events-none block h-4 w-4 rounded-full bg-card shadow-sm ring-0',
        'transition-transform duration-200 ease-out motion-off:transition-none',
        'data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-0.5',
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

/**
 * A short plain-words cue beside a switch label — "Writes to FreshService",
 * "Sends e-mail", "Live", "Shadow". Neutral text with an icon, never a pill
 * and never a colour that competes with the switch.
 */
function SwitchCue({ icon: Icon = null, children, className }) {
  return (
    <span className={cn('inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground', className)}>
      {Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />}
      {children}
    </span>
  );
}

/**
 * The settings row: label + description on the left, the switch on the right.
 * The label is a real <label> for the switch, so clicking the words toggles it.
 * `cue` renders next to the label (a <SwitchCue> or plain text).
 */
function SwitchRow({
  id: idProp, label, description = null, cue = null, checked, onCheckedChange, disabled = false,
  className, testId, switchProps = {}, children = null,
}) {
  const auto = React.useId();
  const id = idProp || `sw-${auto.replace(/:/g, '')}`;
  const hintId = description ? `${id}-hint` : undefined;
  return (
    <div className={cn('flex items-start justify-between gap-4 py-3', className)} data-testid={testId}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <label htmlFor={id} className={cn('text-sm font-medium text-foreground', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>{label}</label>
          {cue}
        </div>
        {description && <p id={hintId} className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        {children}
      </div>
      <Switch
        id={id}
        checked={checked === true}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-describedby={hintId}
        className="mt-0.5"
        {...switchProps}
      />
    </div>
  );
}

export { Switch, SwitchCue, SwitchRow };
