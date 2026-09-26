import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, Archive, ArrowLeft, BadgeCheck, ChevronRight, FileText, Plus, Search, Sparkles, UserRound } from 'lucide-react';
import { knowledgeAPI, ticketsAPI } from '../../services/api';
import FancySelect from '../common/FancySelect';
import RichTextEditor from '../tickets/RichTextEditor';
import { PersonAvatar, SafeHtml, timeAgo } from '../tickets/ticketUi';
import {
  ConfirmDialog, EmptyState, GuardedLink, Loading, SectionTitle, inputClass, labelClass, prettyEmailName, useUnsavedGuard,
} from './knowledgeUi';
import { agoWords, governanceLine } from './knowledgeFormat';

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
const STATUS_WORD = {
  published: { label: 'Published', tone: 'text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500' },
  draft: { label: 'Draft', tone: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' },
  archived: { label: 'Archived', tone: 'text-muted-foreground', dot: 'bg-muted-foreground/50' },
};

function StatusWord({ status }) {
  const m = STATUS_WORD[status] || STATUS_WORD.draft;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${m.tone}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} aria-hidden="true" />{m.label}
    </span>
  );
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

/**
 * The list. With a search typed it asks the hybrid /knowledge/search
 * (meaning + words, the same search Auto-help uses — published articles
 * only); without one it lists by status. Archived articles are hidden unless
 * "Show archived" is ticked.
 */
function ArticleList({ categories, canManage }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const query = q.trim();
  const searching = query.length > 0 && !showArchived && !needsReview;

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      const req = searching
        ? knowledgeAPI.search(query, { limit: 20 }).then((res) => {
          const cat = Number(categoryId) || null;
          const items = (res?.data || [])
            .filter((h) => !cat || h.categoryId === cat || h.subcategoryId === cat)
            .map((h) => ({ ...h, status: 'published' }));
          return { items, total: items.length, searched: true };
        })
        : knowledgeAPI.listArticles({
          q: query || undefined,
          status: showArchived ? 'archived' : (status || undefined),
          review: !showArchived && needsReview ? 'due' : undefined,
          categoryId: categoryId || undefined,
        }).then((res) => res?.data || { items: [], total: 0 });
      req
        .then((d) => { if (!cancelled) { setData(d); setError(null); } })
        .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load articles'); });
    }, query ? 250 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, searching, status, showArchived, needsReview, categoryId]);

  const categoryOptions = useMemo(() => [
    { value: '', label: 'All categories' },
    ...categories.flatMap((c) => [
      { value: c.id, label: c.name, group: 'Categories' },
      ...(c.subcategories || []).map((s) => ({ value: s.id, label: `${c.name} → ${s.name}`, group: 'Subcategories' })),
    ]),
  ], [categories]);

  const filtered = Boolean(query || status || categoryId || showArchived || needsReview);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <label className="relative min-w-0 flex-1 sm:min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" aria-hidden="true" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by meaning or words…"
            aria-label="Search articles"
            className={`${inputClass} pl-9`}
          />
        </label>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <div className="sm:w-48">
            <FancySelect value={status} onChange={setStatus} options={STATUS_FILTERS} aria-label="Article status" disabled={searching || showArchived} />
          </div>
          <div className="sm:w-56"><FancySelect value={categoryId} onChange={setCategoryId} options={categoryOptions} aria-label="Article category" /></div>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 px-1 text-sm text-foreground/85">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="tp-focus-ring h-4 w-4 rounded border-input accent-[hsl(var(--primary))]" />
          Show archived
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2 px-1 text-sm text-foreground/85">
          <input type="checkbox" checked={needsReview} onChange={(e) => setNeedsReview(e.target.checked)} disabled={showArchived} className="tp-focus-ring h-4 w-4 rounded border-input accent-[hsl(var(--primary))]" />
          Needs review
        </label>
        {canManage && (
          <button
            type="button"
            onClick={() => navigate('/knowledge/articles/new')}
            className="tp-focus-ring inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> New article
          </button>
        )}
      </div>
      {searching && <p className="px-1 text-[11px] text-muted-foreground/75">Searching published articles by meaning and words — the same search Auto-help uses.</p>}

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
        <ul className="tp-card divide-y divide-border/70 overflow-hidden" data-testid="articles-list">
          {data.items.map((a) => (
            <li key={a.id}>
              <Link to={`/knowledge/articles/${a.id}`} className="tp-focus-ring block px-4 py-3 transition-colors hover:bg-muted/40">
                <div className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{a.title}</span>
                  <StatusWord status={a.status} />
                </div>
                <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{a.snippet || 'No text yet'}</p>
                <p className="mt-1 text-[11px] text-muted-foreground/75">
                  {[
                    categoryName(categories, a.subcategoryId) || categoryName(categories, a.categoryId),
                    (a.tags || []).length ? a.tags.join(', ') : null,
                    data.searched ? `relevance ${Math.round(Number(a.score || 0) * 100)}%` : (a.updatedAt ? `updated ${timeAgo(a.updatedAt)}` : null),
                  ].filter(Boolean).join(' · ')}
                  {governanceLine(a) && (
                    <span className={a.needsReview ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'} data-testid="governance-line">
                      {' · '}{governanceLine(a)}
                    </span>
                  )}
                </p>
              </Link>
            </li>
          ))}
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
    />
  );
}

