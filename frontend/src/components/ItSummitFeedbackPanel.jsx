import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Edit3,
  AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Loader2, MessageSquare,
  Plus, RotateCcw, Send, Sparkles, ThumbsUp, Trash2, X,
} from 'lucide-react';
import { agentAPI, summitAPI } from '../services/api';

const SECTIONS = [
  {
    id: 'working',
    title: 'Working Well',
    shortTitle: 'Working',
    iconClass: 'bg-emerald-100 text-emerald-700',
    borderClass: 'border-emerald-200',
    buttonClass: 'bg-emerald-600 hover:bg-emerald-700',
  },
  {
    id: 'attention',
    title: 'Needs Attention',
    shortTitle: 'Attention',
    iconClass: 'bg-amber-100 text-amber-700',
    borderClass: 'border-amber-200',
    buttonClass: 'bg-amber-600 hover:bg-amber-700',
  },
];

function normalizeFeedback(feedback) {
  return {
    items: Array.isArray(feedback?.items) ? feedback.items : [],
    counts: {
      working: feedback?.counts?.working || 0,
      attention: feedback?.counts?.attention || 0,
      votes: feedback?.counts?.votes || 0,
      comments: feedback?.counts?.comments || 0,
    },
  };
}

function feedbackItemKey(section, title) {
  return `${section === 'attention' ? 'attention' : 'working'}:${String(title || '').trim().toLowerCase()}`;
}

function feedbackStats(items = []) {
  return new Map(items.map((item) => [
    item.itemId,
    {
      supportCount: Number(item.supportCount || 0),
      commentCount: Number(item.commentCount || 0),
    },
  ]));
}

