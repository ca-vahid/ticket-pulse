import { Children } from 'react';
import { Segmented } from '../availability/teamViews';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';

/**
 * One look for every Off / Shadow / Live switch on Assignment Review → Level
 * match (18 Nov 2026: "the double shadow mode with various styles of
 * shadow is confusing. Unify the look."). Level match and Time zone fit both
 * render through this frame:
 *
 *   icon + title                                  [ Off | Shadow | Live ]
 *   one line of help
 *   Shadow: <what this mode does>          ← one muted line, plain text
 *   Only an admin can change this. · Last changed … by …
 *   <recent results>                       ← children
 *
 * A reviewer sees the switch disabled; an admin can change it.
 */
const MODE_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'live', label: 'Live' },
];
const MODE_WORD = { off: 'Off', shadow: 'Shadow', live: 'Live' };

/** The marker after a ticket whose change was only recorded, never made. */
export function ShadowMark() {
  return <span className="text-muted-foreground"> (shadow)</span>;
}

/** The marker after a Live change that was not made, with the reason. */
export function NotAppliedMark({ reason }) {
  return <span className="text-muted-foreground"> (not applied: {reason})</span>;
}

/** A results heading inside a section ("Last 14 days", "Tickets") with optional controls on the right. */
export function ResultsHeading({ id, children, right = null }) {
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-3">
      <h4 id={id} className="mr-auto text-xs font-medium text-muted-foreground">{children}</h4>
      {right}
    </div>
  );
}

export default function ModeSwitchSection({
  id,
  icon: Icon,
  title,
  help,
  mode,
  notes,
  onChange,
  canManage = false,
  saving = false,
  saveError = null,
  updatedAt = null,
  updatedBy = null,
  neverChanged = null,
  footnote = null,
  workspaceTimezone = 'America/Vancouver',
  className = '',
  testId,
  children,
}) {
  const word = MODE_WORD[mode] || mode;
  return (
    <section aria-labelledby={`${id}-title`} data-testid={testId} className={className}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="mr-auto min-w-0 max-w-2xl">
          <h3 id={`${id}-title`} className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            {Icon ? <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> : null}
            {title}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{help}</p>
        </div>
        <Segmented
          label={`${title} mode`}
          value={mode}
          onChange={onChange}
          options={MODE_OPTIONS}
          disabled={!canManage || saving}
        />
      </div>

      <p className="mt-2 text-xs text-muted-foreground" data-testid={`${id}-status`}>
        <span className="font-medium text-foreground/85">{word}:</span> {notes?.[mode] || ''}
      </p>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {canManage ? null : <span>Only an admin can change this.</span>}
        {saving ? <span role="status">Saving…</span> : null}
        {saveError ? <span className="text-destructive" role="alert">{saveError}</span> : null}
        {updatedAt
          ? <span>Last changed {formatDateTimeInTimezone(updatedAt, workspaceTimezone)}{updatedBy ? ` by ${updatedBy}` : ''}.</span>
          : (neverChanged ? <span>{neverChanged}</span> : null)}
        {footnote ? <span>{footnote}</span> : null}
      </div>

      {Children.toArray(children).length ? <div className="mt-4 space-y-4">{children}</div> : null}
    </section>
  );
}
