import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Icons from 'lucide-react';
import * as XLSX from 'xlsx';
import AppShell from '../components/AppShell';
import { summitAPI } from '../services/api';
import { useWorkspace } from '../contexts/WorkspaceContext';

const ICONS = [
  'KeyRound', 'ShieldAlert', 'MonitorCog', 'AppWindow', 'Share2', 'Network', 'CloudCog',
  'ShoppingCart', 'UsersRound', 'Smartphone', 'ArchiveX', 'Laptop', 'Mail', 'FolderKey',
  'Printer', 'Wifi', 'Server', 'Sparkles', 'Workflow', 'ClipboardList', 'BadgeDollarSign',
  'Rocket', 'DatabaseBackup', 'Lock', 'Projector', 'Map', 'PhoneCall', 'Boxes',
];

const COLORS = ['#0f4c81', '#b42318', '#2563eb', '#7c3aed', '#0891b2', '#0f766e', '#4f46e5', '#c2410c', '#334155', '#16a34a', '#64748b'];

function Icon({ name, className = 'h-4 w-4' }) {
  const LucideIcon = Icons[name] || Icons.Tags;
  return <LucideIcon className={className} />;
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function makeId(prefix, label) {
  return `${prefix}_${String(label || 'item').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)}_${Date.now().toString(36)}`;
}

function flattenRows(state) {
  const rows = [];
  (state?.categories || []).filter(c => !c.deleted).forEach((cat, index) => {
    rows.push({
      Level: 'Top Category',
      Parent: '',
      Name: cat.name,
      Description: cat.description || '',
      Icon: cat.icon || '',
      Color: cat.color || '',
      Status: cat.status || 'draft',
      Order: index + 1,
      Evidence: cat.evidence || '',
      Notes: cat.notes || '',
    });
    (cat.subcategories || []).filter(s => !s.deleted).forEach((subcat, subIndex) => {
      rows.push({
        Level: 'Subcategory',
        Parent: cat.name,
        Name: subcat.name,
        Description: subcat.description || '',
        Icon: subcat.icon || '',
        Color: cat.color || '',
        Status: subcat.status || 'draft',
        Order: `${index + 1}.${subIndex + 1}`,
        Evidence: subcat.evidence || '',
        Notes: '',
      });
    });
  });
  return rows;
}

function voteCount(votes, itemId, voteType = 'support') {
  return votes?.totals?.find(v => v.itemId === itemId && v.voteType === voteType)?.count || 0;
}

function Stat({ label, value, icon }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
      <div className="flex items-center gap-2 text-slate-500 text-xs">
        <Icon name={icon} className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}

export default function SummitTaxonomyWorkshop() {
  const navigate = useNavigate();
  const { currentWorkspace } = useWorkspace();
  const [state, setState] = useState(null);
  const [session, setSession] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [votes, setVotes] = useState({ participantCount: 0, totals: [], mergeSuggestions: [] });
  const [selectedCategoryId, setSelectedCategoryId] = useState(null);
  const [selectedForMerge, setSelectedForMerge] = useState([]);
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const [dragItem, setDragItem] = useState(null);
  const [saveStatus, setSaveStatus] = useState('Loading...');
  const [error, setError] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [showVotes, setShowVotes] = useState(true);
  const [showRegenerateLinkConfirm, setShowRegenerateLinkConfirm] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const hydratedRef = useRef(false);
  const saveTimerRef = useRef(null);

  const isItWorkspace = Number(currentWorkspace?.id) === 1 || currentWorkspace?.slug === 'it';
  const activeCategories = useMemo(() => (state?.categories || []).filter(c => !c.deleted), [state]);
  const deletedItems = useMemo(() => [
    ...(state?.deletedItems || []),
    ...(state?.categories || []).filter(c => c.deleted).map(c => ({ ...c, type: 'category' })),
  ], [state]);
  const selectedCategory = activeCategories.find(c => c.id === selectedCategoryId) || activeCategories[0] || null;

  useEffect(() => {
    let cancelled = false;
    summitAPI.getWorkshop()
      .then((res) => {
        if (cancelled) return;
        setSession(res.session);
        setState(res.session.state);
        setSnapshots(res.snapshots || []);
        setVotes(res.votes || { participantCount: 0, totals: [], mergeSuggestions: [] });
        setSelectedCategoryId(res.session.state?.categories?.find(c => !c.deleted)?.id || null);
        setSaveStatus('Saved');
        setLastSavedAt(res.session.updatedAt);
        hydratedRef.current = true;
      })
      .catch((err) => setError(err.message || 'Failed to load workshop'));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!session?.voteToken) return undefined;
    let source;
    try {
      source = summitAPI.getPublicEventSource(session.voteToken);
      source.addEventListener('votes', (event) => setVotes(JSON.parse(event.data)));
      source.addEventListener('state', (event) => {
        const next = JSON.parse(event.data);
        setSession(prev => prev ? { ...prev, voteEnabled: next.voteEnabled, voteExpiresAt: next.voteExpiresAt } : prev);
      });
    } catch {
      return undefined;
    }
    return () => source?.close();
  }, [session?.voteToken]);

  useEffect(() => {
    if (!hydratedRef.current || !state) return undefined;
    setSaveStatus('Autosaving...');
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      summitAPI.saveState(state, { label: 'Autosave', snapshotType: 'autosave' })
        .then((res) => {
          setSession(res.session);
          setSnapshots(res.snapshots || []);
          setVotes(res.votes || votes);
          setSaveStatus('Saved');
          setLastSavedAt(res.session.updatedAt);
        })
        .catch((err) => setSaveStatus(err.message || 'Autosave failed'));
    }, 1800);
    return () => window.clearTimeout(saveTimerRef.current);
  }, [state]);

  const commit = (updater) => {
    setState((current) => {
      if (!current) return current;
      const before = cloneState(current);
      const next = typeof updater === 'function' ? updater(cloneState(current)) : updater;
      setHistory(prev => [...prev.slice(-29), before]);
      setFuture([]);
      return { ...next, lastEditedAt: new Date().toISOString() };
    });
  };

  const manualSave = async () => {
    if (!state) return;
    setSaveStatus('Saving...');
    const res = await summitAPI.saveState(state, { label: 'Manual summit save', snapshotType: 'manual' });
    setSession(res.session);
    setSnapshots(res.snapshots || []);
    setVotes(res.votes || votes);
    setSaveStatus('Saved');
    setLastSavedAt(res.session.updatedAt);
  };

  const undo = () => {
    setHistory(prev => {
      if (!prev.length) return prev;
      const previous = prev[prev.length - 1];
      setFuture(f => state ? [cloneState(state), ...f.slice(0, 29)] : f);
      setState(previous);
      return prev.slice(0, -1);
    });
  };

  const redo = () => {
    setFuture(prev => {
      if (!prev.length) return prev;
      const next = prev[0];
      setHistory(h => state ? [...h.slice(-29), cloneState(state)] : h);
      setState(next);
      return prev.slice(1);
    });
  };

  const updateCategory = (categoryId, patch) => commit((draft) => {
    draft.categories = draft.categories.map(c => c.id === categoryId ? { ...c, ...patch } : c);
    return draft;
  });

  const updateSubcategory = (categoryId, subId, patch) => commit((draft) => {
    draft.categories = draft.categories.map(c => {
      if (c.id !== categoryId) return c;
      return { ...c, subcategories: c.subcategories.map(s => s.id === subId ? { ...s, ...patch } : s) };
    });
    return draft;
  });

  const addCategory = () => {
    const name = 'New Top Category';
    const newCategory = {
      id: makeId('cat', name),
      name,
      icon: 'FolderPlus',
      color: COLORS[(activeCategories.length + 1) % COLORS.length],
      description: '',
      status: 'draft',
      notes: '',
      deleted: false,
      collapsed: false,
      subcategories: [],
    };
    commit((draft) => ({ ...draft, categories: [...draft.categories, newCategory] }));
    setSelectedCategoryId(newCategory.id);
  };

  const addSubcategory = (categoryId) => {
    const name = 'New Subcategory';
    commit((draft) => {
      draft.categories = draft.categories.map(c => c.id === categoryId
        ? { ...c, subcategories: [...(c.subcategories || []), { id: makeId('sub', name), name, icon: 'Tag', status: 'draft', deleted: false }] }
        : c);
      return draft;
    });
  };

  const softDeleteCategory = (categoryId) => commit((draft) => {
    draft.categories = draft.categories.map(c => c.id === categoryId ? { ...c, deleted: true, deletedAt: new Date().toISOString() } : c);
    const next = draft.categories.find(c => !c.deleted && c.id !== categoryId);
    setSelectedCategoryId(next?.id || null);
    return draft;
  });

  const softDeleteSubcategory = (categoryId, subId) => commit((draft) => {
    draft.categories = draft.categories.map(c => {
      if (c.id !== categoryId) return c;
      const target = c.subcategories.find(s => s.id === subId);
      draft.deletedItems = [...(draft.deletedItems || []), { ...target, parentId: categoryId, parentName: c.name, type: 'subcategory', deletedAt: new Date().toISOString() }];
      return { ...c, subcategories: c.subcategories.filter(s => s.id !== subId) };
    });
    return draft;
  });

  const restoreDeleted = (item) => commit((draft) => {
    if (item.type === 'category') {
      draft.categories = draft.categories.map(c => c.id === item.id ? { ...c, deleted: false } : c);
      setSelectedCategoryId(item.id);
    } else {
      draft.categories = draft.categories.map(c => c.id === item.parentId
        ? { ...c, subcategories: [...(c.subcategories || []), { ...item, deleted: false }] }
        : c);
      draft.deletedItems = (draft.deletedItems || []).filter(d => d.id !== item.id);
    }
    return draft;
  });

  const moveCategory = (fromId, toId) => commit((draft) => {
    const list = draft.categories;
    const from = list.findIndex(c => c.id === fromId);
    const to = list.findIndex(c => c.id === toId);
    if (from < 0 || to < 0 || from === to) return draft;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    return draft;
  });

  const moveSubcategory = (fromCategoryId, subId, toCategoryId) => commit((draft) => {
    let moving = null;
    draft.categories = draft.categories.map(c => {
      if (c.id !== fromCategoryId) return c;
      moving = c.subcategories.find(s => s.id === subId);
      return { ...c, subcategories: c.subcategories.filter(s => s.id !== subId) };
    });
    if (!moving) return draft;
    draft.categories = draft.categories.map(c => c.id === toCategoryId ? { ...c, subcategories: [...c.subcategories, moving] } : c);
    return draft;
  });

  const mergeSelectedCategories = () => {
    if (selectedForMerge.length < 2) return;
    const selected = activeCategories.filter(c => selectedForMerge.includes(c.id));
    const keeper = selected[0];
    commit((draft) => {
      const keep = draft.categories.find(c => c.id === keeper.id);
      selected.slice(1).forEach((cat) => {
        keep.subcategories.push({ id: makeId('sub', cat.name), name: cat.name, icon: cat.icon, status: 'merged', evidence: `Merged from top-level category ${cat.name}`, deleted: false });
        keep.subcategories.push(...(cat.subcategories || []).map(s => ({ ...s, id: s.id || makeId('sub', s.name) })));
      });
      draft.categories = draft.categories.map(c => selectedForMerge.includes(c.id) && c.id !== keep.id ? { ...c, deleted: true, deletedAt: new Date().toISOString(), mergedInto: keep.id } : c);
      return draft;
    });
    setSelectedForMerge([]);
    setSelectedCategoryId(keeper.id);
  };

  const enableVoting = async (regenerate = false) => {
    const res = await summitAPI.enableVoting(120, regenerate);
    setSession(res.session);
    setSnapshots(res.snapshots || []);
    setVotes(res.votes || votes);
    setShowRegenerateLinkConfirm(false);
  };

  const voteUrl = session?.voteToken ? `${window.location.origin}/summit/vote/${session.voteToken}` : '';

  const exportExcel = () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(flattenRows(state)), 'Taxonomy');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(votes.totals || []), 'Votes');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(votes.mergeSuggestions || []), 'Merge Suggestions');
    XLSX.writeFile(workbook, 'BGC-IT-Summit-Taxonomy.xlsx');
  };

  const importJson = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.categories)) throw new Error('Backup JSON must include categories');
    commit(parsed);
    event.target.value = '';
  };

  if (!isItWorkspace) {
    return (
      <AppShell activePage="dashboard">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-900">
          This workshop is currently visible only in the IT workspace.
        </div>
      </AppShell>
    );
  }

  if (error) {
    return <AppShell activePage="dashboard"><div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-800">{error}</div></AppShell>;
  }

  if (!state) {
    return (
      <AppShell activePage="dashboard">
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="rounded-lg border border-slate-200 bg-white px-6 py-5 shadow-sm">
            <Icons.Loader2 className="mx-auto h-8 w-8 animate-spin text-blue-700" />
            <p className="mt-3 text-sm text-slate-600">Loading summit workshop...</p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell activePage="dashboard" contentClassName="max-w-[1500px] mx-auto w-full px-2 sm:px-4 py-4">
      <div className="mb-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-4 border-b border-slate-200 bg-slate-950 px-5 py-4 text-white lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-cyan-200">
              <Icons.Sparkles className="h-4 w-4" />
              BGC Engineering IT Summit
            </div>
            <h1 className="mt-2 text-2xl font-semibold">Taxonomy Workshop</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-300">Move categories, rename items, combine top-level groups, restore deleted ideas, and collect live votes from the room.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => navigate('/dashboard')} className="rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10">Dashboard</button>
            <button onClick={undo} disabled={!history.length} className="rounded-lg border border-white/20 px-3 py-2 text-sm disabled:opacity-40 hover:bg-white/10"><Icons.Undo2 className="mr-1 inline h-4 w-4" />Undo</button>
            <button onClick={redo} disabled={!future.length} className="rounded-lg border border-white/20 px-3 py-2 text-sm disabled:opacity-40 hover:bg-white/10"><Icons.Redo2 className="mr-1 inline h-4 w-4" />Redo</button>
            <button onClick={manualSave} className="rounded-lg bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300"><Icons.Save className="mr-1 inline h-4 w-4" />Save</button>
            <button onClick={exportExcel} className="rounded-lg bg-white px-3 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-100"><Icons.FileSpreadsheet className="mr-1 inline h-4 w-4" />Excel</button>
          </div>
        </div>

        <div className="grid gap-3 px-5 py-4 md:grid-cols-5">
          <Stat label="Top Categories" value={activeCategories.length} icon="Folders" />
          <Stat label="Subcategories" value={activeCategories.reduce((sum, c) => sum + (c.subcategories || []).filter(s => !s.deleted).length, 0)} icon="Tags" />
          <Stat label="Participants" value={votes.participantCount || 0} icon="UsersRound" />
          <Stat label="Votes" value={(votes.totals || []).reduce((sum, v) => sum + v.count, 0)} icon="ThumbsUp" />
          <Stat label="State" value={saveStatus} icon="DatabaseZap" />
        </div>

        <div className="flex flex-col gap-3 border-t border-slate-200 px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
            <button onClick={addCategory} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50"><Icons.FolderPlus className="mr-1 inline h-4 w-4" />Add top category</button>
            <button onClick={() => setShowDeleted(!showDeleted)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50"><Icons.ArchiveRestore className="mr-1 inline h-4 w-4" />Removed items</button>
            <button onClick={mergeSelectedCategories} disabled={selectedForMerge.length < 2} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-40 hover:bg-slate-50"><Icons.Merge className="mr-1 inline h-4 w-4" />Combine selected</button>
            <label className="cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50">
              <Icons.Upload className="mr-1 inline h-4 w-4" />Restore JSON
              <input type="file" accept="application/json" onChange={importJson} className="hidden" />
            </label>
            <button onClick={() => navigator.clipboard.writeText(JSON.stringify(state, null, 2))} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50"><Icons.Copy className="mr-1 inline h-4 w-4" />Copy JSON</button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {voteUrl ? (
              <>
                <span className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800">Voting open until {new Date(session.voteExpiresAt).toLocaleTimeString()}</span>
                <button onClick={() => navigator.clipboard.writeText(voteUrl)} className="rounded-lg bg-emerald-600 px-3 py-2 font-semibold text-white hover:bg-emerald-500"><Icons.Link className="mr-1 inline h-4 w-4" />Copy voting link</button>
                <button onClick={() => setShowRegenerateLinkConfirm(true)} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 font-semibold text-amber-800 hover:bg-amber-100"><Icons.RefreshCcw className="mr-1 inline h-4 w-4" />Regenerate</button>
              </>
            ) : (
              <button onClick={() => enableVoting(false)} className="rounded-lg bg-emerald-600 px-3 py-2 font-semibold text-white hover:bg-emerald-500"><Icons.Radio className="mr-1 inline h-4 w-4" />Open 2-hour voting link</button>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)_320px]">
        <aside className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Top Categories</h2>
            <span className="text-xs text-slate-500">Drag to reorder</span>
          </div>
          <div className="space-y-2">
            {activeCategories.map((cat) => (
              <button
                key={cat.id}
                draggable
                onDragStart={() => setDragItem({ type: 'category', id: cat.id })}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragItem?.type === 'category') moveCategory(dragItem.id, cat.id);
                  if (dragItem?.type === 'sub') moveSubcategory(dragItem.categoryId, dragItem.id, cat.id);
                  setDragItem(null);
                }}
                onClick={() => setSelectedCategoryId(cat.id)}
                className={`w-full rounded-lg border p-3 text-left transition-all ${selectedCategory?.id === cat.id ? 'border-slate-900 bg-slate-50 shadow-sm' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'}`}
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg text-white" style={{ backgroundColor: cat.color }}>
                    <Icon name={cat.icon} className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-900">{cat.name}</span>
                    <span className="text-xs text-slate-500">{(cat.subcategories || []).filter(s => !s.deleted).length} subcategories / {voteCount(votes, cat.id)} votes</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={selectedForMerge.includes(cat.id)}
                    onChange={(e) => {
                      e.stopPropagation();
                      setSelectedForMerge(prev => e.target.checked ? [...prev, cat.id] : prev.filter(id => id !== cat.id));
                    }}
                    onClick={(e) => e.stopPropagation()}
                    title="Select for combine"
                  />
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          {selectedCategory && (
            <>
              <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 md:flex-row md:items-start md:justify-between">
                <div className="flex min-w-0 flex-1 gap-3">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-white shadow-sm" style={{ backgroundColor: selectedCategory.color }}>
                    <Icon name={selectedCategory.icon} className="h-6 w-6" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <input
                      value={selectedCategory.name}
                      onChange={(e) => updateCategory(selectedCategory.id, { name: e.target.value })}
                      className="w-full rounded border border-transparent px-1 text-xl font-semibold text-slate-950 outline-none focus:border-slate-300"
                    />
                    <textarea
                      value={selectedCategory.description || ''}
                      onChange={(e) => updateCategory(selectedCategory.id, { description: e.target.value })}
                      rows={2}
                      className="mt-1 w-full resize-none rounded border border-slate-200 px-2 py-1 text-sm text-slate-600 outline-none focus:border-slate-400"
                      placeholder="Describe the category boundary"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <select value={selectedCategory.icon} onChange={(e) => updateCategory(selectedCategory.id, { icon: e.target.value })} className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
                    {ICONS.map(i => <option key={i} value={i}>{i}</option>)}
                  </select>
                  <input type="color" value={selectedCategory.color} onChange={(e) => updateCategory(selectedCategory.id, { color: e.target.value })} className="h-10 w-12 rounded border border-slate-300" title="Category color" />
                  <button onClick={() => addSubcategory(selectedCategory.id)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"><Icons.Tag className="mr-1 inline h-4 w-4" />Add sub</button>
                  <button onClick={() => softDeleteCategory(selectedCategory.id)} className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700 hover:bg-red-50"><Icons.Trash2 className="mr-1 inline h-4 w-4" />Remove</button>
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {(selectedCategory.subcategories || []).filter(s => !s.deleted).map((subcat) => (
                  <div
                    key={subcat.id}
                    draggable
                    onDragStart={() => setDragItem({ type: 'sub', categoryId: selectedCategory.id, id: subcat.id })}
                    className="group rounded-lg border border-slate-200 bg-slate-50 p-3 transition hover:border-slate-300 hover:bg-white hover:shadow-sm"
                  >
                    <div className="flex items-start gap-2">
                      <span className="mt-1 text-slate-500"><Icon name={subcat.icon || 'Tag'} /></span>
                      <div className="min-w-0 flex-1">
                        <input value={subcat.name} onChange={(e) => updateSubcategory(selectedCategory.id, subcat.id, { name: e.target.value })} className="w-full rounded border border-transparent bg-transparent text-sm font-semibold text-slate-900 outline-none focus:border-slate-300 focus:bg-white" />
                        <input value={subcat.evidence || ''} onChange={(e) => updateSubcategory(selectedCategory.id, subcat.id, { evidence: e.target.value })} className="mt-1 w-full rounded border border-transparent bg-transparent text-xs text-slate-500 outline-none focus:border-slate-300 focus:bg-white" placeholder="Evidence or discussion note" />
                      </div>
                      <select value={subcat.icon || 'Tag'} onChange={(e) => updateSubcategory(selectedCategory.id, subcat.id, { icon: e.target.value })} className="hidden rounded border border-slate-200 bg-white px-1 py-1 text-xs group-hover:block">
                        {ICONS.map(i => <option key={i} value={i}>{i}</option>)}
                      </select>
                      <button onClick={() => softDeleteSubcategory(selectedCategory.id, subcat.id)} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Remove"><Icons.X className="h-4 w-4" /></button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        <aside className="space-y-4">
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Live Feedback</h2>
              <button onClick={() => setShowVotes(!showVotes)} className="text-xs text-slate-500 hover:text-slate-900">{showVotes ? 'Hide' : 'Show'}</button>
            </div>
            {showVotes && (
              <div className="space-y-3">
                {(votes.totals || []).slice(0, 8).map(v => (
                  <div key={`${v.itemId}-${v.voteType}`}>
                    <div className="flex justify-between text-xs">
                      <span className="truncate font-medium text-slate-700">{v.itemLabel}</span>
                      <span className="text-slate-500">{v.count}</span>
                    </div>
                    <div className="mt-1 h-2 rounded bg-slate-100">
                      <div className="h-2 rounded bg-cyan-500 transition-all" style={{ width: `${Math.min(100, v.count * 12)}%` }} />
                    </div>
                  </div>
                ))}
                {!(votes.totals || []).length && <p className="text-sm text-slate-500">Votes will appear here once participants join.</p>}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Merge Suggestions</h2>
            <div className="max-h-64 space-y-2 overflow-auto">
              {(votes.mergeSuggestions || []).map(s => (
                <div key={s.id} className="rounded-lg bg-slate-50 p-2 text-xs">
                  <div className="font-semibold text-slate-800">{s.participantName}</div>
                  <div className="mt-1 text-slate-600">{s.value?.from} + {s.value?.to}</div>
                  {s.value?.reason && <div className="mt-1 text-slate-500">{s.value.reason}</div>}
                </div>
              ))}
              {!(votes.mergeSuggestions || []).length && <p className="text-sm text-slate-500">No merge suggestions yet.</p>}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Backups</h2>
            <div className="max-h-64 space-y-2 overflow-auto">
              {snapshots.map(snapshot => (
                <div key={snapshot.id} className="rounded-lg border border-slate-200 p-2">
                  <div className="text-xs font-semibold text-slate-800">v{snapshot.version} / {snapshot.label}</div>
                  <div className="text-[11px] text-slate-500">{new Date(snapshot.createdAt).toLocaleString()}</div>
                  <button onClick={() => summitAPI.restoreSnapshot(snapshot.id).then(res => { setSession(res.session); setState(res.session.state); setSnapshots(res.snapshots || []); })} className="mt-2 text-xs font-semibold text-blue-700 hover:text-blue-900">Restore</button>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      {showDeleted && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-lg bg-white p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Removed Items</h2>
              <button onClick={() => setShowDeleted(false)}><Icons.X className="h-5 w-5" /></button>
            </div>
            <div className="space-y-2">
              {deletedItems.map(item => (
                <div key={`${item.type}-${item.id}`} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                  <div>
                    <div className="font-medium text-slate-900">{item.name}</div>
                    <div className="text-xs text-slate-500">{item.type}{item.parentName ? ` from ${item.parentName}` : ''}</div>
                  </div>
                  <button onClick={() => restoreDeleted(item)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white">Restore</button>
                </div>
              ))}
              {!deletedItems.length && <p className="text-sm text-slate-500">Nothing removed yet.</p>}
            </div>
          </div>
        </div>
      )}

      {showRegenerateLinkConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-lg overflow-hidden rounded-lg bg-white shadow-2xl">
            <div className="border-b border-amber-200 bg-amber-50 px-5 py-4">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500 text-white">
                  <Icons.RefreshCcw className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">Regenerate voting link?</h2>
                  <p className="text-sm text-amber-800">The current public voting URL will stop working.</p>
                </div>
              </div>
            </div>
            <div className="px-5 py-4 text-sm text-slate-600">
              Participants already on the old link will see that the link expired and will need the new link. Existing saved votes and suggestions stay in this workshop.
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <button onClick={() => setShowRegenerateLinkConfirm(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={() => enableVoting(true)} className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600">
                Regenerate link
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mt-3 text-xs text-slate-500">Last saved: {lastSavedAt ? new Date(lastSavedAt).toLocaleString() : 'not yet saved'}</div>
    </AppShell>
  );
}
