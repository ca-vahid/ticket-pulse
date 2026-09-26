import { useState } from 'react';
import { ArrowRight, Hand, Plus, X } from 'lucide-react';
import { MAX_STAY_QUIET, MAX_STAY_QUIET_CHARS, mergeConditions } from './stayQuietFormat';
import { GuardedLink } from './knowledgeUi';

/**
 * "Stay quiet when" (26 Sep 2026): real rules, at two levels. The workspace
 * list (Knowledge → Settings) applies to every playbook; each playbook adds
 * its own. The runner gives both to the model as numbered hard stops; a run
 * that hits one ends "Stayed quiet: <condition>" and a person picks it up.
 */

/** An editable list of conditions: one per row, × removes, Enter adds. */
export function StayQuietList({
  values = [], onChange, readOnly = false, label, placeholder = 'Add a condition and press Enter…', testId = undefined, emptyText = 'None yet.',
  alsoIn = [],
}) {
  const shared = new Set((alsoIn || []).map((x) => String(x).toLowerCase()));
  const [draft, setDraft] = useState('');
  const add = () => {
    const next = mergeConditions(values, [draft]).slice(0, MAX_STAY_QUIET);
    if (next.length !== values.length) onChange(next);
    setDraft('');
  };
  return (
    <div data-testid={testId}>
      {values.length ? (
        <ul className="space-y-1" aria-label={label}>
          {values.map((v, i) => (
            <li key={`${v}-${i}`} className="group flex items-start gap-2 rounded-md py-0.5 pl-1 text-[13px] leading-relaxed text-foreground/90">
              <span className="mt-[0.55rem] h-1.5 w-1.5 flex-shrink-0 rounded-full bg-blue-400 dark:bg-blue-300" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                {v}
                {shared.has(String(v).toLowerCase()) && <span className="ml-1.5 whitespace-nowrap text-[11px] text-muted-foreground">· also workspace-wide</span>}
              </span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => onChange(values.filter((_, j) => j !== i))}
                  aria-label={`Remove “${v}”`}
                  className="tp-focus-ring inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-70 hover:bg-card hover:text-foreground group-hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="pl-1 text-[13px] text-muted-foreground">{emptyText}</p>
      )}
      {!readOnly && values.length < MAX_STAY_QUIET && (
        <div className="mt-2 flex gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            maxLength={MAX_STAY_QUIET_CHARS}
            placeholder={placeholder}
            aria-label={`Add to ${label || 'the list'}`}
            className="tp-focus-ring h-9 min-w-0 flex-1 rounded-lg border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground/75"
          />
          <button
            type="button"
            onClick={add}
            disabled={!draft.trim()}
            className="tp-focus-ring inline-flex h-9 flex-shrink-0 items-center gap-1 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> Add
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The highlighted panel beside the playbook's instructions: this playbook's
 * list (editable) and the workspace's (read-only here, edited in Settings).
 */
export function StayQuietPanel({ values = [], onChange, workspaceList = [], readOnly = false }) {
  return (
    <aside
      className="rounded-xl border border-blue-200/80 bg-blue-50/60 p-3.5 dark:border-blue-400/25 dark:bg-blue-500/10"
      aria-labelledby="pb-stay-quiet-title"
      data-testid="stay-quiet-panel"
    >
      <h3 id="pb-stay-quiet-title" className="flex items-center gap-2 text-sm font-semibold text-blue-800 dark:text-blue-100">
        <Hand className="h-4 w-4" aria-hidden="true" /> Stay quiet when
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-blue-900/75 dark:text-blue-100/75">
        Hard stops. If any of these applies, Auto-help does not answer and the ticket goes to a person.
      </p>
      <div className="mt-3">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-blue-900/70 dark:text-blue-100/70">This playbook</p>
        <StayQuietList
          values={values}
          onChange={onChange}
          readOnly={readOnly}
          label="Stay quiet when (this playbook)"
          placeholder="e.g. The app is not in Company Portal"
          testId="stay-quiet-playbook"
          emptyText="Nothing extra for this playbook."
          alsoIn={workspaceList}
        />
      </div>
      <div className="mt-3 border-t border-blue-200/70 pt-3 dark:border-blue-400/20" data-testid="stay-quiet-workspace">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-blue-900/70 dark:text-blue-100/70">Every playbook in this workspace</p>
        <StayQuietList values={workspaceList} readOnly label="Always stay quiet when (workspace)" emptyText="No workspace-wide conditions." />
        <GuardedLink to="/knowledge/settings" className="tp-focus-ring mt-1.5 inline-flex items-center gap-1 rounded text-xs font-medium text-blue-700 hover:underline dark:text-blue-200">
          Edit in Settings <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </GuardedLink>
      </div>
    </aside>
  );
}
