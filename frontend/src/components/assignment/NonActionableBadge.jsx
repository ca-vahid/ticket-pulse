import { Info } from 'lucide-react';

/**
 * "The AI thinks this needs no follow-up" — shown NEXT TO a real routing
 * recommendation (QA 09-05, Accounting option 3).
 *
 * Before this, a noise verdict and a recommendation were the same field: the
 * model said "noise" by returning nothing, so it could never say "this looks
 * non-actionable, but if I'm wrong here's who should have it". In workspaces
 * that don't auto-close, it now says both — and this badge is the half a
 * coordinator reads. Deliberately informational, not alarming: being wrong
 * here costs a label, and the routing underneath is still good.
 */
export default function NonActionableBadge({ recommendation, className = '' }) {
  if (!recommendation?.nonActionable) return null;
  const reason = String(recommendation.nonActionableReason || '').trim();

  return (
    <div
      className={`rounded-xl border border-sky-200 dark:border-sky-500/30 bg-sky-50 dark:bg-sky-500/10 p-3 ${className}`}
      data-testid="non-actionable-badge"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-sky-100 dark:bg-sky-500/20">
          <Info className="h-3 w-3 text-sky-700 dark:text-sky-200" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-sky-900 dark:text-sky-100">
            The AI thinks this ticket needs no follow-up
          </p>
          {reason && <p className="mt-0.5 text-[11px] text-sky-800/90 dark:text-sky-200/90">{reason}</p>}
          <p className="mt-1 text-[11px] text-sky-800/75 dark:text-sky-200/75">
            It still routed the ticket, so you can disagree without losing the recommendation.
            Nothing was closed or dismissed.
          </p>
        </div>
      </div>
    </div>
  );
}
