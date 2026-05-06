import { useEffect, useMemo, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { agentAPI } from '../services/api';

function Icon({ name, className = 'h-4 w-4' }) {
  const LucideIcon = Icons[name] || Icons.Tags;
  return <LucideIcon className={className} />;
}

function normalizeVotes(votes) {
  return {
    participantCount: votes?.participantCount || 0,
    totals: Array.isArray(votes?.totals) ? votes.totals : [],
    mergeSuggestions: Array.isArray(votes?.mergeSuggestions) ? votes.mergeSuggestions : [],
    categorySuggestions: Array.isArray(votes?.categorySuggestions) ? votes.categorySuggestions : [],
  };
}

function voteCount(votes, itemId, voteType = 'support') {
  return votes?.totals?.find((vote) => vote.itemId === itemId && vote.voteType === voteType)?.count || 0;
}

function totalVoteCount(votes) {
  return (votes?.totals || []).reduce((sum, vote) => sum + (vote.count || 0), 0);
}

function activeCategories(state) {
  return (state?.categories || [])
    .filter((category) => !category.deleted)
    .map((category) => ({
      ...category,
      subcategories: (category.subcategories || []).filter((subcategory) => !subcategory.deleted),
    }));
}

function suggestionSupportItem(suggestion) {
  return {
    id: suggestion.itemId,
    name: suggestion.itemLabel,
    icon: suggestion.value?.scope === 'subcategory' ? 'Tag' : 'Lightbulb',
    color: '#f59e0b',
  };
}

function Toast({ toast, onClose }) {
  const tone = toast.tone === 'amber'
    ? 'border-amber-300 bg-amber-50 text-amber-950'
    : toast.tone === 'emerald'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-950'
      : 'border-cyan-300 bg-cyan-50 text-cyan-950';
  const LucideIcon = Icons[toast.icon] || Icons.Sparkles;
  return (
    <div className={`animate-[summitCategoriesToast_.18s_ease-out] rounded-xl border ${tone} p-3 shadow-2xl`}>
      <div className="flex gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/70">
          <LucideIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{toast.title}</div>
          <div className="mt-0.5 text-sm opacity-80">{toast.message}</div>
        </div>
        <button type="button" onClick={onClose} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg opacity-60 transition hover:bg-white/60 hover:opacity-100" aria-label="Close notification">
          <Icons.X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default function ItSummitCategoriesPanel() {
  const [session, setSession] = useState(null);
  const [votes, setVotes] = useState(() => normalizeVotes());
  const [myVotes, setMyVotes] = useState({});
  const [query, setQuery] = useState('');
  const [ideaName, setIdeaName] = useState('');
  const [ideaReason, setIdeaReason] = useState('');
  const [quickSubcategoryNames, setQuickSubcategoryNames] = useState({});
  const [highlightIds, setHighlightIds] = useState({});
  const [toasts, setToasts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const votesRef = useRef(normalizeVotes());
  const myVotesRef = useRef({});

  const categories = useMemo(() => activeCategories(session?.state), [session?.state]);
  const subcategorySuggestionsByParent = useMemo(() => {
    const map = new Map();
    for (const suggestion of votes.categorySuggestions || []) {
      if (suggestion.value?.scope !== 'subcategory' || !suggestion.value?.parentId) continue;
      if (!map.has(suggestion.value.parentId)) map.set(suggestion.value.parentId, []);
      map.get(suggestion.value.parentId).push(suggestion);
    }
    return map;
  }, [votes.categorySuggestions]);

  const filteredCategories = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return categories;
    return categories.filter((category) => (
      category.name.toLowerCase().includes(needle)
      || String(category.description || '').toLowerCase().includes(needle)
      || (category.subcategories || []).some((sub) => sub.name.toLowerCase().includes(needle))
      || (subcategorySuggestionsByParent.get(category.id) || []).some((suggestion) => (
        suggestion.itemLabel.toLowerCase().includes(needle)
        || String(suggestion.value?.reason || '').toLowerCase().includes(needle)
      ))
    ));
  }, [categories, query, subcategorySuggestionsByParent]);

  const roomIdeaCounts = useMemo(() => {
    const ideas = votes.categorySuggestions || [];
    return {
      top: ideas.filter((idea) => idea.value?.scope !== 'subcategory').length,
      sub: ideas.filter((idea) => idea.value?.scope === 'subcategory').length,
    };
  }, [votes.categorySuggestions]);

  const pushToast = (title, message, tone = 'cyan', icon = 'Sparkles') => {
    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setToasts((current) => [...current.slice(-2), { id, title, message, tone, icon }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4500);
  };

  const markHighlight = (id) => {
    setHighlightIds((current) => ({ ...current, [id]: true }));
    window.setTimeout(() => {
      setHighlightIds((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }, 1600);
  };

  const applyVotes = (nextVotes, { silent = false } = {}) => {
    const normalized = normalizeVotes(nextVotes);
    if (!silent) {
      const previous = votesRef.current || normalizeVotes();
      const previousCounts = new Map(previous.totals.filter((vote) => vote.voteType === 'support').map((vote) => [vote.itemId, vote.count || 0]));
      for (const vote of normalized.totals.filter((row) => row.voteType === 'support')) {
        if ((vote.count || 0) !== (previousCounts.get(vote.itemId) || 0)) markHighlight(`vote-${vote.itemId}`);
      }
      if ((normalized.categorySuggestions || []).length > (previous.categorySuggestions || []).length) {
        markHighlight('ideas');
      }
    }
    votesRef.current = normalized;
    setVotes(normalized);
  };

  useEffect(() => {
    let cancelled = false;
    let source = null;
    agentAPI.getSummitWorkshop()
      .then((res) => {
        if (cancelled) return;
        setSession(res.session);
        applyVotes(res.votes, { silent: true });
        setMyVotes(res.myVotes || {});
        myVotesRef.current = res.myVotes || {};
      })
      .catch((err) => setError(err.message || 'Could not load summit categories.'))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    try {
      source = agentAPI.getSummitWorkshopEventSource();
      source.addEventListener('state', (event) => setSession(JSON.parse(event.data)));
      source.addEventListener('votes', (event) => applyVotes(JSON.parse(event.data)));
      source.addEventListener('my-votes', (event) => {
        const next = JSON.parse(event.data) || {};
        myVotesRef.current = next;
        setMyVotes(next);
      });
      source.addEventListener('participant-reset', () => {
        myVotesRef.current = {};
        setMyVotes({});
        pushToast('Votes reset', 'Your category votes were reset by the facilitator.', 'amber', 'RotateCcw');
      });
      source.onerror = () => {
        // EventSource will retry on transient restarts.
      };
    } catch {
      // The initial HTTP load is still enough for non-live use.
    }

    return () => {
      cancelled = true;
      source?.close?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    myVotesRef.current = myVotes;
  }, [myVotes]);

  const submitVote = async (body, optimisticItemId = null) => {
    const res = await agentAPI.voteSummitCategory(body);
    applyVotes(res.votes, { silent: true });
    if (res.myVotes) {
      myVotesRef.current = res.myVotes;
      setMyVotes(res.myVotes);
    }
    if (optimisticItemId) markHighlight(`vote-${optimisticItemId}`);
  };

  const toggleVote = async (item, itemType = 'category') => {
    const active = !myVotesRef.current[item.id];
    setMyVotes((current) => ({ ...current, [item.id]: active }));
    try {
      await submitVote({
        itemId: item.id,
        itemLabel: item.name,
        itemType,
        voteType: 'support',
        active,
      }, item.id);
    } catch (err) {
      setMyVotes((current) => ({ ...current, [item.id]: !active }));
      pushToast('Vote failed', err.message || 'Could not save your vote.', 'amber', 'AlertCircle');
    }
  };

  const submitTopIdea = async (event) => {
    event.preventDefault();
    const name = ideaName.trim();
    if (!name) return;
    try {
      const res = await agentAPI.voteSummitCategory({
        itemLabel: name,
        itemType: 'category_suggestion',
        voteType: 'new_category_suggestion',
        value: {
          scope: 'top',
          reason: ideaReason.trim(),
        },
      });
      applyVotes(res.votes, { silent: true });
      setIdeaName('');
      setIdeaReason('');
      markHighlight('ideas');
      pushToast('Suggestion submitted', `${name} was added to room ideas.`, 'amber', 'Lightbulb');
    } catch (err) {
      pushToast('Suggestion failed', err.message || 'Could not submit the idea.', 'amber', 'AlertCircle');
    }
  };

  const submitQuickSubcategory = async (event, category) => {
    event.preventDefault();
    const name = String(quickSubcategoryNames[category.id] || '').trim();
    if (!name) return;
    try {
      const res = await agentAPI.voteSummitCategory({
        itemLabel: name,
        itemType: 'subcategory_suggestion',
        voteType: 'new_category_suggestion',
        value: {
          scope: 'subcategory',
          parentId: category.id,
          parentName: category.name,
          reason: '',
        },
      });
      applyVotes(res.votes, { silent: true });
      setQuickSubcategoryNames((current) => ({ ...current, [category.id]: '' }));
      markHighlight(`category-${category.id}`);
      pushToast('Subcategory suggested', `${name} was added under ${category.name}.`, 'amber', 'Tag');
    } catch (err) {
      pushToast('Suggestion failed', err.message || 'Could not submit the subcategory.', 'amber', 'AlertCircle');
    }
  };

  if (loading) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <Icons.Loader2 className="mx-auto h-7 w-7 animate-spin text-blue-600" />
        <p className="mt-3 text-sm text-slate-500">Loading category voting...</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-2xl border border-red-200 bg-red-50 p-5 text-red-800 shadow-sm">
        <div className="flex items-center gap-2 font-semibold"><Icons.AlertCircle className="h-5 w-5" />{error}</div>
      </section>
    );
  }

  return (
    <section className="relative space-y-4">
      <style>{`
        @keyframes summitCategoriesToast { from { opacity: 0; transform: translate3d(12px, -8px, 0) scale(.98); } to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); } }
        @keyframes summitCategoriesPulse { 0% { box-shadow: 0 0 0 0 rgba(6, 182, 212, .0); } 35% { box-shadow: 0 0 0 5px rgba(6, 182, 212, .22); } 100% { box-shadow: 0 0 0 0 rgba(6, 182, 212, 0); } }
        .summit-categories-pulse { animation: summitCategoriesPulse 1.3s ease-out; }
        @media (prefers-reduced-motion: reduce) {
          .summit-categories-pulse, .animate-\\[summitCategoriesToast_\\.18s_ease-out\\] { animation: none; }
        }
      `}</style>

      <div className="fixed right-4 top-20 z-50 grid w-[min(420px,calc(100vw-2rem))] gap-2">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} onClose={() => setToasts((current) => current.filter((item) => item.id !== toast.id))} />
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-100 text-cyan-700">
              <Icons.Tags className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-2xl font-semibold text-slate-950">Categories & Skills</h2>
              <p className="mt-1 text-sm text-slate-600">Vote on the proposed category list and suggest missing categories or subcategories.</p>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-cyan-200 bg-white p-3 shadow-sm">
            <div className="text-xs font-semibold uppercase text-slate-500">People</div>
            <div className="mt-2 text-2xl font-bold text-cyan-700">{votes.participantCount}</div>
          </div>
          <div className="rounded-xl border border-blue-200 bg-white p-3 shadow-sm">
            <div className="text-xs font-semibold uppercase text-slate-500">Votes</div>
            <div className="mt-2 text-2xl font-bold text-blue-700">{totalVoteCount(votes)}</div>
          </div>
          <div className={`rounded-xl border border-amber-200 bg-white p-3 shadow-sm transition ${highlightIds.ideas ? 'summit-categories-pulse' : ''}`}>
            <div className="text-xs font-semibold uppercase text-slate-500">Ideas</div>
            <div className="mt-2 text-2xl font-bold text-amber-700">{votes.categorySuggestions.length}</div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          <div className="sticky top-20 z-20 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur">
            <div className="relative">
              <Icons.Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search categories or subcategories"
                className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-cyan-300 focus:bg-white focus:ring-2 focus:ring-cyan-100"
              />
            </div>
          </div>

          {filteredCategories.map((category) => {
            const suggestions = subcategorySuggestionsByParent.get(category.id) || [];
            return (
              <article
                key={category.id}
                className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-cyan-200 hover:shadow-md ${
                  highlightIds[`category-${category.id}`] || highlightIds[`vote-${category.id}`] ? 'summit-categories-pulse ring-2 ring-cyan-100' : ''
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white" style={{ backgroundColor: category.color }}>
                    <Icon name={category.icon} className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-lg font-semibold leading-tight text-slate-950">{category.name}</h3>
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-500">{category.subcategories.length} subcategories</span>
                      {!!suggestions.length && <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">{suggestions.length} ideas</span>}
                    </div>
                    <p className="mt-1 text-sm leading-5 text-slate-600">{category.description}</p>
                  </div>
                  <button
                    type="button"
                    aria-pressed={Boolean(myVotes[category.id])}
                    onClick={() => toggleVote(category, 'category')}
                    className={`flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition active:scale-[0.97] ${
                      myVotes[category.id] ? 'bg-cyan-100 text-cyan-900 ring-2 ring-cyan-200' : 'bg-slate-100 text-slate-600 hover:bg-cyan-50 hover:text-cyan-800'
                    }`}
                  >
                    <Icons.ThumbsUp className="h-4 w-4" />
                    {voteCount(votes, category.id)}
                  </button>
                </div>

                <div className="mt-4 grid gap-2 md:grid-cols-2">
                  {category.subcategories.map((subcategory) => (
                    <button
                      key={subcategory.id}
                      type="button"
                      aria-pressed={Boolean(myVotes[subcategory.id])}
                      onClick={() => toggleVote({ ...subcategory, color: category.color }, 'subcategory')}
                      className={`flex min-h-[52px] items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-all duration-200 active:scale-[0.99] ${
                        highlightIds[`vote-${subcategory.id}`] ? 'summit-categories-pulse' : ''
                      } ${myVotes[subcategory.id] ? 'border-cyan-300 bg-cyan-50 text-cyan-950 ring-1 ring-cyan-200' : 'border-slate-200 bg-slate-50 text-slate-800 hover:border-cyan-200 hover:bg-white'}`}
                    >
                      <Icon name={subcategory.icon || 'Tag'} className="h-4 w-4 shrink-0 text-slate-500" />
                      <span className="min-w-0 flex-1 leading-snug">{subcategory.name}</span>
                      <span className={`flex min-h-8 min-w-8 items-center justify-center rounded-lg px-2 text-xs font-semibold ${myVotes[subcategory.id] ? 'bg-cyan-100 text-cyan-900' : 'bg-white text-slate-500'}`}>
                        {voteCount(votes, subcategory.id) || <Icons.ThumbsUp className="h-3.5 w-3.5" />}
                      </span>
                    </button>
                  ))}

                  {suggestions.map((suggestion) => {
                    const item = suggestionSupportItem(suggestion);
                    return (
                      <button
                        key={suggestion.id}
                        type="button"
                        aria-pressed={Boolean(myVotes[item.id])}
                        onClick={() => toggleVote(item, 'suggestion')}
                        className={`flex min-h-[62px] items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-all duration-200 active:scale-[0.99] ${
                          highlightIds[`idea-${item.id}`] || highlightIds[`vote-${item.id}`] ? 'summit-categories-pulse' : ''
                        } ${myVotes[item.id] ? 'border-amber-300 bg-amber-50 text-amber-950 ring-1 ring-amber-200' : 'border-amber-200 bg-amber-50/70 text-slate-800 hover:border-amber-300 hover:bg-amber-50'}`}
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-200 text-amber-900">
                          <Icons.Tag className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold leading-snug">{suggestion.itemLabel}</span>
                          <span className="text-xs text-amber-800">Suggested by {suggestion.participantName}</span>
                        </span>
                        <span className={`flex min-h-8 min-w-8 items-center justify-center rounded-lg px-2 text-xs font-semibold ${myVotes[item.id] ? 'bg-amber-200 text-amber-950' : 'bg-white text-amber-700'}`}>
                          {voteCount(votes, item.id) || <Icons.ThumbsUp className="h-3.5 w-3.5" />}
                        </span>
                      </button>
                    );
                  })}

                  <form onSubmit={(event) => submitQuickSubcategory(event, category)} className="flex min-h-[52px] items-center gap-2 rounded-xl border border-dashed border-amber-300 bg-amber-50/50 px-3 py-2">
                    <Icons.Plus className="h-4 w-4 shrink-0 text-amber-700" />
                    <input
                      value={quickSubcategoryNames[category.id] || ''}
                      onChange={(event) => setQuickSubcategoryNames((current) => ({ ...current, [category.id]: event.target.value }))}
                      placeholder={`Suggest subcategory under ${category.name}`}
                      className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
                    />
                    <button
                      type="submit"
                      disabled={!String(quickSubcategoryNames[category.id] || '').trim()}
                      className="rounded-lg bg-amber-200 px-3 py-2 text-xs font-semibold text-amber-950 transition hover:bg-amber-300 disabled:opacity-40"
                    >
                      Add
                    </button>
                  </form>
                </div>
              </article>
            );
          })}
        </div>

        <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
          <form onSubmit={submitTopIdea} className="rounded-2xl border border-amber-200 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-800">
                <Icons.Lightbulb className="h-5 w-5" />
              </span>
              <div>
                <h3 className="font-semibold text-slate-950">Suggest a new category</h3>
                <p className="text-xs text-slate-500">For subcategories, use the row inside each category.</p>
              </div>
            </div>
            <input
              value={ideaName}
              onChange={(event) => setIdeaName(event.target.value)}
              className="mt-3 h-11 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-amber-300 focus:bg-white focus:ring-2 focus:ring-amber-100"
              placeholder="New top category name"
            />
            <textarea
              value={ideaReason}
              onChange={(event) => setIdeaReason(event.target.value)}
              className="mt-2 min-h-24 w-full resize-y rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-amber-300 focus:bg-white focus:ring-2 focus:ring-amber-100"
              placeholder="Why should we consider it?"
            />
            <button disabled={!ideaName.trim()} className="mt-3 h-10 w-full rounded-lg bg-amber-300 px-4 text-sm font-semibold text-amber-950 transition hover:bg-amber-200 disabled:opacity-40">
              Submit idea
            </button>
          </form>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-slate-950">Room ideas</h3>
                <p className="mt-1 text-xs text-slate-500">Vote here or inside the matching category card.</p>
              </div>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{votes.categorySuggestions.length}</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-center">
                <div className="text-xl font-semibold text-slate-950">{roomIdeaCounts.top}</div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Top</div>
              </div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-center">
                <div className="text-xl font-semibold text-amber-800">{roomIdeaCounts.sub}</div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">Sub</div>
              </div>
            </div>
            <div className="mt-3 max-h-[34rem] space-y-2 overflow-auto pr-1">
              {(votes.categorySuggestions || []).map((suggestion) => {
                const item = suggestionSupportItem(suggestion);
                const isSubcategory = suggestion.value?.scope === 'subcategory';
                return (
                  <div key={suggestion.id} className={`rounded-xl border p-3 transition-all duration-300 ${highlightIds[`vote-${item.id}`] ? 'summit-categories-pulse' : ''} ${isSubcategory ? 'border-amber-200 bg-amber-50/70' : 'border-slate-200 bg-slate-50'}`}>
                    <div className="flex items-start gap-3">
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${isSubcategory ? 'bg-amber-200 text-amber-950' : 'bg-cyan-100 text-cyan-800'}`}>
                        <Icon name={item.icon} className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold leading-tight text-slate-950">{suggestion.itemLabel}</div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          <span className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-slate-600">by {suggestion.participantName}</span>
                          <span className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-slate-600">{isSubcategory ? 'Subcategory' : 'Top category'}</span>
                          {suggestion.value?.parentName && <span className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-slate-600">{suggestion.value.parentName}</span>}
                        </div>
                        {suggestion.value?.reason && <p className="mt-2 text-sm leading-5 text-slate-600">{suggestion.value.reason}</p>}
                      </div>
                      <button
                        type="button"
                        aria-pressed={Boolean(myVotes[item.id])}
                        onClick={() => toggleVote(item, 'suggestion')}
                        className={`flex min-h-9 items-center gap-1 rounded-lg px-3 text-sm font-semibold transition active:scale-[0.97] ${myVotes[item.id] ? 'bg-cyan-100 text-cyan-900' : 'bg-white text-slate-600 hover:bg-cyan-50 hover:text-cyan-800'}`}
                      >
                        <Icons.ThumbsUp className="h-4 w-4" />
                        {voteCount(votes, item.id)}
                      </button>
                    </div>
                  </div>
                );
              })}
              {!votes.categorySuggestions.length && (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
                  New category suggestions will appear here.
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}
