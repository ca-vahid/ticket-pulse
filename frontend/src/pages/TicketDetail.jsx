import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity, AlertCircle, ArrowLeft, Bell, BellRing, Bot, Building2, Check, CheckCircle2,
  ChevronDown, ChevronLeft, ChevronRight, Copy, CopyPlus, Download, ExternalLink, Eye, FileText, Flame, Forward, Hand,
  History, Image as ImageIcon, Link2, Loader2, Lock, Mail, MapPin, MessageCircleQuestion, MessageSquare, Paperclip, Pencil, Phone, Plus,
  RefreshCw, Send, ShieldCheck, Smartphone, Smile, Sparkles, Stamp, StickyNote, Trash2, UserRound, VolumeX, X, XCircle,
} from 'lucide-react';
import AttachmentPreviewModal from '../components/tickets/AttachmentPreviewModal';
import TicketTagEditor from '../components/tickets/TicketTagEditor';
import ApprovalTimeline from '../components/tickets/ApprovalTimeline';
import ProposedReplyCard from '../components/tickets/ProposedReplyCard';
import { CustomFieldsCard, MacroMenu, TicketLinksCard } from '../components/tickets/TicketOpsCards';
import ThreadSummaryCard from '../components/tickets/ThreadSummaryCard';
import RequestApprovalModal from '../components/tickets/RequestApprovalModal';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import AiAssignModal from '../components/tickets/AiAssignModal';
import AssigneePicker from '../components/tickets/AssigneePicker';
import CcChips from '../components/tickets/CcChips';
import FsSyncConfirm from '../components/tickets/FsSyncConfirm';
import RichTextEditor, { isRichContent } from '../components/tickets/RichTextEditor';
import StagedFileChip from '../components/tickets/StagedFileChip';
import ImageMarkupModal from '../components/tickets/ImageMarkupModal';
import TicketAiTab from '../components/tickets/TicketAiTab';
import {
  MirrorChip, OriginChip, PersonAvatar, PriorityDot, ProvenanceChip, SafeHtml, SlaChip, StateChip, StatusPill,
  TypePill, PRIORITY_LABELS, formatBytes, isConversationEntry, pipelineRunLabel,
  pipelineTriggerLabel, ticketCategoryLabels, timeAgo,
} from '../components/tickets/ticketUi';
import { FRESHSERVICE_DOMAIN } from '../components/tech-detail/constants';
import { useWorkspaceRole } from '../components/nav/navDestinations';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { assignmentAPI, ticketsAPI } from '../services/api';
import { useSSE } from '../hooks/useSSE';
import { useTicketPresence } from '../hooks/useTicketPresence';

const STATUSES = ['Open', 'Pending', 'Resolved', 'Closed'];
const TICKET_TYPES = ['Incident', 'Service Request'];
const CONVERSATION_TABS = [
  { key: 'all', label: 'All' },
  { key: 'replies', label: 'Replies' },
  { key: 'notes', label: 'Notes' },
];
// Fields watched for changes made by OTHER users while this page is open.
const LIVE_FIELDS = {
  status: 'Status',
  priority: 'Priority',
  assignedTechId: 'Assignee',
  ticketType: 'Type',
  internalCategoryId: 'Category',
  internalSubcategoryId: 'Subcategory',
  groupId: 'Group',
  subject: 'Subject',
};
// History timeline: icon + tone per activity type.
const HISTORY_STYLES = {
  created: { icon: Plus, tone: 'bg-blue-100 text-blue-600' },
  assigned: { icon: UserRound, tone: 'bg-blue-100 text-blue-600' },
  reassigned: { icon: UserRound, tone: 'bg-sky-100 text-sky-600' },
  coordinator_assigned: { icon: UserRound, tone: 'bg-blue-100 text-blue-600' },
  self_picked: { icon: Hand, tone: 'bg-emerald-100 text-emerald-600' },
  picked: { icon: Hand, tone: 'bg-emerald-100 text-emerald-600' },
  status_changed: { icon: RefreshCw, tone: 'bg-amber-100 text-amber-600' },
  resolved: { icon: Check, tone: 'bg-emerald-100 text-emerald-600' },
  requester_reply: { icon: Mail, tone: 'bg-sky-100 text-sky-600' },
  forwarded: { icon: Forward, tone: 'bg-violet-100 text-violet-600' },
  noise_flagged: { icon: VolumeX, tone: 'bg-violet-100 text-violet-600' },
  noise_cleared: { icon: VolumeX, tone: 'bg-slate-100 text-slate-500' },
  ai_triage: { icon: Sparkles, tone: 'bg-indigo-100 text-indigo-600' },
  fields_updated: { icon: Pencil, tone: 'bg-slate-100 text-slate-500' },
  rejected: { icon: X, tone: 'bg-red-100 text-red-600' },
  group_changed: { icon: Building2, tone: 'bg-sky-100 text-sky-600' },
  default: { icon: History, tone: 'bg-slate-100 text-slate-500' },
};

function looksLikeHtml(s) {
  return /<[a-z][\s\S]*>/i.test(String(s || ''));
}

function Body({ html, text, className = '' }) {
  if (html && looksLikeHtml(html)) return <SafeHtml html={html} className={className} />;
  const value = text || html || '';
  return <p className={`text-sm text-slate-700 whitespace-pre-wrap break-words ${className}`}>{value}</p>;
}

const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const IMG_REF_RE = /\[Image:\s*([^\]]+?)\]/g;
// Bodies may use non-breaking-space entities inside the ref (e.g. from a paste),
// so normalize those to real spaces before trimming the file name.
const cleanRefName = (s) => String(s || '').replace(new RegExp('&nbsp;|&#160;|&#xa0;|\\u00a0', 'gi'), ' ').trim();

/**
 * Renders a thread body and turns inline "[Image: name]" references into
 * clickable chips (click → onImageRef(name) opens a preview). Uses SafeHtml so
 * rich formatting is preserved; delegates the click via the wrapping div.
 */
function RichBody({ html, text, onImageRef, className = '' }) {
  const injectRefs = (s) => String(s).replace(IMG_REF_RE, (_m, name) => {
    const clean = escapeHtml(cleanRefName(name));
    return `<span class="tp-img-ref" data-img="${clean}" role="button" tabindex="0">🖼 ${clean}</span>`;
  });
  const source = (html && looksLikeHtml(html))
    ? injectRefs(html)
    : injectRefs(escapeHtml(text || html || '').replace(/\n/g, '<br>'));
  const handleClick = (e) => {
    const el = e.target.closest?.('.tp-img-ref');
    if (el) { e.preventDefault(); onImageRef?.(el.getAttribute('data-img')); }
  };
  const handleKey = (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('tp-img-ref')) {
      e.preventDefault(); onImageRef?.(e.target.getAttribute('data-img'));
    }
  };
  return (
    <div onClick={handleClick} onKeyDown={handleKey} role="presentation">
      <SafeHtml html={source} className={className} />
    </div>
  );
}

/**
 * Approval-lifecycle thread entries (written by the approval service as system
 * notes) get their own compact, color-coded event style so approved / rejected /
 * needs-info reads at a glance — distinct from ordinary internal notes.
 */
function approvalEventMeta(entry) {
  if (entry?.authorType !== 'system') return null;
  const t = String(entry.bodyText || entry.content || '');
  if (/^Approval (CHANGED to )?APPROVED/i.test(t)) return { label: /CHANGED/i.test(t) ? 'Approved (changed)' : 'Approved', Icon: CheckCircle2, wrap: 'bg-emerald-50 border-emerald-200', accent: 'bg-emerald-500', text: 'text-emerald-800', chip: 'bg-emerald-100 text-emerald-700 border-emerald-200' };
  if (/^Approval (CHANGED to )?REJECTED/i.test(t)) return { label: /CHANGED/i.test(t) ? 'Rejected (changed)' : 'Rejected', Icon: XCircle, wrap: 'bg-red-50 border-red-200', accent: 'bg-red-500', text: 'text-red-800', chip: 'bg-red-100 text-red-700 border-red-200' };
  if (/^Clarification requested/i.test(t)) return { label: 'Clarification requested', Icon: MessageCircleQuestion, wrap: 'bg-violet-50 border-violet-200', accent: 'bg-violet-500', text: 'text-violet-800', chip: 'bg-violet-100 text-violet-700 border-violet-200' };
  return null;
}

// QA 07-06 #8: descriptions render fully by default — only genuinely long ones
// (taller than ~2 screens of content) collapse to a generous preview. Measured
// on the rendered height, not character count, so image-heavy or formatted
// emails aren't clipped mid-read.
const BODY_CLAMP_AT_PX = 1200; // collapse only when taller than this
const BODY_PREVIEW_PX = 800; // collapsed preview height

function CollapsibleBody({ html, text }) {
  const bodyRef = useRef(null);
  const userToggled = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const [isLong, setIsLong] = useState(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    const measure = () => {
      if (el.scrollHeight > BODY_CLAMP_AT_PX) {
        setIsLong(true);
        if (!userToggled.current) setCollapsed(true);
      }
    };
    measure();
    // Late image loads can push a "short" description past the threshold.
    el.addEventListener('load', measure, true);
    return () => el.removeEventListener('load', measure, true);
  }, [html, text]);

  return (
    <div>
      <div
        ref={bodyRef}
        className={collapsed ? 'overflow-hidden relative' : ''}
        style={collapsed ? { maxHeight: `${BODY_PREVIEW_PX}px` } : undefined}
      >
        <Body html={html} text={text} />
        {collapsed && <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white to-transparent" aria-hidden="true" />}
      </div>
      {isLong && (
        <button
          onClick={() => { userToggled.current = true; setCollapsed((v) => !v); }}
          className="tp-focus-ring mt-1.5 text-xs font-semibold text-blue-600 hover:underline rounded"
        >
          {collapsed ? 'Show more' : 'Show less'}
        </button>
      )}
    </div>
  );
}

const isImageAttachment = (a) =>
  /^image\//i.test(a?.contentType || a?.mimeType || '') ||
  /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i.test(a?.fileName || '');

/**
 * QA 07-06 #9: images attached to the DESCRIPTION (ticket-level, not a reply)
 * surface as a thumbnail strip right under the description text instead of
 * hiding only in the attachments rail. Click → the existing preview lightbox.
 * The rail stays the canonical list of everything attached.
 */
function DescriptionImageStrip({ ticketId, images, onPreview }) {
  const [urls, setUrls] = useState({}); // attachmentId → object URL
  useEffect(() => {
    if (!images.length) return undefined;
    let alive = true;
    const made = [];
    images.forEach((a) => {
      ticketsAPI.attachmentObjectUrl(ticketId, a.id)
        .then((res) => {
          if (!alive) { URL.revokeObjectURL(res.url); return; }
          made.push(res.url);
          setUrls((u) => ({ ...u, [a.id]: res.url }));
        })
        .catch(() => {});
    });
    return () => { alive = false; setTimeout(() => made.forEach((u) => URL.revokeObjectURL(u)), 300); };
  }, [ticketId, images]);

  if (!images.length) return null;
  return (
    <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap gap-2" aria-label="Images attached to the description">
      {images.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onPreview(a)}
          className="tp-focus-ring group relative rounded-lg overflow-hidden border border-slate-200 bg-slate-50 hover:border-blue-300 transition-colors"
          title={`Preview ${a.fileName}`}
        >
          {urls[a.id]
            ? <img src={urls[a.id]} alt={a.fileName} loading="lazy" className="h-24 w-auto max-w-[220px] object-cover" />
            : (
              <span className="flex items-center justify-center h-24 w-32">
                <ImageIcon className="w-5 h-5 text-slate-300" aria-hidden="true" />
              </span>
            )}
          <span className="absolute inset-x-0 bottom-0 bg-slate-900/55 text-white text-[10px] px-1.5 py-0.5 truncate opacity-0 group-hover:opacity-100 transition-opacity">
            {a.fileName}
          </span>
        </button>
      ))}
    </div>
  );
}

function AttachmentChip({ attachment, onDownload, onPreview }) {
  const isImage = isImageAttachment(attachment);
  const clickable = isImage ? onPreview : onDownload;
  return (
    <button
      onClick={clickable}
      className="tp-focus-ring inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border border-slate-200 bg-white text-xs text-slate-600 hover:border-blue-300 hover:text-blue-700"
      title={isImage ? `Preview ${attachment.fileName} (${formatBytes(attachment.sizeBytes)})` : `Download ${attachment.fileName} (${formatBytes(attachment.sizeBytes)})`}
    >
      {isImage
        ? <ImageIcon className="w-3 h-3 text-slate-400" aria-hidden="true" />
        : <Paperclip className="w-3 h-3 text-slate-400" aria-hidden="true" />}
      <span className="truncate max-w-[180px]">{attachment.fileName}</span>
      <span className="text-slate-400">{formatBytes(attachment.sizeBytes)}</span>
    </button>
  );
}

/**
 * Chat-style message: requester messages sit LEFT with an indigo tint, agent
 * replies sit RIGHT with a blue tint (avatars + role + channel on both sides),
 * internal notes stay full-width amber so they can't be mistaken for either.
 */
