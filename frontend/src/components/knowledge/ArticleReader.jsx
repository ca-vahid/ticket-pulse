import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { ArrowLeft, Check, Flag, History, Pencil, RotateCcw } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import { formatDayTime, timeAgo } from '../tickets/ticketUi';
import { ConfirmDialog, EmptyState, Loading, PersonLine, textareaClass } from './knowledgeUi';
import { healthOf, sectionAnchor, usageWords } from './libraryFormat';

/**
 * An article, to read (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 12): a
 * reading layout, not a form. On top, in words: whether it can be trusted
 * (Checked / Not checked yet / Needs a look / Out of date), who stood behind
 * it and how it did in use, always with the counts. Anyone can flag it with
 * a sentence; people with the skill can fix it or confirm it; every change
 * is in History and can be put back.
 */

function Dot({ tone }) {
  return <span className={`h-2 w-2 flex-shrink-0 rounded-full ${tone}`} aria-hidden="true" />;
}

function FlagForm({ onCancel, onSend, busy }) {
  const [note, setNote] = useState('');
  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3" data-testid="article-flag-form">
      <label htmlFor="article-flag-note" className="block text-sm font-medium text-foreground">What is wrong or unclear?</label>
      <p className="mt-0.5 text-xs text-muted-foreground">One sentence is enough. People with the skill for this topic see it.</p>
      <textarea id="article-flag-note" rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} className={`${textareaClass} mt-2`} placeholder="For example: step 2 changed, the app is now called…" />
      <div className="mt-2 flex gap-2">
        <button type="button" disabled={busy || note.trim().length < 3} onClick={() => onSend(note.trim())} className="tp-focus-ring h-8 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">Send</button>
        <button type="button" disabled={busy} onClick={onCancel} className="tp-focus-ring h-8 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted">Cancel</button>
      </div>
    </div>
  );
}

