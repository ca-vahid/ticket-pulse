import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { Inbox as InboxIcon } from 'lucide-react';
import { knowledgeAPI, knowledgeGrowthAPI } from '../../services/api';
import { timeAgo } from '../tickets/ticketUi';
import { EmptyState, Loading, PersonLine, textareaClass } from './knowledgeUi';
import { PanelTabs } from './builderUi';
import { KIND, evidenceWords, impactWords, kindOf } from './inboxFormat';

/**
 * Knowledge → Inbox (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 10): everything
 * that needs a person, in one shape. Each item says what, why, shows its
 * evidence and the proposed change, and takes the same few actions: accept,
 * change it first, dismiss, or put it off for a week. Sorted by how many
 * tickets the change would touch.
 *
 * Keyboard, for working through a list: J / K next and previous, A accept,
 * D dismiss (never while typing).
 */
const clean = (html) => DOMPurify.sanitize(html || '', { USE_PROFILES: { html: true } });

function Proposal({ item }) {
  const p = item.proposed || {};
  const now = item.article?.bodyHtml || '';
  if (item.kind === 'merge') {
    return (
      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          {[item.article, item.otherArticle].filter(Boolean).map((a, i) => (
            <div key={a.id} className="rounded-lg border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">{i === 0 ? 'Kept' : 'Folded in, then archived'}</p>
              <Link to={`/knowledge/library/${a.id}`} target="_blank" rel="noreferrer" className="tp-focus-ring rounded text-sm font-medium text-primary hover:underline">{a.title}</Link>
            </div>
          ))}
        </div>
        {p.bodyHtml && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">The merged text</p>
            <div className="tp-article max-h-96 overflow-auto rounded-lg border border-border p-3" dangerouslySetInnerHTML={{ __html: clean(p.bodyHtml) }} />
          </div>
        )}
      </div>
    );
  }
  if (item.kind === 'edit' && p.bodyHtml) {
    return (
      <div className="grid gap-3 md:grid-cols-2" data-testid="inbox-compare">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Now</p>
          <div className="tp-article max-h-96 overflow-auto rounded-lg border border-border p-3 opacity-80" dangerouslySetInnerHTML={{ __html: clean(now) }} />
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Proposed</p>
          <div className="tp-article max-h-96 overflow-auto rounded-lg border border-primary/40 p-3" dangerouslySetInnerHTML={{ __html: clean(p.bodyHtml) }} />
        </div>
      </div>
    );
  }
  const html = p.sectionHtml || p.bodyHtml || (item.kind === 'review' ? now : '');
  if (!html) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{item.kind === 'add_section' ? 'The section to add' : item.kind === 'review' ? 'Your draft' : 'The proposed article'}</p>
      {(p.title || (item.kind === 'review' && item.article?.title)) && <p className="mb-1 text-sm font-semibold text-foreground">{p.title || item.article.title}</p>}
      <div className="tp-article max-h-[28rem] overflow-auto rounded-lg border border-border p-3" dangerouslySetInnerHTML={{ __html: clean(html) }} />
    </div>
  );
}

