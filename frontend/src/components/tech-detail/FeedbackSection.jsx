import { useMemo } from 'react';
import { MessageSquareHeart } from 'lucide-react';

const EMOJI = ['😞', '😕', '😐', '🙂', '😄'];
const COLORS = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981'];

function scoreMeta(score) {
  const i = Math.min(Math.max((score || 3) - 1, 0), 4);
  return { emoji: EMOJI[i], color: COLORS[i] };
}

function StatTile({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-bold text-slate-900">{value}</div>
      {hint && <div className="text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

/**
 * Per-technician first-party feedback (1-5 + comments). Coaching / team-balance
 * signal — never framed as a leaderboard. Sample size (N) is always shown.
 */
export default function FeedbackSection({ feedbackTickets = [], stats = {}, isLoading = false }) {
  const sorted = useMemo(() => [...feedbackTickets].sort((a, b) => {
    const as = a.feedback?.score ?? 9;
    const bs = b.feedback?.score ?? 9;
    if (as !== bs) return as - bs; // lowest scores first (where coaching helps)
    return new Date(b.feedback?.submittedAt || 0) - new Date(a.feedback?.submittedAt || 0);
  }), [feedbackTickets]);

  const total = stats.totalFeedback ?? feedbackTickets.length;

  if (isLoading) {
    return <div className="py-12 text-center text-sm text-slate-500">Loading feedback…</div>;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Responses" value={total} hint="all-time" />
        <StatTile label="Satisfied (top-2-box)" value={stats.topTwoBoxPct != null ? `${stats.topTwoBoxPct}%` : '—'} hint={`${stats.topTwoBoxCount ?? 0} of ${total}`} />
        <StatTile label="Average" value={stats.averageScore != null ? `${stats.averageScore} / 5` : '—'} hint={stats.averageNormalized != null ? `${stats.averageNormalized}% normalized` : ''} />
      </div>

      <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
        Direct first-party feedback from requesters after resolution. Use it as a coaching and team-balance
        signal — not a leaderboard. Sample size (N) is always shown.
      </p>

      {total === 0 ? (
        <div className="rounded-xl border border-slate-100 bg-slate-50 py-12 text-center">
          <MessageSquareHeart className="mx-auto mb-2 h-8 w-8 text-slate-200" />
          <p className="text-sm text-slate-500">No first-party feedback yet for this technician.</p>
          <p className="mt-0.5 text-xs text-slate-400">Enable the “Give feedback” link on your resolved-ticket workflow to start collecting it.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {sorted.map((t) => {
            const m = scoreMeta(t.feedback?.score);
            return (
              <div key={t.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-400">#{t.freshserviceTicketId}</span>
                  <span className="text-xs text-slate-400">
                    {t.feedback?.submittedAt ? new Date(t.feedback.submittedAt).toLocaleDateString() : ''}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-2xl">{m.emoji}</span>
                  <span className="text-sm font-bold" style={{ color: m.color }}>{t.feedback?.score}/5</span>
                </div>
                {t.subject && (
                  <div className="mt-1 truncate text-sm font-medium text-slate-700" title={t.subject}>{t.subject}</div>
                )}
                {t.feedback?.comment && (
                  <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm italic text-slate-600">“{t.feedback.comment}”</p>
                )}
                {(t.requesterName || t.requesterEmail) && (
                  <div className="mt-2 text-xs text-slate-400">{t.requesterName || t.requesterEmail}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