function HistoryList({ articleId, canRestore, onRestored }) {
  const [data, setData] = useState(null);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    knowledgeAPI.articleVersions(articleId)
      .then((res) => { if (!cancelled) setData(res?.data || { current: 1, items: [] }); })
      .catch((err) => { if (!cancelled) { setData({ current: 1, items: [] }); setError(err?.message || 'Could not load the history'); } });
    return () => { cancelled = true; };
  }, [articleId]);
  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      await knowledgeAPI.restoreArticleVersion(articleId, pending.version);
      setPending(null);
      onRestored();
    } catch (err) {
      setError(err?.message || 'Could not put that version back');
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <Loading label="Loading the history…" className="py-6" />;
  return (
    <div className="mt-3 rounded-lg border border-border" data-testid="article-history">
      {error && <p className="px-3 pt-2 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
      {data.items.length === 0 ? <p className="px-3 py-3 text-sm text-muted-foreground">No earlier versions were kept for this article.</p> : (
        <ul className="divide-y divide-border/70">
          {data.items.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
              <span className="w-16 flex-shrink-0 tabular-nums text-muted-foreground">Version {v.version}</span>
              <span className="min-w-0 flex-1">
                <span className="text-foreground/90">{v.changeNote || (v.version === 1 ? 'Created' : 'Edited')}</span>
                <span className="ml-2 text-xs text-muted-foreground">{formatDayTime(v.createdAt)}</span>
              </span>
              {v.changedBy && <PersonLine email={v.changedBy} className="text-xs" />}
              {v.version === data.current ? <span className="text-xs text-muted-foreground">current</span> : canRestore && (
                <button type="button" onClick={() => setPending(v)} className="tp-focus-ring inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-muted">
                  <RotateCcw className="h-3 w-3" aria-hidden="true" /> Put back
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={Boolean(pending)}
        title={`Put version ${pending?.version} back?`}
        confirmLabel={busy ? 'Working…' : 'Put it back'}
        cancelLabel="Cancel"
        onCancel={() => setPending(null)}
        onConfirm={restore}
      >
        The article gets that version&rsquo;s text as a new version. Nothing is lost: today&rsquo;s text stays in the history.
      </ConfirmDialog>
    </div>
  );
}

export default function ArticleReader({ articleId, categories = [] }) {
  const navigate = useNavigate();
  const [article, setArticle] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [panel, setPanel] = useState(null); // 'flag' | 'history'
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef(null);

  const load = useCallback(() => knowledgeAPI.getArticle(articleId)
    .then((res) => { setArticle(res?.data || null); setError(null); })
    .catch((err) => setError(err?.message || 'Could not load the article')), [articleId]);
  useEffect(() => { setArticle(null); setPanel(null); setNotice(null); load(); }, [load]);

  const html = useMemo(() => DOMPurify.sanitize(article?.bodyHtml || '', { USE_PROFILES: { html: true } }), [article?.bodyHtml]);
  // Headings get anchors so "On this page" can jump to them.
  const [headings, setHeadings] = useState([]);
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) { setHeadings([]); return; }
    const list = [...root.querySelectorAll('h1, h2, h3')].map((el, i) => {
      const id = sectionAnchor(el.textContent, i);
      el.id = id;
      return { id, text: el.textContent || '' };
    }).filter((h) => h.text.trim());
    setHeadings(list);
  }, [html]);

  const act = async (fn, done) => {
    setBusy(true);
    setError(null);
    try { await fn(); setNotice(done); await load(); } catch (err) { setError(err?.message || 'That did not work'); } finally { setBusy(false); }
  };

  if (error && !article) {
    return (
      <div className="tp-card">
        <EmptyState title="This article could not be opened" action={<Link to="/knowledge/library" className="tp-focus-ring rounded text-sm font-medium text-primary hover:underline">Back to the Library</Link>}>{error}</EmptyState>
      </div>
    );
  }
  if (!article) return <Loading label="Loading the article…" />;

  const h = healthOf(article);
  const cat = categories.find((c) => c.id === article.categoryId);
  const sub = cat?.subcategories?.find((s) => s.id === article.subcategoryId);
  const back = `/knowledge/library${cat ? `?c=${cat.id}${sub ? `&s=${sub.id}` : ''}` : ''}`;
  const canWrite = article.my?.write === true && !article.readOnly && article.status !== 'archived';
  const canCheck = article.my?.check === true && !article.readOnly && article.status === 'published';
  const flags = article.use?.flags || [];

  return (
    <article className="mx-auto max-w-5xl" data-testid="article-reader">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <Link to={back} className="tp-focus-ring inline-flex items-center gap-1 rounded hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Library
        </Link>
        {cat && <><span aria-hidden="true">›</span><Link to={`/knowledge/library?c=${cat.id}`} className="tp-focus-ring rounded hover:text-foreground">{cat.name}</Link></>}
        {sub && <><span aria-hidden="true">›</span><Link to={back} className="tp-focus-ring rounded hover:text-foreground">{sub.name}</Link></>}
      </div>

      <div className="tp-card px-5 py-5 sm:px-8 sm:py-7">
        <header className="border-b border-border pb-4">
          <h1 className="text-xl font-semibold leading-snug text-foreground sm:text-2xl">{article.title}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground/85" data-testid="article-health">
            <Dot tone={h.dot} />
            <span className="font-medium">{h.label}</span>
            {article.confidence === 'checked' && article.checkedBy && (
              <span className="inline-flex flex-wrap items-center gap-1.5 text-muted-foreground">by <PersonLine email={article.checkedBy} /> {article.checkedAt ? timeAgo(article.checkedAt) : ''}</span>
            )}
            {article.health !== 'checked' && <span className="text-muted-foreground">· {h.hint}</span>}
          </p>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="article-use">
            {usageWords(article)}
            {article.use?.lastGoodBy ? ` · last confirmed in use ${timeAgo(article.use.lastGoodAt)}` : ''}
            {` · version ${article.version}`}
            {article.updatedAt ? ` · changed ${timeAgo(article.updatedAt)}` : ''}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {canWrite && (
              <button type="button" onClick={() => navigate(`/knowledge/articles/${article.id}`)} className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted">
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Edit
              </button>
            )}
            {canCheck && article.health !== 'checked' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => act(() => knowledgeAPI.verifyArticle(article.id), 'Marked as checked. Thank you.')}
                className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" aria-hidden="true" /> I checked this, it is right
              </button>
            )}
            {article.status === 'published' && (
              <button type="button" onClick={() => setPanel(panel === 'flag' ? null : 'flag')} aria-expanded={panel === 'flag'} className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
                <Flag className="h-3.5 w-3.5" aria-hidden="true" /> Something is wrong
              </button>
            )}
            <button type="button" onClick={() => setPanel(panel === 'history' ? null : 'history')} aria-expanded={panel === 'history'} className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
              <History className="h-3.5 w-3.5" aria-hidden="true" /> History
            </button>
          </div>
          {notice && <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-300" role="status">{notice}</p>}
          {error && <p className="mt-2 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
          {panel === 'flag' && (
            <FlagForm
              busy={busy}
              onCancel={() => setPanel(null)}
              onSend={(note) => act(async () => { await knowledgeAPI.flagArticle(article.id, { note }); setPanel(null); }, 'Thank you. People with the skill for this topic will see it.')}
            />
          )}
          {panel === 'history' && <HistoryList articleId={article.id} canRestore={canWrite} onRestored={() => { setPanel(null); setNotice('That version is back as the newest one.'); load(); }} />}
          {flags.length > 0 && (
            <ul className="mt-3 space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100" data-testid="article-flags">
              {flags.map((f, i) => (
                <li key={`${f.at}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="min-w-0 flex-1">“{f.note || 'Flagged'}”</span>
                  <span className="text-xs opacity-80">{f.actor ? `${f.actor.split('@')[0]} · ` : ''}{timeAgo(f.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </header>

        <div className="mt-5 grid gap-8 lg:grid-cols-[minmax(0,1fr)_13rem]">
          {html.trim()
            ? <div ref={bodyRef} className="tp-article min-w-0" dangerouslySetInnerHTML={{ __html: html }} data-testid="article-body" />
            : <p ref={bodyRef} className="text-sm text-muted-foreground">This article has no text yet.</p>}
          {headings.length > 1 && (
            <nav aria-label="On this page" className="hidden text-[13px] lg:block">
              <p className="mb-2 text-xs font-medium text-muted-foreground">On this page</p>
              <ul className="space-y-1.5 border-l border-border pl-3">
                {headings.map((x) => (
                  <li key={x.id}><a href={`#${x.id}`} className="tp-focus-ring block rounded text-muted-foreground hover:text-foreground">{x.text}</a></li>
                ))}
              </ul>
            </nav>
          )}
        </div>

        {(article.tags || []).length > 0 && (
          <p className="mt-6 border-t border-border pt-3 text-xs text-muted-foreground">Topics: {article.tags.join(', ')}</p>
        )}
      </div>
    </article>
  );
}
