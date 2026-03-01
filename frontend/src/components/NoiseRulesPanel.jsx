import { useState, useEffect, useCallback } from 'react';
import {
  VolumeX, Plus, Trash2, Edit3, Save, X, CheckCircle, XCircle,
  RefreshCw, TestTube, ChevronDown, ChevronUp, ToggleLeft, ToggleRight,
} from 'lucide-react';
import { noiseRulesAPI } from '../services/api';

const CATEGORIES = [
  { value: 'infrastructure', label: 'Infrastructure', color: 'bg-blue-100 text-blue-700' },
  { value: 'security', label: 'Security', color: 'bg-red-100 text-red-700' },
  { value: 'monitoring', label: 'Monitoring', color: 'bg-yellow-100 text-yellow-700' },
  { value: 'vendor', label: 'Vendor', color: 'bg-purple-100 text-purple-700' },
  { value: 'spam', label: 'Spam', color: 'bg-gray-100 text-gray-700' },
  { value: 'custom', label: 'Custom', color: 'bg-green-100 text-green-700' },
];

function getCategoryStyle(category) {
  return CATEGORIES.find(c => c.value === category)?.color || 'bg-gray-100 text-gray-700';
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
      dedupWindowDays: rule.dedupWindowDays || '',
    });
    setIsEditing(true);
  };

  const saveEdit = async () => {
    await onUpdate(rule.id, {
      ...editData,
      dedupWindowDays: editData.dedupWindowDays ? parseInt(editData.dedupWindowDays) : null,
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
    <div className={`border rounded-lg transition-all ${rule.isEnabled ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50 opacity-60'}`}>
      <div className="px-4 py-3 flex items-center gap-3">
        <button onClick={toggleEnabled} className="flex-shrink-0" title={rule.isEnabled ? 'Disable rule' : 'Enable rule'}>
          {rule.isEnabled
            ? <ToggleRight className="w-5 h-5 text-green-500" />
            : <ToggleLeft className="w-5 h-5 text-gray-400" />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-900 truncate">{rule.name}</span>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${getCategoryStyle(rule.category)}`}>
              {rule.category}
            </span>
            {rule.dedupWindowDays && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-indigo-100 text-indigo-700">
                dedup: {rule.dedupWindowDays}d
              </span>
            )}
          </div>
          {rule.description && (
            <p className="text-xs text-gray-500 mt-0.5 truncate">{rule.description}</p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-gray-400 tabular-nums">{rule.matchCount} matches</span>
          <button onClick={() => setExpanded(!expanded)} className="p-1 hover:bg-gray-100 rounded">
            {expanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
          </button>
          <button onClick={startEdit} className="p-1 hover:bg-blue-50 rounded text-blue-600">
            <Edit3 className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => onDelete(rule.id)} className="p-1 hover:bg-red-50 rounded text-red-500">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Expanded details / edit */}
      {(expanded || isEditing) && (
        <div className="px-4 pb-3 border-t border-gray-100 pt-3 space-y-3">
          {isEditing ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
                  <input
                    value={editData.name}
                    onChange={e => setEditData(d => ({ ...d, name: e.target.value }))}
                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                  <select
                    value={editData.category}
                    onChange={e => setEditData(d => ({ ...d, category: e.target.value }))}
                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Regex Pattern</label>
                <input
                  value={editData.pattern}
                  onChange={e => setEditData(d => ({ ...d, pattern: e.target.value }))}
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="^Some regex pattern"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
                  <input
                    value={editData.description}
                    onChange={e => setEditData(d => ({ ...d, description: e.target.value }))}
                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Dedup Window (days)</label>
                  <input
                    type="number"
                    value={editData.dedupWindowDays}
                    onChange={e => setEditData(d => ({ ...d, dedupWindowDays: e.target.value }))}
                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="Leave empty for always-noise"
                    min="1"
                    max="90"
                  />
                  <p className="text-[10px] text-gray-400 mt-0.5">If set, only marks as noise when a same-subject ticket exists within this window</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={saveEdit} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium">
                  <Save className="w-3.5 h-3.5" /> Save
                </button>
                <button onClick={() => setIsEditing(false)} className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-xs font-medium">
                  <X className="w-3.5 h-3.5" /> Cancel
                </button>
                <button onClick={handleTest} disabled={isTesting} className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-700 rounded-lg text-xs font-medium">
                  <TestTube className="w-3.5 h-3.5" /> {isTesting ? 'Testing...' : 'Test Pattern'}
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <div>
                <span className="text-[10px] uppercase font-medium text-gray-400">Pattern</span>
                <code className="block text-xs font-mono text-gray-700 bg-gray-50 px-2 py-1 rounded mt-0.5 break-all">{rule.pattern}</code>
              </div>
              {rule.description && (
                <div>
                  <span className="text-[10px] uppercase font-medium text-gray-400">Description</span>
                  <p className="text-xs text-gray-600 mt-0.5">{rule.description}</p>
                </div>
              )}
              <button onClick={handleTest} disabled={isTesting} className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-700 rounded-lg text-xs font-medium">
                <TestTube className="w-3.5 h-3.5" /> {isTesting ? 'Testing...' : 'Test Pattern'}
              </button>
            </div>
          )}

          {testResult && (
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
              {testResult.error ? (
                <p className="text-xs text-red-600">{testResult.error}</p>
              ) : (
                <>
                  <p className="text-xs font-medium text-gray-700">
                    Matches <span className="text-blue-600 font-bold">{testResult.matchCount}</span> of {testResult.totalTickets} tickets ({testResult.percentage}%)
                  </p>
                  {testResult.sampleSubjects?.length > 0 && (
                    <div className="mt-2 space-y-0.5 max-h-32 overflow-y-auto">
                      {testResult.sampleSubjects.map((s, i) => (
                        <p key={i} className="text-[11px] text-gray-500 truncate">{s}</p>
                      ))}
                    </div>
                  )}
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
    name: '', pattern: '', description: '', category: 'custom', dedupWindowDays: '',
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
        dedupWindowDays: newRule.dedupWindowDays ? parseInt(newRule.dedupWindowDays) : null,
      });
      setShowAddForm(false);
      setNewRule({ name: '', pattern: '', description: '', category: 'custom', dedupWindowDays: '' });
      setStatus({ success: true, message: 'Rule created. Run backfill to apply to existing tickets.' });
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
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <VolumeX className="w-5 h-5 text-amber-600" />
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
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-gray-900">{stats.totalTickets?.toLocaleString()}</p>
              <p className="text-[10px] uppercase font-medium text-gray-500">Total Tickets</p>
            </div>
            <div className="bg-green-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-green-700">{stats.actionableTickets?.toLocaleString()}</p>
              <p className="text-[10px] uppercase font-medium text-green-600">Actionable</p>
            </div>
            <div className="bg-amber-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-amber-700">{stats.noiseTickets?.toLocaleString()}</p>
              <p className="text-[10px] uppercase font-medium text-amber-600">Noise</p>
            </div>
            <div className="bg-blue-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-blue-700">{stats.noisePercentage}%</p>
              <p className="text-[10px] uppercase font-medium text-blue-600">Noise Rate</p>
            </div>
          </div>
        </div>
      )}

      {/* Status message */}
      {status && (
        <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${status.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {status.success ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          {status.message}
          <button onClick={() => setStatus(null)} className="ml-auto p-0.5 hover:bg-white/50 rounded">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Add new rule form */}
      {showAddForm && (
        <div className="bg-white rounded-lg shadow-sm border border-blue-200 p-5 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900">Add New Noise Rule</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
              <input
                value={newRule.name}
                onChange={e => setNewRule(d => ({ ...d, name: e.target.value }))}
                className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="e.g., My Custom Alert"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
              <select
                value={newRule.category}
                onChange={e => setNewRule(d => ({ ...d, category: e.target.value }))}
                className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Regex Pattern (case-insensitive)</label>
            <input
              value={newRule.pattern}
              onChange={e => setNewRule(d => ({ ...d, pattern: e.target.value }))}
              className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="^Alert: .+ from server"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Description (optional)</label>
              <input
                value={newRule.description}
                onChange={e => setNewRule(d => ({ ...d, description: e.target.value }))}
                className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Dedup Window (days, optional)</label>
              <input
                type="number"
                value={newRule.dedupWindowDays}
                onChange={e => setNewRule(d => ({ ...d, dedupWindowDays: e.target.value }))}
                className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Leave empty = always noise"
                min="1" max="90"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleCreate} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium">
              <Plus className="w-3.5 h-3.5" /> Create Rule
            </button>
            <button onClick={() => setShowAddForm(false)} className="flex items-center gap-1.5 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-xs font-medium">
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
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
            <p className="text-sm text-gray-500">No noise rules configured.</p>
          </div>
        )}
      </div>
    </div>
  );
}
