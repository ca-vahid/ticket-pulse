import { useState } from 'react';
import { ChevronDown, ListChecks, Loader2, MessageCircleQuestion, Sparkles, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';

/**
 * On-demand AI thread summary for the handling agent: a "Summarize" button
 * that expands into a compact card (what happened / where it stands / next
 * steps / open questions). Generated fresh each click, never stored — the
 * conversation below remains the source of truth.
 */
export default function ThreadSummaryCard({ ticketId }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [collapsed, setCollapsed] = useState(false);

  const generate = async () => {
    if (loading) return;
    setLoading(true); setError(null);
    try {
      const res = await ticketsAPI.summarize(ticketId);
      setSummary(res?.data || null);
      setCollapsed(false);
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Summary failed');
    }
    setLoading(false);
  };

  if (!summary) {
    return (
      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={generate}
          disabled={loading}
          className="tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/60 dark:bg-indigo-500/10 text-xs font-semibold text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/20 disabled:opacity-60"
          data-testid="summarize-button"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />}
          {loading ? 'Summarizing…' : 'Summarize thread'}
        </button>
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-xl border border-indigo-200 dark:border-indigo-500/30 bg-gradient-to-br from-indigo-50/70 dark:from-indigo-500/10 to-card p-3 animate-fadeIn" data-testid="thread-summary-card">
      <div className="flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" aria-hidden="true" />
        <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-300">AI thread summary</p>
        <span className="text-[10px] text-muted-foreground/75">{summary.entryCount} entries · not stored</span>
        <button
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? 'Expand summary' : 'Collapse summary'}
          className="tp-focus-ring ml-auto p-1 rounded text-muted-foreground/75 hover:bg-indigo-100/60 dark:hover:bg-indigo-500/15"
        >
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${collapsed ? '' : 'rotate-180'}`} aria-hidden="true" />
        </button>
        <button
          onClick={() => setSummary(null)}
          aria-label="Dismiss summary"
          className="tp-focus-ring p-1 rounded text-muted-foreground/75 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/15"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
      {!collapsed && (
        <div className="mt-2 space-y-2 text-sm text-foreground/85">
          <p>{summary.summary}</p>
          {summary.currentState && (
            <p className="text-xs font-medium text-indigo-800 dark:text-indigo-200 bg-indigo-100/50 dark:bg-indigo-500/15 rounded-md px-2.5 py-1.5">{summary.currentState}</p>
          )}
          {summary.nextSteps?.length > 0 && (
            <div>
              <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75 mb-1">
                <ListChecks className="w-3 h-3" aria-hidden="true" /> Suggested next steps
              </p>
              <ul className="space-y-0.5">
                {summary.nextSteps.map((step, i) => (
                  <li key={i} className="text-xs text-muted-foreground pl-3 relative before:content-['•'] before:absolute before:left-0 before:text-indigo-400">{step}</li>
                ))}
              </ul>
            </div>
          )}
          {summary.openQuestions?.length > 0 && (
            <div>
              <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75 mb-1">
                <MessageCircleQuestion className="w-3 h-3" aria-hidden="true" /> Open questions from the requester
              </p>
              <ul className="space-y-0.5">
                {summary.openQuestions.map((q, i) => (
                  <li key={i} className="text-xs text-muted-foreground pl-3 relative before:content-['•'] before:absolute before:left-0 before:text-amber-400">{q}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground/50">AI-generated from the thread — verify against the conversation below. {summary.model || ''}</p>
        </div>
      )}
    </div>
  );
}
