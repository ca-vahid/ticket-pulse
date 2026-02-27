import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useDashboard } from '../contexts/DashboardContext';
import { dashboardAPI } from '../services/api';
import SearchBox from '../components/SearchBox';
import CategoryFilter from '../components/CategoryFilter';
import { filterTickets, getAvailableCategories } from '../utils/ticketFilter';
import TechDetailHeader from '../components/tech-detail/TechDetailHeader';
import MetricsRibbon from '../components/tech-detail/MetricsRibbon';
import OverviewTab from '../components/tech-detail/OverviewTab';
import TicketBoardTab from '../components/tech-detail/TicketBoardTab';
import CoverageTab from '../components/tech-detail/CoverageTab';
import CSATTab from '../components/tech-detail/CSATTab';
import { formatDateLocal } from '../components/tech-detail/utils';

// ── Constants ─────────────────────────────────────────────────────────────────

const PRIMARY_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'tickets',  label: 'Tickets' },
  { id: 'coverage', label: 'Coverage' },
  { id: 'csat',     label: 'CSAT' },
];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TechnicianDetailNew() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { getTechnicianCSAT } = useDashboard();

  // ── State ──────────────────────────────────────────────────────────────────

  const [technician, setTechnician] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const fetchSeqRef = useRef(0);
  const [error, setError] = useState(null);

  // Primary tab: overview | tickets | coverage | csat
  const [activeTab, setActiveTab] = useState('overview');
  // Ticket board sub-view: all | self | assigned | closed
  const [ticketView, setTicketView] = useState('all');

  // CSAT
  const [csatTickets, setCSATTickets] = useState([]);
  const [csatLoading, setCSATLoading] = useState(false);
  const [csatCount, setCSATCount] = useState(0);
  const [csatAverage, setCSATAverage] = useState(null);

  // Search – persisted in sessionStorage
  const [searchTerm, setSearchTerm] = useState(() => {
    const nav = location.state?.searchTerm;
    if (nav !== undefined) return nav;
    return sessionStorage.getItem('techDetailNew_search') || '';
  });

  // Category filter – persisted in sessionStorage
  const [selectedCategories, setSelectedCategories] = useState(() => {
    const nav = location.state?.selectedCategories;
    if (nav !== undefined) return nav;
    const stored = sessionStorage.getItem('techDetailNew_categories');
    return stored ? JSON.parse(stored) : [];
  });

  // Date / week / month state
  const [selectedDate, setSelectedDate] = useState(() => {
    const passedDate = location.state?.selectedDate;
    if (!passedDate) return null;
    const isCurrentDay = new Date(passedDate).toDateString() === new Date().toDateString();
    if (isCurrentDay) return null;
    return formatDateLocal(new Date(passedDate));
  });

  const [viewMode, setViewMode] = useState(location.state?.viewMode || 'daily');
  const originViewModeRef = useRef(location.state?.viewMode || 'daily');

  const [selectedWeek, setSelectedWeek] = useState(() => {
    const nav = location.state?.selectedWeek;
    if (nav) return nav;
    if (location.state?.viewMode === 'weekly') {
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
    const nav = location.state?.selectedMonth;
    if (nav) return new Date(nav);
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
  });

  // ── Effects ────────────────────────────────────────────────────────────────

  // Fetch CSAT
  useEffect(() => {
    if (!id) return;
    setCSATLoading(true);
    getTechnicianCSAT(parseInt(id, 10))
      .then((response) => {
        const data = response?.data || response;
        const tickets = data?.csatTickets || [];
        const avg = data?.averageScore ? parseFloat(data.averageScore) : null;
        setCSATTickets(tickets);
        setCSATCount(tickets.length);
        setCSATAverage(avg);
      })
      .catch((e) => console.error('Failed to fetch CSAT data:', e))
      .finally(() => setCSATLoading(false));
  }, [id, getTechnicianCSAT]);

  // Fetch technician data
  useEffect(() => {
    const mySeq = ++fetchSeqRef.current;
    setIsLoading(true);
    // Don't null out technician — keep stale data visible during navigation
    // so child component state (e.g. showMergedTimeline) is never lost
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

  // Persist search/filter
  useEffect(() => { sessionStorage.setItem('techDetailNew_search', searchTerm); }, [searchTerm]);
  useEffect(() => { sessionStorage.setItem('techDetailNew_categories', JSON.stringify(selectedCategories)); }, [selectedCategories]);

  // ── Navigation handlers ────────────────────────────────────────────────────

  const handleBack = () => {
    navigate('/dashboard', {
      state: {
        viewMode: location.state?.returnViewMode || originViewModeRef.current,
        returnDate: selectedDate || formatDateLocal(new Date()),
        returnWeek: selectedWeek ? formatDateLocal(selectedWeek) : null,
        searchTerm,
        selectedCategories,
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
      const prev = new Date(cur.getFullYear(), cur.getMonth() - 1, 1, 0, 0, 0);
      setSelectedMonth(prev);
    } else {
      const cur = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();
      cur.setDate(cur.getDate() - 1);
      setSelectedDate(formatDateLocal(cur));
    }
  };

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

  // ── Loading / error states ─────────────────────────────────────────────────

  // Full-page spinner only on the very first load (no technician data yet).
  // During date/week navigation we keep stale data visible so child state
  // (showMergedTimeline, etc.) is never torn down. isLoading is used below
  // for a subtle header indicator instead.
  if (!technician) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="bg-red-50 border border-red-200 rounded-xl p-5 max-w-sm">
          <p className="text-red-700 text-sm mb-3">{error}</p>
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

  // ── Derived data ───────────────────────────────────────────────────────────

  const isToday = !selectedDate;
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

  const weekRangeLabel = viewMode === 'weekly' && selectedWeek ? (() => {
    if (isCurrentWeek) return 'This Week';
    const ws = new Date(selectedWeek);
    const we = new Date(selectedWeek);
    we.setDate(ws.getDate() + 6);
    return `${ws.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${we.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  })() : 'This Week';

  const monthLabel = viewMode === 'monthly' && selectedMonth
    ? selectedMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Ticket arrays
  const selfPickedTickets = technician.selfPickedTickets || [];
  const assignedTickets   = technician.assignedTickets || [];
  const closedTickets     = (viewMode === 'weekly' || viewMode === 'monthly')
    ? (technician.closedTickets || [])
    : (technician.closedTicketsOnDate || []);
  const allOpenTickets    = technician.openTickets || [];

  const isFiltering = searchTerm || selectedCategories.length > 0;

  let openCount, pendingCount, selfPickedCount, assignedCount, closedCount;
  if (isFiltering) {
    const fOpen     = filterTickets(allOpenTickets, searchTerm, selectedCategories);
    const fSelf     = filterTickets(selfPickedTickets, searchTerm, selectedCategories);
    const fAssigned = filterTickets(assignedTickets, searchTerm, selectedCategories);
    const fClosed   = filterTickets(closedTickets, searchTerm, selectedCategories);
    openCount      = fOpen.filter((t) => t.status === 'Open').length;
    pendingCount   = fOpen.filter((t) => t.status === 'Pending').length;
    selfPickedCount = fSelf.length;
    assignedCount  = fAssigned.length;
    closedCount    = fClosed.length;
  } else {
    openCount      = allOpenTickets.filter((t) => t.status === 'Open').length;
    pendingCount   = allOpenTickets.filter((t) => t.status === 'Pending').length;
    if (viewMode === 'weekly') {
      selfPickedCount = technician.weeklySelfPicked || 0;
      assignedCount   = technician.weeklyAssigned || 0;
      closedCount     = technician.weeklyClosed || 0;
    } else if (viewMode === 'monthly') {
      selfPickedCount = technician.monthlySelfPicked || 0;
      assignedCount   = technician.monthlyAssigned || 0;
      closedCount     = technician.monthlyClosed || 0;
    } else {
      selfPickedCount = technician.selfPickedOnDate || 0;
      assignedCount   = technician.assignedOnDate || 0;
      closedCount     = technician.closedTicketsOnDateCount || 0;
    }
  }

  // Tickets for the board tab, based on ticketView
  const boardSource = {
    all:      [...allOpenTickets].sort((a, b) => {
      if (a.status === 'Open' && b.status === 'Pending') return -1;
      if (a.status === 'Pending' && b.status === 'Open') return 1;
      return 0;
    }),
    self:     selfPickedTickets,
    assigned: assignedTickets,
    closed:   closedTickets,
  };
  const displayedTickets = filterTickets(boardSource[ticketView] || [], searchTerm, selectedCategories);

  // All tickets for search category extraction + export
  const allTickets = [...selfPickedTickets, ...assignedTickets, ...closedTickets, ...allOpenTickets];
  const availableCategories = getAvailableCategories(allTickets);
  const searchResultsCount = isFiltering ? filterTickets(allTickets, searchTerm, selectedCategories).length : 0;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Thin progress bar while re-fetching (navigation between dates/weeks) */}
      {isLoading && (
        <div className="fixed top-0 left-0 right-0 z-50 h-0.5 bg-blue-100 overflow-hidden">
          <div className="h-full bg-blue-500 animate-pulse w-full" />
        </div>
      )}
      {/* Header */}
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

      <main className="max-w-7xl mx-auto px-6 py-4 space-y-4">
        {/* Primary tab bar */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {/* Tab navigation */}
          <div className="flex border-b border-slate-200 bg-slate-50/60">
            {PRIMARY_TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              const badge = tab.id === 'tickets' ? openCount + pendingCount
                : tab.id === 'csat' ? csatCount
                  : null;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-5 py-3 text-sm transition-all relative border-b-2 -mb-px ${
                    isActive
                      ? 'text-slate-900 font-semibold border-blue-600 bg-white'
                      : 'text-slate-400 font-medium border-transparent hover:text-slate-600 hover:bg-white/60'
                  }`}
                >
                  {tab.label}
                  {badge != null && badge > 0 && (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full transition-all ${
                      isActive
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-200 text-slate-500'
                    }`}>
                      {badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Tab content */}
          <div className={activeTab === 'overview' ? 'bg-slate-50/60 p-4' : 'p-4'}>
            {activeTab === 'overview' && (
              <OverviewTab
                technician={technician}
                viewMode={viewMode}
                selectedDate={selectedDate}
                selectedMonth={selectedMonth}
                openCount={openCount}
                pendingCount={pendingCount}
              />
            )}

            {activeTab === 'tickets' && (
              <div className="space-y-3">
                {/* Metrics ribbon — tickets-only context */}
                <MetricsRibbon
                  openCount={openCount}
                  pendingCount={pendingCount}
                  selfPickedCount={selfPickedCount}
                  assignedCount={assignedCount}
                  closedCount={closedCount}
                  csatCount={csatCount}
                  csatAverage={csatAverage}
                  viewMode={viewMode}
                  isToday={isToday}
                  displayDate={displayDate}
                  weekRangeLabel={weekRangeLabel}
                  monthLabel={monthLabel}
                />
                {/* Search + filter */}
                <div className="flex gap-2 items-start">
                  <SearchBox
                    value={searchTerm}
                    onChange={setSearchTerm}
                    placeholder="Search tickets… (use OR or | for alternatives)"
                    resultsCount={isFiltering ? searchResultsCount : null}
                    className="flex-1"
                  />
                  {availableCategories.length > 0 && (
                    <CategoryFilter
                      categories={availableCategories}
                      selected={selectedCategories}
                      onChange={setSelectedCategories}
                      placeholder="Filter by category"
                    />
                  )}
                </div>
                <TicketBoardTab
                  activeView={ticketView}
                  onViewChange={setTicketView}
                  displayedTickets={displayedTickets}
                  technicianName={technician.name}
                  openCount={openCount}
                  pendingCount={pendingCount}
                  selfPickedCount={selfPickedCount}
                  assignedCount={assignedCount}
                  closedCount={closedCount}
                />
              </div>
            )}

            {activeTab === 'coverage' && (
              <CoverageTab
                technician={technician}
                viewMode={viewMode}
                selectedDate={selectedDate}
                selectedWeek={selectedWeek}
                selectedMonth={selectedMonth}
                onPrevious={handlePrevious}
                onNext={handleNext}
                onToday={handleToday}
              />
            )}

            {activeTab === 'csat' && (
              <CSATTab
                tickets={csatTickets}
                isLoading={csatLoading}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