function Toast({ toast, onClose }) {
  return (
    <div className="animate-[summitFeedbackToast_.18s_ease-out] overflow-hidden rounded-xl border border-blue-200 bg-white shadow-2xl">
      <div className="h-1 bg-blue-500" />
      <div className="flex gap-3 p-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-950">{toast.title}</div>
          <div className="mt-0.5 text-sm text-slate-600">{toast.message}</div>
        </div>
        <button type="button" onClick={() => onClose(toast.id)} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function FeedbackCard({
  item,
  canInteract,
  collapsedByDefault = false,
  highlighted,
  onVote,
  onComment,
  canManage = false,
  onEdit,
  onDelete,
  onDeleteComment,
  dark = false,
}) {
  const [expanded, setExpanded] = useState(!collapsedByDefault && item.commentCount > 0);
  const [comment, setComment] = useState('');
  const [savingComment, setSavingComment] = useState(false);

  const submitComment = async (event) => {
    event.preventDefault();
    if (!comment.trim()) return;
    setSavingComment(true);
    try {
      await onComment(item, comment);
      setComment('');
      setExpanded(true);
    } finally {
      setSavingComment(false);
    }
  };

  return (
    <div className={`group rounded-xl border p-4 transition-all duration-500 ease-out hover:-translate-y-0.5 ${
      dark ? 'bg-slate-900/95 text-white shadow-xl shadow-black/20 hover:border-cyan-300/40 hover:bg-slate-900' : 'bg-white shadow-sm hover:shadow-md'
    } ${
      highlighted
        ? dark
          ? 'animate-[summitFeedbackPulse_1.3s_ease-out] border-cyan-300 ring-2 ring-cyan-400/20'
          : 'animate-[summitFeedbackPulse_1.3s_ease-out] border-blue-300 ring-2 ring-blue-100'
        : dark ? 'border-white/10' : 'border-slate-200'
    }`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={`break-words text-base font-semibold ${dark ? 'text-white' : 'text-slate-950'}`}>{item.title}</h3>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${dark ? 'bg-white/10 text-slate-200' : 'bg-slate-100 text-slate-500'}`}>by {item.participantName}</span>
          </div>
          {item.note && <p className={`mt-2 whitespace-pre-wrap text-sm leading-6 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>{item.note}</p>}
          <div className={`mt-3 flex flex-wrap items-center gap-2 text-xs ${dark ? 'text-slate-400' : 'text-slate-500'}`}>
            <span>{new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
            <span>•</span>
            <span>{item.commentCount} comment{item.commentCount === 1 ? '' : 's'}</span>
            {canManage && (
              <>
                <span>•</span>
                <button
                  type="button"
                  onClick={() => onEdit(item)}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-semibold text-blue-600 transition hover:bg-blue-50"
                >
                  <Edit3 className="h-3.5 w-3.5" />
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(item)}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-semibold text-red-600 transition hover:bg-red-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          disabled={!canInteract}
          onClick={() => onVote(item)}
          className={`flex min-w-[78px] shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-bold transition duration-200 hover:-translate-y-0.5 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${
            item.isSupportedByMe
              ? dark ? 'border-cyan-300 bg-cyan-400 text-slate-950 shadow-md shadow-cyan-950/30' : 'border-blue-200 bg-blue-600 text-white shadow-md shadow-blue-100'
              : dark ? 'border-white/10 bg-slate-950 text-slate-200 hover:bg-slate-800' : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-white'
          }`}
          aria-pressed={!!item.isSupportedByMe}
        >
          <ThumbsUp className="h-4 w-4" />
          {item.supportCount}
        </button>
      </div>

      <div className={`mt-3 border-t pt-3 ${dark ? 'border-white/10' : 'border-slate-100'}`}>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold transition ${dark ? 'text-slate-300 hover:bg-white/10 hover:text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {expanded ? 'Hide details' : 'Show details'}
        </button>
        <div className={`grid transition-all duration-300 ease-out ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
          <div className="overflow-hidden">
            <div className="mt-3 space-y-2">
              {(item.comments || []).map((entry) => (
                <div key={entry.id} className={`animate-[summitFeedbackIn_.22s_ease-out] rounded-lg px-3 py-2 text-sm ${dark ? 'bg-slate-950/70' : 'bg-slate-50'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className={`font-semibold ${dark ? 'text-white' : 'text-slate-800'}`}>{entry.participantName}</div>
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => onDeleteComment(entry)}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                        title="Delete comment"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <div className={`mt-0.5 whitespace-pre-wrap ${dark ? 'text-slate-300' : 'text-slate-600'}`}>{entry.text}</div>
                </div>
              ))}
              {canInteract && (
                <form onSubmit={submitComment} className="flex gap-2">
                  <input
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    placeholder="Add a comment"
                    className={`min-h-10 min-w-0 flex-1 rounded-lg border px-3 text-sm outline-none transition ${
                      dark
                        ? 'border-white/10 bg-slate-950 text-white placeholder:text-slate-500 focus:border-cyan-300 focus:ring-2 focus:ring-cyan-400/20'
                        : 'border-slate-200 bg-white text-slate-950 placeholder:text-slate-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-100'
                    }`}
                  />
                  <button
                    type="submit"
                    disabled={savingComment || !comment.trim()}
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 ${dark ? 'bg-cyan-400 text-slate-950 hover:bg-cyan-300' : 'bg-slate-950 text-white hover:bg-slate-800'}`}
                    title="Add comment"
                  >
                    {savingComment ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ItSummitFeedbackPanel({ mode = 'participant', initialFeedback = null, token = null, participantKey = null }) {
  const isFacilitator = mode === 'facilitator';
  const isPublic = mode === 'public';
  const darkMode = isPublic;
  const apiClient = isFacilitator ? summitAPI : agentAPI;
  const [feedback, setFeedback] = useState(() => normalizeFeedback(initialFeedback));
  const [loading, setLoading] = useState(!initialFeedback);
  const [error, setError] = useState('');
  const [activeSection, setActiveSection] = useState('working');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [adminSaving, setAdminSaving] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [editForm, setEditForm] = useState({ title: '', section: 'working', note: '' });
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [highlightIds, setHighlightIds] = useState({});
  const [toasts, setToasts] = useState([]);
  const previousItemIds = useRef(new Set((initialFeedback?.items || []).map((item) => item.itemId)));
  const previousItemStats = useRef(feedbackStats(initialFeedback?.items || []));
  const hasLoadedFeedback = useRef(Boolean(initialFeedback));
  const refreshTimer = useRef(null);
  const refreshInFlight = useRef(false);
  const toastSeq = useRef(0);
  const suppressedLiveItemKeys = useRef(new Set());

  const pushToast = useCallback((titleText, message) => {
    const id = `${Date.now()}_${toastSeq.current += 1}`;
    setToasts((current) => [{ id, title: titleText, message }, ...current].slice(0, 4));
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200);
  }, []);

  const markHighlight = useCallback((id) => {
    setHighlightIds((current) => ({ ...current, [id]: true }));
    window.setTimeout(() => {
      setHighlightIds((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }, 1700);
  }, []);

  const applyFeedback = useCallback((incoming, { silent = false } = {}) => {
    const next = normalizeFeedback(incoming);
    if (!silent && hasLoadedFeedback.current) {
      const oldIds = previousItemIds.current;
      const oldStats = previousItemStats.current;
      next.items.forEach((item) => {
        if (!oldIds.has(item.itemId)) {
          markHighlight(item.itemId);
          markHighlight(`section-${item.section === 'attention' ? 'attention' : 'working'}`);
          const itemKey = feedbackItemKey(item.section, item.title);
          if (suppressedLiveItemKeys.current.has(itemKey)) {
            suppressedLiveItemKeys.current.delete(itemKey);
            return;
          }
          pushToast(item.section === 'working' ? 'New working-well item' : 'New needs-attention item', `${item.title} by ${item.participantName}`);
          return;
        }

        const previousStats = oldStats.get(item.itemId) || { supportCount: 0, commentCount: 0 };
        const supportDelta = Number(item.supportCount || 0) - previousStats.supportCount;
        const commentDelta = Number(item.commentCount || 0) - previousStats.commentCount;
        if (supportDelta > 0) {
          markHighlight(item.itemId);
          markHighlight(`section-${item.section === 'attention' ? 'attention' : 'working'}`);
          pushToast('New vote', `${item.title} now has ${item.supportCount} vote${item.supportCount === 1 ? '' : 's'}.`);
        }
        if (commentDelta > 0) {
          markHighlight(item.itemId);
          markHighlight(`section-${item.section === 'attention' ? 'attention' : 'working'}`);
          const latestComment = [...(item.comments || [])].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
          pushToast('New comment', latestComment?.participantName ? `${latestComment.participantName} commented on ${item.title}.` : item.title);
        }
      });
    }
    previousItemIds.current = new Set(next.items.map((item) => item.itemId));
    previousItemStats.current = feedbackStats(next.items);
    hasLoadedFeedback.current = true;
    setFeedback(next);
  }, [markHighlight, pushToast]);

  const refresh = useCallback(async (silent = false, { showLoading = !silent } = {}) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setError('');
    if (showLoading) setLoading(true);
    try {
      const res = isPublic
        ? await summitAPI.getPublicWorkshop(token, participantKey)
        : isFacilitator
          ? await apiClient.getFeedback()
          : await apiClient.getSummitFeedback();
      applyFeedback(res.feedback, { silent });
    } catch (err) {
      setError(err.message || 'Could not load IT Summit 2026 feedback');
    } finally {
      refreshInFlight.current = false;
      if (showLoading) setLoading(false);
    }
  }, [apiClient, applyFeedback, isFacilitator, isPublic, participantKey, token]);

  const scheduleLiveRefresh = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      refresh(false, { showLoading: false });
    }, 220);
  }, [refresh]);

  useEffect(() => {
    if (!initialFeedback) refresh(false);
  }, [initialFeedback, refresh]);

  useEffect(() => {
    const source = isPublic
      ? (token ? summitAPI.getPublicEventSource(token) : null)
      : isFacilitator
        ? apiClient.getWorkshopEventSource?.()
        : apiClient.getSummitEventSource?.();
    if (!source) return undefined;

    source.addEventListener('feedback', (event) => {
      try {
        if (isFacilitator) {
          const incoming = JSON.parse(event.data);
          applyFeedback(incoming);
        } else {
          scheduleLiveRefresh();
        }
      } catch {
        // Ignore malformed SSE payloads.
      }
    });
    source.onerror = () => {
      // Let EventSource use its built-in retry after transient backend restarts.
    };
    return () => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      source.close();
    };
  }, [apiClient, applyFeedback, isFacilitator, isPublic, scheduleLiveRefresh, token]);

  const itemsBySection = useMemo(() => {
    const grouped = { working: [], attention: [] };
    feedback.items.forEach((item) => grouped[item.section === 'attention' ? 'attention' : 'working'].push(item));
    Object.values(grouped).forEach((list) => list.sort((a, b) => (b.supportCount - a.supportCount) || new Date(b.createdAt) - new Date(a.createdAt)));
    return grouped;
  }, [feedback.items]);

  const submitItem = async (event) => {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError('');
    const submittedItemKey = feedbackItemKey(activeSection, title);
    suppressedLiveItemKeys.current.add(submittedItemKey);
    try {
      const res = isPublic
        ? await summitAPI.submitPublicFeedback(token, { section: activeSection, title, note, participantKey })
        : isFacilitator
          ? await apiClient.submitFeedback({ section: activeSection, title, note })
          : await apiClient.submitSummitFeedback({ section: activeSection, title, note });
      applyFeedback(res.feedback, { silent: true });
      suppressedLiveItemKeys.current.delete(submittedItemKey);
      setTitle('');
      setNote('');
      markHighlight(`section-${activeSection}`);
      pushToast('Submitted', activeSection === 'working' ? 'Added to Working Well.' : 'Added to Needs Attention.');
    } catch (err) {
      suppressedLiveItemKeys.current.delete(submittedItemKey);
      setError(err.message || 'Could not submit item');
    } finally {
      setSaving(false);
    }
  };

  const voteItem = async (item) => {
    const nextActive = !item.isSupportedByMe;
    const res = isPublic
      ? await summitAPI.votePublicFeedback(token, item.itemId, { active: nextActive, participantKey })
      : isFacilitator
        ? await apiClient.voteFeedback(item.itemId, { active: nextActive })
        : await apiClient.voteSummitFeedback(item.itemId, { active: nextActive });
    applyFeedback(res.feedback, { silent: true });
    markHighlight(item.itemId);
    markHighlight(`section-${item.section === 'attention' ? 'attention' : 'working'}`);
  };

  const commentItem = async (item, text) => {
    const res = isPublic
      ? await summitAPI.commentPublicFeedback(token, item.itemId, { text, participantKey })
      : isFacilitator
        ? await apiClient.commentFeedback(item.itemId, { text })
        : await apiClient.commentSummitFeedback(item.itemId, { text });
    applyFeedback(res.feedback, { silent: true });
    markHighlight(item.itemId);
    markHighlight(`section-${item.section === 'attention' ? 'attention' : 'working'}`);
    pushToast('Comment added', item.title);
  };

  const openEditItem = (item) => {
    setEditItem(item);
    setEditForm({
      title: item.title || '',
      section: item.section === 'attention' ? 'attention' : 'working',
      note: item.note || '',
    });
  };

  const saveEditItem = async (event) => {
    event.preventDefault();
    if (!editItem || !editForm.title.trim()) return;
    setAdminSaving(true);
    setError('');
    try {
      const res = await summitAPI.updateFeedbackItem(editItem.itemId, editForm);
      applyFeedback(res.feedback, { silent: true });
      markHighlight(editItem.itemId);
      setEditItem(null);
      pushToast('Idea updated', editForm.title);
    } catch (err) {
      setError(err.message || 'Could not update idea');
    } finally {
      setAdminSaving(false);
    }
  };

  const deleteItem = async (item) => {
    if (!window.confirm(`Delete "${item.title}" and its comments?`)) return;
    setAdminSaving(true);
    setError('');
    try {
      const res = await summitAPI.deleteFeedbackItem(item.itemId);
      applyFeedback(res.feedback, { silent: true });
      pushToast('Idea deleted', item.title);
    } catch (err) {
      setError(err.message || 'Could not delete idea');
    } finally {
      setAdminSaving(false);
    }
  };

  const deleteComment = async (entry) => {
    if (!window.confirm('Delete this comment?')) return;
    setAdminSaving(true);
    setError('');
    try {
      const res = await summitAPI.deleteFeedbackComment(entry.itemId);
      applyFeedback(res.feedback, { silent: true });
      pushToast('Comment deleted', entry.participantName);
    } catch (err) {
      setError(err.message || 'Could not delete comment');
    } finally {
      setAdminSaving(false);
    }
  };

  const resetAllFeedback = async () => {
    setAdminSaving(true);
    setError('');
    try {
      const res = await summitAPI.resetFeedback();
      previousItemIds.current = new Set();
      previousItemStats.current = feedbackStats([]);
      applyFeedback(res.feedback, { silent: true });
      setConfirmResetOpen(false);
      pushToast('Feedback reset', 'All working-well, needs-attention, votes, and comments were cleared.');
    } catch (err) {
      setError(err.message || 'Could not reset feedback');
    } finally {
      setAdminSaving(false);
    }
  };

  const sectionButtonClass = (section, active, tone = 'default') => {
    if (darkMode) {
      if (active) {
        return section.id === 'working'
          ? 'border-emerald-300 bg-emerald-300 text-slate-950 shadow-lg shadow-emerald-950/30'
          : 'border-amber-300 bg-amber-300 text-slate-950 shadow-lg shadow-amber-950/30';
      }
      return tone === 'large'
        ? 'border-white/10 bg-slate-950/80 text-slate-300 hover:border-white/20 hover:bg-white/10 hover:text-white'
        : 'border-white/10 bg-slate-950/70 text-slate-300 hover:border-white/20 hover:bg-white/10 hover:text-white';
    }
    return active
      ? `${section.borderClass} ${section.iconClass}`
      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50';
  };

  const fieldClass = darkMode
    ? 'border-white/10 bg-slate-950 px-3 text-white placeholder:text-slate-500 outline-none transition focus:border-cyan-300 focus:ring-2 focus:ring-cyan-400/20'
    : 'border-slate-200 bg-slate-50 px-3 text-slate-950 placeholder:text-slate-400 outline-none transition focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100';

  return (
    <div className="it-summit-feedback relative">
      <style>{`
        @keyframes summitFeedbackIn { from { opacity: 0; transform: translate3d(0, 12px, 0) scale(.98); } to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); } }
        @keyframes summitFeedbackPulse { 0% { box-shadow: 0 0 0 0 rgba(37,99,235,0); } 35% { box-shadow: 0 0 0 8px rgba(37,99,235,.14); } 100% { box-shadow: 0 0 0 0 rgba(37,99,235,0); } }
        @keyframes summitFeedbackToast { from { opacity: 0; transform: translate3d(16px,-8px,0) scale(.98); } to { opacity: 1; transform: translate3d(0,0,0) scale(1); } }
        @media (prefers-reduced-motion: reduce) {
          .it-summit-feedback * { animation-duration: .01ms !important; transition-duration: .01ms !important; }
        }
      `}</style>

      <div className="fixed right-4 top-20 z-[70] w-[min(420px,calc(100vw-2rem))] space-y-2">
        {toasts.map((toast) => <Toast key={toast.id} toast={toast} onClose={(id) => setToasts((current) => current.filter((entry) => entry.id !== id))} />)}
      </div>

      {editItem && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/35 px-4 backdrop-blur-sm">
          <form onSubmit={saveEditItem} className="w-full max-w-lg animate-[summitFeedbackIn_.18s_ease-out] rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-lg font-semibold text-slate-950">
                  <Edit3 className="h-5 w-5 text-blue-600" />
                  Edit submitted idea
                </div>
                <p className="mt-1 text-sm text-slate-500">Rename, move, or clean up the note while preserving votes and comments.</p>
              </div>
              <button type="button" onClick={() => setEditItem(null)} className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
                <X className="h-4 w-4" />
              </button>
            </div>
            <label className="mt-5 block text-xs font-semibold uppercase text-slate-500">Title</label>
            <input
              value={editForm.title}
              onChange={(event) => setEditForm((current) => ({ ...current, title: event.target.value }))}
              className="mt-1 h-11 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold outline-none transition focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100"
            />
            <label className="mt-4 block text-xs font-semibold uppercase text-slate-500">Section</label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {SECTIONS.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setEditForm((current) => ({ ...current, section: section.id }))}
                  className={`rounded-lg border px-3 py-3 text-sm font-semibold transition hover:-translate-y-0.5 ${
                    editForm.section === section.id ? `${section.borderClass} ${section.iconClass} ring-2 ring-blue-100` : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-white'
                  }`}
                >
                  {section.title}
                </button>
              ))}
            </div>
            <label className="mt-4 block text-xs font-semibold uppercase text-slate-500">Note</label>
            <textarea
              value={editForm.note}
              onChange={(event) => setEditForm((current) => ({ ...current, note: event.target.value }))}
              className="mt-1 min-h-[90px] w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none transition focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setEditItem(null)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50">
                Cancel
              </button>
              <button type="submit" disabled={adminSaving || !editForm.title.trim()} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-blue-700 disabled:cursor-wait disabled:opacity-60">
                {adminSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Save
              </button>
            </div>
          </form>
        </div>
      )}

      {confirmResetOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/35 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md animate-[summitFeedbackIn_.18s_ease-out] rounded-2xl border border-red-200 bg-white p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-600">
                <RotateCcw className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-lg font-semibold text-slate-950">Reset summit feedback?</h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">This clears all submitted working-well items, needs-attention items, votes, and comments for this section. Category voting is not affected.</p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmResetOpen(false)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50">
                Cancel
              </button>
              <button type="button" disabled={adminSaving} onClick={resetAllFeedback} className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-red-700 disabled:cursor-wait disabled:opacity-60">
                {adminSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Reset all
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mb-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className={`rounded-xl border p-4 shadow-sm ${
          darkMode ? 'border-white/10 bg-slate-900/95 text-white shadow-xl shadow-black/20' : 'border-slate-200 bg-white'
        }`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className={`flex items-center gap-2 text-xl font-semibold ${darkMode ? 'text-white' : 'text-slate-950'}`}>
                <Sparkles className={`h-5 w-5 ${darkMode ? 'text-cyan-300' : 'text-blue-600'}`} />
                IT Summit 2026
              </div>
              <p className={`mt-1 text-sm ${darkMode ? 'text-slate-300' : 'text-slate-500'}`}>Share what is working well and what needs attention. Vote once per item and add context when useful.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {SECTIONS.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setActiveSection(section.id)}
                  className={`rounded-lg border px-3 py-2 text-sm font-semibold transition duration-200 hover:-translate-y-0.5 ${sectionButtonClass(section, activeSection === section.id)}`}
                >
                  {section.shortTitle}
                </button>
              ))}
              {isFacilitator && (
                <button
                  type="button"
                  onClick={() => setConfirmResetOpen(true)}
                  disabled={adminSaving || !feedback.items.length}
                  className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 transition hover:-translate-y-0.5 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <div className={`rounded-xl border p-3 shadow-sm ${darkMode ? 'border-emerald-300/30 bg-emerald-950/30' : 'border-emerald-200 bg-white'}`}>
            <div className={`text-xs font-semibold uppercase ${darkMode ? 'text-emerald-200' : 'text-slate-500'}`}>Working</div>
            <div className={`mt-2 text-2xl font-bold ${darkMode ? 'text-emerald-300' : 'text-emerald-700'}`}>{feedback.counts.working}</div>
          </div>
          <div className={`rounded-xl border p-3 shadow-sm ${darkMode ? 'border-amber-300/30 bg-amber-950/30' : 'border-amber-200 bg-white'}`}>
            <div className={`text-xs font-semibold uppercase ${darkMode ? 'text-amber-200' : 'text-slate-500'}`}>Attention</div>
            <div className={`mt-2 text-2xl font-bold ${darkMode ? 'text-amber-300' : 'text-amber-700'}`}>{feedback.counts.attention}</div>
          </div>
          <div className={`rounded-xl border p-3 shadow-sm ${darkMode ? 'border-cyan-300/30 bg-cyan-950/30' : 'border-blue-200 bg-white'}`}>
            <div className={`text-xs font-semibold uppercase ${darkMode ? 'text-cyan-200' : 'text-slate-500'}`}>Votes</div>
            <div className={`mt-2 text-2xl font-bold ${darkMode ? 'text-cyan-300' : 'text-blue-700'}`}>{feedback.counts.votes}</div>
          </div>
          <div className={`rounded-xl border p-3 shadow-sm ${darkMode ? 'border-white/10 bg-slate-900/95' : 'border-slate-200 bg-white'}`}>
            <div className={`text-xs font-semibold uppercase ${darkMode ? 'text-slate-300' : 'text-slate-500'}`}>Comments</div>
            <div className={`mt-2 text-2xl font-bold ${darkMode ? 'text-white' : 'text-slate-950'}`}>{feedback.counts.comments}</div>
          </div>
        </div>
      </div>

      {!isFacilitator && (
        <form onSubmit={submitItem} className={`mb-4 rounded-xl border p-4 shadow-sm ${
          darkMode ? 'border-white/10 bg-slate-900/95 shadow-xl shadow-black/20' : 'border-slate-200 bg-white'
        }`}>
          <div className="grid gap-3 lg:grid-cols-[180px_minmax(0,1fr)]">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
              {SECTIONS.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setActiveSection(section.id)}
                  className={`rounded-lg border px-3 py-3 text-left text-sm font-semibold transition duration-200 hover:-translate-y-0.5 ${sectionButtonClass(section, activeSection === section.id, 'large')}`}
                >
                  {section.title}
                </button>
              ))}
            </div>
            <div className="grid gap-2">
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={activeSection === 'working' ? 'What is working well?' : 'What needs attention?'}
                className={`h-11 rounded-lg border text-sm font-medium ${fieldClass}`}
              />
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={activeSection === 'working' ? 'Add details, examples, or what should continue working this way' : 'Add context, examples, impact, or what needs to change'}
                className={`min-h-[140px] resize-y rounded-lg border py-2 text-sm leading-6 ${fieldClass}`}
              />
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={saving || !title.trim()}
                  className={`inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-semibold transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 ${
                    darkMode ? 'bg-cyan-400 text-slate-950 hover:bg-cyan-300' : 'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Add item
                </button>
              </div>
            </div>
          </div>
        </form>
      )}

      {error && (
        <div className={`mb-4 flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold ${
          darkMode ? 'border-red-400/40 bg-red-950/60 text-red-100' : 'border-red-200 bg-red-50 text-red-800'
        }`}>
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {loading ? (
        <div className={`flex min-h-48 items-center justify-center rounded-xl border ${
          darkMode ? 'border-white/10 bg-slate-900/95' : 'border-slate-200 bg-white'
        }`}>
          <Loader2 className={`h-8 w-8 animate-spin ${darkMode ? 'text-cyan-300' : 'text-blue-600'}`} />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {SECTIONS.map((section) => (
            <section
              key={section.id}
              className={`rounded-xl border p-4 shadow-sm transition-all duration-500 ${
                highlightIds[`section-${section.id}`]
                  ? darkMode
                    ? 'animate-[summitFeedbackPulse_1.3s_ease-out] ring-2 ring-cyan-400/25'
                    : 'animate-[summitFeedbackPulse_1.3s_ease-out] ring-2 ring-blue-100'
                  : ''
              } ${
                darkMode
                  ? section.id === 'working'
                    ? 'border-emerald-300/30 bg-emerald-950/20 shadow-xl shadow-black/20'
                    : 'border-amber-300/30 bg-amber-950/20 shadow-xl shadow-black/20'
                  : `bg-white/90 ${section.borderClass}`
              }`}
            >
              <div className="mb-3 flex items-center justify-between">
                <h2 className={`flex items-center gap-2 text-lg font-semibold ${darkMode ? 'text-white' : 'text-slate-950'}`}>
                  <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                    darkMode
                      ? section.id === 'working' ? 'bg-emerald-300 text-slate-950' : 'bg-amber-300 text-slate-950'
                      : section.iconClass
                  }`}>
                    {section.id === 'working' ? <CheckCircle2 className="h-5 w-5" /> : <MessageSquare className="h-5 w-5" />}
                  </span>
                  {section.title}
                </h2>
                <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${darkMode ? 'bg-white/10 text-slate-200' : 'bg-slate-100 text-slate-600'}`}>{itemsBySection[section.id].length}</span>
              </div>
              <div className="space-y-3">
                {itemsBySection[section.id].map((item) => (
                  <div key={item.itemId} className="animate-[summitFeedbackIn_.22s_ease-out]">
                    <FeedbackCard
                      item={item}
                      canInteract={!isFacilitator}
                      collapsedByDefault={isFacilitator}
                      highlighted={highlightIds[item.itemId]}
                      onVote={voteItem}
                      onComment={commentItem}
                      canManage={isFacilitator}
                      onEdit={openEditItem}
                      onDelete={deleteItem}
                      onDeleteComment={deleteComment}
                      dark={darkMode}
                    />
                  </div>
                ))}
                {!itemsBySection[section.id].length && (
                  <div className={`rounded-xl border border-dashed px-4 py-8 text-center text-sm ${
                    darkMode ? 'border-white/10 bg-slate-950/50 text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-500'
                  }`}>
                    No items yet.
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
