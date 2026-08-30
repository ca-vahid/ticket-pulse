import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Stamp, Loader2, Check, X, MessageCircleQuestion, Inbox, ExternalLink, RotateCcw, ClipboardList, Tags } from 'lucide-react';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import ApprovalCategoriesPanel from '../components/settings/ApprovalCategoriesPanel';
import { ticketsAPI } from '../services/api';
import { useSSE } from '../hooks/useSSE';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useWorkspaceRole } from '../components/nav/navDestinations';
import { formatDayTime, timeAgo } from '../components/tickets/ticketUi';

const STATUS_META = {
  pending: { label: 'Pending', cls: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 border-amber-200 dark:border-amber-500/30' },
  info_requested: { label: 'Needs info', cls: 'bg-violet-50 dark:bg-violet-500/15 text-violet-700 dark:text-violet-200 border-violet-200 dark:border-violet-500/30' },
  approved: { label: 'Approved', cls: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 border-emerald-200 dark:border-emerald-500/30' },
  rejected: { label: 'Rejected', cls: 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 border-red-200 dark:border-red-500/30' },
  cancelled: { label: 'Cancelled', cls: 'bg-muted text-muted-foreground border-border' },
};
const STAT_TILES = [
  { key: 'pending', label: 'Pending', color: 'text-amber-600 dark:text-amber-300' },
  { key: 'info_requested', label: 'Needs info', color: 'text-violet-600 dark:text-violet-300' },
  { key: 'approved', label: 'Approved', color: 'text-emerald-600 dark:text-emerald-300' },
  { key: 'rejected', label: 'Rejected', color: 'text-red-600 dark:text-red-300' },
  { key: 'cancelled', label: 'Cancelled', color: 'text-muted-foreground' },
];

export default function ApprovalsInbox() {
  const location = useLocation();
  // Return address so /tickets/:id's Back control comes back to this inbox.
  const backState = { from: `${location.pathname}${location.search}` };
  const { currentWorkspace, isWorkspaceSelected } = useWorkspace();
  const wsRole = useWorkspaceRole();
  const canReview = wsRole === 'admin' || wsRole === 'reviewer';
  // mine | all | categories. `categories` (v3.7.02, QA 08-24 #3) is the
  // reviewer's home for approval-category management now that Settings is
  // admin-only — same <ApprovalCategoriesPanel/> the admin sees in Settings.
  // Deep-linkable via ?tab= (the Settings → Approval Categories cross-link).
  const requestedTab = new URLSearchParams(location.search).get('tab');
  const [view, setView] = useState(['mine', 'all', 'categories'].includes(requestedTab) ? requestedTab : 'mine');
  const [pending, setPending] = useState([]);
  const [needsInfo, setNeedsInfo] = useState([]);
  const [overview, setOverview] = useState(null); // { stats, items }
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [clarifyingId, setClarifyingId] = useState(null);
  const [clarifyNote, setClarifyNote] = useState('');

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const tasks = [ticketsAPI.approvalInbox(), ticketsAPI.approvalsNeedingMyInfo()];
      if (canReview) tasks.push(ticketsAPI.approvalsOverview(statusFilter ? { status: statusFilter } : {}));
      const [inbox, mine, ov] = await Promise.all(tasks);
      setPending(inbox || []);
      setNeedsInfo(mine || []);
      if (canReview) setOverview(ov || null);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to load approvals');
    } finally {
      setLoading(false);
    }
  }, [canReview, statusFilter]);

  useEffect(() => { if (isWorkspaceSelected) load(); }, [load, isWorkspaceSelected, currentWorkspace?.id]);

  const onTicketChange = useCallback((data) => { if (data?.action === 'approval') load({ silent: true }); }, [load]);
  // reconnectKey: deterministic stream re-key on workspace switch (realtime
  // plan Phase 1) — the context-subscribed id, not a render-time module read.
  useSSE({ onTicketChange, enabled: Boolean(isWorkspaceSelected), reconnectKey: currentWorkspace?.id });

  const act = async (fn, id) => {
    setBusyId(id); setError(null);
    try { await fn(); await load({ silent: true }); }
    catch (err) { setError(err.response?.data?.message || err.message); }
    finally { setBusyId(null); }
  };

  const decide = (a, decision) => act(() => ticketsAPI.decideApproval(a.ticketId, a.id, decision), a.id);
  const sendClarify = (a) => {
    const note = clarifyNote.trim();
    if (!note) return;
    act(async () => { await ticketsAPI.clarifyApproval(a.ticketId, a.id, note); setClarifyingId(null); setClarifyNote(''); }, a.id);
  };
  const resubmit = (a) => act(() => ticketsAPI.resubmitApproval(a.ticketId, a.id), a.id);

  return (
    <div className="tp-tickets-backdrop min-h-screen md:pl-[58px]">
      <AppHeader activePage="approvals" />
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6 pb-24 lg:pb-6 animate-fadeIn">
        <div className="flex items-center gap-2.5 mb-5">
          <span className="h-9 w-9 rounded-xl bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 inline-flex items-center justify-center border border-emerald-100 dark:border-emerald-500/20"><Stamp className="w-5 h-5" aria-hidden="true" /></span>
          <div>
            <h1 className="text-xl font-bold text-foreground">Approvals</h1>
            <p className="text-sm text-muted-foreground">Requests awaiting your decision, and your requests that need more info. A Ticket Pulse feature — not synced to FreshService.</p>
          </div>
        </div>

        {/* Reviewer/admin tab toggle: my inbox vs. everything in the workspace */}
        {canReview && (
          <div role="tablist" className="flex items-end gap-1 border-b border-border mb-4">
            {[
              { k: 'mine', label: 'For you', Icon: Inbox },
              { k: 'all', label: 'All approvals', Icon: ClipboardList },
              { k: 'categories', label: 'Categories', Icon: Tags },
            ].map(({ k, label, Icon }) => (
              <button
                key={k}
                role="tab"
                aria-selected={view === k}
                onClick={() => setView(k)}
                className={`tp-focus-ring relative -mb-px inline-flex items-center gap-1.5 px-4 py-2.5 rounded-t-lg border text-sm font-semibold transition-colors ${
                  view === k ? 'bg-card text-emerald-700 dark:text-emerald-200 border-border border-b-card' : 'bg-muted/50 text-muted-foreground border-transparent hover:bg-muted hover:text-foreground/85'
                }`}
              >
                {view === k && <span className="absolute inset-x-0 top-0 h-0.5 rounded-t bg-emerald-600" aria-hidden="true" />}
                <Icon className="w-4 h-4" aria-hidden="true" /> {label}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg text-sm text-red-700 dark:text-red-200">
            <X className="w-4 h-4 mt-0.5 shrink-0" /><span>{error}</span>
          </div>
        )}

        {view === 'categories' && canReview ? (
          <section aria-label="Approval categories" className="tp-card rounded-xl p-5">
            <ApprovalCategoriesPanel />
          </section>
        ) : loading ? (
          <div className="flex items-center justify-center py-24 text-muted-foreground/75"><Loader2 className="w-6 h-6 animate-spin" aria-hidden="true" /></div>
        ) : view === 'all' && canReview ? (
          <div className="space-y-4">
            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
              {STAT_TILES.map(({ key, label, color }) => (
                <button
                  key={key}
                  onClick={() => setStatusFilter(statusFilter === key ? '' : key)}
                  className={`tp-card rounded-xl p-3 text-left transition-colors ${statusFilter === key ? 'ring-2 ring-emerald-400' : 'hover:border-input'}`}
                >
                  <div className={`text-2xl font-bold ${color}`}>{overview?.stats?.[key] ?? 0}</div>
                  <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
                </button>
              ))}
            </div>
            {statusFilter && (
              <button onClick={() => setStatusFilter('')} className="text-xs text-muted-foreground hover:text-foreground/85 tp-focus-ring rounded inline-flex items-center gap-1">
                <X className="w-3 h-3" /> Clear “{STATUS_META[statusFilter]?.label}” filter
              </button>
            )}
            {/* All approvals list / history */}
            {(overview?.items?.length || 0) === 0 ? (
              <div className="tp-card rounded-xl p-6 text-center text-sm text-muted-foreground/75">No approvals{statusFilter ? ` with status “${STATUS_META[statusFilter]?.label}”` : ''} yet.</div>
            ) : (
              <ul className="space-y-2">
                {overview.items.map((a) => (
                  <li key={a.id} className="tp-card rounded-xl p-3.5">
                    <div className="flex items-start gap-2 flex-wrap">
                      <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${STATUS_META[a.status]?.cls || 'bg-muted text-muted-foreground border-border'}`}>{STATUS_META[a.status]?.label || a.status}</span>
                      {a.categoryName && <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border border-blue-100 dark:border-blue-500/20">{a.categoryName}</span>}
                      <Link to={`/tickets/${a.ticketId}?tab=approvals`} state={backState} className="tp-focus-ring rounded font-mono text-xs font-bold text-blue-700 dark:text-blue-200 hover:underline inline-flex items-center gap-1">{a.displayRef} <ExternalLink className="w-3 h-3" aria-hidden="true" /></Link>
                      <span className="text-sm text-foreground truncate max-w-full">{a.subject || '(no subject)'}</span>
                      <span className="ml-auto text-[11px] text-muted-foreground/75 whitespace-nowrap">{formatDayTime(a.decidedAt || a.createdAt)} · {timeAgo(a.decidedAt || a.createdAt)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground/75 mt-1">
                      Approver {a.approverName || a.approverEmail} · requested by {a.requestedBy}
                      {a.decisionNote ? ` · “${a.decisionNote}”` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {/* Pending for me */}
            <section>
              <h2 className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground mb-2">Pending for you ({pending.length})</h2>
              {pending.length === 0 ? (
                <div className="tp-card rounded-xl p-6 text-center text-sm text-muted-foreground/75">
                  <Inbox className="w-6 h-6 mx-auto mb-2 text-muted-foreground/50" aria-hidden="true" /> Nothing awaiting your decision. 🎉
                </div>
              ) : (
                <ul className="space-y-2">
                  {pending.map((a) => (
                    <li key={a.id} className="tp-card rounded-xl p-4">
                      <div className="flex items-start gap-2 flex-wrap">
                        {a.categoryName && <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border border-blue-100 dark:border-blue-500/20">{a.categoryName}</span>}
                        <Link to={`/tickets/${a.ticketId}?tab=approvals`} state={backState} className="tp-focus-ring rounded font-mono text-xs font-bold text-blue-700 dark:text-blue-200 hover:underline inline-flex items-center gap-1">
                          {a.displayRef} <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </Link>
                        <span className="text-sm text-foreground font-medium truncate max-w-full">{a.subject || '(no subject)'}</span>
                        <span className="ml-auto text-[11px] text-muted-foreground/75 whitespace-nowrap">{formatDayTime(a.createdAt)} · {timeAgo(a.createdAt)}</span>
                      </div>
                      <p className="text-xs text-muted-foreground/75 mt-1">Requested by {a.requestedBy}{a.requesterName ? ` · for ${a.requesterName}` : ''}</p>
                      {a.requestNote && <p className="text-xs text-muted-foreground mt-1">“{a.requestNote}”</p>}

                      {clarifyingId === a.id ? (
                        <div className="mt-2 space-y-1.5">
                          <textarea
                            rows={2}
                            autoFocus
                            value={clarifyNote}
                            onChange={(e) => setClarifyNote(e.target.value)}
                            placeholder="What extra info do you need from the requester?"
                            className="tp-focus-ring w-full text-xs bg-card border border-violet-200 dark:border-violet-500/30 rounded-lg px-2.5 py-1.5 placeholder:text-muted-foreground/75 resize-y"
                          />
                          <div className="flex items-center gap-1.5">
                            <button onClick={() => sendClarify(a)} disabled={busyId === a.id || !clarifyNote.trim()} className="tp-focus-ring px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">Send to requester</button>
                            <button onClick={() => { setClarifyingId(null); setClarifyNote(''); }} className="tp-focus-ring px-2 py-1 text-[11px] font-medium rounded-lg text-muted-foreground hover:bg-muted">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
                          <button onClick={() => decide(a, 'approved')} disabled={busyId === a.id} className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                            {busyId === a.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Approve
                          </button>
                          <button onClick={() => decide(a, 'rejected')} disabled={busyId === a.id} className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
                            <X className="w-3 h-3" /> Reject
                          </button>
                          <button onClick={() => { setClarifyingId(a.id); setClarifyNote(''); }} disabled={busyId === a.id} className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-card text-violet-700 dark:text-violet-200 border border-violet-200 dark:border-violet-500/30 hover:bg-violet-50 dark:hover:bg-violet-500/15 disabled:opacity-50">
                            <MessageCircleQuestion className="w-3 h-3" /> Request clarification
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Needs my info */}
            {needsInfo.length > 0 && (
              <section>
                <h2 className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground mb-2">Needs your info ({needsInfo.length})</h2>
                <ul className="space-y-2">
                  {needsInfo.map((a) => (
                    <li key={a.id} className="tp-card rounded-xl p-4 border-l-2 border-l-violet-300 dark:border-l-violet-500/40">
                      <div className="flex items-start gap-2 flex-wrap">
                        {a.categoryName && <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border border-blue-100 dark:border-blue-500/20">{a.categoryName}</span>}
                        <Link to={`/tickets/${a.ticketId}?tab=approvals`} state={backState} className="tp-focus-ring rounded font-mono text-xs font-bold text-blue-700 dark:text-blue-200 hover:underline inline-flex items-center gap-1">
                          {a.displayRef} <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </Link>
                        <span className="text-sm text-foreground font-medium truncate max-w-full">{a.subject || '(no subject)'}</span>
                        <span className="ml-auto text-[11px] text-muted-foreground/75 whitespace-nowrap">{formatDayTime(a.createdAt)} · {timeAgo(a.createdAt)}</span>
                      </div>
                      {a.decisionNote && <p className="text-xs text-violet-600 dark:text-violet-300 mt-1.5">{a.approverEmail} asks: “{a.decisionNote}”</p>}
                      <div className="flex items-center gap-1.5 mt-2.5">
                        <button onClick={() => resubmit(a)} disabled={busyId === a.id} className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-blue-700 disabled:opacity-50">
                          {busyId === a.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Resubmit for approval
                        </button>
                        <Link to={`/tickets/${a.ticketId}?tab=conversation`} state={backState} className="tp-focus-ring px-2 py-1 text-[11px] font-medium rounded-lg text-muted-foreground hover:bg-muted">Add info on ticket →</Link>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </main>
      <MobileTabBar />
    </div>
  );
}
