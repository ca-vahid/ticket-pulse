import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowUpRight, Ban, CheckCircle2, ChevronRight, Clock, Forward, MessageCircleQuestion, RefreshCw, Reply, Trash2, XCircle,
} from 'lucide-react';
import { BrandArt, PersonAvatar, SafeHtml, formatDayTime, timeAgo } from './ticketUi';
import { AmountChip, TierChip, handoffSentence } from './ApprovalHandoff';
import ApprovalComposer from './ApprovalComposer';
import ApprovalThread, { WaitingOnApproverChip } from './ApprovalThread';
import RichTextEditor, { isRichContent } from './RichTextEditor';
import { ticketsAPI } from '../../services/api';
import { useRequesterPhoto } from '../../hooks/useRequesterPhoto';

/** Approvals v3: an agent / approver answers an open question in-app. */
function AnswerBox({ message, busy, onSend, onCancel }) {
  const [text, setText] = useState('');
  const [html, setHtml] = useState('');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="mt-2 rounded-xl border border-violet-200 bg-violet-50/40 p-2.5 dark:border-violet-500/30 dark:bg-violet-500/10" data-testid="answer-box">
      <p className="mb-1.5 text-[12px] text-muted-foreground">
        Answering <span className="font-semibold text-foreground">{message?.author?.name || message?.author?.email || 'the approver'}</span>
        {message?.bodyText ? <>: “{String(message.bodyText).slice(0, 140)}{String(message.bodyText).length > 140 ? '…' : ''}”</> : null}
        {message?.audience === 'internal' ? ' · internal, the requester is not copied' : ' · everyone on the request is told'}
      </p>
      <RichTextEditor ref={ref} value={html} onChange={({ html: h, text: t }) => { setHtml(h); setText(t); }} placeholder="Your answer…" ariaLabel="Your answer" minHeight={140} className="border-input bg-card" />
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => { const t = text.trim(); if (t) onSend({ bodyText: t, bodyHtml: isRichContent(html) ? html : null }); }}
          disabled={busy || !text.trim()}
          className="tp-focus-ring inline-flex items-center gap-1 rounded-lg bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {busy ? <Activity className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Reply className="h-3 w-3" aria-hidden="true" />} Send answer
        </button>
        <button type="button" onClick={onCancel} className="tp-focus-ring rounded-lg px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted">Cancel</button>
      </div>
    </div>
  );
}

// Approvals v2: the category's tier chain as the request modal sees it.
const chainOf = (cat) => (Array.isArray(cat?.tiers) && cat.tiers.length
  ? cat.tiers
  : [{ name: 'Tier 1', managerEmails: cat?.managerEmails || [], limit: null }]);

