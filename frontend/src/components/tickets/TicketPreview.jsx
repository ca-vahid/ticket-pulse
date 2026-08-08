import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity, Bot, CalendarDays, Check, ChevronDown, ChevronUp, ExternalLink, Hand, Inbox,
  Loader2, Lock, Mail, MapPin, Pencil, Phone, Sparkles, Trash2, VolumeX, X,
} from 'lucide-react';
import {
  ExternalChip, MirrorChip, OriginChip, PersonAvatar, PriorityDot, ProvenanceChip, SafeHtml, SlaChip, SlaTargetChip, StateChip, StatusPill,
  TagChip, TypePill, PRIORITY_LABELS, formatDayTime, isConversationEntry, pipelineRunLabel, pipelineTriggerLabel,
  ticketCategoryLabels, timeAgo,
} from './ticketUi';
import AssigneePicker from './AssigneePicker';
import AiAssignModal from './AiAssignModal';
import { PinnedCardChipsRow } from './PinnedIntakeCard';
import RecipientsLine from './RecipientsLine';
import FsSyncConfirm from './FsSyncConfirm';
import { assignmentAPI, ticketsAPI } from '../../services/api';
import { CANONICAL_STATUS_NAMES, baseStatusOf, isTerminalStatus, statusDefsFromMeta, statusToneFromDefs } from './statusDefs';
import { FRESHSERVICE_DOMAIN } from '../tech-detail/constants';
import { useWorkspaceRole } from '../nav/navDestinations';
import { looksLikeRealHtml } from '../../utils/htmlContent';

// Known-tag detector (QA 08-06 #5): plain text carrying angle-bracket tokens
// like <Processed> renders via the plain-text branch with the tokens intact.
function looksLikeHtml(s) {
  return looksLikeRealHtml(s);
}

const TABS = [
  { key: 'details', label: 'Details' },
  { key: 'conversation', label: 'Conversation' },
  { key: 'activity', label: 'Activity' },
];

/**
 * Peek drawer: a fixed overlay that slides in from the right WITHOUT
 * reflowing the queue — the list keeps its exact layout underneath and stays
 * clickable, so single-clicking other rows (or ↑/↓) walks tickets in place.
 * Double-click still opens the full page.
 */
