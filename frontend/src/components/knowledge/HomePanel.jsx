import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, NotebookPen, Plus, Search } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import { timeAgo } from '../tickets/ticketUi';
import { Loading } from './knowledgeUi';
import { KIND, categoryLine, impactWords, levelWord } from './inboxFormat';
import { levelLabel } from './answeringFormat';

/**
 * Knowledge → Home (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 12): what waits
 * for me, and how the categories I know are doing. Team-safe: a person sees
 * their own items and their own categories, never a ranking of people.
 */
function Action({ to, icon: Icon, title, children }) {
  return (
    <Link to={to} className="tp-focus-ring tp-card flex items-start gap-3 p-4 transition-shadow hover:shadow-soft">
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{children}</span>
      </span>
    </Link>
  );
}

export default function HomePanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    knowledgeAPI.home()
      .then((res) => { if (!cancelled) setData(res?.data || null); })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load Knowledge'); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>;
  if (!data) return <Loading label="Loading…" />;
  const items = data.inbox?.items || [];
  const waiting = data.inbox?.counts?.categories || 0;
  const cats = data.categories || [];
  const canAdd = data.rights?.canPropose === true || data.rights?.isAdmin === true;

  return (
    <div className="space-y-6" data-testid="knowledge-home">
      <div className="grid gap-3 sm:grid-cols-3">
        <Action to="/knowledge/library" icon={Search} title="Find an answer">Search the Library or browse it by category.</Action>
        {canAdd && <Action to="/knowledge/articles/from-notes" icon={NotebookPen} title="Add from rough notes">Paste what you know; it is tidied into an article for you to check.</Action>}
        {data.rights?.canWriteSomewhere && <Action to="/knowledge/articles/new" icon={Plus} title="Write an article">Start from a blank page in a category you know.</Action>}
      </div>

      <section aria-labelledby="home-inbox">
        <div className="mb-2 flex items-baseline gap-3">
          <h2 id="home-inbox" className="text-sm font-semibold text-foreground">Waiting for you</h2>
          {waiting > 0 && <Link to="/knowledge/inbox" className="tp-focus-ring inline-flex items-center gap-1 rounded text-xs font-medium text-primary hover:underline">All {waiting} <ArrowRight className="h-3 w-3" aria-hidden="true" /></Link>}
        </div>
        {items.length === 0 ? (
          <p className="tp-card px-4 py-4 text-sm text-muted-foreground" data-testid="home-inbox-empty">Nothing right now. Drafts to check, flags and suggestions for your categories show up here.</p>
        ) : (
          <ul className="tp-card divide-y divide-border/60 overflow-hidden" data-testid="home-inbox-list">
            {items.map((it) => {
              const k = KIND[it.kind] || KIND.flag;
              return (
                <li key={it.id}>
                  <Link to={`/knowledge/inbox/${it.id}`} className="tp-focus-ring flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-3 hover:bg-muted/60">
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={`h-1.5 w-1.5 rounded-full ${k.dot}`} aria-hidden="true" />{k.label}
                    </span>
                    <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{it.title}</span>
                    <span className="text-xs text-muted-foreground">{[impactWords(it), timeAgo(it.createdAt)].filter(Boolean).join(' · ')}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="home-categories">
        <h2 id="home-categories" className="mb-2 text-sm font-semibold text-foreground">{data.rights?.isAdmin ? 'Categories' : 'Your categories'}</h2>
        {cats.length === 0 ? (
          <p className="tp-card px-4 py-4 text-sm text-muted-foreground" data-testid="home-categories-empty">
            You have no skill recorded in a category yet, so there is nothing to keep here. Everyone can still read the Library and flag an article that is wrong.
          </p>
        ) : (
          <ul className="tp-card divide-y divide-border/60 overflow-hidden" data-testid="home-categories-list">
            {cats.map((c) => (
              <li key={c.id}>
                <Link to={`/knowledge/library?c=${c.id}`} className="tp-focus-ring flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-3 hover:bg-muted/60">
                  <span className="text-sm font-medium text-foreground">{c.name}</span>
                  {levelWord(c.level) && <span className="text-xs text-muted-foreground">{levelWord(c.level)}</span>}
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground sm:text-right">{categoryLine(c)}</span>
                  <span className="hidden w-32 text-right text-xs text-muted-foreground lg:block" title="What Auto-help may do with an answer here during business hours">{levelLabel(c.dayLevel)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
