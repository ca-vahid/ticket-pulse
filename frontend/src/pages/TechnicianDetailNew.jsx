import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useDashboard } from '../contexts/DashboardContext';
import { dashboardAPI } from '../services/api';
import SearchBox from '../components/SearchBox';
import CategoryFilter from '../components/CategoryFilter';
import { filterTickets, getAvailableCategories } from '../utils/ticketFilter';
import {
  ArrowLeft,
  User,
  Mail,
  Clock,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Calendar,
  Star,
  Hand,
  Send,
  ExternalLink,
  Circle
} from 'lucide-react';

// Priority color strips (left border)
const PRIORITY_STRIP_COLORS = {
  1: 'bg-blue-500',    // Low - Blue
  2: 'bg-green-500',   // Medium - Green
  3: 'bg-orange-500',  // High - Orange
  4: 'bg-red-500',     // Urgent - Red
};

const PRIORITY_LABELS = {
  1: 'Low',
  2: 'Medium',
  3: 'High',
  4: 'Urgent',
};

const STATUS_COLORS = {
  'Open': 'bg-red-100 text-red-800 border-red-300',
  'Pending': 'bg-yellow-100 text-yellow-900 border-yellow-400 font-semibold',
  'Resolved': 'bg-green-100 text-green-800 border-green-300',
  'Closed': 'bg-gray-100 text-gray-700 border-gray-300',
};

// Get initials from technician name
const getInitials = (name) => {
  const parts = name.split(' ').filter(p => p.length > 0);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  } else if (parts.length === 1) {
    return parts[0].substring(0, 2).toUpperCase();
  }
  return '??';
};

