import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { assignmentAPI } from '../../services/api';
import { readSSEStream } from '../../hooks/useStreamingFetch';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Plus, Trash2, Loader2, Brain, CheckCircle, XCircle, RotateCcw,
  ChevronDown, ChevronRight, Wrench, AlertTriangle,
  Search, Clock, Save, Upload, FileText, X, MapPin, History,
  Sparkles, ArrowUpDown, SlidersHorizontal, CalendarDays,
  Folder, GitMerge, CheckSquare, Square, HelpCircle, Database,
  ShieldCheck, Gauge, Zap,
} from 'lucide-react';
import {
  CopyBadge, ToolCallCard, StreamContent,
  cleanTranscript, processStreamEvent,
} from './StreamingComponents';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';
import { useWorkspace } from '../../contexts/WorkspaceContext';

const PROFICIENCY_LEVELS = [
  { value: 'basic', label: 'Basic', num: '1', color: 'bg-yellow-100 text-yellow-800' },
  { value: 'intermediate', label: 'Comfortable', num: '2', color: 'bg-blue-100 text-blue-800' },
  { value: 'advanced', label: 'Advanced', num: '3', color: 'bg-indigo-100 text-indigo-800' },
  { value: 'expert', label: 'Expert / SME', num: '4', color: 'bg-green-100 text-green-800' },
];

const CATEGORY_GROUPS = [
  { label: 'Identity & Access', keywords: ['permission', 'active directory', 'password', 'mfa', 'licensing', 'license'] },
  { label: 'End User Support', keywords: ['software', 'onboarding', 'offboarding', 'bst', 'it orders', 'purchase'] },
  { label: 'Devices & Hardware', keywords: ['workstation', 'mobile', 'peripheral', 'printer', 'hololens', 'computer'] },
  { label: 'Collaboration', keywords: ['sharepoint', 'coreshack', 'boardroom', 'a/v'] },
  { label: 'Infrastructure & Cloud', keywords: ['cloud', 'devops', 'network', 'server', 'vpn', 'remote access'] },
  { label: 'Security', keywords: ['security', 'incident', 'beyondtrust', 'maintenance', 'compliance'] },
  { label: 'Automation', keywords: ['scripting', 'automation'] },
];

const RECLASSIFICATION_MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', detail: 'Default for bulk cleanup. Lower cost and fast enough for category matching.' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', detail: 'Use only for spot checks or difficult tickets where reasoning quality matters more than cost.' },
];

const RECLASSIFICATION_CONCURRENCY_OPTIONS = [5, 10, 20];
const RECLASSIFICATION_BATCH_OPTIONS = [25, 50, 100, 200, 250, 500];

function mergeReclassificationResults(existing = [], incoming = []) {
  const byTicketId = new Map();
  [...existing, ...incoming].forEach((result) => {
    const ticketId = Number(result?.ticketId);
    if (Number.isInteger(ticketId)) byTicketId.set(ticketId, result);
  });
  return [...byTicketId.values()];
}

function getCategoryGroup(name) {
  const lower = name.toLowerCase();
  for (const group of CATEGORY_GROUPS) {
    if (group.keywords.some((kw) => lower.includes(kw))) return group.label;
  }
  return 'Other';
}

// ─── Duplicate Detector ──────────────────────────────────────────────────

