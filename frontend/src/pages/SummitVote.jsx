import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { DndContext, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import * as Icons from 'lucide-react';
import ItSummitFeedbackPanel from '../components/ItSummitFeedbackPanel';
import { summitAPI } from '../services/api';

function Icon({ name, className = 'h-4 w-4' }) {
  const LucideIcon = Icons[name] || Icons.Tags;
  return <LucideIcon className={className} />;
}

function voteCount(votes, itemId, voteType = 'support') {
  return votes?.totals?.find(v => v.itemId === itemId && v.voteType === voteType)?.count || 0;
}

function normalizeVotes(votes) {
  return {
    participantCount: votes?.participantCount || 0,
    totals: Array.isArray(votes?.totals) ? votes.totals : [],
    mergeSuggestions: Array.isArray(votes?.mergeSuggestions) ? votes.mergeSuggestions : [],
    categorySuggestions: Array.isArray(votes?.categorySuggestions) ? votes.categorySuggestions : [],
  };
}

function totalVoteCount(votes) {
  return (votes?.totals || []).reduce((sum, vote) => sum + (vote.count || 0), 0);
}

function toastToneClasses(tone) {
  if (tone === 'amber') return 'border-amber-300 bg-amber-50 text-amber-950';
  if (tone === 'emerald') return 'border-emerald-300 bg-emerald-50 text-emerald-950';
  if (tone === 'red') return 'border-red-300 bg-red-50 text-red-950';
  return 'border-cyan-300 bg-cyan-50 text-cyan-950';
}

function compactText(value, max = 130) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max).trim()}...` : text;
}

function suggestionSupportItem(suggestion) {
  return {
    id: suggestion.itemId,
    name: suggestion.itemLabel,
    icon: suggestion.value?.scope === 'subcategory' ? 'Tag' : 'Lightbulb',
    color: '#f59e0b',
  };
}

function isJoinRequiredError(err) {
  return String(err?.message || err || '').toLowerCase().includes('join the workshop before voting');
}

function DragHandle({ item, itemType, label }) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, isDragging } = useDraggable({
    id: `${itemType}:${item.id}`,
    data: { item, itemType },
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  return (
    <span ref={setNodeRef} style={style} className={isDragging ? 'relative z-50 opacity-80' : ''}>
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...listeners}
        {...attributes}
        className="flex min-h-10 min-w-10 items-center justify-center rounded-lg text-slate-500 transition hover:bg-white/10 hover:text-cyan-200 active:scale-[0.96] [touch-action:none]"
        title={`Drag ${label} to priorities`}
      >
        <Icons.GripVertical className="h-4 w-4" />
      </button>
    </span>
  );
}

function PriorityDropZone({ children, collapsed, id = 'priority-tray' }) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`${collapsed ? 'hidden' : 'block'} mt-3 min-h-24 space-y-2 rounded-lg border border-dashed p-2 transition-all duration-200 lg:block lg:min-h-32 ${
        isOver ? 'border-cyan-200 bg-cyan-300/20 shadow-inner' : 'border-cyan-200/40'
      }`}
    >
      {children}
    </div>
  );
}

export default function SummitVote() {
  const { token } = useParams();
  const storageKey = `summit_vote_${token}`;
  const [session, setSession] = useState(null);
  const [votes, setVotes] = useState(() => normalizeVotes());
  const [displayName, setDisplayName] = useState('');
  const [participantKey, setParticipantKey] = useState('');
  const [myVotes, setMyVotes] = useState({});
  const [priorityItems, setPriorityItems] = useState([]);
  const [highlightIds, setHighlightIds] = useState({});
  const [toasts, setToasts] = useState([]);
  const [dragItem, setDragItem] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [showMobilePriorities, setShowMobilePriorities] = useState(false);
  const [showMobileActions, setShowMobileActions] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [activeRoomTab, setActiveRoomTab] = useState('feedback');
  const [query, setQuery] = useState('');
  const [mergeFrom, setMergeFrom] = useState('');
  const [mergeTo, setMergeTo] = useState('');
  const [mergeReason, setMergeReason] = useState('');
  const [ideaName, setIdeaName] = useState('');
  const [ideaReason, setIdeaReason] = useState('');
  const [quickSubcategoryNames, setQuickSubcategoryNames] = useState({});
  const [error, setError] = useState('');
  const [expiredMessage, setExpiredMessage] = useState('');
  const [joining, setJoining] = useState(false);
  const votesRef = useRef(normalizeVotes());
  const participantKeyRef = useRef('');
  const toastIdRef = useRef(0);
  const suggestRef = useRef(null);
  const suggestionsRef = useRef(null);

  const categories = useMemo(() => (session?.state?.categories || []).filter(c => !c.deleted), [session]);
  const acceptedSuggestionIds = useMemo(() => {
    const ids = new Set();
    categories.forEach((category) => {
      if (category.sourceSuggestionItemId) ids.add(category.sourceSuggestionItemId);
      (category.subcategories || []).forEach((subcategory) => {
        if (!subcategory.deleted && subcategory.sourceSuggestionItemId) ids.add(subcategory.sourceSuggestionItemId);
      });
    });
    return ids;
  }, [categories]);
  const subcategorySuggestionsByParent = useMemo(() => {
    const groups = new Map();
    (votes.categorySuggestions || [])
      .filter(suggestion => suggestion.value?.scope === 'subcategory' && suggestion.value?.parentId && !acceptedSuggestionIds.has(suggestion.itemId))
      .forEach((suggestion) => {
        const parentId = suggestion.value.parentId;
        groups.set(parentId, [...(groups.get(parentId) || []), suggestion]);
      });
    return groups;
  }, [acceptedSuggestionIds, votes.categorySuggestions]);
  const roomIdeaCounts = useMemo(() => {
    const ideas = votes.categorySuggestions || [];
    return {
      top: ideas.filter(suggestion => suggestion.value?.scope !== 'subcategory').length,
      sub: ideas.filter(suggestion => suggestion.value?.scope === 'subcategory').length,
    };
  }, [votes.categorySuggestions]);
  const filteredCategories = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return categories;
    return categories.filter((category) => {
      if (category.name.toLowerCase().includes(needle)) return true;
      if ((category.subcategories || []).some(sub => sub.name.toLowerCase().includes(needle))) return true;
      return (subcategorySuggestionsByParent.get(category.id) || []).some(suggestion => String(suggestion.itemLabel || '').toLowerCase().includes(needle));
    });
  }, [categories, query, subcategorySuggestionsByParent]);
  const isJoined = Boolean(participantKey && displayName);
  const activePriorityItems = priorityItems.filter(item => myVotes[item.id]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  }, []);

  const pushToast = useCallback(({ title, message, icon = 'Bell', tone = 'cyan', duration = 3200 }) => {
    const id = `${Date.now()}_${toastIdRef.current += 1}`;
    setToasts(prev => [{ id, title, message, icon, tone }, ...prev].slice(0, 3));
    window.setTimeout(() => {
      setToasts(prev => prev.filter(toast => toast.id !== id));
    }, duration);
  }, []);

  const markHighlight = useCallback((id) => {
    setHighlightIds(prev => ({ ...prev, [id]: true }));
    window.setTimeout(() => {
      setHighlightIds((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }, 1800);
  }, []);

  const applyVotes = useCallback((incomingVotes, { silent = false } = {}) => {
    const next = normalizeVotes(incomingVotes);
    const previous = votesRef.current || normalizeVotes();
    if (!silent) {
      const previousSupportCounts = new Map(previous.totals.filter(vote => vote.voteType === 'support').map(vote => [vote.itemId, vote.count || 0]));
      next.totals
        .filter(vote => vote.voteType === 'support' && (vote.count || 0) !== (previousSupportCounts.get(vote.itemId) || 0))
        .slice(0, 8)
        .forEach((vote) => markHighlight(`vote-${vote.itemId}`));
      if (totalVoteCount(next) !== totalVoteCount(previous)) markHighlight('votes');
      if ((next.participantCount || 0) !== (previous.participantCount || 0)) markHighlight('participants');

      const previousIdeaIds = new Set(previous.categorySuggestions.map(suggestion => suggestion.id));
      next.categorySuggestions
        .filter(suggestion => !previousIdeaIds.has(suggestion.id))
        .slice(0, 5)
        .forEach((suggestion) => {
          markHighlight(`idea-${suggestion.itemId}`);
          markHighlight(`category-${suggestion.value?.parentId}`);
          markHighlight('ideas');
        });
    }
    votesRef.current = next;
    setVotes(next);
  }, [markHighlight]);

  const resetLocalVotingState = useCallback(() => {
    setMyVotes({});
    setPriorityItems([]);
    setQuickSubcategoryNames({});
    setMergeFrom('');
    setMergeTo('');
    setMergeReason('');
  }, []);

  const resetStaleParticipantSession = useCallback((message = 'Your session was reset. Rejoin to keep voting.') => {
    setParticipantKey('');
    setError(message);
    resetLocalVotingState();
    pushToast({
      title: 'Session reset',
      message,
      icon: 'RotateCcw',
      tone: 'amber',
      duration: 5200,
    });
  }, [pushToast, resetLocalVotingState]);

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
    participantKeyRef.current = participantKey;
  }, [participantKey]);

  useEffect(() => {
    let cancelled = false;
    summitAPI.getPublicWorkshop(token)
      .then((res) => {
        if (cancelled) return;
        setSession(res.session);
        applyVotes(res.votes, { silent: true });
      })
      .catch((err) => setError(err.message || 'Voting link is not available'));
    const source = summitAPI.getPublicEventSource(token);
    source.addEventListener('state', (event) => setSession(JSON.parse(event.data)));
    source.addEventListener('votes', (event) => applyVotes(JSON.parse(event.data)));
    source.addEventListener('participant-reset', (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.participantKey !== participantKeyRef.current) return;
        resetLocalVotingState();
        setError('');
        markHighlight('votes');
        pushToast({
          title: 'Your votes were reset',
          message: 'The facilitator cleared your activity. You can keep voting now.',
          icon: 'RotateCcw',
          tone: 'amber',
          duration: 5200,
        });
      } catch {
        // ignore malformed SSE payloads
      }
    });
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
  }, [applyVotes, markHighlight, pushToast, resetLocalVotingState, token]);

  useEffect(() => {
    if (!displayName && !participantKey) return;
    localStorage.setItem(storageKey, JSON.stringify({ displayName, participantKey, myVotes, priorityItems }));
  }, [displayName, participantKey, myVotes, priorityItems, storageKey]);

  useEffect(() => {
    if (!showMobilePriorities) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeMobilePriorities();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showMobilePriorities]);

  const joinWorkshop = async (name) => {
    setJoining(true);
    setError('');
    try {
      const res = await summitAPI.joinPublicWorkshop(token, { displayName: name, participantKey: participantKey || null });
      setParticipantKey(res.participant.participantKey);
      setDisplayName(res.participant.displayName);
      applyVotes(res.votes, { silent: true });
      pushToast({ title: 'Joined', message: `Voting as ${res.participant.displayName}`, icon: 'UserCheck', tone: 'emerald' });
    } catch (err) {
      setError(err.message || 'Could not join');
    } finally {
      setJoining(false);
    }
  };

  const join = async (event) => {
    event.preventDefault();
    await joinWorkshop(displayName);
  };

  const joinAnonymous = async () => {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    await joinWorkshop(`Anonymous ${randomSuffix}`);
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
      applyVotes(res.votes, { silent: true });
      markHighlight(`vote-${item.id}`);
      if (active && navigator.vibrate) navigator.vibrate(12);
      pushToast({
        title: active ? 'Vote added' : 'Vote removed',
        message: item.name,
        icon: active ? 'ThumbsUp' : 'MinusCircle',
        tone: active ? 'cyan' : 'amber',
        duration: 2400,
      });
    } catch (err) {
      if (isJoinRequiredError(err)) {
        resetStaleParticipantSession();
        return;
      }
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

  const scrollToSection = (ref) => {
    setShowMobileActions(false);
    window.setTimeout(() => {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  const closeMobilePriorities = () => {
    setShowMobilePriorities(false);
    setShowMobileActions(false);
  };

  const startNameEdit = () => {
    setNameDraft(displayName);
    setEditingName(true);
  };

  const saveName = async (event) => {
    event.preventDefault();
    const nextName = nameDraft.trim();
    if (!nextName || !participantKey) return;
    try {
      const res = await summitAPI.joinPublicWorkshop(token, { displayName: nextName, participantKey });
      setParticipantKey(res.participant.participantKey);
      setDisplayName(res.participant.displayName);
      applyVotes(res.votes, { silent: true });
      setEditingName(false);
      pushToast({ title: 'Name updated', message: res.participant.displayName, icon: 'Pencil', tone: 'emerald' });
    } catch (err) {
      if (isJoinRequiredError(err)) {
        resetStaleParticipantSession();
        return;
      }
      setError(err.message || 'Could not update name');
    }
  };

  const handleDragEnd = ({ active, over }) => {
    if (!['priority-tray', 'desktop-priority-tray'].includes(over?.id)) return;
    const data = active?.data?.current;
    if (!data?.item) return;
    toggleVote(data.item, data.itemType, true);
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
      applyVotes(res.votes, { silent: true });
      setMergeReason('');
      pushToast({ title: 'Merge suggestion shared', message: `${from} + ${to}`, icon: 'Merge', tone: 'cyan' });
    } catch (err) {
      if (isJoinRequiredError(err)) {
        resetStaleParticipantSession();
        return;
      }
      setError(err.message || 'Suggestion failed');
    }
  };

  const submitIdea = async (event) => {
    event.preventDefault();
    const name = ideaName.trim();
    if (!name || !participantKey) return;
    try {
      const res = await summitAPI.submitVote(token, {
        participantKey,
        itemType: 'top_category',
        itemLabel: name,
        voteType: 'new_category_suggestion',
        value: {
          name,
          scope: 'top_category',
          parentId: null,
          parentName: null,
          reason: ideaReason.trim(),
        },
      });
      applyVotes(res.votes, { silent: true });
      markHighlight(`idea-${name}`);
      setIdeaName('');
      setIdeaReason('');
      pushToast({ title: 'Category suggestion shared', message: name, icon: 'Lightbulb', tone: 'amber' });
    } catch (err) {
      if (isJoinRequiredError(err)) {
        resetStaleParticipantSession();
        return;
      }
      setError(err.message || 'Suggestion failed');
    }
  };

  const submitQuickSubcategory = async (event, category) => {
    event.preventDefault();
    const name = String(quickSubcategoryNames[category.id] || '').trim();
    if (!name || !participantKey) return;
    try {
      const res = await summitAPI.submitVote(token, {
        participantKey,
        itemType: 'subcategory',
        itemLabel: name,
        voteType: 'new_category_suggestion',
        value: {
          name,
          scope: 'subcategory',
          parentId: category.id,
          parentName: category.name,
          reason: '',
        },
      });
      applyVotes(res.votes, { silent: true });
      markHighlight(`category-${category.id}`);
      setQuickSubcategoryNames(prev => ({ ...prev, [category.id]: '' }));
      pushToast({ title: 'Subcategory suggestion shared', message: `${name} under ${category.name}`, icon: 'Tag', tone: 'amber' });
    } catch (err) {
      if (isJoinRequiredError(err)) {
        resetStaleParticipantSession();
        return;
      }
      setError(err.message || 'Suggestion failed');
    }
  };

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
      <style>{`
        @keyframes voteToastIn {
          from { opacity: 0; transform: translate3d(0, -10px, 0) scale(.98); }
          to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
        }
        @keyframes voteSoftPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(34, 211, 238, 0); }
          50% { box-shadow: 0 0 0 7px rgba(34, 211, 238, .2); }
        }
        .vote-toast { animation: voteToastIn 180ms ease-out both; }
        .vote-soft-pulse { animation: voteSoftPulse 1.1s ease-in-out 2; }
        @media (prefers-reduced-motion: reduce) {
          .vote-toast, .vote-soft-pulse { animation: none; }
        }
      `}</style>
      <div className="fixed left-3 right-3 top-3 z-[80] mx-auto grid max-w-md gap-2" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`vote-toast flex items-start gap-3 rounded-lg border px-3 py-2 shadow-2xl ${toastToneClasses(toast.tone)}`}>
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/75">
              <Icon name={toast.icon} className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{toast.title}</div>
              <div className="mt-0.5 break-words text-xs opacity-80">{toast.message}</div>
            </div>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition hover:bg-white/70 active:scale-95"
              aria-label={`Dismiss ${toast.title}`}
            >
              <Icons.X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <div className="mx-auto max-w-7xl px-3 py-4 sm:px-4 sm:py-6">
        <header className="mb-5 overflow-hidden rounded-lg border border-white/10 bg-white/5 shadow-xl">
          <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <div>
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-cyan-200">
                <Icons.Sparkles className="h-4 w-4" />
                BGC Engineering IT Summit
              </div>
              <h1 className="mt-2 text-xl font-semibold sm:text-2xl">Category live voting</h1>
              <p className="mt-1 text-sm text-slate-300">Tap to vote, suggest missing categories, and add subcategory ideas.</p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-slate-950">
              <div className={`rounded-lg bg-cyan-400 px-3 py-3 transition-all duration-300 ${highlightIds.participants ? 'vote-soft-pulse scale-[1.02]' : ''}`}>
                <div className="text-xs font-medium uppercase">Participants</div>
                <div className="text-2xl font-semibold">{votes.participantCount || 0}</div>
              </div>
              <div className={`rounded-lg border border-white/10 bg-slate-900 px-3 py-3 text-white transition-all duration-300 ${highlightIds.votes ? 'vote-soft-pulse scale-[1.02]' : ''}`}>
                <div className="text-xs font-medium uppercase">Votes</div>
                <div className="text-2xl font-semibold">{totalVoteCount(votes)}</div>
              </div>
              <div className={`rounded-lg bg-amber-300 px-3 py-3 transition-all duration-300 ${highlightIds.ideas ? 'vote-soft-pulse scale-[1.02]' : ''}`}>
                <div className="text-xs font-medium uppercase">New ideas</div>
                <div className="text-2xl font-semibold">{votes.categorySuggestions?.length || 0}</div>
              </div>
            </div>
          </div>
        </header>

        {!isJoined ? (
          <form onSubmit={join} className="mx-auto max-w-md rounded-lg border border-white/10 bg-slate-900 p-5 text-white shadow-xl shadow-black/30">
            <h2 className="text-lg font-semibold">Join the session</h2>
            <p className="mt-1 text-sm text-slate-400">Enter your name once. Refreshing the page will keep your votes.</p>
            <label className="mt-4 block text-sm font-medium text-slate-300">Your name</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-white outline-none placeholder:text-slate-500 focus:border-cyan-300 focus:ring-2 focus:ring-cyan-400/20"
              autoFocus
            />
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <button disabled={!displayName.trim() || joining} className="mt-4 min-h-12 w-full rounded-lg bg-slate-950 px-4 py-2 font-semibold text-white transition active:scale-[0.99] disabled:opacity-50 [touch-action:manipulation]">
              {joining ? 'Joining...' : 'Join workshop'}
            </button>
            <button
              type="button"
              disabled={joining}
              onClick={joinAnonymous}
              className="mt-2 min-h-11 w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-white/10 active:scale-[0.99] disabled:opacity-50 [touch-action:manipulation]"
            >
              Continue anonymously
            </button>
          </form>
        ) : (
          <>
            <div className="mb-4 grid gap-2 rounded-lg border border-white/10 bg-white/5 p-2 shadow-xl sm:inline-grid sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setActiveRoomTab('feedback')}
                className={`flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition duration-200 hover:-translate-y-0.5 active:scale-[0.98] ${
                  activeRoomTab === 'feedback' ? 'bg-white text-slate-950 shadow-lg shadow-slate-950/20' : 'text-slate-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icons.Sparkles className="h-4 w-4" />
              Working / Attention
              </button>
              <button
                type="button"
                onClick={() => setActiveRoomTab('categories')}
                className={`flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition duration-200 hover:-translate-y-0.5 active:scale-[0.98] ${
                  activeRoomTab === 'categories' ? 'bg-cyan-400 text-slate-950 shadow-lg shadow-cyan-950/20' : 'text-slate-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icons.Tags className="h-4 w-4" />
              Categories
              </button>
            </div>

            {activeRoomTab === 'feedback' ? (
              <ItSummitFeedbackPanel mode="public" token={token} participantKey={participantKey} />
            ) : (
              <DndContext sensors={sensors} onDragStart={() => setShowMobilePriorities(true)} onDragEnd={handleDragEnd}>
                <div className="grid gap-3 lg:grid-cols-[290px_minmax(0,1fr)_360px] lg:gap-4">
                  <aside className="lg:sticky lg:top-4 lg:self-start">
                    <div
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={dropVote}
                      className="hidden rounded-lg border border-cyan-300/40 bg-cyan-400/10 p-3 shadow-xl sm:p-4 lg:block"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <h2 className="font-semibold text-white">My priorities</h2>
                          <p className="mt-1 text-xs text-cyan-100">Drag categories or subcategories here to support them.</p>
                        </div>
                        <Icons.MousePointer2 className="h-5 w-5 text-cyan-200" />
                      </div>
                      <PriorityDropZone collapsed={false} id="desktop-priority-tray">
                        {activePriorityItems.map((item, index) => (
                          <div key={item.id} className="flex items-center gap-2 rounded-lg border border-white/10 bg-slate-950/80 px-2 py-2 text-white shadow-sm">
                            <span className="flex h-7 w-7 items-center justify-center rounded text-white" style={{ backgroundColor: item.color }}>
                              <Icon name={item.icon} className="h-3.5 w-3.5" />
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">{index + 1}. {item.name}</span>
                            <button onClick={() => removePriority(item)} className="flex min-h-9 min-w-9 items-center justify-center rounded text-slate-400 transition hover:bg-white/10 hover:text-white active:scale-[0.95] [touch-action:manipulation]" title="Remove vote">
                              <Icons.X className="h-4 w-4" />
                            </button>
                          </div>
                        ))}
                        {!activePriorityItems.length && (
                          <div className="flex min-h-24 items-center justify-center text-center text-sm text-cyan-100">
                      Tap vote buttons to add priorities.
                          </div>
                        )}
                      </PriorityDropZone>
                    </div>

                    <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200 lg:mt-4">
                      {editingName ? (
                        <form onSubmit={saveName} className="space-y-2">
                          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Display name</label>
                          <div className="flex gap-2">
                            <input
                              value={nameDraft}
                              onChange={(event) => setNameDraft(event.target.value)}
                              className="min-h-11 min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none placeholder:text-slate-500 focus:border-cyan-300 lg:min-h-0 lg:text-sm"
                            />
                            <button disabled={!nameDraft.trim()} className="rounded-lg bg-cyan-400 px-3 py-2 font-semibold text-slate-950 disabled:opacity-50">Save</button>
                          </div>
                          <button type="button" onClick={() => setEditingName(false)} className="text-xs text-slate-400">Cancel</button>
                        </form>
                      ) : (
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                        Voting as <span className="font-semibold text-white">{displayName}</span>
                            <div className="mt-1 text-xs text-slate-400">Link expires {session?.voteExpiresAt ? new Date(session.voteExpiresAt).toLocaleTimeString() : ''}</div>
                          </div>
                          <button onClick={startNameEdit} className="flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-white/10 text-slate-200 transition hover:bg-white/10 active:scale-[0.98] [touch-action:manipulation]" title="Change name">
                            <Icons.Pencil className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  </aside>

                  <main className="min-w-0">
                    <div className="sticky top-0 z-30 -mx-3 mb-3 border-y border-white/10 bg-slate-950/95 px-3 py-2 backdrop-blur sm:static sm:mx-0 sm:rounded-lg sm:border sm:bg-white/5 sm:p-3">
                      <div className="relative">
                        <Icons.Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400 sm:top-2.5" />
                        <input
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                          className="min-h-11 w-full rounded-lg border border-white/10 bg-slate-900 px-9 py-2 text-base text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-300 sm:min-h-0 sm:text-sm"
                          placeholder="Search categories or subcategories"
                        />
                      </div>
                    </div>

                    <div className="space-y-3">
                      {filteredCategories.map((cat) => {
                        const subcategories = (cat.subcategories || []).filter(s => !s.deleted);
                        const subcategorySuggestions = subcategorySuggestionsByParent.get(cat.id) || [];
                        const isExpanded = expanded[cat.id] !== false;
                        const visibleSubcategories = isExpanded ? subcategories : subcategories.slice(0, 4);
                        return (
                          <article
                            key={cat.id}
                            draggable
                            onDragStart={() => setDragItem({ ...cat, itemType: 'category' })}
                            className={`rounded-lg border bg-slate-900/95 p-3 text-white shadow-xl shadow-black/20 transition-all duration-300 hover:-translate-y-0.5 hover:border-cyan-300/40 hover:bg-slate-900 sm:p-4 ${
                              highlightIds[`category-${cat.id}`] || highlightIds[`vote-${cat.id}`]
                                ? 'vote-soft-pulse border-cyan-300 ring-2 ring-cyan-300/30'
                                : 'border-white/10'
                            }`}
                          >
                            <div className="flex items-start gap-3">
                              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white sm:h-11 sm:w-11" style={{ backgroundColor: cat.color }}>
                                <Icon name={cat.icon} className="h-5 w-5" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h2 className="break-words text-base font-semibold leading-snug sm:text-lg">{cat.name}</h2>
                                  <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-slate-300">{subcategories.length} subcategories</span>
                                  {!!subcategorySuggestions.length && (
                                    <span className="rounded-full bg-amber-300/15 px-2 py-0.5 text-xs font-semibold text-amber-100">{subcategorySuggestions.length} ideas</span>
                                  )}
                                </div>
                                <p className="mt-1 text-sm text-slate-400">{compactText(cat.description)}</p>
                              </div>
                              <button
                                aria-pressed={Boolean(myVotes[cat.id])}
                                onClick={() => toggleVote(cat, 'category')}
                                className={`min-h-11 shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition-all active:scale-[0.96] [touch-action:manipulation] ${
                                  highlightIds[`vote-${cat.id}`] ? 'scale-[1.05]' : ''
                                } ${myVotes[cat.id] ? 'bg-cyan-400 text-slate-950 shadow-md ring-2 ring-cyan-300/30' : 'bg-slate-950 text-slate-300 hover:bg-slate-800 hover:text-white'}`}
                              >
                                <Icons.ThumbsUp className="mr-1 inline h-4 w-4" />
                                {voteCount(votes, cat.id)}
                              </button>
                              <DragHandle item={cat} itemType="category" label={cat.name} />
                            </div>
                            <div className="mt-3 grid gap-2 sm:grid-cols-2">
                              {visibleSubcategories.map(sub => (
                                <div
                                  key={sub.id}
                                  className={`flex min-h-[52px] items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-all duration-200 active:scale-[0.985] [touch-action:manipulation] ${
                                    highlightIds[`vote-${sub.id}`] ? 'vote-soft-pulse scale-[1.01]' : ''
                                  } ${myVotes[sub.id] ? 'border-cyan-300 bg-cyan-400/15 text-cyan-50 shadow-sm ring-1 ring-cyan-300/30' : 'border-white/10 bg-slate-950/70 text-slate-200 hover:border-cyan-300/40 hover:bg-slate-900'}`}
                                >
                                  <DragHandle item={{ ...sub, color: cat.color }} itemType="subcategory" label={sub.name} />
                                  <button
                                    type="button"
                                    aria-pressed={Boolean(myVotes[sub.id])}
                                    onClick={() => toggleVote({ ...sub, color: cat.color }, 'subcategory')}
                                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md text-left transition active:scale-[0.99] [touch-action:manipulation]"
                                  >
                                    <Icon name={sub.icon || 'Tag'} className="h-4 w-4 shrink-0 text-slate-400" />
                                    <span className="min-w-0 flex-1 break-words leading-snug">{sub.name}</span>
                                    <span className={`flex min-h-8 min-w-8 items-center justify-center rounded-lg px-2 text-xs font-semibold ${myVotes[sub.id] ? 'bg-cyan-400 text-slate-950' : 'bg-white/10 text-slate-300'}`}>
                                      {voteCount(votes, sub.id) || <Icons.ThumbsUp className="h-3.5 w-3.5" />}
                                    </span>
                                  </button>
                                </div>
                              ))}
                              {subcategorySuggestions.map((suggestion) => {
                                const item = suggestionSupportItem(suggestion);
                                return (
                                  <div
                                    key={suggestion.id}
                                    className={`flex min-h-[64px] items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-all duration-200 active:scale-[0.985] [touch-action:manipulation] ${
                                      highlightIds[`idea-${item.id}`] || highlightIds[`vote-${item.id}`] ? 'vote-soft-pulse scale-[1.01]' : ''
                                    } ${myVotes[item.id] ? 'border-amber-300 bg-amber-300/20 text-amber-50 shadow-sm ring-1 ring-amber-300/30' : 'border-amber-300/25 bg-amber-950/25 text-amber-50 hover:border-amber-300/50 hover:bg-amber-950/35'}`}
                                  >
                                    <DragHandle item={item} itemType="suggestion" label={item.name} />
                                    <button
                                      type="button"
                                      aria-pressed={Boolean(myVotes[item.id])}
                                      onClick={() => toggleVote(item, 'suggestion')}
                                      className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md text-left transition active:scale-[0.99] [touch-action:manipulation]"
                                    >
                                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-300 text-slate-950">
                                        <Icons.Tag className="h-4 w-4" />
                                      </span>
                                      <span className="min-w-0 flex-1">
                                        <span className="block break-words font-semibold leading-snug">{suggestion.itemLabel}</span>
                                        <span className="mt-0.5 block text-xs text-amber-100/75">Suggested by {suggestion.participantName}</span>
                                      </span>
                                      <span className={`flex min-h-8 min-w-8 items-center justify-center rounded-lg px-2 text-xs font-semibold ${myVotes[item.id] ? 'bg-amber-300 text-slate-950' : 'bg-white/10 text-amber-100'}`}>
                                        {voteCount(votes, item.id) || <Icons.ThumbsUp className="h-3.5 w-3.5" />}
                                      </span>
                                    </button>
                                  </div>
                                );
                              })}
                              <form
                                onSubmit={(event) => submitQuickSubcategory(event, cat)}
                                className="grid gap-2 rounded-lg border border-dashed border-amber-300/40 bg-amber-300/10 p-3 sm:flex sm:items-center sm:px-3 sm:py-2"
                              >
                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                  <Icons.Plus className="h-4 w-4 shrink-0 text-amber-200" />
                                  <input
                                    value={quickSubcategoryNames[cat.id] || ''}
                                    onChange={(event) => setQuickSubcategoryNames(prev => ({ ...prev, [cat.id]: event.target.value }))}
                                    className="min-h-11 min-w-0 flex-1 bg-transparent text-base text-white outline-none placeholder:text-amber-100/55 sm:min-h-0 sm:text-sm"
                                    placeholder="Suggest another subcategory"
                                  />
                                </div>
                                <button
                                  disabled={!String(quickSubcategoryNames[cat.id] || '').trim()}
                                  className="min-h-11 rounded-md bg-amber-300 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-200 active:scale-[0.98] disabled:opacity-50 sm:min-h-0 sm:px-2 sm:py-1 sm:text-xs [touch-action:manipulation]"
                                >
                            Add
                                </button>
                              </form>
                            </div>
                            {subcategories.length > 4 && (
                              <button
                                onClick={() => setExpanded(prev => ({ ...prev, [cat.id]: !isExpanded }))}
                                className="mt-3 min-h-10 rounded-lg px-1 text-sm font-semibold text-cyan-200 transition active:scale-[0.98] hover:text-cyan-100 [touch-action:manipulation]"
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
                    <form ref={suggestRef} onSubmit={submitIdea} className="scroll-mt-20 rounded-lg border border-amber-300/30 bg-amber-950/25 p-4 shadow-xl shadow-black/20">
                      <div className="flex items-center gap-2">
                        <Icons.Lightbulb className="h-5 w-5 text-amber-200" />
                        <div>
                          <h2 className="font-semibold text-white">Suggest a new category</h2>
                          <p className="mt-0.5 text-xs text-amber-100/80">Use the category cards to suggest subcategories.</p>
                        </div>
                      </div>
                      <input
                        value={ideaName}
                        onChange={(event) => setIdeaName(event.target.value)}
                        className="mt-3 min-h-11 w-full rounded-lg border border-amber-300/20 bg-slate-950 px-3 py-2 text-base text-white outline-none placeholder:text-slate-500 transition focus:border-amber-300 focus:ring-2 focus:ring-amber-400/20 lg:min-h-0 lg:text-sm"
                        placeholder="New top category name"
                      />
                      <textarea
                        value={ideaReason}
                        onChange={(event) => setIdeaReason(event.target.value)}
                        className="mt-2 w-full resize-none rounded-lg border border-amber-300/20 bg-slate-950 px-3 py-2 text-base text-white outline-none placeholder:text-slate-500 transition focus:border-amber-300 focus:ring-2 focus:ring-amber-400/20 lg:text-sm"
                        rows={3}
                        placeholder="Why should we consider it?"
                      />
                      <button disabled={!ideaName.trim()} className="mt-3 min-h-11 w-full rounded-lg bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-200 active:scale-[0.99] disabled:opacity-50 [touch-action:manipulation]">
                  Submit idea
                      </button>
                    </form>

                    <section ref={suggestionsRef} className="scroll-mt-20 rounded-lg border border-white/10 bg-white/5 p-4 shadow-xl">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h2 className="font-semibold text-white">Room ideas</h2>
                          <p className="mt-1 text-xs text-slate-400">Vote here or in the matching category card.</p>
                        </div>
                        <span className="rounded-full bg-white/10 px-2 py-1 text-xs font-semibold text-white">{votes.categorySuggestions?.length || 0}</span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-center">
                          <div className="text-lg font-semibold text-white">{roomIdeaCounts.top}</div>
                          <div className="text-[10px] uppercase tracking-wide text-slate-400">Top</div>
                        </div>
                        <div className="rounded-lg border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-center">
                          <div className="text-lg font-semibold text-amber-100">{roomIdeaCounts.sub}</div>
                          <div className="text-[10px] uppercase tracking-wide text-amber-100/70">Sub</div>
                        </div>
                      </div>
                      <div className="mt-3 max-h-[28rem] space-y-2 overflow-auto pr-1">
                        {(votes.categorySuggestions || []).map(suggestion => {
                          const item = suggestionSupportItem(suggestion);
                          const isSubcategoryIdea = suggestion.value?.scope === 'subcategory';
                          return (
                            <div
                              key={suggestion.id}
                              className={`rounded-lg border bg-slate-900/95 p-3 text-white shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-cyan-300/40 hover:shadow-md ${
                                highlightIds[`idea-${item.id}`] || highlightIds[`vote-${item.id}`] ? 'vote-soft-pulse scale-[1.01] ring-2 ring-amber-300/30' : ''
                              } ${isSubcategoryIdea ? 'border-amber-300/25' : 'border-white/10'}`}
                            >
                              <div className="flex items-start gap-3">
                                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${isSubcategoryIdea ? 'bg-amber-300 text-slate-950' : 'bg-cyan-400 text-slate-950'}`}>
                                  <Icon name={item.icon} className="h-5 w-5" />
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div className="break-words text-base font-semibold leading-tight">{suggestion.itemLabel}</div>
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-1 text-xs font-semibold text-slate-200">
                                      <Icons.UserRound className="h-3.5 w-3.5" />
                                      {suggestion.participantName}
                                    </span>
                                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-300/15 px-2 py-1 text-xs font-semibold text-amber-100">
                                      <Icons.Tags className="h-3.5 w-3.5" />
                                      {isSubcategoryIdea ? 'Subcategory' : 'Top category'}
                                    </span>
                                    {suggestion.value?.parentName && (
                                      <span className="inline-flex items-center gap-1 rounded-full bg-cyan-400/15 px-2 py-1 text-xs font-semibold text-cyan-100">
                                        <Icons.FolderTree className="h-3.5 w-3.5" />
                                        {suggestion.value.parentName}
                                      </span>
                                    )}
                                  </div>
                                  {suggestion.value?.reason && <p className="mt-2 rounded-md bg-slate-950/80 px-2 py-1.5 text-sm text-slate-300">{suggestion.value.reason}</p>}
                                </div>
                                <button
                                  aria-pressed={Boolean(myVotes[item.id])}
                                  onClick={() => toggleVote(item, 'suggestion')}
                                  className={`shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition active:scale-[0.96] [touch-action:manipulation] ${
                                    highlightIds[`vote-${item.id}`] ? 'scale-[1.05]' : ''
                                  } ${myVotes[item.id] ? 'bg-cyan-400 text-slate-950 shadow-md ring-2 ring-cyan-300/30' : 'bg-white/10 text-slate-200 hover:bg-white/15'}`}
                                >
                                  <Icons.ThumbsUp className="mr-1 inline h-4 w-4" />
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
                        <select value={mergeFrom} onChange={(e) => setMergeFrom(e.target.value)} className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300">
                          <option value="">First category</option>
                          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        <select value={mergeTo} onChange={(e) => setMergeTo(e.target.value)} className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300">
                          <option value="">Second category</option>
                          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        <input value={mergeReason} onChange={(e) => setMergeReason(e.target.value)} className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none placeholder:text-slate-500 focus:border-cyan-300" placeholder="Optional reason" />
                      </div>
                      <button disabled={!mergeFrom || !mergeTo || mergeFrom === mergeTo} className="mt-3 w-full rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">
                  Submit merge suggestion
                      </button>
                    </form>
                  </aside>
                </div>
                <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2 lg:hidden">
                  <div className={`grid gap-2 transition-all duration-200 ${showMobileActions ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setShowMobilePriorities(true);
                        setShowMobileActions(false);
                      }}
                      className="flex min-h-12 items-center gap-2 rounded-full border border-cyan-200/30 bg-cyan-500 px-4 text-sm font-semibold text-slate-950 shadow-xl transition active:scale-[0.97] [touch-action:manipulation]"
                    >
                      <Icons.ListChecks className="h-4 w-4" />
                  Priorities
                      <span className="rounded-full bg-slate-950 px-2 py-0.5 text-xs text-white">{activePriorityItems.length}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => scrollToSection(suggestRef)}
                      className="flex min-h-12 items-center gap-2 rounded-full border border-amber-200/40 bg-amber-300 px-4 text-sm font-semibold text-slate-950 shadow-xl transition active:scale-[0.97] [touch-action:manipulation]"
                    >
                      <Icons.Lightbulb className="h-4 w-4" />
                  Suggest
                    </button>
                    <button
                      type="button"
                      onClick={() => scrollToSection(suggestionsRef)}
                      className="flex min-h-12 items-center gap-2 rounded-full border border-white/20 bg-slate-900 px-4 text-sm font-semibold text-white shadow-xl transition active:scale-[0.97] [touch-action:manipulation]"
                    >
                      <Icons.MessageSquareText className="h-4 w-4" />
                  Room ideas
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowMobileActions(prev => !prev)}
                    className="flex min-h-14 min-w-14 items-center justify-center rounded-full bg-cyan-400 text-slate-950 shadow-2xl ring-1 ring-cyan-200/30 transition active:scale-[0.96] [touch-action:manipulation]"
                    title="Workshop actions"
                  >
                    {showMobileActions ? <Icons.X className="h-6 w-6" /> : <Icons.Plus className="h-6 w-6" />}
                  </button>
                </div>

                {showMobilePriorities && (
                  <div
                    className="fixed inset-0 z-[80] flex items-end bg-slate-950/75 backdrop-blur-sm lg:hidden"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="mobile-priorities-title"
                    onMouseDown={(event) => {
                      if (event.target === event.currentTarget) closeMobilePriorities();
                    }}
                    onTouchStart={(event) => {
                      if (event.target === event.currentTarget) closeMobilePriorities();
                    }}
                  >
                    <div className="max-h-[86dvh] w-full overflow-hidden rounded-t-2xl border border-cyan-200/20 bg-slate-950 shadow-2xl transition-all duration-200 animate-in slide-in-from-bottom-4">
                      <div className="flex items-start justify-between gap-3 border-b border-white/10 px-4 py-3">
                        <div>
                          <h2 id="mobile-priorities-title" className="text-base font-semibold text-white">My priorities</h2>
                          <p className="mt-1 text-xs text-cyan-100">{activePriorityItems.length} selected. Tap an item X to remove a vote.</p>
                        </div>
                        <button
                          type="button"
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            closeMobilePriorities();
                          }}
                          onClick={closeMobilePriorities}
                          className="relative z-[90] flex min-h-12 min-w-12 items-center justify-center rounded-full border border-white/10 bg-white/10 text-slate-100 shadow-lg transition hover:bg-white/15 active:scale-[0.96] [touch-action:manipulation]"
                          aria-label="Close priorities"
                        >
                          <Icons.X className="h-5 w-5" />
                        </button>
                      </div>
                      <div className="max-h-[58dvh] overflow-auto px-4 pb-4">
                        <PriorityDropZone collapsed={false}>
                          {activePriorityItems.map((item, index) => (
                            <div key={item.id} className="flex items-center gap-2 rounded-lg border border-white/10 bg-slate-900 px-3 py-3 text-white shadow-sm">
                              <span className="flex h-9 w-9 items-center justify-center rounded text-white" style={{ backgroundColor: item.color }}>
                                <Icon name={item.icon} className="h-4 w-4" />
                              </span>
                              <span className="min-w-0 flex-1 break-words text-sm font-medium leading-snug">{index + 1}. {item.name}</span>
                              <button onClick={() => removePriority(item)} className="flex min-h-10 min-w-10 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/10 hover:text-white active:scale-[0.95] [touch-action:manipulation]" title="Remove vote">
                                <Icons.X className="h-4 w-4" />
                              </button>
                            </div>
                          ))}
                          {!activePriorityItems.length && (
                            <div className="flex min-h-28 items-center justify-center rounded-lg text-center text-sm text-cyan-100">
                          Tap vote buttons or drag handles to add priorities.
                            </div>
                          )}
                        </PriorityDropZone>
                      </div>
                      <div className="border-t border-white/10 bg-slate-950 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3">
                        <button
                          type="button"
                          onClick={closeMobilePriorities}
                          className="min-h-12 w-full rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 shadow-lg transition active:scale-[0.98] [touch-action:manipulation]"
                        >
                      Done
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </DndContext>
            )}
          </>
        )}
      </div>
    </div>
  );
}
