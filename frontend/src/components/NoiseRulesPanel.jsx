import { useState, useEffect, useCallback } from 'react';
import {
  VolumeX, Plus, Trash2, Edit3, Save, X, CheckCircle, XCircle,
  RefreshCw, TestTube, ChevronDown, ChevronUp, ToggleLeft, ToggleRight,
  ShieldCheck,
} from 'lucide-react';
import { noiseRulesAPI } from '../services/api';

// NT-4: a rule either flags matches AS noise (classic behavior) or acts as a
// hard veto that protects matches FROM ever being auto-dismissed as noise.
const RULE_MODES = [
  {
    value: 'noise',
    label: 'Noise',
    help: 'Tickets matching this pattern are flagged as noise and may be auto-dismissed.',
  },
  {
    value: 'never_noise',
    label: 'Never noise',
    help: 'Tickets matching this can never be auto-dismissed as noise, no matter what the AI decides.',
  },
];

function RuleModeSelector({ value, onChange, idPrefix }) {
  const selected = RULE_MODES.find(m => m.value === value) || RULE_MODES[0];
  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1">Mode</label>
      <div role="radiogroup" aria-label="Rule mode" className="flex items-center gap-3">
        {RULE_MODES.map(m => (
          <label key={m.value} htmlFor={`${idPrefix}-mode-${m.value}`} className="flex items-center gap-1.5 text-sm text-foreground/85 cursor-pointer">
            <input
              id={`${idPrefix}-mode-${m.value}`}
              type="radio"
              name={`${idPrefix}-mode`}
              value={m.value}
              checked={(value || 'noise') === m.value}
              onChange={() => onChange(m.value)}
              className="tp-focus-ring"
            />
            {m.value === 'never_noise' && <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />}
            {m.label}
          </label>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground/75 mt-1">{selected.help}</p>
    </div>
  );
}

function NeverNoiseBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-500/30"
      title="Tickets matching this rule can never be auto-dismissed as noise, no matter what the AI decides."
    >
      <ShieldCheck className="w-3 h-3" aria-hidden="true" />
      Never noise
    </span>
  );
}