// Per-approver / verdict status → color-coded look (dot, chip, text, header tint).
const STATUS = {
  approved: { label: 'Approved', verb: 'Approved', Icon: CheckCircle2, dot: 'bg-emerald-500', chip: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 border-emerald-200 dark:border-emerald-500/30', text: 'text-emerald-700 dark:text-emerald-200', head: 'bg-emerald-50/70 dark:bg-emerald-500/10 border-emerald-100 dark:border-emerald-500/20' },
  rejected: { label: 'Not approved', verb: 'Not approved', Icon: XCircle, dot: 'bg-red-500', chip: 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 border-red-200 dark:border-red-500/30', text: 'text-red-700 dark:text-red-200', head: 'bg-red-50/70 dark:bg-red-500/10 border-red-100 dark:border-red-500/20' },
  info_requested: { label: 'Needs info', verb: 'Clarification requested', Icon: MessageCircleQuestion, dot: 'bg-violet-500', chip: 'bg-violet-50 dark:bg-violet-500/15 text-violet-700 dark:text-violet-200 border-violet-200 dark:border-violet-500/30', text: 'text-violet-700 dark:text-violet-200', head: 'bg-violet-50/70 dark:bg-violet-500/10 border-violet-100 dark:border-violet-500/20' },
  cancelled: { label: 'Cancelled', verb: 'Cancelled', Icon: Ban, dot: 'bg-muted-foreground/40', chip: 'bg-muted text-muted-foreground border-border', text: 'text-muted-foreground', head: 'bg-muted/50 border-border/60' },
  escalated: { label: 'Escalated', verb: 'Escalated', Icon: ArrowUpRight, dot: 'bg-amber-500', chip: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 border-amber-200 dark:border-amber-500/30', text: 'text-amber-700 dark:text-amber-200', head: 'bg-amber-50/60 dark:bg-amber-500/10 border-amber-100 dark:border-amber-500/20' },
  forwarded: { label: 'Forwarded', verb: 'Forwarded', Icon: Forward, dot: 'bg-blue-500', chip: 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border-blue-200 dark:border-blue-500/30', text: 'text-blue-700 dark:text-blue-200', head: 'bg-blue-50/60 dark:bg-blue-500/10 border-blue-100 dark:border-blue-500/20' },
  pending: { label: 'Pending', verb: 'Pending', Icon: Clock, dot: 'bg-amber-400', chip: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 border-amber-200 dark:border-amber-500/30', text: 'text-amber-700 dark:text-amber-200', head: 'bg-amber-50/60 dark:bg-amber-500/10 border-amber-100 dark:border-amber-500/20' },
};
const statusMeta = (s) => STATUS[s] || STATUS.pending;

// Any-one-approves: the group verdict is the strongest outcome present.
const VERDICT_ORDER = ['approved', 'rejected', 'info_requested', 'pending', 'escalated', 'forwarded', 'cancelled'];
const groupVerdict = (rows) => VERDICT_ORDER.find((s) => rows.some((r) => r.status === s)) || 'pending';
// A decided group needs no interaction — collapse it to a one-line summary.
const TERMINAL = new Set(['approved', 'rejected', 'cancelled']);

// A cancelled row that was auto-cancelled by a sibling decision reads as
// "Superseded"; a requester-cancelled one stays "Cancelled".
const rowLabel = (ap) => {
  if (ap.status === 'cancelled' && /^superseded/i.test(ap.decisionNote || '')) return 'Superseded';
  if (ap.status === 'escalated') {
    const last = [...(ap.escalationLog || [])].reverse()[0];
    return last?.kind === 'auto' ? 'Approved · sent up' : 'Escalated';
  }
  return statusMeta(ap.status).label;
};

/**
 * Polished, grouped approval timeline. Each request (one category fanned out to
 * its managers, tied by requestGroupId) is one card: a header with the category,
 * overall verdict and requester, then a vertical rail of approver rows with live
 * status, decision notes, and the approver/requester actions.
 */
/** Approver avatar: roster photo when the workspace knows one, else the directory photo by e-mail (app-only members). */
// Layered-glass status art for the card header, by overall verdict.
const VERDICT_ART = { approved: 'approval-stamp', rejected: 'approval-rejected', pending: 'approval-waiting', info_requested: 'approval-question', escalated: 'approval-escalate', forwarded: 'approval-forward' };

function ApproverAvatar({ email, name, photoUrl, size = 'h-8 w-8', textSize = 'text-[10px]' }) {
  const fetched = useRequesterPhoto(photoUrl ? null : email);
  const url = photoUrl || (typeof fetched === 'string' ? fetched : fetched?.photo) || null;
  return <PersonAvatar name={name || email} photoUrl={url} size={size} textSize={textSize} />;
}

export default function ApprovalTimeline({
  approvals = [], meta, savingField,
  onDecide, onResubmit, onCancel, onChangeDecision, onDeleteRequest,
  onEscalate, onForward,
  // Approvals v3
  ticketId = null, requester = null, onAsk, onAnswer,
}) {
  const actorEmail = String(meta?.actor?.email || '').toLowerCase();
  const actorIsAdmin = meta?.actor?.kind === 'admin' || meta?.actor?.workspaceRole === 'admin';
  // Requester replies to a needs-info question, keyed per approval row (QA 07-14 #1).
  const [resubmitNotes, setResubmitNotes] = useState({});
  // Approvals v3: the conversation on every request of this ticket, and which
  // question is being answered in-app.
  const [messages, setMessages] = useState([]);
  const [answering, setAnswering] = useState(null); // message
  const [answerBusy, setAnswerBusy] = useState(false);
  const loadMessages = useCallback(async () => {
    if (!ticketId) return;
    try {
      const res = await ticketsAPI.approvalMessages(ticketId);
      const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      setMessages(list);
    } catch { /* the thread is optional — the rows still render */ }
  }, [ticketId]);
  useEffect(() => { loadMessages(); }, [loadMessages, approvals]);
  const people = useMemo(() => {
    const map = new Map();
    for (const t of [...(meta?.technicians || []), ...(meta?.members || [])]) {
      if (!t?.email) continue;
      const key = String(t.email).toLowerCase();
      if (!map.has(key) || (!map.get(key).photoUrl && t.photoUrl)) map.set(key, { name: t.name || t.email, email: key, photoUrl: t.photoUrl || null, role: t.role || null });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [meta?.technicians, meta?.members]);
  // Hand-off log entries carry e-mails; read them as names where we know the person.
  const named = (entry) => (entry ? {
    ...entry,
    toNames: (entry.toNames && entry.toNames.length ? entry.toNames : (entry.toEmails || []).map((e) => people.find((p) => p.email === String(e).toLowerCase())?.name || e)),
    byName: entry.byName || (entry.byEmail ? (people.find((p) => p.email === String(entry.byEmail).toLowerCase())?.name || entry.byEmail) : null),
  } : entry);
  const groups = useMemo(() => {
    const map = new Map();
    for (const ap of approvals) {
      const key = ap.requestGroupId || `single-${ap.id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(ap);
    }
    for (const rows of map.values()) rows.sort((a, b) => a.id - b.id);
    return [...map.values()].sort((a, b) => new Date(b[0].createdAt) - new Date(a[0].createdAt));
  }, [approvals]);

  return (
    <ul className="space-y-3 mb-4">
      {groups.map((rows) => {
        const head = rows[0];
        const verdict = groupVerdict(rows);
        const vMeta = statusMeta(verdict);
        const category = head.approvalCategory?.name;
        const decided = TERMINAL.has(verdict);
        // The approver whose decision set the verdict (for the decided summary).
        const decider = decided ? (rows.find((r) => r.status === verdict) || null) : null;
        const otherCount = decider ? rows.length - 1 : 0;
        const groupBusy = savingField === `approval-${head.id}`;
        const canRequesterManage = actorIsAdmin || (actorEmail && head.requestedBy === actorEmail);
        const canChangeVerdict = decider && (actorIsAdmin || actorEmail === String(decider.approverEmail || '').toLowerCase());
        const flipTo = verdict === 'approved' ? 'rejected' : 'approved';
        const tiers = chainOf(head.approvalCategory);
        const tierCount = tiers.length;
        const liveTier = Math.max(...rows.map((r) => r.tier || 1));
        return (
          <li key={head.requestGroupId || head.id} className="rounded-xl border border-border bg-card shadow-subtle overflow-hidden animate-fadeIn">
            {/* Group header — category + overall verdict, tinted to match */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3.5 border-b border-border/70">
              <BrandArt name={VERDICT_ART[verdict] || 'approval-waiting'} className="h-7 w-7" />
              {category && (
                <span className="text-[15px] font-semibold text-foreground">{category}</span>
              )}
              <span className={`inline-flex items-center gap-1 text-[13px] font-semibold ${vMeta.text}`}>
                <vMeta.Icon className="w-3.5 h-3.5" aria-hidden="true" /> {vMeta.label}
              </span>
              <AmountChip amount={head.amount} currency={head.amountCurrency || head.approvalCategory?.amountCurrency} />
              {!decided && <TierChip tier={liveTier} tierName={(tiers[liveTier - 1] || {}).name} tierCount={tierCount} />}
              <span className="ml-auto text-[11px] text-muted-foreground/75 whitespace-nowrap" title={new Date(head.createdAt).toLocaleString()}>
                {formatDayTime(head.createdAt)}
                {' · '}{timeAgo(head.createdAt)}
              </span>
            </div>

            {/* Decided → compact summary (who decided, when). No dated rail.
                Actions sit on the RIGHT so they read as secondary to the verdict. */}
            {decided ? (
              <div className="px-5 py-5 flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  {decider ? (
                    <div className="flex items-center gap-3.5">
                      <div className="relative flex-shrink-0">
                        <ApproverAvatar email={String(decider.approverEmail || '').toLowerCase()} name={decider.approverName || decider.approverEmail} size="h-11 w-11" textSize="text-xs" />
                        <span className={`absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full border-2 border-card ${vMeta.dot} flex items-center justify-center`}>
                          <vMeta.Icon className="w-2.5 h-2.5 text-white" aria-hidden="true" />
                        </span>
                      </div>
                      <div className="min-w-0">
                        <p className="text-[15px] text-foreground/85">
                          <span className={`font-semibold ${vMeta.text}`}>{vMeta.verb}</span> by <span className="font-semibold text-foreground">{decider.approverName || decider.approverEmail}</span>
                          {decider.decidedAt && <span className="text-muted-foreground/75" title={new Date(decider.decidedAt).toLocaleString()}> · {formatDayTime(decider.decidedAt)} · {timeAgo(decider.decidedAt)}</span>}
                        </p>
                        <p className="text-[13px] text-muted-foreground mt-0.5">
                          Requested by {head.requestedByName || head.requestedBy}
                          {otherCount > 0 && <> · {otherCount} other approver{otherCount === 1 ? '' : 's'} auto-cancelled</>}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[15px] text-muted-foreground">Cancelled · requested by {head.requestedByName || head.requestedBy}</p>
                  )}
                  {/* What was asked for stays on the decided card (16 Sep 2026):
                      the verdict alone lost the agent's own words. */}
                  {head.requestNoteHtml ? (
                    <div className="mt-4 text-sm leading-relaxed text-muted-foreground border-l-2 border-border pl-3.5" data-testid="timeline-request-note">
                      <SafeHtml html={head.requestNoteHtml} className="text-sm text-muted-foreground" />
                    </div>
                  ) : head.requestNote && (
                    <p className="mt-4 text-sm leading-relaxed text-muted-foreground italic border-l-2 border-border pl-3.5" data-testid="timeline-request-note">“{head.requestNote}”</p>
                  )}
                  {decider?.conditionNote && verdict === 'approved' && (
                    <div className="mt-4 border-l-2 border-amber-400 dark:border-amber-500/60 pl-3.5" data-testid="timeline-condition">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Condition</p>
                      <p className="mt-1 text-[15px] leading-relaxed text-foreground/85">{decider.conditionNote}</p>
                    </div>
                  )}
                  {decider?.decisionNoteHtml && !/^superseded/i.test(decider.decisionNote || '') ? (
                    <div className="mt-4"><SafeHtml html={decider.decisionNoteHtml} className="text-sm leading-relaxed text-foreground/85" /></div>
                  ) : decider?.decisionNote && !/^superseded/i.test(decider.decisionNote) && (
                    <p className="text-sm leading-relaxed text-foreground/85 mt-4 italic">“{decider.decisionNote}”</p>
                  )}
                </div>
                {(canChangeVerdict || canRequesterManage) && (verdict === 'approved' || verdict === 'rejected') && (
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    {canChangeVerdict && (
                      <button
                        onClick={() => onChangeDecision?.({ approvalId: decider.id, from: verdict, to: flipTo, categoryName: category, approverName: decider.approverName || decider.approverEmail })}
                        disabled={groupBusy || savingField === `approval-${decider.id}`}
                        title={`Change this decision to ${flipTo === 'rejected' ? 'not approved' : flipTo}`}
                        className={`tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg border disabled:opacity-50 ${
                          flipTo === 'approved'
                            ? 'bg-card text-emerald-700 dark:text-emerald-200 border-emerald-200 dark:border-emerald-500/30 hover:bg-emerald-50 dark:hover:bg-emerald-500/15'
                            : 'bg-card text-red-700 dark:text-red-200 border-red-200 dark:border-red-500/30 hover:bg-red-50 dark:hover:bg-red-500/15'
                        }`}
                      >
                        <RefreshCw className="w-3 h-3" aria-hidden="true" /> Change to {flipTo === 'rejected' ? 'not approved' : flipTo}
                      </button>
                    )}
                    {canRequesterManage && (
                      <button
                        onClick={() => onDeleteRequest?.(head)}
                        disabled={groupBusy}
                        className="tp-focus-ring inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-lg text-muted-foreground/75 hover:bg-red-50 dark:hover:bg-red-500/15 hover:text-red-600 dark:hover:text-red-300"
                      >
                        <Trash2 className="w-3 h-3" aria-hidden="true" /> Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="px-3.5 py-3">
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>Requested by <span className="font-medium text-muted-foreground">{head.requestedByName || head.requestedBy}</span>
                    {rows.length > 1 && <span className="text-muted-foreground/75"> · {rows.length} approvers · any one decides</span>}</span>
                  {(() => {
                    const groupId = head.requestGroupId || `single-${head.id}`;
                    const gm = messages.filter((m) => m.requestGroupId === groupId);
                    const answered = new Set(gm.filter((m) => m.kind === 'answer' && m.inReplyToId).map((m) => m.inReplyToId));
                    const awaiting = gm.some((m) => m.kind === 'question' && m.audience === 'internal' && !answered.has(m.id));
                    const viewerIsApprover = rows.some((r) => String(r.approverEmail).toLowerCase() === actorEmail);
                    return awaiting && !viewerIsApprover ? <WaitingOnApproverChip /> : null;
                  })()}
                </p>
                {head.requestNoteHtml ? (
                  <div className="mt-1 text-xs text-muted-foreground border-l-2 border-border pl-2">
                    <SafeHtml html={head.requestNoteHtml} className="text-xs text-muted-foreground" />
                  </div>
                ) : head.requestNote && (
                  <p className="mt-1 text-xs text-muted-foreground italic border-l-2 border-border pl-2">“{head.requestNote}”</p>
                )}

                {/* Approver rail */}
                <ol className="mt-3 space-y-3">
                  {rows.map((ap, i) => {
                    const sm = statusMeta(ap.status);
                    const approverKey = String(ap.approverEmail || '').toLowerCase();
                    const person = people.find((p) => p.email === approverKey) || null;
                    const approverLabel = ap.approverName || person?.name || ap.approverEmail;
                    // Only the named approver decides (Vahid, 17 Sep 2026). Admins see the row and can forward it.
                    const isApprover = Boolean(actorEmail) && actorEmail === approverKey;
                    const canForwardAsAdmin = actorIsAdmin && !isApprover && typeof onForward === 'function';
                    const isRequester = meta?.actor && (meta.actor.email === ap.requestedBy || meta.actor.kind === 'admin' || meta.actor.workspaceRole === 'admin');
                    const busy = savingField === `approval-${ap.id}`;
                    const last = i === rows.length - 1;
                    // Approvals v3: who is on this request (for the composer's audience chips).
                    const participants = {
                      requester: requester?.email ? { email: String(requester.email).toLowerCase(), name: requester.name || null, role: 'requester' } : null,
                      agent: ap.requestedBy ? { email: String(ap.requestedBy).toLowerCase(), name: people.find((p) => p.email === String(ap.requestedBy).toLowerCase())?.name || null, role: 'agent' } : null,
                      approvers: rows.map((r) => ({ email: String(r.approverEmail).toLowerCase(), name: r.approverName || people.find((p) => p.email === String(r.approverEmail).toLowerCase())?.name || null, role: 'approver' })),
                    };
                    const nextTier = tiers[ap.tier || 1] || null;
                    return (
                      <li key={ap.id} className="relative flex gap-3">
                        {/* rail: avatar + status dot + connector */}
                        <div className="relative flex flex-col items-center">
                          <div className="relative">
                            <ApproverAvatar email={approverKey} name={approverLabel} photoUrl={person?.photoUrl || null} />
                            <span className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-card ${sm.dot} flex items-center justify-center`} title={sm.label}>
                              <sm.Icon className="w-2 h-2 text-white" aria-hidden="true" />
                            </span>
                          </div>
                          {!last && <span className="flex-1 w-px bg-secondary mt-1" aria-hidden="true" />}
                        </div>

                        <div className="min-w-0 flex-1 pb-0.5">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-sm font-medium text-foreground truncate" title={ap.approverEmail}>{approverLabel}</span>
                            {tierCount > 1 && (
                              <span className="rounded border border-border bg-muted/70 px-1 py-px text-[10px] font-semibold text-muted-foreground" title={`Approval tier ${ap.tier || 1} of ${tierCount}`}>
                                {(tiers[(ap.tier || 1) - 1] || {}).name || `Tier ${ap.tier || 1}`}
                              </span>
                            )}
                            {ap.isFinal && <span className="rounded border border-border bg-muted/70 px-1 py-px text-[10px] font-semibold text-muted-foreground" title="Forwarded as the final approver">final</span>}
                            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold rounded-full px-1.5 py-0.5 border ${sm.chip}`}>
                              {rowLabel(ap)}
                            </span>
                            {ap.decidedAt && (
                              <span className="text-[11px] text-muted-foreground/75" title={new Date(ap.decidedAt).toLocaleString()}>{formatDayTime(ap.decidedAt)} · {timeAgo(ap.decidedAt)}</span>
                            )}
                          </div>
                          {ap.status === 'info_requested'
                            ? ap.decisionNote && <p className={`text-xs mt-0.5 ${sm.text}`}>Clarification needed: “{ap.decisionNote}”</p>
                            : (ap.status === 'escalated' || ap.status === 'forwarded')
                              ? (() => { const last = named([...(ap.escalationLog || [])].reverse()[0]); return last ? <p className={`text-xs mt-0.5 ${sm.text}`}>{handoffSentence({ ...last, byName: null, byEmail: null }).replace(/^An approver /, '').replace(/^\w/, (c) => c.toUpperCase())}</p> : ap.decisionNote && <p className="text-xs text-muted-foreground mt-0.5">{ap.decisionNote}</p>; })()
                              : ap.decisionNote && <p className="text-xs text-muted-foreground mt-0.5">{ap.decisionNote}</p>}
                          {/* How this row came to exist (escalated / forwarded / auto over-limit) — only on the receiving row. */}
                          {ap.status === 'pending' && Array.isArray(ap.escalationLog) && ap.escalationLog.length > 0 && (() => {
                            const last = ap.escalationLog[ap.escalationLog.length - 1];
                            return last && last.toEmails?.includes?.(String(ap.approverEmail).toLowerCase()) ? (
                              <p className="text-[11px] text-muted-foreground mt-0.5 border-l-2 border-amber-300 dark:border-amber-500/40 pl-2">{handoffSentence(named(last))}</p>
                            ) : null;
                          })()}

                          {/* Approver actions (pending / question sent): the same composer as the magic link. */}
                          {(ap.status === 'pending' || ap.status === 'info_requested') && isApprover && (
                            <div className="mt-2">
                              <ApprovalComposer
                                compact
                                showShortcuts={false}
                                minHeight={180}
                                approval={{
                                  ...ap,
                                  ticketRef: null,
                                  requesterName: requester?.name || null,
                                  canEscalate: Boolean(!ap.isFinal && nextTier && onEscalate),
                                  nextTier: nextTier ? { name: nextTier.name, approverNames: (nextTier.managerEmails || []).map((e) => people.find((p) => p.email === e)?.name || e) } : null,
                                  tierName: (tiers[(ap.tier || 1) - 1] || {}).name || null,
                                  amountLabel: null,
                                }}
                                participants={participants}
                                selfEmail={ap.approverEmail}
                                forwardCandidates={people.filter((p) => p.email !== String(ap.approverEmail).toLowerCase() && p.email !== String(ap.requestedBy || '').toLowerCase())}
                                onDecide={(decision, note, noteHtml, extra) => onDecide(ap.id, decision, note, { noteHtml, ...extra })}
                                onAsk={onAsk ? async (payload) => { await onAsk(ap.id, payload); await loadMessages(); } : undefined}
                                onHandoff={(onEscalate || onForward) ? async ({ mode, note, toEmail }) => {
                                  if (mode === 'forward') await onForward?.(ap.id, toEmail, note);
                                  else await onEscalate?.(ap.id, note);
                                } : undefined}
                                disabled={busy}
                                footer={ap.status === 'info_requested' ? 'A question is out — you can still decide, or wait for the answer below.' : 'Decisions ask you to confirm first.'}
                              />
                            </div>
                          )}

                          {/* Everyone else on a pending row: who holds it. Admins may hand it on (forward-only composer). */}
                          {ap.status === 'pending' && !isApprover && (
                            <div className="mt-2" data-testid="approval-waiting-on">
                              <p className="text-[11px] text-muted-foreground border-l-2 border-border pl-2">
                                Waiting on <span className="font-medium text-foreground/85">{approverLabel}</span> — only they can decide
                                {tierCount > 1 ? ` ${(tiers[(ap.tier || 1) - 1] || {}).name || `Tier ${ap.tier || 1}`}` : ''}.
                                {canForwardAsAdmin ? ' If they are away, hand it to someone else below.' : ''}
                              </p>
                              {canForwardAsAdmin && (
                                <div className="mt-2">
                                  <ApprovalComposer
                                    compact
                                    canDecide={false}
                                    showShortcuts={false}
                                    minHeight={120}
                                    approval={{ ...ap, ticketRef: null, requesterName: requester?.name || null, canEscalate: false, nextTier: null, tierName: (tiers[(ap.tier || 1) - 1] || {}).name || null, amountLabel: null }}
                                    participants={participants}
                                    selfEmail={ap.approverEmail}
                                    forwardCandidates={people.filter((p) => p.email !== approverKey && p.email !== String(ap.requestedBy || '').toLowerCase())}
                                    onDecide={() => {}}
                                    onHandoff={async ({ mode, note, toEmail }) => { if (mode === 'forward') await onForward(ap.id, toEmail, note); }}
                                    disabled={busy}
                                    footer={`Forwarding moves the request to the person you pick; ${approverLabel} is told.`}
                                  />
                                </div>
                              )}
                            </div>
                          )}

                          {/* Requester actions: type the requested info right here,
                              it travels with the resubmit (QA 07-14 #1). */}
                          {ap.status === 'info_requested' && isRequester && (
                            <div className="mt-2 space-y-1.5">
                              <textarea
                                rows={2}
                                value={resubmitNotes[ap.id] || ''}
                                onChange={(e) => setResubmitNotes((m) => ({ ...m, [ap.id]: e.target.value }))}
                                placeholder="Reply with the requested info — sent to the approver with the resubmit…"
                                className="tp-focus-ring w-full text-xs bg-card border border-violet-200 dark:border-violet-500/30 rounded-lg px-2.5 py-1.5 placeholder:text-muted-foreground/75 resize-y"
                              />
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <button
                                  onClick={() => onResubmit(ap.id, (resubmitNotes[ap.id] || '').trim() || null)}
                                  disabled={busy}
                                  className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-blue-700 disabled:opacity-50"
                                >
                                  <ChevronRight className="w-3 h-3" aria-hidden="true" /> Resubmit for approval
                                </button>
                                <span className="text-[11px] text-muted-foreground/75">Your reply is kept on the request and emailed to the approver.</span>
                              </div>
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>

                {/* Approvals v3: the conversation on this request — request note,
                    hand-offs, questions / answers (internal ones locked), with an
                    in-app Answer for whoever the question was addressed to. */}
                {(() => {
                  const groupId = head.requestGroupId || `single-${head.id}`;
                  const groupMessages = messages.filter((m) => m.requestGroupId === groupId || (m.approvalId && rows.some((r) => r.id === m.approvalId)));
                  const answered = new Set(groupMessages.filter((m) => m.kind === 'answer' && m.inReplyToId).map((m) => m.inReplyToId));
                  const awaiting = groupMessages.some((m) => m.kind === 'question' && m.audience === 'internal' && !answered.has(m.id));
                  const viewerIsApprover = rows.some((r) => String(r.approverEmail).toLowerCase() === actorEmail);
                  const threadApproval = { ...head, requestNote: null, requestNoteHtml: null, clarificationLog: rows.flatMap((r) => r.clarificationLog || []), escalationLog: rows.flatMap((r) => r.escalationLog || []) };
                  if (!groupMessages.length && !threadApproval.clarificationLog.length && !threadApproval.escalationLog.length && !awaiting) return null;
                  return (
                    <div className="mt-3 border-t border-border/60 pt-3">
                      <ApprovalThread
                        compact
                        approval={threadApproval}
                        messages={groupMessages}
                        people={people}
                        viewerEmail={actorEmail}
                        viewerRole={actorIsAdmin ? 'admin' : viewerIsApprover ? 'approver' : 'agent'}
                        awaitingApprover={awaiting}
                        onAnswer={onAnswer ? (m) => setAnswering(m) : null}
                        title="Conversation"
                      />
                      {answering && groupMessages.some((m) => m.id === answering.id) && (
                        <AnswerBox
                          message={answering}
                          busy={answerBusy}
                          onCancel={() => setAnswering(null)}
                          onSend={async (payload) => {
                            setAnswerBusy(true);
                            try { await onAnswer(answering.id, payload); setAnswering(null); await loadMessages(); }
                            finally { setAnswerBusy(false); }
                          }}
                        />
                      )}
                    </div>
                  );
                })()}

                {/* Group-level requester actions: cancel keeps an audit record;
                    delete removes it entirely (parent shows a warning first). */}
                {canRequesterManage && (
                  <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-border/60">
                    <button
                      onClick={() => onCancel(head.id)}
                      disabled={groupBusy}
                      className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-lg text-muted-foreground border border-border hover:bg-muted disabled:opacity-50"
                    >
                      <Ban className="w-3 h-3" aria-hidden="true" /> Cancel request
                    </button>
                    <button
                      onClick={() => onDeleteRequest?.(head)}
                      disabled={groupBusy}
                      className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-lg text-muted-foreground hover:bg-red-50 dark:hover:bg-red-500/15 hover:text-red-600 dark:hover:text-red-300"
                    >
                      <Trash2 className="w-3 h-3" aria-hidden="true" /> Delete
                    </button>
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
