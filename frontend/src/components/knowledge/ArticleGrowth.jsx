import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, ChevronRight, ExternalLink, Lock, Sparkles } from 'lucide-react';
import { knowledgeGrowthAPI } from '../../services/api';
import { timeAgo } from '../tickets/ticketUi';
import { agoWords } from './knowledgeFormat';
import { readableNotes } from './knowledgeGrowthFormat';

/**
 * Knowledge that grows (Auto-help P1) — the article-side pieces:
 *   DraftedFromBanner    on an article drafted from solved tickets
 *   FsSourceNote         on a read-only FreshService-imported article
 *   ReviewDigestLine     "3 of your articles are due for review" (Articles tab)
 * (The FreshService import and the review e-mail switch live on Knowledge →
 * Settings: KnowledgeSourcesSettings.jsx.)
 */

export function DraftedFromBanner({ article }) {
  const from = article?.sourceMeta?.draftedFrom;
  if (!from || !Array.isArray(from.ticketIds) || !from.ticketIds.length) return null;
  const n = from.ticketIds.length;
  const refs = Array.isArray(from.ticketRefs) ? from.ticketRefs : [];
  const published = article.status === 'published';
  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
      role="note"
      data-testid="drafted-from-banner"
    >
      <p className="flex items-start gap-2 text-sm font-medium">
        <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <span>
          {published
            ? `Drafted from ${n} ticket${n === 1 ? '' : 's'} and published — keep checking it against how the team solves these.`
            : `Drafted from ${n} ticket${n === 1 ? '' : 's'} — check every step before publishing.`}
        </span>
      </p>
      <p className="mt-1 pl-6 text-xs text-amber-800/90 dark:text-amber-200/80">
        {from.kind === 'promote' ? 'From the verified solution on ' : 'Sources: '}
        {from.ticketIds.slice(0, 6).map((id, i) => (
          <span key={id}>
            {i > 0 && ', '}
            <Link to={`/tickets/${id}`} className="tp-focus-ring rounded underline decoration-amber-400/60 underline-offset-2 hover:decoration-current">{refs[i] || `#${id}`}</Link>
          </span>
        ))}
        {n > 6 ? ` and ${n - 6} more` : ''}
        {from.drafter === 'prefill' ? ' · pre-filled without AI (rewrite it as steps)' : ''}
        {from.at ? ` · ${timeAgo(from.at)}` : ''}
      </p>
      {from.reviewerNotes && (
        <p className="mt-1 pl-6 text-xs text-amber-800/90 dark:text-amber-200/80" data-testid="reviewer-notes">
          <span className="font-medium">To check:</span> {readableNotes(from.reviewerNotes)}
        </p>
      )}
    </div>
  );
}

export function FsSourceNote({ article }) {
  if (article?.source !== 'fs_solution') return null;
  const url = article.sourceMeta?.url || null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-testid="fs-source-note">
      <Lock className="h-3.5 w-3.5" aria-hidden="true" />
      <span>Imported from FreshService{article.fsUpdatedAt ? ` · changed there ${agoWords(article.fsUpdatedAt)}` : ''}. Read-only here; the nightly import brings changes in.</span>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="tp-focus-ring inline-flex items-center gap-1 rounded font-medium text-primary hover:underline">
          Edit in FreshService <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      )}
    </p>
  );
}

/** The signed-in person's own articles past their review date (in-app digest). */
export function ReviewDigestLine() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    knowledgeGrowthAPI.reviewDigest()
      .then((res) => { if (!cancelled) setData(res?.data || null); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, []);
  if (!data?.count) return null;
  return (
    <div className="px-1" data-testid="review-digest">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="tp-focus-ring inline-flex items-center gap-1.5 rounded text-xs font-medium text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
      >
        <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />
        {data.count === 1 ? 'One article you own is due for review' : `${data.count} articles you own are due for review`}
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="mt-2 space-y-2 pl-5 animate-fadeIn">
          {data.groups.map((g) => (
            <div key={g.category}>
              <p className="text-[11px] font-medium text-muted-foreground">{g.category}</p>
              <ul className="mt-0.5 space-y-0.5">
                {g.articles.map((a) => (
                  <li key={a.id} className="flex items-baseline gap-2 text-xs">
                    <Link to={`/knowledge/articles/${a.id}`} className="tp-focus-ring min-w-0 truncate rounded text-foreground/85 hover:text-primary hover:underline">{a.title}</Link>
                    {a.daysOverdue ? <span className="flex-shrink-0 tabular-nums text-muted-foreground/75">{a.daysOverdue} d overdue</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground/75">Open one, check the steps still work, then Mark as verified.</p>
        </div>
      )}
    </div>
  );
}
