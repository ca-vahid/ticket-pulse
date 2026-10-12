import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BookOpen, ChevronDown, ChevronRight, NotebookPen, Plus, Search, X } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import FancySelect from '../common/FancySelect';
import { timeAgo } from '../tickets/ticketUi';
import { EmptyState, Loading, PersonLine } from './knowledgeUi';
import { TabActions } from './builderUi';
import {
  HEALTH_FILTERS, countWords, healthOf, listRequests, mergeArticles, scopeTitle,
} from './libraryFormat';

/**
 * Knowledge → Library (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 12).
 * Articles are found by category or by searching, never as one flat list:
 * a category tree with counts on the left, the articles of the chosen
 * place on the right, search on top. The place, the filter and the search
 * live in the URL, so a link lands where you were.
 */
const PAGE = 50;

function Health({ article, className = '' }) {
  const h = healthOf(article);
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${className}`} title={h.hint}>
      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${h.dot}`} aria-hidden="true" />
      {h.label}
    </span>
  );
}

function TreeRow({ label, count, attention = 0, active, depth = 0, onClick, expander = null, testId }) {
  return (
    <div className={`flex items-center ${depth ? 'pl-5' : ''}`}>
      {expander || <span className="w-6 flex-shrink-0" aria-hidden="true" />}
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'true' : undefined}
        data-testid={testId}
        className={`tp-focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${active ? 'bg-primary/10 font-medium text-primary' : 'text-foreground/85 hover:bg-muted'}`}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {attention > 0 && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-500" title={`${attention} need${attention === 1 ? 's' : ''} attention`} aria-label={`${attention} need attention`} />}
        <span className={`flex-shrink-0 tabular-nums text-xs ${count ? 'text-muted-foreground' : 'text-muted-foreground/50'}`}>{count}</span>
      </button>
    </div>
  );
}

