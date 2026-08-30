import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams, Link } from 'react-router-dom';
import {
  Layers, Hand, CheckCircle2, Inbox, RotateCcw, Star, X, ArrowRight,
  MapPin, Clock,
} from 'lucide-react';
import { useDashboard } from '../contexts/DashboardContext';
import { dashboardAPI } from '../services/api';
import { getTicketCategoryLabel } from '../utils/ticketFilter';
import TechDetailHeader from '../components/tech-detail/TechDetailHeader';
import ActivityHeatmap from '../components/tech-detail/ActivityHeatmap';
import DayEventStrip from '../components/tech-detail/DayEventStrip';
import EvidenceTable from '../components/tech-detail/EvidenceTable';
import SatisfactionPanel, { mergeSatisfaction } from '../components/tech-detail/SatisfactionPanel';
import BouncedTab from '../components/tech-detail/BouncedTab';
import { getInitials, formatDateLocal } from '../components/tech-detail/utils';

// ─────────────────────────────────────────────────────────────────────────────
// Technician detail — hybrid rebuild (plan: C skeleton + A drillable chips +
// B heatmap). Left rail = who they are + period-scoped stat chips that filter
// the evidence table; main column = drill-context chip, activity heatmap,
// daily event strip, the evidence table, and one merged Satisfaction panel.
// The old Overview/Tickets/Coverage/CSAT/Feedback tabs are gone; Coverage is
// now a deep link into the real Timeline Explorer (?techId=), and the Bounced
// drill-in lives on as a stat chip (the ?tab=bounced URL contract still works).
//
// Badge/count integrity rule: every number shown here is scoped to the
// selected period — the number you clicked on the dashboard is the number
// you land on.
// ─────────────────────────────────────────────────────────────────────────────