export default function TicketPreview({ ticketId, meta, pulse = 0, onClose, onChanged, onStep, stepInfo }) {
  const navigate = useNavigate();
  const location = useLocation();
  // Return address so /tickets/:id's Back control comes back to the exact
  // originating queue view (filters + peek param intact).
  const openFullTicket = () => navigate(`/tickets/${ticketId}`, {
    state: { from: `${location.pathname}${location.search}` },
  });
  const [ticket, setTicket] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('details');
  const [saving, setSaving] = useState(null);
  const [confirmPickup, setConfirmPickup] = useState(false);

  // Abort the in-flight fetch when the user steps to another ticket (or closes)
  // so rapid ↑/↓ stepping doesn't pile up stale requests against the browser's
  // 6-connection limit. The peek also skips the live FreshService reconcile
  // (reconcile:false) — that check belongs on the full detail page, not on a
  // quick preview fired once per step.
  const abortRef = useRef(null);
  const load = useCallback(async ({ silent = false } = {}) => {
    if (!ticketId) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (!silent) setIsLoading(true);
    try {
      const res = await ticketsAPI.get(ticketId, { reconcile: false, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      setTicket(res.data);
      setError(null);
    } catch (err) {
      if (ctrl.signal.aborted || err.code === 'ERR_CANCELED' || err.name === 'CanceledError') return;
      setError(err.response?.data?.message || err.message);
    } finally {
      if (!ctrl.signal.aborted) setIsLoading(false);
    }
  }, [ticketId]);

  useEffect(() => { setTab('details'); setConfirmPickup(false); load(); }, [load]);
  useEffect(() => () => abortRef.current?.abort(), []);

  // Featured custom field (Phase 2): mirrors the queue-row chip as a Details
  // line. One fetch per mount — the peek outlives individual ticket steps.
  const [featuredDef, setFeaturedDef] = useState(null);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => ticketsAPI.customFieldDefinitions())
      .then((res) => { if (!cancelled) setFeaturedDef((res?.data || []).find((d) => d.isFeatured) || null); })
      .catch(() => { if (!cancelled) setFeaturedDef(null); });
    return () => { cancelled = true; };
  }, []);
  const featuredValue = featuredDef ? ticket?.customFields?.[featuredDef.key] : null;

  // SSE-driven refresh: the queue bumps `pulse` whenever tickets change.
  useEffect(() => { if (pulse > 0) load({ silent: true }); }, [pulse, load]);

  // Requester enrichment: Entra photo + their helpdesk history (both cached
  // server-side / cheap counts, keyed so stepping tickets re-fetches).
  const requesterEmail = ticket?.requester?.email || null;
  const requesterId = ticket?.requester?.id || null;
  const [requesterPhoto, setRequesterPhoto] = useState(null);
  const [requesterStats, setRequesterStats] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setRequesterPhoto(null);
    if (!requesterEmail) return undefined;
    ticketsAPI.requesterPhoto(requesterEmail)
      .then((res) => { if (!cancelled) setRequesterPhoto(res.data?.photo || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [requesterEmail]);
  useEffect(() => {
    let cancelled = false;
    setRequesterStats(null);
    if (!requesterId) return undefined;
    ticketsAPI.requesterStats(requesterId)
      .then((res) => { if (!cancelled) setRequesterStats(res.data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [requesterId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isNative = ticket?.origin === 'ticketpulse';
  // Workspace status registry (Phase 8b): TP-born tickets edit against it
  // (custom statuses included); FS-born stay canonical. Base-aware terminal/
  // paused checks keep custom statuses honest in the chips below.
  const statusDefs = useMemo(() => statusDefsFromMeta(meta), [meta]);
  const statusOptions = useMemo(
    () => (ticket?.origin === 'ticketpulse' ? statusDefs.map((d) => d.name) : CANONICAL_STATUS_NAMES),
    [ticket?.origin, statusDefs],
  );
  const ticketTerminal = ticket ? isTerminalStatus(statusDefs, ticket.status) : false;
  const ticketSlaPaused = ticket ? baseStatusOf(statusDefs, ticket.status) === 'Pending' : false;
  const ticketingOn = meta?.nativeTicketingEnabled !== false;
  const fsUrl = ticket?.freshserviceTicketId
    ? `https://${FRESHSERVICE_DOMAIN}/a/tickets/${ticket.freshserviceTicketId}`
    : null;
  const canWrite = isNative && ticketingOn;
  // AI assignment/review is reviewer/admin only — its endpoints are reviewer-gated
  // server-side, so agents/viewers must not see the review affordances.
  const wsRole = useWorkspaceRole();
  const canReview = wsRole === 'admin' || wsRole === 'reviewer';
  const canPickUp = canWrite && meta?.actor?.technicianId && ticket?.assignedTechId !== meta.actor.technicianId;

  const act = useCallback(async (field, fn) => {
    setSaving(field);
    try {
      await fn();
      await load({ silent: true });
      onChanged?.();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setSaving(null);
    }
  }, [load, onChanged]);

  // FS-born tickets take confirmed write-backs for the assignee (same flow as
  // the full detail page): show the picker, but writes go to FreshService after
  // a confirmation. AssigneePicker hides local agents on FS-born tickets.
  const fsEditable = !isNative && Boolean(ticket?.freshserviceTicketId);
  const [fsConfirm, setFsConfirm] = useState(null); // { changes, payload, resolve, reject }
  const [fsBusy, setFsBusy] = useState(false);
  const [fsError, setFsError] = useState(null);
  const requestFsSync = useCallback((changes, payload) => new Promise((resolve, reject) => {
    setFsError(null);
    setFsConfirm({ changes, payload, resolve, reject });
  }), []);
  const runFsSync = async () => {
    if (!fsConfirm) return;
    setFsBusy(true); setFsError(null);
    try {
      const res = await ticketsAPI.fsUpdate(ticketId, fsConfirm.payload);
      await load({ silent: true });
      onChanged?.();
      // Resolve WITH the {success, data} envelope so the awaiting picker sees
      // data.aiOverride and can raise the "why the override?" prompt (QA 08-04 #9).
      fsConfirm.resolve?.(res);
      setFsConfirm(null);
    } catch (err) {
      setFsError(err.response?.data?.message || err.message || 'FreshService rejected the change');
      // A timeout can fire while the write actually lands — show the TRUE state.
      load({ silent: true });
    } finally {
      setFsBusy(false);
    }
  };
  const cancelFsSync = () => { fsConfirm?.reject?.(new Error('cancelled')); setFsConfirm(null); setFsError(null); };
  const fsAssign = useCallback((techId) => {
    const tech = techId ? (meta?.technicians || []).find((t) => t.id === techId) : null;
    return requestFsSync(
      [{ field: 'Assignee', from: ticket?.assignedTech?.name || 'Unassigned', to: tech?.name || 'Unassigned' }],
      { assignedTechId: techId },
    );
  }, [requestFsSync, meta?.technicians, ticket?.assignedTech?.name]);

  const conversation = useMemo(() => {
    const entries = (ticket?.thread || []).filter(isConversationEntry);
    return entries.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt)).slice(0, 8);
  }, [ticket?.thread]);

  const activity = useMemo(() => (ticket?.activities || []).slice(0, 15), [ticket?.activities]);

  // ---- AI assignment: pending suggestion + live modal ----
  const [aiOpen, setAiOpen] = useState(false);
  const [aiDeciding, setAiDeciding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteTicket = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    try {
      await ticketsAPI.remove(ticketId);
      onChanged?.();
      onClose?.();
    } catch { setDeleting(false); setConfirmDelete(false); }
  };
  const aiPending = (ticket?.pipelineRuns || []).find((r) => r.status === 'completed' && r.decision === 'pending_review') || null;
  const aiTop = (() => {
    const rec = aiPending?.recommendation;
    const list = Array.isArray(rec?.recommendations) ? rec.recommendations : Array.isArray(rec) ? rec : [];
    return list[0] || null;
  })();
  const aiSuggestionForPicker = canReview && aiPending && aiTop
    ? { runId: aiPending.id, state: 'suggested', techId: aiTop.techId ?? null, techName: aiTop.techName || null, score: typeof aiTop.score === 'number' ? aiTop.score : null }
    : null;
  const approveAi = async () => {
    if (!aiPending || aiDeciding) return;
    setAiDeciding(true);
    try {
      await assignmentAPI.decide(aiPending.id, { decision: 'approved', assignedTechId: aiTop?.techId || undefined });
      await load({ silent: true });
      onChanged?.();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
    setAiDeciding(false);
  };

  const fieldClass = 'tp-focus-ring w-full text-xs bg-white border border-input rounded-lg px-2 py-1.5 text-slate-700 disabled:bg-slate-50 disabled:text-slate-400';

  return (
    <aside
      className="fixed inset-y-0 right-0 z-40 w-[440px] max-w-[94vw] bg-white border-l border-slate-200 shadow-soft flex flex-col animate-slide-in-right"
      aria-label="Ticket preview"
      role="complementary"
    >
      {/* Header */}
      <div className="p-3.5 border-b border-slate-100 bg-slate-50/60">
        <div className="flex items-center gap-2 mb-1">
          {/* min-w-0 + overflow-hidden lets the chip cluster shrink; the action
              cluster is flex-shrink-0 so the close X can never be pushed out
              of the panel (QA 07-14 #9). */}
          <span className="flex items-center gap-2 min-w-0 overflow-hidden">
            <span className="font-mono text-xs font-bold text-slate-500 whitespace-nowrap">{ticket?.displayRef || '…'}</span>
            {ticket && <OriginChip origin={ticket.origin} />}
            {ticket?.isExternal && <ExternalChip />}
            {ticket && <MirrorChip ticket={ticket} />}
            {ticket && <ProvenanceChip ticket={ticket} />}
          </span>
          <span className="ml-auto flex items-center gap-0.5 flex-shrink-0">
            {onStep && (
              <>
                <button
                  onClick={() => onStep(-1)}
                  disabled={!stepInfo || stepInfo.index <= 0}
                  aria-label="Previous ticket"
                  title="Previous ticket (↑)"
                  className="tp-focus-ring p-1.5 rounded-lg text-slate-400 hover:text-blue-700 hover:bg-blue-50 disabled:opacity-30"
                >
                  <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                {stepInfo && (
                  <span className="text-[10px] text-slate-400 tabular-nums px-0.5 whitespace-nowrap">
                    {stepInfo.index + 1}/{stepInfo.total}
                  </span>
                )}
                <button
                  onClick={() => onStep(1)}
                  disabled={!stepInfo || stepInfo.index >= stepInfo.total - 1}
                  aria-label="Next ticket"
                  title="Next ticket (↓)"
                  className="tp-focus-ring p-1.5 rounded-lg text-slate-400 hover:text-blue-700 hover:bg-blue-50 disabled:opacity-30"
                >
                  <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                <span className="w-px h-4 bg-slate-200 mx-1" aria-hidden="true" />
              </>
            )}
            {isNative && canReview && (
              <button
                onClick={deleteTicket}
                onBlur={() => setConfirmDelete(false)}
                disabled={deleting}
                aria-label={confirmDelete ? 'Confirm delete' : 'Delete ticket'}
                title="Delete this Ticket Pulse ticket"
                className={`tp-focus-ring inline-flex items-center gap-1 px-1.5 py-1 rounded-lg text-[11px] font-semibold ${
                  confirmDelete ? 'bg-red-600 text-white hover:bg-red-700' : 'text-slate-400 hover:text-red-600 hover:bg-red-50'
                }`}
              >
                {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />}
                {confirmDelete && 'Delete?'}
              </button>
            )}
            {fsUrl && (
              <a
                href={fsUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                aria-label="Open in FreshService (new tab)"
                title="Open in FreshService (new tab)"
                className="tp-focus-ring inline-flex items-center gap-1 px-1.5 py-1 rounded-lg text-[11px] font-semibold text-sky-600 hover:text-sky-700 hover:bg-sky-50"
              >
                FS <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              </a>
            )}
            <button
              onClick={openFullTicket}
              aria-label="Open full ticket"
              title="Open full ticket in Ticket Pulse"
              className="tp-focus-ring p-1.5 rounded-lg text-slate-400 hover:text-blue-700 hover:bg-blue-50"
            >
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button
              onClick={onClose}
              aria-label="Close preview"
              className="tp-focus-ring p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </span>
        </div>
        {ticket && (
          <>
            <h2 className="text-sm font-bold text-slate-900 leading-snug line-clamp-2">{ticket.subject || '(no subject)'}</h2>
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              <StateChip state={ticket.stateChip} />
              <TypePill type={ticket.ticketType} full />
              <StatusPill status={ticket.status} tone={statusToneFromDefs(statusDefs, ticket.status)} />
              <PriorityDot priority={ticket.priority} withLabel />
              {(ticket.frDueBy && !ticket.firstPublicAgentReplyAt && !ticketTerminal && !['Deleted', 'Spam'].includes(ticket.status)) && <SlaChip value={ticket.frDueBy} paused={ticketSlaPaused} />}
              {(ticket.tags || []).map((tag) => <TagChip key={tag.id} tag={tag} size="xs" />)}
              {(ticket.impact || ticket.urgency) && (
                <span className="text-[10px] text-slate-400">
                  {ticket.impact ? `Impact ${['Low', 'Medium', 'High'][ticket.impact - 1]}` : null}
                  {ticket.impact && ticket.urgency ? ' · ' : ''}
                  {ticket.urgency ? `Urgency ${['Low', 'Medium', 'High'][ticket.urgency - 1]}` : null}
                </span>
              )}
            </div>
            {ticket.mergedInto && (
              <p className="mt-1.5 rounded-lg bg-violet-50 border border-violet-200 px-2 py-1 text-[11px] text-violet-800">
                Merged into <span className="font-mono font-bold">{ticket.mergedInto.displayRef}</span> — the conversation continues there.
              </p>
            )}
          </>
        )}
      </div>

      {/* Tabs */}
      <div role="tablist" aria-label="Preview sections" className="flex items-center gap-1 px-3.5 pt-2.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`tp-focus-ring px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
              tab === t.key ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto settings-scrollbar p-3.5 space-y-3.5">
        {isLoading ? (
          <div className="py-10 text-center"><Activity className="w-6 h-6 animate-spin mx-auto text-blue-600" aria-label="Loading" /></div>
        ) : error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : ticket && tab === 'details' ? (
          <>
            {/* Requester card: photo, role, contact, helpdesk history */}
            <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
              <div className="flex items-start gap-3">
                {requesterPhoto ? (
                  <img src={requesterPhoto} alt="" className="h-11 w-11 rounded-full object-cover ring-2 ring-white shadow-subtle flex-shrink-0" />
                ) : (
                  <PersonAvatar name={ticket.requester?.name} size="h-11 w-11" textSize="text-sm" />
                )}
                <div className="min-w-0 flex-1 text-xs space-y-0.5">
                  <p className="text-sm font-bold text-slate-900 truncate">{ticket.requester?.name || 'Unknown requester'}</p>
                  {(ticket.requester?.entraJobTitle || ticket.requester?.jobTitle || ticket.requester?.entraDepartment || ticket.requester?.department) && (
                    <p className="text-slate-500 truncate">
                      {[ticket.requester.entraJobTitle || ticket.requester.jobTitle, ticket.requester.entraDepartment || ticket.requester.department]
                        .filter(Boolean).join(' · ')}
                    </p>
                  )}
                  {ticket.requester?.email && (
                    <p className="flex items-center gap-1.5 text-slate-400 truncate">
                      <Mail className="w-3 h-3 flex-shrink-0" aria-hidden="true" />{ticket.requester.email}
                    </p>
                  )}
                  {(ticket.requester?.entraOfficeLocation || ticket.requester?.entraCity) && (
                    <p className="flex items-center gap-1.5 text-slate-400 truncate">
                      <MapPin className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                      {[...new Set([ticket.requester.entraOfficeLocation, ticket.requester.entraCity, ticket.requester.entraState].filter(Boolean))].join(' · ')}
                    </p>
                  )}
                  {(ticket.requester?.phone || ticket.requester?.mobile) && (
                    <p className="flex items-center gap-1.5 text-slate-400 truncate">
                      <Phone className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                      {[...new Set([ticket.requester.phone, ticket.requester.mobile].filter(Boolean))].join(' · ')}
                    </p>
                  )}
                </div>
              </div>
              {requesterStats && requesterStats.total > 0 && (
                <div className="mt-2.5 pt-2 border-t border-slate-200/70 grid grid-cols-3 gap-1 text-center">
                  <span>
                    <span className="block text-sm font-bold text-slate-700">{requesterStats.total}</span>
                    <span className="block text-[9px] font-semibold uppercase tracking-wide text-slate-400">Tickets ever</span>
                  </span>
                  <span>
                    <span className={`block text-sm font-bold ${requesterStats.open > 0 ? 'text-amber-600' : 'text-slate-700'}`}>{requesterStats.open}</span>
                    <span className="block text-[9px] font-semibold uppercase tracking-wide text-slate-400">Open now</span>
                  </span>
                  <span>
                    <span className="block text-sm font-bold text-emerald-600">{requesterStats.resolved}</span>
                    <span className="block text-[9px] font-semibold uppercase tracking-wide text-slate-400">Resolved</span>
                  </span>
                </div>
              )}
            </div>

            {ticket.isNoise && canWrite && (
              <div className="flex flex-wrap items-center gap-2 p-2 bg-violet-50 border border-violet-200 rounded-lg text-[11px] text-violet-800">
                <VolumeX className="w-3.5 h-3.5 text-violet-500 flex-shrink-0" aria-hidden="true" />
                <span>Flagged as noise</span>
                <button
                  onClick={() => act('noise', () => ticketsAPI.setNoise(ticketId, { noise: false }))}
                  disabled={saving === 'noise'}
                  className="tp-focus-ring ml-auto inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded-lg bg-white text-violet-700 border border-violet-300 hover:bg-violet-100 disabled:opacity-50"
                >
                  {saving === 'noise' ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : null}
                  Not noise — restore
                </button>
              </div>
            )}

            {/* Quick edits */}
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-0.5">Status</span>
                <select
                  value={ticket.status}
                  disabled={!canWrite || saving === 'status'}
                  onChange={(e) => act('status', () => ticketsAPI.setStatus(ticketId, e.target.value))}
                  className={fieldClass}
                  aria-label="Status"
                >
                  {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                  {!statusOptions.includes(ticket.status) && <option value={ticket.status}>{ticket.status}</option>}
                </select>
              </label>
              <label className="block">
                <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-0.5">Priority</span>
                <select
                  value={ticket.priority}
                  disabled={!canWrite || saving === 'priority'}
                  onChange={(e) => act('priority', () => ticketsAPI.update(ticketId, { priority: Number(e.target.value) }))}
                  className={fieldClass}
                  aria-label="Priority"
                >
                  {[1, 2, 3, 4].map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
                </select>
              </label>
            </div>
            <div>
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-0.5">Assignee</span>
              {(canWrite || fsEditable) ? (
                <AssigneePicker
                  ticketId={ticketId}
                  value={ticket.assignedTechId}
                  currentTech={ticket.assignedTech}
                  technicians={meta?.technicians || []}
                  ticketOrigin={ticket.origin}
                  assignFn={fsEditable ? fsAssign : undefined}
                  showAi={canReview}
                  aiSuggestion={aiSuggestionForPicker}
                  onAiAssign={canReview ? () => setAiOpen(true) : null}
                  onAssigned={() => { load({ silent: true }); onChanged?.(); }}
                />
              ) : (
                <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-100">
                  <PersonAvatar name={ticket.assignedTech?.name} photoUrl={ticket.assignedTech?.photoUrl} size="h-6 w-6" />
                  <span className="text-sm text-slate-600 truncate">{ticket.assignedTech?.name || 'Unassigned'}</span>
                </div>
              )}
              {canReview && aiPending && aiTop && !ticket.assignedTechId && (
                <div className="mt-1.5 rounded-lg border border-indigo-200 bg-gradient-to-r from-indigo-50 to-violet-50/60 p-2">
                  <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-indigo-500 mb-1">
                    <Sparkles className="w-3 h-3" aria-hidden="true" /> AI suggests
                  </p>
                  <div className="flex items-center gap-2 min-w-0">
                    <PersonAvatar
                      name={aiTop.techName || '?'}
                      photoUrl={(meta?.technicians || []).find((t) => t.id === aiTop.techId)?.photoUrl}
                      size="h-6 w-6"
                    />
                    <span className="text-xs font-semibold text-slate-800 truncate flex-1">{aiTop.techName || 'Unknown'}</span>
                    {typeof aiTop.score === 'number' && (
                      <span className="text-[10px] text-indigo-500 font-medium whitespace-nowrap">{Math.round(aiTop.score * 100)}%</span>
                    )}
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <button
                      onClick={approveAi}
                      disabled={aiDeciding}
                      className="tp-focus-ring flex-1 px-2 py-1 rounded-md bg-indigo-600 text-white text-[11px] font-semibold hover:bg-indigo-700 disabled:opacity-60"
                    >
                      {aiDeciding ? 'Approving…' : 'Approve'}
                    </button>
                    <button
                      onClick={() => setAiOpen(true)}
                      className="tp-focus-ring px-2 py-1 rounded-md border border-indigo-200 text-indigo-700 text-[11px] font-medium hover:bg-indigo-100/60"
                    >
                      Review…
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Description — full rich rendering, same sanitizer as the detail page */}
            {(ticket.descriptionText || ticket.description) && (
              <div>
                <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Description</span>
                {/* Who else received the original email (QA 08-05 #3) */}
                <RecipientsLine to={ticket.toEmails} cc={ticket.ccEmails} compact className="mb-1" />
                <div className="rounded-lg border border-slate-100 bg-white p-2.5 max-h-64 overflow-y-auto settings-scrollbar">
                  {looksLikeHtml(ticket.description) ? (
                    <SafeHtml html={ticket.description} className="!text-xs" />
                  ) : (
                    <p className="text-xs text-slate-600 whitespace-pre-wrap break-words">
                      {(ticket.descriptionText || ticket.description || '').replace(/\n{3,}/g, '\n\n').trim()}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Pinned workflow field cards — compact chips-only row (Phase 1) */}
            <PinnedCardChipsRow cards={ticket.pinnedCards || []} currentValues={ticket.customFields || {}} />

            {/* Ticket details */}
            <div>
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Details</span>
              <dl className="rounded-lg border border-slate-100 divide-y divide-slate-50 text-xs">
                <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <dt className="flex items-center gap-1.5 text-slate-400 w-24 flex-shrink-0"><CalendarDays className="w-3 h-3" aria-hidden="true" />Created</dt>
                  <dd className="text-slate-600 truncate" title={new Date(ticket.createdAt).toLocaleString()}>
                    {formatDayTime(ticket.createdAt)}
                    <span className="text-slate-400"> · {timeAgo(ticket.createdAt)}</span>
                  </dd>
                </div>
                {ticket.frDueBy && !['Deleted', 'Spam'].includes(ticket.status) && (
                  <div className="flex items-center gap-2 px-2.5 py-1.5">
                    <dt className="text-slate-400 w-24 flex-shrink-0 pl-[18px]">First response</dt>
                    <dd className="flex items-center gap-1.5 min-w-0">
                      <span className="text-slate-600" title={`${new Date(ticket.frDueBy).toLocaleString()}${isNative ? '' : ' — FreshService owns this date'}`}>{formatDayTime(ticket.frDueBy)}</span>
                      <SlaTargetChip target={ticket.frDueBy} metAt={ticket.firstPublicAgentReplyAt} status={ticket.status} terminal={ticketTerminal} paused={ticketSlaPaused} kind="response" className="!px-1.5 !text-[10px]" />
                      {canWrite && (
                        <button
                          onClick={openFullTicket}
                          aria-label="Edit first response due date on the full ticket"
                          title="Edit due date on the full ticket"
                          className="tp-focus-ring rounded p-0.5 text-slate-300 hover:bg-slate-100 hover:text-slate-600"
                        >
                          <Pencil className="h-3 w-3" aria-hidden="true" />
                        </button>
                      )}
                    </dd>
                  </div>
                )}
                {/* The pencil deep-links into the full ticket, where the due
                    editor lives (QA 08-04 #13) — no inline editing in the peek.
                    TP-born tickets without a clock still get the row so the
                    affordance is discoverable. */}
                {(ticket.dueBy || canWrite) && !['Deleted', 'Spam'].includes(ticket.status) && (
                  <div className="flex items-center gap-2 px-2.5 py-1.5">
                    <dt className="text-slate-400 w-24 flex-shrink-0 pl-[18px]">Resolution</dt>
                    <dd className="flex items-center gap-1.5 min-w-0">
                      {ticket.dueBy ? (
                        <>
                          <span className="text-slate-600" title={`${new Date(ticket.dueBy).toLocaleString()}${isNative ? '' : ' — FreshService owns this date'}`}>{formatDayTime(ticket.dueBy)}</span>
                          <SlaTargetChip target={ticket.dueBy} metAt={ticket.resolvedAt || ticket.closedAt} status={ticket.status} terminal={ticketTerminal} paused={ticketSlaPaused} kind="resolution" className="!px-1.5 !text-[10px]" />
                        </>
                      ) : (
                        <span className="text-slate-300">Not set</span>
                      )}
                      {canWrite && (
                        <button
                          onClick={openFullTicket}
                          aria-label="Edit resolution due date on the full ticket"
                          title="Edit due date on the full ticket"
                          className="tp-focus-ring rounded p-0.5 text-slate-300 hover:bg-slate-100 hover:text-slate-600"
                        >
                          <Pencil className="h-3 w-3" aria-hidden="true" />
                        </button>
                      )}
                    </dd>
                  </div>
                )}
                <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <dt className="flex items-center gap-1.5 text-slate-400 w-24 flex-shrink-0"><Inbox className="w-3 h-3" aria-hidden="true" />Category</dt>
                  <dd className="text-slate-600 truncate" title={[ticketCategoryLabels(ticket).category, ticketCategoryLabels(ticket).subcategory].filter(Boolean).join(' / ') || undefined}>
                    {ticketCategoryLabels(ticket).category || 'Uncategorized'}
                    {ticketCategoryLabels(ticket).subcategory && <span className="text-slate-400"> / {ticketCategoryLabels(ticket).subcategory}</span>}
                  </dd>
                </div>
                {/* Featured custom field (Phase 2) — same line the queue chip shows */}
                {featuredDef && featuredValue !== null && featuredValue !== undefined && featuredValue !== '' && (
                  <div className="flex items-center gap-2 px-2.5 py-1.5" data-testid="peek-featured-field">
                    <dt className="text-slate-400 w-24 flex-shrink-0 pl-[18px] truncate" title={featuredDef.label}>{featuredDef.label}</dt>
                    <dd className="text-slate-600 truncate" title={String(featuredValue)}>
                      {typeof featuredValue === 'boolean' ? (featuredValue ? 'Yes' : 'No') : String(featuredValue)}
                    </dd>
                  </div>
                )}
                {ticket.groupId && (meta?.groups || []).some((g) => String(g.freshserviceId) === String(ticket.groupId)) && (
                  <div className="flex items-center gap-2 px-2.5 py-1.5">
                    <dt className="text-slate-400 w-24 flex-shrink-0 pl-[18px]">Group</dt>
                    <dd className="text-slate-600 truncate">{(meta.groups.find((g) => String(g.freshserviceId) === String(ticket.groupId)) || {}).name}</dd>
                  </div>
                )}
                {ticket.source != null && (meta?.sources || []).some((s) => s.value === ticket.source) && (
                  <div className="flex items-center gap-2 px-2.5 py-1.5">
                    <dt className="text-slate-400 w-24 flex-shrink-0 pl-[18px]">Source</dt>
                    <dd className="text-slate-600 truncate">{(meta.sources.find((s) => s.value === ticket.source) || {}).label}</dd>
                  </div>
                )}
                {canReview && (() => {
                  const runs = ticket.pipelineRuns || [];
                  // Lead with the latest DECIDED run — a queued follow-up must
                  // not hide a completed assessment (the after-hours case).
                  const lead = runs.find((r) => r.status !== 'queued') || runs[0] || null;
                  const queuedToo = Boolean(lead && lead.status !== 'queued' && runs.some((r) => r.status === 'queued'));
                  return (
                    <div className="flex items-center gap-2 px-2.5 py-1.5">
                      <dt className="flex items-center gap-1.5 text-slate-400 w-24 flex-shrink-0"><Sparkles className="w-3 h-3 text-indigo-400" aria-hidden="true" />AI runs</dt>
                      <dd className="min-w-0 truncate">
                        {lead ? (
                          <Link
                            to={`/assignments/history/${lead.id}`}
                            className="tp-focus-ring inline-flex items-center gap-1 text-indigo-600 hover:underline rounded"
                            title={`via ${pipelineTriggerLabel(lead.triggerSource)}`}
                          >
                            <Bot className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                            {pipelineRunLabel(lead)}
                            <span className="text-slate-400"> · {timeAgo(lead.decidedAt || lead.createdAt)}</span>
                            {queuedToo && <span className="text-amber-600"> · +1 queued</span>}
                            {runs.length > 1 && !queuedToo && <span className="text-slate-400"> · {runs.length} runs</span>}
                          </Link>
                        ) : (
                          <button
                            onClick={() => setAiOpen(true)}
                            className="tp-focus-ring inline-flex items-center gap-1 text-indigo-600 hover:underline rounded"
                            title="Run the assignment pipeline and watch it live"
                          >
                            <Sparkles className="w-3 h-3" aria-hidden="true" /> no run yet — run now
                          </button>
                        )}
                      </dd>
                    </div>
                  );
                })()}
              </dl>
            </div>
          </>
        ) : ticket && tab === 'conversation' ? (
          conversation.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-6">No conversation yet.</p>
          ) : (
            <ul className="space-y-2.5">
              {conversation.map((e) => (
                <li key={e.id} className={`rounded-lg border p-2.5 ${e.isPrivate ? 'bg-amber-50/70 border-amber-200' : (e.incoming || e.authorType === 'requester') ? 'bg-indigo-50/60 border-indigo-100' : 'bg-white border-slate-200'}`}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-xs font-semibold text-slate-700 truncate">{e.actorName || (e.isPrivate ? 'Ticket Pulse' : 'Unknown')}</span>
                    {e.isPrivate
                      ? <Lock className="w-2.5 h-2.5 text-amber-600" aria-label="Internal note" />
                      : <Mail className="w-2.5 h-2.5 text-blue-500" aria-label="Public reply" />}
                    <span className="ml-auto flex items-center gap-1 whitespace-nowrap">
                      {e.editedAt && (
                        <span
                          className="text-[9px] font-medium text-slate-400 bg-slate-100/80 border border-slate-200 rounded-full px-1 py-px"
                          title={`Edited ${e.editedBy ? `by ${e.editedBy} · ` : ''}${new Date(e.editedAt).toLocaleString()}`}
                        >
                          edited
                        </span>
                      )}
                      <span className="text-[10px] text-slate-400">{timeAgo(e.occurredAt)}</span>
                    </span>
                  </div>
                  {e.bodyHtml && looksLikeHtml(e.bodyHtml) ? (
                    <div className="max-h-44 overflow-y-auto settings-scrollbar">
                      <SafeHtml html={e.bodyHtml} className="!text-xs" />
                    </div>
                  ) : (
                    <p className="text-xs text-slate-600 whitespace-pre-wrap break-words max-h-44 overflow-y-auto settings-scrollbar">
                      {String(e.bodyText || e.content || '').replace(/\n{2,}/g, '\n').trim()}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : ticket && tab === 'activity' ? (
          activity.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-6">No activity recorded.</p>
          ) : (
            <ul className="space-y-1.5">
              {activity.map((a) => (
                <li key={a.id} className="flex items-start gap-2 text-xs text-slate-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-300 mt-1.5 flex-shrink-0" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="font-medium text-slate-600 capitalize">{String(a.activityType || '').replace(/_/g, ' ')}</span>
                    {a.performedBy ? ` · ${a.performedBy}` : ''}
                    <span className="text-slate-400"> · {timeAgo(a.performedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>

      {/* Footer actions */}
      {ticket && (
        <div className="p-3 border-t border-slate-100 flex items-center gap-2">
          {canPickUp && (
            <button
              onClick={() => {
                if (!confirmPickup) { setConfirmPickup(true); return; }
                setConfirmPickup(false);
                act('pickup', () => ticketsAPI.assign(ticketId, meta.actor.technicianId));
              }}
              onBlur={() => setConfirmPickup(false)}
              disabled={saving === 'pickup'}
              className={`tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border ${
                confirmPickup ? 'bg-blue-600 text-white border-blue-600' : 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
              }`}
            >
              {saving === 'pickup' ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Hand className="w-3 h-3" aria-hidden="true" />}
              {confirmPickup ? 'Confirm?' : 'Pick up'}
            </button>
          )}
          {canWrite && !ticketTerminal && (
            <button
              onClick={() => act('resolve', () => ticketsAPI.setStatus(ticketId, 'Resolved'))}
              disabled={saving === 'resolve'}
              className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
            >
              {saving === 'resolve' ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Check className="w-3 h-3" aria-hidden="true" />}
              Resolve
            </button>
          )}
          <button
            onClick={openFullTicket}
            className="tp-focus-ring ml-auto px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-blue-700"
          >
            Open full ticket
          </button>
        </div>
      )}

      {aiOpen && ticket && (
        <AiAssignModal
          ticket={ticket}
          onClose={() => setAiOpen(false)}
          onDone={() => { load({ silent: true }); onChanged?.(); }}
        />
      )}

      {fsConfirm && ticket && (
        <FsSyncConfirm
          fsRef={String(ticket.freshserviceTicketId)}
          changes={fsConfirm.changes}
          busy={fsBusy}
          error={fsError}
          onConfirm={runFsSync}
          onCancel={cancelFsSync}
        />
      )}
    </aside>
  );
}