const CATEGORIES = [
  { value: 'infrastructure', label: 'Infrastructure', color: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200' },
  { value: 'security', label: 'Security', color: 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-200' },
  { value: 'monitoring', label: 'Monitoring', color: 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-700 dark:text-yellow-200' },
  { value: 'vendor', label: 'Vendor', color: 'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-200' },
  { value: 'spam', label: 'Spam', color: 'bg-muted text-foreground/85' },
  { value: 'custom', label: 'Custom', color: 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-200' },
];

function getCategoryStyle(category) {
  return CATEGORIES.find(c => c.value === category)?.color || 'bg-muted text-foreground/85';
}

function formatTestDate(value) {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getSenderLabel(match) {
  if (match.requesterName && match.requesterEmail) {
    return `${match.requesterName} <${match.requesterEmail}>`;
  }
  return match.requesterEmail || match.requesterName || 'Unknown sender';
}

function getStatusStyle(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'open') return 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border-blue-100 dark:border-blue-500/20';
  if (normalized === 'pending') return 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 border-amber-100 dark:border-amber-500/20';
  if (normalized === 'spam' || normalized === 'deleted') return 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 border-red-100 dark:border-red-500/20';
  if (normalized === 'closed') return 'bg-muted text-muted-foreground border-border';
  return 'bg-muted/50 text-muted-foreground border-border';
}

function TestPatternMatches({ testResult }) {
  const sampleMatches = testResult.sampleMatches || [];
  const fallbackSubjects = testResult.sampleSubjects || [];

  if (sampleMatches.length === 0 && fallbackSubjects.length === 0) return null;

  return (
    <div className="mt-2 max-h-60 overflow-y-auto rounded-lg border border-border bg-card">
      {sampleMatches.length > 0 ? (
        <div className="divide-y divide-border/60">
          {sampleMatches.map((match, i) => (
            <div key={`${match.ticketId || 'ticket'}-${i}`} className="grid gap-1 px-3 py-2 text-[11px] sm:grid-cols-[7.5rem_minmax(9rem,16rem)_5rem_minmax(0,1fr)] sm:items-start">
              <div className="font-medium text-muted-foreground">
                {formatTestDate(match.createdAt)}
                {match.ticketId && <span className="ml-1 text-muted-foreground/75">#{match.ticketId}</span>}
              </div>
              <div className="min-w-0 text-muted-foreground" title={getSenderLabel(match)}>
                <div className="truncate font-medium text-foreground/85">{match.requesterName || match.requesterEmail || 'Unknown sender'}</div>
                {match.requesterName && match.requesterEmail && (
                  <div className="truncate text-muted-foreground/75">{match.requesterEmail}</div>
                )}
              </div>
              <div>
                <span className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${getStatusStyle(match.status)}`}>
                  {match.status || 'Unknown'}
                </span>
              </div>
              <div className="min-w-0 truncate text-foreground/85" title={match.subject || ''}>
                {match.subject || '(no subject)'}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-0.5 px-3 py-2">
          {fallbackSubjects.map((subject, i) => (
            <p key={i} className="truncate text-[11px] text-muted-foreground">{subject}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function RuleRow({ rule, onUpdate, onDelete }) {
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState({});
  const [expanded, setExpanded] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [isTesting, setIsTesting] = useState(false);

  const startEdit = () => {
    setEditData({
      name: rule.name,
      pattern: rule.pattern,
      description: rule.description || '',
      category: rule.category,
      mode: rule.mode || 'noise',
      dedupWindowDays: rule.dedupWindowDays || '',
      senderPattern: rule.senderPattern || '',
      autoCloseFromPeople: rule.autoCloseFromPeople === true,
    });
    setIsEditing(true);
  };

  const saveEdit = async () => {
    await onUpdate(rule.id, {
      ...editData,
      // Dedup windows only make sense for noise-flagging rules.
      senderPattern: editData.mode !== 'never_noise' ? (editData.senderPattern || '').trim() || null : null,
      autoCloseFromPeople: editData.mode !== 'never_noise' && editData.autoCloseFromPeople === true,
      dedupWindowDays: editData.mode !== 'never_noise' && editData.dedupWindowDays
        ? parseInt(editData.dedupWindowDays)
        : null,
    });
    setIsEditing(false);
  };

  const handleTest = async () => {
    setIsTesting(true);
    try {
      const res = await noiseRulesAPI.test(isEditing ? editData.pattern : rule.pattern);
      setTestResult(res.data);
    } catch (e) {
      setTestResult({ error: e.message });
    } finally {
      setIsTesting(false);
    }
  };

  const toggleEnabled = () => onUpdate(rule.id, { isEnabled: !rule.isEnabled });

  return (
    <div className={`border rounded-lg transition-all ${rule.isEnabled ? 'border-border bg-card' : 'border-border/60 bg-muted/50 opacity-60'}`}>
      <div className="px-4 py-3 flex items-center gap-3">
        <button onClick={toggleEnabled} className="flex-shrink-0" title={rule.isEnabled ? 'Disable rule' : 'Enable rule'}>
          {rule.isEnabled
            ? <ToggleRight className="w-5 h-5 text-green-500" />
            : <ToggleLeft className="w-5 h-5 text-muted-foreground/75" />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground truncate">{rule.name}</span>
            {rule.mode === 'never_noise' && <NeverNoiseBadge />}
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${getCategoryStyle(rule.category)}`}>
              {rule.category}
            </span>
            {rule.dedupWindowDays && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-200">
                dedup: {rule.dedupWindowDays}d
              </span>
            )}
          </div>
          {rule.description && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{rule.description}</p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-muted-foreground/75 tabular-nums">{rule.matchCount} matches</span>
          <button onClick={() => setExpanded(!expanded)} className="p-1 hover:bg-muted rounded">
            {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground/75" /> : <ChevronDown className="w-4 h-4 text-muted-foreground/75" />}
          </button>
          <button onClick={startEdit} title="Edit rule" aria-label={`Edit rule ${rule.name}`} className="p-1 hover:bg-blue-50 dark:hover:bg-blue-500/15 rounded text-blue-600 dark:text-blue-300">
            <Edit3 className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => onDelete(rule.id)} title="Delete rule" aria-label={`Delete rule ${rule.name}`} className="p-1 hover:bg-red-50 dark:hover:bg-red-500/15 rounded text-red-500">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Expanded details / edit */}
      {(expanded || isEditing) && (
        <div className="px-4 pb-3 border-t border-border/60 pt-3 space-y-3">
          {isEditing ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Name</label>
                  <input
                    value={editData.name}
                    onChange={e => setEditData(d => ({ ...d, name: e.target.value }))}
                    className="w-full px-3 py-1.5 border border-input rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Category</label>
                  <select
                    value={editData.category}
                    onChange={e => setEditData(d => ({ ...d, category: e.target.value }))}
                    className="w-full px-3 py-1.5 border border-input rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Regex Pattern</label>
                <input
                  value={editData.pattern}
                  onChange={e => setEditData(d => ({ ...d, pattern: e.target.value }))}
                  className="w-full px-3 py-1.5 border border-input rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="^Some regex pattern"
                />
              </div>
              <RuleModeSelector
                idPrefix={`edit-${rule.id}`}
                value={editData.mode}
                onChange={mode => setEditData(d => ({ ...d, mode }))}
              />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Description</label>
                  <input
                    value={editData.description}
                    onChange={e => setEditData(d => ({ ...d, description: e.target.value }))}
                    className="w-full px-3 py-1.5 border border-input rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                {editData.mode !== 'never_noise' && (
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">Dedup Window (days)</label>
                    <input
                      type="number"
                      value={editData.dedupWindowDays}
                      onChange={e => setEditData(d => ({ ...d, dedupWindowDays: e.target.value }))}
                      className="w-full px-3 py-1.5 border border-input rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="Leave empty for always-noise"
                      min="1"
                      max="90"
                    />
                    <p className="text-[10px] text-muted-foreground/75 mt-0.5">If set, only marks as noise when a same-subject ticket exists within this window</p>
                  </div>
                )}
              </div>
              {editData.mode !== 'never_noise' && (
                <SenderConditionFields
                  idPrefix={`edit-${rule.id}`}
                  senderPattern={editData.senderPattern}
                  autoCloseFromPeople={editData.autoCloseFromPeople}
                  onChange={(patch) => setEditData(d => ({ ...d, ...patch }))}
                />
              )}
              <div className="flex items-center gap-2">
                <button onClick={saveEdit} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium">
                  <Save className="w-3.5 h-3.5" /> Save
                </button>
                <button onClick={() => setIsEditing(false)} className="flex items-center gap-1.5 px-3 py-1.5 bg-muted hover:bg-secondary text-foreground/85 rounded-lg text-xs font-medium">
                  <X className="w-3.5 h-3.5" /> Cancel
                </button>
                <button onClick={handleTest} disabled={isTesting} className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 dark:bg-amber-500/15 hover:bg-amber-100 dark:hover:bg-amber-500/20 text-amber-700 dark:text-amber-200 rounded-lg text-xs font-medium">
                  <TestTube className="w-3.5 h-3.5" /> {isTesting ? 'Testing...' : 'Test Pattern'}
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <div>
                <span className="text-[10px] uppercase font-medium text-muted-foreground/75">Pattern</span>
                <code className="block text-xs font-mono text-foreground/85 bg-muted/50 px-2 py-1 rounded mt-0.5 break-all">{rule.pattern}</code>
              </div>
              {rule.description && (
                <div>
                  <span className="text-[10px] uppercase font-medium text-muted-foreground/75">Description</span>
                  <p className="text-xs text-muted-foreground mt-0.5">{rule.description}</p>
                </div>
              )}
              <button onClick={handleTest} disabled={isTesting} className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 dark:bg-amber-500/15 hover:bg-amber-100 dark:hover:bg-amber-500/20 text-amber-700 dark:text-amber-200 rounded-lg text-xs font-medium">
                <TestTube className="w-3.5 h-3.5" /> {isTesting ? 'Testing...' : 'Test Pattern'}
              </button>
            </div>
          )}

          {testResult && (
            <div className="bg-muted/50 rounded-lg p-3 border border-border">
              {testResult.error ? (
                <p className="text-xs text-red-600 dark:text-red-300">{testResult.error}</p>
              ) : (
                <>
                  <p className="text-xs font-medium text-foreground/85">
                    Matches <span className="text-blue-600 dark:text-blue-300 font-bold">{testResult.matchCount}</span> of {testResult.totalTickets} tickets ({testResult.percentage}%)
                  </p>
                  <TestPatternMatches testResult={testResult} />
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Sender conditions on a noise rule (QA 09-04).
 *
 * A subject match cannot tell the machine's notice apart from a colleague
 * forwarding it — so a rule can require the ADDRESS to match too, and rules that
 * are meant to swallow forwards (phishing-simulation campaigns) say so out loud.
 */
export function SenderConditionFields({ idPrefix, senderPattern = '', autoCloseFromPeople = false, onChange }) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-2">
      <div>
        <label htmlFor={`${idPrefix}-sender`} className="block text-xs font-medium text-muted-foreground mb-1">
          Sender address must match (optional)
        </label>
        <input
          id={`${idPrefix}-sender`}
          value={senderPattern}
          onChange={(e) => onChange({ senderPattern: e.target.value })}
          className="tp-focus-ring w-full px-3 py-1.5 border border-input rounded-lg text-sm font-mono bg-card"
          placeholder="e.g. noreply@|^postmaster@"
        />
        <p className="text-[10px] text-muted-foreground/75 mt-0.5">
          Leave empty to match on the subject alone. With a pattern, the rule only fires when the requester’s address matches it too.
        </p>
      </div>
      <label className="flex items-start gap-2 text-xs text-foreground/85">
        <input
          type="checkbox"
          checked={autoCloseFromPeople === true}
          onChange={(e) => onChange({ autoCloseFromPeople: e.target.checked })}
          className="mt-0.5 h-3.5 w-3.5 rounded border-input text-blue-600 dark:text-blue-300"
        />
        <span>
          <span className="font-medium text-foreground">Close these even when a person sent them</span>
          <span className="block text-[10px] text-muted-foreground/75">
            Off by default: a ticket forwarded by a colleague is left in the queue for the AI and the team to read. Turn this on only for campaigns where the forwards themselves are the noise.
          </span>
        </span>
      </label>
    </div>
  );
}

const SUPPRESS_REASON_LABEL = {
  forwarded_by_person: 'forwarded by a person',
  person_requester: 'requester is a real user',
  sender_mismatch: 'sender did not match the rule',
  guard_error: 'guard could not verify the sender',
};

/**
 * What the rules actually did (QA 09-04 phase F). A wrong auto-close used to leave
 * no trace anyone would look at; this shows both halves — held back, and closed.
 */
export function NoiseActivityPanel({ activity, isLoading, onRefresh }) {
  const [tab, setTab] = useState('held');
  const rows = (tab === 'held' ? activity?.heldForReview : activity?.autoClosed) || [];
  return (
    <div className="bg-card rounded-lg shadow-sm border border-border p-5" data-testid="noise-activity">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-300" />
          What the rules did · last {activity?.days ?? 30} days
        </h3>
        <button
          onClick={onRefresh}
          className="tp-focus-ring flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border text-[11px] font-medium text-muted-foreground hover:bg-muted"
        >
          <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
      <div className="flex items-center gap-2 mb-3">
        {[
          ['held', `Held for review (${activity?.counts?.heldForReview ?? 0})`],
          ['closed', `Auto-closed (${activity?.counts?.autoClosed ?? 0})`],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`tp-focus-ring px-2.5 py-1 rounded-lg text-[11px] font-semibold border ${
              tab === key
                ? 'border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200'
                : 'border-border text-muted-foreground hover:bg-muted'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {tab === 'held'
            ? 'Nothing held back — every rule match in this window came from an automated sender.'
            : 'No rule closed a ticket in this window.'}
        </p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border overflow-hidden">
          {rows.map((row) => (
            <li key={`${tab}-${row.id}`} className="px-3 py-2 text-xs bg-card">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-mono text-[11px] text-muted-foreground">{row.ref}</span>
                <span className="font-medium text-foreground truncate">{row.subject || '(no subject)'}</span>
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {row.requesterName || row.requesterEmail || 'unknown requester'}
                {row.rule ? <> · rule <span className="text-foreground/85">{row.rule}</span></> : null}
                {tab === 'held' && row.reason ? <> · {SUPPRESS_REASON_LABEL[row.reason] || row.reason}</> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Was the AI right? (QA 09-05, Accounting option 4.)
 *
 * The Accounting problem was argued from an inference — "a person worked it
 * anyway" — that nobody could actually see. This panel shows it. The signals
 * are proxies, not confirmed errors, and the panel says so rather than
 * dressing an estimate up as a fact.
 */
export function NoiseAccuracyPanel({ accuracy, isLoading, onRefresh }) {
  const [showSamples, setShowSamples] = useState(false);
  if (!accuracy) return null;
  const { total, overridden, upheld, accuracy: pct, signals, autoCloseNoise, days, samples } = accuracy;
  const tone = pct === null ? 'muted' : pct >= 80 ? 'good' : pct >= 50 ? 'warn' : 'bad';
  const toneClass = {
    good: 'text-emerald-700 dark:text-emerald-200',
    warn: 'text-amber-700 dark:text-amber-200',
    bad: 'text-red-700 dark:text-red-200',
    muted: 'text-muted-foreground',
  }[tone];

  const rows = [
    ['Given to a person', signals?.assigned, 'A coordinator or the pipeline assigned it after the verdict'],
    ['Agent replied to the requester', signals?.agentReplied, 'Someone answered the sender'],
    ['Noise flag taken back off', signals?.noiseCleared, autoCloseNoise
      ? 'Someone un-flagged it'
      : 'Not counted here — this workspace does not auto-close, so the flag is never written in the first place'],
    ['Still open', signals?.stillOpen, 'Context only — where nothing auto-closes, open is the resting state'],
  ];

  return (
    <div className="bg-card rounded-lg shadow-sm border border-border p-5" data-testid="noise-accuracy">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-blue-600 dark:text-blue-300" />
          Was the AI right? · last {days} days
        </h3>
        <button
          onClick={onRefresh}
          className="tp-focus-ring flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border text-[11px] font-medium text-muted-foreground hover:bg-muted"
        >
          <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {total === 0 ? (
        <p className="text-xs text-muted-foreground">No AI noise verdicts in this window — nothing to score.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            {[
              [total, 'verdicts', 'text-foreground'],
              [upheld, 'looked right', 'text-emerald-700 dark:text-emerald-200'],
              [overridden, 'worked anyway', 'text-amber-700 dark:text-amber-200'],
              [pct === null ? '—' : `${pct}%`, 'looked right', toneClass],
            ].map(([value, label, cls], i) => (
              <div key={i} className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                <div className={`text-lg font-bold tabular-nums leading-tight ${cls}`}>{value}</div>
                <div className="text-[10.5px] text-muted-foreground">{label}</div>
              </div>
            ))}
          </div>

          <ul className="divide-y divide-border/60 rounded-lg border border-border overflow-hidden mb-3">
            {rows.map(([label, signal, hint]) => (
              <li key={label} className={`px-3 py-2 text-xs bg-card flex items-baseline gap-2 ${signal?.counted === false ? 'opacity-60' : ''}`}>
                <span className="font-semibold tabular-nums text-foreground w-12">{signal?.count ?? 0}</span>
                <span className="text-foreground/85">{label}</span>
                {signal?.counted === false && (
                  <span className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground/75">not counted</span>
                )}
                <span className="text-[11px] text-muted-foreground ml-auto text-right max-w-[52%]">{hint}</span>
              </li>
            ))}
          </ul>

          <p className="text-[11px] text-muted-foreground">
            These are <strong>signals, not confirmed mistakes</strong> — a ticket can be assigned for reasons
            unrelated to the verdict. Treat the percentage as a trend line to watch, and send us the tickets
            where you disagree so it can be calibrated against real examples.
          </p>

          {samples?.length > 0 && (
            <div className="mt-3">
              <button
                onClick={() => setShowSamples((v) => !v)}
                className="tp-focus-ring text-[11px] font-semibold text-blue-700 dark:text-blue-300 hover:underline"
              >
                {showSamples ? 'Hide' : `Show ${samples.length} recent`} tickets a person worked anyway
              </button>
              {showSamples && (
                <ul className="divide-y divide-border/60 rounded-lg border border-border overflow-hidden mt-2">
                  {samples.map((row) => (
                    <li key={row.ticketId} className="px-3 py-2 text-xs bg-card">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="font-mono text-[11px] text-muted-foreground">{row.ref}</span>
                        <span className="font-medium text-foreground truncate">{row.subject}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        {row.status}
                        {row.assignedTo ? <> · worked by <span className="text-foreground/85">{row.assignedTo}</span></> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * What noise means in THIS mailbox (QA 09-05, Accounting option 2). The
 * built-in prompt learned noise in an IT queue, where a no-reply sender
 * usually IS noise. In Accounts Payable the vendor robots are the customers,
 * so the same heuristic reads backwards.
 */
const AP_GUIDANCE_TEMPLATE = [
  'This is an Accounts Payable / Accounts Receivable mailbox. Automated senders are our CUSTOMERS here, not noise.',
  '',
  'TREAT AS REAL WORK (never noise), even from a no-reply or automated address:',
  '- Invoices, statements, remittance advice, payment confirmations and receipts',
  '- Purchase orders, credit notes, dunning and past-due notices',
  '- Vendor account, banking or tax-detail changes',
  '- Anything naming an invoice number, account number or an amount to be actioned',
  '',
  'TREAT AS NOISE:',
  '- Marketing, newsletters, product announcements, webinar and event invitations',
  '- Conference, giveaway and survey invitations',
  '- Phishing and spoofed payment-change requests (flag rather than dismiss when money is involved)',
  '- Delivery/read receipts and out-of-office auto-replies',
  '',
  'When one sender sends both kinds of mail from the same address, judge the message, not the sender.',
].join('\n');

export function NoiseGuidancePanel({ value, onSave, isSaving }) {
  const [draft, setDraft] = useState(value || '');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setDraft(value || ''); setDirty(false); }, [value]);

  return (
    <div className="bg-card rounded-lg shadow-sm border border-border p-5" data-testid="noise-guidance">
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-1">
        <ShieldCheck className="w-4 h-4 text-violet-600 dark:text-violet-300" />
        What counts as noise in this mailbox
      </h3>
      <p className="text-[11px] text-muted-foreground mb-3">
        Added to the AI&apos;s instructions for this workspace, and it <strong>overrides</strong> the general
        rules — so if you say automated invoices are real work, an automated sender stops being evidence of
        noise. Leave it empty to use the built-in guidance.
      </p>
      <textarea
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
        rows={10}
        maxLength={4000}
        placeholder="e.g. Invoices and statements from vendor systems are real work; marketing and event invitations are noise…"
        className="w-full rounded-lg border border-input bg-card p-3 text-xs text-foreground font-mono leading-relaxed settings-scrollbar"
        aria-label="Workspace noise guidance"
      />
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <button
          onClick={() => { onSave(draft); setDirty(false); }}
          disabled={isSaving || !dirty}
          className="tp-focus-ring px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-50"
        >
          {isSaving ? 'Saving…' : 'Save guidance'}
        </button>
        <button
          onClick={() => { setDraft(AP_GUIDANCE_TEMPLATE); setDirty(true); }}
          className="tp-focus-ring px-3 py-1.5 rounded-lg border border-border text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          Insert Accounts Payable wording
        </button>
        {draft && (
          <button
            onClick={() => { setDraft(''); setDirty(true); }}
            className="tp-focus-ring px-3 py-1.5 rounded-lg border border-border text-xs font-medium text-muted-foreground hover:bg-muted"
          >
            Clear
          </button>
        )}
        <span className="text-[11px] text-muted-foreground ml-auto tabular-nums">{draft.length} / 4000</span>
      </div>
    </div>
  );
}

export default function NoiseRulesPanel() {
  const [rules, setRules] = useState([]);
  const [stats, setStats] = useState(null);
  const [activity, setActivity] = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [guidance, setGuidance] = useState('');
  const [savingGuidance, setSavingGuidance] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [newRule, setNewRule] = useState({
    name: '', pattern: '', description: '', category: 'custom', mode: 'noise', dedupWindowDays: '',
    senderPattern: '', autoCloseFromPeople: false,
  });

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [rulesRes, statsRes, activityRes, accuracyRes, configRes] = await Promise.all([
        noiseRulesAPI.getAll(),
        noiseRulesAPI.getStats(),
        // QA 09-04 (F): strictly non-fatal — the rules list must render even if the
        // activity call fails or the client predates the endpoint.
        typeof noiseRulesAPI.activity === 'function'
          ? noiseRulesAPI.activity(30).catch(() => null)
          : Promise.resolve(null),
        // QA 09-05 (option 4): verdict accuracy. Same non-fatal contract.
        typeof noiseRulesAPI.verdictAccuracy === 'function'
          ? noiseRulesAPI.verdictAccuracy(180).catch(() => null)
          : Promise.resolve(null),
        // QA 09-05 (option 2): the workspace's own noise guidance.
        typeof noiseRulesAPI.guidance === 'function'
          ? noiseRulesAPI.guidance().catch(() => null)
          : Promise.resolve(null),
      ]);
      setRules(rulesRes.data || []);
      setStats(statsRes.data || null);
      setActivity(activityRes?.data || null);
      setAccuracy(accuracyRes?.data || null);
      setGuidance(configRes?.data?.noiseGuidance || '');
    } catch (e) {
      setStatus({ success: false, message: e.message });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // QA 09-05 (option 2): saving guidance must never take the panel down with
  // it — the rules list is the primary content here.
  const saveGuidance = useCallback(async (next) => {
    setSavingGuidance(true);
    try {
      await noiseRulesAPI.saveGuidance(next);
      setGuidance(next);
      setStatus({ success: true, message: next.trim() ? 'Noise guidance saved' : 'Noise guidance cleared' });
    } catch (e) {
      setStatus({ success: false, message: e.response?.data?.message || e.message });
    } finally {
      setSavingGuidance(false);
    }
  }, []);

  const handleCreate = async () => {
    if (!newRule.name || !newRule.pattern) {
      setStatus({ success: false, message: 'Name and pattern are required' });
      return;
    }
    try {
      await noiseRulesAPI.create({
        ...newRule,
        senderPattern: newRule.mode !== 'never_noise' ? (newRule.senderPattern || '').trim() || null : null,
        autoCloseFromPeople: newRule.mode !== 'never_noise' && newRule.autoCloseFromPeople === true,
        dedupWindowDays: newRule.mode !== 'never_noise' && newRule.dedupWindowDays
          ? parseInt(newRule.dedupWindowDays)
          : null,
      });
      setShowAddForm(false);
      setNewRule({
        name: '', pattern: '', description: '', category: 'custom', mode: 'noise', dedupWindowDays: '',
        senderPattern: '', autoCloseFromPeople: false,
      });
      setStatus({
        success: true,
        message: newRule.mode === 'never_noise'
          ? 'Never-noise rule created. Matching tickets are now protected from auto-dismissal.'
          : 'Rule created. Run backfill to apply to existing tickets.',
      });
      await fetchData();
    } catch (e) {
      setStatus({ success: false, message: e.message });
    }
  };

  const handleUpdate = async (id, data) => {
    try {
      await noiseRulesAPI.update(id, data);
      await fetchData();
    } catch (e) {
      setStatus({ success: false, message: e.message });
    }
  };

  const handleDelete = async (id) => {
    const rule = rules.find(r => r.id === id);
    if (!window.confirm(`Delete rule "${rule?.name}"? This won't un-flag already tagged tickets until you re-run backfill.`)) return;
    try {
      await noiseRulesAPI.delete(id);
      setStatus({ success: true, message: 'Rule deleted. Run backfill to update affected tickets.' });
      await fetchData();
    } catch (e) {
      setStatus({ success: false, message: e.message });
    }
  };

  const handleBackfill = async () => {
    if (!window.confirm('Re-evaluate all tickets against current rules? This may take a minute.')) return;
    setIsBackfilling(true);
    setStatus({ success: true, message: 'Backfill running...' });
    try {
      const res = await noiseRulesAPI.backfill();
      setStatus({
        success: true,
        message: `Backfill complete: ${res.data.noiseCount} noise tickets found out of ${res.data.totalProcessed}. ${res.data.updated} tickets updated.`,
      });
      await fetchData();
    } catch (e) {
      setStatus({ success: false, message: `Backfill failed: ${e.message}` });
    } finally {
      setIsBackfilling(false);
    }
  };

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <RefreshCw className="w-6 h-6 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      {/* Stats overview */}
      {stats && (
        <div className="bg-card rounded-lg shadow-sm border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
              <VolumeX className="w-5 h-5 text-amber-600 dark:text-amber-300" />
              Noise Ticket Rules
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowAddForm(!showAddForm)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium"
              >
                <Plus className="w-3.5 h-3.5" /> Add Rule
              </button>
              <button
                onClick={handleBackfill}
                disabled={isBackfilling}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-medium disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isBackfilling ? 'animate-spin' : ''}`} />
                {isBackfilling ? 'Running...' : 'Re-run Backfill'}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-4">
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-foreground">{stats.totalTickets?.toLocaleString()}</p>
              <p className="text-[10px] uppercase font-medium text-muted-foreground">Total Tickets</p>
            </div>
            <div className="bg-green-50 dark:bg-green-500/15 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-green-700 dark:text-green-200">{stats.actionableTickets?.toLocaleString()}</p>
              <p className="text-[10px] uppercase font-medium text-green-600 dark:text-green-300">Actionable</p>
            </div>
            <div className="bg-amber-50 dark:bg-amber-500/15 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-amber-700 dark:text-amber-200">{stats.noiseTickets?.toLocaleString()}</p>
              <p className="text-[10px] uppercase font-medium text-amber-600 dark:text-amber-300">Noise</p>
            </div>
            <div className="bg-blue-50 dark:bg-blue-500/15 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-blue-700 dark:text-blue-200">{stats.noisePercentage}%</p>
              <p className="text-[10px] uppercase font-medium text-blue-600 dark:text-blue-300">Noise Rate</p>
            </div>
          </div>
        </div>
      )}

      {/* Status message */}
      {status && (
        <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${status.success ? 'bg-green-50 dark:bg-green-500/15 text-green-700 dark:text-green-200' : 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200'}`}>
          {status.success ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          {status.message}
          <button onClick={() => setStatus(null)} className="ml-auto p-0.5 hover:bg-card/50 rounded">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Add new rule form */}
      <NoiseAccuracyPanel accuracy={accuracy} isLoading={isLoading} onRefresh={fetchData} />

      <NoiseGuidancePanel value={guidance} onSave={saveGuidance} isSaving={savingGuidance} />

      <NoiseActivityPanel activity={activity} isLoading={isLoading} onRefresh={fetchData} />

      {showAddForm && (
        <div className="bg-card rounded-lg shadow-sm border border-blue-200 dark:border-blue-500/30 p-5 space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Add New Noise Rule</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Name</label>
              <input
                value={newRule.name}
                onChange={e => setNewRule(d => ({ ...d, name: e.target.value }))}
                className="w-full px-3 py-1.5 border border-input rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="e.g., My Custom Alert"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Category</label>
              <select
                value={newRule.category}
                onChange={e => setNewRule(d => ({ ...d, category: e.target.value }))}
                className="w-full px-3 py-1.5 border border-input rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Regex Pattern (case-insensitive)</label>
            <input
              value={newRule.pattern}
              onChange={e => setNewRule(d => ({ ...d, pattern: e.target.value }))}
              className="w-full px-3 py-1.5 border border-input rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="^Alert: .+ from server"
            />
          </div>
          <RuleModeSelector
            idPrefix="new"
            value={newRule.mode}
            onChange={mode => setNewRule(d => ({ ...d, mode }))}
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Description (optional)</label>
              <input
                value={newRule.description}
                onChange={e => setNewRule(d => ({ ...d, description: e.target.value }))}
                className="w-full px-3 py-1.5 border border-input rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            {newRule.mode !== 'never_noise' && (
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Dedup Window (days, optional)</label>
                <input
                  type="number"
                  value={newRule.dedupWindowDays}
                  onChange={e => setNewRule(d => ({ ...d, dedupWindowDays: e.target.value }))}
                  className="w-full px-3 py-1.5 border border-input rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Leave empty = always noise"
                  min="1" max="90"
                />
              </div>
            )}
          </div>
          {newRule.mode !== 'never_noise' && (
            <SenderConditionFields
              idPrefix="new-rule"
              senderPattern={newRule.senderPattern}
              autoCloseFromPeople={newRule.autoCloseFromPeople}
              onChange={(patch) => setNewRule(r => ({ ...r, ...patch }))}
            />
          )}
          <div className="flex items-center gap-2">
            <button onClick={handleCreate} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium">
              <Plus className="w-3.5 h-3.5" /> Create Rule
            </button>
            <button onClick={() => setShowAddForm(false)} className="flex items-center gap-1.5 px-4 py-2 bg-muted hover:bg-secondary text-foreground/85 rounded-lg text-xs font-medium">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Rules list */}
      <div className="space-y-2">
        {rules.map(rule => (
          <RuleRow
            key={rule.id}
            rule={rule}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
          />
        ))}
        {rules.length === 0 && (
          <div className="bg-card rounded-lg border border-border p-8 text-center">
            <p className="text-sm text-muted-foreground">No noise rules configured.</p>
          </div>
        )}
      </div>
    </div>
  );
}
