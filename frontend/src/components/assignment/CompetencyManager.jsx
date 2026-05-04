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
} from 'lucide-react';
import {
  CopyBadge, ToolCallCard, StreamContent,
  cleanTranscript, processStreamEvent,
} from './StreamingComponents';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';

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
        <span className="truncate">{selected ? selected.name : 'Top-level category'}</span>
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
              placeholder="Filter parent categories..."
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
              <span>Top-level category</span>
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
              <div className="px-2.5 py-4 text-center text-xs text-slate-400">No matching categories</div>
            )}
          </div>
        </div>
      )}
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
    if (!confirm('Delete this category and all its mappings?')) return;
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

      <DuplicateDetector onMerged={fetchData} />

      {/* Swapped-axis matrix: categories as rows, technicians as columns */}
      {technicians.length > 0 && (
        <div className="overflow-x-auto border rounded-lg">
          <table className="text-sm border-collapse">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left px-3 py-3 font-medium text-slate-600 sticky left-0 bg-slate-50 z-10 min-w-[180px]">Competency</th>
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
                    No competency categories yet. Add categories below to start mapping skills, or run LLM analysis on a technician to auto-generate them.
                  </td>
                </tr>
              )}
              {displayCategories.map((cat) => (
                <tr key={cat.id} className={`border-t hover:bg-slate-50 ${cat.depth === 0 ? 'bg-slate-50/70' : ''}`}>
                  <td className={`px-3 py-2 sticky left-0 z-10 text-xs text-slate-700 ${cat.depth === 0 ? 'bg-slate-50 font-semibold' : 'bg-white font-medium'}`} title={cat.description || ''}>
                    <div className="flex items-center gap-2">
                      {cat.depth === 1 && <span className="ml-3 h-px w-4 bg-slate-300" />}
                      <span>{cat.name}</span>
                      {cat.depth === 1 && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">sub</span>}
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
          <span>Manage Categories ({categories.length})</span>
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
            <input type="text" value={newCatName} onChange={(e) => setNewCatName(e.target.value)} placeholder="Category name" className="flex-1 border rounded-lg px-3 py-1.5 text-xs" />
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
          if (latestRun && (latestRun.status === 'running' || (latestRun.status === 'completed' && latestRun.decision === 'auto_applied'))) {
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
  }, [techId, scrollToBottom]);

  const STATUS_MAP = {
    checking: { icon: Loader2, text: 'Checking for existing analysis...', color: 'text-gray-500', spin: true },
    connecting: { icon: Loader2, text: 'Starting analysis...', color: 'text-gray-500', spin: true },
    running: { icon: Brain, text: `Analyzing competencies... (${elapsedSec}s)`, color: 'text-purple-600', spin: true },
    completed: { icon: CheckCircle, text: 'Analysis complete — auto-applied', color: 'text-green-600', spin: false },
    error: { icon: XCircle, text: 'Analysis failed', color: 'text-red-600', spin: false },
  };
  const statusInfo = STATUS_MAP[status] || STATUS_MAP.connecting;
  const StatusIcon = statusInfo.icon;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <StatusIcon className={`w-5 h-5 ${statusInfo.color} ${statusInfo.spin ? 'animate-spin' : ''}`} />
          <span className={`text-sm font-medium ${statusInfo.color}`}>{statusInfo.text}</span>
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
          <h4 className="text-sm font-semibold text-gray-700">Assessment Result (Auto-Applied)</h4>
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
    const DECISION_COLORS = { auto_applied: 'bg-green-100 text-green-800', rolled_back: 'bg-red-100 text-red-800' };
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
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${run.decision === 'auto_applied' ? 'bg-green-100 text-green-800' : run.decision === 'rolled_back' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600'}`}>
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
  { id: 'history', label: 'Run History', icon: Clock },
  { id: 'prompt', label: 'Prompt', icon: FileText },
];

export default function CompetencyManager({ deepRunId, deepAnalyzeTechId, workspaceTimezone = 'America/Los_Angeles' }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState('matrix');

  const isLiveAnalysis = !!deepAnalyzeTechId;
  const forceNew = searchParams.get('force') === 'true';

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
            </button>
          );
        })}
      </div>

      {effectiveTab === 'matrix' && <MatrixTab onAnalyze={(id) => handleAnalyze(id)} />}
      {effectiveTab === 'history' && <RunHistoryTab deepRunId={deepRunId} workspaceTimezone={workspaceTimezone} />}
      {effectiveTab === 'prompt' && <CompetencyPromptTab />}
    </div>
  );
}
