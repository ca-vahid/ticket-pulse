import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, BookOpen } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import { healthOf } from '../knowledge/libraryFormat';

/**
 * "Knowledge" on the ticket (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 12),
 * where agents actually work:
 *   - one click to judge what Auto-help drafted for this ticket (Good /
 *     Partly / Wrong). That verdict is what lets a category earn its way
 *     from "Draft only" to answers that go out, and it lands on every
 *     article the draft quoted ("reuse is review");
 *   - the articles that fit this ticket, with how far each can be trusted.
 * Renders nothing when there is neither a draft to judge nor an article
 * that fits (most tickets), or when the read fails.
 */
const VERDICTS = [
  { value: 'good', label: 'Good', hint: 'I would have sent this' },
  { value: 'partial', label: 'Partly', hint: 'Useful, but something is missing or extra' },
  { value: 'wrong', label: 'Wrong', hint: 'It would have misled the requester' },
];
const VERDICT_WORD = { good: 'good', partial: 'partly right', wrong: 'wrong', should_not_answer: 'not something to answer' };

export default function TicketKnowledgeCard({ ticketId }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => Promise.resolve()
    .then(() => knowledgeAPI.ticketKnowledge(ticketId))
    .then((res) => setData(res?.data || null))
    .catch(() => setData(null)), [ticketId]);
  useEffect(() => { if (ticketId) load(); }, [ticketId, load]);

  if (!data) return null;
  const run = data.run;
  const drafted = run && ['drafted', 'staged', 'sent'].includes(run.status);
  const articles = data.articles || [];
  if (!drafted && !articles.length) return null;

  const judge = async (verdict) => {
    setBusy(true);
    setError(null);
    try {
      const res = await knowledgeAPI.reviewRun(run.id, { verdict });
      setData((prev) => ({ ...prev, run: { ...prev.run, ...(res?.data || {}), reviewVerdict: verdict } }));
    } catch (err) {
      setError(err?.message || 'Could not save that');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="tp-card mb-4 rounded-xl p-4" aria-label="Knowledge" data-testid="ticket-knowledge-card">
      <div className="flex items-center gap-2">
        <BookOpen className="h-4 w-4 text-primary" aria-hidden="true" />
        <h2 className="text-sm font-bold text-foreground">Knowledge</h2>
      </div>

      {drafted && (
        <div className="mt-2" data-testid="ticket-knowledge-verdict">
          {run.reviewVerdict ? (
            <p className="text-[13px] text-muted-foreground">
              The Auto-help draft was judged <span className="font-medium text-foreground">{VERDICT_WORD[run.reviewVerdict] || run.reviewVerdict}</span>.
              {data.canReview && (
                <button type="button" disabled={busy} onClick={() => setData((prev) => ({ ...prev, run: { ...prev.run, reviewVerdict: null } }))} className="tp-focus-ring ml-2 rounded text-xs font-medium text-primary hover:underline">Change</button>
              )}
            </p>
          ) : data.canReview ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-foreground/90">How was the Auto-help draft?</span>
              {VERDICTS.map((v) => (
                <button
                  key={v.value}
                  type="button"
                  disabled={busy}
                  title={v.hint}
                  onClick={() => judge(v.value)}
                  className="tp-focus-ring h-7 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
                >
                  {v.label}
                </button>
              ))}
              <span className="text-xs text-muted-foreground">One click. It teaches Auto-help and checks the articles it used.</span>
            </div>
          ) : null}
          {error && <p className="mt-1 text-xs text-red-700 dark:text-red-300" role="alert">{error}</p>}
        </div>
      )}

      {articles.length > 0 && (
        <div className="mt-3" data-testid="ticket-knowledge-articles">
          <p className="text-xs font-medium text-muted-foreground">Articles that fit this ticket</p>
          <ul className="mt-1 divide-y divide-border/60">
            {articles.map((a) => {
              const h = healthOf({ health: a.stale ? 'out_of_date' : a.confidence });
              return (
                <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
                  <Link to={`/knowledge/library/${a.id}`} target="_blank" rel="noreferrer" className="tp-focus-ring inline-flex min-w-0 items-center gap-1 rounded text-[13px] font-medium text-primary hover:underline">
                    <span className="truncate">{a.title}</span>
                    <ArrowUpRight className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                  </Link>
                  {a.section && <span className="text-xs text-muted-foreground">{a.section}</span>}
                  <span className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground" title={h.hint}>
                    <span className={`h-1.5 w-1.5 rounded-full ${h.dot}`} aria-hidden="true" />{h.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
