import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { summitAPI } from '../services/api';

function Icon({ name, className = 'h-4 w-4' }) {
  const LucideIcon = Icons[name] || Icons.Tags;
  return <LucideIcon className={className} />;
}

function voteCount(votes, itemId, voteType = 'support') {
  return votes?.totals?.find(v => v.itemId === itemId && v.voteType === voteType)?.count || 0;
}

function compactText(value, max = 130) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max).trim()}...` : text;
}

function categoryOptionLabel(category) {
  return category?.name || '';
}

export default function SummitVote() {
  const { token } = useParams();
  const storageKey = `summit_vote_${token}`;
  const [session, setSession] = useState(null);
  const [votes, setVotes] = useState({ participantCount: 0, totals: [], mergeSuggestions: [], categorySuggestions: [] });
  const [displayName, setDisplayName] = useState('');
  const [participantKey, setParticipantKey] = useState('');
  const [myVotes, setMyVotes] = useState({});
  const [priorityItems, setPriorityItems] = useState([]);
  const [dragItem, setDragItem] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [query, setQuery] = useState('');
  const [mergeFrom, setMergeFrom] = useState('');
  const [mergeTo, setMergeTo] = useState('');
  const [mergeReason, setMergeReason] = useState('');
  const [ideaName, setIdeaName] = useState('');
  const [ideaParentId, setIdeaParentId] = useState('');
  const [ideaReason, setIdeaReason] = useState('');
  const [ideaScope, setIdeaScope] = useState('top_category');
  const [error, setError] = useState('');
  const [expiredMessage, setExpiredMessage] = useState('');
  const [joining, setJoining] = useState(false);

  const categories = useMemo(() => (session?.state?.categories || []).filter(c => !c.deleted), [session]);
  const filteredCategories = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return categories;
    return categories.filter((category) => {
      if (category.name.toLowerCase().includes(needle)) return true;
      return (category.subcategories || []).some(sub => sub.name.toLowerCase().includes(needle));
    });
  }, [categories, query]);
  const isJoined = Boolean(participantKey && displayName);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
      if (stored.displayName) setDisplayName(stored.displayName);
      if (stored.participantKey) setParticipantKey(stored.participantKey);
      if (stored.myVotes) setMyVotes(stored.myVotes);
      if (stored.priorityItems) setPriorityItems(stored.priorityItems);
    } catch {
      // ignore bad local state
    }
  }, [storageKey]);

  useEffect(() => {
    let cancelled = false;
    summitAPI.getPublicWorkshop(token)
      .then((res) => {
        if (cancelled) return;
        setSession(res.session);
        setVotes(res.votes || { participantCount: 0, totals: [], mergeSuggestions: [], categorySuggestions: [] });
      })
      .catch((err) => setError(err.message || 'Voting link is not available'));
    const source = summitAPI.getPublicEventSource(token);
    source.addEventListener('state', (event) => setSession(JSON.parse(event.data)));
    source.addEventListener('votes', (event) => setVotes(JSON.parse(event.data)));
    source.addEventListener('expired', (event) => {
      try {
        const payload = JSON.parse(event.data);
        setExpiredMessage(payload.message || 'The facilitator regenerated the voting link.');
      } catch {
        setExpiredMessage('The facilitator regenerated the voting link.');
      }
      source.close();
    });
    source.onerror = () => {};
    return () => {
      cancelled = true;
      source.close();
    };
  }, [token]);

  useEffect(() => {
    if (!displayName && !participantKey) return;
    localStorage.setItem(storageKey, JSON.stringify({ displayName, participantKey, myVotes, priorityItems }));
  }, [displayName, participantKey, myVotes, priorityItems, storageKey]);

  const join = async (event) => {
    event.preventDefault();
    setJoining(true);
    setError('');
    try {
      const res = await summitAPI.joinPublicWorkshop(token, { displayName, participantKey: participantKey || null });
      setParticipantKey(res.participant.participantKey);
      setDisplayName(res.participant.displayName);
      setVotes(res.votes || votes);
    } catch (err) {
      setError(err.message || 'Could not join');
    } finally {
      setJoining(false);
    }
  };

  const toggleVote = async (item, itemType = 'category', forceActive = null) => {
    if (!participantKey) return;
    const active = forceActive === null ? !myVotes[item.id] : forceActive;
    setMyVotes(prev => ({ ...prev, [item.id]: active }));
    setPriorityItems(prev => {
      const without = prev.filter(p => p.id !== item.id);
      if (!active) return without;
      return [...without, { id: item.id, name: item.name, icon: item.icon || 'Tag', color: item.color || '#0891b2', itemType }];
    });
    try {
      const res = await summitAPI.submitVote(token, {
        participantKey,
        itemId: item.id,
        itemType,
        itemLabel: item.name,
        voteType: 'support',
        active,
      });
      setVotes(res.votes || votes);
    } catch (err) {
      setError(err.message || 'Vote failed');
      setMyVotes(prev => ({ ...prev, [item.id]: !active }));
    }
  };

  const dropVote = (event) => {
    event.preventDefault();
    if (!dragItem) return;
    toggleVote(dragItem, dragItem.itemType, true);
    setDragItem(null);
  };

  const removePriority = (item) => {
    toggleVote(item, item.itemType, false);
  };

  const submitMerge = async (event) => {
    event.preventDefault();
    if (!mergeFrom || !mergeTo || !participantKey) return;
    const from = categories.find(c => c.id === mergeFrom)?.name || mergeFrom;
    const to = categories.find(c => c.id === mergeTo)?.name || mergeTo;
    try {
      const res = await summitAPI.submitVote(token, {
        participantKey,
        itemId: `${mergeFrom}_${mergeTo}`,
        itemType: 'merge',
        itemLabel: `${from} + ${to}`,
        voteType: 'merge_suggestion',
        value: { from, to, reason: mergeReason },
      });
      setVotes(res.votes || votes);
      setMergeReason('');
    } catch (err) {
      setError(err.message || 'Suggestion failed');
    }
  };

  const submitIdea = async (event) => {
    event.preventDefault();
    const name = ideaName.trim();
    if (!name || !participantKey) return;
    const parent = categories.find(c => c.id === ideaParentId);
    try {
      const res = await summitAPI.submitVote(token, {
        participantKey,
        itemType: ideaScope,
        itemLabel: name,
        voteType: 'new_category_suggestion',
        value: {
          name,
          scope: ideaScope,
          parentId: parent?.id || null,
          parentName: parent?.name || null,
          reason: ideaReason.trim(),
        },
      });
      setVotes(res.votes || votes);
      setIdeaName('');
      setIdeaReason('');
      setIdeaParentId('');
      setIdeaScope('top_category');
    } catch (err) {
      setError(err.message || 'Suggestion failed');
    }
  };

  const suggestionSupportItem = (suggestion) => ({
    id: suggestion.itemId,
    name: suggestion.itemLabel,
    icon: suggestion.value?.scope === 'subcategory' ? 'Tag' : 'Lightbulb',
    color: '#f59e0b',
  });

  if ((error && !session) || expiredMessage) {
    return (
      <div className="min-h-screen bg-slate-950 p-4 text-white">
        <div className="mx-auto mt-20 max-w-lg rounded-lg border border-amber-400/30 bg-amber-500/10 p-6">
          <Icons.AlertTriangle className="h-8 w-8 text-amber-300" />
          <h1 className="mt-3 text-xl font-semibold">Voting link expired</h1>
          <p className="mt-2 text-sm text-amber-100">{expiredMessage || error}</p>
          <p className="mt-3 text-sm text-slate-300">Ask the facilitator for the new shared voting link.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-7xl px-4 py-6">
        <header className="mb-5 overflow-hidden rounded-lg border border-white/10 bg-white/5 shadow-xl">
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-cyan-200">
                <Icons.Sparkles className="h-4 w-4" />
                BGC Engineering IT Summit
              </div>
              <h1 className="mt-2 text-2xl font-semibold">Taxonomy live voting</h1>
              <p className="mt-1 text-sm text-slate-300">Drag cards into your priority tray, vote on ideas, and suggest missing categories.</p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-slate-950">
              <div className="rounded-lg bg-cyan-400 px-4 py-3">
                <div className="text-xs font-medium uppercase">Participants</div>
                <div className="text-2xl font-semibold">{votes.participantCount || 0}</div>
              </div>
              <div className="rounded-lg bg-amber-300 px-4 py-3">
                <div className="text-xs font-medium uppercase">New ideas</div>
                <div className="text-2xl font-semibold">{votes.categorySuggestions?.length || 0}</div>
              </div>
            </div>
          </div>
        </header>

        {!isJoined ? (
          <form onSubmit={join} className="mx-auto max-w-md rounded-lg border border-white/10 bg-white p-5 text-slate-900 shadow-xl">
            <h2 className="text-lg font-semibold">Join the session</h2>
            <p className="mt-1 text-sm text-slate-500">Enter your name once. Refreshing the page will keep your votes.</p>
            <label className="mt-4 block text-sm font-medium text-slate-700">Your name</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-900"
              autoFocus
            />
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <button disabled={!displayName.trim() || joining} className="mt-4 w-full rounded-lg bg-slate-950 px-4 py-2 font-semibold text-white disabled:opacity-50">
              {joining ? 'Joining...' : 'Join workshop'}
            </button>
          </form>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[290px_minmax(0,1fr)_360px]">
            <aside className="lg:sticky lg:top-4 lg:self-start">
              <div
                onDragOver={(event) => event.preventDefault()}
                onDrop={dropVote}
                className="rounded-lg border border-cyan-300/40 bg-cyan-400/10 p-4 shadow-xl"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h2 className="font-semibold text-white">My priorities</h2>
                    <p className="mt-1 text-xs text-cyan-100">Drag categories or subcategories here to support them.</p>
                  </div>
                  <Icons.MousePointer2 className="h-5 w-5 text-cyan-200" />
                </div>
                <div className="mt-3 min-h-32 space-y-2 rounded-lg border border-dashed border-cyan-200/40 p-2">
                  {priorityItems.filter(item => myVotes[item.id]).map((item, index) => (
                    <div key={item.id} className="flex items-center gap-2 rounded-lg bg-white px-2 py-2 text-slate-900 shadow-sm">
                      <span className="flex h-7 w-7 items-center justify-center rounded text-white" style={{ backgroundColor: item.color }}>
                        <Icon name={item.icon} className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{index + 1}. {item.name}</span>
                      <button onClick={() => removePriority(item)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Remove vote">
                        <Icons.X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  {!priorityItems.filter(item => myVotes[item.id]).length && (
                    <div className="flex min-h-24 items-center justify-center text-center text-sm text-cyan-100">
                      Drop items here or use the vote buttons.
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-4 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200">
                Voting as <span className="font-semibold text-white">{displayName}</span>
                <div className="mt-1 text-xs text-slate-400">Link expires {session?.voteExpiresAt ? new Date(session.voteExpiresAt).toLocaleTimeString() : ''}</div>
              </div>
            </aside>

            <main className="min-w-0">
              <div className="mb-3 rounded-lg border border-white/10 bg-white/5 p-3">
                <div className="relative">
                  <Icons.Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-slate-900 px-9 py-2 text-sm text-white outline-none placeholder:text-slate-500 focus:border-cyan-300"
                    placeholder="Search categories or subcategories"
                  />
                </div>
              </div>

              <div className="space-y-3">
                {filteredCategories.map((cat) => {
                  const subcategories = (cat.subcategories || []).filter(s => !s.deleted);
                  const isExpanded = expanded[cat.id];
                  const visibleSubcategories = isExpanded ? subcategories : subcategories.slice(0, 4);
                  return (
                    <article
                      key={cat.id}
                      draggable
                      onDragStart={() => setDragItem({ ...cat, itemType: 'category' })}
                      className="rounded-lg border border-white/10 bg-white p-4 text-slate-900 shadow-lg transition hover:-translate-y-0.5 hover:shadow-xl"
                    >
                      <div className="flex items-start gap-3">
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white" style={{ backgroundColor: cat.color }}>
                          <Icon name={cat.icon} className="h-5 w-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-base font-semibold">{cat.name}</h2>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{subcategories.length} subcategories</span>
                          </div>
                          <p className="mt-1 text-sm text-slate-500">{compactText(cat.description)}</p>
                        </div>
                        <button
                          onClick={() => toggleVote(cat, 'category')}
                          className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${myVotes[cat.id] ? 'bg-cyan-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
                        >
                          <Icons.ThumbsUp className="mr-1 inline h-4 w-4" />
                          {voteCount(votes, cat.id)}
                        </button>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {visibleSubcategories.map(sub => (
                          <button
                            key={sub.id}
                            draggable
                            onDragStart={() => setDragItem({ ...sub, color: cat.color, itemType: 'subcategory' })}
                            onClick={() => toggleVote({ ...sub, color: cat.color }, 'subcategory')}
                            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${myVotes[sub.id] ? 'border-cyan-500 bg-cyan-50 text-cyan-900' : 'border-slate-200 bg-slate-50 text-slate-650 hover:border-slate-300 hover:bg-white'}`}
                          >
                            <Icon name={sub.icon || 'Tag'} className="h-4 w-4 text-slate-500" />
                            <span className="min-w-0 flex-1 truncate">{sub.name}</span>
                            <span className="text-xs text-slate-400">{voteCount(votes, sub.id) || ''}</span>
                          </button>
                        ))}
                      </div>
                      {subcategories.length > 4 && (
                        <button
                          onClick={() => setExpanded(prev => ({ ...prev, [cat.id]: !prev[cat.id] }))}
                          className="mt-3 text-sm font-semibold text-cyan-700 hover:text-cyan-900"
                        >
                          {isExpanded ? 'Show fewer subcategories' : `Show ${subcategories.length - 4} more subcategories`}
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            </main>

            <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
              <form onSubmit={submitIdea} className="rounded-lg border border-amber-300/30 bg-amber-300/10 p-4 shadow-xl">
                <div className="flex items-center gap-2">
                  <Icons.Lightbulb className="h-5 w-5 text-amber-200" />
                  <h2 className="font-semibold text-white">Suggest a new category</h2>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-slate-900/70 p-1">
                  <button type="button" onClick={() => setIdeaScope('top_category')} className={`rounded-md px-2 py-1.5 text-sm ${ideaScope === 'top_category' ? 'bg-white text-slate-950' : 'text-slate-300'}`}>Top category</button>
                  <button type="button" onClick={() => setIdeaScope('subcategory')} className={`rounded-md px-2 py-1.5 text-sm ${ideaScope === 'subcategory' ? 'bg-white text-slate-950' : 'text-slate-300'}`}>Subcategory</button>
                </div>
                <input
                  value={ideaName}
                  onChange={(event) => setIdeaName(event.target.value)}
                  className="mt-3 w-full rounded-lg border border-white/10 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-amber-300"
                  placeholder={ideaScope === 'top_category' ? 'New top category name' : 'New subcategory name'}
                />
                {ideaScope === 'subcategory' && (
                  <select value={ideaParentId} onChange={(event) => setIdeaParentId(event.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-white px-3 py-2 text-sm text-slate-900">
                    <option value="">Suggested parent category</option>
                    {categories.map(category => <option key={category.id} value={category.id}>{categoryOptionLabel(category)}</option>)}
                  </select>
                )}
                <textarea
                  value={ideaReason}
                  onChange={(event) => setIdeaReason(event.target.value)}
                  className="mt-2 w-full resize-none rounded-lg border border-white/10 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-amber-300"
                  rows={3}
                  placeholder="Why should we consider it?"
                />
                <button disabled={!ideaName.trim()} className="mt-3 w-full rounded-lg bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">
                  Submit idea
                </button>
              </form>

              <section className="rounded-lg border border-white/10 bg-white/5 p-4 shadow-xl">
                <h2 className="font-semibold text-white">Room ideas</h2>
                <div className="mt-3 max-h-72 space-y-2 overflow-auto">
                  {(votes.categorySuggestions || []).map(suggestion => {
                    const item = suggestionSupportItem(suggestion);
                    return (
                      <div key={suggestion.id} className="rounded-lg bg-white p-3 text-slate-900">
                        <div className="flex items-start gap-2">
                          <Icon name={item.icon} className="mt-0.5 h-4 w-4 text-amber-600" />
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold">{suggestion.itemLabel}</div>
                            <div className="text-xs text-slate-500">
                              Suggested by {suggestion.participantName}
                              {suggestion.value?.parentName ? ` under ${suggestion.value.parentName}` : ''}
                            </div>
                            {suggestion.value?.reason && <p className="mt-1 text-xs text-slate-600">{suggestion.value.reason}</p>}
                          </div>
                          <button
                            onClick={() => toggleVote(item, 'suggestion')}
                            className={`rounded-lg px-2 py-1 text-xs font-semibold ${myVotes[item.id] ? 'bg-cyan-600 text-white' : 'bg-slate-100 text-slate-700'}`}
                          >
                            <Icons.ThumbsUp className="mr-1 inline h-3.5 w-3.5" />
                            {voteCount(votes, item.id)}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {!(votes.categorySuggestions || []).length && <p className="text-sm text-slate-400">New category suggestions will appear here for everyone.</p>}
                </div>
              </section>

              <form onSubmit={submitMerge} className="rounded-lg border border-white/10 bg-white/5 p-4 shadow-xl">
                <div className="flex items-center gap-2">
                  <Icons.Merge className="h-5 w-5 text-cyan-200" />
                  <h2 className="font-semibold text-white">Suggest a merge</h2>
                </div>
                <div className="mt-3 space-y-2">
                  <select value={mergeFrom} onChange={(e) => setMergeFrom(e.target.value)} className="w-full rounded-lg border border-white/10 bg-white px-3 py-2 text-sm text-slate-900">
                    <option value="">First category</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <select value={mergeTo} onChange={(e) => setMergeTo(e.target.value)} className="w-full rounded-lg border border-white/10 bg-white px-3 py-2 text-sm text-slate-900">
                    <option value="">Second category</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <input value={mergeReason} onChange={(e) => setMergeReason(e.target.value)} className="w-full rounded-lg border border-white/10 bg-white px-3 py-2 text-sm text-slate-900" placeholder="Optional reason" />
                </div>
                <button disabled={!mergeFrom || !mergeTo || mergeFrom === mergeTo} className="mt-3 w-full rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">
                  Submit merge suggestion
                </button>
              </form>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