export default function TechnicianDetailNew() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { getTechnician } = useDashboard();
  const [technician, setTechnician] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('all'); // 'all', 'self', 'assigned', 'closed'

  // Search state - persisted in sessionStorage
  const [searchTerm, setSearchTerm] = useState(() => {
    const navSearch = location.state?.searchTerm;
    if (navSearch !== undefined) return navSearch;
    const stored = sessionStorage.getItem('techDetailNew_search');
    return stored || '';
  });

  // Category filter state - persisted in sessionStorage
  const [selectedCategories, setSelectedCategories] = useState(() => {
    const navCategories = location.state?.selectedCategories;
    if (navCategories !== undefined) return navCategories;
    const stored = sessionStorage.getItem('techDetailNew_categories');
    return stored ? JSON.parse(stored) : [];
  });

  // Helper to format date as YYYY-MM-DD in local timezone
  const formatDateLocal = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Calculate ticket age
  const calculateAge = (createdAt) => {
    const created = new Date(createdAt);
    const now = new Date();
    const diffMs = now - created;
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    return `${hours}h`;
  };

  // Format resolution time from seconds
  const formatResolutionTime = (resolutionTimeSeconds) => {
    if (!resolutionTimeSeconds || resolutionTimeSeconds === 0) return null;

    const totalMinutes = Math.floor(resolutionTimeSeconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    const minutes = totalMinutes % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    return parts.length > 0 ? parts.join(' ') : '< 1m';
  };

  // Calculate pickup time (time from creation to first assignment)
  const calculatePickupTime = (createdAt, firstAssignedAt) => {
    if (!firstAssignedAt) return null;
    const created = new Date(createdAt);
    const assigned = new Date(firstAssignedAt);
    const diffMs = assigned - created;
    const minutes = Math.floor(diffMs / (1000 * 60));
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
  };

  // Calculate age since creation (fallback when pickup time unavailable)
  const calculateAgeSinceCreation = (createdAt) => {
    const created = new Date(createdAt);
    const now = new Date();
    const diffMs = now - created;
    const minutes = Math.floor(diffMs / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
  };

  // Format time spent from minutes
  const formatTimeSpent = (minutes) => {
    if (!minutes || minutes === 0) return null;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;

    if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h`;
    return `${mins}m`;
  };

  // Initialize selectedDate from navigation state or null (today)
  const [selectedDate, setSelectedDate] = useState(() => {
    const passedDate = location.state?.selectedDate;
    if (!passedDate) return null;

    const isCurrentDay = new Date(passedDate).toDateString() === new Date().toDateString();
    if (isCurrentDay) return null;

    return formatDateLocal(new Date(passedDate));
  });

  // Initialize viewMode from navigation state (default to 'daily')
  const [viewMode, setViewMode] = useState(location.state?.viewMode || 'daily');

  // For weekly view, we need to track the selected week (Monday)
  // Restore from navigation state if available
  const [selectedWeek, setSelectedWeek] = useState(() => {
    // First check if selectedWeek was passed from navigation
    const navSelectedWeek = location.state?.selectedWeek;
    if (navSelectedWeek) {
      return navSelectedWeek; // This is already a Date object
    }

    // Otherwise, calculate current week Monday
    if (viewMode === 'weekly') {
      const now = new Date();
      const currentDay = (now.getDay() + 6) % 7; // Convert Sunday=0 to Monday=0
      const monday = new Date(now);
      monday.setDate(now.getDate() - currentDay);
      monday.setHours(0, 0, 0, 0);
      return monday;
    }
    return null;
  });

  useEffect(() => {
    const fetchTechnician = async () => {
      try {
        setIsLoading(true);

        let data;
        if (viewMode === 'weekly') {
          // Fetch weekly data
          const weekStart = selectedWeek ? formatDateLocal(selectedWeek) : null;
          const response = await dashboardAPI.getTechnicianWeekly(parseInt(id, 10), weekStart, 'America/Los_Angeles');
          data = response.data;
        } else {
          // Fetch daily data
          data = await getTechnician(parseInt(id, 10), 'America/Los_Angeles', selectedDate);
        }

        console.log('Technician data:', data);
        setTechnician(data);
      } catch (err) {
        console.error('Error fetching technician:', err);
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    };

    fetchTechnician();
  }, [id, getTechnician, selectedDate, viewMode, selectedWeek]);

  // Persist search term to sessionStorage
  useEffect(() => {
    sessionStorage.setItem('techDetailNew_search', searchTerm);
  }, [searchTerm]);

  // Persist selected categories to sessionStorage
  useEffect(() => {
    sessionStorage.setItem('techDetailNew_categories', JSON.stringify(selectedCategories));
  }, [selectedCategories]);

  const handleBack = () => {
    navigate('/dashboard', {
      state: {
        viewMode: viewMode,
        returnDate: selectedDate || formatDateLocal(new Date()),
        returnWeek: selectedWeek ? formatDateLocal(selectedWeek) : null,
        searchTerm: searchTerm,
        selectedCategories: selectedCategories
      }
    });
  };

  // Date/Week navigation handlers
  const handlePreviousDay = () => {
    if (viewMode === 'weekly') {
      // Navigate to previous week (Monday)
      const currentWeek = selectedWeek || new Date();
      const previousWeek = new Date(currentWeek);
      previousWeek.setDate(currentWeek.getDate() - 7);
      setSelectedWeek(previousWeek);
    } else {
      // Navigate to previous day
      const currentDate = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();
      currentDate.setDate(currentDate.getDate() - 1);
      setSelectedDate(formatDateLocal(currentDate));
    }
  };

  const handleNextDay = () => {
    if (viewMode === 'weekly') {
      // Navigate to next week (Monday)
      const currentWeek = selectedWeek || new Date();
      const nextWeek = new Date(currentWeek);
      nextWeek.setDate(currentWeek.getDate() + 7);
      setSelectedWeek(nextWeek);
    } else {
      // Navigate to next day
      const currentDate = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();
      currentDate.setDate(currentDate.getDate() + 1);
      setSelectedDate(formatDateLocal(currentDate));
    }
  };

  const handleToday = () => {
    if (viewMode === 'weekly') {
      // Navigate to current week (Monday)
      const now = new Date();
      const currentDay = (now.getDay() + 6) % 7; // Convert Sunday=0 to Monday=0
      const monday = new Date(now);
      monday.setDate(now.getDate() - currentDay);
      monday.setHours(0, 0, 0, 0);
      setSelectedWeek(monday);
    } else {
      // Navigate to today
      setSelectedDate(null);
    }
  };

  const handleDateChange = (e) => {
    const dateValue = e.target.value;
    if (dateValue) {
      setSelectedDate(dateValue);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error || !technician) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800 text-sm">{error || 'Technician not found'}</p>
          <button
            onClick={handleBack}
            className="mt-3 bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded text-sm"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  // Calculate display values
  const isToday = !selectedDate;
  const displayDate = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();
  const formattedDate = displayDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Use ticket arrays from backend (already categorized)
  // Weekly mode uses different fields from the backend response
  const selfPickedTickets = viewMode === 'weekly'
    ? (technician.selfPickedTickets || [])
    : (technician.selfPickedTickets || []);
  const assignedTickets = viewMode === 'weekly'
    ? (technician.assignedTickets || [])
    : (technician.assignedTickets || []);
  const closedTicketsToday = viewMode === 'weekly'
    ? (technician.closedTickets || [])
    : (technician.closedTicketsOnDate || []);
  const allOpenTickets = technician.openTickets || []; // All currently open tickets (regardless of creation date)

  // Determine if filtering is active
  const isFiltering = searchTerm || selectedCategories.length > 0;

  // If filtering is active, recalculate stats from filtered tickets
  // Otherwise use the raw backend stats
  let openCount, pendingCount, selfPickedCount, assignedCount, closedCount;

  if (isFiltering) {
    // Filter each ticket array
    const filteredAllOpen = filterTickets(allOpenTickets, searchTerm, selectedCategories);
    const filteredSelfPicked = filterTickets(selfPickedTickets, searchTerm, selectedCategories);
    const filteredAssigned = filterTickets(assignedTickets, searchTerm, selectedCategories);
    const filteredClosed = filterTickets(closedTicketsToday, searchTerm, selectedCategories);

    // Recalculate counts from filtered arrays
    openCount = filteredAllOpen.filter(t => t.status === 'Open').length;
    pendingCount = filteredAllOpen.filter(t => t.status === 'Pending').length;
    selfPickedCount = filteredSelfPicked.length;
    assignedCount = filteredAssigned.length;
    closedCount = filteredClosed.length;
  } else {
    // Use raw backend stats (no filtering)
    openCount = allOpenTickets.filter(t => t.status === 'Open').length;
    pendingCount = allOpenTickets.filter(t => t.status === 'Pending').length;
    selfPickedCount = viewMode === 'weekly'
      ? (technician.weeklySelfPicked || 0)
      : (technician.selfPickedOnDate || 0);
    assignedCount = viewMode === 'weekly'
      ? (technician.weeklyAssigned || 0)
      : (technician.assignedOnDate || 0);
    closedCount = viewMode === 'weekly'
      ? (technician.weeklyClosed || 0)
      : (technician.closedTicketsOnDateCount || 0);
  }

  // Extract unique categories from all tickets using centralized utility
  const allTickets = [...selfPickedTickets, ...assignedTickets, ...closedTicketsToday, ...allOpenTickets];
  const availableCategories = getAvailableCategories(allTickets);

  // Calculate total results count
  const searchResultsCount = (searchTerm || selectedCategories.length > 0)
    ? filterTickets(allTickets, searchTerm, selectedCategories).length
    : 0;

  // Get tickets based on active tab
  let tabTickets;
  switch (activeTab) {
    case 'self':
      tabTickets = selfPickedTickets; // Show all self-picked from today (open + closed)
      break;
    case 'assigned':
      tabTickets = assignedTickets; // Show all assigned from today (open + closed)
      break;
    case 'closed':
      tabTickets = closedTicketsToday; // Show closed from today
      break;
    case 'all':
    default:
      // Show all currently open (from any date)
      // Sort: Open status first, then Pending
      tabTickets = [...allOpenTickets].sort((a, b) => {
        if (a.status === 'Open' && b.status === 'Pending') return -1;
        if (a.status === 'Pending' && b.status === 'Open') return 1;
        return 0;
      });
      break;
  }

  // Apply filters to displayed tickets using centralized utility
  const displayedTickets = filterTickets(tabTickets, searchTerm, selectedCategories);

  // Ticket Card Component with left color strip
  const TicketCard = ({ ticket }) => {
    if (!ticket) return null;

    const priorityStrip = PRIORITY_STRIP_COLORS[ticket.priority] || 'bg-gray-400';
    const isSelfAssigned = ticket.isSelfPicked || ticket.assignedBy === technician?.name;
    const freshdomain = import.meta.env.VITE_FRESHSERVICE_DOMAIN || 'efusion.freshservice.com';
    const pickupTime = calculatePickupTime(ticket.createdAt, ticket.firstAssignedAt);
    const ageSinceCreation = calculateAgeSinceCreation(ticket.createdAt);
    const resolutionTime = formatResolutionTime(ticket.resolutionTimeSeconds);
    const isClosed = ticket.status === 'Closed' || ticket.status === 'Resolved';

    // Format assignment info for assigned tickets
    const assignedByName = ticket.assignedBy && ticket.assignedBy !== technician?.name ? ticket.assignedBy : null;
    const assignedAtTime = ticket.firstAssignedAt ? new Date(ticket.firstAssignedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : null;

    return (
      <div className="bg-white border border-gray-200 rounded overflow-hidden hover:shadow-sm transition-all flex">
        {/* Left Priority Strip */}
        <div className={`${priorityStrip} w-1 flex-shrink-0`}></div>

        {/* Card Content */}
        <div className="flex-1 p-2 flex items-center gap-2">
          {/* Left: ID + Subject + Requester */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              <a
                href={`https://${freshdomain}/a/tickets/${ticket.freshserviceTicketId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-800 font-semibold text-[11px] flex items-center gap-0.5 flex-shrink-0"
              >
                #{ticket.freshserviceTicketId}
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
              <span className="text-gray-900 font-medium text-xs truncate">{ticket.subject}</span>
            </div>
            {ticket.requesterName && (
              <div className="text-[10px] text-gray-500 truncate">
                {ticket.requesterName} {ticket.requesterEmail && `• ${ticket.requesterEmail}`}
              </div>
            )}
          </div>

          {/* Middle: Badges */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <span className={`${STATUS_COLORS[ticket.status] || 'bg-gray-100 text-gray-700'} px-1.5 py-0.5 rounded text-[10px] font-medium`}>
              {ticket.status}
            </span>
            {ticket.ticketCategory && (
              <span className="bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded text-[10px]">
                {ticket.ticketCategory}
              </span>
            )}
            {isSelfAssigned && (
              <span className="bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded text-[10px] flex items-center gap-0.5">
                <Star className="w-2.5 h-2.5 fill-purple-700" />
                Self
              </span>
            )}
          </div>

          {/* Right: Time Metrics and Assignment Info - Single Line */}
          <div className="flex items-center gap-1.5 flex-shrink-0 text-[10px] whitespace-nowrap">
            {/* Assignment Info (for assigned tab) */}
            {assignedByName && activeTab === 'assigned' && (
              <span className="text-orange-700 font-semibold">
                Assigned by {assignedByName} {assignedAtTime && `at ${assignedAtTime}`}
              </span>
            )}

            {/* Time Metrics - Compact */}
            {pickupTime ? (
              <span className="text-green-700">Pickup: {pickupTime}</span>
            ) : (
              !isClosed && (
                <span className="text-gray-500 italic">Age: {ageSinceCreation}</span>
              )
            )}
            {isClosed && resolutionTime && (
              <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded font-semibold border border-blue-300">
                Resolution: {resolutionTime}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  };


  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4">
          {/* Back Button */}
          <button
            onClick={handleBack}
            className="flex items-center gap-2 text-blue-600 hover:text-blue-700 mb-4 text-sm font-medium transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </button>

          {/* Agent Info Row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {/* Profile Photo */}
              {technician.photoUrl ? (
                <img
                  src={technician.photoUrl}
                  alt={technician.name}
                  className="w-16 h-16 rounded-full object-cover border-2 border-gray-200 shadow-md"
                />
              ) : (
                <div className="flex items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 w-16 h-16 shadow-md border-2 border-blue-400">
                  <span className="text-xl font-bold text-white">
                    {getInitials(technician.name)}
                  </span>
                </div>
              )}

              {/* Name & Status */}
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-bold text-gray-900">{technician.name}</h1>
                  {viewMode === 'weekly' && (
                    <span className="px-2 py-1 bg-blue-100 text-blue-700 text-xs font-semibold rounded">
                      Weekly View
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-1">
                  <span className="flex items-center gap-1.5 text-sm text-gray-600">
                    <Circle className="w-2.5 h-2.5 fill-green-500 text-green-500" />
                    Online
                  </span>
                  <span className="text-sm text-gray-500">IT Support - Pacific US & Canada</span>
                </div>
              </div>
            </div>

            {/* Date/Week Picker */}
            <div className="flex items-center gap-2">
              {viewMode === 'weekly' ? (
                <>
                  {/* Weekly View - Show week range */}
                  <button
                    onClick={handlePreviousDay}
                    className="p-2 hover:bg-gray-100 rounded transition-colors"
                  >
                    <ChevronLeft className="w-5 h-5 text-gray-600" />
                  </button>

                  <div className="px-4 py-2 border border-gray-300 rounded-lg text-sm bg-white min-w-[280px] text-center">
                    {technician.weekStart && technician.weekEnd ? (
                      <span className="font-medium text-gray-900">
                        {new Date(technician.weekStart + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        {' '}-{' '}
                        {new Date(technician.weekEnd + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                    ) : (
                      <span className="text-gray-500">Loading week range...</span>
                    )}
                  </div>

                  <button
                    onClick={handleNextDay}
                    className="p-2 hover:bg-gray-100 rounded transition-colors"
                  >
                    <ChevronRight className="w-5 h-5 text-gray-600" />
                  </button>

                  <button
                    onClick={handleToday}
                    className="ml-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors"
                  >
                    This Week
                  </button>
                </>
              ) : (
                <>
                  {/* Daily View - Show single date */}
                  <button
                    onClick={handlePreviousDay}
                    className="p-2 hover:bg-gray-100 rounded transition-colors"
                  >
                    <ChevronLeft className="w-5 h-5 text-gray-600" />
                  </button>

                  <input
                    type="date"
                    value={selectedDate || formatDateLocal(new Date())}
                    onChange={handleDateChange}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />

                  <button
                    onClick={handleNextDay}
                    className="p-2 hover:bg-gray-100 rounded transition-colors"
                  >
                    <ChevronRight className="w-5 h-5 text-gray-600" />
                  </button>

                  {!isToday && (
                    <button
                      onClick={handleToday}
                      className="ml-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors"
                    >
                      Today
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          {/* Total Open */}
          <button
            onClick={() => setActiveTab('all')}
            className={`bg-white rounded-lg shadow-sm border-2 p-4 text-left hover:shadow-md transition-all ${
              activeTab === 'all' ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-200'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-600 uppercase">Total Open</h3>
              <Circle className="w-3 h-3 text-red-600 fill-red-600" />
            </div>
            <div className="text-2xl font-bold text-gray-900">
              {openCount || 0}
              {pendingCount > 0 && (
                <span className="text-lg font-normal text-yellow-600 ml-2">
                  (+ {pendingCount} pending)
                </span>
              )}
            </div>
            <div className="text-xs text-gray-500 mt-1">Current workload</div>
          </button>

          {/* Self-Picked */}
          <button
            onClick={() => setActiveTab('self')}
            className={`bg-white rounded-lg shadow-sm border-2 p-4 text-left hover:shadow-md transition-all ${
              activeTab === 'self' ? 'border-purple-500 ring-2 ring-purple-200' : 'border-gray-200'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-600 uppercase">Self-Picked</h3>
              <Hand className="w-3 h-3 text-purple-600" />
            </div>
            <div className="text-2xl font-bold text-purple-900">{selfPickedCount}</div>
            <div className="text-xs text-gray-500 mt-1">
              {viewMode === 'weekly' ? 'This Week' : (isToday ? 'Today' : displayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}
            </div>
          </button>

          {/* Assigned */}
          <button
            onClick={() => setActiveTab('assigned')}
            className={`bg-white rounded-lg shadow-sm border-2 p-4 text-left hover:shadow-md transition-all ${
              activeTab === 'assigned' ? 'border-orange-500 ring-2 ring-orange-200' : 'border-gray-200'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-600 uppercase">Assigned</h3>
              <Send className="w-3 h-3 text-orange-600" />
            </div>
            <div className="text-2xl font-bold text-orange-900">{assignedCount}</div>
            <div className="text-xs text-gray-500 mt-1">
              {viewMode === 'weekly' ? 'This Week' : (isToday ? 'Today' : displayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}
            </div>
          </button>

          {/* Closed */}
          <button
            onClick={() => setActiveTab('closed')}
            className={`bg-white rounded-lg shadow-sm border-2 p-4 text-left hover:shadow-md transition-all ${
              activeTab === 'closed' ? 'border-green-500 ring-2 ring-green-200' : 'border-gray-200'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-600 uppercase">Closed</h3>
              <CheckCircle className="w-3 h-3 text-green-600" />
            </div>
            <div className="text-2xl font-bold text-green-900">{closedCount}</div>
            <div className="text-xs text-gray-500 mt-1">
              {viewMode === 'weekly' ? 'This Week' : (isToday ? 'Today' : displayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}
            </div>
          </button>
        </div>

        {/* Search and Filter Controls */}
        <div className="mb-3 space-y-2">
          <SearchBox
            value={searchTerm}
            onChange={setSearchTerm}
            placeholder="Search tickets by subject, ID, or requester..."
            resultsCount={searchTerm || selectedCategories.length > 0 ? searchResultsCount : null}
            className="w-full"
          />
          {availableCategories.length > 0 && (
            <CategoryFilter
              categories={availableCategories}
              selected={selectedCategories}
              onChange={setSelectedCategories}
              placeholder="Filter by category"
              className="w-full"
            />
          )}
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="border-b border-gray-200">
            <div className="flex">
              <button
                onClick={() => setActiveTab('all')}
                className={`px-4 py-3 font-medium text-sm transition-colors relative ${
                  activeTab === 'all'
                    ? 'text-blue-600 border-b-2 border-blue-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                All Open
                <span className="ml-2 text-xs text-gray-500">
                  (Open: {openCount} / Pending: {pendingCount})
                </span>
              </button>
              <button
                onClick={() => setActiveTab('self')}
                className={`px-4 py-3 font-medium text-sm transition-colors relative ${
                  activeTab === 'self'
                    ? 'text-purple-600 border-b-2 border-purple-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Self-Picked
                <span className="ml-2 bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full text-xs font-semibold">
                  {selfPickedCount}
                </span>
              </button>
              <button
                onClick={() => setActiveTab('assigned')}
                className={`px-4 py-3 font-medium text-sm transition-colors relative ${
                  activeTab === 'assigned'
                    ? 'text-orange-600 border-b-2 border-orange-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Assigned
                <span className="ml-2 bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full text-xs font-semibold">
                  {assignedCount}
                </span>
              </button>
              <button
                onClick={() => setActiveTab('closed')}
                className={`px-4 py-3 font-medium text-sm transition-colors relative ${
                  activeTab === 'closed'
                    ? 'text-green-600 border-b-2 border-green-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Closed
                <span className="ml-2 bg-green-100 text-green-700 px-2 py-0.5 rounded-full text-xs font-semibold">
                  {closedCount}
                </span>
              </button>
            </div>
          </div>

          {/* Tickets List */}
          <div className="p-3">
            {displayedTickets.length === 0 ? (
              <div className="text-center py-8">
                <div className="text-gray-400 mb-2">
                  <CheckCircle className="w-10 h-10 mx-auto" />
                </div>
                <p className="text-gray-600 font-medium text-sm">No tickets in this category</p>
                <p className="text-gray-500 text-xs mt-1">
                  {activeTab === 'all' && 'All tickets have been closed or there are no open tickets.'}
                  {activeTab === 'self' && (viewMode === 'weekly' ? 'No self-picked tickets this week.' : 'No self-picked tickets today.')}
                  {activeTab === 'assigned' && (viewMode === 'weekly' ? 'No assigned tickets this week.' : 'No assigned tickets today.')}
                  {activeTab === 'closed' && (viewMode === 'weekly' ? 'No closed tickets this week.' : 'No closed tickets for this date.')}
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {displayedTickets.map((ticket) => (
                  <TicketCard key={ticket.id} ticket={ticket} />
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
