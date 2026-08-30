import { forwardRef, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Star } from 'lucide-react';
import { TicketRefLink, PersonAvatar } from '../tickets/ticketUi';

// ─────────────────────────────────────────────────────────────────────────────
// SatisfactionPanel — ONE satisfaction view replacing the old CSAT + Feedback
// tabs (an FS-vs-TP implementation detail the reader shouldn't have to know).
//
// Everything is normalized to /5: FreshService CSAT (usually /4) is scaled by
// 5/totalScore; Ticket Pulse first-party feedback is already /5. The merged
// average is weighted by response counts, and N is ALWAYS shown (binding
// product rule — never imply a survey rate is more reliable than its sample).
// Each response row carries a source chip (FreshService slate / Ticket Pulse
// sky).
// ─────────────────────────────────────────────────────────────────────────────

export function mergeSatisfaction(csatTickets = [], feedbackTickets = []) {
  const responses = [];

  for (const t of csatTickets) {
    if (t.csatScore == null) continue;
    const total = t.csatTotalScore || 4;
    responses.push({
      key: `fs-${t.id}`,
      source: 'freshservice',
      score5: (t.csatScore / total) * 5,
      rawLabel: `${t.csatScore}/${total}`,
      comment: t.csatFeedback || null,
      submittedAt: t.csatSubmittedAt || null,
      requesterName: t.requesterName || null,
      ticket: t,
    });
  }

  for (const t of feedbackTickets) {
    const score = t.feedback?.score;
    if (score == null) continue;
    responses.push({
      key: `tp-${t.id}`,
      source: 'ticketpulse',
      score5: score,
      rawLabel: `${score}/5`,
      comment: t.feedback?.comment || null,
      submittedAt: t.feedback?.submittedAt || null,
      requesterName: t.requesterName || null,
      ticket: t,
    });
  }

  responses.sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));

  const n = responses.length;
  const average = n ? responses.reduce((s, r) => s + r.score5, 0) / n : null;
  const fs = responses.filter((r) => r.source === 'freshservice');
  const tp = responses.filter((r) => r.source === 'ticketpulse');
  const avgOf = (list) => (list.length ? list.reduce((s, r) => s + r.score5, 0) / list.length : null);

  return {
    responses,
    count: n,
    average,
    fsCount: fs.length,
    fsAverage: avgOf(fs),
    tpCount: tp.length,
    tpAverage: avgOf(tp),
  };
}

function SourceChip({ source }) {
  return source === 'ticketpulse' ? (
    <span className="inline-flex items-center rounded-full border border-sky-200 dark:border-sky-500/30 bg-sky-50 dark:bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-200">
      Ticket Pulse
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
      FreshService
    </span>
  );
}

function scoreTone(score5) {
  if (score5 >= 4) return 'text-emerald-600 dark:text-emerald-300';
  if (score5 >= 3) return 'text-amber-600 dark:text-amber-300';
  return 'text-rose-600 dark:text-rose-300';
}

const INITIAL_VISIBLE = 6;

const SatisfactionPanel = forwardRef(function SatisfactionPanel(
  { csatTickets = [], feedbackTickets = [], isLoading = false, highlighted = false },
  ref,
) {
  const location = useLocation();
  // Return address so /tickets/:id's Back control comes back to this page.
  const backState = { from: `${location.pathname}${location.search}` };
  const merged = useMemo(
    () => mergeSatisfaction(csatTickets, feedbackTickets),
    [csatTickets, feedbackTickets],
  );
  const [showAll, setShowAll] = useState(false);

  const visible = showAll ? merged.responses : merged.responses.slice(0, INITIAL_VISIBLE);

  return (
    <section
      ref={ref}
      aria-label="Satisfaction"
      className={`tp-card rounded-xl p-4 transition-shadow ${highlighted ? 'ring-2 ring-blue-400' : ''}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/75">
            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" aria-hidden="true" />
            Satisfaction — one view
          </h3>
          {isLoading ? (
            <div className="mt-2 text-sm text-muted-foreground/75">Loading responses…</div>
          ) : merged.count === 0 ? (
            <div className="mt-2 text-sm text-muted-foreground/75">No satisfaction responses yet for this agent.</div>
          ) : (
            <div className="mt-1 flex items-baseline gap-2">
              <span className={`text-3xl font-extrabold tabular-nums ${scoreTone(merged.average)}`}>
                {merged.average.toFixed(1)}
              </span>
              <span className="text-sm text-muted-foreground/75">/ 5 · {merged.count} response{merged.count === 1 ? '' : 's'}</span>
            </div>
          )}
        </div>

        {merged.count > 0 && (
          <div className="space-y-1 text-xs">
            {merged.fsCount > 0 && (
              <div className="flex items-center justify-between gap-3">
                <SourceChip source="freshservice" />
                <span className="tabular-nums text-muted-foreground">{merged.fsCount} · avg {merged.fsAverage.toFixed(1)}/5</span>
              </div>
            )}
            {merged.tpCount > 0 && (
              <div className="flex items-center justify-between gap-3">
                <SourceChip source="ticketpulse" />
                <span className="tabular-nums text-muted-foreground">{merged.tpCount} · avg {merged.tpAverage.toFixed(1)}/5</span>
              </div>
            )}
          </div>
        )}
      </div>

      {merged.count > 0 && (
        <div className="mt-3 divide-y divide-border/60 border-t border-border/60">
          {visible.map((r) => (
            <div key={r.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
              <span className={`w-12 flex-shrink-0 text-sm font-bold tabular-nums ${scoreTone(r.score5)}`} title={`Original rating: ${r.rawLabel}`}>
                {Number.isInteger(r.score5) ? r.score5 : r.score5.toFixed(1)}<span className="text-[10px] font-medium text-muted-foreground/75">/5</span>
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <TicketRefLink ticket={r.ticket} state={backState} className="text-[11px]" />
                  <span className="min-w-0 truncate text-[12px] font-medium text-foreground/85" title={r.ticket.subject}>
                    {r.ticket.subject || ''}
                  </span>
                </div>
                {r.comment && (
                  <p className="mt-1 rounded-lg bg-muted/50 px-2.5 py-1.5 text-[12px] italic text-muted-foreground">
                    “{r.comment}”
                  </p>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground/75">
                  {r.requesterName && (
                    <span className="inline-flex items-center gap-1">
                      <PersonAvatar name={r.requesterName} size="h-4 w-4" textSize="text-[8px]" />
                      {r.requesterName}
                    </span>
                  )}
                  {r.submittedAt && <span>{new Date(r.submittedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>}
                </div>
              </div>
              <SourceChip source={r.source} />
            </div>
          ))}
          {merged.responses.length > INITIAL_VISIBLE && (
            <div className="pt-2 text-center">
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="tp-focus-ring rounded px-2 py-1 text-xs font-semibold text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-200"
              >
                {showAll ? 'Show fewer' : `Show all ${merged.responses.length} responses`}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
});

export default SatisfactionPanel;
