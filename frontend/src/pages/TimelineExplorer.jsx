import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ChevronLeft, ChevronRight, ChevronDown, Layers, RefreshCw,
  Users, Check, X as XIcon, Search, PanelLeftClose, PanelLeftOpen,
  EyeOff, Eye,
} from 'lucide-react';
import { dashboardAPI } from '../services/api';
import FilterBar, { applyNotPickedFilters, applyPickedFilters } from '../components/tech-detail/FilterBar';
import TimelineCore, { TimelineLegend } from '../components/timeline/TimelineCore';
import {
  mergeTicketsForTimeline,
  buildTimeline,
  collapseMarkers,
} from '../components/timeline/timelineUtils';
import { TECH_ACCENT_COLORS } from '../components/timeline/constants';
import { getInitials, formatDateLocal } from '../components/tech-detail/utils';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMonday(date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Merge avoidance data from multiple techs into a single unified dataset.
 * Each ticket appears once; _picked indicates any selected tech picked it.
 * _techFirstName / _accent carry the picker's identity for visual labelling.
 */
function mergeMultiTechData(techDataArray, accentMap) {
  // Union all unique days across all techs
  const dayMap = new Map(); // dateStr -> { ...dayData, _ticketSet: Map<id, ticket> }

  for (const tech of techDataArray) {
    const accent = accentMap.get(tech.id);
    const firstName = tech.name?.split(' ')[0] || 'Tech';

    for (const day of tech.avoidance?.days || []) {
      if (!dayMap.has(day.date)) {
        dayMap.set(day.date, {
          ...day,
          tickets: [],
          extendedTickets: [],
          _seen: new Map(),
          _seenExt: new Map(),
        });
      }
      const merged = dayMap.get(day.date);

      // Coverage tickets
      for (const t of day.tickets || []) {
        if (!merged._seen.has(t.id)) {
          merged._seen.set(t.id, { ...t, _techFirstName: null, _accent: null });
          merged.tickets.push(merged._seen.get(t.id));
        }
        if (t.pickedByTech) {
          const existing = merged._seen.get(t.id);
          existing._techFirstName = firstName;
          existing._accent = accent;
        }
      }

      // Extended tickets (after 9 AM)
      for (const t of day.extendedTickets || []) {
        if (!merged._seenExt.has(t.id)) {
          merged._seenExt.set(t.id, { ...t, _techFirstName: null, _accent: null });
          merged.extendedTickets.push(merged._seenExt.get(t.id));
        }
        if (t.pickedByTech) {
          const existing = merged._seenExt.get(t.id);
          existing._techFirstName = firstName;
          existing._accent = accent;
        }
      }
    }
  }

  return Array.from(dayMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ _seen, _seenExt, ...day }) => day);
}

// ── TechSelector subcomponent ─────────────────────────────────────────────────