const EMPTY = { title: '', bodyHtml: '', status: 'draft', tags: [], categoryId: null, subcategoryId: null, ownerEmail: '', reviewEveryDays: 180 };

/** R1: the writing rules, one click away (collapsed by default). */
function WritingGuide() {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs" data-testid="writing-guide">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="tp-focus-ring inline-flex items-center gap-1 rounded font-medium text-foreground/85 hover:text-foreground">
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
        Writing for Auto-help
      </button>
      {open && (
        <ul className="mt-1.5 list-disc space-y-1 pl-9 leading-relaxed text-muted-foreground animate-fadeIn">
          <li>One topic per article — one task, one answer.</li>
          <li>Self-contained: Auto-help can&rsquo;t follow links, so put the steps here, not behind a link.</li>
          <li>Use headings for each procedure and numbered steps inside them — each heading becomes a section Auto-help can quote on its own.</li>
          <li>No screenshot-only steps: say in words what to click; a picture can back it up.</li>
          <li>Name buttons and menus exactly as people see them.</li>
        </ul>
      )}
    </div>
  );
}

function ArticleEditor({ articleId, categories, canManage }) {
  const navigate = useNavigate();
  const location = useLocation();
  const isNew = articleId === 'new';
  const [form, setForm] = useState(isNew ? EMPTY : null);
  const [tagText, setTagText] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [similar, setSimilar] = useState([]);
  const [verifying, setVerifying] = useState(false);
  const leave = useUnsavedGuard(canManage && dirty);

  useEffect(() => {
    setDirty(false);
    // A just-created article arrives with its save result (the duplicate-title
    // warning and "Saved") in the route state; anything else starts clean.
    const carried = location.state?.afterCreate || null;
    setSimilar(carried?.similar || []);
    if (carried?.savedAt) setSavedAt(new Date(carried.savedAt));
    if (isNew) { setForm(EMPTY); setTagText(''); return undefined; }
    let cancelled = false;
    setForm(null);
    knowledgeAPI.getArticle(articleId)
      .then((res) => { if (!cancelled) { setForm(res.data); setTagText((res.data.tags || []).join(', ')); } })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load the article'); });
    return () => { cancelled = true; };
  }, [articleId, isNew]); // eslint-disable-line react-hooks/exhaustive-deps -- route state is read once per article

  const set = useCallback((patch) => { setForm((f) => ({ ...f, ...patch })); setDirty(true); }, []);
  const top = categories.find((c) => c.id === Number(form?.categoryId));

  if (error && !form) return <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>;
  if (!form) return <Loading label="Loading article…" />;

  const save = async () => {
    setSaving(true);
    setError(null);
    const payload = {
      title: form.title,
      bodyHtml: form.bodyHtml,
      status: form.status,
      tags: tagText.split(',').map((t) => t.trim()).filter(Boolean),
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
      }
      else { setForm(res.data); setTagText((res.data.tags || []).join(', ')); }
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

  const back = (e) => {
    if (!leave) return;
    e.preventDefault();
    leave('/knowledge/articles');
  };

  return (
    <div className="space-y-4 animate-fadeIn">
      <GuardedLink to="/knowledge/articles" className="tp-focus-ring inline-flex items-center gap-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> All articles
      </GuardedLink>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
        <section className="tp-card space-y-4 p-4 sm:p-5" aria-label="Article editor">
          {canManage ? (
            <>
              <div>
                <label htmlFor="ka-title" className={labelClass}>Title</label>
                <input id="ka-title" value={form.title} onChange={(e) => set({ title: e.target.value })} maxLength={300} placeholder="e.g. Install software from Company Portal" className={`${inputClass} h-10 text-[15px] font-medium`} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <span className={labelClass}>Category</span>
                  <FancySelect
                    value={form.categoryId || ''}
                    onChange={(v) => set({ categoryId: v ? Number(v) : null, subcategoryId: null })}
                    options={[{ value: '', label: 'No category' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
                    aria-label="Category"
                  />
                </div>
                <div>
                  <span className={labelClass}>Subcategory</span>
                  <FancySelect
                    value={form.subcategoryId || ''}
                    onChange={(v) => set({ subcategoryId: v ? Number(v) : null })}
                    options={[{ value: '', label: top ? 'Whole category' : 'Pick a category first' }, ...((top?.subcategories) || []).map((s) => ({ value: s.id, label: s.name }))]}
                    disabled={!top}
                    aria-label="Subcategory"
                  />
                </div>
                <div>
                  <label htmlFor="ka-tags" className={labelClass}>Tags <span className="font-normal text-muted-foreground">(comma separated)</span></label>
                  <input id="ka-tags" value={tagText} onChange={(e) => { setTagText(e.target.value); setDirty(true); }} placeholder="company portal, install" className={inputClass} />
                </div>
                <div>
                  <span className={labelClass}>Status</span>
                  <FancySelect value={form.status} onChange={(v) => set({ status: v })} options={STATUS_OPTIONS} aria-label="Status" />
                </div>
                <div>
                  <span className={labelClass}>Owner <span className="font-normal text-muted-foreground">(keeps it true)</span></span>
                  <OwnerPicker value={form.ownerEmail || ''} isNew={isNew} onChange={(v) => set({ ownerEmail: v })} />
                </div>
                <div>
                  <label htmlFor="ka-review" className={labelClass}>Review every (days)</label>
                  <input id="ka-review" type="number" min="7" max="730" value={form.reviewEveryDays ?? 180} onChange={(e) => set({ reviewEveryDays: e.target.value })} className={`${inputClass} w-28`} />
                </div>
              </div>
              {!isNew && form.status === 'published' && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="verify-row">
                  <span>
                    {form.lastVerifiedAt ? `Verified ${agoWords(form.lastVerifiedAt)}` : 'Never verified'}
                    {form.needsReview ? ' · Review due' : ''}
                  </span>
                  <button type="button" onClick={markVerified} disabled={verifying} className="tp-focus-ring inline-flex items-center gap-1 rounded font-medium text-primary hover:underline disabled:opacity-50">
                    <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" /> {verifying ? 'Marking…' : 'Mark as verified'}
                  </button>
                </div>
              )}
              <WritingGuide />
              <div>
                <span className={labelClass}>Article</span>
                <RichTextEditor
                  value={form.bodyHtml}
                  onChange={({ html }) => set({ bodyHtml: html })}
                  placeholder="Write the answer the way you'd explain it to a colleague: a line of context, then the steps."
                  ariaLabel="Article body"
                  minHeight={260}
                  headings
                />
                <p className="mt-1 text-[11px] text-muted-foreground/75">Keep it to one task. Name buttons and menus exactly as people see them.</p>
              </div>
              {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
              {similar.length > 0 && (
                <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300" role="status" data-testid="similar-titles">
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
              <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-4">
                <button type="button" onClick={save} disabled={saving || !form.title.trim()} className="tp-focus-ring inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  {saving ? 'Saving…' : isNew ? 'Create article' : 'Save'}
                </button>
                <Link to="/knowledge/articles" onClick={back} className="tp-focus-ring inline-flex h-9 items-center rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted">Cancel</Link>
                {dirty ? <span className="text-xs text-amber-700 dark:text-amber-300">Unsaved changes</span> : savedAt && <span className="text-xs text-muted-foreground">Saved {timeAgo(savedAt)}</span>}
                {!isNew && form.status !== 'archived' && (
                  <button type="button" onClick={() => setConfirmArchive(true)} className="tp-focus-ring ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
                    <Archive className="h-4 w-4" aria-hidden="true" /> Archive
                  </button>
                )}
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
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-foreground">{form.title}</h2>
              <p className="text-xs text-muted-foreground">{[categoryName(categories, form.subcategoryId) || categoryName(categories, form.categoryId), (form.tags || []).join(', ')].filter(Boolean).join(' · ')}</p>
              <SafeHtml html={form.bodyHtml} />
            </>
          )}
        </section>

        {canManage && (
          <section className="space-y-2 lg:sticky lg:top-20 lg:self-start" aria-label="Preview">
            <SectionTitle icon={Sparkles} hint="How the article reads when Auto-help or an agent quotes it.">Preview</SectionTitle>
            <div className="tp-card p-4 sm:p-5">
              <p className="mb-2 text-[15px] font-semibold text-foreground">{form.title || 'Untitled article'}</p>
              {form.bodyHtml ? <SafeHtml html={form.bodyHtml} /> : <p className="text-sm text-muted-foreground/75">The article text shows here as you write.</p>}
            </div>
            {!isNew && (
              <p className="px-1 text-[11px] text-muted-foreground/75">
                {form.status === 'published' ? (form.embedded ? 'Indexed for meaning-based search.' : 'Keyword search only (not indexed yet).') : 'Only published articles are used by Auto-help.'}
              </p>
            )}
            {!isNew && (form.sectionHeadings || []).length > 0 && (
              <p className="px-1 text-[11px] text-muted-foreground/75" data-testid="section-headings">
                Auto-help reads it in sections: {form.sectionHeadings.map((h) => h || 'Introduction').join(' · ')}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

export default function ArticlesPanel({ itemId, categories = [], canManage = false }) {
  if (itemId) return <ArticleEditor articleId={itemId} categories={categories} canManage={canManage} />;
  return <ArticleList categories={categories} canManage={canManage} />;
}
