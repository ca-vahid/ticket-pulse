import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Drawer } from 'vaul';
import { DayPicker } from 'react-day-picker';
import {
  endOfMonth, endOfWeek, format, startOfMonth, startOfWeek, subDays, subMonths, subWeeks,
} from 'date-fns';
import {
  CalendarClock, CalendarDays, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight,
  GripVertical, LayoutList, ListFilter, Plus, Search, Sparkles, Star, Trash2, Users, VolumeX, X,
} from 'lucide-react';
import { PersonAvatar, PRIORITY_LABELS, PRIORITY_STRIP_COLORS, TagChip } from './ticketUi';
import { ticketsAPI } from '../../services/api';
import 'react-day-picker/style.css';

const csvList = (s) => (s ? String(s).split(',').filter(Boolean) : []);
const day = (d) => format(d, 'yyyy-MM-dd');

const CREATED_PRESETS = [
  { key: 'today', label: 'Today', range: (now) => [now, now] },
  { key: 'week', label: 'This week', range: (now) => [startOfWeek(now, { weekStartsOn: 1 }), now] },
  { key: 'last-week', label: 'Last week', range: (now) => [startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 }), endOfWeek(subWeeks(now, 1), { weekStartsOn: 1 })] },
  { key: 'month', label: 'This month', range: (now) => [startOfMonth(now), now] },
  { key: 'last-month', label: 'Last month', range: (now) => [startOfMonth(subMonths(now, 1)), endOfMonth(subMonths(now, 1))] },
  { key: '7d', label: 'Last 7 days', range: (now) => [subDays(now, 7), now] },
  { key: '30d', label: 'Last 30 days', range: (now) => [subDays(now, 30), now] },
];

const DUE_OPTIONS = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'week', label: 'Due in 7 days' },
  { value: 'none', label: 'No due date' },
];

const STATUS_OPTIONS = ['Open', 'Pending', 'Resolved', 'Closed'];
const TYPE_OPTIONS = ['Incident', 'Service Request'];

/** One collapsible facet group in the rail. */
function Section({ title, icon: Icon, activeCount = 0, onClear, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen || activeCount > 0);
  // A filter applied from elsewhere (URL, views) pops its section open.
  useEffect(() => { if (activeCount > 0) setOpen(true); }, [activeCount]);
  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <div className="flex items-center gap-1 w-full px-3 py-2 group">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="tp-focus-ring flex items-center gap-1.5 flex-1 min-w-0 text-left rounded"
        >
          {open
            ? <ChevronDown className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" aria-hidden="true" />
            : <ChevronRight className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" aria-hidden="true" />}
          {Icon && <Icon className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" aria-hidden="true" />}
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 truncate">{title}</span>
          {activeCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-blue-600 text-white text-[10px] font-bold">
              {activeCount}
            </span>
          )}
        </button>
        {activeCount > 0 && onClear && (
          <button
            onClick={onClear}
            aria-label={`Clear ${title} filter`}
            className="tp-focus-ring p-0.5 rounded text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 focus:opacity-100"
          >
            <X className="w-3 h-3" aria-hidden="true" />
          </button>
        )}
      </div>
      {open && <div className="px-3 pb-2.5">{children}</div>}
    </div>
  );
}

/** Checkbox facet row: label + optional adornment + optional count. */
function Facet({ checked, onToggle, children, count }) {
  return (
    <label className="flex items-center gap-2 px-1.5 py-[5px] rounded-md hover:bg-blue-50/70 cursor-pointer text-[13px] text-slate-600 min-w-0">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="tp-focus-ring rounded border-slate-300 text-blue-600 flex-shrink-0"
      />
      <span className="flex items-center gap-1.5 min-w-0 flex-1 truncate">{children}</span>
      {count != null && <span className="text-[10px] text-slate-300 tabular-nums flex-shrink-0">{count}</span>}
    </label>
  );
}

/**
 * Wraps a facet section to make it drag-reorderable (native HTML5 DnD). Only the
 * grip handle initiates the drag (so checkboxes/inputs stay clickable); the whole
 * block is a drop target. Reordering persists per-user (localStorage).
 */
function SortableFacet({ id, order, dragKey, setDragKey, onDropOn, children }) {
  const dragging = dragKey === id;
  return (
    <div
      style={{ order }}
      onDragOver={(e) => { if (dragKey && dragKey !== id) e.preventDefault(); }}
      onDrop={(e) => { e.preventDefault(); if (dragKey && dragKey !== id) onDropOn(id); }}
      className={`relative group/facet transition-opacity ${dragging ? 'opacity-40' : dragKey ? 'hover:bg-blue-50/40' : ''}`}
    >
      <span
        draggable
        onDragStart={(e) => { setDragKey(id); e.dataTransfer.effectAllowed = 'move'; }}
        onDragEnd={() => setDragKey(null)}
        title="Drag to reorder"
        aria-label={`Reorder ${id} section`}
        className="absolute left-0 top-2 z-10 cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 opacity-0 group-hover/facet:opacity-100"
      >
        <GripVertical className="w-3.5 h-3.5" aria-hidden="true" />
      </span>
      {children}
    </div>
  );
}

/**
 * Docked faceted filter rail (Linear/Datadog-table style): always visible on
 * desktop, collapsible to a slim bar, every facet URL-persisted. On mobile it
 * becomes a slide-over drawer behind the Filters button.
 */
