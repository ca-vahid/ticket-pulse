import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Activity, AlertCircle, ArrowLeft, Bot, CheckCircle2, ChevronDown, ExternalLink,
  History, Loader2, Lock, Mail, MessageSquare, Send, ShieldCheck, Sparkles, StickyNote, UserRound,
} from 'lucide-react';
import AppHeader from '../components/AppHeader';
import {
  MirrorChip, OriginChip, PersonAvatar, PriorityDot, StatusPill, PRIORITY_LABELS, timeAgo,
} from '../components/tickets/ticketUi';
import { FRESHSERVICE_DOMAIN } from '../components/tech-detail/constants';
import { ticketsAPI } from '../services/api';
import { useSSE } from '../hooks/useSSE';

const STATUSES = ['Open', 'Pending', 'Resolved', 'Closed'];

function ThreadEntry({ entry }) {
  const isReply = entry.eventType === 'reply';
  const isNote = entry.eventType === 'note' || entry.isPrivate === true;
  const isConversation = isReply || isNote || entry.eventType === 'conversation' || entry.bodyText || entry.content;
  const body = entry.bodyText || entry.content || '';
  const incoming = entry.incoming === true || entry.authorType === 'requester';

  if (!isConversation) {
    // Compact system/activity line (status changes, FS activity rows, …)
    return (
      <li className="flex items-center gap-2 pl-10 py-1 text-xs text-slate-400">
        <History className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
        <span className="truncate">{entry.title || entry.eventType}</span>
        <span className="ml-auto whitespace-nowrap">{timeAgo(entry.occurredAt)}</span>
      </li>
    );
  }

  return (
    <li className="flex gap-3">
      <div className="flex-shrink-0 pt-1">
        <PersonAvatar name={entry.actorName} size="h-8 w-8" textSize="text-xs" />
      </div>
      <div
        className={`flex-1 min-w-0 rounded-xl border p-3.5 shadow-subtle ${
          isNote
            ? 'bg-amber-50/70 border-amber-200'
            : incoming
              ? 'bg-indigo-50/60 border-indigo-100'
              : 'bg-white border-slate-200'
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1.5">
          <span className="text-sm font-semibold text-slate-800">{entry.actorName || 'Unknown'}</span>
          {isNote ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-1.5 py-0.5">
              <Lock className="w-2.5 h-2.5" aria-hidden="true" /> Internal note
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-700 bg-blue-50 border border-blue-100 rounded-full px-1.5 py-0.5">
              <Mail className="w-2.5 h-2.5" aria-hidden="true" /> {incoming ? 'From requester' : 'Public reply'}
            </span>
          )}
          <span className="ml-auto text-xs text-slate-400 whitespace-nowrap" title={new Date(entry.occurredAt).toLocaleString()}>
            {timeAgo(entry.occurredAt)}
          </span>
        </div>
        <p className="text-sm text-slate-700 whitespace-pre-wrap break-words">{body.trim() || '(empty message)'}</p>
      </div>
    </li>
  );
}

function SidebarField({ label, children }) {
  return (
    <div>
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">{label}</span>
      {children}
    </div>
  );
}

export default function TicketDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const ticketId = Number(id);

  const [ticket, setTicket] = useState(null);
  const [meta, setMeta] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [toast, setToast] = useState(null);
  const [savingField, setSavingField] = useState(null);

  const [composerMode, setComposerMode] = useState('reply'); // reply | note
  const [composerBody, setComposerBody] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [showActivity, setShowActivity] = useState(false);

  const showToast = useCallback((tone, message) => {
    setToast({ tone, message });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const fetchTicket = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setIsLoading(true);
    try {
      const res = await ticketsAPI.get(ticketId);
      setTicket(res.data);
      setLoadError(null);
    } catch (err) {
      setLoadError(err.response?.data?.message || err.message);
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [ticketId]);

  useEffect(() => { fetchTicket(); }, [fetchTicket]);
  useEffect(() => {
    let cancelled = false;
    ticketsAPI.meta().then((res) => { if (!cancelled) setMeta(res.data); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const onTicketChange = useCallback((data) => {
    if (data?.ticketId === ticketId) fetchTicket({ silent: true });
  }, [ticketId, fetchTicket]);
  useSSE({ onTicketChange, enabled: Number.isFinite(ticketId) });

  const isNative = ticket?.origin === 'ticketpulse';
  const canWrite = isNative && meta?.nativeTicketingEnabled !== false;
  const fsUrl = ticket?.freshserviceTicketId
    ? `https://${FRESHSERVICE_DOMAIN}/a/tickets/${ticket.freshserviceTicketId}`
    : null;

  const conversationEntries = useMemo(() => {
    const entries = [...(ticket?.thread || [])];
    entries.sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
    return entries;
  }, [ticket?.thread]);

  const subcategories = useMemo(() => {
    const top = (meta?.categoryTree || []).find((c) => c.id === ticket?.internalCategoryId);
    return top?.subcategories || [];
  }, [meta, ticket?.internalCategoryId]);

  const applyChange = useCallback(async (field, fn) => {
    setSavingField(field);
    try {
      await fn();
      await fetchTicket({ silent: true });
      showToast('emerald', 'Saved');
    } catch (err) {
      showToast('red', err.response?.data?.message || err.message || 'Change failed');
    } finally {
      setSavingField(null);
    }
  }, [fetchTicket, showToast]);

  const sendComposer = async () => {
    const body = composerBody.trim();
    if (!body) return;
    setIsSending(true);
    try {
      if (composerMode === 'reply') await ticketsAPI.reply(ticketId, { bodyText: body });
      else await ticketsAPI.note(ticketId, { bodyText: body });
      setComposerBody('');
      await fetchTicket({ silent: true });
      showToast('emerald', composerMode === 'reply' ? 'Reply posted — requester emailed' : 'Internal note added');
    } catch (err) {
      showToast('red', err.response?.data?.message || err.message || 'Send failed');
    } finally {
      setIsSending(false);
    }
  };

  const fieldClass = 'tp-focus-ring w-full text-sm bg-white border border-input rounded-lg px-2.5 py-1.5 text-slate-700 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed';
  const run = ticket?.latestPipelineRun;

  return (
    <div className="tp-page-backdrop min-h-screen">
      <AppHeader activePage="tickets" />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 animate-fadeIn">
        <button
          onClick={() => navigate('/tickets')}
          className="tp-focus-ring inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-blue-700 mb-4 rounded"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to tickets
        </button>

        {isLoading ? (
          <div className="tp-card rounded-xl p-16 flex items-center justify-center">
            <Activity className="w-8 h-8 animate-spin text-blue-600" aria-label="Loading ticket" />
          </div>
        ) : loadError ? (
          <div className="tp-card rounded-xl p-8 text-center">
            <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-2" aria-hidden="true" />
            <p className="text-slate-700">{loadError}</p>
          </div>
        ) : ticket && (
          <>
            {/* Header */}
            <div className="tp-card rounded-xl p-4 sm:p-5 mb-4">
              <div className="flex flex-wrap items-center gap-2 mb-1.5">
                <span className="font-mono text-sm font-bold text-slate-500">{ticket.displayRef}</span>
                <OriginChip origin={ticket.origin} />
                <MirrorChip ticket={ticket} />
                {ticket.isNoise && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-500 border border-slate-200">Noise</span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <PriorityDot priority={ticket.priority} withLabel />
                  <StatusPill status={ticket.status} />
                </div>
              </div>
              <h1 className="text-lg sm:text-xl font-bold text-slate-900 leading-snug">{ticket.subject || '(no subject)'}</h1>
              <p className="text-xs text-slate-400 mt-1">
                Created {timeAgo(ticket.createdAt)}
                {ticket.requester?.name ? <> by <span className="text-slate-600 font-medium">{ticket.requester.name}</span></> : null}
                {ticket.resolvedAt ? <> · resolved {timeAgo(ticket.resolvedAt)}</> : null}
              </p>

              {!isNative && (
                <div className="mt-3 flex flex-wrap items-center gap-2 p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
                  <ShieldCheck className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" aria-hidden="true" />
                  FreshService owns this ticket — it is read-only here until the mirror phase adds write-back.
                  {fsUrl && (
                    <a href={fsUrl} target="_blank" rel="noreferrer" className="tp-focus-ring inline-flex items-center gap-1 font-semibold text-blue-700 hover:underline rounded ml-auto">
                      Open in FreshService <ExternalLink className="w-3 h-3" aria-hidden="true" />
                    </a>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
              {/* Conversation column */}
              <div className="space-y-4 min-w-0">
                {(ticket.descriptionText || ticket.description) && (
                  <section className="tp-card rounded-xl p-4" aria-label="Ticket description">
                    <div className="flex items-center gap-2 mb-2">
                      <MessageSquare className="w-4 h-4 text-blue-500" aria-hidden="true" />
                      <h2 className="text-sm font-bold text-slate-800">Description</h2>
                    </div>
                    <p className="text-sm text-slate-700 whitespace-pre-wrap break-words">{ticket.descriptionText || ticket.description}</p>
                  </section>
                )}

                <section aria-label="Conversation">
                  <h2 className="text-sm font-bold text-slate-800 mb-2 px-1">
                    Conversation
                    <span className="ml-2 text-xs font-medium text-slate-400">{conversationEntries.length} entr{conversationEntries.length === 1 ? 'y' : 'ies'}</span>
                  </h2>
                  {conversationEntries.length === 0 ? (
                    <div className="tp-surface rounded-xl p-6 text-center text-sm text-slate-400">
                      No replies yet{canWrite ? ' — start the conversation below.' : '.'}
                    </div>
                  ) : (
                    <ul className="space-y-3">
                      {conversationEntries.map((entry) => <ThreadEntry key={entry.id} entry={entry} />)}
                    </ul>
                  )}
                </section>

                {/* Composer */}
                {canWrite ? (
                  <section className="tp-card rounded-xl p-3.5" aria-label="Reply composer">
                    <div role="group" aria-label="Composer mode" className="flex items-center gap-1.5 mb-2.5">
                      <button
                        onClick={() => setComposerMode('reply')}
                        aria-pressed={composerMode === 'reply'}
                        className={`tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                          composerMode === 'reply' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'
                        }`}
                      >
                        <Mail className="w-3.5 h-3.5" aria-hidden="true" /> Reply to requester
                      </button>
                      <button
                        onClick={() => setComposerMode('note')}
                        aria-pressed={composerMode === 'note'}
                        className={`tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                          composerMode === 'note' ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-slate-600 border-slate-200 hover:border-amber-300'
                        }`}
                      >
                        <StickyNote className="w-3.5 h-3.5" aria-hidden="true" /> Internal note
                      </button>
                      {composerMode === 'reply' && ticket.requester?.email && (
                        <span className="ml-auto text-[11px] text-slate-400 truncate">emails {ticket.requester.email}</span>
                      )}
                    </div>
                    <textarea
                      rows={4}
                      value={composerBody}
                      onChange={(e) => setComposerBody(e.target.value)}
                      placeholder={composerMode === 'reply' ? 'Write a reply to the requester…' : 'Add context for the team (never emailed)…'}
                      aria-label={composerMode === 'reply' ? 'Reply body' : 'Internal note body'}
                      className={`tp-focus-ring w-full text-sm border rounded-lg px-3 py-2.5 resize-y min-h-[90px] placeholder:text-slate-400 ${
                        composerMode === 'note' ? 'bg-amber-50/50 border-amber-200' : 'bg-white border-input'
                      }`}
                    />
                    <div className="flex items-center justify-end mt-2">
                      <button
                        onClick={sendComposer}
                        disabled={isSending || !composerBody.trim()}
                        className={`tp-focus-ring inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg shadow-subtle transition-colors disabled:opacity-50 ${
                          composerMode === 'reply' ? 'bg-primary text-primary-foreground hover:bg-blue-700' : 'bg-amber-500 text-white hover:bg-amber-600'
                        }`}
                      >
                        {isSending ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Send className="w-4 h-4" aria-hidden="true" />}
                        {composerMode === 'reply' ? 'Send reply' : 'Add note'}
                      </button>
                    </div>
                  </section>
                ) : isNative ? (
                  <div className="tp-surface rounded-xl p-4 text-center text-sm text-slate-500">
                    Native ticketing is disabled for this workspace, so the conversation is read-only.
                  </div>
                ) : null}
              </div>

              {/* Sidebar */}
              <aside className="space-y-4" aria-label="Ticket properties">
                <div className="tp-card rounded-xl p-4 space-y-3.5">
                  <SidebarField label="Status">
                    <select
                      value={ticket.status}
                      disabled={!canWrite || savingField === 'status'}
                      onChange={(e) => applyChange('status', () => ticketsAPI.setStatus(ticketId, e.target.value))}
                      className={fieldClass}
                      aria-label="Ticket status"
                    >
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                      {!STATUSES.includes(ticket.status) && <option value={ticket.status}>{ticket.status}</option>}
                    </select>
                  </SidebarField>

                  <SidebarField label="Priority">
                    <select
                      value={ticket.priority}
                      disabled={!canWrite || savingField === 'priority'}
                      onChange={(e) => applyChange('priority', () => ticketsAPI.update(ticketId, { priority: Number(e.target.value) }))}
                      className={fieldClass}
                      aria-label="Ticket priority"
                    >
                      {[1, 2, 3, 4].map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
                    </select>
                  </SidebarField>

                  <SidebarField label="Assignee">
                    <div className="flex items-center gap-2">
                      <PersonAvatar name={ticket.assignedTech?.name} photoUrl={ticket.assignedTech?.photoUrl} size="h-7 w-7" />
                      <select
                        value={ticket.assignedTechId || ''}
                        disabled={!canWrite || savingField === 'assignee'}
                        onChange={(e) => applyChange('assignee', () => ticketsAPI.assign(ticketId, e.target.value ? Number(e.target.value) : null))}
                        className={fieldClass}
                        aria-label="Assigned technician"
                      >
                        <option value="">Unassigned</option>
                        {(meta?.technicians || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </div>
                  </SidebarField>

                  <SidebarField label="Category">
                    <select
                      value={ticket.internalCategoryId || ''}
                      disabled={!canWrite || savingField === 'category'}
                      onChange={(e) => applyChange('category', () => ticketsAPI.update(ticketId, {
                        internalCategoryId: e.target.value ? Number(e.target.value) : null,
                        internalSubcategoryId: null,
                      }))}
                      className={fieldClass}
                      aria-label="Category"
                    >
                      <option value="">Uncategorized</option>
                      {(meta?.categoryTree || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    {subcategories.length > 0 && (
                      <select
                        value={ticket.internalSubcategoryId || ''}
                        disabled={!canWrite || savingField === 'subcategory'}
                        onChange={(e) => applyChange('subcategory', () => ticketsAPI.update(ticketId, {
                          internalSubcategoryId: e.target.value ? Number(e.target.value) : null,
                        }))}
                        className={`${fieldClass} mt-1.5`}
                        aria-label="Subcategory"
                      >
                        <option value="">No subcategory</option>
                        {subcategories.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    )}
                  </SidebarField>

                  {(meta?.groups?.length || 0) > 0 && (
                    <SidebarField label="Group">
                      <select
                        value={ticket.groupId ? String(ticket.groupId) : ''}
                        disabled={!canWrite || savingField === 'group'}
                        onChange={(e) => applyChange('group', () => ticketsAPI.update(ticketId, { groupId: e.target.value ? Number(e.target.value) : null }))}
                        className={fieldClass}
                        aria-label="Group"
                      >
                        <option value="">No group</option>
                        {meta.groups.map((g) => <option key={g.id} value={String(g.freshserviceId)}>{g.name}</option>)}
                      </select>
                    </SidebarField>
                  )}
                </div>

                {/* Requester card */}
                <div className="tp-card rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2.5">
                    <UserRound className="w-4 h-4 text-blue-500" aria-hidden="true" />
                    <h2 className="text-sm font-bold text-slate-800">Requester</h2>
                  </div>
                  {ticket.requester ? (
                    <div className="flex items-start gap-3">
                      <PersonAvatar name={ticket.requester.name} size="h-9 w-9" textSize="text-xs" />
                      <div className="min-w-0 text-sm">
                        <p className="font-semibold text-slate-800 truncate">{ticket.requester.name}</p>
                        {ticket.requester.email && <p className="text-xs text-slate-500 truncate">{ticket.requester.email}</p>}
                        {(ticket.requester.jobTitle || ticket.requester.department) && (
                          <p className="text-xs text-slate-400 mt-0.5 truncate">
                            {[ticket.requester.jobTitle, ticket.requester.department].filter(Boolean).join(' · ')}
                          </p>
                        )}
                        {(ticket.requester.entraCity || ticket.requester.entraOfficeLocation) && (
                          <p className="text-xs text-slate-400 truncate">
                            {[ticket.requester.entraOfficeLocation, ticket.requester.entraCity].filter(Boolean).join(' · ')}
                          </p>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400">No requester on record</p>
                  )}
                </div>

                {/* AI triage */}
                <div className="tp-card rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2.5">
                    <Sparkles className="w-4 h-4 text-indigo-500" aria-hidden="true" />
                    <h2 className="text-sm font-bold text-slate-800">AI triage</h2>
                  </div>
                  {run ? (
                    <div className="text-sm space-y-1">
                      <p className="text-slate-600">
                        <span className="font-medium capitalize">{String(run.decision || run.status || '').replace(/_/g, ' ')}</span>
                        <span className="text-xs text-slate-400"> · {timeAgo(run.decidedAt || run.createdAt)}</span>
                      </p>
                      <p className="text-xs text-slate-400 capitalize">Trigger: {String(run.triggerSource || '').replace(/_/g, ' ')}{run.syncStatus ? ` · sync ${run.syncStatus}` : ''}</p>
                      <Link
                        to={`/assignments/history/${run.id}`}
                        className="tp-focus-ring inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:underline rounded"
                      >
                        <Bot className="w-3.5 h-3.5" aria-hidden="true" /> View pipeline run
                      </Link>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400">No pipeline run yet for this ticket.</p>
                  )}
                </div>

                {/* Approvals scaffold (Phase 6) */}
                <div className="tp-surface rounded-xl p-4">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-slate-400" aria-hidden="true" />
                    <h2 className="text-sm font-bold text-slate-500">Approvals</h2>
                    <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-slate-400 bg-slate-100 border border-slate-200 rounded-full px-2 py-0.5">Coming soon</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1.5">Request sign-off on this ticket (e.g. purchases) — lands with the approvals phase.</p>
                </div>

                {/* Activity log */}
                {(ticket.activities?.length || 0) > 0 && (
                  <div className="tp-card rounded-xl p-4">
                    <button
                      onClick={() => setShowActivity((v) => !v)}
                      aria-expanded={showActivity}
                      className="tp-focus-ring w-full flex items-center gap-2 rounded"
                    >
                      <History className="w-4 h-4 text-slate-400" aria-hidden="true" />
                      <h2 className="text-sm font-bold text-slate-800">Activity</h2>
                      <span className="text-xs text-slate-400">({ticket.activities.length})</span>
                      <ChevronDown className={`w-4 h-4 text-slate-400 ml-auto transition-transform ${showActivity ? 'rotate-180' : ''}`} aria-hidden="true" />
                    </button>
                    {showActivity && (
                      <ul className="mt-3 space-y-2 max-h-72 overflow-y-auto settings-scrollbar">
                        {ticket.activities.map((a) => (
                          <li key={a.id} className="text-xs text-slate-500 flex items-start gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-slate-300 mt-1.5 flex-shrink-0" aria-hidden="true" />
                            <span className="min-w-0">
                              <span className="font-medium text-slate-600 capitalize">{String(a.activityType || '').replace(/_/g, ' ')}</span>
                              {a.performedBy ? ` · ${a.performedBy}` : ''}
                              <span className="text-slate-400"> · {timeAgo(a.performedAt)}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </aside>
            </div>
          </>
        )}
      </main>

      {/* Toast */}
      {toast && (
        <div
          role="status"
          className={`fixed bottom-5 right-5 z-50 px-4 py-2.5 rounded-lg shadow-soft text-sm font-medium animate-slideInLeft ${
            toast.tone === 'red' ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
