import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Archive, ArrowLeft, BadgeCheck, BookMarked, BookOpen, Eye, FileText, Layers, ListTree, Plus, Save, Search, UserRound,
} from 'lucide-react';
import { knowledgeAPI, ticketsAPI } from '../../services/api';
import FancySelect from '../common/FancySelect';
import SearchSelect from '../common/SearchSelect';
import RichTextEditor from '../tickets/RichTextEditor';
import { PersonAvatar, SafeHtml, timeAgo } from '../tickets/ticketUi';
import {
  ConfirmDialog, EmptyState, GuardedLink, Loading, PersonLine, inputClass, prettyEmailName, useUnsavedGuard,
} from './knowledgeUi';
import {
  agoWords, articleSourceLabel, articleTopics, governanceLine, isSystemTag,
} from './knowledgeFormat';
import { DraftedFromBanner, FsSourceNote, ReviewDigestLine } from './ArticleGrowth';
import {
  HelpPopover, IconTile, Menu, MetaRow, NumberedSection, PanelTabs, StatusBadge, TabActions, TitleField, TokenInput, fieldHint, fieldLabel,
} from './builderUi';

const STATUS_FILTERS = [
  { value: '', label: 'Drafts and published' },
  { value: 'published', label: 'Published' },
  { value: 'draft', label: 'Drafts' },
];
const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft — not used by Auto-help' },
  { value: 'published', label: 'Published — Auto-help may quote it' },
  { value: 'archived', label: 'Archived' },
];
const STATUS_BADGE = {
  published: { label: 'Published', tone: 'success' },
  draft: { label: 'Draft', tone: 'warning' },
  archived: { label: 'Archived', tone: 'muted' },
};

function ArticleStatus({ status }) {
  const m = STATUS_BADGE[status] || STATUS_BADGE.draft;
  return <StatusBadge tone={m.tone} testId="article-status">{m.label}</StatusBadge>;
}

/** Topic type-ahead for the article editor: GET /knowledge/topics?q= → [{ topic, count }]. */
async function loadTopics(q) {
  const res = await knowledgeAPI.topics?.(q);
  return (res?.data || []).map((t) => ({ value: t.topic, count: t.count }));
}

/** No playbook's category reaches it (quotedBy is an empty list, not just absent). */
function unreached(article) {
  return Array.isArray(article?.quotedBy) && article.quotedBy.length === 0 && article.status !== 'archived';
}

function categoryName(tree, id) {
  if (!id) return null;
  for (const c of tree) {
    if (c.id === id) return c.name;
    const s = c.subcategories?.find((x) => x.id === id);
    if (s) return `${c.name} → ${s.name}`;
  }
  return null;
}

const SOURCE_FILTERS = [
  { value: 'tp', label: 'Written in Ticket Pulse' },
  { value: 'drafted', label: 'Drafted from tickets' },
  { value: 'fs_solution', label: 'FreshService solution' },
];
const SORT_OPTIONS = [
  { value: '', label: 'Recently updated' },
  { value: 'quoted', label: 'Most quoted' },
  { value: 'title', label: 'Title A–Z' },
  { value: 'oldest_verified', label: 'Longest since checked' },
];

/**
 * The landing strip (30 Sep 2026): how much knowledge there is, how much
 * Auto-help used lately, and — per category — tickets in the last 30 days
 * next to published articles, so the gaps are obvious. A category row
 * filters the list.
 */
