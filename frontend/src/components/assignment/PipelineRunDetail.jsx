import { useState } from 'react';
import { assignmentAPI } from '../../services/api';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronDown, ChevronRight, CheckCircle, XCircle, AlertTriangle,
  Loader2, Brain, MapPin, Calendar, BarChart3, Award, MessageSquare,
} from 'lucide-react';
import { CopyBadge, cleanTranscript } from './StreamingComponents';
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

export default function PipelineRunDetail({ run, onDecide, deciding, onSyncComplete }) {
  if (!run) return null;

  const decisionBadge = run.status === 'completed'
    ? (DECISION_BADGES[run.decision] || DECISION_BADGES.pending_review)
    : (RUN_STATUS_BADGES[run.status] || RUN_STATUS_BADGES.running);
  const isPending = run.decision === 'pending_review' && run.status === 'completed';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-lg font-semibold">
              Pipeline Run #{run.id}
            </h3>
            <CopyBadge label="Run" value={run.id} />
          </div>
          <p className="text-sm text-gray-500">
            Ticket #{run.ticket?.freshserviceTicketId} &mdash; {run.ticket?.subject || 'No subject'}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            Triggered: {run.triggerSource} &bull; {new Date(run.createdAt).toLocaleString()} &bull; {run.totalDurationMs ? `${(run.totalDurationMs / 1000).toFixed(1)}s` : ''}
            {run.totalTokensUsed ? ` &bull; ${run.totalTokensUsed} tokens` : ''}
          </p>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-medium ${decisionBadge.style}`}>
          {decisionBadge.label}
        </span>
      </div>

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
        />
      )}

      {/* Decided info */}
      {run.decidedAt && (
        <div className="bg-gray-50 border rounded-lg p-3 text-sm">
          <p><span className="text-gray-500">Decided by:</span> {run.decidedByEmail}</p>
          <p><span className="text-gray-500">At:</span> {new Date(run.decidedAt).toLocaleString()}</p>
          {run.assignedTech && <p><span className="text-gray-500">Assigned to:</span> {run.assignedTech.name}</p>}
          {run.overrideReason && <p><span className="text-gray-500">Override reason:</span> {run.overrideReason}</p>}
        </div>
      )}

      {/* Pipeline Steps */}
      <div>
        <h4 className="text-sm font-semibold text-gray-700 mb-2">Pipeline Steps</h4>
        {run.steps?.map((step) => (
          <StepCard key={step.id} step={step} />
        ))}
      </div>

      {/* Full Transcript */}
      <div>
        <h4 className="text-sm font-semibold text-gray-700 mb-2">Full Conversation</h4>
        {run.fullTranscript ? (
          <div className="border rounded-lg bg-white p-4 prose prose-sm max-w-none">
            <Markdown remarkPlugins={[remarkGfm]}>
              {cleanTranscript(run.fullTranscript)}
            </Markdown>
          </div>
        ) : (
          <div className="border rounded-lg bg-gray-50 p-4 text-sm text-gray-500">
            No full transcript was captured for this run.
          </div>
        )}
      </div>

      {/* Error */}
      {run.errorMessage && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          <strong>Error:</strong> {run.errorMessage}
        </div>
      )}
    </div>
  );
}
