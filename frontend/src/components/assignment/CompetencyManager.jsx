import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { assignmentAPI } from '../../services/api';
import { readSSEStream } from '../../hooks/useStreamingFetch';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Plus, Loader2, Brain, CheckCircle, XCircle, RotateCcw,
  ChevronDown, ChevronLeft, ChevronRight, Wrench, AlertTriangle,
  Search, Clock, Save, Upload, FileText, X, MapPin, History,
  Sparkles, ArrowUpDown, ArrowUpRight, ArrowDownRight, SlidersHorizontal, CalendarDays,
  Folder, GitMerge, CheckSquare, Square, Lock, Unlock,
} from 'lucide-react';
import {
  CopyBadge, ToolCallCard, StreamContent,
  cleanTranscript, processStreamEvent,
} from './StreamingComponents';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import CategoriesManagementTab, { ParentCategoryPicker } from './CategoriesManagementTab';

const PROFICIENCY_LEVELS = [
  { value: 'basic', label: 'Basic', num: '1', color: 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-800 dark:text-yellow-200' },
  { value: 'intermediate', label: 'Comfortable', num: '2', color: 'bg-blue-100 dark:bg-blue-500/20 text-blue-800 dark:text-blue-200' },
  { value: 'advanced', label: 'Advanced', num: '3', color: 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-800 dark:text-indigo-200' },
  { value: 'expert', label: 'Expert / SME', num: '4', color: 'bg-green-100 dark:bg-green-500/20 text-green-800 dark:text-green-200' },
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

const MATRIX_CATEGORY_COL_WIDTH = 280;
const MATRIX_TECH_COL_WIDTH = 74;

function getTechnicianInitials(name = '') {
  return name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function getCategoryGroup(name) {
  const lower = name.toLowerCase();
  for (const group of CATEGORY_GROUPS) {
    if (group.keywords.some((kw) => lower.includes(kw))) return group.label;
  }
  return 'Other';
}

// DuplicateDetector and ParentCategoryPicker moved to ./CategoriesManagementTab.jsx
// as part of the Categories page overhaul (tree editor, rename/edit/retire/merge).

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
      <div className="bg-gradient-to-r from-purple-50 dark:from-purple-500/15 to-blue-50 dark:to-blue-500/15 px-5 py-4 border-b border-purple-100 dark:border-purple-500/20 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {tech.photoUrl ? (
              <img src={tech.photoUrl} alt="" className="w-10 h-10 rounded-full object-cover border-2 border-card shadow-sm" />
            ) : (
              <span className="w-10 h-10 rounded-full bg-purple-200 dark:bg-purple-500/30 text-purple-700 dark:text-purple-200 text-sm font-bold flex items-center justify-center border-2 border-card shadow-sm">{initials}</span>
            )}
            <div>
              <h3 className="text-base font-bold text-foreground">{tech.name}</h3>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {tech.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {tech.location}</span>}
                <span>{mappedCount} skill{mappedCount !== 1 ? 's' : ''} mapped</span>
                {latestRun?.decision === 'auto_applied' && <span className="text-green-600 dark:text-green-300 font-medium">LLM analyzed</span>}
                {latestRun?.decision === 'preserved_existing' && <span className="text-amber-600 dark:text-amber-300 font-medium">LLM preserved</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => onAnalyze(tech.id)} className="px-3 py-1.5 bg-purple-600 text-white rounded-lg text-xs font-semibold hover:bg-purple-700 flex items-center gap-1.5 shadow-sm">
              <Brain className="w-3.5 h-3.5" /> Run LLM Analysis
            </button>
            {latestRun && (
              <button onClick={() => navigate(`/assignments/competency-run/${latestRun.id}`)} className="px-3 py-1.5 border border-border rounded-lg text-xs font-medium hover:bg-muted/50 flex items-center gap-1">
                <History className="w-3.5 h-3.5" /> Last Run
              </button>
            )}
            <button onClick={onClose} className="p-1.5 text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted rounded-lg">
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
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/75" />
            <input type="text" value={catFilter} onChange={(e) => setCatFilter(e.target.value)} placeholder="Filter categories..." className="w-full pl-8 pr-3 py-1.5 border rounded-lg text-xs bg-muted/50 focus:bg-card" />
          </div>
          <div className="flex items-center gap-2 ml-auto">
            {hasChanges && <span className="text-xs text-orange-600 dark:text-orange-300 font-medium">Unsaved changes</span>}
            {saveMsg && <span className={`text-xs font-medium ${saveMsg.startsWith('Error') ? 'text-red-600 dark:text-red-300' : 'text-green-600 dark:text-green-300'}`}>{saveMsg}</span>}
            <button onClick={handleReset} disabled={!hasChanges} className="px-3 py-1.5 border rounded-lg text-xs font-medium hover:bg-muted/50 disabled:opacity-30 flex items-center gap-1">
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
              <h4 className="text-[10px] font-bold text-muted-foreground/75 uppercase tracking-wider mb-2">{groupName}</h4>
              <div className="space-y-1">
                {cats.map((cat) => {
                  const level = draft[cat.id] || '';
                  const saved = savedMap[cat.id] || '';
                  const changed = level !== saved;
                  const levelInfo = PROFICIENCY_LEVELS.find((l) => l.value === level);
                  return (
                    <div key={cat.id} className={`flex items-center justify-between rounded-lg px-3 py-2 border transition-colors ${changed ? 'border-orange-300 dark:border-orange-500/40 bg-orange-50 dark:bg-orange-500/15' : 'border-border/60 bg-muted/50 hover:bg-card'}`}>
                      <span className="text-sm text-foreground/85 flex-1 mr-3">{cat.name}</span>
                      <select
                        value={level}
                        onChange={(e) => handleChange(cat.id, e.target.value)}
                        className={`text-xs rounded-md px-2 py-1.5 border cursor-pointer font-medium min-w-[120px] ${levelInfo ? levelInfo.color : 'text-muted-foreground/75 bg-card'}`}
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 dark:bg-black/70 p-4">
      <div className="w-full max-w-xl rounded-2xl bg-card p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-bold text-foreground">
              <Plus className="h-5 w-5 text-purple-600 dark:text-purple-300" />
              Add Category
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">Create a category directly when an AI suggestion is close but not quite right.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-muted-foreground/75 transition hover:bg-muted hover:text-foreground/85">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-5 grid gap-3">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded-xl border border-border px-3 py-2.5 text-sm font-semibold outline-none transition focus:border-purple-300 dark:focus:border-purple-500/40 focus:ring-2 focus:ring-purple-100 dark:focus:ring-purple-500/30"
            placeholder="Category name"
          />
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className="min-h-[88px] rounded-xl border border-border px-3 py-2.5 text-sm outline-none transition focus:border-purple-300 dark:focus:border-purple-500/40 focus:ring-2 focus:ring-purple-100 dark:focus:ring-purple-500/30"
            placeholder="Description (optional)"
          />
          <ParentCategoryPicker
            value={parentId}
            categories={activeCategories.filter((category) => !category.parentId)}
            onChange={setParentId}
          />
        </div>
        {error && <div className="mt-3 rounded-lg bg-red-50 dark:bg-red-500/15 px-3 py-2 text-sm text-red-700 dark:text-red-200">{error}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-border px-4 py-2 text-sm font-semibold text-foreground/85 transition hover:bg-muted/50">
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

      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-purple-50 dark:bg-purple-500/15 text-purple-600 dark:text-purple-300">
            <Sparkles className="h-7 w-7" />
          </div>
          <div>
            <h2 className="flex items-center gap-2 text-2xl font-bold text-foreground">
              AI Suggested Categories
              <span className="rounded-full bg-purple-100 dark:bg-purple-500/20 px-2.5 py-1 text-sm font-bold text-purple-700 dark:text-purple-200">{suggestions.length}</span>
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">AI analyzed competencies and found potential new categories. Review and take action.</p>
          </div>
        </div>
        <button type="button" onClick={() => setShowAddCategory(true)} className="inline-flex items-center justify-center gap-2 rounded-xl border border-purple-200 dark:border-purple-500/30 bg-card px-4 py-2.5 text-sm font-bold text-purple-700 dark:text-purple-200 shadow-sm transition hover:bg-purple-50 dark:hover:bg-purple-500/15">
          <Plus className="h-4 w-4" />
          Add Category
        </button>
      </div>

      {message && (
        <div className={`flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm ${message.type === 'error' ? 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200' : 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200'}`}>
          <div className="flex items-center gap-2">
            {message.type === 'error' ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle className="h-4 w-4" />}
            <span>{message.text}</span>
          </div>
          <button type="button" onClick={() => setMessage(null)} className="rounded-lg p-1 hover:bg-card/70"><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3 border-b border-border/60 pb-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-[86px] text-sm font-bold text-muted-foreground">{selectedIds.length} selected</span>
            <span className="hidden h-7 w-px bg-secondary sm:block" />
            <button type="button" onClick={toggleAllFiltered} className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-semibold text-foreground/85 transition hover:bg-muted/50">
              {allFilteredSelected ? <CheckSquare className="h-4 w-4 text-purple-600 dark:text-purple-300" /> : <Square className="h-4 w-4 text-muted-foreground/75" />}
              Select all
            </button>
            <button type="button" onClick={() => reviewSelected('approve')} disabled={!selectedIds.length || actingIds.length > 0} className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 px-3 py-2 text-sm font-bold text-emerald-700 dark:text-emerald-200 transition hover:bg-emerald-100 dark:hover:bg-emerald-500/20 disabled:opacity-40">
              <CheckCircle className="h-4 w-4" />
              Approve selected
            </button>
            <select value={bulkMergeTarget} onChange={(event) => setBulkMergeTarget(event.target.value)} disabled={!selectedIds.length} className="h-10 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground/85 outline-none disabled:opacity-40">
              <option value="">Merge target...</option>
              {targetOptions.map((category) => <option key={category.id} value={category.id}>{category.parentId ? 'Sub: ' : 'Top: '}{category.name}</option>)}
            </select>
            <button type="button" onClick={() => reviewSelected('merge')} disabled={!selectedIds.length || !bulkMergeTarget || actingIds.length > 0} className="inline-flex items-center gap-2 rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 px-3 py-2 text-sm font-bold text-blue-700 dark:text-blue-200 transition hover:bg-blue-100 dark:hover:bg-blue-500/20 disabled:opacity-40">
              <GitMerge className="h-4 w-4" />
              Merge selected
            </button>
            <button type="button" onClick={() => reviewSelected('reject')} disabled={!selectedIds.length || actingIds.length > 0} className="inline-flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 px-3 py-2 text-sm font-bold text-red-700 dark:text-red-200 transition hover:bg-red-100 dark:hover:bg-red-500/20 disabled:opacity-40">
              <XCircle className="h-4 w-4" />
              Reject selected
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} className="h-10 w-full min-w-[240px] rounded-lg border border-border pl-9 pr-3 text-sm outline-none transition focus:border-purple-300 dark:focus:border-purple-500/40 focus:ring-2 focus:ring-purple-100 dark:focus:ring-purple-500/30 sm:w-72" placeholder="Search suggestions..." />
            </div>
            <div className="relative">
              <SlidersHorizontal className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" />
              <select value={filter} onChange={(event) => setFilter(event.target.value)} className="h-10 appearance-none rounded-lg border border-border bg-card pl-9 pr-8 text-sm font-semibold text-foreground/85 outline-none">
                <option value="all">Filters</option>
                <option value="high">High confidence</option>
                <option value="medium">Medium confidence</option>
                <option value="duplicates">Potential duplicates</option>
                <option value="top">Top-level only</option>
                <option value="sub">Subcategories only</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" />
            </div>
            <div className="relative">
              <ArrowUpDown className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" />
              <select value={sort} onChange={(event) => setSort(event.target.value)} className="h-10 appearance-none rounded-lg border border-border bg-card pl-9 pr-8 text-sm font-semibold text-foreground/85 outline-none">
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="name">Name</option>
                <option value="confidence">Confidence</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" />
            </div>
            <div className="relative">
              <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))} className="h-10 appearance-none rounded-lg border border-border bg-card pl-3 pr-8 text-sm font-semibold text-foreground/85 outline-none">
                {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} per page</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" />
            </div>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {loading && <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-purple-600 dark:text-purple-300" /></div>}
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
              <div key={suggestion.id} className={`grid min-w-0 gap-3 rounded-xl border p-3 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md xl:grid-cols-[28px_minmax(0,1fr)_minmax(300px,390px)] ${isSelected ? 'border-purple-300 dark:border-purple-500/40 bg-purple-50/40 dark:bg-purple-500/10 shadow-sm' : 'border-border bg-card'}`}>
                <button type="button" onClick={() => toggleSelected(suggestion.id)} className="mt-1 flex h-5 w-5 items-center justify-center rounded border border-input bg-card text-muted-foreground/75 transition hover:border-purple-300 dark:hover:border-purple-500/40 hover:text-purple-600 dark:hover:text-purple-300">
                  {isSelected ? <CheckSquare className="h-4 w-4 text-purple-600 dark:text-purple-300" /> : <Square className="h-4 w-4" />}
                </button>
                <div className="min-w-0">
                  <input value={draft.name} onChange={(event) => updateDraft(suggestion.id, { name: event.target.value })} className="w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm font-bold text-foreground outline-none transition focus:border-purple-200 dark:focus:border-purple-500/30 focus:bg-card" />
                  <div className="mt-1 flex items-center gap-2 text-xs font-semibold text-muted-foreground"><Folder className="h-3.5 w-3.5" /><span>{suggestion.parent?.name || 'Create new parent category'}</span></div>
                  <textarea value={description} onChange={(event) => updateDraft(suggestion.id, { description: event.target.value })} className={`mt-2 w-full resize-none rounded-md border border-transparent bg-transparent px-1 py-1 text-sm leading-5 text-muted-foreground outline-none transition focus:border-purple-200 dark:focus:border-purple-500/30 focus:bg-card ${descriptionExpanded ? 'h-[118px]' : 'h-[62px]'}`} placeholder="Description or evidence" />
                  {canExpandDescription && (
                    <button type="button" onClick={() => toggleDescription(suggestion.id)} className="mt-1 text-xs font-bold text-purple-600 dark:text-purple-300 transition hover:text-purple-700 dark:hover:text-purple-200">
                      {descriptionExpanded ? 'Show less' : 'Show more'}
                    </button>
                  )}
                </div>
                <div className="min-w-0 space-y-2 border-border/60 xl:border-l xl:pl-4">
                  <div className="space-y-1.5">
                    <span className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-xs font-bold ${confidence === 'high' ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 ring-1 ring-emerald-200 dark:ring-emerald-500/30' : confidence === 'medium' ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 ring-1 ring-blue-200 dark:ring-blue-500/30' : 'bg-muted text-muted-foreground ring-1 ring-border'}`}>
                      <ArrowUpDown className="h-3.5 w-3.5" />
                      {confidence === 'high' ? 'High' : confidence === 'medium' ? 'Medium' : 'Low'} confidence
                    </span>
                    {duplicateTarget && <span className="ml-2 inline-flex items-center gap-1.5 rounded-lg bg-amber-50 dark:bg-amber-500/15 px-2 py-0.5 text-xs font-bold text-amber-700 dark:text-amber-200 ring-1 ring-amber-200 dark:ring-amber-500/30"><AlertTriangle className="h-3.5 w-3.5" />Potential duplicate</span>}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" />{suggestion.createdAt ? new Date(suggestion.createdAt).toLocaleString() : 'No date'}</span>
                      <span className="text-muted-foreground/75">{suggestion.source || 'technician_analysis'}</span>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold uppercase text-muted-foreground">Assign to category</label>
                    <select value={draft.parentId || ''} onChange={(event) => updateDraft(suggestion.id, { parentId: event.target.value })} className="h-9 w-full rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground/85 outline-none transition focus:border-purple-300 dark:focus:border-purple-500/40 focus:ring-2 focus:ring-purple-100 dark:focus:ring-purple-500/30">
                      <option value="">Create new parent category</option>
                      {activeCategories.filter((category) => !category.parentId).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                    </select>
                    <button type="button" onClick={() => updateDraft(suggestion.id, { parentId: '' })} className="inline-flex items-center gap-1 text-xs font-bold text-purple-600 dark:text-purple-300 transition hover:text-purple-700 dark:hover:text-purple-200"><Plus className="h-3.5 w-3.5" />Create new parent category</button>
                  </div>
                  <div className="grid min-w-0 gap-2">
                    {isActing ? <div className="flex items-center justify-center rounded-xl bg-muted/50 py-8"><Loader2 className="h-5 w-5 animate-spin text-purple-600 dark:text-purple-300" /></div> : <>
                      <button type="button" onClick={() => reviewOne(suggestion, 'approve')} className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700"><CheckCircle className="h-4 w-4" />Approve</button>
                      <div className="grid grid-cols-2 gap-2">
                        <button type="button" onClick={() => reviewOne(suggestion, 'merge', draft.parentId || duplicateTarget?.id)} disabled={!draft.parentId && !duplicateTarget?.id} className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-bold text-foreground/85 transition hover:bg-muted/50 disabled:opacity-40"><GitMerge className="h-3.5 w-3.5" />Merge</button>
                        <button type="button" onClick={() => reviewOne(suggestion, 'reject')} className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 px-3 py-2 text-xs font-bold text-red-700 dark:text-red-200 transition hover:bg-red-100 dark:hover:bg-red-500/20"><XCircle className="h-3.5 w-3.5" />Reject</button>
                      </div>
                    </>}
                  </div>
                </div>
              </div>
            );
          })}
          {!loading && filteredSuggestions.length === 0 && <div className="rounded-xl border border-dashed border-border py-14 text-center"><CheckCircle className="mx-auto h-8 w-8 text-emerald-500" /><p className="mt-3 text-sm font-semibold text-foreground/85">No matching suggestions</p><p className="mt-1 text-sm text-muted-foreground/75">{suggestions.length ? 'Try clearing search or filters.' : 'New AI suggestions will appear here after competency analysis.'}</p></div>}
        </div>

        <div className="mt-4 flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-medium text-muted-foreground">Showing {showingStart} to {showingEnd} of {filteredSuggestions.length} suggestion{filteredSuggestions.length === 1 ? '' : 's'}</p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={safePage <= 1} className="rounded-lg border border-border px-3 py-2 text-sm font-bold text-muted-foreground transition hover:bg-muted/50 disabled:opacity-40"><ChevronRight className="h-4 w-4 rotate-180" /></button>
            {Array.from({ length: totalPages }).map((_, index) => {
              const pageNumber = index + 1;
              return <button key={pageNumber} type="button" onClick={() => setPage(pageNumber)} className={`rounded-lg border px-3 py-2 text-sm font-bold transition ${safePage === pageNumber ? 'border-purple-300 dark:border-purple-500/40 bg-purple-50 dark:bg-purple-500/15 text-purple-700 dark:text-purple-200' : 'border-border text-muted-foreground hover:bg-muted/50'}`}>{pageNumber}</button>;
            })}
            <button type="button" onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))} disabled={safePage >= totalPages} className="rounded-lg border border-border px-3 py-2 text-sm font-bold text-muted-foreground transition hover:bg-muted/50 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>
      </div>
    </div>
  );
}
// ─── Matrix Tab (Overview + Editor) ──────────────────────────────────────

function MatrixTab({ onAnalyze }) {
  const [categories, setCategories] = useState([]);
  const [categoryTree, setCategoryTree] = useState([]);
  const [technicians, setTechnicians] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedTechId, setSelectedTechId] = useState(null);
  const [focusedTechId, setFocusedTechId] = useState(null);
  const [hoveredTechId, setHoveredTechId] = useState(null);
  const [showFocusedOnly, setShowFocusedOnly] = useState(false);
  const [categorySearch, setCategorySearch] = useState('');
  const [mappedOnly, setMappedOnly] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [matrixEditMode, setMatrixEditMode] = useState(false);
  const [matrixScrollLeft, setMatrixScrollLeft] = useState(0);
  const [matrixMaxScrollLeft, setMatrixMaxScrollLeft] = useState(0);
  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState(() => new Set());
  const matrixScrollRef = useRef(null);

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

  const mappingMap = {};
  // Competencies minted by the assignment-feedback learner (notes stamped
  // "Auto-created…") get a visible marker: admins should know which matrix
  // entries no human ever chose. A manual edit re-saves without the note,
  // which correctly clears the marker — the human has confirmed it.
  const autoLearnedMap = {};
  for (const m of mappings) {
    if (!mappingMap[m.technicianId]) mappingMap[m.technicianId] = {};
    mappingMap[m.technicianId][m.competencyCategoryId] = m.proficiencyLevel;
    if (typeof m.notes === 'string' && m.notes.startsWith('Auto-created')) {
      if (!autoLearnedMap[m.technicianId]) autoLearnedMap[m.technicianId] = {};
      autoLearnedMap[m.technicianId][m.competencyCategoryId] = true;
    }
  }

  const selectedTech = technicians.find((t) => t.id === selectedTechId);
  const focusedTech = technicians.find((t) => t.id === focusedTechId);
  const activeColumnTechId = focusedTechId || hoveredTechId;
  const visibleTechnicians = showFocusedOnly && focusedTech ? [focusedTech] : technicians;
  const topLevelCategories = categories.filter((category) => !category.parentId);
  const tree = categoryTree.length ? categoryTree : topLevelCategories;
  const expandableCategoryIds = tree.filter((category) => (category.subcategories || []).length > 0).map((category) => category.id);
  const expandableCategoryCount = expandableCategoryIds.length;
  const normalizedSearch = categorySearch.trim().toLowerCase();
  const hasVisibleMapping = (categoryId) => visibleTechnicians.some((tech) => Boolean(mappingMap[tech.id]?.[categoryId]));
  const displayCategories = tree.flatMap((category) => {
    const subcategories = category.subcategories || [];
    const categoryText = `${category.name || ''} ${category.description || ''}`.toLowerCase();
    const parentMatchesSearch = !normalizedSearch || categoryText.includes(normalizedSearch);
    const childMatches = subcategories.filter((subcategory) => {
      const subcategoryText = `${subcategory.name || ''} ${subcategory.description || ''} ${category.name || ''}`.toLowerCase();
      const matchesSearch = !normalizedSearch || parentMatchesSearch || subcategoryText.includes(normalizedSearch);
      const matchesMapping = !mappedOnly || hasVisibleMapping(subcategory.id);
      return matchesSearch && matchesMapping;
    });
    const parentMatchesMapping = !mappedOnly || hasVisibleMapping(category.id) || childMatches.length > 0;
    if (!parentMatchesSearch && childMatches.length === 0) return [];
    if (!parentMatchesMapping) return [];

    const rows = [{
      ...category,
      depth: 0,
      childCount: subcategories.length,
      visibleChildCount: childMatches.length,
      hasChildren: subcategories.length > 0,
    }];
    const forceExpandedForFilter = Boolean(normalizedSearch || mappedOnly);
    if (forceExpandedForFilter || !collapsedCategoryIds.has(category.id)) {
      rows.push(...childMatches.map((subcategory) => ({ ...subcategory, depth: 1, parentName: category.name })));
    }
    return rows;
  });
  const matrixMinWidth = MATRIX_CATEGORY_COL_WIDTH + (visibleTechnicians.length * MATRIX_TECH_COL_WIDTH);
  const canScrollMatrixLeft = matrixScrollLeft > 2;
  const canScrollMatrixRight = matrixScrollLeft < matrixMaxScrollLeft - 2;

  const updateMatrixScrollMetrics = useCallback(() => {
    const node = matrixScrollRef.current;
    if (!node) return;

    const nextMaxScrollLeft = Math.max(0, node.scrollWidth - node.clientWidth);
    setMatrixMaxScrollLeft(nextMaxScrollLeft);

    if (node.scrollLeft > nextMaxScrollLeft) {
      node.scrollLeft = nextMaxScrollLeft;
      setMatrixScrollLeft(nextMaxScrollLeft);
    } else {
      setMatrixScrollLeft(node.scrollLeft);
    }
  }, []);

  useEffect(() => {
    updateMatrixScrollMetrics();
    window.addEventListener('resize', updateMatrixScrollMetrics);
    return () => window.removeEventListener('resize', updateMatrixScrollMetrics);
  }, [matrixMinWidth, updateMatrixScrollMetrics]);

  const handleMatrixScroll = (event) => {
    const node = event.currentTarget;
    setMatrixScrollLeft(node.scrollLeft);
    setMatrixMaxScrollLeft(Math.max(0, node.scrollWidth - node.clientWidth));
  };

  const scrollMatrixBy = (direction) => {
    const node = matrixScrollRef.current;
    if (!node) return;
    node.scrollBy({
      left: direction * MATRIX_TECH_COL_WIDTH * 4,
      behavior: 'smooth',
    });
  };

  const toggleCategoryCollapsed = (categoryId) => {
    setCollapsedCategoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  };

  const collapseAllCategories = () => {
    setCollapsedCategoryIds(new Set(expandableCategoryIds));
  };

  const expandAllCategories = () => {
    setCollapsedCategoryIds(new Set());
  };

  if (loading) return <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-blue-600 dark:text-blue-300" /></div>;

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg p-3 text-sm text-red-700 dark:text-red-200">
          {error} <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {categories.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              Showing <span className="font-semibold text-foreground/85">{displayCategories.length}</span> rows across <span className="font-semibold text-foreground/85">{tree.length}</span> top categories and <span className="font-semibold text-foreground/85">{categories.length - tree.length}</span> subcategories.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setMatrixEditMode((enabled) => !enabled)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-bold shadow-sm transition-all ${
                  matrixEditMode
                    ? 'border-amber-300 dark:border-amber-500/40 bg-amber-100 dark:bg-amber-500/20 text-amber-900 dark:text-amber-200 ring-2 ring-amber-200 dark:ring-amber-500/30'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted/50'
                }`}
                title={matrixEditMode ? 'Disable matrix edits' : 'Enable matrix score editing'}
              >
                {matrixEditMode ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                {matrixEditMode ? 'Editing on' : 'Enable edits'}
              </button>
              {focusedTech && (
                <>
                  <button type="button" onClick={() => setSelectedTechId(focusedTech.id)} className="rounded-lg border border-purple-200 dark:border-purple-500/30 bg-purple-50 dark:bg-purple-500/15 px-2.5 py-1.5 text-xs font-semibold text-purple-700 dark:text-purple-200 transition-colors hover:bg-purple-100 dark:hover:bg-purple-500/20">Edit</button>
                  <button type="button" onClick={() => { setFocusedTechId(null); setShowFocusedOnly(false); }} className="rounded-lg border border-purple-200 dark:border-purple-500/30 bg-card px-2.5 py-1.5 text-xs font-semibold text-purple-700 dark:text-purple-200 transition-colors hover:bg-purple-50 dark:hover:bg-purple-500/15">Clear focus</button>
                </>
              )}
              {expandableCategoryCount > 0 && (
                <>
                  <button type="button" onClick={expandAllCategories} className="rounded-lg border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50">Expand all</button>
                  <button type="button" onClick={collapseAllCategories} className="rounded-lg border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50">Collapse all</button>
                </>
              )}
            </div>
          </div>

          <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(220px,1fr)_220px_auto_auto_auto]">
            <label className="relative block">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" />
              <input
                value={categorySearch}
                onChange={(event) => setCategorySearch(event.target.value)}
                placeholder="Search categories or subcategories"
                className="h-10 w-full rounded-lg border border-border bg-muted/50 pl-9 pr-9 text-sm outline-none transition-colors focus:border-purple-300 dark:focus:border-purple-500/40 focus:bg-card focus:ring-2 focus:ring-purple-100 dark:focus:ring-purple-500/30"
              />
              {categorySearch && (
                <button type="button" onClick={() => setCategorySearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground/75 hover:bg-secondary hover:text-foreground/85" title="Clear search">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </label>
            <select
              value={focusedTechId || ''}
              onChange={(event) => setFocusedTechId(event.target.value ? Number(event.target.value) : null)}
              className="h-10 rounded-lg border border-border bg-card px-3 text-sm text-foreground/85 outline-none transition-colors focus:border-purple-300 dark:focus:border-purple-500/40 focus:ring-2 focus:ring-purple-100 dark:focus:ring-purple-500/30"
              title="Highlight a technician column"
            >
              <option value="">Focus technician</option>
              {technicians.map((tech) => <option key={tech.id} value={tech.id}>{tech.name}</option>)}
            </select>
            <button
              type="button"
              disabled={!focusedTech}
              onClick={() => setShowFocusedOnly((value) => !value)}
              className={`h-10 rounded-lg border px-3 text-xs font-semibold transition-all ${showFocusedOnly ? 'border-purple-300 dark:border-purple-500/40 bg-purple-50 dark:bg-purple-500/15 text-purple-700 dark:text-purple-200' : 'border-border bg-card text-muted-foreground hover:bg-muted/50'} disabled:cursor-not-allowed disabled:opacity-40`}
              title="Show only the focused technician column"
            >
              {showFocusedOnly ? 'Showing one tech' : 'Show one tech'}
            </button>
            <button
              type="button"
              onClick={() => setMappedOnly((value) => !value)}
              className={`h-10 rounded-lg border px-3 text-xs font-semibold transition-all ${mappedOnly ? 'border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200' : 'border-border bg-card text-muted-foreground hover:bg-muted/50'}`}
              title="Temporarily hide rows with no mapping in the visible technician columns"
            >
              {mappedOnly ? 'Mapped rows only' : 'All rows'}
            </button>
            <button
              type="button"
              onClick={() => setCompactMode((value) => !value)}
              className={`h-10 rounded-lg border px-3 text-xs font-semibold transition-all ${compactMode ? 'border-muted-foreground/60 bg-muted text-foreground' : 'border-border bg-card text-muted-foreground hover:bg-muted/50'}`}
              title="Toggle a denser matrix row height"
            >
              {compactMode ? 'Compact' : 'Comfortable'}
            </button>
          </div>
        </div>
      )}

      {matrixEditMode && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-3 py-2 text-sm font-semibold text-amber-900 dark:text-amber-200 shadow-sm">
          <Unlock className="h-4 w-4" />
          Matrix edit mode is on. Score clicks auto-save immediately.
        </div>
      )}

      {/* Swapped-axis matrix: categories as rows, technicians as columns */}
      {technicians.length > 0 && (
        <div className="space-y-2">
          <div className="sticky top-[57px] z-30 overflow-hidden rounded-xl border border-border bg-card/95 shadow-lg shadow-black/5 dark:shadow-black/40 backdrop-blur">
            <div className="flex">
              <div
                className="flex shrink-0 items-center justify-between gap-3 border-r border-border bg-muted/50 px-3 text-sm font-semibold text-foreground/85"
                style={{ width: MATRIX_CATEGORY_COL_WIDTH }}
              >
                <span>Category / Subcategory</span>
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => scrollMatrixBy(-1)}
                    disabled={!canScrollMatrixLeft}
                    className="rounded-lg border border-border bg-card p-1.5 text-muted-foreground shadow-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-35"
                    aria-label="Scroll technicians left"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => scrollMatrixBy(1)}
                    disabled={!canScrollMatrixRight}
                    className="rounded-lg border border-border bg-card p-1.5 text-muted-foreground shadow-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-35"
                    aria-label="Scroll technicians right"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </span>
              </div>
              <div className="min-w-0 flex-1 overflow-hidden">
                <div
                  className="flex transition-transform duration-100 ease-out"
                  style={{ transform: `translateX(-${matrixScrollLeft}px)`, width: visibleTechnicians.length * MATRIX_TECH_COL_WIDTH }}
                >
                  {visibleTechnicians.map((tech) => {
                    const initials = getTechnicianInitials(tech.name);
                    const isFocused = focusedTechId === tech.id;
                    const isHovered = hoveredTechId === tech.id && !focusedTechId;
                    return (
                      <button
                        type="button"
                        key={tech.id}
                        onClick={() => {
                          setFocusedTechId(isFocused ? null : tech.id);
                          if (isFocused) setShowFocusedOnly(false);
                        }}
                        onDoubleClick={() => setSelectedTechId(tech.id)}
                        onMouseEnter={() => setHoveredTechId(tech.id)}
                        onMouseLeave={() => setHoveredTechId(null)}
                        className={`relative flex h-[74px] shrink-0 flex-col items-center justify-center gap-1 border-r px-1 text-center transition-all duration-150 ${
                          isFocused
                            ? 'border-purple-200 dark:border-purple-500/30 bg-purple-100 dark:bg-purple-500/20 text-purple-800 dark:text-purple-200 shadow-[inset_0_-3px_0_rgba(147,51,234,0.8)]'
                            : isHovered
                              ? 'border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 text-blue-800 dark:text-blue-200 shadow-[inset_0_-3px_0_rgba(37,99,235,0.45)]'
                              : 'border-border/60 bg-card text-muted-foreground hover:bg-muted/50'
                        }`}
                        style={{ width: MATRIX_TECH_COL_WIDTH }}
                      >
                        {tech.photoUrl ? (
                          <img src={tech.photoUrl} alt="" className={`h-9 w-9 rounded-full object-cover transition-all ${isFocused ? 'scale-105 ring-2 ring-purple-500 shadow-md' : isHovered ? 'ring-2 ring-blue-400 shadow-sm' : ''}`} />
                        ) : (
                          <span className={`flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-[10px] font-bold text-muted-foreground transition-all ${isFocused ? 'scale-105 ring-2 ring-purple-500 shadow-md' : isHovered ? 'ring-2 ring-blue-400 shadow-sm' : ''}`}>{initials}</span>
                        )}
                        <span className={`block max-w-[58px] truncate text-[10px] leading-tight ${isFocused || isHovered ? 'font-extrabold' : 'font-semibold'}`}>{tech.name.split(' ')[0]}</span>
                        {isFocused && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-purple-500 shadow-sm" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div
            ref={matrixScrollRef}
            onScroll={handleMatrixScroll}
            className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm [scrollbar-gutter:stable]"
          >
            <table className="text-sm border-collapse" style={{ minWidth: matrixMinWidth }}>
              <thead className="sr-only">
                <tr>
                  <th
                    className="sticky left-0 z-20 bg-muted/50 px-3 py-3 text-left font-medium text-muted-foreground"
                    style={{ width: MATRIX_CATEGORY_COL_WIDTH, minWidth: MATRIX_CATEGORY_COL_WIDTH }}
                  >
                  Category / Subcategory
                  </th>
                  {visibleTechnicians.map((tech) => {
                    const initials = getTechnicianInitials(tech.name);
                    const isFocused = focusedTechId === tech.id;
                    const isHovered = hoveredTechId === tech.id && !focusedTechId;
                    return (
                      <th
                        key={tech.id}
                        className={`cursor-pointer px-2 py-2 text-center transition-colors ${isFocused ? 'bg-purple-100 dark:bg-purple-500/20' : isHovered ? 'bg-blue-50 dark:bg-blue-500/15' : 'bg-muted/50 hover:bg-muted'}`}
                        style={{ width: MATRIX_TECH_COL_WIDTH, minWidth: MATRIX_TECH_COL_WIDTH }}
                        onClick={() => {
                          setFocusedTechId(isFocused ? null : tech.id);
                          if (isFocused) setShowFocusedOnly(false);
                        }}
                        onDoubleClick={() => setSelectedTechId(tech.id)}
                      >
                        <div className="flex flex-col items-center gap-1">
                          {tech.photoUrl ? (
                            <img src={tech.photoUrl} alt="" className={`w-8 h-8 rounded-full object-cover transition-all ${isFocused ? 'ring-2 ring-purple-500 shadow-md' : ''}`} />
                          ) : (
                            <span className={`w-8 h-8 rounded-full bg-secondary text-muted-foreground text-[10px] font-bold flex items-center justify-center transition-all ${isFocused ? 'ring-2 ring-purple-500 shadow-md' : ''}`}>{initials}</span>
                          )}
                          <span className="text-[9px] text-muted-foreground truncate max-w-[52px] block leading-tight font-medium">{tech.name.split(' ')[0]}</span>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {categories.length === 0 && (
                  <tr>
                    <td colSpan={visibleTechnicians.length + 1} className="px-4 py-8 text-center text-sm text-muted-foreground/75">
                    No categories yet. Add categories in the Categories tab to start mapping technicians.
                    </td>
                  </tr>
                )}
                {displayCategories.map((cat) => {
                  const isTopLevel = cat.depth === 0;
                  const isGroup = isTopLevel && cat.hasChildren;
                  const isStandaloneCategory = isTopLevel && !cat.hasChildren;
                  const isCollapsed = isGroup && collapsedCategoryIds.has(cat.id) && !normalizedSearch && !mappedOnly;
                  const childBadge = normalizedSearch || mappedOnly
                    ? (cat.visibleChildCount !== cat.childCount ? `${cat.visibleChildCount}/${cat.childCount}` : cat.childCount)
                    : cat.childCount;
                  const rowTone = isGroup ? 'bg-muted/30' : 'bg-card';
                  const labelCellTone = isGroup
                    ? 'bg-muted/50 py-2.5 text-sm font-semibold text-foreground'
                    : isStandaloneCategory
                      ? `${compactMode ? 'py-2' : 'py-2.5'} bg-card text-sm font-semibold text-foreground/85`
                      : `${compactMode ? 'py-1.5' : 'py-2'} bg-card text-xs font-medium text-muted-foreground`;

                  return (
                    <tr key={cat.id} className={`border-t transition-colors duration-200 hover:bg-muted/50 ${rowTone}`}>
                      <td
                        className={`sticky left-0 z-20 px-3 shadow-[1px_0_0_hsl(var(--border))] ${labelCellTone}`}
                        style={{ width: MATRIX_CATEGORY_COL_WIDTH, minWidth: MATRIX_CATEGORY_COL_WIDTH }}
                        title={cat.description || ''}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {isGroup && (
                            <button
                              type="button"
                              onClick={() => toggleCategoryCollapsed(cat.id)}
                              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-card hover:text-foreground hover:shadow-sm"
                              title={isCollapsed ? 'Expand category' : 'Collapse category'}
                              aria-expanded={!isCollapsed}
                            >
                              {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                            </button>
                          )}
                          {cat.depth === 1 && <span className="ml-7 h-px w-4 shrink-0 bg-muted-foreground/40" />}
                          <span className="min-w-0 flex-1 leading-snug">{cat.name}</span>
                          {isGroup && (
                            <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                              isCollapsed
                                ? 'bg-secondary text-muted-foreground'
                                : 'bg-card text-muted-foreground ring-1 ring-border'
                            }`}>
                              {isCollapsed ? `${cat.childCount} hidden` : childBadge}
                            </span>
                          )}
                        </div>
                      </td>
                      {visibleTechnicians.map((tech) => {
                        const level = mappingMap[tech.id]?.[cat.id] || '';
                        const levelInfo = PROFICIENCY_LEVELS.find((l) => l.value === level);
                        const autoLearned = !!autoLearnedMap[tech.id]?.[cat.id] && !!levelInfo;
                        const isFocused = focusedTechId === tech.id;
                        const isHovered = hoveredTechId === tech.id && !focusedTechId;
                        const isActiveColumn = activeColumnTechId === tech.id;
                        const CYCLE = ['', 'basic', 'intermediate', 'advanced', 'expert'];
                        const handleCycle = (e) => {
                          e.stopPropagation();
                          if (!matrixEditMode) return;

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
                          <td
                            key={tech.id}
                            className={`relative px-1 text-center ${compactMode ? 'py-0.5' : 'py-1'} transition-all duration-150 ${
                              isFocused
                                ? 'bg-purple-100/80 dark:bg-purple-500/15 shadow-[inset_2px_0_0_rgba(147,51,234,0.35),inset_-2px_0_0_rgba(147,51,234,0.35)]'
                                : isHovered
                                  ? 'bg-blue-50/80 dark:bg-blue-500/10 shadow-[inset_1px_0_0_rgba(37,99,235,0.22),inset_-1px_0_0_rgba(37,99,235,0.22)]'
                                  : ''
                            }`}
                          >
                            {isFocused && <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-purple-300/70" />}
                            <button
                              type="button"
                              onClick={handleCycle}
                              disabled={!matrixEditMode}
                              className={`relative z-10 h-7 w-7 rounded-lg text-center text-[10px] font-bold leading-7 transition-all ${
                                matrixEditMode ? 'cursor-pointer hover:scale-110 hover:shadow-sm' : 'cursor-default'
                              } ${
                                levelInfo
                                  ? `${levelInfo.color} ${isActiveColumn ? 'ring-2 ring-card shadow-md' : ''}`
                                  : isActiveColumn
                                    ? 'bg-card/75 text-muted-foreground/50 ring-1 ring-purple-200 dark:ring-purple-500/30'
                                    : `${matrixEditMode ? 'text-muted-foreground/40 hover:bg-muted' : 'text-muted-foreground/40'}`
                              }`}
                              title={`${cat.depth === 1 ? `${cat.parentName} > ` : ''}${cat.name} × ${tech.name}: ${level || 'not set'}${autoLearned ? ' — AUTO-LEARNED from assignment feedback, no human set this' : ''} (${matrixEditMode ? 'click to cycle and auto-save' : 'enable edits to change'})`}
                            >
                              {levelInfo ? levelInfo.num : '·'}
                              {autoLearned && (
                                <span
                                  className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-card"
                                  aria-label="Auto-learned competency"
                                />
                              )}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {displayCategories.length === 0 && categories.length > 0 && (
                  <tr>
                    <td colSpan={visibleTechnicians.length + 1} className="px-4 py-8 text-center text-sm text-muted-foreground/75">
                    No rows match the current matrix filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Legend */}
      {categories.length > 0 && (
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="font-medium">Legend:</span>
          <span className="px-1.5 py-0.5 rounded bg-yellow-100 dark:bg-yellow-500/20 text-yellow-800 dark:text-yellow-200">1 = Basic</span>
          <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-500/20 text-blue-800 dark:text-blue-200">2 = Comfortable</span>
          <span className="px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-500/20 text-indigo-800 dark:text-indigo-200">3 = Advanced</span>
          <span className="px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-500/20 text-green-800 dark:text-green-200">4 = Expert / SME</span>
          <span className="ml-2 text-muted-foreground/75">{matrixEditMode ? 'Click cell to cycle and auto-save' : 'Enable edits before changing scores'} · Click agent header to spotlight column · Double-click header to edit</span>
        </div>
      )}

      {/* Technician Editor — Slide-over overlay */}
      {selectedTech && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black bg-opacity-30" onClick={() => setSelectedTechId(null)} />
          <div className="relative w-full max-w-xl bg-card shadow-2xl overflow-y-auto animate-slide-in-right">
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

      {technicians.length === 0 && (
        <p className="text-muted-foreground text-sm text-center py-4">No active technicians found in this workspace.</p>
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
    checking: { icon: Loader2, text: 'Checking for existing analysis...', color: 'text-muted-foreground', spin: true },
    connecting: { icon: Loader2, text: 'Starting analysis...', color: 'text-muted-foreground', spin: true },
    running: { icon: Brain, text: `Analyzing competencies... (${elapsedSec}s)`, color: 'text-purple-600 dark:text-purple-300', spin: true },
    completed: { icon: CheckCircle, text: 'Analysis complete — auto-applied', color: 'text-green-600 dark:text-green-300', spin: false },
    error: { icon: XCircle, text: 'Analysis failed', color: 'text-red-600 dark:text-red-300', spin: false },
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
    ? 'text-amber-600 dark:text-amber-300'
    : statusInfo.color;
  const StatusIcon = statusInfo.icon;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <StatusIcon className={`w-5 h-5 ${statusColor} ${statusInfo.spin ? 'animate-spin' : ''}`} />
          <span className={`text-sm font-medium ${statusColor}`}>{statusText}</span>
          {runId && <CopyBadge label="CR" value={runId} />}
          <span className="text-sm text-muted-foreground">| {techName}</span>
        </div>
        {onBack && <button onClick={onBack} className="text-sm text-blue-600 dark:text-blue-300 hover:underline">Back</button>}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto border rounded-lg bg-card p-2.5 sm:p-4 min-h-[200px] sm:min-h-[300px] max-h-[60vh] sm:max-h-[600px]">
        {events.length === 0 && (status === 'connecting' || status === 'checking') && <div className="flex items-center justify-center h-full text-muted-foreground/75"><Loader2 className="w-6 h-6 animate-spin" /></div>}
        {events.length === 0 && status === 'completed' && completedRun && (
          <div className="text-sm text-muted-foreground">
            <p className="mb-2 text-xs text-muted-foreground/75">Showing results from previous analysis (run CR-{completedRun.id}, {formatDateTimeInTimezone(completedRun.createdAt, workspaceTimezone)})</p>
            {completedRun.decision === 'preserved_existing' && (
              <p className="mb-2 text-xs text-amber-700 dark:text-amber-200 bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30 rounded px-2 py-1">
                Existing skills were preserved because clean canonical category evidence was too sparse.
              </p>
            )}
            {(completedRun.structuredResult?.competencies || []).length === 0 && (
              <p className="text-xs text-muted-foreground">No skill changes were submitted.</p>
            )}
            {completedRun.structuredResult?.competencies?.map((comp, i) => (
              <div key={i} className="mb-1">
                <span className="font-medium">{comp.categoryName}</span>
                {' '}<span className={`text-xs px-1.5 py-0.5 rounded ${PROFICIENCY_LEVELS.find((l) => l.value === comp.proficiencyLevel)?.color || ''}`}>{comp.proficiencyLevel}</span>
                {comp.confidence && <span className="text-xs text-muted-foreground/75 ml-1">({comp.confidence})</span>}
              </div>
            ))}
            <button onClick={() => navigate(`/assignments/competency-live/${techId}?force=true`)} className="mt-3 text-xs text-purple-600 dark:text-purple-300 hover:underline">Run new analysis instead</button>
          </div>
        )}
        {events.length > 0 && (
          <StreamContent events={events} toolCalls={toolCalls} thinkingKb={thinkingKb} status={status} accentColor="purple" />
        )}
      </div>

      {error && (
        <div className="mt-3 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg p-3 text-sm text-red-700 dark:text-red-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {error}
        </div>
      )}

      {(assessment || completedRun) && (
        <div className="mt-4 border-t pt-4 space-y-4">
          <h4 className="text-sm font-semibold text-foreground/85">
            {resultDecision === 'preserved_existing'
              ? 'Assessment Result (Existing Skills Preserved)'
              : resultDecision === 'no_changes'
                ? 'Assessment Result (No Skill Changes)'
                : 'Assessment Result (Auto-Applied)'}
          </h4>
          {resultDecision === 'preserved_existing' && (
            <div className="bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30 rounded-lg p-3 text-sm text-amber-900 dark:text-amber-200">
              {assessment?.applyResult?.preserveReason || completedRun?.structuredResult?.applyResult?.preserveReason || 'Existing skills were preserved because the run did not have enough clean canonical Ticket Pulse category evidence.'}
            </div>
          )}
          {(assessment?.overallSummary || completedRun?.structuredResult?.overallSummary) && (
            <p className="text-sm text-muted-foreground bg-purple-50 dark:bg-purple-500/15 rounded-lg p-3">{assessment?.overallSummary || completedRun?.structuredResult?.overallSummary}</p>
          )}
          {completedRun?.beforeSnapshot && completedRun?.afterSnapshot && (
            <CompetencyDiff before={completedRun.beforeSnapshot.competencies || []} after={completedRun.afterSnapshot?.competencies || []} />
          )}
          {!completedRun && assessment && (
            <div className="space-y-2">
              {(assessment.competencies || []).map((comp, i) => (
                <div key={i} className="border rounded-lg p-3 bg-card">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{comp.categoryName}</span>
                      {comp.categoryAction === 'create_new' && <span className="text-xs bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-200 px-1.5 py-0.5 rounded">new</span>}
                      <span className={`text-xs px-1.5 py-0.5 rounded ${PROFICIENCY_LEVELS.find((l) => l.value === comp.proficiencyLevel)?.color || ''}`}>{comp.proficiencyLevel}</span>
                    </div>
                    {comp.confidence && <span className="text-xs text-muted-foreground/75">{comp.confidence}</span>}
                  </div>
                  {comp.evidenceSummary && <p className="text-xs text-muted-foreground mt-1">{comp.evidenceSummary}</p>}
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-3">
            <button onClick={() => { onComplete?.(); }} className="text-sm text-blue-600 dark:text-blue-300 hover:underline">Back to matrix</button>
            {runId && <button onClick={() => navigate(`/assignments/competency-run/${runId}`)} className="text-sm text-purple-600 dark:text-purple-300 hover:underline">View full run details</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Diff View ───────────────────────────────────────────────────────────

function CompetencyDiff({ before, after }) {
  const [viewMode, setViewMode] = useState('audit');
  const [rowFilter, setRowFilter] = useState('changed');
  const beforeMap = {};
  for (const c of before) beforeMap[c.categoryName] = c.proficiencyLevel;
  const afterMap = {};
  for (const c of after) afterMap[c.categoryName] = c.proficiencyLevel;
  const allCategories = [...new Set([...before.map((c) => c.categoryName), ...after.map((c) => c.categoryName)])].sort();
  const levelRank = PROFICIENCY_LEVELS.reduce((acc, level, index) => {
    acc[level.value] = index + 1;
    return acc;
  }, {});

  const rows = allCategories.map((name) => {
    const bLevel = beforeMap[name] || null;
    const aLevel = afterMap[name] || null;
    let changeType = 'unchanged';
    if (!bLevel && aLevel) changeType = 'added';
    else if (bLevel && !aLevel) changeType = 'removed';
    else if (bLevel !== aLevel) {
      const beforeRank = levelRank[bLevel] || 0;
      const afterRank = levelRank[aLevel] || 0;
      changeType = afterRank > beforeRank ? 'increased' : afterRank < beforeRank ? 'decreased' : 'changed';
    }
    const beforeRank = levelRank[bLevel] || 0;
    const afterRank = levelRank[aLevel] || 0;
    return { name, bLevel, aLevel, changeType, beforeRank, afterRank, delta: afterRank - beforeRank };
  });

  const getLevelBadge = (level) => {
    if (!level) return <span className="inline-flex min-w-[92px] justify-center rounded-md border border-dashed border-border bg-muted/50 px-2 py-1 text-xs font-semibold text-muted-foreground/50">none</span>;
    const info = PROFICIENCY_LEVELS.find((l) => l.value === level);
    return <span className={`inline-flex min-w-[92px] justify-center rounded-md px-2 py-1 text-xs font-bold ${info?.color || ''}`}>{level}</span>;
  };
  const ROW_STYLES = {
    added: 'bg-emerald-50/85 dark:bg-emerald-500/10 border-emerald-100 dark:border-emerald-500/20 hover:bg-emerald-100/70 dark:hover:bg-emerald-500/15',
    removed: 'bg-rose-50/85 dark:bg-rose-500/10 border-rose-100 dark:border-rose-500/20 hover:bg-rose-100/70 dark:hover:bg-rose-500/15',
    increased: 'bg-blue-50/85 dark:bg-blue-500/10 border-blue-100 dark:border-blue-500/20 hover:bg-blue-100/70 dark:hover:bg-blue-500/15',
    decreased: 'bg-orange-50/85 dark:bg-orange-500/10 border-orange-100 dark:border-orange-500/20 hover:bg-orange-100/70 dark:hover:bg-orange-500/15',
    changed: 'bg-violet-50/85 dark:bg-violet-500/10 border-violet-100 dark:border-violet-500/20 hover:bg-violet-100/70 dark:hover:bg-violet-500/15',
    unchanged: 'bg-card border-border/60 hover:bg-muted/50',
  };
  const CHANGE_LABELS = {
    added: <span className="inline-flex min-w-[76px] justify-center rounded-full bg-emerald-100 dark:bg-emerald-500/20 px-2 py-1 text-[10px] font-extrabold uppercase tracking-wide text-emerald-800 dark:text-emerald-200">Added</span>,
    removed: <span className="inline-flex min-w-[76px] justify-center rounded-full bg-rose-100 dark:bg-rose-500/20 px-2 py-1 text-[10px] font-extrabold uppercase tracking-wide text-rose-800 dark:text-rose-200">Removed</span>,
    increased: <span className="inline-flex min-w-[76px] justify-center rounded-full bg-blue-100 dark:bg-blue-500/20 px-2 py-1 text-[10px] font-extrabold uppercase tracking-wide text-blue-800 dark:text-blue-200">Up</span>,
    decreased: <span className="inline-flex min-w-[76px] justify-center rounded-full bg-orange-100 dark:bg-orange-500/20 px-2 py-1 text-[10px] font-extrabold uppercase tracking-wide text-orange-800 dark:text-orange-200">Down</span>,
    changed: <span className="inline-flex min-w-[76px] justify-center rounded-full bg-violet-100 dark:bg-violet-500/20 px-2 py-1 text-[10px] font-extrabold uppercase tracking-wide text-violet-800 dark:text-violet-200">Changed</span>,
    unchanged: null,
  };
  const changedCount = rows.filter((r) => r.changeType !== 'unchanged').length;
  const countByType = rows.reduce((acc, row) => {
    acc[row.changeType] = (acc[row.changeType] || 0) + 1;
    return acc;
  }, {});
  const filterOptions = [
    { key: 'changed', label: 'Changed', count: changedCount },
    { key: 'added', label: 'Added', count: countByType.added || 0 },
    { key: 'increased', label: 'Up', count: countByType.increased || 0 },
    { key: 'decreased', label: 'Down', count: countByType.decreased || 0 },
    { key: 'removed', label: 'Removed', count: countByType.removed || 0 },
    { key: 'unchanged', label: 'Same', count: countByType.unchanged || 0 },
    { key: 'all', label: 'All', count: rows.length },
  ];
  const filteredRows = rows.filter((row) => {
    if (rowFilter === 'all') return true;
    if (rowFilter === 'changed') return row.changeType !== 'unchanged';
    return row.changeType === rowFilter;
  });
  const groupedRows = [
    {
      key: 'added',
      title: 'Added Skills',
      subtitle: 'New mappings created by this run',
      rows: rows.filter((row) => row.changeType === 'added'),
      className: 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15',
      badgeClassName: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-200',
    },
    {
      key: 'increased',
      title: 'Moved Up',
      subtitle: 'Existing skills raised to a stronger level',
      rows: rows.filter((row) => row.changeType === 'increased'),
      className: 'border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15',
      badgeClassName: 'bg-blue-100 dark:bg-blue-500/20 text-blue-800 dark:text-blue-200',
    },
    {
      key: 'decreased',
      title: 'Moved Down',
      subtitle: 'Existing skills lowered by the run',
      rows: rows.filter((row) => row.changeType === 'decreased'),
      className: 'border-orange-200 dark:border-orange-500/30 bg-orange-50 dark:bg-orange-500/15',
      badgeClassName: 'bg-orange-100 dark:bg-orange-500/20 text-orange-800 dark:text-orange-200',
    },
    {
      key: 'removed',
      title: 'Removed Skills',
      subtitle: 'Mappings removed from the technician',
      rows: rows.filter((row) => row.changeType === 'removed'),
      className: 'border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/15',
      badgeClassName: 'bg-rose-100 dark:bg-rose-500/20 text-rose-800 dark:text-rose-200',
    },
  ];

  const MOVE_STYLES = {
    added: {
      label: 'Added',
      detail: 'new skill',
      icon: Plus,
      shell: 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-200 shadow-emerald-100',
      line: 'from-emerald-400 to-emerald-600',
      marker: 'bg-emerald-600',
    },
    increased: {
      label: 'Up',
      detail: 'increased',
      icon: ArrowUpRight,
      shell: 'border-blue-200 dark:border-blue-500/30 bg-blue-100 dark:bg-blue-500/20 text-blue-800 dark:text-blue-200 shadow-blue-100',
      line: 'from-blue-400 to-blue-600',
      marker: 'bg-blue-600',
    },
    decreased: {
      label: 'Down',
      detail: 'lowered',
      icon: ArrowDownRight,
      shell: 'border-orange-200 dark:border-orange-500/30 bg-orange-100 dark:bg-orange-500/20 text-orange-800 dark:text-orange-200 shadow-orange-100',
      line: 'from-orange-400 to-orange-600',
      marker: 'bg-orange-600',
    },
    removed: {
      label: 'Removed',
      detail: 'removed',
      icon: X,
      shell: 'border-rose-200 dark:border-rose-500/30 bg-rose-100 dark:bg-rose-500/20 text-rose-800 dark:text-rose-200 shadow-rose-100',
      line: 'from-rose-500 to-rose-700',
      marker: 'bg-rose-700',
    },
    changed: {
      label: 'Changed',
      detail: 'changed',
      icon: ArrowUpDown,
      shell: 'border-violet-200 dark:border-violet-500/30 bg-violet-100 dark:bg-violet-500/20 text-violet-800 dark:text-violet-200 shadow-violet-100',
      line: 'from-violet-400 to-violet-600',
      marker: 'bg-violet-600',
    },
    unchanged: {
      label: 'Same',
      detail: 'no change',
      icon: null,
      shell: 'border-border bg-card text-muted-foreground/75',
      line: 'from-secondary to-muted-foreground/40',
      marker: 'bg-muted-foreground/40',
    },
  };

  const DirectionIcon = ({ row }) => {
    const meta = MOVE_STYLES[row.changeType] || MOVE_STYLES.unchanged;
    const Icon = meta.icon;
    if (!Icon) return <span className="h-px w-8 rounded bg-muted-foreground/40" />;
    return <Icon className="h-4 w-4" />;
  };

  const MovementIndicator = ({ row }) => {
    const meta = MOVE_STYLES[row.changeType] || MOVE_STYLES.unchanged;
    return (
      <div className="flex min-w-[132px] flex-col items-center gap-1">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-extrabold uppercase tracking-wide shadow-sm ${meta.shell}`}>
          <DirectionIcon row={row} />
          {meta.label}
          {row.delta !== 0 && <span className="rounded-full bg-card/80 px-1.5 py-0.5 text-[10px]">{row.delta > 0 ? `+${row.delta}` : row.delta}</span>}
        </span>
        <div className="flex w-full items-center justify-center gap-1 px-2">
          <span className={`h-1.5 w-1.5 rounded-full ${meta.marker}`} />
          <span className={`h-0.5 flex-1 rounded bg-gradient-to-r ${meta.line}`} />
          <span className={`h-1.5 w-1.5 rounded-full ${meta.marker}`} />
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75">{meta.detail}</span>
      </div>
    );
  };

  const DiffMiniRow = ({ row }) => (
    <div className="rounded-lg border border-card/70 dark:border-white/10 bg-card/80 p-2 shadow-sm">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0 font-semibold text-foreground">{row.name}</div>
        {CHANGE_LABELS[row.changeType]}
      </div>
      <div className="flex items-center gap-2">
        {getLevelBadge(row.bLevel)}
        <DirectionIcon row={row} />
        {getLevelBadge(row.aLevel)}
        {row.delta !== 0 && (
          <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold ${row.delta > 0 ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200' : 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-200'}`}>
            {row.delta > 0 ? `+${row.delta}` : row.delta}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div className="rounded-2xl border border-border bg-card p-3 shadow-sm">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-bold text-foreground">Before / After Comparison</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {changedCount} change{changedCount !== 1 ? 's' : ''}: {countByType.added || 0} added, {countByType.increased || 0} up, {countByType.decreased || 0} down, {countByType.removed || 0} removed.
          </p>
        </div>
        <div className="flex rounded-xl border border-border bg-muted/50 p-1">
          <button
            type="button"
            onClick={() => setViewMode('impact')}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${viewMode === 'impact' ? 'bg-card text-purple-700 dark:text-purple-200 shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Option A: Impact
          </button>
          <button
            type="button"
            onClick={() => setViewMode('audit')}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${viewMode === 'audit' ? 'bg-card text-purple-700 dark:text-purple-200 shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Option B: Audit
          </button>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
        <div className="rounded-xl border border-border bg-muted/50 p-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Total changes</div>
          <div className="mt-1 text-2xl font-extrabold text-foreground">{changedCount}</div>
        </div>
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 p-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-200">Added</div>
          <div className="mt-1 text-2xl font-extrabold text-emerald-800 dark:text-emerald-200">{countByType.added || 0}</div>
        </div>
        <div className="rounded-xl border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 p-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-blue-700 dark:text-blue-200">Moved up</div>
          <div className="mt-1 text-2xl font-extrabold text-blue-800 dark:text-blue-200">{countByType.increased || 0}</div>
        </div>
        <div className="rounded-xl border border-orange-200 dark:border-orange-500/30 bg-orange-50 dark:bg-orange-500/15 p-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-orange-700 dark:text-orange-200">Moved down</div>
          <div className="mt-1 text-2xl font-extrabold text-orange-800 dark:text-orange-200">{countByType.decreased || 0}</div>
        </div>
        <div className="rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/15 p-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-rose-700 dark:text-rose-200">Removed</div>
          <div className="mt-1 text-2xl font-extrabold text-rose-800 dark:text-rose-200">{countByType.removed || 0}</div>
        </div>
      </div>

      {viewMode === 'impact' ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {groupedRows.map((group) => (
            <section key={group.key} className={`rounded-xl border p-3 ${group.className}`}>
              <div className="mb-3 flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-extrabold text-foreground">{group.title}</div>
                  <div className="text-xs text-muted-foreground">{group.subtitle}</div>
                </div>
                <span className={`rounded-full px-2 py-1 text-xs font-extrabold ${group.badgeClassName}`}>{group.rows.length}</span>
              </div>
              <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                {group.rows.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-card/80 bg-card/50 px-3 py-5 text-center text-xs font-medium text-muted-foreground">No items</div>
                ) : group.rows.map((row) => <DiffMiniRow key={row.name} row={row} />)}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {filterOptions.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setRowFilter(option.key)}
                className={`rounded-full border px-2.5 py-1 text-xs font-bold transition-colors ${rowFilter === option.key ? 'border-purple-300 dark:border-purple-500/40 bg-purple-50 dark:bg-purple-500/15 text-purple-700 dark:text-purple-200' : 'border-border bg-card text-muted-foreground hover:bg-muted/50 hover:text-foreground'}`}
              >
                {option.label} <span className="ml-1 text-[10px] opacity-70">{option.count}</span>
              </button>
            ))}
          </div>
          <div className="overflow-hidden rounded-xl border border-border shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="w-[40%] px-4 py-2 text-right font-bold uppercase tracking-wide text-muted-foreground">Skill</th>
                  <th className="w-32 px-3 py-2 text-center font-bold uppercase tracking-wide text-muted-foreground">Before</th>
                  <th className="w-40 px-2 py-2 text-center font-bold uppercase tracking-wide text-muted-foreground">Movement</th>
                  <th className="w-32 px-3 py-2 text-center font-bold uppercase tracking-wide text-muted-foreground">After</th>
                  <th className="w-24 px-2 py-2 text-center font-bold uppercase tracking-wide text-muted-foreground">Result</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.name} className={`border-t transition-colors ${ROW_STYLES[row.changeType]}`}>
                    <td className="px-4 py-3 text-right">
                      <div className="ml-auto max-w-[620px] text-base font-extrabold leading-snug text-foreground">
                        {row.name}
                      </div>
                      {row.changeType === 'unchanged' && <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75">unchanged reference row</div>}
                    </td>
                    <td className="px-3 py-3 text-center">{getLevelBadge(row.bLevel)}</td>
                    <td className="px-2 py-3 text-center"><MovementIndicator row={row} /></td>
                    <td className="px-3 py-3 text-center">{getLevelBadge(row.aLevel)}</td>
                    <td className="px-2 py-3 text-center">{CHANGE_LABELS[row.changeType] || <span className="inline-flex min-w-[76px] justify-center rounded-full bg-muted px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground/75">Same</span>}</td>
                  </tr>
                ))}
                {filteredRows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground/75">No rows match this filter.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-3 rounded-xl border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-bold text-foreground">Option A</span> groups impact for fast approval. <span className="font-bold text-foreground">Option B</span> keeps the audit table when you need exact row-by-row review.
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
    auto_applied: 'bg-green-100 dark:bg-green-500/20 text-green-800 dark:text-green-200',
    preserved_existing: 'bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-200',
    rolled_back: 'bg-red-100 dark:bg-red-500/20 text-red-800 dark:text-red-200',
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
        <button onClick={() => { setSelectedRun(null); navigate('/assignments/competencies'); }} className="text-sm text-blue-600 dark:text-blue-300 hover:underline mb-4 flex items-center gap-1">
          <ChevronRight className="w-4 h-4 rotate-180" /> Back to history
        </button>
        <div className="space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-lg font-semibold">Competency Run CR-{selectedRun.id}</h3>
                <CopyBadge label="CR" value={selectedRun.id} />
              </div>
              <p className="text-sm text-muted-foreground">{selectedRun.technician?.name} | {formatDateTimeInTimezone(selectedRun.createdAt, workspaceTimezone)}</p>
              <p className="text-xs text-muted-foreground/75">{selectedRun.totalDurationMs ? `${(selectedRun.totalDurationMs / 1000).toFixed(1)}s` : ''} {selectedRun.totalTokensUsed ? `| ${selectedRun.totalTokensUsed} tokens` : ''}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`px-3 py-1 rounded-full text-xs font-medium ${DECISION_COLORS[selectedRun.decision] || 'bg-muted text-muted-foreground'}`}>
                {(selectedRun.decision || selectedRun.status || '').replace(/_/g, ' ')}
              </span>
              {selectedRun.decision === 'auto_applied' && (
                <button onClick={() => handleRollback(selectedRun.id)} className="px-3 py-1 bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-200 rounded-lg text-xs font-medium hover:bg-red-200 dark:hover:bg-red-500/30 flex items-center gap-1"><RotateCcw className="w-3 h-3" /> Rollback</button>
              )}
              {selectedRun.status === 'running' && (
                <button onClick={() => handleCancel(selectedRun.id)} className="px-3 py-1 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700 flex items-center gap-1"><XCircle className="w-3 h-3" /> Cancel</button>
              )}
            </div>
          </div>
          {selectedRun.decision === 'preserved_existing' && (
            <div className="bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30 rounded-lg p-3">
              <p className="text-sm text-amber-900 dark:text-amber-200">
                {selectedRun.structuredResult?.applyResult?.preserveReason || 'Existing skills were preserved because the run did not have enough clean canonical Ticket Pulse category evidence.'}
              </p>
            </div>
          )}
          {selectedRun.structuredResult?.overallSummary && <div className="bg-purple-50 dark:bg-purple-500/15 border border-purple-200 dark:border-purple-500/30 rounded-lg p-3"><p className="text-sm text-purple-900 dark:text-purple-200">{selectedRun.structuredResult.overallSummary}</p></div>}
          {selectedRun.beforeSnapshot && selectedRun.afterSnapshot && <CompetencyDiff before={selectedRun.beforeSnapshot.competencies || []} after={selectedRun.afterSnapshot?.competencies || []} />}
          {selectedRun.steps?.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-foreground/85 mb-2">Pipeline Steps</h4>
              {selectedRun.steps.map((step) => <ToolCallCard key={step.id} name={step.stepName} input={step.input} result={step.output} durationMs={step.durationMs} />)}
            </div>
          )}
          {selectedRun.fullTranscript && (
            <div>
              <h4 className="text-sm font-semibold text-foreground/85 mb-2">Full Conversation</h4>
              <div className="border rounded-lg bg-card p-4 prose prose-sm max-w-none max-h-[400px] overflow-y-auto">
                <Markdown remarkPlugins={[remarkGfm]}>{cleanTranscript(selectedRun.fullTranscript)}</Markdown>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (loading) return <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-blue-600 dark:text-blue-300" /></div>;

  return (
    <div>
      {actionMsg && <div className="mb-3 text-sm text-green-600 dark:text-green-300 bg-green-50 dark:bg-green-500/15 border border-green-200 dark:border-green-500/30 rounded-lg px-3 py-2">{actionMsg}</div>}
      <p className="text-sm text-muted-foreground mb-4">{runs.total} competency analysis run{runs.total !== 1 ? 's' : ''}</p>
      {runs.items.length === 0 ? (
        <p className="text-muted-foreground/75 text-sm text-center py-8">No competency analysis runs yet.</p>
      ) : (
        <div className="space-y-2">
          {runs.items.map((run) => (
            <button key={run.id} onClick={() => handleSelectRun(run.id)} className="w-full text-left border rounded-lg p-3 hover:bg-muted/50 transition-colors">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">{run.technician?.name || `Tech #${run.technicianId}`}</p>
                  <p className="text-xs text-muted-foreground">{formatDateTimeInTimezone(run.createdAt, workspaceTimezone)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${DECISION_COLORS[run.decision] || 'bg-muted text-muted-foreground'}`}>
                    {(run.decision || run.status || '').replace(/_/g, ' ')}
                  </span>
                  <ChevronRight className="w-4 h-4 text-muted-foreground/75" />
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

  if (loading) return <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-blue-600 dark:text-blue-300" /></div>;

  const STATUS_BADGES = { published: 'bg-green-100 dark:bg-green-500/20 text-green-800 dark:text-green-200', draft: 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-800 dark:text-yellow-200', archived: 'bg-muted text-muted-foreground' };

  return (
    <div className="space-y-6">
      {error && <div className="bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg p-3 text-sm text-red-700 dark:text-red-200">{error} <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button></div>}

      <div>
        <h4 className="text-sm font-semibold text-foreground/85 mb-2 flex items-center gap-1.5"><Wrench className="w-4 h-4" /> Available Tools ({tools.length})</h4>
        <div className="space-y-1">
          {tools.map((tool) => (
            <div key={tool.name} className="border rounded-lg bg-card overflow-hidden">
              <button onClick={() => setToolsExpanded((p) => ({ ...p, [tool.name]: !p[tool.name] }))} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors">
                {toolsExpanded[tool.name] ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/75" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/75" />}
                <code className="text-xs font-semibold text-purple-700 dark:text-purple-200">{tool.name}</code>
                <span className="text-xs text-muted-foreground/75 truncate flex-1">{tool.description.slice(0, 80)}{tool.description.length > 80 ? '...' : ''}</span>
              </button>
              {toolsExpanded[tool.name] && <div className="px-3 pb-3 border-t bg-muted/50"><p className="text-xs text-muted-foreground mt-2">{tool.description}</p></div>}
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold text-foreground/85 flex items-center gap-1.5"><FileText className="w-4 h-4" /> Competency System Prompt</h4>
          {published && <span className="text-xs text-muted-foreground/75">Published: v{published.version}</span>}
        </div>
        <textarea value={editText} onChange={(e) => setEditText(e.target.value)} className="w-full border rounded-lg p-3 text-sm font-mono resize-y min-h-[250px] bg-muted/50 focus:bg-card focus:ring-2 focus:ring-purple-200 dark:focus:ring-purple-500/30 transition-colors" />
        <div className="flex items-center gap-2 mt-2">
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Version notes (optional)" className="flex-1 border rounded-lg px-3 py-2 text-sm" />
          <button onClick={handleSaveDraft} disabled={saving || !editText.trim()} className="px-4 py-2 border rounded-lg text-sm font-medium hover:bg-muted/50 disabled:opacity-50 flex items-center gap-1.5">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save Draft
          </button>
        </div>
        {saveMsg && <p className="text-sm text-green-600 dark:text-green-300 mt-2 flex items-center gap-1"><CheckCircle className="w-4 h-4" /> {saveMsg}</p>}
      </div>

      <div>
        <h4 className="text-sm font-semibold text-foreground/85 mb-2 flex items-center gap-1.5"><Clock className="w-4 h-4" /> Version History</h4>
        {versions.length === 0 ? <p className="text-muted-foreground/75 text-sm">No versions yet.</p> : (
          <div className="space-y-1.5">
            {versions.map((v) => (
              <div key={v.id} className="flex items-center justify-between bg-card border rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="text-sm font-mono font-medium text-foreground/85">v{v.version}</span>
                  <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${STATUS_BADGES[v.status] || ''}`}>{v.status}</span>
                  {v.notes && <span className="text-xs text-muted-foreground/75 truncate">{v.notes}</span>}
                </div>
                <div className="flex items-center gap-1 ml-2">
                  {v.status !== 'published' && <button onClick={() => handlePublish(v.id)} disabled={publishing} className="p-1.5 hover:bg-green-50 dark:hover:bg-green-500/15 rounded"><Upload className="w-3.5 h-3.5 text-green-600 dark:text-green-300" /></button>}
                  <button onClick={() => handleRestore(v.id)} className="p-1.5 hover:bg-blue-50 dark:hover:bg-blue-500/15 rounded"><RotateCcw className="w-3.5 h-3.5 text-blue-600 dark:text-blue-300" /></button>
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
  { id: 'categories', label: 'Categories', icon: Folder },
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
  // Which category tools this workspace gets is decided by the BACKEND
  // (the FS_TAXONOMY_SYNC / CANONICAL_CATEGORY workspace sets drive the
  // drift/sync and reclassify services) — asking it keeps the UI from
  // drifting from what the API allows. Two separate gates since Phase PA:
  // - skillHierarchyEnabled (FS-sync set) → FS drift/sync migration toolbar
  // - canonicalCategoriesEnabled → batch Reclassify (canonical-only
  //   workspaces like Project Accounting get Reclassify without FS tools)
  // Fallback to the historical IT-only check while loading / if the config
  // call fails.
  const [categoryFlags, setCategoryFlags] = useState(null);
  useEffect(() => {
    setCategoryFlags(null);
    assignmentAPI.getConfig()
      .then((res) => setCategoryFlags({
        fsSync: res?.skillHierarchyEnabled === true,
        // Older backends don't send canonicalCategoriesEnabled — fall back to
        // the pre-split behavior (both tool groups ride the same flag).
        canonical: res?.canonicalCategoriesEnabled === undefined
          ? res?.skillHierarchyEnabled === true
          : res?.canonicalCategoriesEnabled === true,
      }))
      .catch(() => setCategoryFlags(null));
  }, [currentWorkspace?.id]);
  const legacyItFallback = Number(currentWorkspace?.id) === 1 || currentWorkspace?.slug === 'it';
  const useHierarchyEditor = categoryFlags?.fsSync ?? legacyItFallback;
  const useReclassifyTools = categoryFlags?.canonical ?? legacyItFallback;

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
            <button key={tab.id} onClick={() => { setActiveTab(tab.id); if (deepRunId) navigate('/assignments/competencies'); }} className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${effectiveTab === tab.id ? 'border-purple-600 text-purple-600 dark:text-purple-300' : 'border-transparent text-muted-foreground hover:text-foreground/85'}`}>
              <Icon className="w-4 h-4" /> {tab.label}
              {tab.id === 'suggestions' && suggestionCount > 0 && (
                <span className={`ml-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                  effectiveTab === tab.id ? 'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-200' : 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200'
                }`}>
                  {suggestionCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {effectiveTab === 'matrix' && <MatrixTab onAnalyze={(id) => handleAnalyze(id)} />}
      {effectiveTab === 'categories' && <CategoriesManagementTab showMigrationControls={useHierarchyEditor} showReclassifyControls={useReclassifyTools} />}
      {effectiveTab === 'suggestions' && <CategorySuggestionsTab onCountChange={setSuggestionCount} />}
      {effectiveTab === 'history' && <RunHistoryTab deepRunId={deepRunId} workspaceTimezone={workspaceTimezone} />}
      {effectiveTab === 'prompt' && <CompetencyPromptTab />}
    </div>
  );
}