function Detail({ id, onDone }) {
  const navigate = useNavigate();
  const [item, setItem] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    setError(null);
    setAnswer('');
    knowledgeAPI.suggestion(id)
      .then((res) => { if (!cancelled) setItem(res?.data || null); })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not open this item'); });
    return () => { cancelled = true; };
  }, [id]);

  const run = async (fn, word) => {
    setBusy(true);
    setError(null);
    try { await fn(); onDone(word); } catch (err) { setError(err?.message || 'That did not work'); } finally { setBusy(false); }
  };

  if (error && !item) return <p className="p-4 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>;
  if (!item) return <Loading label="Opening…" className="py-10" />;
  const k = kindOf(item);
  const tickets = Array.isArray(item.evidence?.ticketIds) ? item.evidence.ticketIds.slice(0, 8) : [];
  // A merge the review found has no merged text: nothing is archived on a guess.
  const bareMerge = item.kind === 'merge' && !item.proposed?.bodyHtml;
  const canDraft = item.kind === 'gap' && item.canDecide && tickets.length > 0;
  // Drafting opens the draft in the editor (it does not go back to the list).
  const draftFromGap = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await knowledgeGrowthAPI.draftFromTickets({ ticketIds: item.evidence.ticketIds, topic: item.title.replace(/^Not written down:\s*/, ''), kind: 'gap' });
      await knowledgeAPI.acceptSuggestion(item.id, {}).catch(() => {});
      const id = res?.data?.article?.id;
      if (id) navigate(`/knowledge/articles/${id}`); else onDone('Drafted');
    } catch (err) {
      setError(err?.message || 'The draft could not be written');
      setBusy(false);
    }
  };
  const editable = item.canDecide && item.articleId && ['review', 'edit', 'add_section', 'flag'].includes(item.kind);

  return (
    <div className="p-4 sm:p-5" data-testid="inbox-detail">
      <p className="text-xs font-medium text-muted-foreground">{k.label}</p>
      <h2 className="mt-0.5 text-base font-semibold leading-snug text-foreground">{item.title}</h2>
      {item.why && <p className="mt-1.5 text-sm leading-relaxed text-foreground/85">{item.why}</p>}
      <p className="mt-1.5 text-xs text-muted-foreground">
        {[evidenceWords(item), impactWords(item), `raised ${timeAgo(item.createdAt)}`].filter(Boolean).join(' · ')}
      </p>
      {tickets.length > 0 && (
        <p className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs">
          <span className="text-muted-foreground">Tickets:</span>
          {tickets.map((t) => <Link key={t} to={`/tickets/${t}`} target="_blank" rel="noreferrer" className="tp-focus-ring rounded text-primary hover:underline">#{t}</Link>)}
        </p>
      )}
      {item.article && item.kind !== 'merge' && (
        <p className="mt-1 text-xs text-muted-foreground">
          Article: <Link to={`/knowledge/library/${item.article.id}`} target="_blank" rel="noreferrer" className="tp-focus-ring rounded text-primary hover:underline">{item.article.title}</Link>
        </p>
      )}

      <div className="mt-4"><Proposal item={item} /></div>

      {item.kind === 'question' && item.canDecide && (
        <div className="mt-4">
          <label htmlFor="inbox-answer" className="block text-sm font-medium text-foreground">Your answer</label>
          <textarea id="inbox-answer" rows={2} maxLength={1000} value={answer} onChange={(e) => setAnswer(e.target.value)} className={`${textareaClass} mt-1`} placeholder="One or two sentences are enough." />
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
        {item.canDecide ? (
          <>
            {canDraft && (
              <button type="button" disabled={busy} onClick={draftFromGap} className="tp-focus-ring h-9 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50" data-testid="inbox-draft">
                {busy ? 'Drafting…' : 'Draft from these tickets'}
              </button>
            )}
            {bareMerge && item.article && (
              <button type="button" disabled={busy} onClick={() => navigate(`/knowledge/articles/${item.article.id}`)} className="tp-focus-ring h-9 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
                Open the kept article in the editor
              </button>
            )}
            <button
              type="button"
              disabled={busy || (item.kind === 'question' && answer.trim().length < 2)}
              onClick={() => run(() => knowledgeAPI.acceptSuggestion(item.id, item.kind === 'question' ? { answer: answer.trim() } : bareMerge ? { keepAsIs: true } : {}), k.done)}
              className={canDraft || bareMerge
                ? 'tp-focus-ring h-9 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50'
                : 'tp-focus-ring h-9 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50'}
              title={bareMerge ? 'The kept article already says everything the other one does' : undefined}
              data-testid="inbox-accept"
            >
              {bareMerge ? 'Archive the other one' : k.accept}
            </button>
            {editable && (
              <button type="button" disabled={busy} onClick={() => navigate(`/knowledge/articles/${item.articleId}`)} className="tp-focus-ring h-9 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted">
                Open in the editor
              </button>
            )}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Deciding this needs the skill for its category.</span>
        )}
        {(item.canDecide || item.mine) && (
          <>
            <button type="button" disabled={busy} onClick={() => run(() => knowledgeAPI.snoozeSuggestion(item.id, { days: 7 }), 'Put off for a week')} className="tp-focus-ring h-9 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted">Not now</button>
            <button type="button" disabled={busy} onClick={() => run(() => knowledgeAPI.dismissSuggestion(item.id, {}), 'Dismissed')} className="tp-focus-ring h-9 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted" data-testid="inbox-dismiss">Dismiss</button>
          </>
        )}
        {(item.assignedTo || []).length > 0 && (
          <span className="ml-auto inline-flex flex-wrap items-center gap-2 text-xs text-muted-foreground">Sent to {item.assignedTo.map((e) => <PersonLine key={e} email={e} className="text-xs" />)}</span>
        )}
      </div>
    </div>
  );
}

export default function InboxPanel({ itemId = null, isAdmin = false }) {
  const navigate = useNavigate();
  const [scope, setScope] = useState('categories');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(() => knowledgeAPI.inbox({ scope })
    .then((res) => { setData(res?.data || { items: [], counts: {} }); setError(null); })
    .catch((err) => { setData({ items: [], counts: {} }); setError(err?.message || 'Could not load the inbox'); }), [scope]);
  useEffect(() => { setData(null); load(); }, [load]);

  const items = useMemo(() => data?.items || [], [data]);
  const selected = itemId ? Number(itemId) : (items[0]?.id ?? null);
  const open = useCallback((id) => navigate(id ? `/knowledge/inbox/${id}` : '/knowledge/inbox'), [navigate]);
  const move = useCallback((step) => {
    if (!items.length) return;
    const i = items.findIndex((x) => x.id === selected);
    const next = items[Math.min(Math.max((i < 0 ? 0 : i) + step, 0), items.length - 1)];
    if (next) open(next.id);
  }, [items, selected, open]);

  // J / K to move, A to accept, D to dismiss: never while typing in a field.
  useEffect(() => {
    const onKey = (e) => {
      const el = e.target;
      if (e.metaKey || e.ctrlKey || e.altKey || (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName)))) return;
      const key = e.key.toLowerCase();
      if (key === 'j') { e.preventDefault(); move(1); }
      if (key === 'k') { e.preventDefault(); move(-1); }
      if (key === 'a') document.querySelector('[data-testid="inbox-accept"]:not(:disabled)')?.click();
      if (key === 'd') document.querySelector('[data-testid="inbox-dismiss"]:not(:disabled)')?.click();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move]);

  const done = async (word) => {
    setNotice(word);
    const i = items.findIndex((x) => x.id === selected);
    const next = items[i + 1] || items[i - 1] || null;
    await load();
    open(next?.id || null);
  };

  const scopes = [
    { id: 'mine', label: `For you${data?.counts?.mine ? ` (${data.counts.mine})` : ''}` },
    { id: 'categories', label: `My categories${data?.counts?.categories ? ` (${data.counts.categories})` : ''}` },
    ...(isAdmin ? [{ id: 'all', label: `Everything${data?.counts?.all ? ` (${data.counts.all})` : ''}` }] : []),
  ];

  return (
    <div data-testid="inbox-panel">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-full max-w-md">
          <PanelTabs tabs={scopes} activeId={scope} onSelect={(id) => { setScope(id); open(null); }} ariaLabel="Whose items" idPrefix="knowledge-inbox" />
        </div>
        {notice && <p className="text-sm text-emerald-700 dark:text-emerald-300" role="status">{notice}.</p>}
        <p className="ml-auto hidden text-xs text-muted-foreground lg:block">J / K to move · A to accept · D to dismiss</p>
      </div>
      {error && <p className="mb-3 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}

      {data === null ? <Loading label="Loading the inbox…" /> : items.length === 0 ? (
        <div className="tp-card">
          <EmptyState icon={InboxIcon} title={scope === 'mine' ? 'Nothing is waiting for you' : 'Nothing is waiting'}>
            Suggestions show up here when someone flags an article, when a draft waits for its author, and when the nightly review finds something to merge, fix or write down.
          </EmptyState>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <ul className="tp-card h-fit divide-y divide-border/60 overflow-hidden p-0" data-testid="inbox-list">
            {items.map((it) => {
              const k = KIND[it.kind] || KIND.flag;
              const active = it.id === selected;
              return (
                <li key={it.id}>
                  <button
                    type="button"
                    onClick={() => open(it.id)}
                    aria-current={active ? 'true' : undefined}
                    className={`tp-focus-ring block w-full px-3.5 py-3 text-left ${active ? 'bg-primary/10' : 'hover:bg-muted/60'}`}
                    data-testid={`inbox-item-${it.id}`}
                  >
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${k.dot}`} aria-hidden="true" />
                      <span>{k.label}</span>
                      {it.mine && <span className="text-primary">· for you</span>}
                      <span className="ml-auto whitespace-nowrap">{timeAgo(it.createdAt)}</span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-sm font-medium text-foreground">{it.title}</span>
                    {impactWords(it) && <span className="mt-0.5 block text-xs text-muted-foreground">{impactWords(it)}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <section className="tp-card min-w-0" aria-label="The selected item">
            {selected ? <Detail key={selected} id={selected} onDone={done} /> : <p className="p-5 text-sm text-muted-foreground">Pick an item on the left.</p>}
          </section>
        </div>
      )}
    </div>
  );
}
