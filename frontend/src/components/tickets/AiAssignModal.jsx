import { useEffect, useState, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertTriangle, ExternalLink, FileText, Hand, Loader2, Sparkles, X } from 'lucide-react';
import LivePipelineView, { RecommendationCards } from '../assignment/LivePipelineView';
import { assignmentAPI } from '../../services/api';

/**
 * "Let AI assign" host for the ticket surfaces. Leads with the ranked
 * recommendation list (the same RecommendationCards the Assignment Review page
 * uses) — approve / pick another / reject inline — instead of the raw analysis
 * transcript. The transcript is available on demand ("View AI analysis"), and
 * when there's no run yet (or it's still running) it streams the pipeline live.
 */
export default function AiAssignModal({ ticket, onClose, onDone }) {
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const [run, setRun] = useState(null);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState(null);
  const [view, setView] = useState('cards'); // 'cards' | 'live'

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await assignmentAPI.getLatestRunForTicket(ticket.id);
      const r = res?.data || null;
      setRun(r);
      // Lead with cards when we have a finished recommendation; otherwise stream.
      setView(r && r.status === 'completed' && r.recommendation ? 'cards' : 'live');
    } catch {
      setRun(null);
      setView('live');
    }
    setLoading(false);
  }, [ticket.id]);
  useEffect(() => { load(); }, [load]);

  const handleDecide = async (decisionData) => {
    if (!run?.id) return;
    setDeciding(true);
    setError(null);
    try {
      await assignmentAPI.decide(run.id, decisionData);
      // Hand the decision to the host page: decide returns BEFORE the FS
      // write-back lands, so a plain refetch would still show the old
      // assignee — the host needs the chosen tech to update its row now.
      onDone?.(decisionData);
      onClose();
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Decision failed');
      setDeciding(false);
    }
  };

  if (!ticket) return null;

  const rec = run?.recommendation;
  const hasCards = run && run.status === 'completed' && rec;
  const isQueued = run && run.status === 'queued';
  const pending = run?.decision === 'pending_review';
  const decidedLabel = run?.decision && run.decision !== 'pending_review' ? run.decision.replace(/_/g, ' ') : null;
  // Already-assigned guard: if the ticket already has an owner (assigned in FS or
  // TP), approving the suggestion would REASSIGN it. Surface that clearly instead
  // of presenting a plain "Approve" as if it were an open decision.
  const assigneeName = ticket.assignedTech?.name || null;
  const alreadyAssigned = Boolean(ticket.assignedTechId);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`AI assignment for ${ticket.displayRef || `ticket ${ticket.id}`}`}
    >
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px] animate-fadeIn cursor-default"
      />
      <div className="relative w-full max-w-4xl max-h-[88vh] flex flex-col tp-card rounded-2xl shadow-soft overflow-hidden animate-scaleIn">
        <header className="flex items-center gap-3 px-4 sm:px-5 py-3 border-b border-border/60 bg-gradient-to-r from-indigo-50/80 dark:from-indigo-500/10 via-card to-card">
          <span className="h-8 w-8 rounded-lg bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 inline-flex items-center justify-center flex-shrink-0">
            <Sparkles className="w-4 h-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold text-foreground leading-tight">
              AI recommendation{decidedLabel ? ` · ${decidedLabel}` : ''}
            </h2>
            <p className="text-xs text-muted-foreground/75 truncate">
              <span className="font-mono">{ticket.displayRef || `#${ticket.freshserviceTicketId || ticket.id}`}</span>
              {ticket.subject ? ` · ${ticket.subject}` : ''}
            </p>
          </div>
          {/* Recommendation ⇄ Analysis toggle (only when a finished run exists) */}
          {hasCards && (
            <div className="hidden sm:flex items-center rounded-lg border border-border overflow-hidden text-xs font-medium">
              <button
                onClick={() => setView('cards')}
                className={`px-2.5 py-1 ${view === 'cards' ? 'bg-indigo-600 text-white' : 'text-muted-foreground hover:bg-muted/50'}`}
              >
                Recommendation
              </button>
              <button
                onClick={() => setView('live')}
                className={`px-2.5 py-1 border-l border-border inline-flex items-center gap-1 ${view === 'live' ? 'bg-indigo-600 text-white' : 'text-muted-foreground hover:bg-muted/50'}`}
              >
                <FileText className="w-3 h-3" aria-hidden="true" /> Analysis
              </button>
            </div>
          )}
          <Link
            to={`/assignments/live/${ticket.id}`}
            state={{ returnTo: location.pathname + location.search }}
            className="tp-focus-ring hidden md:inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-300 hover:underline rounded whitespace-nowrap"
          >
            <ExternalLink className="w-3 h-3" aria-hidden="true" /> Full page
          </Link>
          <button
            onClick={onClose}
            aria-label="Close AI assignment"
            className="tp-focus-ring p-1.5 rounded-lg text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto settings-scrollbar p-4 sm:p-5">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground/75">
              <Loader2 className="w-6 h-6 animate-spin" aria-hidden="true" />
            </div>
          ) : isQueued && view === 'cards' ? (
            <div className="bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30 rounded-xl p-6 text-center">
              <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto mb-2" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-200 mb-1">Queued until the next business window</h3>
              <p className="text-sm text-amber-700 dark:text-amber-200">{run.queuedReason || 'Currently outside business hours.'}</p>
              <p className="text-xs text-muted-foreground mt-2">It processes automatically when business hours resume — or open the full page to run it now.</p>
            </div>
          ) : hasCards && view === 'cards' ? (
            <>
              {!pending && (
                <div className="mb-3 text-xs text-muted-foreground bg-muted/50 border border-border rounded-lg px-3 py-2">
                  This run was already <span className="font-semibold">{decidedLabel}</span>. The ranked candidates below are read-only — use the full page to re-open or re-run.
                </div>
              )}
              {pending && alreadyAssigned && (
                <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-3 py-2.5">
                  <Hand className="w-4 h-4 text-amber-600 dark:text-amber-300 flex-shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="text-xs text-amber-800 dark:text-amber-200">
                    <span className="font-semibold">Already assigned{assigneeName ? ` to ${assigneeName}` : ''} — handled outside this run.</span>{' '}
                    Ticket Pulse leaves assigned tickets untouched. The suggestion below is informational; approving it would <span className="font-semibold">reassign</span> the ticket.
                  </div>
                </div>
              )}
              <RecommendationCards
                data={rec}
                onDecide={pending ? handleDecide : null}
                deciding={deciding}
                decision={run.decision}
                currentAssignedTechId={ticket.assignedTechId || null}
                reassignWarnName={pending && alreadyAssigned ? (assigneeName || 'someone else') : null}
              />
            </>
          ) : (
            // no run yet, running, or "Analysis" view → stream / show transcript
            <LivePipelineView
              ticketId={ticket.id}
              onComplete={() => { onDone?.(); onClose(); }}
            />
          )}
          {error && (
            <div className="mt-3 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg p-3 text-sm text-red-700 dark:text-red-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden="true" /> {error}
            </div>
          )}
        </div>

        <p className="px-5 pb-3 text-[10px] text-muted-foreground/75">
          Approving assigns in FreshService and Ticket Pulse. Closing while an analysis is streaming cancels that run.
        </p>
      </div>
    </div>
  );
}