function DuplicateDetector({ onMerged }) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [merging, setMerging] = useState(null);
  const [msg, setMsg] = useState(null);

  const handleDetect = async () => {
    try { setLoading(true); const res = await assignmentAPI.detectDuplicateCategories(); setGroups(res?.data || []); setScanned(true); } catch (err) { console.error('Failed to detect duplicates:', err); } finally { setLoading(false); }
  };

  const handleMerge = async (keepId, mergeIds, keepName) => {
    try { setMerging(keepId); await assignmentAPI.mergeCategories({ keepId, mergeIds }); setMsg(`Merged into "${keepName}"`); setGroups((prev) => prev.filter((g) => g.keepId !== keepId)); onMerged?.(); setTimeout(() => setMsg(null), 3000); } catch (err) { console.error('Merge failed:', err); } finally { setMerging(null); }
  };

  return (
    <div className="mb-3">
      <div className="flex items-center gap-2">
        <button onClick={handleDetect} disabled={loading} className="px-3 py-1.5 border rounded-lg text-xs font-medium hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1 transition-colors">
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
          Detect Duplicates
        </button>
        {scanned && groups.length === 0 && <span className="text-xs text-green-600">No duplicates found</span>}
        {msg && <span className="text-xs text-green-600">{msg}</span>}
      </div>
      {groups.length > 0 && (
        <div className="mt-3 space-y-2">
          {groups.map((group) => (
            <div key={group.keepId} className="border border-orange-200 bg-orange-50 rounded-lg p-3 flex items-start justify-between">
              <div>
                <p className="text-sm font-medium text-orange-800">Keep: <span className="font-bold">{group.keepName}</span></p>
                {group.duplicates.map((dup) => <p key={dup.id} className="text-xs text-orange-700">Merge: {dup.name} ({Math.round(dup.score * 100)}%)</p>)}
              </div>
              <button onClick={() => handleMerge(group.keepId, group.duplicates.map((d) => d.id), group.keepName)} disabled={merging === group.keepId} className="px-3 py-1.5 bg-orange-600 text-white rounded-lg text-xs font-medium hover:bg-orange-700 disabled:opacity-50 flex-shrink-0">
                {merging === group.keepId ? 'Merging...' : 'Merge'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Technician Editor Panel ─────────────────────────────────────────────

function TechnicianEditor({ tech, categories, savedMappings, onClose, onSaved, onAnalyze }) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [catFilter, setCatFilter] = useState('');

  useEffect(() => {
    const initial = {};
    for (const m of savedMappings) {
      if (m.technicianId === tech.id) {
        initial[m.competencyCategoryId] = m.proficiencyLevel;
      }
    }
    setDraft(initial);
    setSaveMsg(null);
  }, [tech.id, savedMappings]);

  const savedMap = {};
  for (const m of savedMappings) {
    if (m.technicianId === tech.id) savedMap[m.competencyCategoryId] = m.proficiencyLevel;
  }

  const hasChanges = JSON.stringify(draft) !== JSON.stringify(savedMap);

  const handleChange = (catId, level) => {
    setDraft((prev) => {
      const next = { ...prev };
      if (level === '') delete next[catId];
      else next[catId] = level;
      return next;
    });
  };

  const handleSave = async () => {
    const arr = Object.entries(draft).map(([catId, level]) => ({
      competencyCategoryId: parseInt(catId), proficiencyLevel: level,
    }));
    try {
      setSaving(true);
      await assignmentAPI.updateTechCompetencies(tech.id, arr);
      setSaveMsg('Saved');
      onSaved?.();
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (err) {
      setSaveMsg(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setDraft({ ...savedMap });
    setSaveMsg(null);
  };

  // Group categories
  const grouped = {};
  const filteredCats = categories.filter((c) =>
    !catFilter || c.name.toLowerCase().includes(catFilter.toLowerCase()),
  );
  for (const cat of filteredCats) {
    const group = getCategoryGroup(cat.name);
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(cat);
  }

  const initials = tech.name.split(' ').map((n) => n[0]).join('').slice(0, 2);
  const latestRun = tech.competencyRuns?.[0];
  const mappedCount = Object.keys(draft).length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="bg-gradient-to-r from-purple-50 to-blue-50 px-5 py-4 border-b border-purple-100 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {tech.photoUrl ? (
              <img src={tech.photoUrl} alt="" className="w-10 h-10 rounded-full object-cover border-2 border-white shadow-sm" />
            ) : (
              <span className="w-10 h-10 rounded-full bg-purple-200 text-purple-700 text-sm font-bold flex items-center justify-center border-2 border-white shadow-sm">{initials}</span>
            )}
            <div>
              <h3 className="text-base font-bold text-slate-900">{tech.name}</h3>
              <div className="flex items-center gap-3 text-xs text-slate-500">
                {tech.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {tech.location}</span>}
                <span>{mappedCount} skill{mappedCount !== 1 ? 's' : ''} mapped</span>
                {latestRun?.decision === 'auto_applied' && <span className="text-green-600 font-medium">LLM analyzed</span>}
                {latestRun?.decision === 'preserved_existing' && <span className="text-amber-600 font-medium">LLM preserved</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => onAnalyze(tech.id)} className="px-3 py-1.5 bg-purple-600 text-white rounded-lg text-xs font-semibold hover:bg-purple-700 flex items-center gap-1.5 shadow-sm">
              <Brain className="w-3.5 h-3.5" /> Run LLM Analysis
            </button>
            {latestRun && (
              <button onClick={() => navigate(`/assignments/competency-run/${latestRun.id}`)} className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium hover:bg-slate-50 flex items-center gap-1">
                <History className="w-3.5 h-3.5" /> Last Run
              </button>
            )}
            <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Editor body */}
      <div className="px-5 py-4 flex-1 overflow-hidden flex flex-col">
        {/* Search + actions bar */}
        <div className="flex items-center gap-3 mb-4 flex-shrink-0">
          <div className="relative flex-1 max-w-xs">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input type="text" value={catFilter} onChange={(e) => setCatFilter(e.target.value)} placeholder="Filter categories..." className="w-full pl-8 pr-3 py-1.5 border rounded-lg text-xs bg-slate-50 focus:bg-white" />
          </div>
          <div className="flex items-center gap-2 ml-auto">
            {hasChanges && <span className="text-xs text-orange-600 font-medium">Unsaved changes</span>}
            {saveMsg && <span className={`text-xs font-medium ${saveMsg.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}>{saveMsg}</span>}
            <button onClick={handleReset} disabled={!hasChanges} className="px-3 py-1.5 border rounded-lg text-xs font-medium hover:bg-slate-50 disabled:opacity-30 flex items-center gap-1">
              <RotateCcw className="w-3 h-3" /> Reset
            </button>
            <button onClick={handleSave} disabled={!hasChanges || saving} className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5 shadow-sm">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
            </button>
          </div>
        </div>

        {/* Grouped categories — single column, full names */}
        <div className="space-y-5 flex-1 overflow-y-auto pr-1">
          {Object.entries(grouped).map(([groupName, cats]) => (
            <div key={groupName}>
              <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">{groupName}</h4>
              <div className="space-y-1">
                {cats.map((cat) => {
                  const level = draft[cat.id] || '';
                  const saved = savedMap[cat.id] || '';
                  const changed = level !== saved;
                  const levelInfo = PROFICIENCY_LEVELS.find((l) => l.value === level);
                  return (
                    <div key={cat.id} className={`flex items-center justify-between rounded-lg px-3 py-2 border transition-colors ${changed ? 'border-orange-300 bg-orange-50' : 'border-slate-100 bg-slate-50 hover:bg-white'}`}>
                      <span className="text-sm text-slate-700 flex-1 mr-3">{cat.name}</span>
                      <select
                        value={level}
                        onChange={(e) => handleChange(cat.id, e.target.value)}
                        className={`text-xs rounded-md px-2 py-1.5 border cursor-pointer font-medium min-w-[120px] ${levelInfo ? levelInfo.color : 'text-slate-400 bg-white'}`}
                      >
                        <option value="">Not set</option>
                        {PROFICIENCY_LEVELS.map((l) => <option key={l.value} value={l.value}>{l.num} — {l.label}</option>)}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ParentCategoryPicker({ value, categories, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const selected = categories.find((category) => String(category.id) === String(value));
  const filtered = categories.filter((category) => (
    !query.trim() || category.name.toLowerCase().includes(query.trim().toLowerCase())
  ));

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((prev) => !prev);
          setQuery('');
        }}
        className="flex h-full min-h-[34px] w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
      >
        <span className="truncate">{selected ? selected.name : 'Top-level skill'}</span>
        <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-[min(360px,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter parent skills..."
              className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-8 pr-2 text-xs outline-none focus:border-blue-300 focus:bg-white"
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            <button
              type="button"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs font-semibold ${
                !value ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-50'
              }`}
            >
              <span>Top-level skill</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">none</span>
            </button>
            {filtered.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => {
                  onChange(String(category.id));
                  setOpen(false);
                }}
                className={`mt-1 flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-xs ${
                  String(value) === String(category.id) ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className="truncate font-medium">{category.name}</span>
                <span className="flex-shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">parent</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-2.5 py-4 text-center text-xs text-slate-400">No matching skills</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function normalizeSuggestionText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token && !['and', 'or', 'the', 'for', 'with', 'to', 'of', 'in'].includes(token))
    .join(' ');
}

function similarityScore(a, b) {
  const left = new Set(normalizeSuggestionText(a).split(' ').filter(Boolean));
  const right = new Set(normalizeSuggestionText(b).split(' ').filter(Boolean));
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / Math.max(left.size, right.size);
}

function getSuggestionSignals(suggestion, activeCategories) {
  const descriptionLength = suggestion.description?.length || 0;
  const duplicateTarget = activeCategories.find((category) => (
    normalizeSuggestionText(category.name) === normalizeSuggestionText(suggestion.name)
      || similarityScore(category.name, suggestion.name) >= 0.58
  ));
  const hasParent = Boolean(suggestion.parentId || suggestion.parent?.id);
  const confidence = hasParent && descriptionLength >= 35 ? 'high' : descriptionLength >= 20 ? 'medium' : 'low';
  return { confidence, duplicateTarget };
}

function AddCategoryModal({ open, activeCategories, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setParentId('');
    setError(null);
  }, [open]);

  if (!open) return null;

  const create = async () => {
    if (!name.trim()) {
      setError('Category name is required');
      return;
    }
    try {
      setSaving(true);
      setError(null);
      await assignmentAPI.createCategory({
        name: name.trim(),
        description: description.trim() || null,
        parentId: parentId ? Number(parentId) : null,
      });
      await onCreated?.();
      onClose();
    } catch (err) {
      setError(err.message || 'Could not add category');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
      <div className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-bold text-slate-950">
              <Plus className="h-5 w-5 text-purple-600" />
              Add Category
            </h3>
            <p className="mt-1 text-sm text-slate-500">Create a category directly when an AI suggestion is close but not quite right.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-5 grid gap-3">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold outline-none transition focus:border-purple-300 focus:ring-2 focus:ring-purple-100"
            placeholder="Category name"
          />
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className="min-h-[88px] rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none transition focus:border-purple-300 focus:ring-2 focus:ring-purple-100"
            placeholder="Description (optional)"
          />
          <ParentCategoryPicker
            value={parentId}
            categories={activeCategories.filter((category) => !category.parentId)}
            onChange={setParentId}
          />
        </div>
        {error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
            Cancel
          </button>
          <button type="button" onClick={create} disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-purple-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-purple-700 disabled:opacity-50">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add Category
          </button>
        </div>
      </div>
    </div>
  );
}

function CategorySuggestionsTab({ onCountChange }) {
  const PAGE_SIZE_OPTIONS = [15, 25, 50];
  const [suggestions, setSuggestions] = useState([]);
  const [activeCategories, setActiveCategories] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [selectedIds, setSelectedIds] = useState([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);
  const [bulkMergeTarget, setBulkMergeTarget] = useState('');
  const [pageSize, setPageSize] = useState(15);
  const [actingIds, setActingIds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [expandedDescriptions, setExpandedDescriptions] = useState([]);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await assignmentAPI.getCompetencies();
      const payload = res?.data || {};
      setSuggestions(payload.suggestedCategories || []);
      setActiveCategories(payload.categories || []);
      onCountChange?.(payload.suggestedCategories?.length || 0);
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Could not load category suggestions' });
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const suggestion of suggestions) {
        if (!next[suggestion.id]) {
          next[suggestion.id] = {
            name: suggestion.name || '',
            description: suggestion.description || '',
            parentId: suggestion.parentId ? String(suggestion.parentId) : '',
          };
        }
      }
      return next;
    });
  }, [suggestions]);

  useEffect(() => { setPage(1); }, [query, filter, sort, pageSize]);

  const enrichedSuggestions = suggestions.map((suggestion) => ({
    ...suggestion,
    signals: getSuggestionSignals(suggestion, activeCategories),
  }));

  const filteredSuggestions = enrichedSuggestions
    .filter((suggestion) => {
      const needle = query.trim().toLowerCase();
      if (needle) {
        const haystack = [suggestion.name, suggestion.description, suggestion.parent?.name, suggestion.source]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (filter === 'high') return suggestion.signals.confidence === 'high';
      if (filter === 'medium') return suggestion.signals.confidence === 'medium';
      if (filter === 'duplicates') return Boolean(suggestion.signals.duplicateTarget);
      if (filter === 'top') return !suggestion.parentId;
      if (filter === 'sub') return Boolean(suggestion.parentId);
      return true;
    })
    .sort((a, b) => {
      if (sort === 'oldest') return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'confidence') {
        const order = { high: 0, medium: 1, low: 2 };
        return order[a.signals.confidence] - order[b.signals.confidence];
      }
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });

  const totalPages = Math.max(1, Math.ceil(filteredSuggestions.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageItems = filteredSuggestions.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selectedSet = new Set(selectedIds);
  const selectedSuggestions = suggestions.filter((suggestion) => selectedSet.has(suggestion.id));
  const allFilteredSelected = filteredSuggestions.length > 0 && filteredSuggestions.every((suggestion) => selectedSet.has(suggestion.id));
  const targetOptions = activeCategories;
  const showingStart = filteredSuggestions.length ? ((safePage - 1) * pageSize) + 1 : 0;
  const showingEnd = Math.min(safePage * pageSize, filteredSuggestions.length);

  const updateDraft = (id, patch) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  };

  const toggleSelected = (id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((candidate) => candidate !== id) : [...prev, id]));
  };

  const toggleAllFiltered = () => {
    setSelectedIds((prev) => {
      if (allFilteredSelected) {
        const filteredIds = new Set(filteredSuggestions.map((suggestion) => suggestion.id));
        return prev.filter((id) => !filteredIds.has(id));
      }
      return [...new Set([...prev, ...filteredSuggestions.map((suggestion) => suggestion.id)])];
    });
  };

  const toggleDescription = (id) => {
    setExpandedDescriptions((prev) => (
      prev.includes(id) ? prev.filter((candidate) => candidate !== id) : [...prev, id]
    ));
  };

  const reviewOne = async (suggestion, action, targetCategoryId = null) => {
    const draft = drafts[suggestion.id] || {};
    if (action === 'approve' && !draft.name?.trim()) {
      setMessage({ type: 'error', text: 'A category name is required before approval.' });
      return;
    }
    if (action === 'merge' && !targetCategoryId) {
      setMessage({ type: 'error', text: 'Choose a category before merging.' });
      return;
    }

    setActingIds((prev) => [...new Set([...prev, suggestion.id])]);
    setMessage(null);
    try {
      const payload = action === 'merge'
        ? { action, targetCategoryId: Number(targetCategoryId) }
        : {
          action,
          name: draft.name?.trim(),
          description: draft.description || null,
          parentId: draft.parentId ? Number(draft.parentId) : null,
        };
      await assignmentAPI.reviewCategorySuggestion(suggestion.id, payload);
      setSelectedIds((prev) => prev.filter((id) => id !== suggestion.id));
      setMessage({ type: 'success', text: `${suggestion.name} ${action === 'approve' ? 'approved' : action === 'merge' ? 'merged' : 'rejected'}.` });
      await fetchData();
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Could not review category suggestion' });
    } finally {
      setActingIds((prev) => prev.filter((id) => id !== suggestion.id));
    }
  };

  const reviewSelected = async (action) => {
    if (!selectedSuggestions.length) return;
    if (action === 'merge' && !bulkMergeTarget) {
      setMessage({ type: 'error', text: 'Choose a merge target before merging selected suggestions.' });
      return;
    }
    if (action === 'reject' && !confirm(`Reject ${selectedSuggestions.length} selected suggestion${selectedSuggestions.length === 1 ? '' : 's'}?`)) return;
    setActingIds(selectedSuggestions.map((suggestion) => suggestion.id));
    setMessage(null);
    try {
      for (const suggestion of selectedSuggestions) {
        const draft = drafts[suggestion.id] || {};
        const payload = action === 'merge'
          ? { action, targetCategoryId: Number(bulkMergeTarget) }
          : {
            action,
            name: draft.name?.trim() || suggestion.name,
            description: draft.description || null,
            parentId: draft.parentId ? Number(draft.parentId) : null,
          };
        await assignmentAPI.reviewCategorySuggestion(suggestion.id, payload);
      }
      setMessage({ type: 'success', text: `${selectedSuggestions.length} suggestion${selectedSuggestions.length === 1 ? '' : 's'} ${action === 'approve' ? 'approved' : action === 'merge' ? 'merged' : 'rejected'}.` });
      setSelectedIds([]);
      setBulkMergeTarget('');
      await fetchData();
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Bulk review failed' });
    } finally {
      setActingIds([]);
    }
  };

  return (
    <div className="space-y-4">
      <AddCategoryModal open={showAddCategory} activeCategories={activeCategories} onClose={() => setShowAddCategory(false)} onCreated={fetchData} />

      <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-purple-50 text-purple-600">
            <Sparkles className="h-7 w-7" />
          </div>
          <div>
            <h2 className="flex items-center gap-2 text-2xl font-bold text-slate-950">
              AI Suggested Categories
              <span className="rounded-full bg-purple-100 px-2.5 py-1 text-sm font-bold text-purple-700">{suggestions.length}</span>
            </h2>
            <p className="mt-1 text-sm text-slate-500">AI analyzed competencies and found potential new categories. Review and take action.</p>
          </div>
        </div>
        <button type="button" onClick={() => setShowAddCategory(true)} className="inline-flex items-center justify-center gap-2 rounded-xl border border-purple-200 bg-white px-4 py-2.5 text-sm font-bold text-purple-700 shadow-sm transition hover:bg-purple-50">
          <Plus className="h-4 w-4" />
          Add Category
        </button>
      </div>

      {message && (
        <div className={`flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm ${message.type === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
          <div className="flex items-center gap-2">
            {message.type === 'error' ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle className="h-4 w-4" />}
            <span>{message.text}</span>
          </div>
          <button type="button" onClick={() => setMessage(null)} className="rounded-lg p-1 hover:bg-white/70"><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-100 pb-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-[86px] text-sm font-bold text-slate-600">{selectedIds.length} selected</span>
            <span className="hidden h-7 w-px bg-slate-200 sm:block" />
            <button type="button" onClick={toggleAllFiltered} className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
              {allFilteredSelected ? <CheckSquare className="h-4 w-4 text-purple-600" /> : <Square className="h-4 w-4 text-slate-400" />}
              Select all
            </button>
            <button type="button" onClick={() => reviewSelected('approve')} disabled={!selectedIds.length || actingIds.length > 0} className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-40">
              <CheckCircle className="h-4 w-4" />
              Approve selected
            </button>
            <select value={bulkMergeTarget} onChange={(event) => setBulkMergeTarget(event.target.value)} disabled={!selectedIds.length} className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none disabled:opacity-40">
              <option value="">Merge target...</option>
              {targetOptions.map((category) => <option key={category.id} value={category.id}>{category.parentId ? 'Sub: ' : 'Top: '}{category.name}</option>)}
            </select>
            <button type="button" onClick={() => reviewSelected('merge')} disabled={!selectedIds.length || !bulkMergeTarget || actingIds.length > 0} className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-bold text-blue-700 transition hover:bg-blue-100 disabled:opacity-40">
              <GitMerge className="h-4 w-4" />
              Merge selected
            </button>
            <button type="button" onClick={() => reviewSelected('reject')} disabled={!selectedIds.length || actingIds.length > 0} className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-700 transition hover:bg-red-100 disabled:opacity-40">
              <XCircle className="h-4 w-4" />
              Reject selected
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} className="h-10 w-full min-w-[240px] rounded-lg border border-slate-200 pl-9 pr-3 text-sm outline-none transition focus:border-purple-300 focus:ring-2 focus:ring-purple-100 sm:w-72" placeholder="Search suggestions..." />
            </div>
            <div className="relative">
              <SlidersHorizontal className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <select value={filter} onChange={(event) => setFilter(event.target.value)} className="h-10 appearance-none rounded-lg border border-slate-200 bg-white pl-9 pr-8 text-sm font-semibold text-slate-700 outline-none">
                <option value="all">Filters</option>
                <option value="high">High confidence</option>
                <option value="medium">Medium confidence</option>
                <option value="duplicates">Potential duplicates</option>
                <option value="top">Top-level only</option>
                <option value="sub">Subcategories only</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            </div>
            <div className="relative">
              <ArrowUpDown className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <select value={sort} onChange={(event) => setSort(event.target.value)} className="h-10 appearance-none rounded-lg border border-slate-200 bg-white pl-9 pr-8 text-sm font-semibold text-slate-700 outline-none">
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="name">Name</option>
                <option value="confidence">Confidence</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            </div>
            <div className="relative">
              <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))} className="h-10 appearance-none rounded-lg border border-slate-200 bg-white pl-3 pr-8 text-sm font-semibold text-slate-700 outline-none">
                {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} per page</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            </div>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {loading && <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-purple-600" /></div>}
          {!loading && pageItems.map((suggestion) => {
            const draft = drafts[suggestion.id] || { name: suggestion.name || '', description: suggestion.description || '', parentId: suggestion.parentId ? String(suggestion.parentId) : '' };
            const isSelected = selectedSet.has(suggestion.id);
            const isActing = actingIds.includes(suggestion.id);
            const confidence = suggestion.signals.confidence;
            const duplicateTarget = suggestion.signals.duplicateTarget;
            const description = draft.description || '';
            const descriptionExpanded = expandedDescriptions.includes(suggestion.id);
            const canExpandDescription = description.length > 140;
            return (
              <div key={suggestion.id} className={`grid min-w-0 gap-3 rounded-xl border p-3 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md xl:grid-cols-[28px_minmax(0,1fr)_minmax(300px,390px)] ${isSelected ? 'border-purple-300 bg-purple-50/40 shadow-sm' : 'border-slate-200 bg-white'}`}>
                <button type="button" onClick={() => toggleSelected(suggestion.id)} className="mt-1 flex h-5 w-5 items-center justify-center rounded border border-slate-300 bg-white text-slate-400 transition hover:border-purple-300 hover:text-purple-600">
                  {isSelected ? <CheckSquare className="h-4 w-4 text-purple-600" /> : <Square className="h-4 w-4" />}
                </button>
                <div className="min-w-0">
                  <input value={draft.name} onChange={(event) => updateDraft(suggestion.id, { name: event.target.value })} className="w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm font-bold text-slate-950 outline-none transition focus:border-purple-200 focus:bg-white" />
                  <div className="mt-1 flex items-center gap-2 text-xs font-semibold text-slate-500"><Folder className="h-3.5 w-3.5" /><span>{suggestion.parent?.name || 'Create new parent category'}</span></div>
                  <textarea value={description} onChange={(event) => updateDraft(suggestion.id, { description: event.target.value })} className={`mt-2 w-full resize-none rounded-md border border-transparent bg-transparent px-1 py-1 text-sm leading-5 text-slate-600 outline-none transition focus:border-purple-200 focus:bg-white ${descriptionExpanded ? 'h-[118px]' : 'h-[62px]'}`} placeholder="Description or evidence" />
                  {canExpandDescription && (
                    <button type="button" onClick={() => toggleDescription(suggestion.id)} className="mt-1 text-xs font-bold text-purple-600 transition hover:text-purple-700">
                      {descriptionExpanded ? 'Show less' : 'Show more'}
                    </button>
                  )}
                </div>
                <div className="min-w-0 space-y-2 border-slate-100 xl:border-l xl:pl-4">
                  <div className="space-y-1.5">
                    <span className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-xs font-bold ${confidence === 'high' ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : confidence === 'medium' ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200' : 'bg-slate-100 text-slate-600 ring-1 ring-slate-200'}`}>
                      <ArrowUpDown className="h-3.5 w-3.5" />
                      {confidence === 'high' ? 'High' : confidence === 'medium' ? 'Medium' : 'Low'} confidence
                    </span>
                    {duplicateTarget && <span className="ml-2 inline-flex items-center gap-1.5 rounded-lg bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-700 ring-1 ring-amber-200"><AlertTriangle className="h-3.5 w-3.5" />Potential duplicate</span>}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-slate-500">
                      <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" />{suggestion.createdAt ? new Date(suggestion.createdAt).toLocaleString() : 'No date'}</span>
                      <span className="text-slate-400">{suggestion.source || 'technician_analysis'}</span>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold uppercase text-slate-500">Assign to category</label>
                    <select value={draft.parentId || ''} onChange={(event) => updateDraft(suggestion.id, { parentId: event.target.value })} className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-purple-300 focus:ring-2 focus:ring-purple-100">
                      <option value="">Create new parent category</option>
                      {activeCategories.filter((category) => !category.parentId).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                    </select>
                    <button type="button" onClick={() => updateDraft(suggestion.id, { parentId: '' })} className="inline-flex items-center gap-1 text-xs font-bold text-purple-600 transition hover:text-purple-700"><Plus className="h-3.5 w-3.5" />Create new parent category</button>
                  </div>
                  <div className="grid min-w-0 gap-2">
                    {isActing ? <div className="flex items-center justify-center rounded-xl bg-slate-50 py-8"><Loader2 className="h-5 w-5 animate-spin text-purple-600" /></div> : <>
                      <button type="button" onClick={() => reviewOne(suggestion, 'approve')} className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700"><CheckCircle className="h-4 w-4" />Approve</button>
                      <div className="grid grid-cols-2 gap-2">
                        <button type="button" onClick={() => reviewOne(suggestion, 'merge', draft.parentId || duplicateTarget?.id)} disabled={!draft.parentId && !duplicateTarget?.id} className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"><GitMerge className="h-3.5 w-3.5" />Merge</button>
                        <button type="button" onClick={() => reviewOne(suggestion, 'reject')} className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 transition hover:bg-red-100"><XCircle className="h-3.5 w-3.5" />Reject</button>
                      </div>
                    </>}
                  </div>
                </div>
              </div>
            );
          })}
          {!loading && filteredSuggestions.length === 0 && <div className="rounded-xl border border-dashed border-slate-200 py-14 text-center"><CheckCircle className="mx-auto h-8 w-8 text-emerald-500" /><p className="mt-3 text-sm font-semibold text-slate-700">No matching suggestions</p><p className="mt-1 text-sm text-slate-400">{suggestions.length ? 'Try clearing search or filters.' : 'New AI suggestions will appear here after competency analysis.'}</p></div>}
        </div>

        <div className="mt-4 flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-medium text-slate-500">Showing {showingStart} to {showingEnd} of {filteredSuggestions.length} suggestion{filteredSuggestions.length === 1 ? '' : 's'}</p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={safePage <= 1} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold text-slate-500 transition hover:bg-slate-50 disabled:opacity-40"><ChevronRight className="h-4 w-4 rotate-180" /></button>
            {Array.from({ length: totalPages }).map((_, index) => {
              const pageNumber = index + 1;
              return <button key={pageNumber} type="button" onClick={() => setPage(pageNumber)} className={`rounded-lg border px-3 py-2 text-sm font-bold transition ${safePage === pageNumber ? 'border-purple-300 bg-purple-50 text-purple-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>{pageNumber}</button>;
            })}
            <button type="button" onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))} disabled={safePage >= totalPages} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold text-slate-500 transition hover:bg-slate-50 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>
      </div>
    </div>
  );
}
// ─── Skills Draft / Publish Panel ────────────────────────────────────────

function MigrationControlsHelpModal({ onClose }) {
  const controls = [
    {
      icon: Upload,
      title: 'Import Summit',
      tone: 'text-blue-700 bg-blue-50 border-blue-100',
      body: 'Pulls the latest summit workshop output into an editable draft. This is for rebuilding the category/subcategory hierarchy from the workshop data before publishing.',
      safety: 'Does not change Freshservice and does not classify tickets.',
    },
    {
      icon: Save,
      title: 'Save Draft',
      tone: 'text-slate-700 bg-slate-50 border-slate-100',
      body: 'Saves edits to the draft hierarchy and legacy mapping review. Use this while cleaning names, moving subcategories, or resolving old category mappings.',
      safety: 'Draft-only. It does not affect assignment, analytics, Freshservice, or technician skills until publish.',
    },
    {
      icon: CheckCircle,
      title: 'Publish',
      tone: 'text-emerald-700 bg-emerald-50 border-emerald-100',
      body: 'Makes the current draft the active Ticket Pulse category/subcategory hierarchy for the IT workspace. It remaps internal technician competencies and existing local Ticket Pulse classifications using the reviewed mappings.',
      safety: 'Ticket Pulse database change only. It does not backfill historical Freshservice tickets.',
    },
    {
      icon: Database,
      title: 'Sync FS Objects',
      tone: 'text-indigo-700 bg-indigo-50 border-indigo-100',
      body: 'Creates any missing Freshservice custom object records for the active Ticket Pulse categories and subcategories. This keeps the Freshservice lookup lists populated.',
      safety: 'Updates Freshservice lookup object records only. It does not edit ticket history or assign tickets.',
    },
    {
      icon: FileText,
      title: 'FS Drift',
      tone: 'text-amber-700 bg-amber-50 border-amber-100',
      body: 'Compares the published Ticket Pulse hierarchy against Freshservice lookup object records. Missing means Freshservice lacks a value Ticket Pulse expects. Extra means Freshservice has a value Ticket Pulse no longer publishes.',
      safety: 'Read-only check. Safe to press any time.',
    },
    {
      icon: Brain,
      title: 'Dry Run Batch',
      tone: 'text-purple-700 bg-purple-50 border-purple-100',
      body: 'Selects the next unclassified or review-needed IT tickets and asks the selected LLM model to map each ticket to the published Ticket Pulse category/subcategory list. It returns a preview.',
      safety: 'No ticket fields are saved. No Freshservice ticket is modified.',
    },
    {
      icon: ChevronRight,
      title: 'Next Batch',
      tone: 'text-cyan-700 bg-cyan-50 border-cyan-100',
      body: 'Moves the dry-run cursor older than the last preview and analyzes the next set of matching tickets. The new results are added to the pending preview queue.',
      safety: 'Dry-run only. It does not save classifications until Apply Preview is pressed.',
    },
    {
      icon: CheckSquare,
      title: 'Apply Preview',
      tone: 'text-orange-700 bg-orange-50 border-orange-100',
      body: 'Saves the accumulated pending preview queue to Ticket Pulse local fields. This is what makes those tickets usable as canonical category/subcategory evidence.',
      safety: 'Ticket Pulse local fields only. It does not write historical category changes back to Freshservice.',
    },
    {
      icon: RotateCcw,
      title: 'Rollback',
      tone: 'text-red-700 bg-red-50 border-red-100',
      body: 'Restores the saved pre-run Ticket Pulse category fields for an applied reclassification run.',
      safety: 'Only available for completed apply runs that have not already been rolled back.',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 px-4 py-8">
      <div className="w-full max-w-5xl rounded-xl bg-white shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b bg-white px-5 py-4">
          <div>
            <h3 className="text-lg font-bold text-slate-900">Category Migration Controls</h3>
            <p className="mt-1 text-sm text-slate-500">
              These controls manage three separate things: the Ticket Pulse hierarchy, Freshservice lookup values, and local Ticket Pulse ticket reclassification.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50" aria-label="Close help">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-4">
              <ShieldCheck className="h-6 w-6 text-emerald-700" />
              <p className="mt-2 text-sm font-bold text-emerald-900">Safe boundary</p>
              <p className="mt-1 text-xs leading-5 text-emerald-800">Reclassification updates Ticket Pulse local category fields only. Historical Freshservice tickets are not rewritten.</p>
            </div>
            <div className="rounded-lg border border-purple-100 bg-purple-50 p-4">
              <Gauge className="h-6 w-6 text-purple-700" />
              <p className="mt-2 text-sm font-bold text-purple-900">Batch vs parallel</p>
              <p className="mt-1 text-xs leading-5 text-purple-800">Batch size is how many tickets are selected. Parallel is how many LLM calls run at the same time. Larger batches cost more because every dry-run ticket is one LLM classification.</p>
            </div>
            <div className="rounded-lg border border-blue-100 bg-blue-50 p-4">
              <Zap className="h-6 w-6 text-blue-700" />
              <p className="mt-2 text-sm font-bold text-blue-900">Default model</p>
              <p className="mt-1 text-xs leading-5 text-blue-800">Bulk reclassification defaults to Haiku 4.5. Sonnet is available only when you intentionally choose the higher-cost option.</p>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200">
            <div className="grid grid-cols-4 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-500">
              <span>Flow</span>
              <span className="col-span-3">What happens</span>
            </div>
            <div className="grid grid-cols-4 gap-3 px-4 py-4 text-sm">
              <div className="font-semibold text-slate-800">1. Build hierarchy</div>
              <div className="col-span-3 text-slate-600">Import Summit, edit categories/subcategories, save draft, resolve mappings, then publish.</div>
              <div className="font-semibold text-slate-800">2. Mirror options</div>
              <div className="col-span-3 text-slate-600">Run FS Drift to check Freshservice. Use Sync FS Objects only if drift shows missing lookup records.</div>
              <div className="font-semibold text-slate-800">3. Classify tickets</div>
              <div className="col-span-3 text-slate-600">Run Dry Run Batch, optionally add older tickets with Next Batch, review the pending preview queue, then Apply Preview. Apply Preview saves that queue without asking the LLM again.</div>
              <div className="font-semibold text-slate-800">4. Skill evidence</div>
              <div className="col-span-3 text-slate-600">After enough tickets have canonical categories/subcategories, competency analysis can safely update technician skills.</div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {controls.map(({ icon: Icon, title, tone, body, safety }) => (
              <div key={title} className={`rounded-lg border p-4 ${tone}`}>
                <div className="flex items-center gap-2">
                  <Icon className="h-5 w-5" />
                  <p className="text-sm font-bold">{title}</p>
                </div>
                <p className="mt-2 text-xs leading-5">{body}</p>
                <p className="mt-2 rounded-md bg-white/70 px-2 py-1 text-[11px] font-semibold leading-5">{safety}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SkillsMigrationPanel({ onPublished }) {
  const [draft, setDraft] = useState(null);
  const [skills, setSkills] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [drift, setDrift] = useState(null);
  const [reclassification, setReclassification] = useState(null);
  const [pendingReclassificationResults, setPendingReclassificationResults] = useState([]);
  const [reclassificationLimit, setReclassificationLimit] = useState(25);
  const [reclassificationModel, setReclassificationModel] = useState(RECLASSIFICATION_MODELS[0].value);
  const [reclassificationConcurrency, setReclassificationConcurrency] = useState(10);
  const [reclassificationCursor, setReclassificationCursor] = useState(null);
  const [reclassificationRuns, setReclassificationRuns] = useState([]);
  const [showControlsHelp, setShowControlsHelp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const loadDraft = useCallback(async () => {
    try {
      setLoading(true);
      const res = await assignmentAPI.getSkillDraft();
      const payload = res?.data || {};
      const activeDraft = payload.draft;
      setDraft(activeDraft || null);
      setSkills(activeDraft?.state?.skills || payload.published?.skills || []);
      setWarnings(activeDraft?.warnings || []);
      setMappings(activeDraft?.mappings || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDraft(); }, [loadDraft]);

  const loadReclassificationRuns = useCallback(async () => {
    try {
      const res = await assignmentAPI.getReclassificationRuns({ limit: 5 });
      setReclassificationRuns(res?.data || []);
    } catch {
      setReclassificationRuns([]);
    }
  }, []);

  useEffect(() => { loadReclassificationRuns(); }, [loadReclassificationRuns]);

  const updateSkill = (index, patch) => {
    setSkills((prev) => prev.map((skill, i) => (i === index ? { ...skill, ...patch } : skill)));
  };

  const updateSubskill = (skillIndex, subIndex, patch) => {
    setSkills((prev) => prev.map((skill, i) => {
      if (i !== skillIndex) return skill;
      return {
        ...skill,
        subskills: (skill.subskills || []).map((sub, j) => (j === subIndex ? { ...sub, ...patch } : sub)),
      };
    }));
  };

  const addSkill = () => setSkills((prev) => [...prev, { id: `draft-skill-${Date.now()}`, name: '', description: '', subskills: [] }]);
  const addSubskill = (skillIndex) => setSkills((prev) => prev.map((skill, i) => (i === skillIndex
    ? { ...skill, subskills: [...(skill.subskills || []), { id: `draft-subskill-${Date.now()}`, name: '', description: '' }] }
    : skill)));
  const removeSkill = (skillIndex) => setSkills((prev) => prev.filter((_, i) => i !== skillIndex));
  const removeSubskill = (skillIndex, subIndex) => setSkills((prev) => prev.map((skill, i) => (i === skillIndex
    ? { ...skill, subskills: (skill.subskills || []).filter((_, j) => j !== subIndex) }
    : skill)));
  const mappingTargetOptions = skills.flatMap((skill) => [
    { id: skill.id, label: skill.name || '(unnamed skill)', level: 'skill', skillName: skill.name || '', subskillName: null },
    ...(skill.subskills || []).map((subskill) => ({
      id: subskill.id,
      label: `${skill.name || '(unnamed skill)'} > ${subskill.name || '(unnamed subskill)'}`,
      level: 'subskill',
      skillName: skill.name || '',
      subskillName: subskill.name || '',
    })),
  ]);

  const updateMappingTarget = (mappingIndex, targetId) => {
    const target = mappingTargetOptions.find((option) => option.id === targetId);
    setMappings((prev) => prev.map((mapping, index) => {
      if (index !== mappingIndex) return mapping;
      if (!target) {
        return {
          ...mapping,
          targetSkillTempId: null,
          targetSubskillTempId: null,
          targetSkillName: null,
          targetSubskillName: null,
          status: 'unmapped',
          confidence: 'unmapped',
        };
      }
      return {
        ...mapping,
        targetSkillTempId: target.level === 'skill' ? target.id : null,
        targetSubskillTempId: target.level === 'subskill' ? target.id : null,
        targetSkillName: target.skillName,
        targetSubskillName: target.subskillName,
        status: 'mapped',
        confidence: mapping.confidence === 'exact' ? 'exact' : 'manual',
      };
    }));
  };

  const saveDraft = async () => {
    try {
      setSaving(true);
      setError(null);
      const res = await assignmentAPI.saveSkillDraft({ state: { skills }, mappings, source: draft?.source || 'manual' });
      const saved = res?.data;
      setDraft(saved);
      setSkills(saved?.state?.skills || []);
      setWarnings(saved?.warnings || []);
      setMappings(saved?.mappings || []);
      setMessage('Draft saved');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const saveMappings = async () => {
    try {
      setSaving(true);
      setError(null);
      const res = await assignmentAPI.updateSkillMappings(mappings);
      const saved = res?.data;
      setDraft(saved);
      setMappings(saved?.mappings || []);
      setMessage('Mappings saved');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const importSummit = async () => {
    try {
      setSaving(true);
      setError(null);
      const res = await assignmentAPI.importSummitSkills();
      const imported = res?.data;
      setDraft(imported);
      setSkills(imported?.state?.skills || []);
      setWarnings(imported?.warnings || []);
      setMappings(imported?.mappings || []);
      setMessage('Summit output imported as a draft');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!confirm('Publish this category hierarchy and remap existing competencies/ticket classifications? No Freshservice ticket backfill will run.')) return;
    try {
      setSaving(true);
      setError(null);
      const res = await assignmentAPI.publishSkillDraft();
      setMessage(`Published ${res?.data?.skillCount || 0} categories and ${res?.data?.subskillCount || 0} subcategories`);
      setDraft(null);
      await loadDraft();
      onPublished?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const loadDrift = async () => {
    try {
      setSaving(true);
      setError(null);
      const res = await assignmentAPI.getFreshserviceSkillDrift();
      setDrift(res?.data || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const syncFreshserviceObjects = async () => {
    try {
      setSaving(true);
      setError(null);
      const res = await assignmentAPI.syncFreshserviceSkillObjects();
      const created = res?.data?.created || {};
      setMessage(`Freshservice objects synced. Created ${created.skills?.length || 0} categories and ${created.subskills?.length || 0} subcategories.`);
      await loadDrift();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const reclassificationModelLabel = RECLASSIFICATION_MODELS.find((model) => model.value === reclassificationModel)?.label || reclassificationModel;

  const reclassifyTickets = async ({ apply = false, nextBatch = false } = {}) => {
    const selectedLimit = Number(reclassificationLimit) || 25;
    if (!apply && selectedLimit >= 250 && !confirm(`Dry run up to ${selectedLimit} tickets with ${reclassificationModelLabel}. This sends one LLM classification request per ticket and may take several minutes. Continue?`)) return;
    const pendingCount = pendingReclassificationResults.filter((result) => result.classification && !result.error).length;
    if (apply && !confirm(`Apply ${pendingCount} pending preview classification${pendingCount === 1 ? '' : 's'} to IT tickets? This saves the displayed preview queue to Ticket Pulse without calling the LLM again. Freshservice ticket history is not modified.`)) return;
    try {
      setSaving(true);
      setError(null);
      setMessage(`${apply ? 'Applying preview' : 'Dry run running'} with ${reclassificationModelLabel}, ${reclassificationConcurrency} parallel LLM call${reclassificationConcurrency === 1 ? '' : 's'}...`);
      const previewResults = pendingReclassificationResults
        .filter((result) => result.classification && !result.error)
        .map((result) => ({
          ticketId: Number(result.ticketId),
          freshserviceTicketId: result.freshserviceTicketId,
          model: result.model || reclassification.model || reclassificationModel,
          classification: result.classification,
        }))
        .filter((result) => Number.isInteger(result.ticketId));
      const previewTicketIds = previewResults
        .map((result) => Number(result.ticketId))
        .filter(Number.isInteger);
      const res = await assignmentAPI.reclassifyTickets({
        apply,
        days: 180,
        limit: selectedLimit,
        model: reclassificationModel,
        concurrency: Number(reclassificationConcurrency) || 10,
        onlyNeedsReview: true,
        ...(!apply && nextBatch && reclassificationCursor ? { createdBefore: reclassificationCursor } : {}),
        ...(apply && previewTicketIds.length ? { ticketIds: previewTicketIds, previewResults } : {}),
      });
      const data = res?.data || {};
      setReclassification(data);
      if (!apply) {
        setPendingReclassificationResults((prev) => (nextBatch
          ? mergeReclassificationResults(prev, data.results || [])
          : (data.results || [])));
      } else {
        setPendingReclassificationResults([]);
      }
      const oldestCreatedAt = (data.results || [])
        .map((result) => result.createdAt)
        .filter(Boolean)
        .sort()[0] || null;
      if (!apply && oldestCreatedAt) setReclassificationCursor(oldestCreatedAt);
      const usedModel = RECLASSIFICATION_MODELS.find((model) => model.value === data.model)?.label || data.model || reclassificationModelLabel;
      if (apply) {
        setMessage(`Applied preview: ${data.classified || 0} local Ticket Pulse classifications saved, ${data.reviewNeeded || 0} marked for review, ${data.failed || 0} failed. No Freshservice tickets were modified and no extra LLM calls were made.`);
      } else {
        const totalPending = nextBatch
          ? mergeReclassificationResults(pendingReclassificationResults, data.results || []).length
          : (data.results || []).length;
        setMessage(`Dry run complete with ${usedModel}, ${data.concurrency || reclassificationConcurrency} parallel: ${data.classified || 0} classified, ${data.reviewNeeded || 0} needing review, ${data.failed || 0} failed. Pending preview queue: ${totalPending}.`);
      }
      await loadReclassificationRuns();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const rollbackReclassificationRun = async (runId) => {
    if (!confirm(`Rollback reclassification run #${runId}? This restores the saved pre-run Ticket Pulse category fields for the affected tickets.`)) return;
    try {
      setSaving(true);
      setError(null);
      const res = await assignmentAPI.rollbackReclassificationRun(runId);
      setMessage(`Rolled back run #${runId}. Restored ${res?.data?.restoredCount || 0} tickets.`);
      await loadReclassificationRuns();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const needsReviewMappings = mappings.filter((mapping) => mapping.status !== 'mapped' || (!mapping.targetSkillTempId && !mapping.targetSubskillTempId));
  const displayReclassificationResults = pendingReclassificationResults.length
    ? pendingReclassificationResults
    : (reclassification?.results || []);
  const pendingClassifiableCount = pendingReclassificationResults.filter((result) => result.classification && !result.error).length;
  const pendingReviewNeededCount = pendingReclassificationResults.filter((result) => result.classification?.taxonomyReviewNeeded).length;
  const pendingFailedCount = pendingReclassificationResults.filter((result) => result.error).length;

  return (
    <div className="border rounded-lg bg-white">
      {showControlsHelp && <MigrationControlsHelpModal onClose={() => setShowControlsHelp(false)} />}
      <div className="border-b px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">Categories / Subcategories Draft</h3>
          <p className="text-xs text-slate-500">Ticket Pulse owns this hierarchy; Freshservice mirrors the selected category values.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setShowControlsHelp(true)} className="px-3 py-1.5 border border-blue-200 bg-blue-50 text-blue-800 rounded-lg text-xs font-medium hover:bg-blue-100 flex items-center gap-1">
            <HelpCircle className="w-3.5 h-3.5" /> Help
          </button>
          <button onClick={importSummit} disabled={saving} className="px-3 py-1.5 border rounded-lg text-xs font-medium hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1"><Upload className="w-3.5 h-3.5" /> Import Summit</button>
          <button onClick={saveDraft} disabled={saving} className="px-3 py-1.5 border rounded-lg text-xs font-medium hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1"><Save className="w-3.5 h-3.5" /> Save Draft</button>
          <button onClick={publish} disabled={saving || !draft} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" /> Publish</button>
          <button onClick={syncFreshserviceObjects} disabled={saving} className="px-3 py-1.5 border rounded-lg text-xs font-medium hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1"><Upload className="w-3.5 h-3.5" /> Sync FS Objects</button>
          <button onClick={loadDrift} disabled={saving} className="px-3 py-1.5 border rounded-lg text-xs font-medium hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1"><FileText className="w-3.5 h-3.5" /> FS Drift</button>
          <label className="flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs text-slate-600">
            <span className="font-semibold">Batch</span>
            <select value={reclassificationLimit} onChange={(event) => setReclassificationLimit(Number(event.target.value))} disabled={saving} className="bg-transparent text-xs outline-none">
              {RECLASSIFICATION_BATCH_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs text-slate-600" title="Number of ticket classifications sent to the LLM at the same time.">
            <span className="font-semibold">Parallel</span>
            <select value={reclassificationConcurrency} onChange={(event) => setReclassificationConcurrency(Number(event.target.value))} disabled={saving} className="bg-transparent text-xs outline-none">
              {RECLASSIFICATION_CONCURRENCY_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs text-slate-600" title="Model used for dry-run/apply reclassification.">
            <span className="font-semibold">Model</span>
            <select value={reclassificationModel} onChange={(event) => setReclassificationModel(event.target.value)} disabled={saving} className="bg-transparent text-xs outline-none">
              {RECLASSIFICATION_MODELS.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
            </select>
          </label>
          <button onClick={() => { setReclassificationCursor(null); reclassifyTickets({ apply: false }); }} disabled={saving} className="px-3 py-1.5 border rounded-lg text-xs font-medium hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1"><Brain className="w-3.5 h-3.5" /> Dry Run Batch</button>
          <button onClick={() => reclassifyTickets({ apply: false, nextBatch: true })} disabled={saving || !reclassificationCursor} className="px-3 py-1.5 border rounded-lg text-xs font-medium hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1"><ChevronRight className="w-3.5 h-3.5" /> Next Batch</button>
          <button onClick={() => reclassifyTickets({ apply: true })} disabled={saving || !pendingClassifiableCount} className="px-3 py-1.5 border border-amber-200 bg-amber-50 text-amber-800 rounded-lg text-xs font-medium hover:bg-amber-100 disabled:opacity-50 flex items-center gap-1"><CheckSquare className="w-3.5 h-3.5" /> Apply Preview</button>
        </div>
      </div>

      <div className="p-4 space-y-3">
        {loading && <div className="text-sm text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading draft</div>}
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
        {message && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{message}</div>}
        {reclassificationLimit >= 250 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Large batch selected. Dry run cost and time scale with ticket count. Apply Preview does not call the LLM again; it saves the displayed preview.
          </div>
        )}
        {reclassification && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 space-y-2">
            <p>
              Internal reclassification run #{reclassification.id} {reclassification.dryRun ? 'dry run' : 'apply'} scanned {reclassification.scanned || 0} tickets
              {reclassification.model ? ` with ${RECLASSIFICATION_MODELS.find((model) => model.value === reclassification.model)?.label || reclassification.model}` : ''}
              {reclassification.concurrency ? ` at ${reclassification.concurrency} parallel calls` : ''}. Freshservice ticket history was not modified.
            </p>
            {pendingReclassificationResults.length > 0 && (
              <p className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 font-semibold text-blue-800">
                Pending preview queue: {pendingReclassificationResults.length} tickets ({pendingClassifiableCount} applyable, {pendingReviewNeededCount} review-needed, {pendingFailedCount} failed). Next Batch adds to this queue; Apply Preview saves the queue.
              </p>
            )}
            <div className="grid gap-2 sm:grid-cols-4">
              <div className="rounded-md bg-white px-2 py-1 ring-1 ring-slate-200"><span className="font-semibold">{reclassification.scanned || 0}</span> scanned</div>
              <div className="rounded-md bg-white px-2 py-1 ring-1 ring-slate-200"><span className="font-semibold text-emerald-700">{reclassification.classified || 0}</span> classified</div>
              <div className="rounded-md bg-white px-2 py-1 ring-1 ring-slate-200"><span className="font-semibold text-amber-700">{reclassification.reviewNeeded || 0}</span> review-needed</div>
              <div className="rounded-md bg-white px-2 py-1 ring-1 ring-slate-200"><span className="font-semibold text-red-700">{reclassification.failed || 0}</span> failed</div>
            </div>
            {!reclassification.dryRun && (
              <p className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 font-semibold text-emerald-800">
                Saved to Ticket Pulse local category fields. This apply run can be rolled back from Recent Reclassification Runs.
              </p>
            )}
            {displayReclassificationResults.length > 0 && (
              <div className="max-h-96 overflow-y-auto rounded border border-slate-200 bg-white">
                {displayReclassificationResults.map((result) => (
                  <div key={result.ticketId} className="grid gap-1 border-b border-slate-100 px-2 py-1.5 last:border-b-0 md:grid-cols-[110px_1fr_220px]">
                    <span className="font-mono text-slate-500">FS-{result.freshserviceTicketId}</span>
                    <span className="truncate">{result.subject}</span>
                    <span className={result.error ? 'text-red-600' : result.classification?.taxonomyReviewNeeded ? 'text-amber-700' : 'text-emerald-700'}>
                      {result.error || `${result.classification?.categoryName || 'Unmapped'}${result.classification?.subcategoryName ? ` / ${result.classification.subcategoryName}` : ''}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {reclassificationRuns.length > 0 && (
          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
              <h4 className="text-xs font-semibold text-slate-700">Recent Reclassification Runs</h4>
              <button onClick={loadReclassificationRuns} disabled={saving} className="text-xs text-purple-600 hover:underline disabled:opacity-50">Refresh</button>
            </div>
            <div className="divide-y divide-slate-100">
              {reclassificationRuns.map((run) => (
                <div key={run.id} className="grid gap-2 px-3 py-2 text-xs text-slate-600 md:grid-cols-[90px_90px_1fr_120px] md:items-center">
                  <div className="font-mono">TR-{run.id}</div>
                  <div className={run.status === 'completed' ? 'text-emerald-700' : run.status === 'failed' ? 'text-red-700' : 'text-amber-700'}>
                    {run.mode} / {run.status}
                  </div>
                  <div>
                    <span>{formatDateTimeInTimezone(run.createdAt, 'America/Los_Angeles')}</span>
                    <span className="ml-2 text-slate-400">
                      scanned {run.summary?.scanned || 0}, classified {run.summary?.classified || 0}, failed {run.summary?.failed || 0}
                      {run.summary?.model ? `, ${RECLASSIFICATION_MODELS.find((model) => model.value === run.summary.model)?.label || run.summary.model}` : ''}
                      {run.summary?.concurrency ? `, ${run.summary.concurrency} parallel` : ''}
                      {run.summary?.applyFromPreview ? ', preview apply' : ''}
                    </span>
                    {run.rolledBackAt && <span className="ml-2 text-red-600">rolled back</span>}
                  </div>
                  <div className="flex justify-end">
                    {run.mode === 'apply' && run.status === 'completed' && !run.rolledBackAt && (
                      <button onClick={() => rollbackReclassificationRun(run.id)} disabled={saving} className="rounded border border-red-200 px-2 py-1 text-red-700 hover:bg-red-50 disabled:opacity-50">Rollback</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {(warnings.length > 0 || needsReviewMappings.length > 0) && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {warnings.length > 0 && <span>{warnings.length} placeholder or duplicate rows were removed. </span>}
            {needsReviewMappings.length > 0 && <span>{needsReviewMappings.length} legacy category mappings need review before publish.</span>}
          </div>
        )}

        <div className="space-y-2">
          {skills.map((skill, skillIndex) => (
            <div key={skill.id || skillIndex} className="rounded-lg border border-slate-200">
              <div className="grid gap-2 p-3 md:grid-cols-[1fr_1fr_auto]">
                <input value={skill.name || ''} onChange={(e) => updateSkill(skillIndex, { name: e.target.value })} placeholder="Category" className="rounded-lg border px-3 py-2 text-sm" />
                <input value={skill.description || ''} onChange={(e) => updateSkill(skillIndex, { description: e.target.value })} placeholder="Description" className="rounded-lg border px-3 py-2 text-sm" />
                <button onClick={() => removeSkill(skillIndex)} className="rounded-lg border px-2 text-red-500 hover:bg-red-50"><Trash2 className="w-4 h-4" /></button>
              </div>
              <div className="border-t bg-slate-50 px-3 py-2 space-y-2">
                {(skill.subskills || []).map((subskill, subIndex) => (
                  <div key={subskill.id || subIndex} className="grid gap-2 md:grid-cols-[24px_1fr_1fr_auto] items-center">
                    <span className="h-px bg-slate-300" />
                    <input value={subskill.name || ''} onChange={(e) => updateSubskill(skillIndex, subIndex, { name: e.target.value })} placeholder="Subcategory" className="rounded-lg border px-3 py-1.5 text-xs" />
                    <input value={subskill.description || ''} onChange={(e) => updateSubskill(skillIndex, subIndex, { description: e.target.value })} placeholder="Description" className="rounded-lg border px-3 py-1.5 text-xs" />
                    <button onClick={() => removeSubskill(skillIndex, subIndex)} className="rounded-lg border px-2 py-1 text-red-500 hover:bg-red-50"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
                <button onClick={() => addSubskill(skillIndex)} className="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Add subcategory</button>
              </div>
            </div>
          ))}
          <button onClick={addSkill} className="px-3 py-2 border rounded-lg text-xs font-medium hover:bg-slate-50 flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Add category</button>
        </div>

        {mappings.length > 0 && (
          <details className="rounded-lg border" open={needsReviewMappings.length > 0}>
            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              Legacy mapping review ({needsReviewMappings.length} unresolved)
            </summary>
            <div className="border-t p-3 space-y-2">
              <div className="max-h-80 overflow-y-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-left text-slate-500">
                    <tr>
                      <th className="px-2 py-2 font-semibold">Legacy skill</th>
                      <th className="px-2 py-2 font-semibold">Target category/subcategory</th>
                      <th className="px-2 py-2 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mappings.map((mapping, index) => {
                      const selectedTarget = mapping.targetSubskillTempId || mapping.targetSkillTempId || '';
                      return (
                        <tr key={mapping.legacyCategoryId || index} className="border-t">
                          <td className="px-2 py-2 font-medium text-slate-700">{mapping.legacyName}</td>
                          <td className="px-2 py-2">
                            <select value={selectedTarget} onChange={(e) => updateMappingTarget(index, e.target.value)} className="w-full rounded-lg border px-2 py-1 text-xs">
                              <option value="">Choose target</option>
                              {mappingTargetOptions.map((option) => (
                                <option key={option.id} value={option.id}>{option.label}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2 py-2">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${mapping.status === 'mapped' ? 'bg-emerald-100 text-emerald-700' : mapping.status === 'review' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                              {mapping.confidence || mapping.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <button onClick={saveMappings} disabled={saving} className="px-3 py-1.5 border rounded-lg text-xs font-medium hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1"><Save className="w-3.5 h-3.5" /> Save mappings</button>
            </div>
          </details>
        )}

        {drift && (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border p-3 text-xs">
              <p className="font-semibold text-slate-700">Freshservice lookup object drift</p>
              <p className="mt-1 text-slate-500">Category field: {drift.configured?.tpSkillCustomField}; Subcategory field: {drift.configured?.tpSubskillCustomField}</p>
              <p className="mt-1 text-slate-500">Object records: {drift.objectRecords?.skills || 0} categories; {drift.objectRecords?.subskills || 0} subcategories</p>
              <p className="mt-2 text-amber-700">Missing categories: {drift.skillDrift?.missing?.length || 0}; extra categories: {drift.skillDrift?.extra?.length || 0}</p>
              <p className="text-amber-700">Missing subcategories: {drift.subskillDrift?.missing?.length || 0}; extra subcategories: {drift.subskillDrift?.extra?.length || 0}</p>
            </div>
            <textarea readOnly value={drift.exports?.hierarchyText || ''} className="min-h-[140px] rounded-lg border p-3 font-mono text-xs text-slate-700" />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Matrix Tab (Overview + Editor) ──────────────────────────────────────

function MatrixTab({ onAnalyze, showMigrationControls = false }) {
  const [categories, setCategories] = useState([]);
  const [categoryTree, setCategoryTree] = useState([]);
  const [technicians, setTechnicians] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newCatName, setNewCatName] = useState('');
  const [newCatDesc, setNewCatDesc] = useState('');
  const [newCatParentId, setNewCatParentId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [selectedTechId, setSelectedTechId] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [compRes, techRes] = await Promise.all([
        assignmentAPI.getCompetencies(),
        assignmentAPI.getCompetencyTechnicians(),
      ]);
      const payload = compRes?.data || {};
      setCategories(payload.categories || []);
      setCategoryTree(payload.categoryTree || []);
      setMappings(payload.mappings || []);
      setTechnicians(techRes?.data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleCreateCategory = async () => {
    if (!newCatName.trim()) return;
    try {
      setSaving(true);
      await assignmentAPI.createCategory({
        name: newCatName.trim(),
        description: newCatDesc.trim() || null,
        parentId: newCatParentId ? Number(newCatParentId) : null,
      });
      setNewCatName('');
      setNewCatDesc('');
      setNewCatParentId('');
      await fetchData();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  const handleDeleteCategory = async (id) => {
    if (!confirm('Delete this category/subcategory and all its mappings?')) return;
    try { await assignmentAPI.deleteCategory(id); await fetchData(); } catch (err) { setError(err.message); }
  };

  const mappingMap = {};
  for (const m of mappings) {
    if (!mappingMap[m.technicianId]) mappingMap[m.technicianId] = {};
    mappingMap[m.technicianId][m.competencyCategoryId] = m.proficiencyLevel;
  }

  const selectedTech = technicians.find((t) => t.id === selectedTechId);
  const topLevelCategories = categories.filter((category) => !category.parentId);
  const displayCategories = (categoryTree.length ? categoryTree : topLevelCategories).flatMap((category) => [
    { ...category, depth: 0 },
    ...(category.subcategories || []).map((subcategory) => ({ ...subcategory, depth: 1, parentName: category.name })),
  ]);

  if (loading) return <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>;

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          {error} <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {showMigrationControls && <SkillsMigrationPanel onPublished={fetchData} />}

      <DuplicateDetector onMerged={fetchData} />

      {/* Swapped-axis matrix: categories as rows, technicians as columns */}
      {technicians.length > 0 && (
        <div className="overflow-x-auto border rounded-lg">
          <table className="text-sm border-collapse">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left px-3 py-3 font-medium text-slate-600 sticky left-0 bg-slate-50 z-10 min-w-[180px]">Category / Subcategory</th>
                {technicians.map((tech) => {
                  const initials = tech.name.split(' ').map((n) => n[0]).join('').slice(0, 2);
                  const isSelected = selectedTechId === tech.id;
                  return (
                    <th key={tech.id} className={`px-2 py-2 min-w-[60px] text-center cursor-pointer transition-colors ${isSelected ? 'bg-purple-100' : 'hover:bg-slate-100'}`} onClick={() => setSelectedTechId(isSelected ? null : tech.id)} title={`${tech.name} — click to edit`}>
                      <div className="flex flex-col items-center gap-1">
                        {tech.photoUrl ? (
                          <img src={tech.photoUrl} alt="" className={`w-8 h-8 rounded-full object-cover ${isSelected ? 'ring-2 ring-purple-500 shadow-md' : ''}`} />
                        ) : (
                          <span className={`w-8 h-8 rounded-full bg-gray-200 text-gray-500 text-[10px] font-bold flex items-center justify-center ${isSelected ? 'ring-2 ring-purple-500 shadow-md' : ''}`}>{initials}</span>
                        )}
                        <span className="text-[9px] text-slate-500 truncate max-w-[52px] block leading-tight font-medium">{tech.name.split(' ')[0]}</span>
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {categories.length === 0 && (
                <tr>
                  <td colSpan={technicians.length + 1} className="px-4 py-8 text-center text-sm text-slate-400">
                    No categories yet. Add categories below to start mapping technicians, or import the summit draft.
                  </td>
                </tr>
              )}
              {displayCategories.map((cat) => (
                <tr key={cat.id} className={`border-t hover:bg-slate-50 ${cat.depth === 0 ? 'bg-slate-100/70' : ''}`}>
                  <td className={`px-3 sticky left-0 z-10 text-slate-700 ${cat.depth === 0 ? 'bg-slate-100/95 py-3 text-sm font-bold text-slate-800' : 'bg-white py-2 text-xs font-medium'}`} title={cat.description || ''}>
                    <div className="flex items-center gap-2">
                      {cat.depth === 1 && <span className="ml-3 h-px w-5 bg-slate-300" />}
                      <span className={cat.depth === 0 ? 'tracking-normal' : 'text-slate-600'}>{cat.name}</span>
                    </div>
                  </td>
                  {technicians.map((tech) => {
                    const level = mappingMap[tech.id]?.[cat.id] || '';
                    const levelInfo = PROFICIENCY_LEVELS.find((l) => l.value === level);
                    const CYCLE = ['', 'basic', 'intermediate', 'advanced', 'expert'];
                    const handleCycle = (e) => {
                      e.stopPropagation();
                      const currentIdx = CYCLE.indexOf(level);
                      const nextLevel = CYCLE[(currentIdx + 1) % CYCLE.length];

                      setMappings((prev) => {
                        const filtered = prev.filter((m) => !(m.technicianId === tech.id && m.competencyCategoryId === cat.id));
                        if (nextLevel) {
                          filtered.push({ technicianId: tech.id, competencyCategoryId: cat.id, proficiencyLevel: nextLevel });
                        }
                        return filtered;
                      });

                      const techMappings = { ...(mappingMap[tech.id] || {}) };
                      if (nextLevel === '') delete techMappings[cat.id];
                      else techMappings[cat.id] = nextLevel;
                      const arr = Object.entries(techMappings).map(([catId, lv]) => ({ competencyCategoryId: parseInt(catId), proficiencyLevel: lv }));
                      assignmentAPI.updateTechCompetencies(tech.id, arr).catch(() => fetchData());
                    };
                    return (
                      <td key={tech.id} className="text-center px-1 py-1">
                        <button
                          onClick={handleCycle}
                          className={`w-7 h-7 rounded-lg text-[10px] font-bold leading-7 text-center transition-all hover:scale-110 hover:shadow-sm ${
                            levelInfo ? levelInfo.color : 'text-slate-200 hover:bg-slate-100'
                          }`}
                          title={`${cat.depth === 1 ? `${cat.parentName} > ` : ''}${cat.name} × ${tech.name}: ${level || 'not set'} (click to cycle)`}
                        >
                          {levelInfo ? levelInfo.num : '·'}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      {categories.length > 0 && (
        <div className="flex items-center gap-4 text-xs text-slate-500">
          <span className="font-medium">Legend:</span>
          <span className="px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-800">1 = Basic</span>
          <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-800">2 = Comfortable</span>
          <span className="px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800">3 = Advanced</span>
          <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-800">4 = Expert / SME</span>
          <span className="ml-2 text-slate-400">Click cell to cycle · Click avatar to edit</span>
        </div>
      )}

      {/* Technician Editor — Slide-over overlay */}
      {selectedTech && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black bg-opacity-30" onClick={() => setSelectedTechId(null)} />
          <div className="relative w-full max-w-xl bg-white shadow-2xl overflow-y-auto animate-slide-in-right">
            <TechnicianEditor
              tech={selectedTech}
              categories={categories}
              savedMappings={mappings}
              onClose={() => setSelectedTechId(null)}
              onSaved={fetchData}
              onAnalyze={onAnalyze}
            />
          </div>
        </div>
      )}

      {/* Category management (collapsed by default) */}
      <details className="border rounded-lg">
        <summary className="px-4 py-2.5 text-sm font-medium text-slate-700 cursor-pointer hover:bg-slate-50 select-none flex items-center gap-2">
          <span>Manage Published Categories ({categories.length})</span>
        </summary>
        <div className="px-4 pb-4 pt-2 border-t space-y-3">
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {displayCategories.map((cat) => (
                <div key={cat.id} className="flex items-center gap-1 bg-white border rounded px-2 py-1 text-xs">
                  <span className="font-medium">{cat.depth === 1 ? `${cat.parentName} > ${cat.name}` : cat.name}</span>
                  <button onClick={() => handleDeleteCategory(cat.id)} className="ml-0.5 text-red-400 hover:text-red-600"><Trash2 className="w-3 h-3" /></button>
                </div>
              ))}
            </div>
          )}
          <div className="grid gap-2 md:grid-cols-[1fr_1fr_220px_auto]">
            <input type="text" value={newCatName} onChange={(e) => setNewCatName(e.target.value)} placeholder="Skill or subskill name" className="flex-1 border rounded-lg px-3 py-1.5 text-xs" />
            <input type="text" value={newCatDesc} onChange={(e) => setNewCatDesc(e.target.value)} placeholder="Description (optional)" className="flex-1 border rounded-lg px-3 py-1.5 text-xs" />
            <ParentCategoryPicker
              value={newCatParentId}
              categories={topLevelCategories}
              onChange={setNewCatParentId}
            />
            <button onClick={handleCreateCategory} disabled={saving || !newCatName.trim()} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Add</button>
          </div>
        </div>
      </details>

      {technicians.length === 0 && (
        <p className="text-slate-500 text-sm text-center py-4">No active technicians found in this workspace.</p>
      )}
    </div>
  );
}

// ─── Sub-tab: Live Analysis View ─────────────────────────────────────────

function LiveAnalysisView({ techId, techName, onBack, onComplete, forceNew, workspaceTimezone = 'America/Los_Angeles' }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState('checking');
  const [events, setEvents] = useState([]);
  const [toolCalls, setToolCalls] = useState([]);
  const [assessment, setAssessment] = useState(null);
  const [runId, setRunId] = useState(null);
  const [completedRun, setCompletedRun] = useState(null);
  const [error, setError] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [thinkingKb, setThinkingKb] = useState(null);
  const scrollRef = useRef(null);
  const timerRef = useRef(null);
  const startTimeRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, []);

  useEffect(() => {
    if (!techId) return;
    const abortController = new AbortController();
    let currentStatus = 'checking';

    setStatus('checking');
    setEvents([]);
    setToolCalls([]);
    setAssessment(null);
    setCompletedRun(null);
    setError(null);
    setRunId(null);
    setElapsedSec(0);
    setThinkingKb(null);

    function startTimer() {
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsedSec(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
    }

    function stopTimer() {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    }

    function handleEvent(event) {
      processStreamEvent(event, {
        setEvents,
        setToolCalls,
        setThinkingKb,
        scrollToBottom,
        onRunStarted: (e) => { setRunId(e.runId); },
        onResult: (e) => { setAssessment(e.data); currentStatus = 'completed'; setStatus('completed'); stopTimer(); setTimeout(scrollToBottom, 50); },
        onError: (e) => { setError(e.message); if (currentStatus !== 'completed') { currentStatus = 'error'; setStatus('error'); stopTimer(); } },
        onComplete: () => { if (currentStatus !== 'error' && currentStatus !== 'completed') { currentStatus = 'completed'; setStatus('completed'); } stopTimer(); },
      });
    }

    (async () => {
      if (!forceNew) {
        try {
          const runsRes = await assignmentAPI.getCompetencyRuns({ techId, limit: 1 });
          const latestRun = runsRes?.items?.[0];
          if (latestRun?.status === 'running') {
            setRunId(latestRun.id);
            currentStatus = 'running';
            setStatus('running');
            setError(`Analysis already running for this technician (run #${latestRun.id}). Use Run History to cancel it if it is stuck.`);
            return;
          }
          if (latestRun?.status === 'completed' && ['auto_applied', 'preserved_existing'].includes(latestRun.decision)) {
            const runRes = await assignmentAPI.getCompetencyRun(latestRun.id);
            if (runRes?.data) { setCompletedRun(runRes.data); setRunId(latestRun.id); currentStatus = 'completed'; setStatus('completed'); return; }
          }
        } catch { /* proceed */ }
      }

      try {
        startTimer();
        currentStatus = 'connecting';
        setStatus('connecting');

        currentStatus = 'running';
        setStatus('running');

        await readSSEStream(`/assignment/competencies/analyze/${techId}?stream=true`, {
          signal: abortController.signal,
          onEvent: handleEvent,
        });

        if (currentStatus === 'completed') {
          await new Promise((r) => setTimeout(r, 500));
          try {
            const runsRes2 = await assignmentAPI.getCompetencyRuns({ techId, limit: 1 });
            const rid = runsRes2?.items?.[0]?.id;
            if (rid) { const runRes = await assignmentAPI.getCompetencyRun(rid); if (runRes?.data) setCompletedRun(runRes.data); }
          } catch { /* non-critical */ }
        }
      } catch (err) {
        if (err.name !== 'AbortError') { setStatus('error'); setError(err.message); }
        stopTimer();
      } finally {
        setThinkingKb(null);
      }
    })();

    return () => { abortController.abort(); stopTimer(); };
  }, [techId, forceNew, scrollToBottom]);

  const STATUS_MAP = {
    checking: { icon: Loader2, text: 'Checking for existing analysis...', color: 'text-gray-500', spin: true },
    connecting: { icon: Loader2, text: 'Starting analysis...', color: 'text-gray-500', spin: true },
    running: { icon: Brain, text: `Analyzing competencies... (${elapsedSec}s)`, color: 'text-purple-600', spin: true },
    completed: { icon: CheckCircle, text: 'Analysis complete — auto-applied', color: 'text-green-600', spin: false },
    error: { icon: XCircle, text: 'Analysis failed', color: 'text-red-600', spin: false },
  };
  const statusInfo = STATUS_MAP[status] || STATUS_MAP.connecting;
  const submittedCompetencyCount = assessment
    ? (assessment.competencies || []).length
    : (completedRun?.structuredResult?.competencies || []).length;
  const resultDecision = assessment?.applyResult?.preservedExisting
    ? 'preserved_existing'
    : (completedRun?.decision === 'auto_applied' && submittedCompetencyCount === 0 ? 'no_changes' : (completedRun?.decision || (assessment ? 'auto_applied' : null)));
  const statusText = status === 'completed'
    ? (resultDecision === 'preserved_existing'
      ? 'Analysis complete — existing skills preserved'
      : resultDecision === 'no_changes'
        ? 'Analysis complete — no skill changes'
        : statusInfo.text)
    : statusInfo.text;
  const statusColor = status === 'completed' && ['preserved_existing', 'no_changes'].includes(resultDecision)
    ? 'text-amber-600'
    : statusInfo.color;
  const StatusIcon = statusInfo.icon;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <StatusIcon className={`w-5 h-5 ${statusColor} ${statusInfo.spin ? 'animate-spin' : ''}`} />
          <span className={`text-sm font-medium ${statusColor}`}>{statusText}</span>
          {runId && <CopyBadge label="CR" value={runId} />}
          <span className="text-sm text-gray-500">| {techName}</span>
        </div>
        {onBack && <button onClick={onBack} className="text-sm text-blue-600 hover:underline">Back</button>}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto border rounded-lg bg-white p-2.5 sm:p-4 min-h-[200px] sm:min-h-[300px] max-h-[60vh] sm:max-h-[600px]">
        {events.length === 0 && (status === 'connecting' || status === 'checking') && <div className="flex items-center justify-center h-full text-gray-400"><Loader2 className="w-6 h-6 animate-spin" /></div>}
        {events.length === 0 && status === 'completed' && completedRun && (
          <div className="text-sm text-gray-600">
            <p className="mb-2 text-xs text-gray-400">Showing results from previous analysis (run CR-{completedRun.id}, {formatDateTimeInTimezone(completedRun.createdAt, workspaceTimezone)})</p>
            {completedRun.decision === 'preserved_existing' && (
              <p className="mb-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                Existing skills were preserved because clean canonical category evidence was too sparse.
              </p>
            )}
            {(completedRun.structuredResult?.competencies || []).length === 0 && (
              <p className="text-xs text-gray-500">No skill changes were submitted.</p>
            )}
            {completedRun.structuredResult?.competencies?.map((comp, i) => (
              <div key={i} className="mb-1">
                <span className="font-medium">{comp.categoryName}</span>
                {' '}<span className={`text-xs px-1.5 py-0.5 rounded ${PROFICIENCY_LEVELS.find((l) => l.value === comp.proficiencyLevel)?.color || ''}`}>{comp.proficiencyLevel}</span>
                {comp.confidence && <span className="text-xs text-gray-400 ml-1">({comp.confidence})</span>}
              </div>
            ))}
            <button onClick={() => navigate(`/assignments/competency-live/${techId}?force=true`)} className="mt-3 text-xs text-purple-600 hover:underline">Run new analysis instead</button>
          </div>
        )}
        {events.length > 0 && (
          <StreamContent events={events} toolCalls={toolCalls} thinkingKb={thinkingKb} status={status} accentColor="purple" />
        )}
      </div>

      {error && (
        <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {error}
        </div>
      )}

      {(assessment || completedRun) && (
        <div className="mt-4 border-t pt-4 space-y-4">
          <h4 className="text-sm font-semibold text-gray-700">
            {resultDecision === 'preserved_existing'
              ? 'Assessment Result (Existing Skills Preserved)'
              : resultDecision === 'no_changes'
                ? 'Assessment Result (No Skill Changes)'
                : 'Assessment Result (Auto-Applied)'}
          </h4>
          {resultDecision === 'preserved_existing' && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
              {assessment?.applyResult?.preserveReason || completedRun?.structuredResult?.applyResult?.preserveReason || 'Existing skills were preserved because the run did not have enough clean canonical Ticket Pulse category evidence.'}
            </div>
          )}
          {(assessment?.overallSummary || completedRun?.structuredResult?.overallSummary) && (
            <p className="text-sm text-gray-600 bg-purple-50 rounded-lg p-3">{assessment?.overallSummary || completedRun?.structuredResult?.overallSummary}</p>
          )}
          {completedRun?.beforeSnapshot && completedRun?.afterSnapshot && (
            <CompetencyDiff before={completedRun.beforeSnapshot.competencies || []} after={completedRun.afterSnapshot?.competencies || []} />
          )}
          {!completedRun && assessment && (
            <div className="space-y-2">
              {(assessment.competencies || []).map((comp, i) => (
                <div key={i} className="border rounded-lg p-3 bg-white">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{comp.categoryName}</span>
                      {comp.categoryAction === 'create_new' && <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">new</span>}
                      <span className={`text-xs px-1.5 py-0.5 rounded ${PROFICIENCY_LEVELS.find((l) => l.value === comp.proficiencyLevel)?.color || ''}`}>{comp.proficiencyLevel}</span>
                    </div>
                    {comp.confidence && <span className="text-xs text-gray-400">{comp.confidence}</span>}
                  </div>
                  {comp.evidenceSummary && <p className="text-xs text-gray-500 mt-1">{comp.evidenceSummary}</p>}
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-3">
            <button onClick={() => { onComplete?.(); }} className="text-sm text-blue-600 hover:underline">Back to matrix</button>
            {runId && <button onClick={() => navigate(`/assignments/competency-run/${runId}`)} className="text-sm text-purple-600 hover:underline">View full run details</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Diff View ───────────────────────────────────────────────────────────

function CompetencyDiff({ before, after }) {
  const beforeMap = {};
  for (const c of before) beforeMap[c.categoryName] = c.proficiencyLevel;
  const afterMap = {};
  for (const c of after) afterMap[c.categoryName] = c.proficiencyLevel;
  const allCategories = [...new Set([...before.map((c) => c.categoryName), ...after.map((c) => c.categoryName)])].sort();

  const rows = allCategories.map((name) => {
    const bLevel = beforeMap[name] || null;
    const aLevel = afterMap[name] || null;
    let changeType = 'unchanged';
    if (!bLevel && aLevel) changeType = 'added';
    else if (bLevel && !aLevel) changeType = 'removed';
    else if (bLevel !== aLevel) changeType = 'changed';
    return { name, bLevel, aLevel, changeType };
  });

  const getLevelBadge = (level) => {
    if (!level) return <span className="text-gray-300 text-xs">--</span>;
    const info = PROFICIENCY_LEVELS.find((l) => l.value === level);
    return <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${info?.color || ''}`}>{level}</span>;
  };
  const ROW_STYLES = { added: 'bg-green-50', removed: 'bg-red-50 line-through opacity-60', changed: 'bg-yellow-50', unchanged: '' };
  const CHANGE_LABELS = {
    added: <span className="text-[10px] font-semibold text-green-700 bg-green-100 px-1 rounded">NEW</span>,
    removed: <span className="text-[10px] font-semibold text-red-700 bg-red-100 px-1 rounded">REMOVED</span>,
    changed: <span className="text-[10px] font-semibold text-yellow-700 bg-yellow-100 px-1 rounded">CHANGED</span>,
    unchanged: null,
  };
  const changedCount = rows.filter((r) => r.changeType !== 'unchanged').length;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-gray-700">Before / After Comparison</h4>
        <span className="text-xs text-gray-400">{changedCount} change{changedCount !== 1 ? 's' : ''}</span>
      </div>
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium text-gray-600">Category</th>
              <th className="text-center px-3 py-1.5 font-medium text-gray-600 w-28">Before</th>
              <th className="text-center px-1 py-1.5 w-6"></th>
              <th className="text-center px-3 py-1.5 font-medium text-gray-600 w-28">After</th>
              <th className="text-center px-2 py-1.5 w-20"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className={`border-t ${ROW_STYLES[row.changeType]}`}>
                <td className="px-3 py-1.5 font-medium">{row.name}</td>
                <td className="text-center px-3 py-1.5">{getLevelBadge(row.bLevel)}</td>
                <td className="text-center px-1 py-1.5 text-gray-300">{row.changeType !== 'unchanged' ? '→' : ''}</td>
                <td className="text-center px-3 py-1.5">{getLevelBadge(row.aLevel)}</td>
                <td className="text-center px-2 py-1.5">{CHANGE_LABELS[row.changeType]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Sub-tab: Run History ─────────────────────────────────────────────────

function RunHistoryTab({ deepRunId, workspaceTimezone = 'America/Los_Angeles' }) {
  const navigate = useNavigate();
  const [runs, setRuns] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [selectedRun, setSelectedRun] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);
  const DECISION_COLORS = {
    auto_applied: 'bg-green-100 text-green-800',
    preserved_existing: 'bg-amber-100 text-amber-800',
    rolled_back: 'bg-red-100 text-red-800',
  };

  const fetchRuns = useCallback(async () => {
    try { setLoading(true); const res = await assignmentAPI.getCompetencyRuns({ limit: 50 }); setRuns({ items: res?.items || [], total: res?.total || 0 }); } catch (err) { console.error(err); } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  useEffect(() => {
    if (deepRunId) {
      (async () => { try { const res = await assignmentAPI.getCompetencyRun(parseInt(deepRunId)); setSelectedRun(res?.data || null); } catch (err) { console.error(err); } })();
    }
  }, [deepRunId]);

  const handleSelectRun = (runId) => { navigate(`/assignments/competency-run/${runId}`); };

  const handleRollback = async (runId) => {
    if (!confirm('Rollback this competency assessment?')) return;
    try { await assignmentAPI.rollbackCompetencyRun(runId); setActionMsg('Rolled back'); setSelectedRun(null); await fetchRuns(); setTimeout(() => setActionMsg(null), 3000); } catch (err) { setActionMsg(`Failed: ${err.message}`); }
  };

  const handleCancel = async (runId) => {
    try { await assignmentAPI.cancelCompetencyRun(runId); setActionMsg('Cancelled'); setSelectedRun(null); await fetchRuns(); setTimeout(() => setActionMsg(null), 3000); } catch (err) { setActionMsg(`Failed: ${err.message}`); }
  };

  if (selectedRun) {
    return (
      <div>
        <button onClick={() => { setSelectedRun(null); navigate('/assignments/competencies'); }} className="text-sm text-blue-600 hover:underline mb-4 flex items-center gap-1">
          <ChevronRight className="w-4 h-4 rotate-180" /> Back to history
        </button>
        <div className="space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-lg font-semibold">Competency Run CR-{selectedRun.id}</h3>
                <CopyBadge label="CR" value={selectedRun.id} />
              </div>
              <p className="text-sm text-gray-500">{selectedRun.technician?.name} | {formatDateTimeInTimezone(selectedRun.createdAt, workspaceTimezone)}</p>
              <p className="text-xs text-gray-400">{selectedRun.totalDurationMs ? `${(selectedRun.totalDurationMs / 1000).toFixed(1)}s` : ''} {selectedRun.totalTokensUsed ? `| ${selectedRun.totalTokensUsed} tokens` : ''}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`px-3 py-1 rounded-full text-xs font-medium ${DECISION_COLORS[selectedRun.decision] || 'bg-gray-100 text-gray-600'}`}>
                {(selectedRun.decision || selectedRun.status || '').replace(/_/g, ' ')}
              </span>
              {selectedRun.decision === 'auto_applied' && (
                <button onClick={() => handleRollback(selectedRun.id)} className="px-3 py-1 bg-red-100 text-red-700 rounded-lg text-xs font-medium hover:bg-red-200 flex items-center gap-1"><RotateCcw className="w-3 h-3" /> Rollback</button>
              )}
              {selectedRun.status === 'running' && (
                <button onClick={() => handleCancel(selectedRun.id)} className="px-3 py-1 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700 flex items-center gap-1"><XCircle className="w-3 h-3" /> Cancel</button>
              )}
            </div>
          </div>
          {selectedRun.decision === 'preserved_existing' && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-sm text-amber-900">
                {selectedRun.structuredResult?.applyResult?.preserveReason || 'Existing skills were preserved because the run did not have enough clean canonical Ticket Pulse category evidence.'}
              </p>
            </div>
          )}
          {selectedRun.structuredResult?.overallSummary && <div className="bg-purple-50 border border-purple-200 rounded-lg p-3"><p className="text-sm text-purple-900">{selectedRun.structuredResult.overallSummary}</p></div>}
          {selectedRun.beforeSnapshot && selectedRun.afterSnapshot && <CompetencyDiff before={selectedRun.beforeSnapshot.competencies || []} after={selectedRun.afterSnapshot?.competencies || []} />}
          {selectedRun.steps?.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-2">Pipeline Steps</h4>
              {selectedRun.steps.map((step) => <ToolCallCard key={step.id} name={step.stepName} input={step.input} result={step.output} durationMs={step.durationMs} />)}
            </div>
          )}
          {selectedRun.fullTranscript && (
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-2">Full Conversation</h4>
              <div className="border rounded-lg bg-white p-4 prose prose-sm max-w-none max-h-[400px] overflow-y-auto">
                <Markdown remarkPlugins={[remarkGfm]}>{cleanTranscript(selectedRun.fullTranscript)}</Markdown>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (loading) return <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>;

  return (
    <div>
      {actionMsg && <div className="mb-3 text-sm text-green-600 bg-green-50 border border-green-200 rounded-lg px-3 py-2">{actionMsg}</div>}
      <p className="text-sm text-gray-500 mb-4">{runs.total} competency analysis run{runs.total !== 1 ? 's' : ''}</p>
      {runs.items.length === 0 ? (
        <p className="text-gray-400 text-sm text-center py-8">No competency analysis runs yet.</p>
      ) : (
        <div className="space-y-2">
          {runs.items.map((run) => (
            <button key={run.id} onClick={() => handleSelectRun(run.id)} className="w-full text-left border rounded-lg p-3 hover:bg-gray-50 transition-colors">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">{run.technician?.name || `Tech #${run.technicianId}`}</p>
                  <p className="text-xs text-gray-500">{formatDateTimeInTimezone(run.createdAt, workspaceTimezone)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${DECISION_COLORS[run.decision] || 'bg-gray-100 text-gray-600'}`}>
                    {(run.decision || run.status || '').replace(/_/g, ' ')}
                  </span>
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Sub-tab: Competency Prompt Manager ──────────────────────────────────

function CompetencyPromptTab() {
  const [versions, setVersions] = useState([]);
  const [published, setPublished] = useState(null);
  const [editText, setEditText] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [error, setError] = useState(null);
  const [tools, setTools] = useState([]);
  const [toolsExpanded, setToolsExpanded] = useState({});

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [promptRes, toolsRes] = await Promise.all([assignmentAPI.getCompetencyPrompts(), assignmentAPI.getCompetencyTools()]);
      const data = promptRes?.data || {};
      setVersions(data.versions || []);
      setPublished(data.published || null);
      if (data.published?.systemPrompt && !editText) setEditText(data.published.systemPrompt);
      setTools(toolsRes?.data || []);
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSaveDraft = async () => {
    if (!editText.trim()) return;
    try { setSaving(true); await assignmentAPI.createCompetencyPrompt({ systemPrompt: editText, notes: notes || null }); setSaveMsg('Draft saved'); setNotes(''); await fetchData(); setTimeout(() => setSaveMsg(null), 3000); } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  const handlePublish = async (id) => {
    try { setPublishing(true); await assignmentAPI.publishCompetencyPrompt(id); setSaveMsg('Published'); await fetchData(); setTimeout(() => setSaveMsg(null), 3000); } catch (err) { setError(err.message); } finally { setPublishing(false); }
  };

  const handleRestore = async (id) => {
    try { const res = await assignmentAPI.restoreCompetencyPrompt(id); if (res?.data?.systemPrompt) setEditText(res.data.systemPrompt); setSaveMsg('Restored as draft'); await fetchData(); setTimeout(() => setSaveMsg(null), 3000); } catch (err) { setError(err.message); }
  };

  if (loading) return <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>;

  const STATUS_BADGES = { published: 'bg-green-100 text-green-800', draft: 'bg-yellow-100 text-yellow-800', archived: 'bg-gray-100 text-gray-600' };

  return (
    <div className="space-y-6">
      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error} <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button></div>}

      <div>
        <h4 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1.5"><Wrench className="w-4 h-4" /> Available Tools ({tools.length})</h4>
        <div className="space-y-1">
          {tools.map((tool) => (
            <div key={tool.name} className="border rounded-lg bg-white overflow-hidden">
              <button onClick={() => setToolsExpanded((p) => ({ ...p, [tool.name]: !p[tool.name] }))} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 transition-colors">
                {toolsExpanded[tool.name] ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                <code className="text-xs font-semibold text-purple-700">{tool.name}</code>
                <span className="text-xs text-gray-400 truncate flex-1">{tool.description.slice(0, 80)}{tool.description.length > 80 ? '...' : ''}</span>
              </button>
              {toolsExpanded[tool.name] && <div className="px-3 pb-3 border-t bg-gray-50"><p className="text-xs text-gray-600 mt-2">{tool.description}</p></div>}
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5"><FileText className="w-4 h-4" /> Competency System Prompt</h4>
          {published && <span className="text-xs text-gray-400">Published: v{published.version}</span>}
        </div>
        <textarea value={editText} onChange={(e) => setEditText(e.target.value)} className="w-full border rounded-lg p-3 text-sm font-mono resize-y min-h-[250px] bg-gray-50 focus:bg-white focus:ring-2 focus:ring-purple-200 transition-colors" />
        <div className="flex items-center gap-2 mt-2">
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Version notes (optional)" className="flex-1 border rounded-lg px-3 py-2 text-sm" />
          <button onClick={handleSaveDraft} disabled={saving || !editText.trim()} className="px-4 py-2 border rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save Draft
          </button>
        </div>
        {saveMsg && <p className="text-sm text-green-600 mt-2 flex items-center gap-1"><CheckCircle className="w-4 h-4" /> {saveMsg}</p>}
      </div>

      <div>
        <h4 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1.5"><Clock className="w-4 h-4" /> Version History</h4>
        {versions.length === 0 ? <p className="text-gray-400 text-sm">No versions yet.</p> : (
          <div className="space-y-1.5">
            {versions.map((v) => (
              <div key={v.id} className="flex items-center justify-between bg-white border rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="text-sm font-mono font-medium text-gray-700">v{v.version}</span>
                  <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${STATUS_BADGES[v.status] || ''}`}>{v.status}</span>
                  {v.notes && <span className="text-xs text-gray-400 truncate">{v.notes}</span>}
                </div>
                <div className="flex items-center gap-1 ml-2">
                  {v.status !== 'published' && <button onClick={() => handlePublish(v.id)} disabled={publishing} className="p-1.5 hover:bg-green-50 rounded"><Upload className="w-3.5 h-3.5 text-green-600" /></button>}
                  <button onClick={() => handleRestore(v.id)} className="p-1.5 hover:bg-blue-50 rounded"><RotateCcw className="w-3.5 h-3.5 text-blue-600" /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────

const COMPETENCY_TABS = [
  { id: 'matrix', label: 'Skill Matrix', icon: Search },
  { id: 'suggestions', label: 'AI Suggestions', icon: Sparkles },
  { id: 'history', label: 'Run History', icon: Clock },
  { id: 'prompt', label: 'Prompt', icon: FileText },
];

export default function CompetencyManager({ deepRunId, deepAnalyzeTechId, workspaceTimezone = 'America/Los_Angeles' }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { currentWorkspace } = useWorkspace();
  const [activeTab, setActiveTab] = useState('matrix');
  const [suggestionCount, setSuggestionCount] = useState(0);

  const isLiveAnalysis = !!deepAnalyzeTechId;
  const forceNew = searchParams.get('force') === 'true';
  const isItWorkspace = Number(currentWorkspace?.id) === 1 || currentWorkspace?.slug === 'it';

  useEffect(() => {
    assignmentAPI.getCategorySuggestions()
      .then((res) => setSuggestionCount(res?.count || res?.data?.length || 0))
      .catch(() => setSuggestionCount(0));
  }, []);

  if (isLiveAnalysis) {
    return (
      <LiveAnalysisView
        techId={deepAnalyzeTechId}
        techName={`Technician #${deepAnalyzeTechId}`}
        forceNew={forceNew}
        workspaceTimezone={workspaceTimezone}
        onBack={() => navigate('/assignments/competencies')}
        onComplete={() => navigate('/assignments/competencies')}
      />
    );
  }

  const handleAnalyze = (techId) => {
    navigate(`/assignments/competency-live/${techId}?force=true`);
  };

  const effectiveTab = deepRunId ? 'history' : activeTab;

  return (
    <div>
      <div className="flex gap-1 mb-4 border-b">
        {COMPETENCY_TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button key={tab.id} onClick={() => { setActiveTab(tab.id); if (deepRunId) navigate('/assignments/competencies'); }} className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${effectiveTab === tab.id ? 'border-purple-600 text-purple-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              <Icon className="w-4 h-4" /> {tab.label}
              {tab.id === 'suggestions' && suggestionCount > 0 && (
                <span className={`ml-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                  effectiveTab === tab.id ? 'bg-purple-100 text-purple-700' : 'bg-amber-100 text-amber-700'
                }`}>
                  {suggestionCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {effectiveTab === 'matrix' && <MatrixTab onAnalyze={(id) => handleAnalyze(id)} showMigrationControls={isItWorkspace} />}
      {effectiveTab === 'suggestions' && <CategorySuggestionsTab onCountChange={setSuggestionCount} />}
      {effectiveTab === 'history' && <RunHistoryTab deepRunId={deepRunId} workspaceTimezone={workspaceTimezone} />}
      {effectiveTab === 'prompt' && <CompetencyPromptTab />}
    </div>
  );
}