function ArticlesOverview({ onPickCategory }) {
  const [data, setData] = useState(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => knowledgeAPI.articlesOverview())
      .then((res) => { if (!cancelled) setData(res?.data || null); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, []);
  if (!data) return null;
  const rows = (data.coverage || []).filter((c) => c.tickets30d > 0 || c.published > 0);
  const shown = showAll ? rows : rows.slice(0, 6);
  const max = Math.max(1, ...rows.map((c) => c.tickets30d));
  const stat = (n, label, tone = '') => (
    <div className="min-w-0">
      <p className={`text-xl font-semibold tabular-nums ${tone || 'text-foreground'}`}>{n}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
  return (
    <section className="tp-card grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]" aria-label="Knowledge at a glance" data-testid="articles-overview">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
        {stat(data.published, 'published')}
        {stat(data.draft, data.draft === 1 ? 'draft' : 'drafts')}
        {stat(data.needsReview, 'need a review', data.needsReview ? 'text-amber-700 dark:text-amber-300' : '')}
        {stat(data.quoted30d, 'quotes by Auto-help, 30 days')}
        {stat(data.articlesQuoted30d, 'articles quoted, 30 days')}
        {stat(data.archived, 'archived')}
      </div>
      <div className="min-w-0" data-testid="coverage">
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Tickets in the last 30 days vs published articles, by category</p>
        <ul className="space-y-1">
          {shown.map((c) => (
            <li key={c.categoryId}>
              <button
                type="button"
                onClick={() => onPickCategory?.(c.categoryId)}
                className="tp-focus-ring grid w-full grid-cols-[minmax(0,1fr)_5rem_6.5rem] items-center gap-3 rounded-md px-1.5 py-1 text-left text-xs hover:bg-muted/50"
                title={`Show ${c.name} articles`}
              >
                <span className="truncate text-foreground/85">{c.name}</span>
                <span className="relative h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-primary/60" style={{ width: `${Math.max(3, Math.round((c.tickets30d / max) * 100))}%` }} />
                </span>
                <span className="whitespace-nowrap text-right tabular-nums">
                  <span className="text-muted-foreground">{c.tickets30d} tickets · </span>
                  <span className={c.published ? 'text-foreground/85' : 'font-medium text-amber-700 dark:text-amber-300'}>{c.published || 'no'} article{c.published === 1 ? '' : 's'}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {rows.length > 6 && (
          <button type="button" onClick={() => setShowAll((v) => !v)} className="tp-focus-ring mt-1 rounded px-1.5 text-xs font-medium text-primary hover:underline">
            {showAll ? 'Show fewer' : `Show all ${rows.length} categories`}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The list. With a search typed it asks the hybrid /knowledge/search
 * (meaning + words, the same search Auto-help uses — published articles
 * only); without one it lists by status. Filters you can type in: category,
 * topic and owner (30 Sep 2026). Archived articles are hidden unless
 * "Show archived" is ticked.
 */
function ArticleList({ categories, canManage }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  const [topic, setTopic] = useState('');
  const [owner, setOwner] = useState('');
  const [source, setSource] = useState('');
  const [sort, setSort] = useState('');
  const [techs, setTechs] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const query = q.trim();
  const searching = query.length > 0 && !showArchived && !needsReview;

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => ticketsAPI.meta())
      .then((res) => { if (!cancelled) setTechs(res?.data?.technicians || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      const req = searching
        ? knowledgeAPI.search(query, { limit: 20 }).then((res) => {
          const cat = Number(categoryId) || null;
          const tp = topic.trim().toLowerCase();
          const items = (res?.data || [])
            .filter((h) => !cat || h.categoryId === cat || h.subcategoryId === cat)
            .filter((h) => !tp || (h.tags || []).some((x) => String(x).toLowerCase() === tp))
            .map((h) => ({ ...h, status: 'published' }));
          return { items, total: items.length, searched: true };
        })
        : knowledgeAPI.listArticles({
          q: query || undefined,
          status: showArchived ? 'archived' : (status || undefined),
          review: !showArchived && needsReview ? 'due' : undefined,
          categoryId: categoryId || undefined,
          topic: topic || undefined,
          owner: owner || undefined,
          source: source || undefined,
          sort: sort || undefined,
        }).then((res) => res?.data || { items: [], total: 0 });
      req
        .then((d) => { if (!cancelled) { setData(d); setError(null); } })
        .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load articles'); });
    }, query ? 250 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, searching, status, showArchived, needsReview, categoryId, topic, owner, source, sort]);

  const categoryOptions = useMemo(() => categories.flatMap((c) => [
    { value: c.id, label: c.name },
    ...(c.subcategories || []).map((s) => ({ value: s.id, label: `${c.name} → ${s.name}` })),
  ]), [categories]);
  const ownerOptions = useMemo(() => (techs || [])
    .filter((t) => t.email)
    .map((t) => ({ value: String(t.email).toLowerCase(), label: t.name || prettyEmailName(t.email), hint: t.email }))
    .sort((a, b) => a.label.localeCompare(b.label)), [techs]);
  const loadTopicOptions = useCallback(async (text) => {
    const list = await loadTopics(text);
    return list.map((t) => ({ value: t.value, label: t.value, hint: t.count ? `${t.count}` : undefined }));
  }, []);

  const filtered = Boolean(query || status || categoryId || topic || owner || source || showArchived || needsReview);
  const clearAll = () => {
    setQ(''); setStatus(''); setCategoryId(''); setTopic(''); setOwner(''); setSource(''); setShowArchived(false); setNeedsReview(false);
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <TabActions>
          <button
            type="button"
            onClick={() => navigate('/knowledge/articles/new')}
            className="tp-focus-ring inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> New article
          </button>
        </TabActions>
      )}
      <ArticlesOverview onPickCategory={(id) => setCategoryId(id)} />
      <div className="tp-card space-y-2.5 p-3 sm:p-4" data-testid="articles-filters">
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center">
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" aria-hidden="true" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by meaning or words…"
              aria-label="Search articles"
              className={`${inputClass} h-10 pl-9`}
            />
          </label>
          <div className="grid grid-cols-2 gap-2 lg:flex">
            <div className="lg:w-44">
              <FancySelect value={status} onChange={setStatus} options={STATUS_FILTERS} aria-label="Article status" disabled={searching || showArchived} className="h-10" />
            </div>
            <div className="lg:w-44">
              <FancySelect value={sort} onChange={setSort} options={SORT_OPTIONS} aria-label="Sort articles" disabled={searching} className="h-10" />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <SearchSelect value={categoryId} onChange={setCategoryId} options={categoryOptions} allLabel="All categories" placeholder="Type a category…" aria-label="Article category" data-testid="filter-category" />
          <SearchSelect value={topic} onChange={setTopic} loadOptions={loadTopicOptions} allLabel="All topics" placeholder="Type a topic…" aria-label="Article topic" data-testid="filter-topic" />
          <SearchSelect value={owner} onChange={setOwner} options={ownerOptions} allLabel="Any owner" placeholder="Type a name…" aria-label="Article owner" data-testid="filter-owner" />
          <SearchSelect value={source} onChange={setSource} options={SOURCE_FILTERS} allLabel="Any source" placeholder="Type a source…" aria-label="Article source" data-testid="filter-source" />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <label className="inline-flex cursor-pointer items-center gap-2 px-1 text-sm text-foreground/85">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="tp-focus-ring h-4 w-4 rounded border-input accent-[hsl(var(--primary))]" />
            Show archived
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 px-1 text-sm text-foreground/85">
            <input type="checkbox" checked={needsReview} onChange={(e) => setNeedsReview(e.target.checked)} disabled={showArchived} className="tp-focus-ring h-4 w-4 rounded border-input accent-[hsl(var(--primary))]" />
            Needs review
          </label>
          {filtered && (
            <button type="button" onClick={clearAll} className="tp-focus-ring ml-auto rounded px-1 text-sm font-medium text-primary hover:underline">Clear filters</button>
          )}
        </div>
      </div>
      {searching && <p className="px-1 text-xs text-muted-foreground">Searching published articles by meaning and words — the same search Auto-help uses.</p>}
      <ReviewDigestLine />

      {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
      {!data && !error ? <Loading label="Loading articles…" /> : data && data.items.length === 0 ? (
        <div className="tp-card">
          <EmptyState icon={showArchived ? Archive : needsReview ? BadgeCheck : FileText} title={showArchived ? 'Nothing archived' : needsReview ? 'Nothing due for review' : filtered ? 'No articles match' : 'No articles yet'}>
            {showArchived
              ? 'Archived articles show up here. They are never quoted by Auto-help.'
              : needsReview ? 'Every published article has been checked within its review interval.' : filtered
                ? 'Try a different word or filter.'
                : 'Articles are the short, trusted how-tos Auto-help may quote. Start with the questions your team answers every week.'}
          </EmptyState>
        </div>
      ) : data && (
        <ul className="space-y-2" data-testid="articles-list">
          {data.items.map((a) => {
            const topics = articleTopics(a);
            const reach = Array.isArray(a.quotedBy) ? a.quotedBy : [];
            return (
              <li key={a.id}>
                <Link to={`/knowledge/articles/${a.id}`} className="tp-card tp-focus-ring flex items-start gap-3.5 px-4 py-3.5 transition-shadow hover:shadow-soft">
                  <IconTile icon={FileText} size="sm" tone={a.status === 'published' ? 'primary' : 'muted'} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">{a.title}</span>
                      <ArticleStatus status={a.status} />
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">{a.snippet || 'No text yet'}</span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground/85">
                      {(categoryName(categories, a.subcategoryId) || categoryName(categories, a.categoryId)) && (
                        <span className="inline-flex items-center gap-1"><Layers className="h-3 w-3" aria-hidden="true" />{categoryName(categories, a.subcategoryId) || categoryName(categories, a.categoryId)}</span>
                      )}
                      {a.ownerEmail && (
                        <span className="inline-flex items-center gap-1"><UserRound className="h-3 w-3" aria-hidden="true" />{prettyEmailName(a.ownerEmail)}</span>
                      )}
                      {data.searched
                        ? <span>relevance {Math.round(Number(a.score || 0) * 100)}%</span>
                        : <span data-testid="times-quoted-line">{Number(a.timesQuoted) ? `quoted ${a.timesQuoted}×` : 'not quoted yet'}</span>}
                      {!data.searched && a.updatedAt && <span>updated {timeAgo(a.updatedAt)}</span>}
                      {articleSourceLabel(a) && <span>{articleSourceLabel(a)}</span>}
                      {governanceLine(a) && (
                        <span className={a.needsReview ? 'text-amber-700 dark:text-amber-300' : ''} data-testid="governance-line">{governanceLine(a)}</span>
                      )}
                    </span>
                    {(topics.length > 0 || reach.length > 0 || unreached(a)) && (
                      <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground/85">
                        {topics.length > 0 && <span>Topics: {topics.join(', ')}</span>}
                        {reach.length > 0 && <span>Preferred by {reach.map((pb) => pb.name).join(', ')}</span>}
                        {unreached(a) && (
                          <span className="text-amber-700 dark:text-amber-300" data-testid="no-playbook-reaches" title="No playbook covers this article's category — Auto-help can still find it by search.">
                            <AlertTriangle className="inline h-3 w-3 -translate-y-px" aria-hidden="true" /> No playbook covers its category
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {data && !data.searched && data.total > data.items.length && (
        <p className="px-1 text-xs text-muted-foreground">Showing {data.items.length} of {data.total}. Narrow the search to see the rest.</p>
      )}
    </div>
  );
}

/**
 * The article's owner: a person on this workspace's team (avatar + name),
 * stored as their e-mail. New articles default to whoever creates them.
 */
function OwnerPicker({ value, isNew, onChange }) {
  const [techs, setTechs] = useState(null);
  useEffect(() => {
    let cancelled = false;
    ticketsAPI.meta()
      .then((res) => { if (!cancelled) setTechs(res?.data?.technicians || []); })
      .catch(() => { if (!cancelled) setTechs([]); });
    return () => { cancelled = true; };
  }, []);
  const email = String(value || '').trim().toLowerCase();
  const options = useMemo(() => {
    const avatar = (name, photoUrl = null) => <PersonAvatar name={name} photoUrl={photoUrl} size="h-5 w-5" textSize="text-[9px]" />;
    const people = (techs || [])
      .filter((t) => t.email)
      .map((t) => ({ value: String(t.email).toLowerCase(), label: t.name || prettyEmailName(t.email), icon: avatar(t.name, t.photoUrl), hint: t.email }))
      .sort((a, b) => a.label.localeCompare(b.label));
    // An owner who isn't on the team list (left, or another workspace) still shows by name.
    if (email && !people.some((o) => o.value === email)) {
      people.unshift({ value: email, label: prettyEmailName(email), icon: avatar(prettyEmailName(email)), hint: email });
    }
    const none = {
      value: '',
      label: isNew ? 'You (default)' : 'No owner',
      icon: <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-muted-foreground"><UserRound className="h-3 w-3" /></span>,
    };
    return [none, ...people];
  }, [techs, email, isNew]);
  return (
    <FancySelect
      value={email}
      onChange={(v) => onChange(v)}
      options={options}
      aria-label="Owner"
      placeholder={techs ? 'Pick a person' : 'Loading people…'}
      data-testid="owner-picker"
      className="h-10"
    />
  );
}

// inputClass without w-full, for short number fields.
const narrowInput = inputClass.replace('w-full ', '');

const EMPTY = { title: '', bodyHtml: '', status: 'draft', tags: [], categoryId: null, subcategoryId: null, ownerEmail: '', reviewEveryDays: 180 };

/** R1: the writing rules, one click away (a help popover on step 1). */
function WritingGuide() {
  return (
    <div data-testid="writing-guide">
      <HelpPopover label="Writing for Auto-help" icon={BookOpen} title="Writing for Auto-help">
        <ul className="list-disc space-y-1.5 pl-4">
          <li>One topic per article — one task, one answer.</li>
          <li>Self-contained: Auto-help can&rsquo;t follow links, so put the steps here, not behind a link.</li>
          <li>Use headings for each procedure and numbered steps inside them — each heading becomes a section Auto-help can quote on its own.</li>
          <li>No screenshot-only steps: say in words what to click; a picture can back it up.</li>
          <li>Name buttons and menus exactly as people see them.</li>
        </ul>
      </HelpPopover>
    </div>
  );
}

const SIDE_TABS = [
  { id: 'preview', label: 'Preview', icon: Eye },
  { id: 'sections', label: 'How Auto-help reads it', icon: ListTree },
];

/** The article editor's sticky right panel: the reader's view, and the sections Auto-help quotes. */
function ArticleSidePanel({ form, isNew }) {
  const [tab, setTab] = useState('preview');
  const headings = form.sectionHeadings || [];
  return (
    <aside className="tp-card p-3 sm:p-4" aria-label="Preview" data-testid="article-side-panel">
      <PanelTabs tabs={SIDE_TABS} activeId={tab} onSelect={setTab} ariaLabel="Preview" idPrefix="ka-panel" />
      <div role="tabpanel" id="ka-panel-panel-preview" aria-labelledby="ka-panel-tab-preview" hidden={tab !== 'preview'} className="mt-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">How it reads when quoted</p>
        <div className="rounded-lg border border-border/80 p-4">
          <p className="mb-2 text-[15px] font-semibold text-foreground">{form.title || 'Untitled article'}</p>
          {form.bodyHtml ? <SafeHtml html={form.bodyHtml} /> : <p className="text-sm text-muted-foreground/75">The article text shows here as you write.</p>}
        </div>
      </div>
      <div role="tabpanel" id="ka-panel-panel-sections" aria-labelledby="ka-panel-tab-sections" hidden={tab !== 'sections'} className="mt-4 space-y-3">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Auto-help reads an article in sections, one per heading, and quotes the section that best matches the ticket.
        </p>
        {!isNew && headings.length > 0 ? (
          <ol className="space-y-1.5" data-testid="section-headings" aria-label={`Auto-help reads it in sections: ${headings.map((h) => h || 'Introduction').join(' · ')}`}>
            {headings.map((h, i) => (
              <li key={`${h}-${i}`} className="flex items-center gap-2.5 rounded-lg border border-border/80 px-3 py-2 text-sm text-foreground/90">
                <span className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold text-primary dark:bg-blue-500/15 dark:text-blue-200">{i + 1}</span>
                {h || 'Introduction'}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-[13px] text-muted-foreground/80">{isNew ? 'Save the article to see its sections.' : 'No headings yet — Auto-help reads it as one section.'}</p>
        )}
        {!isNew && (
          <p className="text-xs text-muted-foreground">
            {form.status === 'published' ? (form.embedded ? 'Indexed for meaning-based search.' : 'Keyword search only (not indexed yet).') : 'Only published articles are used by Auto-help.'}
          </p>
        )}
      </div>
    </aside>
  );
}

/**
 * "Quoted by" (Knowledge v2, MEGA 09-28 §6.7): which playbooks reach this
 * article's category, and how often Auto-help has quoted it.
 */
function ArticleReach({ form }) {
  if (!Array.isArray(form?.quotedBy)) return null;
  const list = form.quotedBy;
  const times = Number(form.timesQuoted) || 0;
  return (
    <section className="tp-card p-3 sm:p-4" aria-labelledby="ka-reach-title" data-testid="article-quoted-by">
      <h3 id="ka-reach-title" className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
        <BookMarked className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /> Quoted by
      </h3>
      {list.length ? (
        <ul className="mt-2 space-y-1">
          {list.map((pb) => (
            <li key={pb.playbookId} className="flex items-center gap-2 text-sm">
              <GuardedLink to={`/knowledge/playbooks/${pb.playbookId}`} className="tp-focus-ring min-w-0 truncate rounded font-medium text-primary hover:underline">
                {pb.name || `Playbook #${pb.playbookId}`}
              </GuardedLink>
              {!pb.enabled && <StatusBadge tone="muted">off</StatusBadge>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:bg-amber-500/10 dark:text-amber-200" role="note" data-testid="no-playbook-note">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          No playbook reaches this article&rsquo;s category yet &mdash; Auto-help can still find it by search, but no playbook is aimed at it.
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground" data-testid="times-quoted">
        Quoted in {times} Auto-help answer{times === 1 ? '' : 's'}
      </p>
    </section>
  );
}

function ArticleEditor({ articleId, categories, canManage }) {
  const navigate = useNavigate();
  const location = useLocation();
  const isNew = articleId === 'new';
  const [form, setForm] = useState(isNew ? EMPTY : null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [similar, setSimilar] = useState([]);
  const [verifying, setVerifying] = useState(false);
  useUnsavedGuard(canManage && dirty);

  useEffect(() => {
    setDirty(false);
    // A just-created article arrives with its save result (the duplicate-title
    // warning and "Saved") in the route state; anything else starts clean.
    const carried = location.state?.afterCreate || null;
    setSimilar(carried?.similar || []);
    if (carried?.savedAt) setSavedAt(new Date(carried.savedAt));
    if (isNew) { setForm(EMPTY); return undefined; }
    let cancelled = false;
    setForm(null);
    knowledgeAPI.getArticle(articleId)
      .then((res) => { if (!cancelled) setForm(res.data); })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load the article'); });
    return () => { cancelled = true; };
  }, [articleId, isNew]); // eslint-disable-line react-hooks/exhaustive-deps -- route state is read once per article

  const set = useCallback((patch) => { setForm((f) => ({ ...f, ...patch })); setDirty(true); }, []);
  const top = categories.find((c) => c.id === Number(form?.categoryId));
  // FreshService-imported articles are read-only here (edited in FreshService).
  const editable = canManage && !form?.readOnly;

  if (error && !form) return <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>;
  if (!form) return <Loading label="Loading article…" />;

  const save = async () => {
    setSaving(true);
    setError(null);
    const payload = {
      title: form.title,
      bodyHtml: form.bodyHtml,
      status: form.status,
      tags: form.tags || [],
      categoryId: form.categoryId || null,
      subcategoryId: form.subcategoryId || null,
      ownerEmail: String(form.ownerEmail || '').trim() || undefined,
      reviewEveryDays: Number(form.reviewEveryDays) || 180,
    };
    try {
      const res = isNew ? await knowledgeAPI.createArticle(payload) : await knowledgeAPI.updateArticle(articleId, payload);
      setSavedAt(new Date());
      setDirty(false);
      // Non-blocking: saved either way; a near-identical published title is flagged.
      setSimilar(res?.data?.warnings?.similarTitles || []);
      if (isNew) {
        navigate(`/knowledge/articles/${res.data.id}`, {
          replace: true,
          state: { afterCreate: { similar: res?.data?.warnings?.similarTitles || [], savedAt: Date.now() } },
        });
      } else setForm(res.data);
    } catch (err) {
      setError(err?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const markVerified = async () => {
    setVerifying(true);
    setError(null);
    try {
      const res = await knowledgeAPI.verifyArticle(articleId);
      setForm((f) => ({ ...f, lastVerifiedAt: res?.data?.lastVerifiedAt, needsReview: res?.data?.needsReview, reviewDueAt: res?.data?.reviewDueAt }));
    } catch (err) {
      setError(err?.message || 'Could not mark it verified');
    } finally {
      setVerifying(false);
    }
  };

  const archive = async () => {
    setConfirmArchive(false);
    try {
      await knowledgeAPI.deleteArticle(articleId);
      setDirty(false);
      navigate('/knowledge/articles');
    } catch (err) {
      setError(err?.message || 'Could not archive');
    }
  };

  const verifyLine = form.lastVerifiedAt ? `Verified ${agoWords(form.lastVerifiedAt)}` : 'Never verified';
  const header = (
    <section className="tp-card p-4 sm:p-5" aria-label="Article" data-testid="article-header">
      <div className="flex items-start gap-4">
        <IconTile icon={FileText} className="hidden sm:inline-flex" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{form.source === 'fs_solution' ? 'FreshService solution article' : 'Knowledge article'}</p>
              {editable ? (
                <TitleField id="ka-title" ariaLabel="Title" value={form.title} onChange={(title) => set({ title })} maxLength={300} placeholder="e.g. Install software from Company Portal" />
              ) : (
                <h2 className="mt-0.5 text-xl font-semibold text-foreground sm:text-2xl">{form.title}</h2>
              )}
            </div>
            <div className="flex flex-shrink-0 items-center gap-2 pt-1">
              <ArticleStatus status={form.status} />
              {editable && !isNew && (
                <Menu
                  label="Article actions"
                  testId="article-menu"
                  items={[
                    form.status === 'published' && { id: 'verify', label: verifying ? 'Marking…' : 'Mark as verified', hint: 'You checked it is still right today', icon: BadgeCheck, onSelect: markVerified, disabled: verifying },
                    form.status !== 'archived' && { id: 'archive', label: 'Archive…', hint: 'Auto-help stops quoting it', icon: Archive, onSelect: () => setConfirmArchive(true) },
                  ]}
                />
              )}
            </div>
          </div>
          <MetaRow className="mt-2.5">
            {form.ownerEmail ? <span className="inline-flex items-center gap-1.5">Owner <PersonLine email={form.ownerEmail} /></span> : <span>No owner</span>}
            {!isNew && form.status === 'published' && (
              <span className={form.needsReview ? 'text-amber-700 dark:text-amber-300' : ''} data-testid="verify-line">{verifyLine}{form.needsReview ? ' · Review due' : ''}</span>
            )}
            {!isNew && form.updatedAt && <span>Updated {timeAgo(form.updatedAt)}</span>}
            {!isNew && form.reviewEveryDays && <span>Review every {form.reviewEveryDays} days</span>}
          </MetaRow>
          {!editable && <div className="mt-2"><FsSourceNote article={form} /></div>}
        </div>
      </div>
    </section>
  );

  if (!editable) {
    return (
      <div className="animate-fadeIn space-y-4">
        <TabActions>
          <GuardedLink to="/knowledge/articles" aria-label="All articles" className="tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-foreground/85 hover:bg-muted sm:px-3">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> <span className="hidden sm:inline">All articles</span>
          </GuardedLink>
        </TabActions>
        {header}
        <section className="tp-card space-y-3 p-4 sm:p-5" aria-label="Article">
          <DraftedFromBanner article={form} />
          <p className="text-xs text-muted-foreground">{[categoryName(categories, form.subcategoryId) || categoryName(categories, form.categoryId), articleTopics(form).join(', ')].filter(Boolean).join(' · ')}</p>
          {articleSourceLabel(form) && <p className="text-xs text-muted-foreground" data-testid="article-source">Source: {articleSourceLabel(form)}</p>}
          <SafeHtml html={form.bodyHtml} />
        </section>
        <ArticleReach form={form} />
      </div>
    );
  }

  return (
    <div className="animate-fadeIn" data-testid="article-editor">
      <TabActions>
        {dirty ? <span className="hidden text-xs font-medium text-amber-700 dark:text-amber-300 sm:inline">Unsaved changes</span> : savedAt && <span className="hidden text-xs text-muted-foreground sm:inline">Saved {timeAgo(savedAt)}</span>}
        <GuardedLink to="/knowledge/articles" aria-label="All articles" className="tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-foreground/85 hover:bg-muted sm:px-3">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> <span className="hidden sm:inline">All articles</span>
        </GuardedLink>
        <button type="button" onClick={save} disabled={saving || !form.title.trim()} className="tp-focus-ring inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60">
          <Save className="h-4 w-4" aria-hidden="true" /> {saving ? 'Saving…' : isNew ? 'Create article' : 'Save changes'}
        </button>
      </TabActions>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(340px,440px)]">
        <div className="min-w-0 space-y-4">
          {header}
          {dirty && <p className="px-1 text-xs font-medium text-amber-700 dark:text-amber-300 sm:hidden">Unsaved changes</p>}
          {similar.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200" role="status" data-testid="similar-titles">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              <span>
                Saved. A published article has a very similar title — is this the same procedure?{' '}
                {similar.map((x, i) => (
                  <span key={x.id}>
                    {i > 0 && ', '}
                    <Link to={`/knowledge/articles/${x.id}`} className="tp-focus-ring rounded underline">{x.title}</Link>
                  </span>
                ))}
              </span>
            </div>
          )}

          <NumberedSection n={1} id="ka-content" title="Content" description="The answer, the way you'd explain it to a colleague: a line of context, then the steps." action={<WritingGuide />}>
            <div className="space-y-3">
              <DraftedFromBanner article={form} />
              <RichTextEditor
                value={form.bodyHtml}
                onChange={({ html }) => set({ bodyHtml: html })}
                placeholder="Write the answer the way you'd explain it to a colleague: a line of context, then the steps."
                ariaLabel="Article body"
                minHeight={300}
                headings
              />
              <p className={fieldHint}>Keep it to one task. Name buttons and menus exactly as people see them.</p>
            </div>
          </NumberedSection>

          <NumberedSection n={2} id="ka-classification" title="Classification" description="Where it belongs. Playbooks look in their own category first.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <span className={fieldLabel}>Category</span>
                <FancySelect
                  value={form.categoryId || ''}
                  onChange={(v) => set({ categoryId: v ? Number(v) : null, subcategoryId: null })}
                  options={[{ value: '', label: 'No category' }, ...categories.map((c) => ({ value: c.id, label: c.name, icon: <Layers className="h-4 w-4 text-primary" /> }))]}
                  aria-label="Category"
                  className="h-10"
                />
              </div>
              <div>
                <span className={fieldLabel}>Subcategory</span>
                <FancySelect
                  value={form.subcategoryId || ''}
                  onChange={(v) => set({ subcategoryId: v ? Number(v) : null })}
                  options={[{ value: '', label: top ? 'Whole category' : 'Pick a category first' }, ...((top?.subcategories) || []).map((s) => ({ value: s.id, label: s.name }))]}
                  disabled={!top}
                  aria-label="Subcategory"
                  className="h-10"
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="ka-tags" className={fieldLabel}>Topics</label>
                <TokenInput
                  id="ka-tags"
                  label="Topics"
                  values={articleTopics(form)}
                  onChange={(topics) => set({ tags: [...(form.tags || []).filter(isSystemTag), ...topics] })}
                  placeholder="company portal, install…"
                  minRows={1}
                  testId="article-tags"
                  describedBy="ka-tags-hint"
                  loadSuggestions={loadTopics}
                />
                <p id="ka-tags-hint" className={fieldHint}>For browsing and search: Enter or a comma adds a topic; topics other articles use are suggested as you type.</p>
              </div>
              {!isNew && articleSourceLabel(form) && (
                <div className="sm:col-span-2" data-testid="article-source">
                  <span className={fieldLabel}>Source</span>
                  <p className="text-sm text-foreground/85">{articleSourceLabel(form)}</p>
                </div>
              )}
            </div>
          </NumberedSection>

          <NumberedSection n={3} id="ka-review" title="Review & ownership" description="Who keeps it true, and how often it gets checked.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <span className={fieldLabel}>Status</span>
                <FancySelect value={form.status} onChange={(v) => set({ status: v })} options={STATUS_OPTIONS} aria-label="Status" className="h-10" />
              </div>
              <div>
                <span className={fieldLabel}>Owner <span className="font-normal text-muted-foreground">(keeps it true)</span></span>
                <OwnerPicker value={form.ownerEmail || ''} isNew={isNew} onChange={(v) => set({ ownerEmail: v })} />
              </div>
              <div>
                <label htmlFor="ka-review-days" className={fieldLabel}>Review every (days)</label>
                <input id="ka-review-days" type="number" min="7" max="730" value={form.reviewEveryDays ?? 180} onChange={(e) => set({ reviewEveryDays: e.target.value })} className={`${narrowInput} w-28`} />
              </div>
              {!isNew && form.status === 'published' && (
                <div className="flex flex-col justify-end gap-1 text-[13px] text-muted-foreground" data-testid="verify-row">
                  <span>{verifyLine}{form.needsReview ? ' · Review due' : ''}</span>
                  <button type="button" onClick={markVerified} disabled={verifying} className="tp-focus-ring inline-flex w-fit items-center gap-1 rounded font-medium text-primary hover:underline disabled:opacity-50">
                    <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" /> {verifying ? 'Marking…' : 'Mark as verified'}
                  </button>
                </div>
              )}
            </div>
          </NumberedSection>
          {error && <p className="px-1 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
        </div>

        <div className="settings-scrollbar min-w-0 xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto xl:rounded-xl">
          <div className="space-y-4">
            <ArticleSidePanel form={form} isNew={isNew} />
            {!isNew && <ArticleReach form={form} />}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmArchive}
        title="Archive this article?"
        confirmLabel="Archive"
        onCancel={() => setConfirmArchive(false)}
        onConfirm={archive}
      >
        Auto-help stops quoting it and it leaves search. Past runs still link to it, and you can find it under Show archived.
      </ConfirmDialog>
    </div>
  );
}

export default function ArticlesPanel({ itemId, categories = [], canManage = false }) {
  if (itemId) return <ArticleEditor articleId={itemId} categories={categories} canManage={canManage} />;
  return <ArticleList categories={categories} canManage={canManage} />;
}
