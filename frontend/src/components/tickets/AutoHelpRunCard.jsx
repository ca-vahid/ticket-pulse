import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, BookOpen, ChevronDown } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import { Confidence, DraftPreview, RunStatus } from '../knowledge/knowledgeUi';
import { readableReason } from '../knowledge/knowledgeFormat';

/**
 * "Auto-help (shadow)" on the ticket's AI & Routing tab: the newest
 * Auto-help run for this ticket — what it would have answered, how sure it
 * was, which playbook — with a link to the full run. Renders nothing when
 * there is no run (most tickets) or the viewer cannot read Knowledge.
 */
export default function AutoHelpRunCard({ ticketId }) {
  const [run, setRun] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!ticketId) return undefined;
    let cancelled = false;
    // Optional card: any failure (403 for agents, a partial api mock) = no card.
    Promise.resolve()
      .then(() => knowledgeAPI.ticketAutoHelp(ticketId))
      .then((res) => { if (!cancelled) setRun(res?.data || null); })
      .catch(() => { if (!cancelled) setRun(null); });
    return () => { cancelled = true; };
  }, [ticketId]);

  if (!run) return null;
  const drafted = run.status === 'drafted';

  return (
    <section className="tp-card mb-4 rounded-xl p-4" aria-label="Auto-help (shadow)" data-testid="auto-help-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <BookOpen className="h-4 w-4 text-primary" aria-hidden="true" />
        <h2 className="text-sm font-bold text-foreground">Auto-help <span className="font-normal text-muted-foreground">(shadow — not sent)</span></h2>
        <RunStatus status={run.status} />
        <Confidence value={run.confidence} min={run.minConfidence} />
        {run.id && (
          <Link to={`/knowledge/activity/${run.id}`} className="tp-focus-ring ml-auto inline-flex items-center gap-1 rounded text-xs font-medium text-primary hover:underline">
            Run details <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {run.playbookName ? `Playbook “${run.playbookName}”` : 'Playbook removed'}
        {!drafted && ` · ${run.status === 'failed' ? (run.error || 'the run failed') : (readableReason(run.transcript?.reason, run.sources) || 'the playbook stayed quiet')}`}
      </p>
      {drafted && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="tp-focus-ring mt-2 inline-flex items-center gap-1 rounded text-xs font-medium text-foreground/85 hover:text-foreground"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
            {open ? 'Hide the draft' : 'Show the draft'}
          </button>
          {open && <DraftPreview className="mt-2 animate-fadeIn" subject={run.draftSubject} html={run.draftHtml} />}
        </>
      )}
    </section>
  );
}