export default function TicketFilterRail({ meta, stats = null, mobileOpen = false, onMobileClose, sheet = false }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('tp_filter_rail') === 'collapsed'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('tp_filter_rail', collapsed ? 'collapsed' : 'open'); } catch { /* no-op */ }
  }, [collapsed]);

  // Saved filter views (per-user + workspace-shared). Admins can share.
  const canShare = meta?.actor?.role === 'admin' || meta?.actor?.workspaceRole === 'admin';
  const [savedViews, setSavedViews] = useState([]);
  const [savingView, setSavingView] = useState(false); // shows the name input
  const [newViewName, setNewViewName] = useState('');
  const [confirmDeleteView, setConfirmDeleteView] = useState(null); // view id armed for delete
  const wsId = meta?.workspaceId;
  const loadSavedViews = async () => {
    try { const res = await ticketsAPI.listSavedViews(); setSavedViews(res.data || []); } catch { /* rail just hides them */ }
  };
  useEffect(() => { loadSavedViews(); }, [wsId]);

  // Personal, persisted facet-section order — drag to rearrange (e.g. Status
  // above Technician). New sections append so the list survives app updates.
  const FACET_KEYS = ['status', 'technician', 'priority', 'type', 'category', 'tag', 'impact', 'group', 'source', 'created', 'due', 'origin'];
  const [sectionOrder, setSectionOrder] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('tp_filter_section_order') || 'null');
      if (Array.isArray(saved)) {
        const merged = saved.filter((k) => FACET_KEYS.includes(k));
        for (const k of FACET_KEYS) if (!merged.includes(k)) merged.push(k);
        return merged;
      }
    } catch { /* ignore */ }
    return FACET_KEYS;
  });
  const [dragKey, setDragKey] = useState(null);
  useEffect(() => { try { localStorage.setItem('tp_filter_section_order', JSON.stringify(sectionOrder)); } catch { /* no-op */ } }, [sectionOrder]);
  const moveSection = (targetKey) => setSectionOrder((prev) => {
    if (!dragKey || dragKey === targetKey) return prev;
    const a = prev.filter((k) => k !== dragKey);
    const idx = a.indexOf(targetKey);
    a.splice(idx, 0, dragKey);
    return a;
  });
  // Props for wrapping a facet section so it reorders via CSS `order` (+1 keeps
  // Views, which has no order, pinned at the top).
  const facetProps = (id) => ({ id, order: sectionOrder.indexOf(id) + 1, dragKey, setDragKey, onDropOn: moveSection });

  const get = (k) => searchParams.get(k) || '';
  const setParams = (patch, { resetPage = true } = {}) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === '' || v === 'all') next.delete(k);
        else next.set(k, String(v));
      }
      if (resetPage) next.delete('page');
      return next;
    }, { replace: true });
  };
  const toggleCsv = (key, value) => {
    const current = csvList(get(key));
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    setParams({ [key]: next.join(',') });
  };

  // Status keeps its special default (Open+Pending when the param is absent).
  const statusRaw = searchParams.get('status');
  const statuses = statusRaw === 'any' ? [] : (statusRaw ? statusRaw.split(',').filter((s) => STATUS_OPTIONS.includes(s)) : ['Open', 'Pending']);
  const segment = get('segment');
  const toggleStatus = (status) => {
    const next = statuses.includes(status) ? statuses.filter((s) => s !== status) : [...statuses, status];
    setParams({ segment: null, status: next.length === 0 ? 'any' : next.join(',') });
  };

  const assignees = csvList(get('assignee'));
  const priorities = csvList(get('priority'));
  const types = csvList(get('type'));
  const categories = csvList(get('category'));
  const subcategories = csvList(get('subcategory'));
  const groups = csvList(get('group'));
  const sources = csvList(get('source'));
  const tags = csvList(get('tag'));
  const tagMode = get('tagMode');
  const impacts = csvList(get('impact'));
  const urgencies = csvList(get('urgency'));
  const due = csvList(get('due'));
  const origin = get('origin');
  const createdFrom = get('createdFrom');
  const createdTo = get('createdTo');
  const noise = get('noise');
  const view = get('view');
  const aiState = get('aiState');

  const activeTotal = [
    segment && segment !== 'all', statusRaw, assignees.length, priorities.length, types.length,
    categories.length, subcategories.length, groups.length, sources.length, tags.length, impacts.length, urgencies.length, due.length,
    origin, createdFrom || createdTo, noise, view, aiState, get('q'),
  ].filter(Boolean).length;

  const clearAll = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams();
      for (const key of ['sort', 'dir', 'peek']) {
        const v = prev.get(key);
        if (v) next.set(key, v);
      }
      return next;
    }, { replace: true });
  };

  // Technician search within the facet
  const [techQuery, setTechQuery] = useState('');
  const techs = useMemo(() => {
    const q = techQuery.trim().toLowerCase();
    const list = meta?.technicians || [];
    return q ? list.filter((t) => t.name.toLowerCase().includes(q)) : list;
  }, [meta?.technicians, techQuery]);
  // Show the first N technicians + "load more" so the list doesn't grow endlessly.
  const TECH_PAGE = 15;
  const [techLimit, setTechLimit] = useState(TECH_PAGE);
  // When searching, show all matches; otherwise cap to the current limit but
  // always keep any already-selected techs visible.
  const shownTechs = useMemo(() => {
    if (techQuery.trim()) return techs;
    const capped = techs.slice(0, techLimit);
    const extraSelected = techs.slice(techLimit).filter((t) => assignees.includes(String(t.id)));
    return [...capped, ...extraSelected];
  }, [techs, techLimit, techQuery, assignees]);

  // Category tree expansion
  const [expandedCats, setExpandedCats] = useState(() => new Set());
  const toggleCatExpand = (id) => setExpandedCats((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Category type-to-filter — drilling through a big tree is slow, so a search
  // narrows to matching categories/subcategories (parent kept if it or any child
  // matches; only matching children shown unless the parent name itself matches).
  const [catQuery, setCatQuery] = useState('');
  const filteredCategoryTree = useMemo(() => {
    const q = catQuery.trim().toLowerCase();
    const tree = meta?.categoryTree || [];
    if (!q) return tree;
    // Light stemming so "license" matches "Licensing", "licenses", etc. — strip
    // a common trailing suffix from each word before comparing, both sides.
    const stem = (word) => word.replace(/(ing|ies|ed|es|s|e)$/, '') || word;
    const stemText = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem).join(' ');
    const qTokens = q.split(/[^a-z0-9]+/).filter(Boolean).map(stem);
    const matches = (name) => {
      const hay = stemText(name);
      return qTokens.every((tok) => hay.includes(tok));
    };
    const out = [];
    for (const cat of tree) {
      const catMatch = matches(cat.name);
      const subs = (cat.subcategories || []).filter((s) => matches(s.name));
      if (catMatch) out.push({ ...cat }); // parent matches → keep with all its subs
      else if (subs.length) out.push({ ...cat, subcategories: subs });
    }
    return out;
  }, [meta?.categoryTree, catQuery]);
  const catSearching = catQuery.trim().length > 0;

  // Created range
  const [showCalendar, setShowCalendar] = useState(false);
  const now = new Date();
  const activePreset = CREATED_PRESETS.find((p) => {
    const [from, to] = p.range(now);
    return createdFrom === day(from) && createdTo === day(to);
  })?.key || null;
  const applyPreset = (preset) => {
    const [from, to] = preset.range(now);
    setParams({ createdFrom: day(from), createdTo: day(to) });
    setShowCalendar(false);
  };
  const calendarRange = {
    from: createdFrom ? new Date(`${createdFrom}T00:00:00`) : undefined,
    to: createdTo ? new Date(`${createdTo}T00:00:00`) : undefined,
  };

  const CANNED_VIEWS = [
    { key: 'all', label: 'All tickets', params: { status: 'any' } },
    ...(meta?.actor?.technicianId ? [{ key: 'mine', label: 'My open', params: { assignee: String(meta.actor.technicianId) } }] : []),
    { key: 'unassigned', label: 'Unassigned', params: { segment: 'unassigned' } },
    { key: 'awaiting_approval', label: 'Awaiting AI approval', params: { aiState: 'suggested' }, icon: Sparkles },
    { key: 'awaiting', label: 'Awaiting reply', params: { segment: 'awaiting' } },
    { key: 'noise', label: 'Noise & spam', params: { noise: 'only', status: 'any' }, icon: VolumeX },
    { key: 'deleted', label: 'Deleted', params: { segment: 'deleted', status: 'any' }, icon: Trash2 },
    { key: 'resolved', label: 'Recently resolved', params: { segment: 'resolved' } },
    { key: 'scheduled', label: 'Scheduled', params: { view: 'scheduled' }, icon: CalendarClock },
  ];
  const applyView = (v) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams();
      for (const key of ['sort', 'dir']) {
        const val = prev.get(key);
        if (val) next.set(key, val);
      }
      for (const [k, val] of Object.entries(v.params)) next.set(k, String(val));
      return next;
    }, { replace: true });
    onMobileClose?.();
  };
  const viewActive = (v) => Object.entries(v.params).every(([k, val]) => (searchParams.get(k) || '') === String(val))
    && activeTotal === Object.keys(v.params).length;

  // Snapshot the active filter query for a new saved view.
  const FILTER_KEYS = ['segment', 'status', 'assignee', 'priority', 'type', 'category', 'subcategory', 'group', 'source', 'tag', 'tagMode', 'impact', 'urgency', 'due', 'origin', 'createdFrom', 'createdTo', 'noise', 'q', 'view', 'aiState'];
  const captureParams = () => {
    const out = {};
    for (const k of FILTER_KEYS) { const val = searchParams.get(k); if (val) out[k] = val; }
    return out;
  };
  const saveCurrentView = async () => {
    const name = newViewName.trim();
    if (!name) return;
    try {
      await ticketsAPI.createSavedView({ name, params: captureParams(), shared: false });
      setNewViewName(''); setSavingView(false);
      await loadSavedViews();
    } catch { /* non-fatal */ }
  };
  const deleteSavedView = async (id) => {
    try { await ticketsAPI.deleteSavedView(id); await loadSavedViews(); } catch { /* non-fatal */ }
  };
  const toggleShareView = async (v) => {
    try { await ticketsAPI.updateSavedView(v.id, { shared: !v.shared }); await loadSavedViews(); } catch { /* non-fatal */ }
  };

  const body = (
    <>
      <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-slate-100">
        <ListFilter className="w-4 h-4 text-blue-500" aria-hidden="true" />
        <span className="text-sm font-bold text-slate-800">Filters</span>
        {activeTotal > 0 && (
          <button
            onClick={clearAll}
            className="tp-focus-ring text-[11px] font-semibold text-red-500 hover:text-red-700 rounded px-1"
          >
            Clear all ({activeTotal})
          </button>
        )}
        {mobileOpen ? (
          <button onClick={onMobileClose} aria-label="Close filters" className="tp-focus-ring ml-auto p-1 rounded-lg text-slate-400 hover:bg-slate-100">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        ) : (
          <button
            onClick={() => setCollapsed(true)}
            aria-label="Collapse filters"
            title="Collapse filters"
            className="tp-focus-ring ml-auto p-1 rounded-lg text-slate-300 hover:text-slate-500 hover:bg-slate-100"
          >
            <ChevronsLeft className="w-4 h-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto settings-scrollbar lg:flex-none lg:min-h-0 lg:overflow-visible">
        {/* Desktop: natural height, scrolls with the page (one scrollbar). Mobile
            drawer: this region scrolls inside the fixed-height slide-over. */}
        <Section title="Views" icon={LayoutList} defaultOpen>
          <div className="space-y-0.5">
            {CANNED_VIEWS.map((v) => {
              const count = {
                all: stats?.all, unassigned: stats?.unassigned, awaiting: stats?.awaiting,
                awaiting_approval: stats?.awaitingApproval,
                noise: stats?.noise, deleted: stats?.deleted, resolved: stats?.resolved,
              }[v.key];
              return (
                <button
                  key={v.key}
                  onClick={() => applyView(v)}
                  className={`tp-focus-ring w-full flex items-center gap-1.5 text-left px-1.5 py-1 rounded-md text-[13px] ${
                    viewActive(v) ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {v.icon && <v.icon className="w-3 h-3 text-slate-400 flex-shrink-0" aria-hidden="true" />}
                  <span className="flex-1 truncate">{v.label}</span>
                  {count != null && <span className="text-[10px] text-slate-400 tabular-nums flex-shrink-0">{count.toLocaleString()}</span>}
                </button>
              );
            })}

            {/* Saved views — the user's own + workspace-shared */}
            {savedViews.length > 0 && (
              <div className="mt-1.5 pt-1.5 border-t border-slate-100 space-y-0.5">
                {savedViews.map((v) => (
                  <div key={v.id} className="group/sv flex items-center gap-1">
                    <button
                      onClick={() => applyView(v)}
                      title={v.shared && !v.mine ? `Shared by ${v.ownerEmail}` : undefined}
                      className={`tp-focus-ring flex-1 min-w-0 flex items-center gap-1.5 text-left px-1.5 py-1 rounded-md text-[13px] ${
                        viewActive(v) ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {v.shared ? <Users className="w-3 h-3 text-indigo-400 flex-shrink-0" aria-hidden="true" /> : <Star className="w-3 h-3 text-amber-400 flex-shrink-0" aria-hidden="true" />}
                      <span className="flex-1 truncate">{v.name}</span>
                    </button>
                    {canShare && v.mine && (
                      <button
                        onClick={() => toggleShareView(v)}
                        title={v.shared ? 'Unshare from workspace' : 'Share to workspace'}
                        className={`tp-focus-ring p-0.5 rounded opacity-0 group-hover/sv:opacity-100 focus:opacity-100 ${v.shared ? 'text-indigo-500' : 'text-slate-300 hover:text-indigo-500'}`}
                      >
                        <Users className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    )}
                    {v.mine && (
                      confirmDeleteView === v.id ? (
                        <span className="flex items-center gap-0.5 flex-shrink-0" onMouseLeave={() => setConfirmDeleteView(null)}>
                          <button
                            onClick={() => { deleteSavedView(v.id); setConfirmDeleteView(null); }}
                            title="Confirm delete"
                            className="tp-focus-ring px-1.5 py-0.5 rounded text-[10px] font-bold text-white bg-red-500 hover:bg-red-600"
                          >
                            Delete
                          </button>
                          <button
                            onClick={() => setConfirmDeleteView(null)}
                            title="Cancel"
                            className="tp-focus-ring p-0.5 rounded text-slate-400 hover:text-slate-600"
                          >
                            <X className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteView(v.id)}
                          title="Delete view"
                          className="tp-focus-ring p-0.5 rounded text-slate-300 hover:text-red-500 opacity-0 group-hover/sv:opacity-100 focus:opacity-100 flex-shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      )
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Save current filters */}
            <div className="mt-1.5 pt-1.5 border-t border-slate-100">
              {savingView ? (
                <div className="flex items-center gap-1">
                  <input
                    autoFocus
                    value={newViewName}
                    onChange={(e) => setNewViewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveCurrentView(); if (e.key === 'Escape') { setSavingView(false); setNewViewName(''); } }}
                    placeholder="View name…"
                    className="tp-focus-ring flex-1 min-w-0 px-2 py-1 text-xs bg-white border border-input rounded-md placeholder:text-slate-400"
                  />
                  <button onClick={saveCurrentView} disabled={!newViewName.trim()} className="tp-focus-ring p-1 rounded-md bg-primary text-primary-foreground disabled:opacity-50" title="Save view">
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                  <button onClick={() => { setSavingView(false); setNewViewName(''); }} className="tp-focus-ring p-1 rounded-md text-slate-400 hover:bg-slate-100" title="Cancel">
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setSavingView(true)}
                  disabled={activeTotal === 0}
                  title={activeTotal === 0 ? 'Apply some filters first' : 'Save the current filters as a view'}
                  className="tp-focus-ring w-full flex items-center gap-1.5 px-1.5 py-1 rounded-md text-[13px] text-blue-600 hover:bg-blue-50 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Save current filters…
                </button>
              )}
            </div>
          </div>
        </Section>

        {/* Status */}
        <SortableFacet {...facetProps('status')}>
          <Section
            title="Status"
            activeCount={statusRaw && statusRaw !== 'any' ? statuses.length : 0}
            onClear={() => setParams({ status: null, segment: null })}
            defaultOpen
          >
            {STATUS_OPTIONS.map((s) => (
              <Facet key={s} checked={segment === '' && statuses.includes(s)} onToggle={() => toggleStatus(s)}>
                {s}
              </Facet>
            ))}
          </Section>
        </SortableFacet>

        {/* Technician */}
        <SortableFacet {...facetProps('technician')}>
          <Section
            title="Members"
            activeCount={assignees.length}
            onClear={() => setParams({ assignee: null })}
            defaultOpen
          >
            <div className="relative mb-1">
              <Search className="w-3 h-3 text-slate-300 absolute left-2 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                type="search"
                value={techQuery}
                onChange={(e) => setTechQuery(e.target.value)}
                placeholder="Find member…"
                aria-label="Search members"
                className="tp-focus-ring w-full pl-6 pr-2 py-1 text-xs bg-slate-50 border border-slate-200 rounded-md placeholder:text-slate-400"
              />
            </div>
            <div>
              <Facet checked={assignees.includes('unassigned')} onToggle={() => toggleCsv('assignee', 'unassigned')}>
                <span className="text-slate-400 italic">Unassigned</span>
              </Facet>
              {meta?.actor?.technicianId && (
                <Facet
                  checked={assignees.includes(String(meta.actor.technicianId))}
                  onToggle={() => toggleCsv('assignee', String(meta.actor.technicianId))}
                >
                  <span className="font-medium">Assigned to me</span>
                </Facet>
              )}
              {shownTechs.map((t) => (
                <Facet
                  key={t.id}
                  checked={assignees.includes(String(t.id))}
                  onToggle={() => toggleCsv('assignee', String(t.id))}
                  count={stats?.byTechnician?.[t.id]}
                >
                  <PersonAvatar name={t.name} photoUrl={t.photoUrl} size="h-4.5 w-4.5 h-[18px] w-[18px]" textSize="text-[8px]" />
                  <span className="truncate">{t.name}</span>
                </Facet>
              ))}
              {!techQuery.trim() && techs.length > techLimit && (
                <button
                  onClick={() => setTechLimit((n) => n + TECH_PAGE)}
                  className="tp-focus-ring w-full text-left px-1.5 py-1 mt-0.5 rounded-md text-[12px] font-medium text-blue-600 hover:bg-blue-50"
                >
                  Show {Math.min(TECH_PAGE, techs.length - techLimit)} more · {techs.length - techLimit} hidden
                </button>
              )}
            </div>
          </Section>
        </SortableFacet>

        {/* Priority */}
        <SortableFacet {...facetProps('priority')}>
          <Section title="Priority" activeCount={priorities.length} onClear={() => setParams({ priority: null })} defaultOpen>
            {[4, 3, 2, 1].map((p) => (
              <Facet key={p} checked={priorities.includes(String(p))} onToggle={() => toggleCsv('priority', String(p))}>
                <span aria-hidden="true" className={`w-2 h-2 rounded-full ${PRIORITY_STRIP_COLORS[p] || 'bg-slate-300'}`} />
                {PRIORITY_LABELS[p]}
              </Facet>
            ))}
          </Section>
        </SortableFacet>

        {/* Type */}
        <SortableFacet {...facetProps('type')}>
          <Section title="Type" activeCount={types.length} onClear={() => setParams({ type: null })}>
            {TYPE_OPTIONS.map((t) => (
              <Facet key={t} checked={types.includes(t)} onToggle={() => toggleCsv('type', t)}>{t}</Facet>
            ))}
          </Section>
        </SortableFacet>

        {/* Category tree */}
        <SortableFacet {...facetProps('category')}>
          <Section
            title="Category"
            activeCount={categories.length + subcategories.length}
            onClear={() => setParams({ category: null, subcategory: null })}
          >
            <div className="relative mb-1">
              <Search className="w-3 h-3 text-slate-300 absolute left-2 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                type="search"
                value={catQuery}
                onChange={(e) => setCatQuery(e.target.value)}
                placeholder="Find category…"
                aria-label="Search categories"
                className="tp-focus-ring w-full pl-6 pr-2 py-1 text-xs bg-slate-50 border border-slate-200 rounded-md placeholder:text-slate-400"
              />
            </div>
            <div>
              {filteredCategoryTree.map((cat) => {
                const expanded = catSearching || expandedCats.has(cat.id);
                return (
                  <div key={cat.id}>
                    <div className="flex items-center">
                      {cat.subcategories.length > 0 && !catSearching ? (
                        <button
                          onClick={() => toggleCatExpand(cat.id)}
                          aria-label={`${expandedCats.has(cat.id) ? 'Collapse' : 'Expand'} ${cat.name}`}
                          className="tp-focus-ring p-0.5 rounded text-slate-300 hover:text-slate-500"
                        >
                          {expandedCats.has(cat.id)
                            ? <ChevronDown className="w-3 h-3" aria-hidden="true" />
                            : <ChevronRight className="w-3 h-3" aria-hidden="true" />}
                        </button>
                      ) : <span className="w-4" aria-hidden="true" />}
                      <div className="flex-1 min-w-0">
                        <Facet checked={categories.includes(String(cat.id))} onToggle={() => toggleCsv('category', String(cat.id))}>
                          <span className="truncate">{cat.name}</span>
                        </Facet>
                      </div>
                    </div>
                    {expanded && cat.subcategories.map((sub) => (
                      <div key={sub.id} className="pl-7">
                        <Facet checked={subcategories.includes(String(sub.id))} onToggle={() => toggleCsv('subcategory', String(sub.id))}>
                          <span className="truncate text-slate-500">{sub.name}</span>
                        </Facet>
                      </div>
                    ))}
                  </div>
                );
              })}
              {catSearching && filteredCategoryTree.length === 0 && (
                <p className="px-2 py-2 text-xs text-slate-400">No category matches “{catQuery}”.</p>
              )}
            </div>
          </Section>
        </SortableFacet>

        {/* Group */}
        {(meta?.groups?.length || 0) > 0 && (
          <SortableFacet {...facetProps('group')}>
            <Section title="Group" activeCount={groups.length} onClear={() => setParams({ group: null })}>
              <div>
                {meta.groups.map((g) => (
                  <Facet
                    key={g.id}
                    checked={groups.includes(String(g.freshserviceId))}
                    onToggle={() => toggleCsv('group', String(g.freshserviceId))}
                  >
                    <span className="truncate">{g.name}</span>
                  </Facet>
                ))}
              </div>
            </Section>
          </SortableFacet>
        )}

        {/* Tags (gap plan P1) */}
        {(meta?.tags?.length || 0) > 0 && (
          <SortableFacet {...facetProps('tag')}>
            <Section title="Tags" activeCount={tags.length} onClear={() => setParams({ tag: null, tagMode: null })}>
              {tags.length > 1 && (
                <div className="flex items-center gap-1 mb-1 px-1.5">
                  <span className="text-[10px] uppercase tracking-wide text-slate-400">Match</span>
                  {['any', 'all'].map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setParams({ tagMode: mode === 'any' ? null : mode })}
                      aria-pressed={(tagMode || 'any') === mode}
                      className={`tp-focus-ring px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
                        (tagMode || 'any') === mode ? 'bg-blue-100 text-blue-700' : 'text-slate-400 hover:bg-slate-50'
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              )}
              {meta.tags.map((t) => (
                <Facet
                  key={t.id}
                  checked={tags.includes(String(t.id))}
                  onToggle={() => toggleCsv('tag', String(t.id))}
                >
                  <TagChip tag={t} size="xs" />
                </Facet>
              ))}
              <Facet checked={tags.includes('none')} onToggle={() => toggleCsv('tag', 'none')}>
                <span className="text-slate-400 italic">Untagged</span>
              </Facet>
            </Section>
          </SortableFacet>
        )}

        {/* Impact / urgency (P1.5) — appears once anyone uses the fields */}
        {meta?.hasImpactUrgency && (
          <SortableFacet {...facetProps('impact')}>
            <Section title="Impact / Urgency" activeCount={impacts.length + urgencies.length} onClear={() => setParams({ impact: null, urgency: null })}>
              {[['impact', impacts], ['urgency', urgencies]].map(([key, active]) => (
                <div key={key} className="flex items-center gap-1 px-1.5 py-0.5">
                  <span className="w-14 text-[10px] uppercase tracking-wide text-slate-400">{key}</span>
                  {[1, 2, 3].map((v) => (
                    <button
                      key={v}
                      onClick={() => toggleCsv(key, String(v))}
                      aria-pressed={active.includes(String(v))}
                      className={`tp-focus-ring px-1.5 py-0.5 rounded text-[11px] font-medium ${
                        active.includes(String(v)) ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-50'
                      }`}
                    >
                      {['Low', 'Med', 'High'][v - 1]}
                    </button>
                  ))}
                </div>
              ))}
            </Section>
          </SortableFacet>
        )}

        {/* Source */}
        {(meta?.sources?.length || 0) > 0 && (
          <SortableFacet {...facetProps('source')}>
            <Section title="Source" activeCount={sources.length} onClear={() => setParams({ source: null })}>
              {meta.sources.map((s) => (
                <Facet
                  key={s.value}
                  checked={sources.includes(String(s.value))}
                  onToggle={() => toggleCsv('source', String(s.value))}
                  count={s.count}
                >
                  {s.label}
                </Facet>
              ))}
            </Section>
          </SortableFacet>
        )}

        {/* Created */}
        <SortableFacet {...facetProps('created')}>
          <Section
            title="Created"
            icon={CalendarDays}
            activeCount={createdFrom || createdTo ? 1 : 0}
            onClear={() => { setParams({ createdFrom: null, createdTo: null }); setShowCalendar(false); }}
          >
            <div className="grid grid-cols-2 gap-0.5 mb-1">
              {CREATED_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  onClick={() => applyPreset(preset)}
                  className={`tp-focus-ring text-left px-1.5 py-1 rounded-md text-xs ${
                    activePreset === preset.key ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
              <button
                onClick={() => setShowCalendar((v) => !v)}
                aria-expanded={showCalendar}
                className={`tp-focus-ring text-left px-1.5 py-1 rounded-md text-xs ${
                  showCalendar || (createdFrom && !activePreset) ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
              Between days…
              </button>
            </div>
            {(createdFrom || createdTo) && (
              <p className="px-1.5 pb-1 text-[10px] text-slate-400">
                {createdFrom || '…'} → {createdTo || 'today'}
              </p>
            )}
            {showCalendar && (
              <div className="tp-rail-calendar rounded-lg border border-slate-100 bg-slate-50/60 p-1">
                <DayPicker
                  mode="range"
                  numberOfMonths={1}
                  weekStartsOn={1}
                  selected={calendarRange.from ? calendarRange : undefined}
                  onSelect={(range) => {
                    setParams({
                      createdFrom: range?.from ? day(range.from) : null,
                      createdTo: range?.to ? day(range.to) : (range?.from ? day(range.from) : null),
                    });
                  }}
                  disabled={{ after: new Date() }}
                />
              </div>
            )}
          </Section>
        </SortableFacet>

        {/* Due */}
        <SortableFacet {...facetProps('due')}>
          <Section title="Due" activeCount={due.length} onClear={() => setParams({ due: null })}>
            {DUE_OPTIONS.map((o) => (
              <Facet key={o.value} checked={due.includes(o.value)} onToggle={() => toggleCsv('due', o.value)}>
                {o.label}
              </Facet>
            ))}
          </Section>
        </SortableFacet>

        {/* Origin */}
        <SortableFacet {...facetProps('origin')}>
          <Section title="Origin" activeCount={origin ? 1 : 0} onClear={() => setParams({ origin: null })}>
            {[{ v: 'ticketpulse', label: 'Born in Ticket Pulse' }, { v: 'freshservice', label: 'From FreshService' }].map(({ v, label }) => (
              <Facet key={v} checked={origin === v} onToggle={() => setParams({ origin: origin === v ? null : v })}>
                {label}
              </Facet>
            ))}
          </Section>
        </SortableFacet>
      </div>
    </>
  );

  // Mobile: a native-feeling bottom sheet (drag the handle down to dismiss).
  // Always mounted so vaul can animate both in and out; visibility = `mobileOpen`.
  if (sheet) {
    return (
      <Drawer.Root open={mobileOpen} onOpenChange={(o) => { if (!o) onMobileClose?.(); }} shouldScaleBackground>
        <Drawer.Portal>
          <Drawer.Overlay className="lg:hidden fixed inset-0 z-50 bg-slate-900/40" />
          <Drawer.Content className="lg:hidden fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-2xl bg-white shadow-soft max-h-[88vh] focus:outline-none">
            <Drawer.Title className="sr-only">Ticket filters</Drawer.Title>
            <div className="pt-2.5 pb-1 flex justify-center shrink-0" aria-hidden="true">
              <span className="h-1.5 w-10 rounded-full bg-slate-300" />
            </div>
            {body}
            <div className="pb-safe shrink-0" aria-hidden="true" />
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  // Desktop: one always-full-height sticky rail whose WIDTH animates, so the
  // grid track (and the table next to it) reflows smoothly and reclaims the
  // freed space. Both content layers stay mounted and cross-fade.
  return (
    <aside
      aria-label="Ticket filters"
      data-collapsed={collapsed ? 'true' : undefined}
      className={`hidden lg:flex sticky top-4 self-start flex-col tp-card rounded-xl overflow-hidden
        transition-[width] duration-300 ease-out motion-reduce:transition-none ${collapsed ? 'w-11 h-[calc(100vh-2rem)]' : 'w-[248px]'}`}
    >
      {/* Slim layer (collapsed) */}
      <div
        aria-hidden={!collapsed}
        className={`absolute inset-x-0 top-0 flex flex-col items-center gap-2 py-3 transition-opacity duration-200 ${
          collapsed ? 'opacity-100 delay-150' : 'opacity-0 pointer-events-none'
        }`}
      >
        <button
          onClick={() => setCollapsed(false)}
          aria-label="Expand filters"
          title="Expand filters"
          tabIndex={collapsed ? 0 : -1}
          className="tp-focus-ring p-1.5 rounded-lg text-slate-400 hover:text-blue-700 hover:bg-blue-50"
        >
          <ChevronsRight className="w-4 h-4" aria-hidden="true" />
        </button>
        <button
          onClick={() => setCollapsed(false)}
          aria-label={`Filters${activeTotal ? ` (${activeTotal} active)` : ''}`}
          tabIndex={collapsed ? 0 : -1}
          className="tp-focus-ring relative p-1.5 rounded-lg text-slate-400 hover:text-blue-700 hover:bg-blue-50"
        >
          <ListFilter className="w-4 h-4" aria-hidden="true" />
          {activeTotal > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-0.5 rounded-full bg-blue-600 text-white text-[9px] font-bold inline-flex items-center justify-center">
              {activeTotal}
            </span>
          )}
        </button>
      </div>

      {/* Full layer — fixed inner width so text doesn't reflow mid-animation */}
      <div
        aria-hidden={collapsed}
        className={`flex flex-col w-[248px] flex-shrink-0 transition-opacity duration-150 ${
          collapsed ? 'opacity-0 pointer-events-none' : 'opacity-100 delay-100'
        }`}
      >
        {body}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------

const MONTH_DAY = { month: 'short', day: 'numeric' };
const fmtDay = (s) => {
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, MONTH_DAY);
};

/**
 * Always-visible "you are looking at a filtered view" bar: sticky under the
 * app header, one removable chip per active facet, and a prominent reset.
 */
export function ActiveFilterBar({ meta }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const get = (k) => searchParams.get(k) || '';

  const patch = (changes) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, String(v));
      }
      next.delete('page');
      return next;
    }, { replace: true });
  };
  const removeFromCsv = (key, value) => {
    const left = csvList(get(key)).filter((v) => v !== value);
    patch({ [key]: left.join(',') });
  };

  const techName = (id) => (id === 'unassigned' ? 'Unassigned' : (meta?.technicians || []).find((t) => String(t.id) === id)?.name || `Tech ${id}`);
  const catName = (id) => {
    for (const c of meta?.categoryTree || []) {
      if (String(c.id) === id) return c.name;
      const sub = c.subcategories.find((s) => String(s.id) === id);
      if (sub) return sub.name;
    }
    return `Category ${id}`;
  };
  const groupName = (fsId) => (meta?.groups || []).find((g) => String(g.freshserviceId) === fsId)?.name || `Group ${fsId}`;
  const sourceName = (v) => (meta?.sources || []).find((s) => String(s.value) === v)?.label || `Source ${v}`;
  const PRIOS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
  const SEGMENT_LABELS = { open: 'Open', unassigned: 'Unassigned', awaiting: 'Awaiting reply', due_today: 'Due today', overdue: 'Overdue', resolved: 'Resolved' };
  const DUE_LABELS = { overdue: 'Overdue', today: 'Due today', week: 'Due in 7 days', none: 'No due date' };

  const chips = [];
  const q = get('q');
  if (q) chips.push({ label: `“${q}”`, onRemove: () => patch({ q: null }) });
  const segment = get('segment');
  if (segment && segment !== 'all') chips.push({ label: SEGMENT_LABELS[segment] || segment, onRemove: () => patch({ segment: null }) });
  const statusRaw = searchParams.get('status');
  if (statusRaw === 'any') chips.push({ label: 'Any status', onRemove: () => patch({ status: null }) });
  else if (statusRaw) for (const s of csvList(statusRaw)) chips.push({ label: s, onRemove: () => removeFromCsv('status', s) });
  for (const a of csvList(get('assignee'))) chips.push({ label: techName(a), onRemove: () => removeFromCsv('assignee', a) });
  for (const p of csvList(get('priority'))) chips.push({ label: PRIOS[p] || `P${p}`, onRemove: () => removeFromCsv('priority', p) });
  for (const t of csvList(get('type'))) chips.push({ label: t, onRemove: () => removeFromCsv('type', t) });
  for (const c of csvList(get('category'))) chips.push({ label: catName(c), onRemove: () => removeFromCsv('category', c) });
  for (const s of csvList(get('subcategory'))) chips.push({ label: catName(s), onRemove: () => removeFromCsv('subcategory', s) });
  for (const g of csvList(get('group'))) chips.push({ label: groupName(g), onRemove: () => removeFromCsv('group', g) });
  for (const s of csvList(get('source'))) chips.push({ label: sourceName(s), onRemove: () => removeFromCsv('source', s) });
  for (const t of csvList(get('tag'))) {
    const tagObj = (meta?.tags || []).find((x) => String(x.id) === t);
    chips.push({
      label: t === 'none' ? 'Untagged' : `#${tagObj?.name || t}`,
      onRemove: () => removeFromCsv('tag', t),
    });
  }
  const from = get('createdFrom');
  const to = get('createdTo');
  if (from || to) {
    chips.push({
      label: `Created ${from ? fmtDay(from) : '…'} – ${to ? fmtDay(to) : 'today'}`,
      onRemove: () => patch({ createdFrom: null, createdTo: null }),
    });
  }
  for (const d of csvList(get('due'))) chips.push({ label: DUE_LABELS[d] || d, onRemove: () => removeFromCsv('due', d) });
  const origin = get('origin');
  if (origin) chips.push({ label: origin === 'ticketpulse' ? 'Born in Ticket Pulse' : 'From FreshService', onRemove: () => patch({ origin: null }) });
  if (get('noise') === 'only') chips.push({ label: 'Noise & spam', onRemove: () => patch({ noise: null }) });
  if (get('view') === 'scheduled') chips.push({ label: 'Scheduled view', onRemove: () => patch({ view: null }) });
  if (get('aiState') === 'suggested') chips.push({ label: 'Awaiting AI approval', onRemove: () => patch({ aiState: null }) });

  if (chips.length === 0) return null;

  const resetAll = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams();
      for (const key of ['sort', 'dir', 'peek']) {
        const v = prev.get(key);
        if (v) next.set(key, v);
      }
      return next;
    }, { replace: true });
  };

  return (
    <div className="sticky top-[64px] z-30 mb-3 animate-fadeIn">
      <div className="tp-glass rounded-xl border border-blue-200/70 shadow-subtle px-3 py-2 flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-blue-700">
          <ListFilter className="w-3.5 h-3.5" aria-hidden="true" />
          Filtered view
        </span>
        {chips.map((chip, i) => (
          <span
            key={`${chip.label}-${i}`}
            className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-white border border-slate-200 text-xs text-slate-700 shadow-subtle"
          >
            {chip.label}
            <button
              onClick={chip.onRemove}
              aria-label={`Remove filter ${chip.label}`}
              className="tp-focus-ring rounded-full p-0.5 text-slate-400 hover:text-red-600 hover:bg-red-50"
            >
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        <button
          onClick={resetAll}
          className="tp-focus-ring ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-bold hover:bg-red-700 shadow-subtle"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
          Reset filters ({chips.length})
        </button>
      </div>
    </div>
  );
}