function TechSelector({
  techList, selectedIds, onChange, accentMap, perTech, isOpen,
  hiddenIds, onToggleHidden,
}) {
  const [search, setSearch] = useState('');
  const [showHidden, setShowHidden] = useState(false);

  const visibleTechs = techList.filter((t) => !hiddenIds.has(t.id));
  const hiddenTechs  = techList.filter((t) => hiddenIds.has(t.id));

  // Sort: selected first, then alphabetical within each group
  const sorted = [...visibleTechs].sort((a, b) => {
    const aSelected = selectedIds.has(a.id) ? 0 : 1;
    const bSelected = selectedIds.has(b.id) ? 0 : 1;
    if (aSelected !== bSelected) return aSelected - bSelected;
    return a.name.localeCompare(b.name);
  });

  const filtered = sorted.filter((t) =>
    t.name.toLowerCase().includes(search.toLowerCase()),
  );

  const toggle = (id) => {
    const next = new Set(selectedIds);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange(next);
  };

  const selectAll = () => onChange(new Set(visibleTechs.map((t) => t.id)));
  const clearAll  = () => onChange(new Set());

  // Build lookup: techId -> { picked, notPicked }
  const statsMap = new Map();
  (perTech || []).forEach((tp) => statsMap.set(tp.techId, tp));

  // ── Collapsed view ──
  if (!isOpen) {
    const selectedTechs = visibleTechs.filter((t) => selectedIds.has(t.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    return (
      <div className="flex flex-col gap-2 items-center py-1">
        {selectedTechs.map((tech) => {
          const accent = accentMap.get(tech.id);
          const st = statsMap.get(tech.id);
          return (
            <div
              key={tech.id}
              className="flex flex-col items-center gap-0.5"
              title={`${tech.name}${st ? ` — ${st.picked} picked · ${st.notPicked} not` : ''}`}
            >
              {tech.photoUrl ? (
                <img src={tech.photoUrl} alt={tech.name} className="w-7 h-7 rounded-full object-cover border border-slate-200" />
              ) : (
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[8px] font-bold text-white ${accent?.bg || 'bg-slate-400'}`}>
                  {getInitials(tech.name)}
                </div>
              )}
              {st && (
                <div className="flex items-center gap-0.5 leading-none">
                  <span className="text-[7px] font-bold text-emerald-600">{st.picked}</span>
                  <span className="text-[7px] text-slate-300">·</span>
                  <span className="text-[7px] font-bold text-slate-400">{st.notPicked}</span>
                </div>
              )}
            </div>
          );
        })}
        {selectedTechs.length === 0 && (
          <span className="text-slate-300 text-[9px] font-medium" style={{ writingMode: 'vertical-rl' }}>
            Select techs
          </span>
        )}
      </div>
    );
  }

  // ── Expanded view ──
  const renderRow = (tech, { isHiddenSection } = {}) => {
    const selected = selectedIds.has(tech.id);
    const accent = accentMap.get(tech.id);
    const st = statsMap.get(tech.id);

    return (
      <div
        key={tech.id}
        className={`flex items-center gap-2 px-3 py-2 transition-colors ${
          selected ? 'bg-blue-50' : 'hover:bg-slate-50'
        }`}
      >
        <button onClick={() => toggle(tech.id)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
          <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${selected ? (accent?.bg || 'bg-emerald-500') : 'bg-slate-200'}`} />
          {tech.photoUrl ? (
            <img src={tech.photoUrl} alt={tech.name} className="w-8 h-8 rounded-full object-cover flex-shrink-0 border border-slate-200" />
          ) : (
            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold text-white ${selected ? (accent?.bg || 'bg-blue-500') : 'bg-slate-300'}`}>
              {getInitials(tech.name)}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <span className={`text-sm truncate block ${selected ? 'font-semibold text-slate-900' : 'text-slate-600'}`}>
              {tech.name}
            </span>
            {/* Inline stats when selected */}
            {selected && st && (
              <span className="text-[10px] text-slate-400 block">
                <span className="text-emerald-600 font-semibold">{st.picked} picked</span>
                <span className="mx-1">·</span>
                <span>{st.notPicked} not</span>
              </span>
            )}
          </div>
          {selected && <Check className={`w-3.5 h-3.5 flex-shrink-0 ${accent ? accent.bg.replace('bg-', 'text-') : 'text-emerald-600'}`} />}
        </button>
        {/* Hide / unhide button */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleHidden(tech.id); }}
          className="p-1 hover:bg-slate-200 rounded transition-colors flex-shrink-0 text-slate-300 hover:text-slate-500"
          title={isHiddenSection ? 'Show agent' : 'Hide agent'}
        >
          {isHiddenSection ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
        </button>
      </div>
    );
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden flex-shrink-0">
      <div className="px-3 py-2 border-b border-slate-100">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-slate-600 uppercase tracking-wider flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" /> Technicians
          </span>
          <div className="flex items-center gap-1.5 text-[10px]">
            <button onClick={selectAll} className="text-blue-600 hover:underline">All</button>
            <span className="text-slate-300">·</span>
            <button onClick={clearAll} className="text-slate-400 hover:text-red-500 hover:underline">None</button>
          </div>
        </div>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-300" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter techs…"
            className="w-full pl-7 pr-2 py-1.5 text-sm border border-slate-200 rounded-md focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
          />
        </div>
      </div>

      {/* Visible techs */}
      <div className="overflow-y-auto divide-y divide-slate-50" style={{ maxHeight: 'calc(100vh - 280px)' }}>
        {filtered.map((tech) => renderRow(tech))}
        {filtered.length === 0 && (
          <p className="text-xs text-slate-400 text-center py-4">No techs match</p>
        )}
      </div>

      {/* Hidden techs — collapsible section */}
      {hiddenTechs.length > 0 && (
        <div className="border-t border-slate-200">
          <button
            onClick={() => setShowHidden((p) => !p)}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] text-slate-400 hover:text-slate-600 transition-colors"
          >
            <EyeOff className="w-3 h-3" />
            <span>{hiddenTechs.length} hidden</span>
            <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${showHidden ? 'rotate-180' : ''}`} />
          </button>
          {showHidden && (
            <div className="divide-y divide-slate-50 bg-slate-50/50">
              {hiddenTechs.map((tech) => renderRow(tech, { isHiddenSection: true }))}
            </div>
          )}
        </div>
      )}

      {/* Footer count */}
      {selectedIds.size > 0 && (
        <div className="px-3 py-1.5 border-t border-slate-100 bg-slate-50 text-[10px] text-slate-500">
          {selectedIds.size} selected
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function TimelineExplorer() {
  const navigate = useNavigate();

  // ── Tech state ──
  const [techList, setTechList] = useState([]);
  const [selectedTechIds, setSelectedTechIds] = useState(new Set());
  const [hiddenTechIds, setHiddenTechIds] = useState(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem('tl_hidden') || '[]')); }
    catch { return new Set(); }
  });
  // Map<techId, TECH_ACCENT_COLORS entry>
  const [accentMap, setAccentMap] = useState(new Map());

  const toggleHidden = (id) => {
    setHiddenTechIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else {
        next.add(id);
        // Also deselect if hiding
        setSelectedTechIds((sel) => { const s = new Set(sel); s.delete(id); return s; });
      }
      sessionStorage.setItem('tl_hidden', JSON.stringify([...next]));
      return next;
    });
  };

  // ── Period state ──
  const [viewMode, setViewMode]     = useState('daily');
  const [selectedDate, setSelectedDate]   = useState(null);   // YYYY-MM-DD or null = today
  const [selectedWeek, setSelectedWeek]   = useState(null);   // Date (Monday)
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1, 0, 0, 0);
  });

  // ── View mode ──
  const [mergedViewMode, setMergedViewMode] = useState('rolling');

  // ── Sidebar ──
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // ── Filter state ──
  const [excludeCats, setExcludeCats] = useState(new Set());
  const [excludeText, setExcludeText] = useState('');
  const [includeCats, setIncludeCats] = useState(new Set());
  const [includeText, setIncludeText] = useState('');

  // ── Data state ──
  const [techData, setTechData]   = useState(null);  // raw API response
  const [isLoading, setIsLoading] = useState(false);
  const [techListLoading, setTechListLoading] = useState(true);
  const [error, setError]         = useState(null);

  // ── Derived: is current period ──
  const isToday = !selectedDate;
  const isCurrentWeek = viewMode === 'weekly' && selectedWeek
    ? (() => {
      const mon = getMonday(new Date());
      const sel = new Date(selectedWeek);
      sel.setHours(0, 0, 0, 0);
      return sel.getTime() === mon.getTime();
    })()
    : false;
  const isCurrentMonth = viewMode === 'monthly' && selectedMonth
    ? (() => {
      const n = new Date();
      return selectedMonth.getFullYear() === n.getFullYear() && selectedMonth.getMonth() === n.getMonth();
    })()
    : false;

  // ── Load tech list from dashboard API ──
  useEffect(() => {
    setTechListLoading(true);
    dashboardAPI.getDashboard('America/Los_Angeles', null).then((res) => {
      if (res?.success && res.data?.technicians) {
        setTechList(res.data.technicians.filter((t) => t.isActive !== false));
      }
    }).catch(() => {}).finally(() => setTechListLoading(false));
  }, []);

  // ── Keep accent map in sync with selectedTechIds ──
  useEffect(() => {
    const arr = Array.from(selectedTechIds);
    const map = new Map();
    arr.forEach((id, idx) => {
      map.set(id, TECH_ACCENT_COLORS[idx % TECH_ACCENT_COLORS.length]);
    });
    setAccentMap(map);
  }, [selectedTechIds]);

  // ── Fetch timeline data ──
  const fetchTimeline = useCallback(async () => {
    if (selectedTechIds.size === 0) { setTechData(null); return; }
    setIsLoading(true);
    setError(null);
    try {
      const techIds = Array.from(selectedTechIds);
      let period = {};
      if (viewMode === 'monthly') {
        period.month = `${selectedMonth.getFullYear()}-${String(selectedMonth.getMonth() + 1).padStart(2, '0')}`;
      } else if (viewMode === 'weekly') {
        const ws = selectedWeek || getMonday(new Date());
        period.weekStart = formatDateLocal(ws);
      } else {
        if (selectedDate) period.date = selectedDate;
      }
      const res = await dashboardAPI.getTimeline(techIds, period, 'America/Los_Angeles');
      if (!res.success) throw new Error('Failed to load timeline');
      setTechData(res.data);
    } catch (e) {
      setError(e.message);
    } finally {
      setIsLoading(false);
    }
  }, [selectedTechIds, viewMode, selectedDate, selectedWeek, selectedMonth]);

  useEffect(() => { fetchTimeline(); }, [fetchTimeline]);

  // ── Navigation ──
  const handlePrevious = () => {
    if (viewMode === 'monthly') {
      const cur = selectedMonth;
      setSelectedMonth(new Date(cur.getFullYear(), cur.getMonth() - 1, 1));
    } else if (viewMode === 'weekly') {
      const cur = selectedWeek || getMonday(new Date());
      const prev = new Date(cur);
      prev.setDate(cur.getDate() - 7);
      setSelectedWeek(prev);
    } else {
      const cur = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();
      cur.setDate(cur.getDate() - 1);
      setSelectedDate(formatDateLocal(cur));
    }
  };

  const handleNext = () => {
    const now = new Date();
    if (viewMode === 'monthly') {
      const next = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() + 1, 1);
      const curMo = new Date(now.getFullYear(), now.getMonth(), 1);
      if (next <= curMo) setSelectedMonth(next);
    } else if (viewMode === 'weekly') {
      const cur = selectedWeek || getMonday(now);
      const next = new Date(cur);
      next.setDate(cur.getDate() + 7);
      if (formatDateLocal(next) <= formatDateLocal(now)) setSelectedWeek(next);
    } else {
      if (isToday) return;
      const cur = new Date(selectedDate + 'T12:00:00');
      cur.setDate(cur.getDate() + 1);
      const nextStr = formatDateLocal(cur);
      setSelectedDate(nextStr <= formatDateLocal(now) ? nextStr : null);
    }
  };

  const handleToday = () => {
    if (viewMode === 'monthly') {
      const n = new Date();
      setSelectedMonth(new Date(n.getFullYear(), n.getMonth(), 1));
    } else if (viewMode === 'weekly') {
      setSelectedWeek(getMonday(new Date()));
    } else {
      setSelectedDate(null);
    }
  };

  const atCurrentPeriod =
    (viewMode === 'daily' && isToday) ||
    (viewMode === 'weekly' && isCurrentWeek) ||
    (viewMode === 'monthly' && isCurrentMonth);

  const periodLabel =
    viewMode === 'monthly'
      ? selectedMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : viewMode === 'weekly'
        ? (() => {
          const ws = selectedWeek || getMonday(new Date());
          const we = new Date(ws);
          we.setDate(ws.getDate() + 6);
          return `${ws.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${we.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
        })()
        : isToday
          ? 'Today'
          : new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  const monthInputValue = `${selectedMonth.getFullYear()}-${String(selectedMonth.getMonth() + 1).padStart(2, '0')}`;
  const maxMonthValue   = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`; })();

  // ── Build timeline items ──
  const { timelineItems, days, allCategories, techConfigs, totals } = (() => {
    if (!techData || techData.technicians.length === 0) {
      return { timelineItems: [], days: [], allCategories: [], techConfigs: [], totals: null };
    }

    const techDataArray = techData.technicians.filter((t) => t.avoidance?.applicable !== false);

    // Build techConfigs for marker insertion
    const tcs = techDataArray.map((tech) => {
      const accent = accentMap.get(tech.id);
      const tz = tech.timezone || 'America/Los_Angeles';
      return {
        id: tech.id,
        firstName: tech.name?.split(' ')[0] || 'Tech',
        techStart: tech.workStartTime || '09:00',
        techEnd: tech.workEndTime || '17:00',
        techTz: tz,
        tzCity: tz.split('/').pop().replace(/_/g, ' '),
        accent,
      };
    });

    const mergedDays = techDataArray.length === 1
      ? (techDataArray[0].avoidance?.days || [])
      : mergeMultiTechData(techDataArray, accentMap);

    // Flatten picked / not-picked lists (with accent/firstName for multi-tech)
    const allPicked = [];
    const allNotPicked = [];

    if (techDataArray.length === 1) {
      const av = techDataArray[0].avoidance;
      const firstName = tcs[0].firstName;
      const accent = tcs[0].accent;
      mergedDays.forEach((day) => {
        (day.tickets || []).forEach((t) => {
          const enriched = { ...t, _day: day.date, _techFirstName: firstName, _accent: accent };
          (t.pickedByTech ? allPicked : allNotPicked).push(enriched);
        });
      });
    } else {
      mergedDays.forEach((day) => {
        (day.tickets || []).forEach((t) => {
          const enriched = { ...t, _day: day.date };
          (t._techFirstName ? allPicked : allNotPicked).push(enriched);
        });
      });
    }

    const filters = { excludeCats, excludeText, includeCats, includeText };
    const allMerged = mergeTicketsForTimeline(mergedDays, allPicked, allNotPicked);
    const filtered = allMerged.filter((t) => {
      if (t._picked) return applyPickedFilters(t, { includeCats, includeText });
      return applyNotPickedFilters(t, filters);
    });

    const rawItems = buildTimeline(mergedDays, filtered, mergedViewMode, tcs);
    const items = collapseMarkers(rawItems);

    const cats = [...new Set([...allPicked, ...allNotPicked].map((t) => t.ticketCategory).filter(Boolean))].sort();

    const pickedCount    = filtered.filter((t) => t._picked).length;
    const notPickedCount = filtered.filter((t) => !t._picked).length;
    const hiddenCount    = allMerged.filter((t) => !t._picked).length - notPickedCount;

    // Per-tech breakdown using assignedTechId for accurate matching
    const perTech = tcs.map((tc) => ({
      techId: tc.id,
      firstName: tc.firstName,
      accent: tc.accent,
      picked: filtered.filter((t) => t._picked && t.assignedTechId === tc.id).length,
      notPicked: notPickedCount,
    }));

    return {
      timelineItems: items,
      days: mergedDays,
      allCategories: cats,
      techConfigs: tcs,
      totals: { picked: pickedCount, notPicked: notPickedCount, hidden: hiddenCount, perTech },
    };
  })();

  const addExcludeCat = (cat) =>
    setExcludeCats((prev) => { const n = new Set(prev); n.add(cat); return n; });

  const isMultiDay = days.length > 1;

  // ── Render ──
  return (
    <div className="h-screen bg-slate-50 flex flex-col overflow-hidden relative">
      {/* Loading overlay — same style as Dashboard */}
      {(isLoading || techListLoading) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="absolute inset-0 bg-gray-900/20 backdrop-blur-[1px]" />
          <div className="relative">
            <div
              className="absolute inset-0 w-20 h-20 rounded-full border-4 border-transparent border-t-blue-500 border-r-blue-300 opacity-80"
              style={{ animation: 'spin 1.5s linear infinite' }}
            />
            <div
              className="absolute inset-2 w-16 h-16 rounded-full border-4 border-transparent border-b-purple-500 border-l-purple-300 opacity-70"
              style={{ animation: 'spin 1s linear infinite reverse', marginLeft: '0.5rem', marginTop: '0.5rem' }}
            />
            <div
              className="absolute inset-4 w-12 h-12 rounded-full border-4 border-transparent border-t-indigo-500 border-r-indigo-300 opacity-90"
              style={{ animation: 'spin 0.7s linear infinite', marginLeft: '1rem', marginTop: '1rem' }}
            />
            <div className="absolute w-20 h-20 flex items-center justify-center">
              <div className="w-4 h-4 rounded-full bg-gradient-to-br from-blue-400 to-purple-600 animate-pulse shadow-lg" />
            </div>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <header className="bg-white border-b border-slate-200 shadow-sm flex-shrink-0">
        <div className="max-w-full px-6 py-3 flex items-center gap-4">
          {/* Back */}
          <button
            onClick={() => navigate('/dashboard')}
            className="flex items-center gap-1.5 text-slate-500 hover:text-slate-800 transition-colors text-sm font-medium flex-shrink-0"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>

          <div className="w-px h-6 bg-slate-200 flex-shrink-0" />

          {/* Title */}
          <div className="flex items-center gap-2 min-w-0">
            <Layers className="w-5 h-5 text-blue-600 flex-shrink-0" />
            <h1 className="text-base font-bold text-slate-900 leading-tight">Timeline Explorer</h1>
            {selectedTechIds.size > 0 && (
              <span className="text-[10px] font-semibold bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">
                {selectedTechIds.size} tech{selectedTechIds.size > 1 ? 's' : ''}
              </span>
            )}
          </div>

          <div className="flex-1" />

          {/* Period toggle */}
          <div className="flex bg-slate-100 rounded-lg p-0.5 text-xs font-semibold flex-shrink-0">
            {['daily', 'weekly', 'monthly'].map((m) => (
              <button
                key={m}
                onClick={() => setViewMode(m)}
                className={`px-3 py-1.5 rounded-md capitalize transition-all ${
                  viewMode === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          <div className="w-px h-5 bg-slate-200 flex-shrink-0" />

          {/* Date nav */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={handlePrevious} className="p-1.5 hover:bg-slate-100 rounded-md transition-colors">
              <ChevronLeft className="w-4 h-4 text-slate-500" />
            </button>

            <div className="w-[216px] flex items-center justify-center">
              {viewMode === 'weekly' ? (
                <span className="text-sm font-medium text-slate-700 text-center w-full">{periodLabel}</span>
              ) : viewMode === 'monthly' ? (
                <input
                  type="month"
                  value={monthInputValue}
                  max={maxMonthValue}
                  onChange={(e) => {
                    const [y, mo] = e.target.value.split('-').map(Number);
                    setSelectedMonth(new Date(y, mo - 1, 1));
                  }}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent text-slate-700"
                />
              ) : (
                <input
                  type="date"
                  value={selectedDate || formatDateLocal(new Date())}
                  max={formatDateLocal(new Date())}
                  onChange={(e) => setSelectedDate(e.target.value || null)}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent text-slate-700"
                />
              )}
            </div>

            <button
              onClick={atCurrentPeriod ? undefined : handleNext}
              className={`p-1.5 rounded-md transition-colors ${atCurrentPeriod ? 'invisible' : 'hover:bg-slate-100'}`}
              tabIndex={atCurrentPeriod ? -1 : 0}
            >
              <ChevronRight className="w-4 h-4 text-slate-500" />
            </button>

            <button
              onClick={atCurrentPeriod ? undefined : handleToday}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors flex-shrink-0 ${
                atCurrentPeriod ? 'invisible' : 'bg-blue-600 hover:bg-blue-700 text-white'
              }`}
              tabIndex={atCurrentPeriod ? -1 : 0}
            >
              {viewMode === 'monthly' ? 'This Month' : viewMode === 'weekly' ? 'This Week' : 'Today'}
            </button>
          </div>

          <div className="w-px h-5 bg-slate-200 flex-shrink-0" />

          {/* View mode (rolling/combined) */}
          {isMultiDay && (
            <div className="flex bg-slate-100 rounded-lg p-0.5 text-[11px] font-semibold flex-shrink-0">
              {['rolling', 'combined'].map((m) => (
                <button
                  key={m}
                  onClick={() => setMergedViewMode(m)}
                  className={`px-2.5 py-1 rounded-md capitalize transition-all ${
                    mergedViewMode === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {m === 'rolling' ? 'Day by Day' : 'Combined'}
                </button>
              ))}
            </div>
          )}

          {/* Refresh */}
          <button
            onClick={fetchTimeline}
            disabled={isLoading}
            className={`p-1.5 hover:bg-slate-100 rounded-md transition-colors flex-shrink-0 ${isLoading ? 'opacity-50' : ''}`}
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 text-slate-500 ${isLoading ? 'animate-spin' : ''}`} />
          </button>

          {/* Stats — totals only (per-tech breakdown is in the sidebar) */}
          {totals && (
            <div className="flex items-center gap-2 text-xs flex-shrink-0">
              <span className="flex items-center gap-1 text-emerald-600 font-semibold">
                <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> Picked {totals.picked}
              </span>
              <span className="flex items-center gap-1 text-slate-400 font-semibold">
                <span className="w-2 h-2 rounded-full bg-slate-400 inline-block" /> Not picked {totals.notPicked}
              </span>
              {totals.hidden > 0 && <span className="text-slate-300">({totals.hidden} hidden)</span>}
            </div>
          )}
        </div>
      </header>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar — animated collapse */}
        <div
          className={`flex-shrink-0 border-r border-slate-200 bg-white transition-all duration-300 ease-in-out flex flex-col ${
            sidebarOpen ? 'w-64' : 'w-12'
          }`}
        >
          {/* Toggle button row */}
          <div className={`flex items-center flex-shrink-0 border-b border-slate-100 ${sidebarOpen ? 'justify-end px-3 py-1.5' : 'justify-center py-2'}`}>
            <button
              onClick={() => setSidebarOpen((o) => !o)}
              className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors text-slate-400 hover:text-slate-700"
              title={sidebarOpen ? 'Collapse panel' : 'Expand panel'}
            >
              {sidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
            </button>
          </div>
          {/* Content — fills remaining height, scrolls internally */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-1.5 py-2">
            <TechSelector
              techList={techList}
              selectedIds={selectedTechIds}
              onChange={setSelectedTechIds}
              accentMap={accentMap}
              perTech={totals?.perTech}
              isOpen={sidebarOpen}
              hiddenIds={hiddenTechIds}
              onToggleHidden={toggleHidden}
            />
          </div>
        </div>

        {/* Right: filter bar + timeline */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0 pr-4 py-4 gap-3">
          {/* Filter bar */}
          <div className="bg-white border border-slate-200 rounded-xl px-4 py-2.5 flex-shrink-0">
            <FilterBar
              allCategories={allCategories}
              excludeCats={excludeCats}
              setExcludeCats={setExcludeCats}
              excludeText={excludeText}
              setExcludeText={setExcludeText}
              includeCats={includeCats}
              setIncludeCats={setIncludeCats}
              includeText={includeText}
              setIncludeText={setIncludeText}
            />
          </div>

          {/* Timeline */}
          <div className="bg-white border border-slate-200 rounded-xl flex flex-col flex-1 overflow-hidden">
            {error && (
              <div className="p-6 text-center">
                <p className="text-red-500 text-sm">{error}</p>
                <button onClick={fetchTimeline} className="mt-2 text-xs text-blue-600 hover:underline">Retry</button>
              </div>
            )}

            {!error && !isLoading && selectedTechIds.size === 0 && (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <Layers className="w-10 h-10 text-slate-200 mx-auto mb-3" />
                  <p className="text-slate-400 text-sm font-medium">Select technicians to view their timeline</p>
                  <p className="text-slate-300 text-xs mt-1">Pick one or more from the panel on the left</p>
                </div>
              </div>
            )}

            {!error && selectedTechIds.size > 0 && (
              <TimelineCore
                timelineItems={timelineItems}
                defaultFirstName={techConfigs[0]?.firstName}
                onExcludeCategory={addExcludeCat}
                className="flex-1 overflow-y-auto px-5 py-3"
                emptyMessage="No tickets match the current filters."
                showFullDate={viewMode !== 'daily'}
              />
            )}

            {/* Footer legend */}
            {techConfigs.length > 0 && (
              <div className="px-5 py-2.5 border-t border-slate-100 flex-shrink-0">
                <TimelineLegend techConfigs={techConfigs} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
