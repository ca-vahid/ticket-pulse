import { useState, useEffect } from 'react';
import { assignmentAPI } from '../../services/api';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronDown, ChevronRight, CheckCircle, XCircle, AlertTriangle,
  Loader2, Brain, MapPin, Calendar, BarChart3, Award, MessageSquare,
  ExternalLink, AlertCircle, User, FileText, Mail, Building2, Tag, Sparkles,
} from 'lucide-react';
import { CopyBadge, cleanTranscript, mdComponents } from './StreamingComponents';
import { RecommendationCards } from './LivePipelineView';

const STEP_ICONS = {
  classification: Brain,
  categorization: Award,
  location: MapPin,
  availability: Calendar,
  competency: Award,
  workload: BarChart3,
  recommendation: MessageSquare,
};

const STATUS_STYLES = {
  completed: { icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50' },
  failed: { icon: XCircle, color: 'text-red-600', bg: 'bg-red-50' },
  running: { icon: Loader2, color: 'text-blue-600', bg: 'bg-blue-50' },
  skipped: { icon: AlertTriangle, color: 'text-gray-400', bg: 'bg-gray-50' },
};

function StepCard({ step }) {
  const [expanded, setExpanded] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  const statusStyle = STATUS_STYLES[step.status] || STATUS_STYLES.running;
  const StatusIcon = statusStyle.icon;
  const StepIcon = STEP_ICONS[step.stepName] || Brain;

  return (
    <div className={`border rounded-lg ${statusStyle.bg} mb-2`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 text-left hover:bg-white/40 transition-colors rounded-lg"
      >
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-gray-400 w-5">{step.stepNumber}</span>
          <StepIcon className="w-4 h-4 text-gray-500" />
          <span className="font-medium text-sm capitalize">{step.stepName.replace(/_/g, ' ')}</span>
          <StatusIcon className={`w-4 h-4 ${statusStyle.color} ${step.status === 'running' ? 'animate-spin' : ''}`} />
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {step.durationMs && <span>{step.durationMs}ms</span>}
          {step.tokensUsed && <span>{step.tokensUsed} tokens</span>}
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {step.output && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Output</h4>
              <pre className="bg-white rounded p-2 text-xs overflow-x-auto max-h-60 border">
                {JSON.stringify(step.output, null, 2)}
              </pre>
            </div>
          )}

          {step.input && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Input</h4>
              <pre className="bg-white rounded p-2 text-xs overflow-x-auto max-h-40 border">
                {JSON.stringify(step.input, null, 2)}
              </pre>
            </div>
          )}

          {(step.llmPrompt || step.llmResponse) && (
            <div>
              <button
                onClick={() => setShowPrompt(!showPrompt)}
                className="text-xs text-blue-600 hover:underline"
              >
                {showPrompt ? 'Hide' : 'Show'} LLM prompt/response
              </button>
              {showPrompt && (
                <div className="mt-2 space-y-2">
                  {step.llmPrompt && (
                    <div>
                      <h5 className="text-xs font-semibold text-gray-400">Prompt</h5>
                      <pre className="bg-gray-900 text-green-300 rounded p-2 text-xs overflow-x-auto max-h-60">
                        {step.llmPrompt}
                      </pre>
                    </div>
                  )}
                  {step.llmResponse && (
                    <div>
                      <h5 className="text-xs font-semibold text-gray-400">Response</h5>
                      <pre className="bg-gray-900 text-blue-300 rounded p-2 text-xs overflow-x-auto max-h-60">
                        {step.llmResponse}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {step.errorMessage && (
            <div className="bg-red-100 text-red-700 rounded p-2 text-xs">
              {step.errorMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

function HighlightText({ text, techNames = [] }) {
  if (!text) return null;

  const allMatches = [];
  const ticketRegex = /#\d{4,}/g;
  let m;
  while ((m = ticketRegex.exec(text)) !== null) {
    allMatches.push({ start: m.index, end: m.index + m[0].length, text: m[0], type: 'ticket' });
  }
  for (const name of techNames.filter(Boolean)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    while ((m = regex.exec(text)) !== null) {
      if (!allMatches.some(e => e.start <= m.index && e.end >= m.index + m[0].length)) {
        allMatches.push({ start: m.index, end: m.index + m[0].length, text: m[0], type: 'tech' });
      }
    }
  }
  allMatches.sort((a, b) => a.start - b.start);

  const parts = [];
  let lastIndex = 0;
  for (const match of allMatches) {
    if (match.start > lastIndex) parts.push({ text: text.slice(lastIndex, match.start), type: 'plain' });
    parts.push(match);
    lastIndex = match.end;
  }
  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex), type: 'plain' });

  return (
    <>
      {parts.map((part, i) => {
        if (part.type === 'ticket') return <mark key={i} className="bg-amber-100 text-amber-800 px-0.5 rounded font-mono text-[11px] not-italic">{part.text}</mark>;
        if (part.type === 'tech') return <strong key={i} className="text-indigo-700 font-semibold">{part.text}</strong>;
        return <span key={i}>{part.text}</span>;
      })}
    </>
  );
}

function ReasoningCard({ reasoning, recommendations }) {
  if (!reasoning) return null;
  const techNames = recommendations?.map(r => r.techName).filter(Boolean) || [];
  return (
    <div className="bg-gradient-to-br from-indigo-50 via-blue-50 to-slate-50 border border-indigo-100 rounded-xl p-4 h-full flex flex-col">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
          <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
        </div>
        <h4 className="text-xs font-semibold text-indigo-700 uppercase tracking-wide">Overall Reasoning</h4>
      </div>
      <p className="text-sm text-slate-700 leading-relaxed">
        <HighlightText text={reasoning} techNames={techNames} />
      </p>
    </div>
  );
}

function TicketDetailsCard({ ticket }) {
  const [expanded, setExpanded] = useState(false);
  if (!ticket) return null;

  const description = ticket.descriptionText || stripHtml(ticket.description) || '';
  const isLong = description.length > 300;
  const displayText = expanded || !isLong ? description : description.slice(0, 300) + '...';

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <FileText className="w-4 h-4 text-slate-400" />
          Ticket Details
        </span>
        {expanded ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
      </button>

      <div className={`px-4 py-3 space-y-3 ${expanded ? '' : ''}`}>
        {/* Metadata grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
          {ticket.requester?.name && (
            <div className="flex items-start gap-1.5">
              <User className="w-3.5 h-3.5 text-slate-400 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] text-slate-400 uppercase font-medium">Requester</p>
                <p className="text-xs font-medium text-slate-800 truncate">{ticket.requester.name}</p>
              </div>
            </div>
          )}
          {ticket.requester?.email && (
            <div className="flex items-start gap-1.5">
              <Mail className="w-3.5 h-3.5 text-slate-400 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] text-slate-400 uppercase font-medium">Email</p>
                <p className="text-xs text-slate-600 truncate">{ticket.requester.email}</p>
              </div>
            </div>
          )}
          {ticket.requester?.department && (
            <div className="flex items-start gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-slate-400 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] text-slate-400 uppercase font-medium">Department</p>
                <p className="text-xs text-slate-600 truncate">{ticket.requester.department}</p>
              </div>
            </div>
          )}
          {(ticket.category || ticket.ticketCategory) && (
            <div className="flex items-start gap-1.5">
              <Tag className="w-3.5 h-3.5 text-slate-400 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] text-slate-400 uppercase font-medium">Category</p>
                <div className="flex items-center gap-1 flex-wrap">
                  {ticket.category && <span className="text-xs text-slate-600">{ticket.category}</span>}
                  {ticket.ticketCategory && <span className="text-[10px] bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded font-medium">{ticket.ticketCategory}</span>}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Description */}
        {description && (
          <div>
            <div className="border-t border-slate-100 pt-2.5">
              <p className="text-xs text-slate-400 uppercase font-medium mb-1">Description</p>
              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">{displayText}</p>
              {isLong && (
                <button
                  onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
                  className="text-xs text-blue-600 hover:text-blue-800 font-medium mt-1"
                >
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const DECISION_BADGES = {
  pending_review: { label: 'Pending Review', style: 'bg-yellow-100 text-yellow-800' },
  approved: { label: 'Approved', style: 'bg-green-100 text-green-800' },
  modified: { label: 'Modified', style: 'bg-blue-100 text-blue-800' },
  rejected: { label: 'Rejected', style: 'bg-red-100 text-red-800' },
  auto_assigned: { label: 'Auto-Assigned', style: 'bg-purple-100 text-purple-800' },
  noise_dismissed: { label: 'Noise Dismissed', style: 'bg-gray-100 text-gray-600' },
};

const RUN_STATUS_BADGES = {
  queued: { label: 'Queued', style: 'bg-orange-100 text-orange-800' },
  running: { label: 'Running', style: 'bg-blue-100 text-blue-800' },
  failed: { label: 'Failed', style: 'bg-red-100 text-red-800' },
  cancelled: { label: 'Cancelled', style: 'bg-gray-100 text-gray-600' },
  superseded: { label: 'Superseded', style: 'bg-gray-100 text-gray-600' },
  skipped_stale: { label: 'Skipped Stale', style: 'bg-gray-100 text-gray-600' },
};

const SYNC_BADGES = {
  synced: { label: 'Synced to FreshService', style: 'bg-green-100 text-green-800', icon: '✓' },
  failed: { label: 'Sync failed', style: 'bg-red-100 text-red-800', icon: '✗' },
  dry_run: { label: 'Dry run (not synced)', style: 'bg-yellow-100 text-yellow-800', icon: '◑' },
  pending: { label: 'Sync pending', style: 'bg-gray-100 text-gray-600', icon: '…' },
  skipped: { label: 'Sync skipped', style: 'bg-gray-100 text-gray-500', icon: '–' },
};

function SyncStatusCard({ run, onSyncComplete }) {
  const [syncing, setSyncing] = useState(false);
  const [localSyncStatus, setLocalSyncStatus] = useState(run.syncStatus);
  const [localSyncedAt, setLocalSyncedAt] = useState(run.syncedAt);
  const [localSyncError, setLocalSyncError] = useState(run.syncError);
  const [result, setResult] = useState(null);
  const badge = SYNC_BADGES[localSyncStatus] || SYNC_BADGES.pending;

  const handleSync = async (dryRun) => {
    try {
      setSyncing(true);
      setResult(null);
      const res = dryRun ? await assignmentAPI.syncPreview(run.id) : await assignmentAPI.syncRun(run.id);
      const data = res?.data || res;
      setResult(data);
      if (!dryRun && data?.success) {
        setLocalSyncStatus('synced');
        setLocalSyncedAt(new Date().toISOString());
        setLocalSyncError(null);
        onSyncComplete?.();
      } else if (!dryRun && !data?.success) {
        setLocalSyncStatus('failed');
        setLocalSyncError(data?.error || 'Sync failed');
      }
    } catch (err) {
      setResult({ success: false, error: err.message });
      if (!dryRun) {
        setLocalSyncStatus('failed');
        setLocalSyncError(err.message);
      }
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className={`rounded-lg border p-3 ${localSyncStatus === 'failed' ? 'border-red-200 bg-red-50' : localSyncStatus === 'dry_run' ? 'border-yellow-200 bg-yellow-50' : localSyncStatus === 'synced' ? 'border-green-200 bg-green-50' : 'border-slate-200 bg-slate-50'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.style}`}>{badge.icon} {badge.label}</span>
          {localSyncedAt && <span className="text-xs text-gray-400">{new Date(localSyncedAt).toLocaleString()}</span>}
        </div>
        <div className="flex gap-1.5">
          {(localSyncStatus === 'dry_run' || localSyncStatus === 'failed') && (
            <button onClick={() => handleSync(false)} disabled={syncing} className="px-2.5 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700 disabled:opacity-50">
              {syncing ? 'Syncing...' : localSyncStatus === 'failed' ? 'Retry Sync' : 'Execute for Real'}
            </button>
          )}
          {!localSyncStatus && (
            <button onClick={() => handleSync(true)} disabled={syncing} className="px-2.5 py-1 border rounded text-xs font-medium hover:bg-slate-50 disabled:opacity-50">
              Preview Sync
            </button>
          )}
        </div>
      </div>
      {localSyncError && <p className="text-xs text-red-600 mt-1.5">{localSyncError}</p>}
      {run.syncPayload?.preview && <p className="text-xs text-slate-500 mt-1.5">Actions: {run.syncPayload.preview}</p>}
      {result && (
        <div className={`mt-2 text-xs p-2 rounded ${result.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {result.success ? (result.dryRun ? `Dry run: ${result.preview}` : `Synced: ${result.preview}`) : `Error: ${result.error}`}
        </div>
      )}
    </div>
  );
}

function TranscriptSection({ transcript }) {
  const [expanded, setExpanded] = useState(false);

  if (!transcript) {
    return (
      <div>
        <h4 className="text-sm font-semibold text-gray-700 mb-2">Full Conversation</h4>
        <div className="border rounded-lg bg-gray-50 p-4 text-sm text-gray-500">
          No full transcript was captured for this run.
        </div>
      </div>
    );
  }

  const cleaned = cleanTranscript(transcript);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-gray-700">Full Conversation</h4>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>
      <div className={`border border-slate-200 rounded-lg bg-white overflow-hidden transition-all ${expanded ? '' : 'max-h-[500px] overflow-y-auto'}`}>
        <div className="p-4 sm:p-5 prose prose-sm max-w-none prose-headings:text-slate-800 prose-p:text-slate-700 prose-p:leading-relaxed prose-li:text-slate-700 prose-strong:text-slate-900">
          <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {cleaned}
          </Markdown>
        </div>
      </div>
    </div>
  );
}

export default function PipelineRunDetail({ run, onDecide, deciding, onSyncComplete, isAdmin = false }) {
  const [fsDomain, setFsDomain] = useState(null);

  useEffect(() => {
    assignmentAPI.getFreshServiceDomain().then(res => setFsDomain(res?.domain)).catch(() => {});
  }, []);

  if (!run) return null;

  const ticket = run.ticket;
  const decisionBadge = run.status === 'completed'
    ? (DECISION_BADGES[run.decision] || DECISION_BADGES.pending_review)
    : (RUN_STATUS_BADGES[run.status] || RUN_STATUS_BADGES.running);
  const isPending = run.decision === 'pending_review' && run.status === 'completed';

  const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
  const PRIORITY_PILL = { 1: 'bg-slate-100 text-slate-600', 2: 'bg-yellow-100 text-yellow-800', 3: 'bg-orange-100 text-orange-800', 4: 'bg-red-100 text-red-800' };

  const ticketUrl = fsDomain && ticket?.freshserviceTicketId ? `https://${fsDomain}/a/tickets/${ticket.freshserviceTicketId}` : null;

  const isTicketStale = ticket && (
    (ticket.status && !['Open', 'open', '2'].includes(String(ticket.status))) ||
    (ticket.assignedTechId && ticket.assignedTech && isPending)
  );

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header: Ticket-first */}
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-xs text-slate-400 font-mono">#{ticket?.freshserviceTicketId}</span>
              <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${PRIORITY_PILL[ticket?.priority] || 'bg-slate-100 text-slate-500'}`}>
                {PRIORITY_LABELS[ticket?.priority] || '—'}
              </span>
              {ticket?.ticketCategory && <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">{ticket.ticketCategory}</span>}
            </div>
            <h3 className="text-base sm:text-lg font-bold text-slate-900 leading-snug">
              {ticket?.subject || 'No subject'}
            </h3>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap text-xs text-slate-500">
              {ticket?.requester && (
                <span className="flex items-center gap-1">
                  <User className="w-3 h-3" />
                  {ticket.requester.name}
                  {ticket.requester.department && <span className="text-slate-400">· {ticket.requester.department}</span>}
                </span>
              )}
              <span className="text-slate-300">·</span>
              <span>{ticket?.createdAt ? new Date(ticket.createdAt).toLocaleString() : ''}</span>
              {ticketUrl && (
                <>
                  <span className="text-slate-300">·</span>
                  <a href={ticketUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 font-medium flex items-center gap-0.5">
                    Open in FreshService <ExternalLink className="w-3 h-3" />
                  </a>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-400">
              <CopyBadge label="Run" value={run.id} />
              <span>· {run.triggerSource}</span>
              <span>· {new Date(run.createdAt).toLocaleString()}</span>
              {run.totalDurationMs && <span>· {(run.totalDurationMs / 1000).toFixed(1)}s</span>}
              {run.totalTokensUsed && <span>· {run.totalTokensUsed.toLocaleString()} tokens</span>}
            </div>
          </div>
          <span className={`px-3 py-1 rounded-full text-xs font-medium flex-shrink-0 ${decisionBadge.style}`}>
            {decisionBadge.label}
          </span>
        </div>
      </div>

      {/* Ticket Details + AI Reasoning side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3 sm:gap-4 items-start">
        <div className="lg:col-span-3">
          <TicketDetailsCard ticket={ticket} />
        </div>
        {run.recommendation?.overallReasoning && (
          <div className="lg:col-span-2">
            <ReasoningCard
              reasoning={run.recommendation.overallReasoning}
              recommendations={run.recommendation?.recommendations}
            />
          </div>
        )}
      </div>

      {/* Deleted ticket banner */}
      {String(ticket?.status || '').toLowerCase() === 'deleted' && isPending && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2.5">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-red-800">This ticket has been deleted from FreshService.</p>
            <p className="text-xs text-red-600 mt-1">You can dismiss this run or reject the recommendation.</p>
          </div>
        </div>
      )}

      {/* Staleness banner */}
      {isTicketStale && isPending && String(ticket?.status || '').toLowerCase() !== 'deleted' && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2.5">
          <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            {ticket.assignedTech && (
              <p className="text-sm font-medium text-amber-800">
                This ticket was assigned to <strong>{ticket.assignedTech.name}</strong> outside of this pipeline.
              </p>
            )}
            {ticket.status && !['Open', 'open', '2'].includes(String(ticket.status)) && (
              <p className="text-sm font-medium text-amber-800">
                This ticket is now <strong>{ticket.status}</strong> — it may have been resolved or closed.
              </p>
            )}
            <p className="text-xs text-amber-600 mt-1">You can still approve the recommendation, dismiss this run, or add a triage note.</p>
          </div>
        </div>
      )}

      {run.status !== 'completed' && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
          This run is in status <strong>{run.status}</strong>.
          {run.errorMessage ? ` ${run.errorMessage}` : ''}
        </div>
      )}

      {/* FreshService Sync Status */}
      {run.syncStatus && (
        <SyncStatusCard run={run} onSyncComplete={onSyncComplete} />
      )}

      {/* Recommendations + Decision (shared component) */}
      {run.recommendation && (
        <RecommendationCards
          data={run.recommendation}
          onDecide={isPending ? onDecide : null}
          deciding={deciding}
          hideReasoning={!!run.recommendation?.overallReasoning}
        />
      )}

      {/* Decided info */}
      {run.decidedAt && (
        <div className="bg-gray-50 border rounded-lg p-3 text-sm">
          <p><span className="text-gray-500">Decided by:</span> {run.decidedByEmail}</p>
          <p><span className="text-gray-500">At:</span> {new Date(run.decidedAt).toLocaleString()}</p>
          {run.assignedTech && <p><span className="text-gray-500">Assigned to:</span> {run.assignedTech.name}</p>}
          {run.overrideReason && <p><span className="text-gray-500">Override reason:</span> {run.overrideReason}</p>}
          {run.decisionNote && <p><span className="text-gray-500">Triage note:</span> {run.decisionNote}</p>}
        </div>
      )}

      {/* Pipeline Steps */}
      <div>
        <h4 className="text-sm font-semibold text-gray-700 mb-2">Pipeline Steps</h4>
        {run.steps?.map((step) => (
          <StepCard key={step.id} step={step} />
        ))}
      </div>

      {/* Full Conversation */}
      <TranscriptSection transcript={run.fullTranscript} />

      {/* Error */}
      {run.errorMessage && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          <strong>Error:</strong> {run.errorMessage}
        </div>
      )}
    </div>
  );
}
