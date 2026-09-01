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
    });
    setIsEditing(true);
  };

  const saveEdit = async () => {
    await onUpdate(rule.id, {
      ...editData,
      // Dedup windows only make sense for noise-flagging rules.
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

export default function NoiseRulesPanel() {
  const [rules, setRules] = useState([]);
  const [stats, setStats] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [newRule, setNewRule] = useState({
    name: '', pattern: '', description: '', category: 'custom', mode: 'noise', dedupWindowDays: '',
  });

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [rulesRes, statsRes] = await Promise.all([
        noiseRulesAPI.getAll(),
        noiseRulesAPI.getStats(),
      ]);
      setRules(rulesRes.data || []);
      setStats(statsRes.data || null);
    } catch (e) {
      setStatus({ success: false, message: e.message });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleCreate = async () => {
    if (!newRule.name || !newRule.pattern) {
      setStatus({ success: false, message: 'Name and pattern are required' });
      return;
    }
    try {
      await noiseRulesAPI.create({
        ...newRule,
        dedupWindowDays: newRule.mode !== 'never_noise' && newRule.dedupWindowDays
          ? parseInt(newRule.dedupWindowDays)
          : null,
      });
      setShowAddForm(false);
      setNewRule({ name: '', pattern: '', description: '', category: 'custom', mode: 'noise', dedupWindowDays: '' });
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