function ThreadEntry({ entry, attachments = [], onDownload, onPreview, onImageRef, photoFor, onCopy, canDelete = false, onDelete, deleting = false }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isNote = entry.eventType === 'note' || entry.isPrivate === true;
  const body = entry.bodyText || entry.content || '';
  // Identity beats channel: an agent replying by email syncs from FS as
  // "incoming", but the server resolves the author against the roster and
  // stamps authorType 'agent' — those render agent-side, not as requester.
  const isAgentAuthor = entry.authorType === 'agent';
  const incoming = !isAgentAuthor && (entry.incoming === true || entry.authorType === 'requester');
  const outgoing = !isNote && !incoming;
  const viaEmail = entry.source === 'email_inbound' || Boolean(entry.emailMessageId)
    || (entry.incoming === true && isAgentAuthor);
  const apEvent = approvalEventMeta(entry);

  // Approval-lifecycle events read as their own compact, color-coded card so
  // approved / rejected / needs-info is obvious at a glance vs. ordinary notes.
  if (apEvent) {
    const { label, Icon, wrap, accent, text, chip } = apEvent;
    return (
      <li className="flex justify-center">
        <div className={`relative w-full max-w-[92%] overflow-hidden rounded-2xl border ${wrap} pl-4 pr-3.5 py-3 shadow-subtle`}>
          <span className={`absolute inset-y-0 left-0 w-1.5 ${accent}`} aria-hidden="true" />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Stamp className={`w-3.5 h-3.5 ${text}`} aria-hidden="true" />
            <span className={`text-[11px] font-bold uppercase tracking-wide ${text}`}>Approval</span>
            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold rounded-full px-1.5 py-0.5 border ${chip}`}>
              <Icon className="w-2.5 h-2.5" aria-hidden="true" /> {label}
            </span>
            <span className="ml-auto text-xs text-slate-400 whitespace-nowrap" title={new Date(entry.occurredAt).toLocaleString()}>
              {timeAgo(entry.occurredAt)}
            </span>
          </div>
          <p className={`mt-1 text-sm font-medium ${text} break-words`}>{body}</p>
        </div>
      </li>
    );
  }

  // TP-authored notes (assignment/system) get the brand mark, not "TP" initials.
  const isTicketPulse = entry.actorName === 'Ticket Pulse';
  const avatar = (
    <div className="flex-shrink-0 flex flex-col items-center gap-1 pt-0.5 w-12">
      {isTicketPulse ? (
        <span className="h-10 w-10 rounded-full bg-gradient-to-br from-blue-50 to-indigo-100 border border-blue-200 flex items-center justify-center shadow-subtle overflow-hidden" title="Ticket Pulse">
          <img src="/brand/logo-mark.png" alt="Ticket Pulse" className="h-full w-full object-contain p-0.5" />
        </span>
      ) : (
        <PersonAvatar name={entry.actorName} photoUrl={photoFor?.(entry)} size="h-10 w-10" textSize="text-xs" />
      )}
      <span className={`text-[9px] font-bold uppercase tracking-wide ${
        isTicketPulse ? 'text-blue-400' : isNote ? 'text-amber-500' : incoming ? 'text-indigo-400' : 'text-blue-400'
      }`}
      >
        {isTicketPulse ? 'Auto' : isNote ? 'Note' : incoming ? 'Requester' : 'Agent'}
      </span>
    </div>
  );

  return (
    <li className={`flex gap-2.5 group ${outgoing ? 'flex-row-reverse' : ''}`}>
      {avatar}
      <div
        className={`min-w-0 rounded-2xl border p-4 shadow-subtle ${
          isNote
            ? 'flex-1 bg-amber-50/80 border-amber-200 rounded-tl-md'
            : incoming
              ? 'max-w-[92%] flex-1 bg-white border-indigo-200/70 rounded-tl-md'
              : 'max-w-[92%] flex-1 bg-blue-50/60 border-blue-200/70 rounded-tr-md'
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-2.5 mb-3 border-b border-slate-900/5">
          <span className="text-sm font-bold text-slate-800">{entry.actorName || 'Unknown'}</span>
          {isNote ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-1.5 py-0.5">
              <Lock className="w-2.5 h-2.5" aria-hidden="true" /> Internal note
            </span>
          ) : entry.eventType === 'forward' ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-violet-700 bg-violet-50 border border-violet-200 rounded-full px-1.5 py-0.5">
              <Forward className="w-2.5 h-2.5" aria-hidden="true" /> Forwarded
            </span>
          ) : (
            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold rounded-full px-1.5 py-0.5 border ${
              incoming ? 'text-indigo-700 bg-indigo-50 border-indigo-200' : 'text-blue-700 bg-blue-50 border-blue-200'
            }`}
            >
              <Mail className="w-2.5 h-2.5" aria-hidden="true" /> {incoming ? 'From requester' : 'Reply to requester'}
            </span>
          )}
          {viaEmail && <span className="text-[10px] text-slate-400">via email</span>}
          <span className="ml-auto flex items-center gap-1">
            {canDelete && isNote && entry.authorType !== 'system' && (
              confirmDelete ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-700">
                  Delete?
                  <button
                    onClick={() => { setConfirmDelete(false); onDelete?.(entry.id); }}
                    disabled={deleting}
                    className="tp-focus-ring px-1.5 py-0.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-60"
                  >
                    {deleting ? 'Deleting…' : 'Yes'}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="tp-focus-ring px-1.5 py-0.5 rounded text-slate-500 hover:bg-slate-100"
                  >
                    No
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  aria-label="Delete note"
                  title="Delete note (admin)"
                  className="tp-focus-ring p-1 rounded text-slate-300 hover:text-red-600 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                >
                  <Trash2 className="w-3 h-3" aria-hidden="true" />
                </button>
              )
            )}
            <button
              onClick={() => onCopy?.(body)}
              aria-label="Copy message text"
              title="Copy message text"
              className="tp-focus-ring p-1 rounded text-slate-300 hover:text-slate-600 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
            >
              <Copy className="w-3 h-3" aria-hidden="true" />
            </button>
            <span className="text-xs text-slate-400 whitespace-nowrap" title={new Date(entry.occurredAt).toLocaleString()}>
              {new Date(entry.occurredAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              {' · '}{timeAgo(entry.occurredAt)}
            </span>
          </span>
        </div>
        <RichBody html={entry.bodyHtml} text={body} onImageRef={onImageRef} />
        {attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <AttachmentChip
                key={a.id}
                attachment={a}
                onDownload={() => onDownload?.(a)}
                onPreview={() => onPreview?.(a)}
              />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Sidebar property row. `flash` marks a change someone ELSE just made — an
 * amber pulse that sticks until the user hovers/focuses it (acknowledgment).
 */
function SidebarField({ label, children, flash = false, onAck }) {
  return (
    <div
      onMouseEnter={flash ? onAck : undefined}
      onFocusCapture={flash ? onAck : undefined}
      className={`rounded-lg transition-all duration-500 ${flash ? 'ring-2 ring-amber-300 bg-amber-50/80 p-1.5 -m-1.5' : ''}`}
    >
      <span className="flex items-center text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
        {label}
        {flash && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-bold text-amber-600 normal-case tracking-normal animate-pulse">
            <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            updated
          </span>
        )}
      </span>
      {children}
    </div>
  );
}

/** One event on the History tab's vertical timeline. */
function HistoryEvent({ icon: Icon, tone, title, meta, at, isLast }) {
  return (
    <li className="relative flex gap-3 pb-5">
      {!isLast && <span aria-hidden="true" className="absolute left-[15px] top-8 bottom-0 w-px bg-slate-200" />}
      <span className={`relative z-10 flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${tone}`}>
        <Icon className="w-3.5 h-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-sm text-slate-700">{title}</p>
        {meta && <p className="text-xs text-slate-400 mt-0.5">{meta}</p>}
      </div>
      <span
        className="text-xs text-slate-400 whitespace-nowrap pt-1"
        title={new Date(at).toLocaleString()}
      >
        {timeAgo(at)}
      </span>
    </li>
  );
}

export default function TicketDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const ticketId = Number(id);
  // This ticket belongs to the workspace it was opened in. If the user switches
  // workspace while viewing it, the ticket won't exist in the new one — bounce
  // to that workspace's queue instead of showing a "not found" error.
  const { workspaceId } = useWorkspace();
  const openedWsRef = useRef(null);
  useEffect(() => {
    if (!workspaceId) return;
    // Capture the first known workspace (context hydrates async), then bounce to
    // the queue if the user switches to a different workspace while viewing this
    // ticket — it won't exist there.
    if (openedWsRef.current === null) { openedWsRef.current = workspaceId; return; }
    if (workspaceId !== openedWsRef.current) navigate('/tickets', { replace: true });
  }, [workspaceId, navigate]);
  const [searchParams, setSearchParams] = useSearchParams();
  const pageTab = ['approvals', 'history', 'ai'].includes(searchParams.get('tab')) ? searchParams.get('tab') : 'conversation';
  const setPageTab = (tab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tab === 'conversation') next.delete('tab'); else next.set('tab', tab);
      return next;
    }, { replace: true });
  };

  const [ticket, setTicket] = useState(null);
  const [meta, setMeta] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [toast, setToast] = useState(null);
  const [savingField, setSavingField] = useState(null);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiDeciding, setAiDeciding] = useState(false);
  // AI assignment/review is reviewer/admin only (endpoints are reviewer-gated).
  const wsRole = useWorkspaceRole();
  const canReview = wsRole === 'admin' || wsRole === 'reviewer';

  // ---- Live collaboration: flag fields changed by other users ----
  const [liveChanges, setLiveChanges] = useState({});
  const ticketRef = useRef(null);
  const lastLocalMutationRef = useRef(0);
  const ackChange = useCallback((field) => {
    setLiveChanges((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);
  // Stale-highlight backstop: a flash nobody acknowledges fades after 45s.
  useEffect(() => {
    const keys = Object.keys(liveChanges);
    if (keys.length === 0) return undefined;
    const timer = setTimeout(() => {
      const cutoff = Date.now() - 45000;
      setLiveChanges((prev) => Object.fromEntries(Object.entries(prev).filter(([, at]) => at > cutoff)));
    }, 5000);
    return () => clearTimeout(timer);
  }, [liveChanges]);

  // ---- Requester photo from Entra (lazy, server-cached) ----
  const [requesterPhoto, setRequesterPhoto] = useState(null);
  const requesterEmail = ticket?.requester?.email || null;
  useEffect(() => {
    let cancelled = false;
    setRequesterPhoto(null);
    if (!requesterEmail) return undefined;
    ticketsAPI.requesterPhoto(requesterEmail)
      .then((res) => { if (!cancelled) setRequesterPhoto(res.data?.photo || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [requesterEmail]);

  const [composerMode, setComposerMode] = useState('note'); // default to internal note
  const [composerBody, setComposerBody] = useState(''); // sanitized html from the editor
  const [composerText, setComposerText] = useState(''); // plain-text mirror for guards/sending
  const [composerCc, setComposerCc] = useState([]);
  const [composerFiles, setComposerFiles] = useState([]);
  const [editFile, setEditFile] = useState(null);
  const [cloneConfirm, setCloneConfirm] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [requestApprovalOpen, setRequestApprovalOpen] = useState(false);
  const [deleteApprovalTarget, setDeleteApprovalTarget] = useState(null); // approval group pending delete-confirm
  const [changeApprovalTarget, setChangeApprovalTarget] = useState(null); // {approvalId, from, to, categoryName, approverName}
  const [changeNote, setChangeNote] = useState('');
  const [clarifyingId, setClarifyingId] = useState(null); // approvalId being clarified
  const [clarifyNote, setClarifyNote] = useState('');
  const [conversationTab, setConversationTab] = useState('all');
  const [confirmPickup, setConfirmPickup] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingSubject, setEditingSubject] = useState(false);
  const [subjectDraft, setSubjectDraft] = useState('');
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const composerRef = useRef(null);
  const composerFileInputRef = useRef(null);
  const pasteCountRef = useRef(0);

  const showToast = useCallback((tone, message, { undo = null, duration = 3500 } = {}) => {
    setToast({ tone, message, undo });
    setTimeout(() => setToast(null), undo ? Math.max(duration, 5000) : duration);
  }, []);

  // ---- Draft guard: per-ticket stash so navigating away never loses a reply ----
  const draftKey = `tp_ticket_draft_${ticketId}`;
  const draftLoadedRef = useRef(false);
  const htmlToText = (html) => {
    const div = document.createElement('div');
    div.innerHTML = String(html || '');
    return div.innerText || div.textContent || '';
  };
  useEffect(() => {
    draftLoadedRef.current = false;
    setComposerBody('');
    setComposerText('');
    setComposerCc([]);
    setComposerFiles([]);
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft.body) {
          setComposerBody(draft.body);
          setComposerText(htmlToText(draft.body));
        }
        if (Array.isArray(draft.cc) && draft.cc.length) setComposerCc(draft.cc);
        if (draft.mode === 'note' || draft.mode === 'reply') setComposerMode(draft.mode);
      }
    } catch { /* corrupt stash — start clean */ }
    draftLoadedRef.current = true;
  }, [draftKey]);

  useEffect(() => {
    if (!draftLoadedRef.current) return undefined;
    const timer = setTimeout(() => {
      try {
        if (composerText.trim() || composerCc.length) {
          localStorage.setItem(draftKey, JSON.stringify({ body: composerBody, cc: composerCc, mode: composerMode, savedAt: Date.now() }));
        } else {
          localStorage.removeItem(draftKey);
        }
      } catch { /* storage full/unavailable */ }
    }, 400);
    return () => clearTimeout(timer);
  }, [composerBody, composerText, composerCc, composerMode, draftKey]);

  // Tab-close guard while a draft is in flight (SPA navigation is already safe:
  // the stash restores the draft when the user comes back to this ticket).
  useEffect(() => {
    if (!composerText.trim()) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [composerText]);

  const switchComposerMode = (mode) => {
    setComposerMode(mode);
    setTimeout(() => composerRef.current?.focus(), 0);
  };

  const addComposerFiles = (fileList) => {
    const incoming = [...fileList];
    setComposerFiles((prev) => {
      const merged = [...prev];
      for (const file of incoming) {
        if (!merged.some((f) => f.name === file.name && f.size === file.size)) merged.push(file);
      }
      return merged.slice(0, 5);
    });
  };

  const fetchTicket = useCallback(async ({ silent = false, diff = false } = {}) => {
    if (!silent) setIsLoading(true);
    try {
      // Only the initial explicit open runs the live FreshService reconcile;
      // silent live-update / post-action refetches skip it (reconcile:false) so
      // a burst of SSE events can't pile up 30s-timeout FS calls.
      const res = await ticketsAPI.get(ticketId, { reconcile: !silent });
      // SSE-triggered refetch: mark fields another user changed (own edits are
      // exempt — they refetch within the local-mutation grace window).
      if (diff && ticketRef.current && Date.now() - lastLocalMutationRef.current > 2500) {
        const prev = ticketRef.current;
        const next = res.data;
        const changed = {};
        for (const field of Object.keys(LIVE_FIELDS)) {
          if (String(prev[field] ?? '') !== String(next[field] ?? '')) changed[field] = Date.now();
        }
        if (Object.keys(changed).length > 0) setLiveChanges((existing) => ({ ...existing, ...changed }));
      }
      ticketRef.current = res.data;
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

  // Browser tab shows the ticket ref
  useEffect(() => {
    if (ticket?.displayRef) {
      const prev = document.title;
      document.title = `${ticket.displayRef} · ${ticket.subject || 'Ticket'} — Ticket Pulse`;
      return () => { document.title = prev; };
    }
    return undefined;
  }, [ticket?.displayRef, ticket?.subject]);

  // Live updates, coalesced: a burst of SSE ticket-change events for this
  // ticket collapses into a single refetch after a short quiet period, instead
  // of one refetch per event. Keeps the page live without a refetch storm.
  const liveRefetchTimerRef = useRef(null);
  const onTicketChange = useCallback((data) => {
    if (data?.ticketId !== ticketId) return;
    if (liveRefetchTimerRef.current) clearTimeout(liveRefetchTimerRef.current);
    liveRefetchTimerRef.current = setTimeout(() => {
      liveRefetchTimerRef.current = null;
      fetchTicket({ silent: true, diff: true });
    }, 600);
  }, [ticketId, fetchTicket]);
  // "Also viewing" (gap plan 2 P4.1): heartbeat while open, live avatar list
  // over the same SSE connection.
  const { viewers: alsoViewing, onPresence } = useTicketPresence(ticketId, Number.isFinite(ticketId));
  useSSE({ onTicketChange, onPresence, enabled: Number.isFinite(ticketId) });
  useEffect(() => () => { if (liveRefetchTimerRef.current) clearTimeout(liveRefetchTimerRef.current); }, []);

  const isNative = ticket?.origin === 'ticketpulse';
  const ticketingOn = meta?.nativeTicketingEnabled !== false;
  const canWrite = isNative && ticketingOn;
  const canConverse = ticketingOn && (isNative || Boolean(ticket?.freshserviceTicketId));
  // FS-born tickets take confirmed write-backs for assignee/status/priority/category.
  const fsEditable = !isNative && Boolean(ticket?.freshserviceTicketId);
  const fsUrl = ticket?.freshserviceTicketId
    ? `https://${FRESHSERVICE_DOMAIN}/a/tickets/${ticket.freshserviceTicketId}`
    : null;

  // At-a-glance approval state for the header (open > approved > rejected).
  const approvalSummary = useMemo(() => {
    const list = ticket?.approvals || [];
    if (!list.length) return null;
    const open = list.filter((a) => a.status === 'pending' || a.status === 'info_requested');
    if (open.length) return { label: open.length > 1 ? `Awaiting approval (${open.length})` : 'Awaiting approval', cls: 'bg-amber-50 text-amber-700 border-amber-200' };
    if (list.some((a) => a.status === 'approved')) return { label: 'Approved', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    if (list.some((a) => a.status === 'rejected')) return { label: 'Rejected', cls: 'bg-red-50 text-red-700 border-red-200' };
    return null;
  }, [ticket?.approvals]);

  // ---- FS write-back confirmation flow (write-verify-then-mirror) ----
  const [fsConfirm, setFsConfirm] = useState(null); // { changes, payload, resolve?, reject? }
  const [fsBusy, setFsBusy] = useState(false);
  const [fsError, setFsError] = useState(null);
  const requestFsSync = useCallback((changes, payload) => new Promise((resolve, reject) => {
    setFsError(null);
    setFsConfirm({ changes, payload, resolve, reject });
  }), []);
  const runFsSync = async () => {
    if (!fsConfirm) return;
    setFsBusy(true);
    setFsError(null);
    try {
      await ticketsAPI.fsUpdate(ticketId, fsConfirm.payload);
      lastLocalMutationRef.current = Date.now();
      await fetchTicket({ silent: true });
      showToast('sky', 'Written to FreshService & verified ✓');
      fsConfirm.resolve?.();
      setFsConfirm(null);
    } catch (err) {
      // FS refused (or didn't accept the value) — nothing changed locally.
      setFsError(err.response?.data?.message || err.message || 'FreshService rejected the change');
      // A timeout can fire while the write actually lands (QA 231648) —
      // refetch so the page shows the TRUE state alongside the error.
      fetchTicket({ silent: true });
    } finally {
      setFsBusy(false);
    }
  };
  const cancelFsSync = () => {
    fsConfirm?.reject?.(new Error('cancelled'));
    setFsConfirm(null);
    setFsError(null);
  };
  const fsAssign = useCallback((techId) => {
    const tech = techId ? (meta?.technicians || []).find((t) => t.id === techId) : null;
    return requestFsSync(
      [{ field: 'Assignee', from: ticket?.assignedTech?.name || 'Unassigned', to: tech?.name || 'Unassigned' }],
      { assignedTechId: techId },
    );
  }, [requestFsSync, meta?.technicians, ticket?.assignedTech?.name]);

  // FS tickets often carry TP taxonomy only as names (tp_skill) — resolve them
  // against the canonical tree so the editable selects show the true value.
  const effectiveCategoryId = useMemo(() => {
    if (ticket?.internalCategoryId) return ticket.internalCategoryId;
    if (!ticket?.tpSkill) return '';
    return (meta?.categoryTree || []).find((c) => c.name === ticket.tpSkill)?.id || '';
  }, [ticket?.internalCategoryId, ticket?.tpSkill, meta?.categoryTree]);
  const effectiveSubcategoryId = useMemo(() => {
    if (ticket?.internalSubcategoryId) return ticket.internalSubcategoryId;
    if (!ticket?.tpSubskill || !effectiveCategoryId) return '';
    const top = (meta?.categoryTree || []).find((c) => c.id === effectiveCategoryId);
    return top?.subcategories.find((s) => s.name === ticket.tpSubskill)?.id || '';
  }, [ticket?.internalSubcategoryId, ticket?.tpSubskill, effectiveCategoryId, meta?.categoryTree]);

  // Prev/next within the queue ordering the user came from
  const navIds = useMemo(() => {
    try { return JSON.parse(sessionStorage.getItem('tp_ticket_nav') || '[]'); } catch { return []; }
  }, []);
  const navIndex = navIds.indexOf(ticketId);
  const prevId = navIndex > 0 ? navIds[navIndex - 1] : null;
  const nextId = navIndex >= 0 && navIndex < navIds.length - 1 ? navIds[navIndex + 1] : null;

  const conversationEntries = useMemo(() => {
    const entries = [...(ticket?.thread || [])];
    entries.sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
    return entries;
  }, [ticket?.thread]);

  // Conversation stream: real MESSAGES only — the FS activity feed (workflow
  // executions, field sets) is excluded here and surfaces on History instead.
  const timeline = useMemo(() => {
    const conv = conversationEntries
      .filter(isConversationEntry)
      .map((e) => ({ kind: 'entry', at: new Date(e.occurredAt).getTime(), e }));
    if (conversationTab === 'replies') return conv.filter((i) => !i.e.isPrivate);
    if (conversationTab === 'notes') return conv.filter((i) => i.e.isPrivate === true);
    return conv;
  }, [conversationEntries, conversationTab]);

  // Long threads: keep the original request + the newest messages in view;
  // everything between folds behind a divider until asked for.
  const [showFolded, setShowFolded] = useState(false);
  useEffect(() => { setShowFolded(false); }, [ticketId, conversationTab]);
  const FOLD_THRESHOLD = 8;
  const KEEP_TAIL = 5;
  const folded = !showFolded && timeline.length > FOLD_THRESHOLD;
  const visibleTimeline = folded
    ? [timeline[0], ...timeline.slice(timeline.length - KEEP_TAIL)]
    : timeline;
  const foldedCount = timeline.length - 1 - KEEP_TAIL;

  // History tab: audit activities + assignment episodes + AI triage, newest first
  const techNameById = useMemo(() => {
    const map = new Map();
    for (const t of meta?.technicians || []) map.set(t.id, t.name);
    return map;
  }, [meta?.technicians]);

  const historyItems = useMemo(() => {
    const items = [];
    const humanize = (s) => String(s || '').replace(/_/g, ' ');
    for (const a of ticket?.activities || []) {
      const style = HISTORY_STYLES[a.activityType] || HISTORY_STYLES.default;
      const d = a.details || {};
      const bits = [];
      if (d.oldStatus && d.newStatus) bits.push(`${d.oldStatus} → ${d.newStatus}`);
      if (d.fromTechId || d.toTechId) {
        bits.push(`${d.fromTechId ? techNameById.get(d.fromTechId) || `tech ${d.fromTechId}` : 'Unassigned'} → ${d.toTechId ? techNameById.get(d.toTechId) || `tech ${d.toTechId}` : 'Unassigned'}`);
      }
      if (Array.isArray(d.to)) bits.push(`to ${d.to.join(', ')}`);
      if (d.note) bits.push(d.note);
      items.push({
        key: `a-${a.id}`,
        at: new Date(a.performedAt).getTime(),
        ...style,
        title: (
          <>
            <span className="capitalize font-medium">{humanize(a.activityType)}</span>
            {a.performedBy ? <span className="text-slate-500"> · {a.performedBy}</span> : null}
          </>
        ),
        meta: bits.join(' · ') || null,
      });
    }
    for (const ep of ticket?.assignmentEpisodes || []) {
      items.push({
        key: `ep-${ep.id}`,
        at: new Date(ep.startedAt).getTime(),
        ...(HISTORY_STYLES[ep.startMethod] || HISTORY_STYLES.assigned),
        title: (
          <>
            <span className="font-medium">{ep.technician?.name || 'Technician'}</span>
            <span className="text-slate-500"> took ownership ({humanize(ep.startMethod)})</span>
          </>
        ),
        meta: ep.startAssignedByName ? `by ${ep.startAssignedByName}` : null,
      });
      if (ep.endedAt && ep.endMethod && ep.endMethod !== 'still_active') {
        items.push({
          key: `ep-end-${ep.id}`,
          at: new Date(ep.endedAt).getTime(),
          ...(HISTORY_STYLES[ep.endMethod] || HISTORY_STYLES.default),
          title: (
            <>
              <span className="font-medium">{ep.technician?.name || 'Technician'}</span>
              <span className="text-slate-500">’s ownership ended ({humanize(ep.endMethod)})</span>
            </>
          ),
          meta: ep.endActorName ? `by ${ep.endActorName}` : null,
        });
      }
    }
    for (const pr of ticket?.pipelineRuns || []) {
      items.push({
        key: `run-${pr.id}`,
        at: new Date(pr.decidedAt || pr.createdAt).getTime(),
        ...HISTORY_STYLES.ai_triage,
        title: (
          <>
            <span className="font-medium">{pr.status === 'queued' ? 'AI triage queued' : 'AI run'}</span>
            <span className="text-slate-500"> — {pipelineRunLabel(pr)}</span>
          </>
        ),
        meta: `via ${pipelineTriggerLabel(pr.triggerSource)}${pr.syncStatus ? ` · sync ${pr.syncStatus}` : ''}`,
      });
    }
    // FS system feed (workflow executions, field sets): verbatim lines cached
    // as thread entries — history material, deliberately kept out of the
    // conversation. Assignment/status/group events are skipped here because
    // the structured audit rows above already cover them.
    for (const e of ticket?.thread || []) {
      if (e.source !== 'freshservice_activity' || e.eventType !== 'activity') continue;
      const text = String(e.bodyText || e.content || '').trim();
      if (!text) continue;
      items.push({
        key: `sys-${e.id}`,
        at: new Date(e.occurredAt).getTime(),
        icon: Bot,
        tone: 'bg-slate-100 text-slate-500',
        title: (
          <>
            <span className="font-medium">{e.actorName || 'System'}</span>
            <span className="text-slate-500"> · system activity</span>
          </>
        ),
        meta: text.length > 220 ? `${text.slice(0, 220)}…` : text,
      });
    }
    return items.sort((x, y) => y.at - x.at);
  }, [ticket?.activities, ticket?.assignmentEpisodes, ticket?.pipelineRuns, ticket?.thread, techNameById]);

  const subcategories = useMemo(() => {
    const top = (meta?.categoryTree || []).find((c) => c.id === effectiveCategoryId);
    return top?.subcategories || [];
  }, [meta, effectiveCategoryId]);

  // Category picker scoped by the ticket's group (gap plan P2.3): categories
  // mapped to OTHER groups drop out; unmapped categories stay visible to all.
  // The current value is always kept so an off-scope pick never disappears.
  const scopedCategoryTree = useMemo(() => {
    const tree = meta?.categoryTree || [];
    const links = meta?.categoryGroupLinks || [];
    if (!links.length || !ticket?.groupId) return tree;
    const gid = String(ticket.groupId);
    const mapped = new Set(links.map((l) => l.categoryId));
    const allowed = new Set(links.filter((l) => l.groupId === gid).map((l) => l.categoryId));
    return tree.filter((c) => !mapped.has(c.id) || allowed.has(c.id) || c.id === effectiveCategoryId);
  }, [meta?.categoryTree, meta?.categoryGroupLinks, ticket?.groupId, effectiveCategoryId]);

  const attachmentsByEntry = useMemo(() => {
    const map = new Map();
    for (const a of ticket?.attachments || []) {
      if (!a.threadEntryId) continue;
      if (!map.has(a.threadEntryId)) map.set(a.threadEntryId, []);
      map.get(a.threadEntryId).push(a);
    }
    return map;
  }, [ticket?.attachments]);

  // Ticket-level (description) image attachments — shown as an inline strip
  // under the description (QA 07-06 #9).
  const descriptionImages = useMemo(
    () => (ticket?.attachments || []).filter((a) => !a.threadEntryId && isImageAttachment(a)),
    [ticket?.attachments],
  );

  const techPhotoByEmail = useMemo(() => {
    const map = new Map();
    for (const t of meta?.technicians || []) {
      if (t.email && t.photoUrl) map.set(t.email.toLowerCase(), t.photoUrl);
    }
    return map;
  }, [meta?.technicians]);
  const photoFor = useCallback((entry) => {
    const email = entry.actorEmail ? String(entry.actorEmail).toLowerCase() : null;
    if (email && techPhotoByEmail.has(email)) return techPhotoByEmail.get(email);
    // Requester messages reuse the Entra photo fetched for the header.
    if (requesterPhoto && (
      (email && email === (requesterEmail || '').toLowerCase())
      || (!email && entry.authorType !== 'agent' && (entry.authorType === 'requester' || entry.incoming === true))
    )) {
      return requesterPhoto;
    }
    return null;
  }, [techPhotoByEmail, requesterPhoto, requesterEmail]);

  const applyChange = useCallback(async (field, fn, { undo = null, label = 'Saved' } = {}) => {
    setSavingField(field);
    lastLocalMutationRef.current = Date.now(); // own change — no self-flash
    try {
      await fn();
      await fetchTicket({ silent: true });
      // Instant saves get an Undo (QA 07-06 #3): the toast holds the previous
      // value for ~5s and re-applies it through the same API on click.
      showToast('emerald', label, undo ? {
        undo: async () => {
          lastLocalMutationRef.current = Date.now();
          try {
            await undo();
            await fetchTicket({ silent: true });
            showToast('sky', 'Change undone');
          } catch (err) {
            showToast('red', err.response?.data?.message || err.message || 'Undo failed');
          }
        },
      } : {});
    } catch (err) {
      showToast('red', err.response?.data?.message || err.message || 'Change failed');
    } finally {
      setSavingField(null);
    }
  }, [fetchTicket, showToast]);

  // Force this native ticket's pending/failed FreshService mirror to run now.
  const retryMirror = useCallback(async () => {
    setSavingField('mirror');
    lastLocalMutationRef.current = Date.now();
    try {
      const res = await ticketsAPI.retryMirror(ticketId);
      await fetchTicket({ silent: true });
      const d = res.data || {};
      showToast(d.remaining ? 'sky' : 'emerald', d.remaining ? `Mirror retried — ${d.remaining} still pending` : 'Mirrored to FreshService ✓');
    } catch (err) {
      showToast('red', err.response?.data?.message || err.message || 'Mirror failed');
    } finally {
      setSavingField(null);
    }
  }, [ticketId, fetchTicket, showToast]);

  const downloadAttachment = useCallback((a) => {
    ticketsAPI.downloadAttachment(ticketId, a.id, a.fileName)
      .catch((err) => showToast('red', err.response?.data?.message || 'Download failed'));
  }, [ticketId, showToast]);

  const isAdmin = meta?.actor?.kind === 'admin' || meta?.actor?.workspaceRole === 'admin';
  const [deletingNoteId, setDeletingNoteId] = useState(null);
  const deleteNote = useCallback(async (entryId) => {
    setDeletingNoteId(entryId);
    try {
      await ticketsAPI.deleteNote(ticketId, entryId);
      lastLocalMutationRef.current = Date.now();
      await fetchTicket({ silent: true });
      showToast('emerald', 'Note deleted');
    } catch (err) {
      showToast('red', err.response?.data?.message || 'Could not delete note');
    } finally {
      setDeletingNoteId(null);
    }
  }, [ticketId, fetchTicket, showToast]);

  const [previewAttachment, setPreviewAttachment] = useState(null);
  // Preview image attachments/refs in a lightbox instead of forcing a download.
  const previewImage = useCallback((a) => {
    if (a) setPreviewAttachment(a);
  }, []);
  // Resolve an inline "[Image: name]" reference to an attachment by file name
  // (case/space-insensitive) and preview it; fall back to a download if the
  // exact bytes aren't attached (e.g. an inline paste that didn't upload).
  const previewImageRef = useCallback((name) => {
    const wanted = String(name || '').trim().toLowerCase();
    if (!wanted) return;
    const all = ticket?.attachments || [];
    const hit = all.find((a) => String(a.fileName || '').trim().toLowerCase() === wanted)
      || all.find((a) => String(a.fileName || '').trim().toLowerCase().includes(wanted));
    if (hit) setPreviewAttachment(hit);
    else showToast('sky', `No attachment named “${name}” on this ticket`);
  }, [ticket?.attachments, showToast]);

  const attachmentInputRef = useRef(null);
  const [uploadProgress, setUploadProgress] = useState(null); // { pct, name, count } | null
  const uploadAttachments = async (picked) => {
    const files = Array.from(picked || []);
    if (files.length === 0) return;
    setSavingField('attachments');
    const label = files.length === 1 ? files[0].name : `${files.length} files`;
    setUploadProgress({ pct: 0, name: label, count: files.length });
    try {
      await ticketsAPI.uploadAttachments(ticketId, files, (pct) => setUploadProgress((p) => (p ? { ...p, pct } : p)));
      await fetchTicket({ silent: true });
      showToast('emerald', `${files.length} file${files.length === 1 ? '' : 's'} attached`);
    } catch (err) {
      showToast('red', err.response?.data?.message || err.message || 'Upload failed');
    } finally {
      setSavingField(null);
      setUploadProgress(null);
    }
  };

  const copyText = useCallback((text) => {
    navigator.clipboard?.writeText(text || '').then(
      () => showToast('emerald', 'Copied to clipboard'),
      () => showToast('red', 'Copy failed'),
    );
  }, [showToast]);

  const copyLink = () => copyText(window.location.href);

  const cloneTicket = () => applyChange('clone', async () => {
    const res = await ticketsAPI.clone(ticketId);
    showToast('emerald', `Cloned as ${res.data.displayRef}`);
    navigate(`/tickets/${res.data.id}`);
  });

  const pickUp = () => {
    if (!confirmPickup) { setConfirmPickup(true); return; }
    setConfirmPickup(false);
    applyChange('pickup', () => ticketsAPI.assign(ticketId, meta.actor.technicianId));
  };

  // Delete a TP-born ticket (soft-delete). Two-click confirm; navigates back to the queue.
  const deleteTicket = () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setConfirmDelete(false);
    applyChange('delete', async () => {
      await ticketsAPI.remove(ticketId);
      showToast('red', 'Ticket deleted');
      navigate('/tickets');
    });
  };

  const [noiseMenuOpen, setNoiseMenuOpen] = useState(false);
  const noiseMenuRef = useRef(null);
  useEffect(() => {
    if (!noiseMenuOpen) return undefined;
    const onDoc = (e) => { if (noiseMenuRef.current && !noiseMenuRef.current.contains(e.target)) setNoiseMenuOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [noiseMenuOpen]);

  const setNoiseFlag = async (noise, resolve = false) => {
    setNoiseMenuOpen(false);
    setSavingField('noise');
    try {
      const res = await ticketsAPI.setNoise(ticketId, { noise, resolve });
      await fetchTicket({ silent: true });
      showToast('emerald', noise
        ? (res.data.resolved ? 'Flagged as noise & resolved' : 'Flagged as noise — hidden from the default queue')
        : 'Noise flag removed');
    } catch (err) {
      showToast('red', err.response?.data?.message || err.message || 'Change failed');
    } finally {
      setSavingField(null);
    }
  };

  // ---- Related tickets (accuracy-first): facts + clearly-labeled suggestions ----
  const [related, setRelated] = useState(null);
  const [dupeDismissed, setDupeDismissed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setRelated(null);
    try { setDupeDismissed(Boolean(sessionStorage.getItem(`tp_dupe_dismiss_${ticketId}`))); } catch { /* no-op */ }
    ticketsAPI.related(ticketId)
      .then((res) => { if (!cancelled) setRelated(res.data); })
      .catch(() => { if (!cancelled) setRelated({ sameRequester: [], nearDuplicates: [], similarByContent: [] }); });
    return () => { cancelled = true; };
  }, [ticketId]);
  const dismissDupes = () => {
    try { sessionStorage.setItem(`tp_dupe_dismiss_${ticketId}`, '1'); } catch { /* no-op */ }
    setDupeDismissed(true);
  };

  // ---- Watch subscriptions: per category/group, never per ticket ----
  const [watchSubs, setWatchSubs] = useState([]);
  const loadWatchSubs = useCallback(() => {
    ticketsAPI.listWatchSubscriptions().then((res) => setWatchSubs(res.data || [])).catch(() => {});
  }, []);
  useEffect(() => { loadWatchSubs(); }, [loadWatchSubs]);
  const watchingCategory = Boolean(ticket?.internalCategoryId && watchSubs.some(
    (s) => s.scopeType === 'category' && [ticket.internalCategoryId, ticket.internalSubcategoryId].includes(s.categoryId),
  ));
  const watchingGroup = Boolean(ticket?.groupId && watchSubs.some(
    (s) => s.scopeType === 'group' && String(s.groupId) === String(ticket.groupId),
  ));
  const toggleWatch = async (scopeType) => {
    const watching = scopeType === 'category' ? watchingCategory : watchingGroup;
    setSavingField(`watch-${scopeType}`);
    try {
      await ticketsAPI.setWatchSubscription({
        scopeType,
        categoryId: scopeType === 'category' ? ticket.internalCategoryId : null,
        groupId: scopeType === 'group' ? String(ticket.groupId) : null,
        watch: !watching,
        notifyRequesterReply: true,
      });
      loadWatchSubs();
      showToast('emerald', watching
        ? `Stopped watching this ${scopeType}`
        : `Watching this ${scopeType} — emails on new tickets & requester replies`);
    } catch (err) {
      showToast('red', err.response?.data?.message || err.message);
    } finally {
      setSavingField(null);
    }
  };

  // ---- Reply templates ----
  const [templates, setTemplates] = useState([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const templatesRef = useRef(null);
  const loadTemplates = useCallback(() => {
    ticketsAPI.listTemplates().then((res) => setTemplates(res.data || [])).catch(() => {});
  }, []);
  useEffect(() => { loadTemplates(); }, [loadTemplates]);
  useEffect(() => {
    if (!templatesOpen) return undefined;
    const onDoc = (e) => { if (templatesRef.current && !templatesRef.current.contains(e.target)) setTemplatesOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [templatesOpen]);
  const insertTemplate = (template) => {
    const addition = template.bodyHtml || String(template.bodyText || '').replace(/\n/g, '<br>');
    const joined = composerText.trim() ? `${composerBody}<p><br></p>${addition}` : addition;
    setComposerBody(joined);
    setComposerText(htmlToText(joined));
    setTemplatesOpen(false);
    setTimeout(() => composerRef.current?.focus(), 0);
  };
  const saveTemplate = async () => {
    const name = templateName.trim();
    if (!name || !composerText.trim()) return;
    try {
      await ticketsAPI.createTemplate({
        name,
        bodyText: composerText.trim(),
        bodyHtml: isRichContent(composerBody) ? composerBody : null,
      });
      setTemplateName('');
      loadTemplates();
      showToast('emerald', `Template “${name}” saved for the workspace`);
    } catch (err) {
      showToast('red', err.response?.data?.message || err.message);
    }
  };
  const removeTemplate = async (template) => {
    try {
      await ticketsAPI.removeTemplate(template.id);
      loadTemplates();
    } catch (err) {
      showToast('red', err.response?.data?.message || err.message);
    }
  };

  // ---- Quick notes: canned INTERNAL notes, scoped by top category (QA 07-06 #12) ----
  const [quickNotes, setQuickNotes] = useState([]);
  const [quickNotesOpen, setQuickNotesOpen] = useState(false);
  const quickNotesRef = useRef(null);
  useEffect(() => {
    ticketsAPI.listQuickNotes().then((res) => setQuickNotes(res.data || [])).catch(() => {});
  }, []);
  useEffect(() => {
    if (!quickNotesOpen) return undefined;
    const onDoc = (e) => { if (quickNotesRef.current && !quickNotesRef.current.contains(e.target)) setQuickNotesOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [quickNotesOpen]);
  // Unscoped notes always show; scoped notes only on tickets in one of their top categories.
  const visibleQuickNotes = useMemo(() => quickNotes.filter((n) =>
    !(n.internalCategoryIds || []).length
    || (effectiveCategoryId && n.internalCategoryIds.includes(effectiveCategoryId)),
  ), [quickNotes, effectiveCategoryId]);
  const insertQuickNote = (note) => {
    const addition = note.bodyHtml || String(note.bodyText || '').replace(/\n/g, '<br>');
    const joined = composerText.trim() ? `${composerBody}<p><br></p>${addition}` : addition;
    setComposerBody(joined);
    setComposerText(htmlToText(joined));
    setQuickNotesOpen(false);
    setTimeout(() => composerRef.current?.focus(), 0);
  };

  // ---- Forward mode ----
  const [forwardTo, setForwardTo] = useState([]);

  const resolveTicket = () => applyChange('resolve', () => ticketsAPI.setStatus(ticketId, 'Resolved'));

  const startSubjectEdit = () => {
    setSubjectDraft(ticket.subject || '');
    setEditingSubject(true);
  };
  const commitSubject = () => {
    setEditingSubject(false);
    const next = subjectDraft.trim();
    if (next && next !== ticket.subject) {
      applyChange('subject', () => ticketsAPI.update(ticketId, { subject: next }));
    }
  };

  const startDescriptionEdit = () => {
    setDescriptionDraft(ticket.descriptionText || ticket.description || '');
    setEditingDescription(true);
  };
  const commitDescription = () => {
    setEditingDescription(false);
    applyChange('description', () => ticketsAPI.update(ticketId, { description: descriptionDraft }));
  };

  const sendComposer = async () => {
    const body = composerText.trim();
    if (composerMode === 'forward') {
      if (forwardTo.length === 0) {
        showToast('red', 'Add at least one destination email to forward to');
        return;
      }
      setIsSending(true);
      try {
        await ticketsAPI.forward(ticketId, { to: forwardTo, note: body });
        setComposerBody('');
        setComposerText('');
        setForwardTo([]);
        try { localStorage.removeItem(draftKey); } catch { /* no-op */ }
        await fetchTicket({ silent: true });
        showToast('emerald', `Thread forwarded to ${forwardTo.join(', ')}`);
      } catch (err) {
        showToast('red', err.response?.data?.message || err.message || 'Forward failed');
      } finally {
        setIsSending(false);
      }
      return;
    }
    if (!body) return;
    setIsSending(true);
    lastLocalMutationRef.current = Date.now();
    try {
      const payload = {
        bodyText: body,
        ...(isRichContent(composerBody) ? { bodyHtml: composerBody } : {}),
        files: composerFiles,
      };
      if (composerMode === 'reply') {
        await ticketsAPI.reply(ticketId, { ...payload, cc: composerCc });
      } else {
        await ticketsAPI.note(ticketId, payload);
      }
      setComposerBody('');
      setComposerText('');
      setComposerCc([]);
      setComposerFiles([]);
      try { localStorage.removeItem(draftKey); } catch { /* no-op */ }
      await fetchTicket({ silent: true });
      const ccNote = composerMode === 'reply' && composerCc.length ? ` (+${composerCc.length} Cc)` : '';
      const fileNote = composerFiles.length ? ` · ${composerFiles.length} file${composerFiles.length === 1 ? '' : 's'}` : '';
      showToast('emerald', composerMode === 'reply' ? `Reply posted — requester emailed${ccNote}${fileNote}` : `Internal note added${fileNote}`);
    } catch (err) {
      showToast('red', err.response?.data?.message || err.message || 'Send failed');
    } finally {
      setIsSending(false);
    }
  };

  const fieldClass = 'tp-focus-ring w-full text-sm bg-white border border-input rounded-lg px-2.5 py-1.5 text-slate-700 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed';
  const pipelineRuns = ticket?.pipelineRuns || [];
  const canPickUp = canWrite && meta?.actor?.technicianId && ticket?.assignedTechId !== meta.actor.technicianId;

  // ---- AI assignment: pending suggestion + live-run modal ----
  const aiPendingRun = pipelineRuns.find((r) => r.status === 'completed' && r.decision === 'pending_review') || null;
  const aiRecs = useMemo(() => {
    const rec = aiPendingRun?.recommendation;
    const list = Array.isArray(rec?.recommendations) ? rec.recommendations : Array.isArray(rec) ? rec : [];
    return list.slice(0, 3);
  }, [aiPendingRun]);
  const aiSuggestionForPicker = aiPendingRun && aiRecs[0]
    ? {
      runId: aiPendingRun.id,
      state: 'suggested',
      techId: aiRecs[0].techId ?? null,
      techName: aiRecs[0].techName || null,
      score: typeof aiRecs[0].score === 'number' ? aiRecs[0].score : null,
    }
    : pipelineRuns.some((r) => r.status === 'running') ? { state: 'analyzing' }
      : pipelineRuns.some((r) => r.status === 'queued') ? { state: 'queued' } : null;
  // Already-assigned guard: approving an AI pick when the ticket already has an
  // owner is a reassignment — surface it instead of a plain "Approve".
  const alreadyAssigned = Boolean(ticket?.assignedTechId);
  const assigneeName = ticket?.assignedTech?.name || null;
  const aiIsReassign = alreadyAssigned && aiRecs[0] && Number(aiRecs[0].techId) !== Number(ticket?.assignedTechId);

  const approveAiRun = async () => {
    if (!aiPendingRun || aiDeciding) return;
    setAiDeciding(true);
    try {
      await assignmentAPI.decide(aiPendingRun.id, { decision: 'approved', assignedTechId: aiRecs[0]?.techId || undefined });
      lastLocalMutationRef.current = Date.now();
      showToast('emerald', `Approved — assigning to ${aiRecs[0]?.techName || 'technician'}`);
      fetchTicket({ silent: true });
    } catch (err) {
      showToast('red', err.response?.data?.message || err.message || 'Approve failed');
    }
    setAiDeciding(false);
  };

  return (
    <div className="tp-tickets-backdrop min-h-screen md:pl-[14px] print:pl-0">
      <div className="print-hide"><AppHeader activePage="tickets" /></div>

      {/* pb clears the mobile bottom tab bar (QA 07-06 #11) */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-20 md:pb-6 animate-fadeIn">
        <div className="flex items-center justify-between mb-4 print-hide">
          <button
            onClick={() => navigate('/tickets')}
            className="tp-focus-ring inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-blue-700 rounded"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to tickets
          </button>
          {navIndex >= 0 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => prevId && navigate(`/tickets/${prevId}`)}
                disabled={!prevId}
                aria-label="Previous ticket in queue"
                className="tp-focus-ring p-1.5 rounded-lg border border-slate-200 bg-white text-slate-500 disabled:opacity-40 hover:border-blue-300 hover:text-blue-700"
              >
                <ChevronLeft className="w-4 h-4" aria-hidden="true" />
              </button>
              <span className="text-xs text-slate-400 px-1">{navIndex + 1} / {navIds.length}</span>
              <button
                onClick={() => nextId && navigate(`/tickets/${nextId}`)}
                disabled={!nextId}
                aria-label="Next ticket in queue"
                className="tp-focus-ring p-1.5 rounded-lg border border-slate-200 bg-white text-slate-500 disabled:opacity-40 hover:border-blue-300 hover:text-blue-700"
              >
                <ChevronRight className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>

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
              <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                    <span className="font-mono text-sm font-bold text-slate-500">{ticket.displayRef}</span>
                    <OriginChip origin={ticket.origin} />
                    <MirrorChip ticket={ticket} />
                    {isNative && isAdmin && ['pending', 'error'].includes(ticket.mirrorState) && (
                      <button
                        onClick={retryMirror}
                        disabled={savingField === 'mirror'}
                        title="Mirror to FreshService now (auto-mirrors every ~60s)"
                        className="tp-focus-ring inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white text-blue-700 border border-blue-200 hover:bg-blue-50 disabled:opacity-50"
                      >
                        {savingField === 'mirror' ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-3 h-3" aria-hidden="true" />}
                        Mirror now
                      </button>
                    )}
                    {isNative && ticket.freshserviceTicketId && fsUrl && (
                      <a
                        href={fsUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={`FreshService fallback copy #${ticket.freshserviceTicketId}`}
                        className="tp-focus-ring inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-white text-blue-700 border border-blue-200 hover:bg-blue-50"
                      >
                        <ExternalLink className="w-3 h-3" aria-hidden="true" /> View FS mirror #{String(ticket.freshserviceTicketId)}
                      </a>
                    )}
                    <ProvenanceChip ticket={ticket} />
                    <StateChip state={ticket.stateChip} />
                    <TypePill type={ticket.ticketType} full />
                    {approvalSummary && (
                      <button
                        type="button"
                        onClick={() => setPageTab('approvals')}
                        title="View approvals"
                        className={`tp-focus-ring inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${approvalSummary.cls}`}
                      >
                        <Stamp className="w-3 h-3" aria-hidden="true" /> {approvalSummary.label}
                      </button>
                    )}
                    {ticket.isNoise && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-500 border border-slate-200">Noise</span>
                    )}
                    {/* Requester sentiment (AI, team-safe: requester state only).
                        Neutral is the default state — only the actionable ends
                        get a chip, so it means something when one appears. */}
                    {ticket.sentiment === 'frustrated' && (
                      <span
                        title={`Requester sounds frustrated in their recent messages (AI classification${ticket.sentimentComputedAt ? `, ${timeAgo(ticket.sentimentComputedAt)}` : ''}). Describes the requester, never the agent.`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-50 text-red-700 border border-red-200"
                      >
                        <Flame className="w-3 h-3" aria-hidden="true" /> Requester frustrated
                      </span>
                    )}
                    {ticket.sentiment === 'positive' && (
                      <span
                        title={`Requester sounds positive in their recent messages (AI classification${ticket.sentimentComputedAt ? `, ${timeAgo(ticket.sentimentComputedAt)}` : ''}).`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200"
                      >
                        <Smile className="w-3 h-3" aria-hidden="true" /> Requester positive
                      </span>
                    )}
                    {alsoViewing.length > 0 && (
                      <span
                        className="inline-flex items-center gap-1.5 pl-1 pr-2 py-0.5 rounded-full bg-violet-50 border border-violet-200 animate-fadeIn"
                        title={`Also viewing: ${alsoViewing.map((v) => v.name).join(', ')}`}
                      >
                        <span className="flex -space-x-1.5" aria-hidden="true">
                          {alsoViewing.slice(0, 4).map((v) => (
                            <span
                              key={v.email}
                              className="w-4.5 h-4.5 min-w-[18px] min-h-[18px] rounded-full bg-violet-500 border border-white text-white text-[8px] font-bold flex items-center justify-center uppercase"
                            >
                              {(v.name || v.email).trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('')}
                            </span>
                          ))}
                        </span>
                        <span className="text-[10px] font-semibold text-violet-700">
                          {alsoViewing.length === 1
                            ? `${(alsoViewing[0].name || alsoViewing[0].email).split(/\s+/)[0]} is also viewing`
                            : `${alsoViewing.length} also viewing`}
                        </span>
                      </span>
                    )}
                    <div
                      onMouseEnter={() => { ackChange('status'); ackChange('priority'); }}
                      className={`ml-auto flex items-center gap-2 rounded-lg transition-all ${
                        liveChanges.status || liveChanges.priority ? 'ring-2 ring-amber-300 bg-amber-50 px-1.5 py-0.5' : ''
                      }`}
                    >
                      <PriorityDot priority={ticket.priority} withLabel />
                      <StatusPill status={ticket.status} />
                    </div>
                  </div>

                  {editingSubject ? (
                    <input
                      autoFocus
                      value={subjectDraft}
                      onChange={(e) => setSubjectDraft(e.target.value)}
                      onBlur={commitSubject}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitSubject();
                        if (e.key === 'Escape') setEditingSubject(false);
                      }}
                      aria-label="Edit subject"
                      className="tp-focus-ring w-full text-lg sm:text-xl font-bold text-slate-900 bg-white border border-blue-300 rounded-lg px-2 py-1"
                    />
                  ) : (
                    <h1
                      onMouseEnter={liveChanges.subject ? () => ackChange('subject') : undefined}
                      className={`text-lg sm:text-xl font-bold text-slate-900 leading-snug group rounded-lg transition-all ${
                        liveChanges.subject ? 'ring-2 ring-amber-300 bg-amber-50 px-1.5' : ''
                      }`}
                    >
                      {ticket.subject || '(no subject)'}
                      {canWrite && (
                        <button
                          onClick={startSubjectEdit}
                          aria-label="Edit subject"
                          className="tp-focus-ring ml-2 p-1 rounded text-slate-300 hover:text-blue-600 align-middle"
                        >
                          <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </h1>
                  )}

                  <p className="text-xs text-slate-400 mt-1">
                Created {timeAgo(ticket.createdAt)}
                    {ticket.requester?.name ? <> by <span className="text-slate-600 font-medium">{ticket.requester.name}</span></> : null}
                    {ticket.resolvedAt ? <> · resolved {timeAgo(ticket.resolvedAt)}</> : null}
                    {ticket.lastActivityAt ? <> · last activity {timeAgo(ticket.lastActivityAt)}</> : null}
                  </p>

                  {/* Quick actions */}
                  <div className="mt-3 flex flex-wrap items-center gap-2 print-hide">
                    {canPickUp && (
                      <button
                        onClick={pickUp}
                        onBlur={() => setConfirmPickup(false)}
                        disabled={savingField === 'pickup'}
                        className={`tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                          confirmPickup
                            ? 'bg-blue-600 text-white border-blue-600'
                            : 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                        }`}
                      >
                        {savingField === 'pickup' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Hand className="w-3.5 h-3.5" aria-hidden="true" />}
                        {confirmPickup ? 'Confirm pick up?' : 'Pick up'}
                      </button>
                    )}
                    {canWrite && !['Resolved', 'Closed'].includes(ticket.status) && (
                      <button
                        onClick={resolveTicket}
                        disabled={savingField === 'resolve'}
                        className="tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                      >
                        {savingField === 'resolve' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Check className="w-3.5 h-3.5" aria-hidden="true" />}
                    Resolve
                      </button>
                    )}
                    <button
                      onClick={copyLink}
                      className="tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-white text-slate-600 border border-slate-200 hover:border-blue-300 hover:text-blue-700"
                    >
                      <Link2 className="w-3.5 h-3.5" aria-hidden="true" /> Copy link
                    </button>
                    <button
                      onClick={() => window.print()}
                      className="tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-white text-slate-600 border border-slate-200 hover:border-blue-300 hover:text-blue-700"
                    >
                      <Download className="w-3.5 h-3.5" aria-hidden="true" /> Print
                    </button>
                    {canConverse && (
                      <MacroMenu
                        ticketId={ticketId}
                        onApplied={(result) => {
                          lastLocalMutationRef.current = Date.now();
                          fetchTicket({ silent: true });
                          const failed = (result?.steps || []).filter((s) => !s.ok);
                          showToast(failed.length ? 'amber' : 'emerald', failed.length
                            ? `Macro applied with ${failed.length} failed step${failed.length === 1 ? '' : 's'}`
                            : `Macro "${result?.macro?.name || ''}" applied`);
                        }}
                      />
                    )}
                    {ticketingOn && (
                      <button
                        onClick={() => setCloneConfirm(true)}
                        disabled={savingField === 'clone'}
                        title="Create a new draft ticket pre-filled from this one"
                        className="tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-white text-slate-600 border border-slate-200 hover:border-blue-300 hover:text-blue-700"
                      >
                        {savingField === 'clone' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <CopyPlus className="w-3.5 h-3.5" aria-hidden="true" />}
                    Clone
                      </button>
                    )}
                    {isNative && canReview && (
                      <button
                        onClick={deleteTicket}
                        onBlur={() => setConfirmDelete(false)}
                        disabled={savingField === 'delete'}
                        title="Delete this Ticket Pulse ticket"
                        className={`tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                          confirmDelete
                            ? 'bg-red-600 text-white border-red-600 hover:bg-red-700'
                            : 'bg-white text-slate-600 border-slate-200 hover:border-red-300 hover:text-red-700'
                        }`}
                      >
                        {savingField === 'delete' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />}
                        {confirmDelete ? 'Confirm delete' : 'Delete'}
                      </button>
                    )}
                    <span ref={noiseMenuRef} className="relative">
                      <button
                        onClick={() => (ticket.isNoise ? setNoiseFlag(false) : setNoiseMenuOpen((v) => !v))}
                        disabled={savingField === 'noise'}
                        aria-expanded={ticket.isNoise ? undefined : noiseMenuOpen}
                        className={`tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                          ticket.isNoise
                            ? 'bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100'
                            : 'bg-white text-slate-600 border-slate-200 hover:border-violet-300 hover:text-violet-700'
                        }`}
                      >
                        {savingField === 'noise' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <VolumeX className="w-3.5 h-3.5" aria-hidden="true" />}
                        {ticket.isNoise ? 'Unmark noise' : 'Mark as noise'}
                      </button>
                      {noiseMenuOpen && !ticket.isNoise && (
                        <span className="absolute left-0 top-full mt-1 z-30 w-60 tp-card rounded-lg shadow-soft p-1 flex flex-col animate-scaleIn" role="menu">
                          <button
                            onClick={() => setNoiseFlag(true)}
                            role="menuitem"
                            className="tp-focus-ring w-full text-left px-2.5 py-1.5 text-sm rounded-md text-slate-600 hover:bg-violet-50 hover:text-violet-700"
                          >
                        Flag as noise
                          </button>
                          {isNative && !['Resolved', 'Closed'].includes(ticket.status) && (
                            <button
                              onClick={() => setNoiseFlag(true, true)}
                              role="menuitem"
                              className="tp-focus-ring w-full text-left px-2.5 py-1.5 text-sm rounded-md text-slate-600 hover:bg-emerald-50 hover:text-emerald-700"
                            >
                          Flag as noise & resolve
                            </button>
                          )}
                          <span className="px-2.5 pt-1 pb-1.5 text-[10px] text-slate-400 border-t border-slate-100 mt-1">
                        Noise tickets leave the default queue — find them under Views → Noise & spam.
                          </span>
                        </span>
                      )}
                    </span>
                  </div>

                  {ticket.mergedInto && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 p-2.5 bg-violet-50 border border-violet-200 rounded-lg text-xs text-violet-800">
                      <CopyPlus className="w-3.5 h-3.5 text-violet-500 flex-shrink-0" aria-hidden="true" />
                      This ticket was merged into
                      <button
                        onClick={() => navigate(`/tickets/${ticket.mergedInto.id}`)}
                        className="tp-focus-ring font-mono font-bold text-violet-700 hover:underline rounded"
                      >
                        {ticket.mergedInto.displayRef}
                      </button>
                      — the conversation continues there.
                    </div>
                  )}

                  {!isNative && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
                      <ShieldCheck className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" aria-hidden="true" />
                  FreshService owns this ticket — edits to assignee, status, priority and category sync back to FreshService (with confirmation); replies are delivered through FreshService.
                      {fsUrl && (
                        <a href={fsUrl} target="_blank" rel="noreferrer" className="tp-focus-ring inline-flex items-center gap-1 font-semibold text-blue-700 hover:underline rounded ml-auto">
                      Open in FreshService <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </a>
                      )}
                    </div>
                  )}
                </div>

                {/* Requester panel — compact contact card (Entra/FS enriched) */}
                <div className="mt-4 lg:mt-0 lg:border-l lg:border-slate-100 lg:pl-5 lg:self-center">
                  {ticket.requester ? (
                    <div>
                      <div className="flex items-center gap-3">
                        {requesterPhoto ? (
                          <img src={requesterPhoto} alt="" className="h-12 w-12 rounded-full object-cover ring-2 ring-white shadow-subtle flex-shrink-0" />
                        ) : (
                          <PersonAvatar name={ticket.requester.name} size="h-12 w-12" textSize="text-base" />
                        )}
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-slate-900 truncate">{ticket.requester.name}</p>
                          {(() => {
                            const role = [
                              ticket.requester.entraJobTitle || ticket.requester.jobTitle,
                              ticket.requester.entraDepartment || ticket.requester.department,
                            ].filter(Boolean).join(' · ');
                            return role ? <p className="text-xs text-slate-500 truncate">{role}</p> : null;
                          })()}
                        </div>
                      </div>

                      {/* Contact + activity as compact chips (kills the tall list) */}
                      <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
                        {ticket.requester.email && (
                          <button
                            onClick={() => copyText(ticket.requester.email)}
                            title={`Copy ${ticket.requester.email}`}
                            className="tp-focus-ring inline-flex items-center gap-1.5 max-w-full px-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-700"
                          >
                            <Mail className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" aria-hidden="true" />
                            <span className="truncate">{ticket.requester.email}</span>
                          </button>
                        )}
                        {(ticket.requester.entraOfficeLocation || ticket.requester.entraCity) && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-500">
                            <MapPin className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" aria-hidden="true" />
                            <span className="truncate max-w-[160px]">
                              {[...new Set([ticket.requester.entraOfficeLocation, ticket.requester.entraCity, ticket.requester.entraState].filter(Boolean))].join(' · ')}
                            </span>
                          </span>
                        )}
                        {ticket.requester.phone && (
                          <a href={`tel:${ticket.requester.phone}`} className="tp-focus-ring inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-500 hover:border-blue-300 hover:text-blue-700">
                            <Phone className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" aria-hidden="true" />
                            <span>{ticket.requester.phone}</span>
                          </a>
                        )}
                        {ticket.requester.mobile && ticket.requester.mobile !== ticket.requester.phone && (
                          <a href={`tel:${ticket.requester.mobile}`} className="tp-focus-ring inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-500 hover:border-blue-300 hover:text-blue-700">
                            <Smartphone className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" aria-hidden="true" />
                            <span>{ticket.requester.mobile}</span>
                          </a>
                        )}
                        {ticket.requesterId && (related?.sameRequesterCount || 0) > 0 && (
                          <Link
                            to={`/tickets?requesterId=${ticket.requesterId}&requesterName=${encodeURIComponent(ticket.requester.name || '')}&status=any`}
                            title={`View all tickets from ${ticket.requester.name || 'this requester'}`}
                            className="tp-focus-ring inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-blue-50 border border-blue-200 text-blue-700 font-medium hover:bg-blue-100"
                          >
                            <History className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                            <span>{related.sameRequesterCount} other ticket{related.sameRequesterCount === 1 ? '' : 's'}</span>
                            <ChevronRight className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                          </Link>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400">No requester on record</p>
                  )}
                </div>
              </div>
            </div>

            {/* Page tabs — folder-style: squared, bordered, sitting on a baseline;
                scroll horizontally on narrow screens instead of clipping. */}
            <div role="tablist" aria-label="Ticket sections" className="flex items-end gap-1 border-b border-slate-200 mb-4 overflow-x-auto no-scrollbar print-hide">
              {[
                { key: 'conversation', label: 'Conversation', icon: MessageSquare, count: conversationEntries.filter(isConversationEntry).length },
                { key: 'approvals', label: 'Approvals', icon: CheckCircle2, count: new Set((ticket.approvals || []).map((a) => a.requestGroupId || `single-${a.id}`)).size },
                { key: 'ai', label: 'AI & Routing', icon: Sparkles, count: (ticket.pipelineRuns || []).length },
                { key: 'history', label: 'History', icon: History, count: historyItems.length },
              ].map(({ key, label, icon: TabIcon, count }) => {
                const selected = pageTab === key;
                return (
                  <button
                    key={key}
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setPageTab(key)}
                    className={`tp-focus-ring relative shrink-0 -mb-px inline-flex items-center gap-1.5 px-4 py-2.5 rounded-t-lg border text-sm font-semibold transition-colors ${
                      selected
                        ? 'bg-white text-blue-700 border-slate-200 border-b-white'
                        : 'bg-slate-50 text-slate-500 border-transparent hover:bg-slate-100 hover:text-slate-700'
                    }`}
                  >
                    {selected && <span className="absolute inset-x-0 top-0 h-0.5 rounded-t bg-blue-600" aria-hidden="true" />}
                    <TabIcon className="w-4 h-4" aria-hidden="true" />
                    {label}
                    {count > 0 && (
                      <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-md text-[10px] font-bold ${
                        selected ? 'bg-blue-100 text-blue-700' : 'bg-slate-200/80 text-slate-500'
                      }`}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
              {/* Main column (tabbed) */}
              <div className="space-y-4 min-w-0">
                {pageTab === 'conversation' && (
                  <>
                    {(ticket.descriptionText || ticket.description) && !editingDescription && (
                      <section className="tp-card rounded-xl p-4 bg-gradient-to-br from-white via-white to-slate-100/80" aria-label="Ticket description">
                        <div className="flex items-center gap-2 mb-2">
                          <MessageSquare className="w-4 h-4 text-blue-500" aria-hidden="true" />
                          <h2 className="text-sm font-bold text-slate-800">Description</h2>
                          {canWrite && (
                            <button
                              onClick={startDescriptionEdit}
                              aria-label="Edit description"
                              className="tp-focus-ring ml-auto p-1 rounded text-slate-300 hover:text-blue-600"
                            >
                              <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                        <CollapsibleBody html={ticket.description} text={ticket.descriptionText} />
                        <DescriptionImageStrip ticketId={ticketId} images={descriptionImages} onPreview={previewImage} />
                      </section>
                    )}
                    {editingDescription && (
                      <section className="tp-card rounded-xl p-4" aria-label="Edit description">
                        <textarea
                          autoFocus
                          rows={6}
                          value={descriptionDraft}
                          onChange={(e) => setDescriptionDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Escape') setEditingDescription(false); }}
                          className="tp-focus-ring w-full text-sm bg-white border border-blue-300 rounded-lg px-3 py-2 resize-y"
                          aria-label="Description"
                        />
                        <div className="flex items-center justify-end gap-2 mt-2">
                          <button onClick={() => setEditingDescription(false)} className="tp-focus-ring px-3 py-1.5 text-xs font-medium text-slate-500 rounded-lg hover:bg-slate-100">Cancel</button>
                          <button onClick={commitDescription} className="tp-focus-ring px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700">Save</button>
                        </div>
                      </section>
                    )}

                    <section aria-label="Conversation">
                      {/* On-demand AI thread summary (read-only, never stored) */}
                      <ThreadSummaryCard ticketId={ticketId} />
                      <div className="flex flex-wrap items-center gap-2 mb-2 px-1">
                        <h2 className="text-sm font-bold text-slate-800">Conversation</h2>
                        <div role="tablist" aria-label="Filter conversation" className="ml-auto flex items-center gap-1">
                          {CONVERSATION_TABS.map((tab) => (
                            <button
                              key={tab.key}
                              role="tab"
                              aria-selected={conversationTab === tab.key}
                              onClick={() => setConversationTab(tab.key)}
                              className={`tp-focus-ring px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                                conversationTab === tab.key
                                  ? 'bg-slate-800 text-white border-slate-800'
                                  : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
                              }`}
                            >
                              {tab.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      {timeline.length === 0 ? (
                        <div className="tp-surface rounded-xl p-6 text-center text-sm text-slate-400">
                          Nothing here yet{canConverse && conversationTab === 'all' ? ' — start the conversation below.' : '.'}
                          {' '}System events live under the History tab.
                        </div>
                      ) : (
                        <div className="rounded-2xl border border-slate-200/70 bg-gradient-to-b from-slate-100/90 via-indigo-50/40 to-blue-50/40 p-3 sm:p-4">
                          <ul className="space-y-5">
                            {visibleTimeline.map((item, idx) => (
                              <li key={`wrap-${item.e.id}`} className="list-none">
                                {folded && idx === 1 && (
                                  <div className="relative flex items-center justify-center py-1.5 mb-3.5" role="separator">
                                    <span aria-hidden="true" className="absolute inset-x-2 top-1/2 border-t border-dashed border-slate-300" />
                                    <button
                                      onClick={() => setShowFolded(true)}
                                      className="tp-focus-ring relative inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white border border-slate-300 text-xs font-semibold text-slate-500 hover:text-blue-700 hover:border-blue-300 shadow-subtle"
                                    >
                                      <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                                      Show {foldedCount} earlier message{foldedCount === 1 ? '' : 's'}
                                    </button>
                                  </div>
                                )}
                                <ul>
                                  <ThreadEntry
                                    entry={item.e}
                                    attachments={attachmentsByEntry.get(item.e.id) || []}
                                    onDownload={downloadAttachment}
                                    onPreview={previewImage}
                                    onImageRef={previewImageRef}
                                    photoFor={photoFor}
                                    onCopy={copyText}
                                    canDelete={isAdmin && ticket?.origin === 'ticketpulse'}
                                    onDelete={deleteNote}
                                    deleting={deletingNoteId === item.e.id}
                                  />
                                </ul>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </section>

                    {/* AI proposed reply (draft→approve) — staged by a workflow */}
                    {canConverse && (
                      <ProposedReplyCard
                        ticketId={ticketId}
                        refreshToken={ticket?.updatedAt}
                        canWrite={canConverse}
                        onSent={() => { lastLocalMutationRef.current = Date.now(); fetchTicket({ silent: true }); showToast('emerald', 'Reply sent'); }}
                        onEditInComposer={(proposal) => {
                          const html = proposal.bodyHtml || String(proposal.bodyText || '').replace(/\n/g, '<br>');
                          switchComposerMode('reply');
                          setComposerBody(html);
                          setComposerText(htmlToText(html));
                          setTimeout(() => composerRef.current?.focus(), 0);
                        }}
                      />
                    )}

                    {/* Composer */}
                    {canConverse ? (
                      <section className="tp-card rounded-xl p-3.5 print-hide" aria-label="Reply composer">
                        {/* QA 07-06 #10: wraps + compact labels under sm so nothing
                            (Templates, Quick notes) ever exceeds a phone viewport. */}
                        <div role="group" aria-label="Composer mode" className="flex flex-wrap items-center gap-1.5 mb-2.5">
                          <button
                            onClick={() => switchComposerMode('reply')}
                            aria-pressed={composerMode === 'reply'}
                            className={`tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                              composerMode === 'reply' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'
                            }`}
                          >
                            <Mail className="w-3.5 h-3.5" aria-hidden="true" /> Reply<span className="hidden sm:inline">&nbsp;to requester</span>
                          </button>
                          <button
                            onClick={() => switchComposerMode('note')}
                            aria-pressed={composerMode === 'note'}
                            className={`tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                              composerMode === 'note' ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-slate-600 border-slate-200 hover:border-amber-300'
                            }`}
                          >
                            <StickyNote className="w-3.5 h-3.5" aria-hidden="true" /> <span className="sm:hidden">Note</span><span className="hidden sm:inline">Internal note</span>
                          </button>
                          <button
                            onClick={() => switchComposerMode('forward')}
                            aria-pressed={composerMode === 'forward'}
                            className={`tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                              composerMode === 'forward' ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-slate-600 border-slate-200 hover:border-violet-300'
                            }`}
                          >
                            <Forward className="w-3.5 h-3.5" aria-hidden="true" /> Forward
                          </button>

                          {composerMode === 'note' && visibleQuickNotes.length > 0 && (
                            <span ref={quickNotesRef} className="relative ml-auto">
                              <button
                                onClick={() => setQuickNotesOpen((v) => !v)}
                                aria-expanded={quickNotesOpen}
                                className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 hover:border-amber-400"
                              >
                                <StickyNote className="w-3.5 h-3.5" aria-hidden="true" />
                                <span className="hidden sm:inline">Quick notes&nbsp;</span>({visibleQuickNotes.length})
                              </button>
                              {quickNotesOpen && (
                                <span className="absolute right-0 top-full mt-1 z-30 w-72 max-w-[calc(100vw-2.5rem)] tp-card rounded-lg shadow-soft p-1.5 flex flex-col animate-scaleIn">
                                  <span className="max-h-52 overflow-y-auto settings-scrollbar flex flex-col">
                                    {visibleQuickNotes.map((note) => (
                                      <button
                                        key={note.id}
                                        onClick={() => insertQuickNote(note)}
                                        className="tp-focus-ring text-left px-2 py-1.5 text-sm rounded-md text-slate-700 hover:bg-amber-50"
                                        title={note.bodyText.slice(0, 200)}
                                      >
                                        <span className="block truncate">{note.name}</span>
                                        <span className="block text-[10px] text-slate-400 truncate">{note.bodyText.slice(0, 60)}</span>
                                      </button>
                                    ))}
                                  </span>
                                  <span className="px-2 pt-1.5 mt-1 border-t border-slate-100 text-[10px] text-slate-400">Admins manage these under Settings → Ticket Ops.</span>
                                </span>
                              )}
                            </span>
                          )}

                          {/* Reply templates are requester-facing content — internal
                              notes get Quick notes only (QA 07-07 #2). */}
                          {composerMode !== 'note' && (
                            <span ref={templatesRef} className="relative ml-auto">
                              <button
                                onClick={() => setTemplatesOpen((v) => !v)}
                                aria-expanded={templatesOpen}
                                className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-500 bg-white border border-slate-200 hover:border-blue-300 hover:text-blue-700"
                              >
                                <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                                <span className="hidden sm:inline">Templates{templates.length > 0 ? ` (${templates.length})` : ''}</span>
                                <span className="sm:hidden">{templates.length > 0 ? `(${templates.length})` : 'Tpl'}</span>
                              </button>
                              {templatesOpen && (
                                <span className="absolute right-0 top-full mt-1 z-30 w-72 max-w-[calc(100vw-2.5rem)] tp-card rounded-lg shadow-soft p-1.5 flex flex-col animate-scaleIn">
                                  {templates.length === 0 && (
                                    <span className="px-2 py-1.5 text-xs text-slate-400">No templates yet — write a reply below, then save it here.</span>
                                  )}
                                  <span className="max-h-52 overflow-y-auto settings-scrollbar flex flex-col">
                                    {templates.map((template) => (
                                      <span key={template.id} className="flex items-center gap-1 group">
                                        <button
                                          onClick={() => insertTemplate(template)}
                                          className="tp-focus-ring flex-1 min-w-0 text-left px-2 py-1.5 text-sm rounded-md text-slate-700 hover:bg-blue-50"
                                          title={template.bodyText.slice(0, 200)}
                                        >
                                          <span className="block truncate">{template.name}</span>
                                          <span className="block text-[10px] text-slate-400 truncate">{template.bodyText.slice(0, 60)}</span>
                                        </button>
                                        <button
                                          onClick={() => removeTemplate(template)}
                                          aria-label={`Delete template ${template.name}`}
                                          className="tp-focus-ring p-1 rounded text-slate-300 hover:text-red-600 hover:bg-red-50"
                                        >
                                          <Trash2 className="w-3 h-3" aria-hidden="true" />
                                        </button>
                                      </span>
                                    ))}
                                  </span>
                                  <span className="flex items-center gap-1.5 border-t border-slate-100 mt-1 pt-1.5 px-1">
                                    <input
                                      type="text"
                                      value={templateName}
                                      onChange={(e) => setTemplateName(e.target.value)}
                                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveTemplate(); } }}
                                      placeholder="Save current draft as…"
                                      aria-label="New template name"
                                      className="tp-focus-ring flex-1 min-w-0 text-xs bg-white border border-input rounded-md px-2 py-1.5 placeholder:text-slate-400"
                                    />
                                    <button
                                      onClick={saveTemplate}
                                      disabled={!templateName.trim() || !composerText.trim()}
                                      className="tp-focus-ring px-2 py-1.5 text-xs font-semibold rounded-md bg-primary text-primary-foreground hover:bg-blue-700 disabled:opacity-40"
                                    >
                                Save
                                    </button>
                                  </span>
                                </span>
                              )}
                            </span>
                          )}

                          {composerMode === 'reply' && (
                            <span className="text-[11px] text-slate-400 truncate">
                              {isNative
                                ? (ticket.requester?.email ? `emails ${ticket.requester.email}` : '')
                                : 'sent via FreshService (emails the requester)'}
                            </span>
                          )}
                        </div>
                        {composerMode === 'reply' && (
                          <div className="mb-2">
                            <CcChips value={composerCc} onChange={setComposerCc} />
                          </div>
                        )}
                        {composerMode === 'forward' && (
                          <div className="mb-2">
                            <CcChips value={forwardTo} onChange={setForwardTo} placeholder="Forward to…" label="Forward recipients" />
                            <p className="mt-1 text-[10px] text-slate-400">
                          Sends the description + the last public replies from the workspace mailbox; recorded on the ticket as a private entry.
                            </p>
                          </div>
                        )}
                        <RichTextEditor
                          ref={composerRef}
                          value={composerBody}
                          onChange={({ html, text }) => { setComposerBody(html); setComposerText(text); }}
                          onSubmit={sendComposer}
                          placeholder={composerMode === 'reply'
                            ? 'Write a reply to the requester… (Ctrl+Enter to send)'
                            : composerMode === 'forward'
                              ? 'Optional note to include above the forwarded thread…'
                              : 'Add context for the team (never emailed)…'}
                          ariaLabel={composerMode === 'reply' ? 'Reply body' : composerMode === 'forward' ? 'Forward note' : 'Internal note body'}
                          className={composerMode === 'note' ? 'bg-amber-50/25 border-amber-200' : composerMode === 'forward' ? 'bg-violet-50/30 border-violet-200' : 'bg-white border-slate-300'}
                          onImagePaste={composerMode === 'forward' ? undefined : (file) => {
                            const ext = ((file.type || 'image/png').split('/')[1] || 'png').replace('jpeg', 'jpg');
                            const name = `pasted-image-${++pasteCountRef.current}.${ext}`;
                            addComposerFiles([new File([file], name, { type: file.type || 'image/png' })]);
                            return name;
                          }}
                        />
                        {composerFiles.length > 0 && (
                          <ul className="mt-2 flex flex-wrap gap-2 items-start" aria-label="Files to attach">
                            {composerFiles.map((file) => (
                              <StagedFileChip
                                key={`${file.name}-${file.size}`}
                                file={file}
                                storedOnly={file.size > 3 * 1024 * 1024 && composerMode === 'reply'}
                                onRemove={() => setComposerFiles((prev) => prev.filter((f) => f !== file))}
                                onEdit={() => setEditFile(file)}
                              />
                            ))}
                          </ul>
                        )}
                        <div className="flex items-center justify-between mt-2 gap-2">
                          <span className="flex items-center gap-2 min-w-0">
                            {composerMode !== 'forward' && (
                              <>
                                <input
                                  ref={composerFileInputRef}
                                  type="file"
                                  multiple
                                  className="hidden"
                                  onChange={(e) => { addComposerFiles(e.target.files); e.target.value = ''; }}
                                />
                                <button
                                  onClick={() => composerFileInputRef.current?.click()}
                                  disabled={composerFiles.length >= 5}
                                  className="tp-focus-ring inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-500 bg-white border border-slate-200 rounded-lg hover:border-blue-300 hover:text-blue-700 disabled:opacity-50"
                                  title="Attach files (up to 5 · 100 MB each; ≤3 MB files are emailed with the reply)"
                                >
                                  <Paperclip className="w-3.5 h-3.5" aria-hidden="true" />
                              Attach
                                </button>
                              </>
                            )}
                            {composerText.trim() && (
                              <span className="text-[10px] text-slate-300 truncate" title="Drafts are kept per ticket until sent">draft saved</span>
                            )}
                          </span>
                          <button
                            onClick={sendComposer}
                            disabled={isSending || (composerMode === 'forward' ? forwardTo.length === 0 : !composerText.trim())}
                            className={`tp-focus-ring inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg shadow-subtle transition-colors disabled:opacity-50 ${
                              composerMode === 'reply' ? 'bg-primary text-primary-foreground hover:bg-blue-700'
                                : composerMode === 'forward' ? 'bg-violet-600 text-white hover:bg-violet-700'
                                  : 'bg-amber-500 text-white hover:bg-amber-600'
                            }`}
                          >
                            {isSending ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Send className="w-4 h-4" aria-hidden="true" />}
                            {composerMode === 'reply' ? 'Send reply' : composerMode === 'forward' ? 'Forward thread' : 'Add note'}
                          </button>
                        </div>
                      </section>
                    ) : isNative ? (
                      <div className="tp-surface rounded-xl p-4 text-center text-sm text-slate-500">
                    Native ticketing is disabled for this workspace, so the conversation is read-only.
                      </div>
                    ) : null}
                  </>
                )}

                {pageTab === 'approvals' && (
                  <section className="tp-card rounded-xl p-4 sm:p-5" aria-label="Approvals">
                    <div className="flex items-center gap-2 mb-3">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" aria-hidden="true" />
                      <h2 className="text-sm font-bold text-slate-800">Approvals</h2>
                    </div>

                    {(ticket.approvals?.length || 0) === 0 && (
                      <p className="text-sm text-slate-400 mb-4">
                        No approvals yet. Request one below — the approver decides in-app or through a personal magic link.
                      </p>
                    )}
                    {(ticket.approvals?.length || 0) > 0 && (
                      <ApprovalTimeline
                        approvals={ticket.approvals}
                        meta={meta}
                        savingField={savingField}
                        clarifyingId={clarifyingId}
                        setClarifyingId={setClarifyingId}
                        clarifyNote={clarifyNote}
                        setClarifyNote={setClarifyNote}
                        onDecide={(apId, decision) => applyChange(`approval-${apId}`, () => ticketsAPI.decideApproval(ticketId, apId, decision))}
                        onClarify={(apId, note) => applyChange(`approval-${apId}`, async () => { await ticketsAPI.clarifyApproval(ticketId, apId, note); setClarifyingId(null); setClarifyNote(''); })}
                        onResubmit={(apId) => applyChange(`approval-${apId}`, () => ticketsAPI.resubmitApproval(ticketId, apId))}
                        onCancel={(apId) => applyChange(`approval-${apId}`, () => ticketsAPI.cancelApproval(ticketId, apId))}
                        onChangeDecision={(target) => { setChangeNote(''); setChangeApprovalTarget(target); }}
                        onDeleteRequest={(group) => setDeleteApprovalTarget(group)}
                      />
                    )}

                    {/* Request approval — prominent button opens the guided modal */}
                    {(meta?.approvalCategories?.filter((c) => (c.managerCount || 0) > 0).length || 0) > 0 ? (
                      <button
                        type="button"
                        onClick={() => setRequestApprovalOpen(true)}
                        className="tp-focus-ring inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-blue-700 shadow-subtle"
                      >
                        <Stamp className="w-4 h-4" aria-hidden="true" />
                        Request approval
                      </button>
                    ) : (
                      <p className="text-sm text-slate-400">
                        No approval categories are set up yet. An admin can add them under <span className="font-medium">Settings → Approval Categories</span>.
                      </p>
                    )}
                  </section>
                )}

                {pageTab === 'ai' && (
                  <TicketAiTab
                    ticket={ticket}
                    technicians={meta?.technicians || []}
                    canReview={wsRole === 'admin' || wsRole === 'reviewer'}
                  />
                )}

                {pageTab === 'history' && (
                  <section className="tp-card rounded-xl p-4 sm:p-5" aria-label="Ticket history">
                    <div className="flex items-center gap-2 mb-4">
                      <History className="w-4 h-4 text-blue-500" aria-hidden="true" />
                      <h2 className="text-sm font-bold text-slate-800">Everything that happened on this ticket</h2>
                    </div>
                    {historyItems.length === 0 ? (
                      <p className="text-sm text-slate-400">No recorded events yet.</p>
                    ) : (
                      <ol>
                        {historyItems.map((item, i) => (
                          <HistoryEvent
                            key={item.key}
                            icon={item.icon}
                            tone={item.tone}
                            title={item.title}
                            meta={item.meta}
                            at={item.at}
                            isLast={i === historyItems.length - 1}
                          />
                        ))}
                      </ol>
                    )}
                  </section>
                )}
              </div>

              {/* Sidebar */}
              <aside className="space-y-4" aria-label="Ticket properties">
                {/* Status & SLA */}
                <div className="tp-card rounded-xl p-4 space-y-3.5">
                  <SidebarField label="Status" flash={Boolean(liveChanges.status)} onAck={() => ackChange('status')}>
                    <select
                      value={ticket.status}
                      disabled={(!canWrite && !fsEditable) || savingField === 'status'}
                      onChange={(e) => {
                        const next = e.target.value;
                        const prev = ticket.status;
                        if (canWrite) {
                          applyChange('status', () => ticketsAPI.setStatus(ticketId, next), {
                            label: `Status → ${next}`,
                            undo: () => ticketsAPI.setStatus(ticketId, prev),
                          });
                        } else requestFsSync([{ field: 'Status', from: ticket.status, to: next }], { status: next }).catch(() => {});
                      }}
                      className={fieldClass}
                      aria-label="Ticket status"
                    >
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                      {!STATUSES.includes(ticket.status) && <option value={ticket.status}>{ticket.status}</option>}
                    </select>
                  </SidebarField>

                  <SidebarField label="Priority" flash={Boolean(liveChanges.priority)} onAck={() => ackChange('priority')}>
                    <select
                      value={ticket.priority}
                      disabled={(!canWrite && !fsEditable) || savingField === 'priority'}
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        const prev = ticket.priority;
                        if (canWrite) {
                          applyChange('priority', () => ticketsAPI.update(ticketId, { priority: next }), {
                            label: `Priority → ${PRIORITY_LABELS[next]}`,
                            undo: () => ticketsAPI.update(ticketId, { priority: prev }),
                          });
                        } else requestFsSync([{ field: 'Priority', from: PRIORITY_LABELS[ticket.priority], to: PRIORITY_LABELS[next] }], { priority: next }).catch(() => {});
                      }}
                      className={fieldClass}
                      aria-label="Ticket priority"
                    >
                      {[1, 2, 3, 4].map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
                    </select>
                  </SidebarField>

                  {/* Impact / urgency (gap plan P2.5) — optional ITSM nuance, TP-born editable */}
                  {(canWrite || ticket.impact || ticket.urgency) && (
                    <div className="grid grid-cols-2 gap-2">
                      {[['impact', 'Impact'], ['urgency', 'Urgency']].map(([field, label]) => (
                        <SidebarField key={field} label={label}>
                          <select
                            value={ticket[field] ?? ''}
                            disabled={!canWrite || savingField === field}
                            onChange={(e) => {
                              const next = e.target.value ? Number(e.target.value) : null;
                              const prev = ticket[field] ?? null;
                              applyChange(field, () => ticketsAPI.update(ticketId, { [field]: next }), {
                                label: `${label} → ${next ? ['Low', 'Medium', 'High'][next - 1] : '—'}`,
                                undo: () => ticketsAPI.update(ticketId, { [field]: prev }),
                              });
                            }}
                            className={fieldClass}
                            aria-label={`Ticket ${field}`}
                          >
                            <option value="">—</option>
                            {[1, 2, 3].map((v) => <option key={v} value={v}>{['Low', 'Medium', 'High'][v - 1]}</option>)}
                          </select>
                        </SidebarField>
                      ))}
                    </div>
                  )}

                  {(ticket.frDueBy || ticket.dueBy) && !['Deleted', 'Spam'].includes(ticket.status) && (
                    <div className="pt-1 border-t border-slate-100 space-y-2">
                      {ticket.frDueBy && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-slate-500 font-medium">First response</span>
                          <span className="ml-auto text-slate-400">{new Date(ticket.frDueBy).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                          {ticket.firstPublicAgentReplyAt
                            ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200">Responded</span>
                            : <SlaChip value={ticket.frDueBy} />}
                        </div>
                      )}
                      {ticket.dueBy && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-slate-500 font-medium">Resolution</span>
                          <span className="ml-auto text-slate-400">{new Date(ticket.dueBy).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                          {['Resolved', 'Closed'].includes(ticket.status)
                            ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200">Done</span>
                            : <SlaChip value={ticket.dueBy} />}
                        </div>
                      )}
                    </div>
                  )}

                  <SidebarField label="Assignee" flash={Boolean(liveChanges.assignedTechId)} onAck={() => ackChange('assignedTechId')}>
                    {(canWrite || fsEditable) ? (
                      <AssigneePicker
                        ticketId={ticketId}
                        value={ticket.assignedTechId}
                        currentTech={ticket.assignedTech}
                        technicians={meta?.technicians || []}
                        ticketOrigin={ticket.origin}
                        assignFn={fsEditable ? fsAssign : undefined}
                        showAi={canReview}
                        aiSuggestion={canReview ? aiSuggestionForPicker : null}
                        onAiAssign={canReview ? () => setAiModalOpen(true) : null}
                        onAssigned={() => {
                          lastLocalMutationRef.current = Date.now();
                          fetchTicket({ silent: true });
                          if (!fsEditable) showToast('emerald', 'Saved');
                        }}
                      />
                    ) : (
                      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-100">
                        <PersonAvatar name={ticket.assignedTech?.name} photoUrl={ticket.assignedTech?.photoUrl} size="h-7 w-7" />
                        <span className="text-sm text-slate-600 truncate">{ticket.assignedTech?.name || 'Unassigned'}</span>
                      </div>
                    )}
                  </SidebarField>

                  <SidebarField label="Type" flash={Boolean(liveChanges.ticketType)} onAck={() => ackChange('ticketType')}>
                    <select
                      value={ticket.ticketType || ''}
                      disabled={!canWrite || savingField === 'type'}
                      onChange={(e) => applyChange('type', () => ticketsAPI.update(ticketId, { ticketType: e.target.value || null }))}
                      className={fieldClass}
                      aria-label="Ticket type"
                    >
                      <option value="">—</option>
                      {TICKET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      {ticket.ticketType && !TICKET_TYPES.includes(ticket.ticketType) && (
                        <option value={ticket.ticketType}>{ticket.ticketType}</option>
                      )}
                    </select>
                  </SidebarField>

                  <SidebarField
                    label="Category"
                    flash={Boolean(liveChanges.internalCategoryId || liveChanges.internalSubcategoryId)}
                    onAck={() => { ackChange('internalCategoryId'); ackChange('internalSubcategoryId'); }}
                  >
                    {(canWrite || fsEditable) ? (
                      <>
                        <select
                          value={effectiveCategoryId || ''}
                          disabled={savingField === 'category'}
                          onChange={(e) => {
                            const nextId = e.target.value ? Number(e.target.value) : null;
                            const prevCat = ticket.internalCategoryId ?? null;
                            const prevSub = ticket.internalSubcategoryId ?? null;
                            if (canWrite) {
                              applyChange('category', () => ticketsAPI.update(ticketId, {
                                internalCategoryId: nextId,
                                internalSubcategoryId: null,
                              }), {
                                label: 'Category updated',
                                undo: () => ticketsAPI.update(ticketId, { internalCategoryId: prevCat, internalSubcategoryId: prevSub }),
                              });
                            } else {
                              const nextName = (meta?.categoryTree || []).find((c) => c.id === nextId)?.name || 'Uncategorized';
                              requestFsSync(
                                [{ field: 'Category', from: ticketCategoryLabels(ticket).category || 'Uncategorized', to: nextName }],
                                { internalCategoryId: nextId, internalSubcategoryId: null },
                              ).catch(() => {});
                            }
                          }}
                          className={fieldClass}
                          aria-label="Category"
                        >
                          <option value="">Uncategorized</option>
                          {scopedCategoryTree.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        {subcategories.length > 0 && (
                          <select
                            value={effectiveSubcategoryId || ''}
                            disabled={savingField === 'subcategory'}
                            onChange={(e) => {
                              const nextId = e.target.value ? Number(e.target.value) : null;
                              if (canWrite) {
                                applyChange('subcategory', () => ticketsAPI.update(ticketId, { internalSubcategoryId: nextId }));
                              } else {
                                const nextName = subcategories.find((s) => s.id === nextId)?.name || 'None';
                                requestFsSync(
                                  [{ field: 'Subcategory', from: ticketCategoryLabels(ticket).subcategory || 'None', to: nextName }],
                                  { internalCategoryId: effectiveCategoryId || null, internalSubcategoryId: nextId },
                                ).catch(() => {});
                              }
                            }}
                            className={`${fieldClass} mt-1.5`}
                            aria-label="Subcategory"
                          >
                            <option value="">No subcategory</option>
                            {subcategories.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                        )}
                        {fsEditable && (
                          <p className="mt-1 text-[10px] text-slate-400">Edits sync to FreshService with confirmation.</p>
                        )}
                      </>
                    ) : (
                      (() => {
                        const { category: catLabel, subcategory: subLabel } = ticketCategoryLabels(ticket);
                        return (
                          <div className="px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-100 text-sm min-w-0">
                            <span className="block text-slate-700 truncate" title={catLabel || undefined}>{catLabel || 'Uncategorized'}</span>
                            {subLabel && <span className="block text-xs text-slate-400 truncate" title={subLabel}>{subLabel}</span>}
                          </div>
                        );
                      })()
                    )}
                  </SidebarField>

                  {(meta?.groups?.length || 0) > 0 && (
                    <SidebarField label="Group" flash={Boolean(liveChanges.groupId)} onAck={() => ackChange('groupId')}>
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

                  {/* Tags — TP-side layer, editable on BOTH origins */}
                  <TicketTagEditor
                    ticketId={ticketId}
                    tags={ticket.tags || []}
                    allTags={meta?.tags || []}
                    canEdit={canConverse}
                    isAdmin={isAdmin}
                    onChanged={() => { lastLocalMutationRef.current = Date.now(); fetchTicket({ silent: true }); }}
                  />

                  {/* Watchers are per category/group scopes, never per ticket */}
                  {(ticket.internalCategoryId || ticket.groupId) && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      {ticket.internalCategoryId && (
                        <button
                          onClick={() => toggleWatch('category')}
                          disabled={savingField === 'watch-category'}
                          title="Email me when tickets are created (or requesters reply) in this category"
                          className={`tp-focus-ring inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded-lg border transition-colors ${
                            watchingCategory
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300 hover:text-blue-700'
                          }`}
                        >
                          {watchingCategory ? <BellRing className="w-3 h-3" aria-hidden="true" /> : <Bell className="w-3 h-3" aria-hidden="true" />}
                          {watchingCategory ? 'Watching category' : 'Watch category'}
                        </button>
                      )}
                      {ticket.groupId && (meta?.groups?.length || 0) > 0 && (
                        <button
                          onClick={() => toggleWatch('group')}
                          disabled={savingField === 'watch-group'}
                          title="Email me when tickets are created (or requesters reply) in this group"
                          className={`tp-focus-ring inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded-lg border transition-colors ${
                            watchingGroup
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300 hover:text-blue-700'
                          }`}
                        >
                          {watchingGroup ? <BellRing className="w-3 h-3" aria-hidden="true" /> : <Bell className="w-3 h-3" aria-hidden="true" />}
                          {watchingGroup ? 'Watching group' : 'Watch group'}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Explicit ticket links (duplicate/related/parent) + merge */}
                <TicketLinksCard
                  ticketId={ticketId}
                  canWrite={canConverse}
                  canMerge={meta?.actor?.kind !== 'agent'}
                  onMerged={() => { lastLocalMutationRef.current = Date.now(); fetchTicket({ silent: true }); showToast('emerald', 'Ticket merged — the conversation continues on the target'); }}
                  refreshToken={ticket?.updatedAt}
                  onNavigate={(id) => navigate(`/tickets/${id}`)}
                />

                {/* Per-workspace custom fields (TP annotation layer, both origins) */}
                <CustomFieldsCard
                  ticketId={ticketId}
                  values={ticket?.customFields || {}}
                  canWrite={canConverse}
                  onSaved={() => { lastLocalMutationRef.current = Date.now(); fetchTicket({ silent: true }); showToast('emerald', 'Custom fields saved'); }}
                />

                {/* Related tickets: facts first, suggestions clearly labeled */}
                {related && (related.sameRequester.length > 0 || (related.nearDuplicates.length > 0 && !dupeDismissed) || (related.similarByContent?.length > 0)) && (
                  <div className="tp-card rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-2.5">
                      <History className="w-4 h-4 text-blue-500" aria-hidden="true" />
                      <h2 className="text-sm font-bold text-slate-800">Related</h2>
                    </div>
                    {related.sameRequester.length > 0 && (
                      <>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
                          Other tickets from this requester
                        </p>
                        <ul className="space-y-1 mb-2.5">
                          {related.sameRequester.map((r) => (
                            <li key={r.id}>
                              <Link
                                to={`/tickets/${r.id}`}
                                className="tp-focus-ring flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-blue-50/60 border border-transparent hover:border-blue-100"
                              >
                                <span className="font-mono text-[10px] font-semibold text-slate-400 whitespace-nowrap">{r.displayRef}</span>
                                <span className="min-w-0 flex-1 text-xs text-slate-700 truncate">{r.subject || '(no subject)'}</span>
                                <StatusPill status={r.status} className="!text-[9px] !px-1.5" />
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {related.nearDuplicates.length > 0 && !dupeDismissed && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-2">
                        <div className="flex items-center gap-1.5 mb-1">
                          <Sparkles className="w-3 h-3 text-amber-500" aria-hidden="true" />
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                            Suggestion — same subject within 7 days
                          </span>
                          <button
                            onClick={dismissDupes}
                            aria-label="Dismiss duplicate suggestion"
                            className="tp-focus-ring ml-auto p-0.5 rounded text-amber-400 hover:text-amber-700"
                          >
                            <X className="w-3 h-3" aria-hidden="true" />
                          </button>
                        </div>
                        <ul className="space-y-1">
                          {related.nearDuplicates.map((r) => (
                            <li key={r.id}>
                              <Link
                                to={`/tickets/${r.id}`}
                                className="tp-focus-ring flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-amber-100/70"
                              >
                                <span className="font-mono text-[10px] font-semibold text-amber-600 whitespace-nowrap">{r.displayRef}</span>
                                <span className="min-w-0 flex-1 text-xs text-slate-700 truncate">{r.subject || '(no subject)'}</span>
                                <span className="text-[10px] text-slate-400 whitespace-nowrap">{timeAgo(r.createdAt)}</span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-1 text-[10px] text-amber-600/80">Might be unrelated — treat as a hint, not a fact.</p>
                      </div>
                    )}
                    {related.similarByContent?.length > 0 && (
                      <div className={`rounded-lg border border-violet-200 bg-violet-50/50 p-2 ${related.nearDuplicates.length > 0 && !dupeDismissed ? 'mt-2' : ''}`}>
                        <div className="flex items-center gap-1.5 mb-1">
                          <Sparkles className="w-3 h-3 text-violet-500" aria-hidden="true" />
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-700">
                            AI suggestion — similar by content
                          </span>
                        </div>
                        <ul className="space-y-1">
                          {related.similarByContent.map((r) => (
                            <li key={r.id}>
                              <Link
                                to={`/tickets/${r.id}`}
                                className="tp-focus-ring flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-violet-100/70"
                              >
                                <span className="font-mono text-[10px] font-semibold text-violet-600 whitespace-nowrap">{r.displayRef}</span>
                                <span className="min-w-0 flex-1 text-xs text-slate-700 truncate">{r.subject || '(no subject)'}</span>
                                <span
                                  className="text-[10px] font-semibold text-violet-500 whitespace-nowrap"
                                  title="Content similarity (cosine over text embeddings)"
                                >
                                  {Math.round((r.similarity || 0) * 100)}%
                                </span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-1 text-[10px] text-violet-600/80">Matched on wording, not history — verify before acting.</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Attachments */}
                <div className="tp-card rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2.5">
                    <Paperclip className="w-4 h-4 text-blue-500" aria-hidden="true" />
                    <h2 className="text-sm font-bold text-slate-800">Attachments</h2>
                    <span className="text-xs text-slate-400">({ticket.attachments?.length || 0})</span>
                    {canWrite && (
                      <>
                        <input
                          ref={attachmentInputRef}
                          type="file"
                          multiple
                          onChange={(e) => { uploadAttachments(e.target.files); e.target.value = ''; }}
                          className="sr-only"
                          aria-label="Upload attachments"
                        />
                        <button
                          onClick={() => attachmentInputRef.current?.click()}
                          disabled={savingField === 'attachments'}
                          className="tp-focus-ring ml-auto inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50"
                        >
                          {savingField === 'attachments' ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Paperclip className="w-3 h-3" aria-hidden="true" />}
                          {uploadProgress ? `${uploadProgress.pct}%` : 'Add'}
                        </button>
                      </>
                    )}
                  </div>
                  {uploadProgress && (
                    <div className="mb-2 rounded-lg border border-blue-100 bg-blue-50/60 px-2.5 py-2">
                      <div className="flex items-center justify-between text-[11px] mb-1">
                        <span className="text-slate-600 truncate mr-2">
                          {uploadProgress.pct < 100 ? 'Uploading' : 'Processing'} {uploadProgress.name}
                        </span>
                        <span className="font-semibold text-blue-700 tabular-nums flex-shrink-0">{uploadProgress.pct}%</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-blue-100 overflow-hidden">
                        <div
                          className="h-full bg-blue-600 rounded-full transition-[width] duration-150"
                          style={{ width: `${uploadProgress.pct}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {(ticket.attachments?.length || 0) === 0 ? (
                    <p className="text-xs text-slate-400">No files attached{canWrite ? ' — drop something in with Add.' : '.'}</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {ticket.attachments.map((a) => (
                        <li key={a.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-slate-100 bg-slate-50/60">
                          {isImageAttachment(a)
                            ? <ImageIcon className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" aria-hidden="true" />
                            : <Paperclip className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" aria-hidden="true" />}
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-slate-700 truncate">{a.fileName}</p>
                            <p className="text-[10px] text-slate-400 truncate">
                              {formatBytes(a.sizeBytes)}
                              {a.source === 'email' ? ' · from email' : a.uploadedBy ? ` · ${a.uploadedBy}` : ''}
                            </p>
                          </div>
                          {isImageAttachment(a) && (
                            <button
                              onClick={() => previewImage(a)}
                              aria-label={`Preview ${a.fileName}`}
                              className="tp-focus-ring p-1 text-slate-400 hover:text-blue-700 hover:bg-blue-50 rounded"
                            >
                              <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                          )}
                          <button
                            onClick={() => downloadAttachment(a)}
                            aria-label={`Download ${a.fileName}`}
                            className="tp-focus-ring p-1 text-slate-400 hover:text-blue-700 hover:bg-blue-50 rounded"
                          >
                            <Download className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          {canWrite && (meta?.actor?.email === a.uploadedBy || meta?.actor?.kind === 'admin' || meta?.actor?.workspaceRole === 'admin') && (
                            <button
                              onClick={() => applyChange(`attach-del-${a.id}`, () => ticketsAPI.removeAttachment(ticketId, a.id))}
                              disabled={savingField === `attach-del-${a.id}`}
                              aria-label={`Remove ${a.fileName}`}
                              className="tp-focus-ring p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                            >
                              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* AI triage — reviewer/admin only (endpoints are reviewer-gated) */}
                {canReview && (
                  <div className="tp-card rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-2.5">
                      <Sparkles className="w-4 h-4 text-indigo-500" aria-hidden="true" />
                      <h2 className="text-sm font-bold text-slate-800">AI runs</h2>
                      {pipelineRuns.length > 0 && <span className="text-xs text-slate-400">({pipelineRuns.length})</span>}
                      <button
                        onClick={() => setAiModalOpen(true)}
                        className="tp-focus-ring ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-indigo-200 bg-indigo-50/70 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100"
                        title="Run the assignment pipeline and watch it live"
                      >
                        <Sparkles className="w-3 h-3" aria-hidden="true" />
                        {pipelineRuns.length > 0 ? 'Run again' : 'Run AI'}
                      </button>
                    </div>

                    {/* Pending recommendation — approve without leaving the ticket */}
                    {aiPendingRun && aiRecs.length > 0 && (
                      <div className={`mb-3 rounded-lg border p-3 ${alreadyAssigned ? 'border-amber-200 bg-amber-50/60' : 'border-indigo-200 bg-gradient-to-br from-indigo-50 to-violet-50/50'}`}>
                        <p className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider mb-2 ${alreadyAssigned ? 'text-amber-600' : 'text-indigo-500'}`}>
                          <Sparkles className="w-3 h-3" aria-hidden="true" /> {alreadyAssigned ? 'AI suggestion (already assigned)' : 'Awaiting your review'}
                        </p>
                        {alreadyAssigned && (
                          <p className="mb-2 text-[11px] text-amber-700 leading-relaxed">
                            Already assigned{assigneeName ? ` to ${assigneeName}` : ''} — handled outside this run. Approving reassigns the ticket.
                          </p>
                        )}
                        <div className="flex items-center gap-2.5 min-w-0">
                          <PersonAvatar
                            name={aiRecs[0].techName || '?'}
                            photoUrl={(meta?.technicians || []).find((t) => t.id === aiRecs[0].techId)?.photoUrl}
                            size="h-9 w-9"
                            textSize="text-[11px]"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-slate-800 truncate">{aiRecs[0].techName || 'Unknown'}</span>
                            {typeof aiRecs[0].score === 'number' && (
                              <span className="block text-[11px] text-indigo-500 font-medium">{Math.round(aiRecs[0].score * 100)}% match</span>
                            )}
                          </span>
                        </div>
                        {aiRecs[0].reasoning && (
                          <p className="mt-1.5 text-[11px] text-slate-500 leading-relaxed line-clamp-3">{aiRecs[0].reasoning}</p>
                        )}
                        {aiRecs.length > 1 && (
                          <p className="mt-1.5 text-[10px] text-slate-400 truncate">
                          Also considered: {aiRecs.slice(1).map((r) => r.techName).filter(Boolean).join(', ')}
                          </p>
                        )}
                        <div className="mt-2.5 flex items-center gap-1.5">
                          <button
                            onClick={approveAiRun}
                            disabled={aiDeciding}
                            title={aiIsReassign ? `Already assigned to ${assigneeName} — this reassigns to ${aiRecs[0].techName}.` : undefined}
                            className={`tp-focus-ring flex-1 px-2.5 py-1.5 rounded-lg text-white text-xs font-semibold disabled:opacity-60 ${aiIsReassign ? 'bg-amber-500 hover:bg-amber-600' : 'bg-indigo-600 hover:bg-indigo-700'}`}
                          >
                            {aiDeciding ? 'Approving…' : `${aiIsReassign ? 'Reassign' : 'Approve'} — ${(aiRecs[0].techName || '').split(' ')[0] || 'assign'}`}
                          </button>
                          <button
                            onClick={() => setAiModalOpen(true)}
                            className="tp-focus-ring px-2.5 py-1.5 rounded-lg border border-indigo-200 text-indigo-700 text-xs font-medium hover:bg-indigo-100/60"
                            title="See reasoning, pick another technician, or reject"
                          >
                          Review…
                          </button>
                        </div>
                      </div>
                    )}

                    {pipelineRuns.length === 0 ? (
                      <p className="text-sm text-slate-400">No pipeline run yet for this ticket.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {pipelineRuns.map((r) => (
                          <li key={r.id} className={`rounded-lg border p-2.5 ${
                            r.status === 'queued' ? 'border-amber-200 bg-amber-50/60' : 'border-slate-100 bg-slate-50/60'
                          }`}
                          >
                            <div className="flex items-center gap-2">
                              <span className={`text-xs font-semibold ${r.status === 'queued' ? 'text-amber-700' : 'text-slate-700'}`}>
                                {pipelineRunLabel(r)}
                              </span>
                              <span
                                className="ml-auto text-[10px] text-slate-400 whitespace-nowrap"
                                title={new Date(r.decidedAt || r.createdAt).toLocaleString()}
                              >
                                {timeAgo(r.decidedAt || r.createdAt)}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                            via {pipelineTriggerLabel(r.triggerSource)}
                              {r.status === 'queued' && ' — runs when business hours open'}
                              {r.syncStatus ? ` · sync ${r.syncStatus}` : ''}
                            </p>
                            <Link
                              to={`/assignments/history/${r.id}`}
                              state={{ returnTo: `/tickets/${ticket.id}` }}
                              className="tp-focus-ring inline-flex items-center gap-1 mt-1 text-[11px] font-semibold text-indigo-600 hover:underline rounded"
                            >
                              <Bot className="w-3 h-3" aria-hidden="true" /> View run
                            </Link>
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

      {toast && (
        <div
          role="status"
          className={`fixed bottom-20 md:bottom-5 right-5 z-50 flex items-center gap-3 px-4 py-2.5 rounded-lg shadow-soft text-sm font-medium animate-slideInLeft ${
            toast.tone === 'red' ? 'bg-red-600 text-white' : toast.tone === 'sky' ? 'bg-sky-600 text-white' : 'bg-emerald-600 text-white'
          }`}
        >
          {toast.message}
          {toast.undo && (
            <button
              onClick={() => { const fn = toast.undo; setToast(null); fn(); }}
              className="tp-focus-ring px-2 py-0.5 rounded-md bg-white/20 hover:bg-white/30 text-xs font-bold uppercase tracking-wide"
            >
              Undo
            </button>
          )}
        </div>
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

      {aiModalOpen && ticket && (
        <AiAssignModal
          ticket={ticket}
          onClose={() => setAiModalOpen(false)}
          onDone={() => {
            lastLocalMutationRef.current = Date.now();
            fetchTicket({ silent: true });
          }}
        />
      )}

      {editFile && (
        <ImageMarkupModal
          file={editFile}
          onCancel={() => setEditFile(null)}
          onSave={(edited) => {
            setComposerFiles((prev) => prev.map((f) => (f === editFile ? edited : f)));
            setEditFile(null);
          }}
        />
      )}

      {previewAttachment && (
        <AttachmentPreviewModal
          ticketId={ticketId}
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
        />
      )}

      {requestApprovalOpen && (
        <RequestApprovalModal
          categories={(meta?.approvalCategories || []).filter((c) => (c.managerCount || 0) > 0)}
          technicians={meta?.technicians || []}
          busy={savingField === 'approval-request'}
          onClose={() => setRequestApprovalOpen(false)}
          onSubmit={({ approvalCategoryId, note, noteHtml }) => {
            applyChange('approval-request', async () => {
              await ticketsAPI.requestApproval(ticketId, { approvalCategoryId, note, noteHtml });
              setRequestApprovalOpen(false);
            });
          }}
        />
      )}

      {changeApprovalTarget && (() => {
        const t = changeApprovalTarget;
        const toApprove = t.to === 'approved';
        const busy = savingField === `approval-${t.approvalId}`;
        return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-labelledby="chg-approval-title">
            <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-[2px]" onClick={() => setChangeApprovalTarget(null)} aria-hidden="true" />
            <div className="relative tp-card rounded-2xl shadow-soft w-full max-w-md p-5 animate-scaleIn">
              <div className="flex items-start gap-3">
                <span className={`h-9 w-9 rounded-lg inline-flex items-center justify-center flex-shrink-0 ${toApprove ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
                  <RefreshCw className="w-4.5 h-4.5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h2 id="chg-approval-title" className="text-base font-bold text-slate-900">
                    Change this decision to {t.to}?
                  </h2>
                  <p className="mt-1 text-sm text-slate-600 leading-relaxed">
                    {t.categoryName ? <><span className="font-semibold">{t.categoryName}</span> is </> : 'This approval is '}
                    currently <span className={`font-semibold ${t.from === 'approved' ? 'text-emerald-700' : 'text-red-700'}`}>{t.from}</span>.
                    {' '}This will flip it to <span className={`font-semibold ${toApprove ? 'text-emerald-700' : 'text-red-700'}`}>{t.to}</span> and record the change on the ticket.
                  </p>
                </div>
              </div>
              <label htmlFor="change-note" className="block mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
                Why the change? <span className="font-normal normal-case text-slate-300">— optional, shown in the audit trail</span>
              </label>
              <textarea
                id="change-note"
                rows={3}
                autoFocus
                value={changeNote}
                onChange={(e) => setChangeNote(e.target.value)}
                placeholder={toApprove ? 'e.g. “Budget was approved after all — clearing to proceed.”' : 'e.g. “Reversing — the spend exceeds this quarter’s cap.”'}
                className="tp-focus-ring w-full text-sm bg-white border border-input rounded-xl px-3 py-2.5 placeholder:text-slate-400 resize-y"
              />
              <div className="flex items-center justify-end gap-2 mt-4">
                <button onClick={() => setChangeApprovalTarget(null)} className="tp-focus-ring px-3.5 py-2 text-sm font-medium rounded-lg text-slate-600 hover:bg-slate-100">Cancel</button>
                <button
                  onClick={() => {
                    applyChange(`approval-${t.approvalId}`, async () => {
                      await ticketsAPI.changeApprovalDecision(ticketId, t.approvalId, t.to, changeNote.trim() || null);
                      setChangeApprovalTarget(null);
                    });
                  }}
                  disabled={busy}
                  className={`tp-focus-ring inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg text-white disabled:opacity-50 ${toApprove ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}`}
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-4 h-4" aria-hidden="true" />}
                  Change to {t.to}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {deleteApprovalTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-labelledby="del-approval-title">
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-[2px]" onClick={() => setDeleteApprovalTarget(null)} aria-hidden="true" />
          <div className="relative tp-card rounded-2xl shadow-soft w-full max-w-md p-5 animate-scaleIn">
            <div className="flex items-start gap-3">
              <span className="h-9 w-9 rounded-lg bg-red-50 text-red-600 inline-flex items-center justify-center flex-shrink-0">
                <Trash2 className="w-4.5 h-4.5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 id="del-approval-title" className="text-base font-bold text-slate-900">Delete this approval request?</h2>
                <p className="mt-1 text-sm text-slate-600 leading-relaxed">
                  This permanently removes the
                  {deleteApprovalTarget.approvalCategory?.name ? <> <span className="font-semibold">{deleteApprovalTarget.approvalCategory.name}</span></> : null} approval
                  {' '}and its decision history from this ticket. <span className="font-medium text-red-600">Any approved/rejected status will be lost</span> and can&apos;t be recovered.
                  {' '}To keep the record instead, use <span className="font-medium">Cancel</span>.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-4">
              <button onClick={() => setDeleteApprovalTarget(null)} className="tp-focus-ring px-3.5 py-2 text-sm font-medium rounded-lg text-slate-600 hover:bg-slate-100">Keep it</button>
              <button
                onClick={() => {
                  const target = deleteApprovalTarget;
                  applyChange(`approval-${target.id}`, async () => {
                    await ticketsAPI.deleteApproval(ticketId, target.id);
                    setDeleteApprovalTarget(null);
                  });
                }}
                disabled={savingField === `approval-${deleteApprovalTarget.id}`}
                className="tp-focus-ring inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {savingField === `approval-${deleteApprovalTarget.id}` ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Trash2 className="w-4 h-4" aria-hidden="true" />}
                Delete request
              </button>
            </div>
          </div>
        </div>
      )}

      {cloneConfirm && ticket && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-labelledby="clone-title">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={() => setCloneConfirm(false)} aria-hidden="true" />
          <div className="relative tp-card rounded-2xl shadow-soft w-full max-w-md p-5 animate-scaleIn">
            <div className="flex items-start gap-3">
              <span className="h-9 w-9 rounded-lg bg-blue-50 text-blue-600 inline-flex items-center justify-center flex-shrink-0">
                <CopyPlus className="w-4.5 h-4.5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 id="clone-title" className="text-base font-bold text-slate-900">Clone this ticket?</h2>
                <p className="mt-1 text-sm text-slate-600 leading-relaxed">
                  This creates a <strong>new draft ticket</strong> pre-filled from <span className="font-mono">{ticket.displayRef}</span> — same requester, subject, description, priority and category. Handy for logging a recurring or near-identical request.
                </p>
                <ul className="mt-2.5 space-y-1 text-xs text-slate-500">
                  <li>• Titled <strong>“Copy of: {(ticket.subject || '').slice(0, 48)}{(ticket.subject || '').length > 48 ? '…' : ''}”</strong> so it’s easy to tell apart.</li>
                  <li>• Starts <strong>unassigned</strong>, and <strong>no AI triage</strong> runs automatically.</li>
                  <li>• The original ticket is untouched.</li>
                </ul>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setCloneConfirm(false)}
                className="tp-focus-ring px-3 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { setCloneConfirm(false); cloneTicket(); }}
                className="tp-focus-ring inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-blue-700"
              >
                <CopyPlus className="w-4 h-4" aria-hidden="true" /> Create clone
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="print-hide"><MobileTabBar /></div>
    </div>
  );
}
