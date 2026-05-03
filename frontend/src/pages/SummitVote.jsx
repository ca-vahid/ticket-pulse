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

export default function SummitVote() {
  const { token } = useParams();
  const storageKey = `summit_vote_${token}`;
  const [session, setSession] = useState(null);
  const [votes, setVotes] = useState({ participantCount: 0, totals: [], mergeSuggestions: [] });
  const [displayName, setDisplayName] = useState('');
  const [participantKey, setParticipantKey] = useState('');
  const [myVotes, setMyVotes] = useState({});
  const [mergeFrom, setMergeFrom] = useState('');
  const [mergeTo, setMergeTo] = useState('');
  const [mergeReason, setMergeReason] = useState('');
  const [error, setError] = useState('');
  const [joining, setJoining] = useState(false);

  const categories = useMemo(() => (session?.state?.categories || []).filter(c => !c.deleted), [session]);
  const isJoined = Boolean(participantKey && displayName);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
      if (stored.displayName) setDisplayName(stored.displayName);
      if (stored.participantKey) setParticipantKey(stored.participantKey);
      if (stored.myVotes) setMyVotes(stored.myVotes);
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
        setVotes(res.votes || { participantCount: 0, totals: [], mergeSuggestions: [] });
      })
      .catch((err) => setError(err.message || 'Voting link is not available'));
    const source = summitAPI.getPublicEventSource(token);
    source.addEventListener('state', (event) => setSession(JSON.parse(event.data)));
    source.addEventListener('votes', (event) => setVotes(JSON.parse(event.data)));
    source.onerror = () => {};
    return () => {
      cancelled = true;
      source.close();
    };
  }, [token]);

  useEffect(() => {
    if (!displayName && !participantKey) return;
    localStorage.setItem(storageKey, JSON.stringify({ displayName, participantKey, myVotes }));
  }, [displayName, participantKey, myVotes, storageKey]);

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

  const toggleVote = async (item, itemType = 'category') => {
    if (!participantKey) return;
    const active = !myVotes[item.id];
    setMyVotes(prev => ({ ...prev, [item.id]: active }));
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

  if (error && !session) {
    return (
      <div className="min-h-screen bg-slate-950 p-4 text-white">
        <div className="mx-auto mt-20 max-w-lg rounded-lg border border-red-400/30 bg-red-500/10 p-6">
          <Icons.AlertTriangle className="h-8 w-8 text-red-300" />
          <h1 className="mt-3 text-xl font-semibold">Voting unavailable</h1>
          <p className="mt-2 text-sm text-red-100">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <header className="mb-6 rounded-lg border border-white/10 bg-white/5 p-5 shadow-xl">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-cyan-200">
                <Icons.Sparkles className="h-4 w-4" />
                BGC Engineering IT Summit
              </div>
              <h1 className="mt-2 text-2xl font-semibold">Taxonomy live voting</h1>
              <p className="mt-1 text-sm text-slate-300">Vote on categories you support and suggest top-level groups to combine.</p>
            </div>
            <div className="rounded-lg bg-cyan-400 px-4 py-3 text-slate-950">
              <div className="text-xs font-medium uppercase">Participants</div>
              <div className="text-2xl font-semibold">{votes.participantCount || 0}</div>
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
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
              <div className="text-sm text-slate-200">Voting as <span className="font-semibold text-white">{displayName}</span></div>
              <div className="text-xs text-slate-400">Link expires {session?.voteExpiresAt ? new Date(session.voteExpiresAt).toLocaleTimeString() : ''}</div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {categories.map((cat) => (
                <div key={cat.id} className="rounded-lg border border-white/10 bg-white p-4 text-slate-900 shadow-lg">
                  <div className="flex items-start gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white" style={{ backgroundColor: cat.color }}>
                      <Icon name={cat.icon} className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="font-semibold">{cat.name}</h2>
                      <p className="mt-1 line-clamp-2 text-xs text-slate-500">{cat.description}</p>
                    </div>
                    <button
                      onClick={() => toggleVote(cat, 'category')}
                      className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${myVotes[cat.id] ? 'bg-cyan-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
                    >
                      <Icons.ThumbsUp className="mr-1 inline h-4 w-4" />
                      {voteCount(votes, cat.id)}
                    </button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {(cat.subcategories || []).filter(s => !s.deleted).slice(0, 10).map(sub => (
                      <button
                        key={sub.id}
                        onClick={() => toggleVote(sub, 'subcategory')}
                        className={`rounded-full border px-2 py-1 text-xs transition ${myVotes[sub.id] ? 'border-cyan-500 bg-cyan-50 text-cyan-800' : 'border-slate-200 bg-slate-50 text-slate-600'}`}
                        title="Vote for this subcategory"
                      >
                        {sub.name} {voteCount(votes, sub.id) ? `(${voteCount(votes, sub.id)})` : ''}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <form onSubmit={submitMerge} className="mt-5 rounded-lg border border-white/10 bg-white p-4 text-slate-900 shadow-lg">
              <h2 className="text-base font-semibold">Suggest a merge</h2>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <select value={mergeFrom} onChange={(e) => setMergeFrom(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2">
                  <option value="">First category</option>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <select value={mergeTo} onChange={(e) => setMergeTo(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2">
                  <option value="">Second category</option>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <input value={mergeReason} onChange={(e) => setMergeReason(e.target.value)} className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2" placeholder="Optional reason" />
              <button disabled={!mergeFrom || !mergeTo || mergeFrom === mergeTo} className="mt-3 rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                Submit merge suggestion
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