export default function TechnicianDetailNew() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [, setSearchParams] = useSearchParams();
  const { getTechnicianCSAT } = useDashboard();

  // ── State ──────────────────────────────────────────────────────────────────

  const [technician, setTechnician] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const fetchSeqRef = useRef(0);
  const [error, setError] = useState(null);

  // Active stat chip — the evidence filter. Canonical param is ?bucket=<chip>
  // (written by the URL round-trip effect below); the legacy ?tab=bounced deep
  // link (dashboard Rej badges + other pages still build that URL) keeps working.
  const [activeChip, setActiveChip] = useState(() => {
    const params = new URLSearchParams(location.search);
    const bucket = params.get('bucket');
    if (['handled', 'closed', 'open', 'self', 'bounced', 'satisfaction'].includes(bucket)) return bucket;
    const tab = params.get('tab');
    if (tab === 'bounced') return 'bounced';
    if (tab === 'csat' || tab === 'feedback') return 'satisfaction';
    return 'handled';
  });

  // CSAT (FreshService surveys, usually /4)
  const [csatTickets, setCSATTickets] = useState([]);
  const [csatLoading, setCSATLoading] = useState(false);

  // First-party feedback (Ticket Pulse, /5)
  const [feedbackTickets, setFeedbackTickets] = useState([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);

  // Activity heatmap data (one fetch per tech — the only new request)
  const [calendarDays, setCalendarDays] = useState([]);
  const [calendarLoading, setCalendarLoading] = useState(true);

  // Drill context from the dashboard (location.state travels with the click)
  const [drillDismissed, setDrillDismissed] = useState(false);
  const drillContext = !drillDismissed && (location.state?.techSummary || location.state?.selectedDate)
    ? location.state
    : null;

  // Dashboard round-trip filters (no UI here anymore, but the Back button
  // returns them so the dashboard restores its own search/category state).
  const returnFiltersRef = useRef({
    searchTerm: location.state?.searchTerm || '',
    selectedCategories: location.state?.selectedCategories || [],
    canonicalCategoryFilter: location.state?.canonicalCategoryFilter || { categoryIds: [], subcategoryIds: [] },
  });

  // Parse URL query params on mount — deep-link bootstrap. Two contracts:
  //  • canonical (Back round-trip): ?view=daily|weekly|monthly&date=YYYY-MM-DD
  //  • legacy (dashboard Rej badge): ?range=day|week|month&start=YYYY-MM-DD
  // Either half may arrive alone: a bare view means "current period in that
  // view"; a bare date means "that day, daily view".
  const urlParamsOnMount = useMemo(() => {
    const p = new URLSearchParams(location.search);
    const viewParam = p.get('view');
    const range = p.get('range');
    const view = ['daily', 'weekly', 'monthly'].includes(viewParam)
      ? viewParam
      : range === 'day' ? 'daily'
        : range === 'week' ? 'weekly'
          : range === 'month' ? 'monthly'
            : null;
    const rawDate = p.get('date') || p.get('start');
    let startDate = null;
    if (rawDate) {
      const d = new Date(rawDate + 'T12:00:00');
      if (!Number.isNaN(d.getTime())) startDate = d;
    }
    if (!view && !startDate) return null;
    return { view: view || 'daily', startDate };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Date / week / month state. Priority: URL deep-link > location.state > defaults.
  const [selectedDate, setSelectedDate] = useState(() => {
    if (urlParamsOnMount?.view === 'daily' && urlParamsOnMount.startDate) {
      const str = formatDateLocal(urlParamsOnMount.startDate);
      // null = today (the page's "live" default) — keep that invariant.
      return str === formatDateLocal(new Date()) ? null : str;
    }
    const passedDate = location.state?.selectedDate;
    if (!passedDate) return null;
    const isCurrentDay = new Date(passedDate).toDateString() === new Date().toDateString();
    if (isCurrentDay) return null;
    return formatDateLocal(new Date(passedDate));
  });

  const initialViewMode = urlParamsOnMount?.view || location.state?.viewMode || 'daily';

  const [viewMode, setViewMode] = useState(initialViewMode);
  const originViewModeRef = useRef(initialViewMode);

  const [selectedWeek, setSelectedWeek] = useState(() => {
    if (urlParamsOnMount?.view === 'weekly' && urlParamsOnMount.startDate) {
      return urlParamsOnMount.startDate;
    }
    const nav = location.state?.selectedWeek;
    if (nav) return nav;
    if (initialViewMode === 'weekly') {
      const now = new Date();
      const day = (now.getDay() + 6) % 7;
      const monday = new Date(now);
      monday.setDate(now.getDate() - day);
      monday.setHours(0, 0, 0, 0);
      return monday;
    }
    return null;
  });

  // selectedMonth: Date representing the 1st of the selected month
  const [selectedMonth, setSelectedMonth] = useState(() => {
    if (urlParamsOnMount?.view === 'monthly' && urlParamsOnMount.startDate) {
      const d = urlParamsOnMount.startDate;
      return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0);
    }
    const nav = location.state?.selectedMonth;
    if (nav) return new Date(nav);
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
  });

  const satisfactionRef = useRef(null);

  // ── Effects ────────────────────────────────────────────────────────────────

  // URL round-trip: reflect the selected period + active chip into the query
  // string (?view=&date=&bucket=, replace:true so history doesn't spam). Every
  // ticket link on this page builds its Back address from location.pathname +
  // location.search, so the ticket page's Back control restores this exact
  // view. Defaults are omitted to keep URLs clean (no params = today, daily,
  // handled); the legacy range/start/end/tab deep-link params are consumed by
  // the mount bootstrap above and dropped here. location.state (dashboard
  // drill context) is re-attached so the replace doesn't lose the drill chip.
  useEffect(() => {
    const next = new URLSearchParams(location.search);
    ['range', 'start', 'end', 'tab'].forEach((k) => next.delete(k));
    if (viewMode !== 'daily') next.set('view', viewMode);
    else next.delete('view');
    const dateStr = viewMode === 'weekly'
      ? (selectedWeek ? formatDateLocal(new Date(selectedWeek)) : null)
      : viewMode === 'monthly'
        ? (selectedMonth ? formatDateLocal(selectedMonth) : null)
        : (selectedDate || null);
    if (dateStr) next.set('date', dateStr);
    else next.delete('date');
    if (activeChip !== 'handled') next.set('bucket', activeChip);
    else next.delete('bucket');
    if (next.toString() !== new URLSearchParams(location.search).toString()) {
      setSearchParams(next, { replace: true, state: location.state });
    }
  }, [viewMode, selectedDate, selectedWeek, selectedMonth, activeChip, location.search, location.state, setSearchParams]);

  // Fetch CSAT
  useEffect(() => {
    if (!id) return;
    setCSATLoading(true);
    getTechnicianCSAT(parseInt(id, 10))
      .then((response) => {
        const data = response?.data || response;
        setCSATTickets(data?.csatTickets || []);
      })
      .catch((e) => console.error('Failed to fetch CSAT data:', e))
      .finally(() => setCSATLoading(false));
  }, [id, getTechnicianCSAT]);

  // Fetch first-party feedback
  useEffect(() => {
    if (!id) return;
    setFeedbackLoading(true);
    dashboardAPI.getTechnicianFeedback(parseInt(id, 10))
      .then((response) => {
        setFeedbackTickets(response?.data?.feedbackTickets || []);
      })
      .catch((e) => console.error('Failed to fetch feedback data:', e))
      .finally(() => setFeedbackLoading(false));
  }, [id]);

  // Fetch heatmap calendar (365 days, once per tech)
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setCalendarLoading(true);
    dashboardAPI.getTechnicianActivityCalendar(parseInt(id, 10), 365)
      .then((response) => {
        if (!cancelled) setCalendarDays(response?.data?.days || []);
      })
      .catch((e) => console.error('Failed to fetch activity calendar:', e))
      .finally(() => { if (!cancelled) setCalendarLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  // Fetch technician data per period
  useEffect(() => {
    const mySeq = ++fetchSeqRef.current;
    setIsLoading(true);
    // Keep stale data visible during navigation so the layout never flashes.
    setError(null);

    const fetchData = async () => {
      try {
        let data;
        if (viewMode === 'weekly') {
          const weekStart = selectedWeek ? formatDateLocal(selectedWeek) : null;
          const res = await dashboardAPI.getTechnicianWeekly(parseInt(id, 10), weekStart, 'America/Los_Angeles');
          if (!res.success || !res.data) throw new Error('Failed to fetch weekly technician data');
          data = res.data;
        } else if (viewMode === 'monthly') {
          const monthStr = selectedMonth
            ? `${selectedMonth.getFullYear()}-${String(selectedMonth.getMonth() + 1).padStart(2, '0')}`
            : null;
          const res = await dashboardAPI.getTechnicianMonthly(parseInt(id, 10), monthStr, 'America/Los_Angeles');
          if (!res.success || !res.data) throw new Error('Failed to fetch monthly technician data');
          data = res.data;
        } else {
          const dateStr = selectedDate
            ? (typeof selectedDate === 'string' ? selectedDate : formatDateLocal(selectedDate))
            : null;
          const res = await dashboardAPI.getTechnician(parseInt(id, 10), 'America/Los_Angeles', dateStr);
          if (!res.success || !res.data) throw new Error('Failed to fetch technician data');
          data = res.data;
        }
        if (mySeq !== fetchSeqRef.current) return;
        setTechnician(data);
      } catch (err) {
        if (mySeq !== fetchSeqRef.current) return;
        console.error('Error fetching technician:', err);
        setError(err.message);
      } finally {
        if (mySeq === fetchSeqRef.current) setIsLoading(false);
      }
    };
    fetchData();
  }, [id, selectedDate, viewMode, selectedWeek, selectedMonth]);

  // ── Navigation handlers ────────────────────────────────────────────────────

  const handleBack = () => {
    navigate('/dashboard', {
      state: {
        viewMode: location.state?.returnViewMode || originViewModeRef.current,
        returnDate: selectedDate || formatDateLocal(new Date()),
        returnWeek: selectedWeek ? formatDateLocal(selectedWeek) : null,
        ...returnFiltersRef.current,
      },
    });
  };

  const handlePrevious = () => {
    if (viewMode === 'weekly') {
      const cur = selectedWeek || new Date();
      const prev = new Date(cur);
      prev.setDate(cur.getDate() - 7);
      setSelectedWeek(prev);
    } else if (viewMode === 'monthly') {
      const cur = selectedMonth || new Date();
      setSelectedMonth(new Date(cur.getFullYear(), cur.getMonth() - 1, 1, 0, 0, 0));
    } else {
      const cur = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();
      cur.setDate(cur.getDate() - 1);
      setSelectedDate(formatDateLocal(cur));
    }
  };

  const isToday = !selectedDate;

  const handleNext = () => {
    const now = new Date();
    if (viewMode === 'weekly') {
      const todayStr = formatDateLocal(now);
      const cur = selectedWeek || now;
      const next = new Date(cur);
      next.setDate(cur.getDate() + 7);
      if (formatDateLocal(next) <= todayStr) {
        setSelectedWeek(next);
      }
    } else if (viewMode === 'monthly') {
      const cur = selectedMonth || now;
      const next = new Date(cur.getFullYear(), cur.getMonth() + 1, 1, 0, 0, 0);
      const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
      if (next <= currentMonthStart) {
        setSelectedMonth(next);
      }
    } else {
      const todayStr = formatDateLocal(now);
      if (isToday) return;
      const cur = new Date(selectedDate + 'T12:00:00');
      cur.setDate(cur.getDate() + 1);
      const nextStr = formatDateLocal(cur);
      if (nextStr <= todayStr) {
        setSelectedDate(nextStr);
      } else {
        setSelectedDate(null);
      }
    }
  };

  const handleToday = () => {
    if (viewMode === 'weekly') {
      const now = new Date();
      const day = (now.getDay() + 6) % 7;
      const monday = new Date(now);
      monday.setDate(now.getDate() - day);
      monday.setHours(0, 0, 0, 0);
      setSelectedWeek(monday);
    } else if (viewMode === 'monthly') {
      const now = new Date();
      setSelectedMonth(new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0));
    } else {
      setSelectedDate(null);
    }
  };

  const handleDateChange = (e) => {
    if (e.target.value) setSelectedDate(e.target.value);
  };

  // Heatmap day click → rescope the page to that day (daily view)
  const handleSelectDay = useCallback((dateStr) => {
    setViewMode('daily');
    setSelectedDate(dateStr === formatDateLocal(new Date()) ? null : dateStr);
  }, []);

  const handleChipClick = (key) => {
    setActiveChip(key);
    if (key === 'satisfaction' && satisfactionRef.current) {
      const reduce = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      satisfactionRef.current.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    }
  };

  // ── Loading / error states ─────────────────────────────────────────────────

  if (!technician) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/50">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 motion-reduce:animate-none" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/50">
        <div className="bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-xl p-5 max-w-sm">
          <p className="text-red-700 dark:text-red-200 text-sm mb-3">{error}</p>
          <button
            onClick={handleBack}
            className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg text-sm font-medium"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  // ── Derived data (ALL period-scoped — the badge-integrity rule) ────────────

  const displayDate = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();

  const isCurrentWeek = viewMode === 'weekly' && selectedWeek ? (() => {
    const now = new Date();
    const day = (now.getDay() + 6) % 7;
    const mon = new Date(now);
    mon.setDate(now.getDate() - day);
    mon.setHours(0, 0, 0, 0);
    const sel = new Date(selectedWeek);
    sel.setHours(0, 0, 0, 0);
    return sel.getTime() === mon.getTime();
  })() : false;

  const isCurrentMonth = viewMode === 'monthly' && selectedMonth ? (() => {
    const now = new Date();
    return selectedMonth.getFullYear() === now.getFullYear() &&
      selectedMonth.getMonth() === now.getMonth();
  })() : false;

  const monthLabel = viewMode === 'monthly' && selectedMonth
    ? selectedMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Human label for the selected period ("Mon, Jul 27" / "Jul 21 – Jul 27" / "July 2026")
  const periodLabel = viewMode === 'weekly'
    ? (() => {
      const ws = technician.weekStart
        ? new Date(technician.weekStart + 'T12:00:00')
        : selectedWeek ? new Date(selectedWeek) : new Date();
      const we = new Date(ws);
      we.setDate(ws.getDate() + 6);
      return `${ws.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${we.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    })()
    : viewMode === 'monthly'
      ? monthLabel
      : displayDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  // Period-scoped ticket sets (the evidence behind each chip)
  const isRange = viewMode === 'weekly' || viewMode === 'monthly';
  const handledTickets = viewMode === 'weekly'
    ? (technician.weeklyTickets || [])
    : viewMode === 'monthly'
      ? (technician.monthlyTickets || [])
      : (technician.ticketsOnDate || []);
  const closedTickets = isRange
    ? (technician.closedTickets || [])
    : (technician.closedTicketsOnDate || []);
  const selfPickedTickets = technician.selfPickedTickets || [];
  const openTickets = technician.openTickets || [];

  const openCount = openTickets.filter((t) => t.status === 'Open').length;
  const pendingCount = openTickets.filter((t) => t.status === 'Pending').length;
  const handledCount = viewMode === 'weekly'
    ? (technician.weeklyTotalCreated ?? handledTickets.length)
    : viewMode === 'monthly'
      ? (technician.monthlyTotalCreated ?? handledTickets.length)
      : (technician.totalTicketsOnDate ?? handledTickets.length);
  const closedCount = viewMode === 'weekly'
    ? (technician.weeklyClosed ?? closedTickets.length)
    : viewMode === 'monthly'
      ? (technician.monthlyClosed ?? closedTickets.length)
      : (technician.closedTicketsOnDateCount ?? closedTickets.length);
  const selfPickedCount = viewMode === 'weekly'
    ? (technician.weeklySelfPicked ?? selfPickedTickets.length)
    : viewMode === 'monthly'
      ? (technician.monthlySelfPicked ?? selfPickedTickets.length)
      : (technician.selfPickedOnDate ?? selfPickedTickets.length);
  const bouncedCount = technician.rejectedThisPeriod || 0;
  const bouncedLifetime = technician.rejectedLifetime || 0;

  const satisfaction = mergeSatisfaction(csatTickets, feedbackTickets);

  // All tickets for the export menu (unchanged contract)
  const allTickets = [...selfPickedTickets, ...(technician.assignedTickets || []), ...closedTickets, ...openTickets];

  // Category mix: top 3 over the period's handled set
  const categoryMix = (() => {
    const map = {};
    handledTickets.forEach((t) => {
      const cat = getTicketCategoryLabel(t) || 'Uncategorized';
      map[cat] = (map[cat] || 0) + 1;
    });
    const total = handledTickets.length;
    return Object.entries(map)
      .map(([label, count]) => ({ label, count, pct: total ? Math.round((count / total) * 100) : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
  })();

  const loadTone = openCount >= 10
    ? { text: 'Heavy load', cls: 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200' }
    : openCount >= 5
      ? { text: 'Medium load', cls: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200' }
      : { text: 'Light load', cls: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200' };

  // Stat chip definitions — every one scoped to the selected period
  const chips = [
    {
      key: 'handled', label: `Handled · ${viewMode === 'daily' ? (isToday ? 'today' : periodLabel) : periodLabel}`,
      value: handledCount, tone: 'text-indigo-600 dark:text-indigo-300', Icon: Layers,
      sub: `${selfPickedCount} self · ${handledCount - selfPickedCount} routed`,
    },
    {
      key: 'closed', label: 'Closed',
      value: closedCount, tone: 'text-emerald-600 dark:text-emerald-300', Icon: CheckCircle2,
      sub: handledCount > 0 ? `${Math.round((closedCount / handledCount) * 100)}% of handled` : null,
    },
    {
      key: 'open', label: 'Open now',
      value: openCount, tone: 'text-amber-600 dark:text-amber-300', Icon: Inbox,
      valueSuffix: pendingCount > 0 ? `+${pendingCount} pending` : null,
      sub: 'live snapshot, not period-scoped',
    },
    {
      key: 'self', label: 'Self-picked',
      value: selfPickedCount, tone: 'text-violet-600 dark:text-violet-300', Icon: Hand,
      sub: handledCount > 0 ? `${Math.round((selfPickedCount / handledCount) * 100)}% of handled` : null,
    },
    {
      key: 'bounced', label: 'Bounced',
      value: bouncedCount, tone: bouncedCount > 0 ? 'text-red-600 dark:text-red-300' : 'text-muted-foreground/75', Icon: RotateCcw,
      sub: bouncedLifetime > 0 ? `${bouncedLifetime} lifetime` : null,
    },
    {
      key: 'satisfaction', label: 'Satisfaction',
      value: satisfaction.count > 0 ? satisfaction.average.toFixed(1) : '—',
      valueSuffix: satisfaction.count > 0 ? '/5' : null,
      tone: 'text-emerald-600 dark:text-emerald-300', Icon: Star,
      sub: `${satisfaction.count} response${satisfaction.count === 1 ? '' : 's'} · FS + TP merged`,
    },
  ];

  // Evidence set + title for the active chip
  const evidence = {
    handled: { tickets: handledTickets, verb: 'Handled' },
    closed: { tickets: closedTickets, verb: 'Closed' },
    open: { tickets: openTickets, verb: 'Open right now' },
    self: { tickets: selfPickedTickets, verb: 'Self-picked' },
    satisfaction: { tickets: handledTickets, verb: 'Handled' },
  }[activeChip === 'bounced' ? 'handled' : activeChip] || { tickets: handledTickets, verb: 'Handled' };

  const evidenceTitle = activeChip === 'open'
    ? `Open right now · ${openCount + pendingCount} ticket${openCount + pendingCount === 1 ? '' : 's'}`
    : `${evidence.verb} on ${periodLabel} · ${evidence.tickets.length} ticket${evidence.tickets.length === 1 ? '' : 's'}`;

  const dayIso = viewMode === 'daily'
    ? (selectedDate || formatDateLocal(new Date()))
    : null;

  const timezoneLabel = technician.timezone ? technician.timezone.replace(/_/g, ' ') : null;
  const techLocation = technician.location ||
    (technician.timezone ? technician.timezone.split('/').pop().replace(/_/g, ' ') : null);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-muted/50">
      {/* Thin progress bar while re-fetching (navigation between periods) */}
      {isLoading && (
        <div className="fixed top-0 left-0 right-0 z-50 h-0.5 bg-blue-100 dark:bg-blue-500/20 overflow-hidden">
          <div className="h-full bg-blue-500 animate-pulse w-full motion-reduce:animate-none" />
        </div>
      )}

      <TechDetailHeader
        technician={technician}
        viewMode={viewMode}
        setViewMode={setViewMode}
        selectedDate={selectedDate}
        setSelectedDate={setSelectedDate}
        selectedWeek={selectedWeek}
        setSelectedWeek={setSelectedWeek}
        selectedMonth={selectedMonth}
        setSelectedMonth={setSelectedMonth}
        allTickets={allTickets}
        onBack={handleBack}
        onPrevious={handlePrevious}
        onNext={handleNext}
        onToday={handleToday}
        onDateChange={handleDateChange}
        isToday={isToday}
        isCurrentWeek={isCurrentWeek}
        isCurrentMonth={isCurrentMonth}
        monthLabel={monthLabel}
      />

      <main className="mx-auto grid max-w-7xl grid-cols-1 gap-4 px-3 py-4 sm:px-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* ── LEFT RAIL ─────────────────────────────────────────────────────── */}
        <aside className="space-y-3 self-start lg:sticky lg:top-[72px]">
          {/* Profile card */}
          <div className="tp-card rounded-xl p-3">
            <div className="flex items-center gap-3">
              {technician.photoUrl ? (
                <img
                  src={technician.photoUrl}
                  alt={technician.name}
                  className="h-12 w-12 flex-shrink-0 rounded-full border border-border object-cover"
                />
              ) : (
                <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600">
                  <span className="text-sm font-bold text-white">{getInitials(technician.name)}</span>
                </div>
              )}
              <div className="min-w-0">
                <div className="truncate text-sm font-bold text-foreground">{technician.name}</div>
                <span className={`mt-0.5 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${loadTone.cls}`}>
                  {loadTone.text}
                </span>
              </div>
            </div>
            <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
              {techLocation && (
                <div className="flex items-center gap-1.5">
                  <MapPin className="h-3 w-3 text-muted-foreground/75" aria-hidden="true" />
                  <span className="truncate">{techLocation}</span>
                </div>
              )}
              {timezoneLabel && (
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3 w-3 text-muted-foreground/75" aria-hidden="true" />
                  <span className="truncate">
                    {timezoneLabel}
                    {(technician.workStartTime || technician.workEndTime) &&
                      ` · ${technician.workStartTime || '??'}–${technician.workEndTime || '??'}`}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Stat chips — click = filter the evidence table (A mechanics) */}
          <nav className="tp-card rounded-xl p-1.5" aria-label="Period stats">
            <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/75">
              {periodLabel}
            </div>
            <div className="space-y-0.5">
              {chips.map(({ key, label, value, valueSuffix, sub, tone, Icon }) => {
                const active = activeChip === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleChipClick(key)}
                    aria-pressed={active}
                    aria-label={`${label}: ${value}${valueSuffix ? ` ${valueSuffix}` : ''}`}
                    className={`tp-focus-ring flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                      active ? 'bg-blue-50 dark:bg-blue-500/15 ring-1 ring-blue-200 dark:ring-blue-500/30' : 'hover:bg-muted/50'
                    }`}
                  >
                    <Icon className={`h-4 w-4 flex-shrink-0 ${active ? 'text-blue-600 dark:text-blue-300' : 'text-muted-foreground/50'}`} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-medium text-muted-foreground">{label}</span>
                      {sub && <span className="block truncate text-[10px] text-muted-foreground/75">{sub}</span>}
                    </span>
                    <span className={`flex-shrink-0 text-lg font-extrabold tabular-nums ${tone}`}>
                      {value}
                      {valueSuffix && <span className="ml-0.5 text-[10px] font-semibold text-muted-foreground/75">{valueSuffix}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </nav>

          {/* Category mix — top 3 with % bars */}
          {categoryMix.length > 0 && (
            <div className="tp-card rounded-xl p-3">
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/75">
                Category mix · {periodLabel}
              </h3>
              <div className="space-y-1.5">
                {categoryMix.map((c, idx) => (
                  <div key={c.label} className="flex items-center gap-2 text-[11px]">
                    <span className="w-24 truncate text-muted-foreground" title={c.label}>{c.label}</span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className={`block h-full rounded-full ${['bg-sky-500', 'bg-indigo-400', 'bg-muted-foreground/40'][idx]}`}
                        style={{ width: `${Math.max(c.pct, 3)}%` }}
                      />
                    </span>
                    <span className="w-8 text-right font-bold tabular-nums text-foreground/85">{c.pct}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Timeline Explorer deep link — replaces the old Coverage tab */}
          <Link
            to={`/timeline?techId=${id}`}
            className="tp-focus-ring group flex items-center justify-between rounded-xl border border-border bg-card px-3 py-2.5 text-sm font-semibold text-blue-700 dark:text-blue-200 shadow-subtle transition-colors hover:border-blue-200 dark:hover:border-blue-500/30 hover:bg-blue-50 dark:hover:bg-blue-500/15"
          >
            <span className="inline-flex items-center gap-2">
              <Layers className="h-4 w-4" aria-hidden="true" />
              Open in Timeline Explorer
            </span>
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
          </Link>
        </aside>

        {/* ── MAIN COLUMN ───────────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-4">
          {/* Drill-context chip — the dashboard click travels with you */}
          {drillContext && (
            <div className="flex items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 px-2.5 py-1 font-semibold text-blue-700 dark:text-blue-200">
                Arrived from Dashboard:
                <b>{handledCount} handled on {periodLabel}</b>
                <button
                  type="button"
                  onClick={() => setDrillDismissed(true)}
                  aria-label="Dismiss drill context"
                  className="tp-focus-ring ml-0.5 rounded-full opacity-60 hover:opacity-100"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </span>
            </div>
          )}

          {/* Activity heatmap */}
          <ActivityHeatmap
            days={calendarDays}
            viewMode={viewMode}
            selectedDate={selectedDate}
            selectedWeek={selectedWeek}
            selectedMonth={selectedMonth}
            onSelectDay={handleSelectDay}
            isLoading={calendarLoading}
          />

          {/* Daily only: event-marker strip (weekly+ hides it entirely) */}
          {viewMode === 'daily' && (
            <DayEventStrip
              ticketsOnDate={handledTickets}
              dayLabel={periodLabel}
              dayIso={dayIso}
            />
          )}

          {/* Evidence: bounced drill-in keeps its dedicated table; every other
              chip filters the one ticket table */}
          {activeChip === 'bounced' ? (
            <section className="tp-card rounded-xl p-4" aria-label="Bounced tickets">
              <BouncedTab
                technician={technician}
                viewMode={viewMode}
                selectedDate={selectedDate}
                selectedWeek={selectedWeek}
                selectedMonth={selectedMonth}
              />
            </section>
          ) : (
            <EvidenceTable
              tickets={evidence.tickets}
              chipKey={activeChip === 'satisfaction' ? 'handled' : activeChip}
              title={evidenceTitle}
            />
          )}

          {/* Merged Satisfaction panel (CSAT + first-party feedback, /5) */}
          <SatisfactionPanel
            ref={satisfactionRef}
            csatTickets={csatTickets}
            feedbackTickets={feedbackTickets}
            isLoading={csatLoading || feedbackLoading}
            highlighted={activeChip === 'satisfaction'}
          />
        </div>
      </main>
    </div>
  );
}