function Tree({ tree, scope, onPick }) {
  const [open, setOpen] = useState(() => new Set(scope.categoryId ? [Number(scope.categoryId)] : []));
  useEffect(() => {
    if (scope.categoryId) setOpen((prev) => (prev.has(Number(scope.categoryId)) ? prev : new Set([...prev, Number(scope.categoryId)])));
  }, [scope.categoryId]);
  const toggle = (id) => setOpen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const is = (s) => (s.view || 'all') === (scope.view || 'all') && Number(s.categoryId || 0) === Number(scope.categoryId || 0) && Number(s.subcategoryId || 0) === Number(scope.subcategoryId || 0);
  const total = (b) => (b?.articles || 0) + (b?.drafts || 0);
  return (
    <nav aria-label="Library" className="space-y-0.5" data-testid="library-tree">
      <TreeRow label="All articles" count={total(tree.totals)} active={is({})} onClick={() => onPick({})} testId="library-all" />
      <TreeRow label="Mine" count={total(tree.mine)} active={is({ view: 'mine' })} onClick={() => onPick({ view: 'mine' })} testId="library-mine" />
      <TreeRow label="Needs attention" count={tree.totals?.attention || 0} attention={tree.totals?.attention || 0} active={is({ view: 'attention' })} onClick={() => onPick({ view: 'attention' })} testId="library-attention" />
      <div className="my-2 border-t border-border" />
      {(tree.categories || []).map((cat) => {
        const hasSubs = (cat.subcategories || []).length > 0;
        const expanded = open.has(cat.id);
        return (
          <div key={cat.id}>
            <TreeRow
              label={cat.name}
              count={total(cat)}
              attention={cat.attention}
              active={is({ categoryId: cat.id })}
              onClick={() => { onPick({ categoryId: cat.id }); if (hasSubs && !expanded) toggle(cat.id); }}
              testId={`library-cat-${cat.id}`}
              expander={hasSubs ? (
                <button type="button" onClick={() => toggle(cat.id)} aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} the subcategories of ${cat.name}`} className="tp-focus-ring inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted">
                  {expanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
                </button>
              ) : null}
            />
            {expanded && cat.subcategories.map((sub) => (
              <TreeRow
                key={sub.id}
                depth={1}
                label={sub.name}
                count={total(sub)}
                attention={sub.attention}
                active={is({ categoryId: cat.id, subcategoryId: sub.id })}
                onClick={() => onPick({ categoryId: cat.id, subcategoryId: sub.id })}
                testId={`library-sub-${sub.id}`}
              />
            ))}
          </div>
        );
      })}
      {total(tree.uncategorised) > 0 && (
        <TreeRow label="No category yet" count={total(tree.uncategorised)} active={is({ view: 'none' })} onClick={() => onPick({ view: 'none' })} testId="library-none" />
      )}
    </nav>
  );
}

function ArticleRow({ article, categoryNames }) {
  const where = [categoryNames.get(article.categoryId), categoryNames.get(article.subcategoryId)].filter(Boolean).join(' › ');
  const quoted = Number(article.timesQuoted) || 0;
  return (
    <li>
      <Link
        to={`/knowledge/library/${article.id}`}
        className="tp-focus-ring block rounded-lg px-3 py-3 hover:bg-muted/60"
        data-testid={`library-article-${article.id}`}
      >
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="min-w-0 text-sm font-medium text-foreground">{article.title}</span>
          <Health article={article} className="text-xs text-muted-foreground" />
        </span>
        {article.snippet && <span className="mt-0.5 line-clamp-2 block text-[13px] leading-relaxed text-muted-foreground">{article.snippet}</span>}
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground/90">
          {where && <span className="truncate">{where}</span>}
          <span>{quoted ? `used in ${quoted} answer${quoted === 1 ? '' : 's'}` : 'not used yet'}</span>
          <span>changed {timeAgo(article.updatedAt)}</span>
          {article.ownerEmail && <PersonLine email={article.ownerEmail} className="text-xs" />}
        </span>
      </Link>
    </li>
  );
}

function SearchHit({ hit }) {
  return (
    <li>
      <Link to={`/knowledge/library/${hit.id}`} className="tp-focus-ring block rounded-lg px-3 py-3 hover:bg-muted/60" data-testid={`library-hit-${hit.id}`}>
        <span className="flex flex-wrap items-baseline gap-x-3">
          <span className="text-sm font-medium text-foreground">{hit.title}</span>
          {hit.section?.heading && <span className="text-xs text-muted-foreground">{hit.section.heading}</span>}
        </span>
        <span className="mt-0.5 line-clamp-2 block text-[13px] leading-relaxed text-muted-foreground">{hit.snippet}</span>
      </Link>
    </li>
  );
}

export default function LibraryPanel({ canWrite = false }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const scope = useMemo(() => ({
    view: params.get('view') || 'all',
    categoryId: Number(params.get('c')) || null,
    subcategoryId: Number(params.get('s')) || null,
  }), [params]);
  const health = params.get('health') || '';
  const q = params.get('q') || '';
  const [typed, setTyped] = useState(q);
  const [tree, setTree] = useState(null);
  const [list, setList] = useState(null);
  const [total, setTotal] = useState(0);
  const [hits, setHits] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showTree, setShowTree] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    knowledgeAPI.library()
      .then((res) => { if (!cancelled) setTree(res?.data || null); })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load the Library'); });
    return () => { cancelled = true; };
  }, []);

  // Typing searches after a short pause; the query lives in the URL.
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (typed.trim() === q) return;
      const next = new URLSearchParams(params);
      if (typed.trim()) next.set('q', typed.trim()); else next.delete('q');
      setParams(next, { replace: true });
    }, 300);
    return () => window.clearTimeout(id);
  }, [typed]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const mine = ++seq.current;
    setError(null);
    if (q.length >= 2) {
      setHits(null);
      knowledgeAPI.search(q, { limit: 20 })
        .then((res) => { if (seq.current === mine) setHits(res?.data || []); })
        .catch((err) => { if (seq.current === mine) { setHits([]); setError(err?.message || 'Search failed'); } });
      return;
    }
    setHits(null);
    setList(null);
    Promise.all(listRequests({ scope, health, limit: PAGE }).map((p) => knowledgeAPI.listArticles(p)))
      .then((pages) => {
        if (seq.current !== mine) return;
        setList(mergeArticles(pages.map((p) => p?.data?.items || [])));
        setTotal(pages.length === 1 ? Number(pages[0]?.data?.total) || 0 : 0);
      })
      .catch((err) => { if (seq.current === mine) { setList([]); setError(err?.message || 'Could not load the articles'); } });
  }, [scope, health, q]);

  const pick = (next) => {
    const sp = new URLSearchParams();
    if (next.view && next.view !== 'all') sp.set('view', next.view);
    if (next.categoryId) sp.set('c', String(next.categoryId));
    if (next.subcategoryId) sp.set('s', String(next.subcategoryId));
    setTyped('');
    setParams(sp);
  };
  const setHealth = (value) => {
    const sp = new URLSearchParams(params);
    if (value) sp.set('health', value); else sp.delete('health');
    setParams(sp, { replace: true });
  };
  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const [req] = listRequests({ scope, health, limit: PAGE, offset: list.length });
      const res = await knowledgeAPI.listArticles(req);
      setList((prev) => mergeArticles([prev, res?.data?.items || []]));
    } catch (err) {
      setError(err?.message || 'Could not load more');
    } finally {
      setLoadingMore(false);
    }
  };

  const categoryNames = useMemo(() => {
    const m = new Map();
    for (const c of tree?.categories || []) { m.set(c.id, c.name); for (const s of c.subcategories || []) m.set(s.id, s.name); }
    return m;
  }, [tree]);
  const newHref = `/knowledge/articles/new${scope.categoryId ? `?c=${scope.categoryId}${scope.subcategoryId ? `&s=${scope.subcategoryId}` : ''}` : ''}`;
  const searching = q.length >= 2;

  if (!tree && !error) return <Loading label="Loading the Library…" />;

  return (
    <div data-testid="library-panel">
      {canWrite && (
        <TabActions>
          <button type="button" onClick={() => navigate(newHref.replace('/articles/new', '/articles/from-notes'))} className="tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted">
            <NotebookPen className="h-4 w-4" aria-hidden="true" /> From rough notes
          </button>
          <button type="button" onClick={() => navigate(newHref)} className="tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90">
            <Plus className="h-4 w-4" aria-hidden="true" /> New article
          </button>
        </TabActions>
      )}

      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          type="search"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Search the Library: a question, an app, an error message…"
          aria-label="Search the Library"
          className="tp-focus-ring h-11 w-full rounded-xl border border-input bg-card pl-10 pr-10 text-sm text-foreground placeholder:text-muted-foreground/75"
        />
        {typed && (
          <button type="button" onClick={() => setTyped('')} aria-label="Clear the search" className="tp-focus-ring absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {error && <p className="mb-3 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}

      <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        {/* On a phone the tree is one tap away, so the articles come first. */}
        <button
          type="button"
          onClick={() => setShowTree((v) => !v)}
          aria-expanded={showTree}
          className="tp-focus-ring tp-card flex items-center justify-between px-3 py-2.5 text-left text-sm lg:hidden"
          data-testid="library-tree-toggle"
        >
          <span><span className="text-muted-foreground">Browsing </span><span className="font-medium text-foreground">{scopeTitle(scope, tree)}</span></span>
          {showTree ? <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
        </button>
        <aside className={`tp-card h-fit p-2 lg:sticky lg:top-20 lg:block ${showTree ? '' : 'hidden'}`}>
          {tree && <Tree tree={tree} scope={scope} onPick={(next) => { setShowTree(false); pick(next); }} />}
        </aside>

        <section className="tp-card min-w-0 p-2" aria-label={searching ? 'Search results' : scopeTitle(scope, tree)}>
          <div className="flex flex-wrap items-center gap-3 px-3 pb-2 pt-2">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground" data-testid="library-title">
              {searching ? `Results for “${q}”` : scopeTitle(scope, tree)}
            </h2>
            {canWrite && !searching && (
              <Link to="/knowledge/articles" className="tp-focus-ring flex-shrink-0 rounded text-xs font-medium text-primary hover:underline" title="Every article in one list: filters, drafts and the archive">
                Manage as a list
              </Link>
            )}
            {!searching && scope.view !== 'attention' && (
              <div className="w-44 flex-shrink-0">
                <FancySelect value={health} onChange={setHealth} options={HEALTH_FILTERS} aria-label="Show" data-testid="library-health" />
              </div>
            )}
          </div>

          {searching ? (
            hits === null ? <Loading label="Searching…" className="py-10" /> : hits.length === 0 ? (
              <EmptyState icon={Search} title="Nothing in the Library answers that">
                {canWrite ? 'If you know the answer, write it down: the next person will find it, and so will Auto-help.' : 'Someone with the skill for this topic can write it down.'}
              </EmptyState>
            ) : (
              <ul className="divide-y divide-border/60" data-testid="library-hits">{hits.map((h) => <SearchHit key={h.id} hit={h} />)}</ul>
            )
          ) : list === null ? <Loading label="Loading…" className="py-10" /> : list.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title={scope.view === 'attention' ? 'Nothing needs attention' : scope.view === 'mine' ? 'You keep no articles yet' : health ? 'Nothing matches that filter here' : 'Nothing written here yet'}
              action={canWrite && scope.view !== 'attention' && !health ? (
                <button type="button" onClick={() => navigate(newHref)} className="tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted">
                  <Plus className="h-4 w-4" aria-hidden="true" /> Write the first one
                </button>
              ) : null}
            >
              {scope.view === 'attention' ? 'No article is out of date or marked “needs a look”.' : !health && (scope.categoryId ? 'Tickets in this category have nothing to be answered from yet.' : null)}
            </EmptyState>
          ) : (
            <>
              <ul className="divide-y divide-border/60" data-testid="library-list">
                {list.map((a) => <ArticleRow key={a.id} article={a} categoryNames={categoryNames} />)}
              </ul>
              <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
                <span>{countWords(list.length)}{total > list.length ? ` of ${total}` : ''}</span>
                {total > list.length && (
                  <button type="button" onClick={loadMore} disabled={loadingMore} className="tp-focus-ring rounded-md px-2 py-1 font-medium text-primary hover:bg-muted disabled:opacity-50">
                    {loadingMore ? 'Loading…' : 'Show more'}
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
