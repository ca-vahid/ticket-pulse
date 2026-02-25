import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useDashboard } from '../contexts/DashboardContext';
import { dashboardAPI } from '../services/api';
import SearchBox from '../components/SearchBox';
import CategoryFilter from '../components/CategoryFilter';
import { filterTickets, getAvailableCategories } from '../utils/ticketFilter';
import ExportButton from '../components/ExportButton';
import { getHolidayInfo, getHolidayTooltip } from '../utils/holidays';
import {
  ArrowLeft,
  User,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Star,
  Hand,
  Send,
  ExternalLink,
  Circle,
  BarChart3,
  TrendingUp,
  TrendingDown,
  Minus,
  Users,
  Moon,
  Sunrise,
  X,
  Layers,
  CalendarDays,
} from 'lucide-react';

// Priority color strips (left border)
const PRIORITY_STRIP_COLORS = {
  1: 'bg-blue-500',    // Low - Blue
  2: 'bg-green-500',   // Medium - Green
  3: 'bg-orange-500',  // High - Orange
  4: 'bg-red-500',     // Urgent - Red
};

const _PRIORITY_LABELS = {
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
  if (!name) return '??';
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
  const { getTechnicianCSAT } = useDashboard();

  const [technician, setTechnician] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const fetchSeqRef = useRef(0);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('overview'); // 'overview', 'all', 'self', 'assigned', 'closed', 'csat'
  const [csatTickets, setCSATTickets] = useState([]);
  const [csatLoading, setCSATLoading] = useState(false);
  const [csatCount, setCSATCount] = useState(0);
  const [csatAverage, setCSATAverage] = useState(null);
  const [expandedCSATTicket, setExpandedCSATTicket] = useState(null); // For CSAT feedback modal

  // Coverage tab exclude filters
  const [coverageExcludedCats, setCoverageExcludedCats] = useState(new Set());
  const [coverageExcludeText, setCoverageExcludeText] = useState('');
  const [showMergedTimeline, setShowMergedTimeline] = useState(false);
  const [mergedViewMode, setMergedViewMode] = useState('rolling');

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
  const _calculateAge = (createdAt) => {
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
  const _formatTimeSpent = (minutes) => {
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

  // Capture the originating dashboard viewMode so back-nav restores it correctly
  // even if the user toggles daily/weekly within the detail page
  const originViewModeRef = useRef(location.state?.viewMode || 'daily');

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

  // Fetch CSAT data (cache-aware via context)
  useEffect(() => {
    const fetchCSATData = async () => {
      if (!id) return;
      try {
        setCSATLoading(activeTab === 'csat');
        const response = await getTechnicianCSAT(parseInt(id, 10));
        const data = response?.data || response;
        const tickets = data?.csatTickets || [];
        const avg = data?.averageScore ? parseFloat(data.averageScore) : null;
        setCSATTickets(tickets);
        setCSATCount(tickets.length);
        setCSATAverage(avg);
      } catch (error) {
        console.error('Failed to fetch CSAT data:', error);
      } finally {
        setCSATLoading(false);
      }
    };
    fetchCSATData();
  }, [id, getTechnicianCSAT]);

  // Fetch technician detail — direct API call (bypasses frontend cache to avoid stale data)
  useEffect(() => {
    const mySeq = ++fetchSeqRef.current;
    setIsLoading(true);
    setTechnician(null);
    setError(null);

    const fetchTechnicianData = async () => {
      try {
        let data;
        if (viewMode === 'weekly') {
          const weekStart = selectedWeek ? formatDateLocal(selectedWeek) : null;
          const response = await dashboardAPI.getTechnicianWeekly(
            parseInt(id, 10), weekStart, 'America/Los_Angeles',
          );
          if (response.success && response.data) {
            data = response.data;
          } else {
            throw new Error('Failed to fetch weekly technician data');
          }
        } else {
          const dateStr = selectedDate ? (typeof selectedDate === 'string' ? selectedDate : formatDateLocal(selectedDate)) : null;
          const response = await dashboardAPI.getTechnician(
            parseInt(id, 10), 'America/Los_Angeles', dateStr,
          );
          if (response.success && response.data) {
            data = response.data;
          } else {
            throw new Error('Failed to fetch technician data');
          }
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
    fetchTechnicianData();
  }, [id, selectedDate, viewMode, selectedWeek]);

  // Persist search term to sessionStorage
  useEffect(() => {
    sessionStorage.setItem('techDetailNew_search', searchTerm);
  }, [searchTerm]);

  // Persist selected categories to sessionStorage
  useEffect(() => {
    sessionStorage.setItem('techDetailNew_categories', JSON.stringify(selectedCategories));
  }, [selectedCategories]);

  const handleBack = () => {
    // Use the original dashboard viewMode (not the detail page's internal toggle)
    const returnViewMode = location.state?.returnViewMode || originViewModeRef.current;
    navigate('/dashboard', {
      state: {
        viewMode: returnViewMode,
        returnDate: selectedDate || formatDateLocal(new Date()),
        returnWeek: selectedWeek ? formatDateLocal(selectedWeek) : null,
        searchTerm: searchTerm,
        selectedCategories: selectedCategories,
      },
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

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800 text-sm">{error}</p>
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

  if (!technician) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  // Calculate display values
  const isToday = !selectedDate;
  const displayDate = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();
  const _formattedDate = displayDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Check if selected week is current week
  const isCurrentWeek = viewMode === 'weekly' && selectedWeek ? (() => {
    const now = new Date();
    const currentDay = (now.getDay() + 6) % 7;
    const currentMonday = new Date(now);
    currentMonday.setDate(now.getDate() - currentDay);
    currentMonday.setHours(0, 0, 0, 0);

    const selectedMonday = new Date(selectedWeek);
    selectedMonday.setHours(0, 0, 0, 0);

    return selectedMonday.getTime() === currentMonday.getTime();
  })() : false;

  // Format week range for display
  const weekRangeLabel = viewMode === 'weekly' && selectedWeek ? (() => {
    if (isCurrentWeek) return 'This Week';

    const weekStart = new Date(selectedWeek);
    const weekEnd = new Date(selectedWeek);
    weekEnd.setDate(weekStart.getDate() + 6);

    const startStr = weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endStr = weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    return `${startStr} - ${endStr}`;
  })() : 'This Week';

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
  case 'overview':
    tabTickets = [];
    break;
  case 'self':
    tabTickets = selfPickedTickets;
    break;
  case 'assigned':
    tabTickets = assignedTickets;
    break;
  case 'closed':
    tabTickets = closedTicketsToday;
    break;
  case 'csat':
    tabTickets = csatTickets;
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
  const displayedTickets = activeTab === 'csat' 
    ? tabTickets // CSAT tickets are already filtered from backend
    : filterTickets(tabTickets, searchTerm, selectedCategories);

  // CSAT Card Component - Beautiful card design for CSAT tab
  const CSATCard = ({ ticket }) => {
    if (!ticket) return null;

    const freshdomain = import.meta.env.VITE_FRESHSERVICE_DOMAIN || 'efusion.freshservice.com';
    const score = ticket.csatScore || 0;
    const totalScore = ticket.csatTotalScore || 4;
    const hasFeedback = ticket.csatFeedback && ticket.csatFeedback.length > 0;
    const isLongFeedback = hasFeedback && ticket.csatFeedback.length > 150;
    
    // Card background color based on score
    const getCardColor = (score) => {
      if (score >= 4) return 'bg-gradient-to-br from-green-50 to-green-100 border-green-300';
      if (score === 3) return 'bg-gradient-to-br from-yellow-50 to-yellow-100 border-yellow-300';
      if (score === 2) return 'bg-gradient-to-br from-orange-50 to-orange-100 border-orange-300';
      return 'bg-gradient-to-br from-red-50 to-red-100 border-red-300';
    };

    const getScoreColor = (score) => {
      if (score >= 4) return 'text-green-700';
      if (score === 3) return 'text-yellow-700';
      if (score === 2) return 'text-orange-700';
      return 'text-red-700';
    };

    const getEmoji = (score) => {
      if (score >= 4) return '😊';
      if (score === 3) return '😐';
      if (score === 2) return '😕';
      return '😞';
    };

    const formatDate = (dateString) => {
      if (!dateString) return 'N/A';
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    };

    // Render star rating
    const renderStars = () => {
      const stars = [];
      for (let i = 1; i <= totalScore; i++) {
        stars.push(
          <Star
            key={i}
            className={`w-3.5 h-3.5 ${i <= score ? 'text-yellow-500 fill-yellow-500' : 'text-gray-300'}`}
          />,
        );
      }
      return stars;
    };

    return (
      <div className={`rounded-lg border-2 shadow-sm hover:shadow-md transition-all p-3 flex flex-col ${getCardColor(score)}`}>
        {/* Header: Ticket ID and Date */}
        <div className="flex items-center justify-between mb-2">
          <a
            href={`https://${freshdomain}/a/tickets/${ticket.freshserviceTicketId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 font-bold text-xs flex items-center gap-1"
          >
            #{ticket.freshserviceTicketId}
            <ExternalLink className="w-2.5 h-2.5" />
          </a>
          <span className="text-[10px] text-gray-600">
            {formatDate(ticket.csatSubmittedAt)}
          </span>
        </div>

        {/* Subject */}
        <h3 className="font-medium text-gray-900 mb-2 line-clamp-1 leading-tight text-xs">
          {ticket.subject}
        </h3>

        {/* Star Rating and Score - Horizontal Layout */}
        <div className="flex items-center justify-between mb-2 py-1.5 border-y border-gray-200">
          <div className="flex items-center gap-0.5">
            {renderStars()}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-2xl">{getEmoji(score)}</span>
            <div className={`text-xl font-bold ${getScoreColor(score)}`}>
              {score}/{totalScore}
            </div>
          </div>
        </div>

        {/* Customer Feedback - Truncated with Read More */}
        {hasFeedback && (
          <div className="mt-2">
            <div className="text-[10px] font-bold text-gray-600 mb-1 uppercase">
              Feedback:
            </div>
            <div className="text-xs text-gray-700 italic leading-snug bg-white/60 rounded p-2 border border-gray-200">
              <div className={isLongFeedback ? 'line-clamp-2' : ''}>
                &quot;{ticket.csatFeedback}&quot;
              </div>
              {isLongFeedback && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedCSATTicket(ticket);
                  }}
                  className="mt-1 text-blue-600 hover:text-blue-800 font-semibold text-[10px] underline"
                >
                  Read More →
                </button>
              )}
            </div>
          </div>
        )}

        {/* Requester Info */}
        {ticket.requesterName && (
          <div className="mt-2 pt-2 border-t border-gray-200">
            <div className="flex items-center gap-1.5 text-[10px] text-gray-600">
              <User className="w-3 h-3" />
              <span className="font-medium truncate">{ticket.requesterName}</span>
            </div>
          </div>
        )}
      </div>
    );
  };

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
    const hasCSAT = ticket.csatScore !== null && ticket.csatScore !== undefined;

    // Format assignment info for assigned tickets
    const assignedByName = ticket.assignedBy && ticket.assignedBy !== technician?.name ? ticket.assignedBy : null;
    const assignedAtTime = ticket.firstAssignedAt ? new Date(ticket.firstAssignedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : null;

    // CSAT color coding
    const getCSATColor = (score) => {
      if (score >= 4) return 'bg-green-100 text-green-800 border-green-300';
      if (score === 3) return 'bg-yellow-100 text-yellow-800 border-yellow-300';
      if (score === 2) return 'bg-orange-100 text-orange-800 border-orange-300';
      return 'bg-red-100 text-red-800 border-red-300';
    };

    const getCSATEmoji = (score) => {
      if (score >= 4) return '😊';
      if (score === 3) return '😐';
      if (score === 2) return '😕';
      return '😞';
    };

    return (
      <div className="bg-white border border-gray-200 rounded overflow-hidden hover:shadow-sm transition-all">
        <div className="flex">
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
              {/* CSAT Rating Badge */}
              {hasCSAT && (
                <span 
                  className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border flex items-center gap-0.5 ${getCSATColor(ticket.csatScore)}`}
                  title={ticket.csatFeedback || 'Customer satisfaction rating'}
                >
                  <span>{getCSATEmoji(ticket.csatScore)}</span>
                  <span>CSAT: {ticket.csatScore}/{ticket.csatTotalScore || 4}</span>
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
        {/* CSAT Feedback - Expandable section for detailed comments */}
        {hasCSAT && ticket.csatFeedback && (
          <div className="border-t border-gray-100 bg-gray-50 px-3 py-2">
            <div className="text-[10px] text-gray-600 font-semibold mb-0.5">Customer Feedback:</div>
            <div className="text-[11px] text-gray-700 line-clamp-2">{ticket.csatFeedback}</div>
          </div>
        )}
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
                  <div className="flex bg-gray-100 rounded-lg p-0.5">
                    <button
                      onClick={() => {
                        if (viewMode === 'weekly' && selectedWeek) {
                          setSelectedDate(formatDateLocal(new Date(selectedWeek)));
                        }
                        setViewMode('daily');
                      }}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
                        viewMode === 'daily'
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'text-gray-600 hover:text-gray-900'
                      }`}
                    >
                      Daily
                    </button>
                    <button
                      onClick={() => {
                        if (viewMode !== 'weekly') {
                          const dateToUse = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();
                          const day = (dateToUse.getDay() + 6) % 7;
                          const monday = new Date(dateToUse);
                          monday.setDate(dateToUse.getDate() - day);
                          monday.setHours(0, 0, 0, 0);
                          setSelectedWeek(monday);
                        }
                        setViewMode('weekly');
                      }}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
                        viewMode === 'weekly'
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'text-gray-600 hover:text-gray-900'
                      }`}
                    >
                      Weekly
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-3 mt-1">
                  <span className="flex items-center gap-1.5 text-sm text-gray-600">
                    <Circle className="w-2.5 h-2.5 fill-green-500 text-green-500" />
                    {technician.timezone ? technician.timezone.split('/').pop().replace(/_/g, ' ') : 'Unknown TZ'}
                  </span>
                  {(technician.workStartTime || technician.workEndTime) && (
                    <span className="text-sm text-gray-500">
                      {technician.workStartTime || '??'} – {technician.workEndTime || '??'}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Export and Date/Week Picker */}
            <div className="flex items-center gap-3">
              {/* Export Button */}
              <ExportButton
                tickets={allTickets}
                technicians={[technician]}
                viewMode={technician.name}
                selectedDate={selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date()}
              />

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
                    {(() => {
                      const ws = technician.weekStart
                        ? new Date(technician.weekStart + 'T12:00:00')
                        : selectedWeek ? new Date(selectedWeek) : null;
                      const we = technician.weekEnd
                        ? new Date(technician.weekEnd + 'T12:00:00')
                        : ws ? (() => { const d = new Date(ws); d.setDate(d.getDate() + 6); return d; })() : null;
                      if (!ws) return <span className="text-gray-500">Loading week range...</span>;
                      return (
                        <span className="font-medium text-gray-900">
                          {ws.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          {' '}-{' '}
                          {we.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      );
                    })()}
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
        <div className="grid grid-cols-5 gap-4 mb-6">
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
              {viewMode === 'weekly' ? weekRangeLabel : (isToday ? 'Today' : displayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}
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
              {viewMode === 'weekly' ? weekRangeLabel : (isToday ? 'Today' : displayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}
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
              {viewMode === 'weekly' ? weekRangeLabel : (isToday ? 'Today' : displayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}
            </div>
          </button>

          {/* CSAT */}
          <button
            onClick={() => setActiveTab('csat')}
            className={`bg-white rounded-lg shadow-sm border-2 p-4 text-left hover:shadow-md transition-all ${
              activeTab === 'csat' ? 'border-yellow-500 ring-2 ring-yellow-200' : 'border-gray-200'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-600 uppercase">CSAT</h3>
              <Star className={`w-3 h-3 ${csatCount > 0 ? 'text-yellow-600 fill-yellow-600' : 'text-gray-400'}`} />
            </div>
            <div className="flex items-center gap-2">
              <div className="text-2xl font-bold text-yellow-900">{csatCount}</div>
              {csatAverage && (
                <div className="text-sm text-gray-600">
                  Avg: {csatAverage}/4
                </div>
              )}
            </div>
            <div className="text-xs text-gray-500 mt-1">All time</div>
          </button>
        </div>

        {/* Search and Filter Controls */}
        <div className="mb-3 space-y-2">
          <SearchBox
            value={searchTerm}
            onChange={setSearchTerm}
            placeholder="Search tickets... (use OR or | for alternatives)"
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
                onClick={() => setActiveTab('overview')}
                className={`px-4 py-3 font-medium text-sm transition-colors relative flex items-center gap-1.5 ${
                  activeTab === 'overview'
                    ? 'text-indigo-600 border-b-2 border-indigo-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <BarChart3 className="w-3.5 h-3.5" />
                Overview
              </button>
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
              <button
                onClick={() => setActiveTab('csat')}
                className={`px-4 py-3 font-medium text-sm transition-colors relative ${
                  activeTab === 'csat'
                    ? 'text-yellow-600 border-b-2 border-yellow-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                CSAT
                <span className="ml-2 bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full text-xs font-semibold">
                  {csatCount}
                </span>
              </button>
              <button
                onClick={() => setActiveTab('coverage')}
                className={`px-4 py-3 font-medium text-sm transition-colors relative ${
                  activeTab === 'coverage'
                    ? 'text-indigo-600 border-b-2 border-indigo-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Coverage
              </button>
            </div>
          </div>

          {/* Tab Content */}
          <div className="p-3">
            {activeTab === 'overview' ? (
              /* Overview Tab */
              <div className="space-y-4">
                {viewMode === 'weekly' && !technician.dailyBreakdown ? (
                  <div className="text-center py-12">
                    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mx-auto mb-3"></div>
                    <p className="text-gray-500 text-sm">Loading weekly data...</p>
                  </div>
                ) : viewMode === 'weekly' && technician.dailyBreakdown ? (
                  /* ===== WEEKLY OVERVIEW ===== */
                  <>
                    {/* Daily Breakdown Grid */}
                    <div>
                      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Daily Breakdown</h3>
                      <div className="grid grid-cols-7 gap-2">
                        {technician.dailyBreakdown.map((day, index) => {
                          const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
                          const dateObj = new Date(day.date + 'T12:00:00');
                          const dateLabel = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                          const isWeekend = index >= 5;
                          const maxTotal = Math.max(...technician.dailyBreakdown.map(d => d.total), 1);
                          const intensity = day.total / maxTotal;
                          const bgClass = day.total === 0
                            ? (isWeekend ? 'bg-slate-50' : 'bg-gray-50')
                            : intensity >= 0.66
                              ? 'bg-green-50 border-green-200'
                              : intensity >= 0.33
                                ? 'bg-blue-50 border-blue-200'
                                : 'bg-gray-50 border-gray-200';

                          return (
                            <div key={day.date} className={`rounded-lg border p-2.5 text-center ${bgClass} ${isWeekend ? 'opacity-70' : ''}`}>
                              <div className={`text-[10px] font-bold uppercase ${isWeekend ? 'text-slate-400' : 'text-gray-500'}`}>{dayNames[index]}</div>
                              <div className="text-[9px] text-gray-400 mb-1">{dateLabel}</div>
                              <div className={`text-xl font-bold ${day.total === 0 ? 'text-gray-300' : 'text-gray-800'}`}>{day.total}</div>
                              {day.total > 0 && (
                                <div className="mt-1.5 space-y-0.5">
                                  <div className="flex items-center justify-center gap-1">
                                    <Hand className="w-2.5 h-2.5 text-purple-500" />
                                    <span className="text-[9px] text-purple-700 font-medium">{day.self}</span>
                                    <Send className="w-2.5 h-2.5 text-orange-500 ml-1" />
                                    <span className="text-[9px] text-orange-700 font-medium">{day.assigned}</span>
                                  </div>
                                  <div className="flex items-center justify-center gap-1">
                                    <CheckCircle className="w-2.5 h-2.5 text-green-500" />
                                    <span className="text-[9px] text-green-700 font-medium">{day.closed} cls</span>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Weekly Summary Metrics */}
                    <div>
                      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Weekly Summary</h3>
                      <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
                        {/* TOTAL - highlighted */}
                        <div className="bg-blue-600 rounded-lg p-3 text-center shadow-md ring-1 ring-blue-700">
                          <div className="text-3xl font-extrabold text-white">{technician.weeklyTotalCreated || 0}</div>
                          <div className="text-[10px] text-blue-100 font-semibold uppercase tracking-wide">Total</div>
                        </div>
                        <div className="bg-gray-50 rounded-lg p-3 text-center border border-gray-200">
                          <div className="text-2xl font-bold text-gray-700">{technician.weeklySelfPicked || 0}</div>
                          <div className="text-[10px] text-gray-500 font-medium uppercase">Self-Picked</div>
                        </div>
                        <div className="bg-gray-50 rounded-lg p-3 text-center border border-gray-200">
                          <div className="text-2xl font-bold text-gray-700">{technician.weeklyAssigned || 0}</div>
                          <div className="text-[10px] text-gray-500 font-medium uppercase">Assigned</div>
                        </div>
                        {/* CLOSED - highlighted */}
                        <div className="bg-green-600 rounded-lg p-3 text-center shadow-md ring-1 ring-green-700">
                          <div className="text-3xl font-extrabold text-white">{technician.weeklyClosed || 0}</div>
                          <div className="text-[10px] text-green-100 font-semibold uppercase tracking-wide">Closed</div>
                        </div>
                        {(() => {
                          const netChange = technician.weeklyNetChange || 0;
                          const wrapperClass = netChange > 0
                            ? 'bg-red-50 border-red-200'
                            : netChange < 0
                              ? 'bg-green-50 border-green-200'
                              : 'bg-gray-50 border-gray-200';
                          const textClass = netChange > 0
                            ? 'text-red-700'
                            : netChange < 0
                              ? 'text-green-700'
                              : 'text-gray-700';
                          const labelClass = netChange > 0
                            ? 'text-red-500'
                            : netChange < 0
                              ? 'text-green-500'
                              : 'text-gray-500';
                          return (
                            <div className={`rounded-lg p-3 text-center border ${wrapperClass}`}>
                              <div className={`text-2xl font-bold flex items-center justify-center gap-1 ${textClass}`}>
                                {netChange > 0 ? <TrendingUp className="w-4 h-4" /> : netChange < 0 ? <TrendingDown className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
                                {netChange > 0 ? '+' : ''}{netChange}
                              </div>
                              <div className={`text-[10px] font-medium uppercase ${labelClass}`}>Net Change</div>
                            </div>
                          );
                        })()}
                        {(() => {
                          const total = technician.weeklyTotalCreated || 0;
                          const selfRate = total > 0 ? Math.round(((technician.weeklySelfPicked || 0) / total) * 100) : 0;
                          return (
                            <div className="bg-gray-50 rounded-lg p-3 text-center border border-gray-200">
                              <div className="text-2xl font-bold text-gray-700">{selfRate}%</div>
                              <div className="text-[10px] text-gray-500 font-medium uppercase">Self-Pick Rate</div>
                            </div>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Breakdown Bar */}
                    {(technician.weeklyTotalCreated || 0) > 0 && (
                      <div>
                        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Self-Picked vs Assigned</h3>
                        <div className="flex rounded-full overflow-hidden h-4 bg-gray-100">
                          {(technician.weeklySelfPicked || 0) > 0 && (
                            <div
                              className="bg-blue-500 flex items-center justify-center"
                              style={{ width: `${((technician.weeklySelfPicked || 0) / (technician.weeklyTotalCreated || 1)) * 100}%` }}
                            >
                              <span className="text-[9px] text-white font-bold">{technician.weeklySelfPicked}</span>
                            </div>
                          )}
                          {(technician.weeklyAssigned || 0) > 0 && (
                            <div
                              className="bg-gray-400 flex items-center justify-center"
                              style={{ width: `${((technician.weeklyAssigned || 0) / (technician.weeklyTotalCreated || 1)) * 100}%` }}
                            >
                              <span className="text-[9px] text-white font-bold">{technician.weeklyAssigned}</span>
                            </div>
                          )}
                        </div>
                        <div className="flex justify-between mt-1">
                          <div className="flex items-center gap-1">
                            <div className="w-2 h-2 rounded-full bg-blue-500" />
                            <span className="text-[10px] text-gray-600">Self-Picked</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <div className="w-2 h-2 rounded-full bg-gray-400" />
                            <span className="text-[10px] text-gray-600">Assigned</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Daily Averages */}
                    <div>
                      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Daily Averages</h3>
                      <div className="grid grid-cols-3 gap-2">
                        <div className="bg-gray-50 rounded-lg p-3 text-center border border-gray-200">
                          <div className="text-lg font-bold text-gray-700">{(technician.avgTicketsPerDay || 0).toFixed(1)}</div>
                          <div className="text-[10px] text-gray-500 font-medium">Tickets / Day</div>
                        </div>
                        <div className="bg-gray-50 rounded-lg p-3 text-center border border-gray-200">
                          <div className="text-lg font-bold text-gray-700">{(technician.avgSelfPickedPerDay || 0).toFixed(1)}</div>
                          <div className="text-[10px] text-gray-500 font-medium">Self-Picked / Day</div>
                        </div>
                        <div className="bg-gray-50 rounded-lg p-3 text-center border border-gray-200">
                          <div className="text-lg font-bold text-gray-700">{(technician.avgClosedPerDay || 0).toFixed(1)}</div>
                          <div className="text-[10px] text-gray-500 font-medium">Closed / Day</div>
                        </div>
                      </div>
                    </div>

                    {/* Assigners + CSAT Row */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {/* Assigners Breakdown */}
                      {technician.assigners && technician.assigners.length > 0 && (
                        <div>
                          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Assigned By</h3>
                          <div className="bg-gray-50 rounded-lg border border-gray-200 divide-y divide-gray-200">
                            {technician.assigners.map((assigner, idx) => (
                              <div key={idx} className="flex items-center justify-between px-3 py-2">
                                <div className="flex items-center gap-2">
                                  <Users className="w-3.5 h-3.5 text-orange-500" />
                                  <span className="text-sm text-gray-700">{assigner.name}</span>
                                </div>
                                <span className="text-sm font-bold text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full">{assigner.count}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Weekly CSAT */}
                      {(technician.weeklyCSATCount || 0) > 0 && (
                        <div>
                          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Weekly CSAT</h3>
                          <div className="bg-yellow-50 rounded-lg border border-yellow-200 p-4 text-center">
                            <div className="flex items-center justify-center gap-3">
                              <div>
                                <div className="text-2xl font-bold text-yellow-700">{technician.weeklyCSATCount}</div>
                                <div className="text-[10px] text-yellow-600 font-medium">Ratings</div>
                              </div>
                              <div className="w-px h-10 bg-yellow-300" />
                              <div>
                                <div className="text-2xl font-bold text-yellow-700 flex items-center gap-1">
                                  {technician.weeklyCSATAverage ? Number(technician.weeklyCSATAverage).toFixed(1) : 'N/A'}
                                  <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                                </div>
                                <div className="text-[10px] text-yellow-600 font-medium">Avg Score / 4</div>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Category Breakdown */}
                    {(() => {
                      const weeklyTickets = technician.weeklyTickets || [];
                      if (weeklyTickets.length === 0) return null;
                      const categoryMap = {};
                      weeklyTickets.forEach(t => {
                        const cat = t.ticketCategory || 'Uncategorized';
                        categoryMap[cat] = (categoryMap[cat] || 0) + 1;
                      });
                      const sorted = Object.entries(categoryMap).sort((a, b) => b[1] - a[1]);
                      return (
                        <div>
                          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Categories</h3>
                          <div className="flex flex-wrap gap-1.5">
                            {sorted.map(([cat, count]) => (
                              <span key={cat} className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-700 rounded-full text-xs border border-gray-200">
                                {cat}
                                <span className="font-bold text-gray-900">{count}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </>
                ) : (
                  /* ===== DAILY OVERVIEW ===== */
                  <>
                    {/* Period Metrics Grid */}
                    <div>
                      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                        {selectedDate
                          ? new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
                          : new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
                        }
                      </h3>
                      <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
                        {/* TOTAL - highlighted */}
                        <div className="bg-blue-600 rounded-lg p-3 text-center shadow-md ring-1 ring-blue-700">
                          <div className="text-3xl font-extrabold text-white">{technician.totalTicketsOnDate || 0}</div>
                          <div className="text-[10px] text-blue-100 font-semibold uppercase tracking-wide">Total Tickets</div>
                        </div>
                        <div className="bg-gray-50 rounded-lg p-3 text-center border border-gray-200">
                          <div className="text-2xl font-bold text-gray-700">{technician.selfPickedOnDate || 0}</div>
                          <div className="text-[10px] text-gray-500 font-medium uppercase">Self-Picked</div>
                        </div>
                        <div className="bg-gray-50 rounded-lg p-3 text-center border border-gray-200">
                          <div className="text-2xl font-bold text-gray-700">{technician.assignedOnDate || 0}</div>
                          <div className="text-[10px] text-gray-500 font-medium uppercase">Assigned</div>
                        </div>
                        {/* CLOSED - highlighted */}
                        <div className="bg-green-600 rounded-lg p-3 text-center shadow-md ring-1 ring-green-700">
                          <div className="text-3xl font-extrabold text-white">{technician.closedTicketsOnDateCount || 0}</div>
                          <div className="text-[10px] text-green-100 font-semibold uppercase tracking-wide">Closed</div>
                        </div>
                        <div className="bg-gray-50 rounded-lg p-3 text-center border border-gray-200">
                          <div className="text-2xl font-bold text-gray-700">{openCount}</div>
                          {pendingCount > 0 && <div className="text-[9px] text-gray-500 font-medium">+ {pendingCount} pending</div>}
                          <div className="text-[10px] text-gray-500 font-medium uppercase">Open Now</div>
                        </div>
                        {(() => {
                          const total = technician.totalTicketsOnDate || 0;
                          const selfRate = total > 0 ? Math.round(((technician.selfPickedOnDate || 0) / total) * 100) : 0;
                          return (
                            <div className="bg-gray-50 rounded-lg p-3 text-center border border-gray-200">
                              <div className="text-2xl font-bold text-gray-700">{selfRate}%</div>
                              <div className="text-[10px] text-gray-500 font-medium uppercase">Self-Pick Rate</div>
                            </div>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Breakdown Bar */}
                    {(technician.totalTicketsOnDate || 0) > 0 && (
                      <div>
                        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Self-Picked vs Assigned</h3>
                        <div className="flex rounded-full overflow-hidden h-4 bg-gray-100">
                          {(technician.selfPickedOnDate || 0) > 0 && (
                            <div
                              className="bg-blue-500 flex items-center justify-center"
                              style={{ width: `${((technician.selfPickedOnDate || 0) / (technician.totalTicketsOnDate || 1)) * 100}%` }}
                            >
                              <span className="text-[9px] text-white font-bold">{technician.selfPickedOnDate}</span>
                            </div>
                          )}
                          {(technician.assignedOnDate || 0) > 0 && (
                            <div
                              className="bg-gray-400 flex items-center justify-center"
                              style={{ width: `${((technician.assignedOnDate || 0) / (technician.totalTicketsOnDate || 1)) * 100}%` }}
                            >
                              <span className="text-[9px] text-white font-bold">{technician.assignedOnDate}</span>
                            </div>
                          )}
                        </div>
                        <div className="flex justify-between mt-1">
                          <div className="flex items-center gap-1">
                            <div className="w-2 h-2 rounded-full bg-blue-500" />
                            <span className="text-[10px] text-gray-600">Self-Picked</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <div className="w-2 h-2 rounded-full bg-gray-400" />
                            <span className="text-[10px] text-gray-600">Assigned</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Category Breakdown */}
                    {(() => {
                      const dayTickets = technician.ticketsOnDate || [];
                      if (dayTickets.length === 0) return null;
                      const categoryMap = {};
                      dayTickets.forEach(t => {
                        const cat = t.ticketCategory || 'Uncategorized';
                        categoryMap[cat] = (categoryMap[cat] || 0) + 1;
                      });
                      const sorted = Object.entries(categoryMap).sort((a, b) => b[1] - a[1]);
                      return (
                        <div>
                          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Categories</h3>
                          <div className="flex flex-wrap gap-1.5">
                            {sorted.map(([cat, count]) => (
                              <span key={cat} className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-700 rounded-full text-xs border border-gray-200">
                                {cat}
                                <span className="font-bold text-gray-900">{count}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Ticket Status Breakdown */}
                    {(() => {
                      const dayTickets = technician.ticketsOnDate || [];
                      if (dayTickets.length === 0) return null;
                      const statusMap = {};
                      dayTickets.forEach(t => {
                        const status = t.status || 'Unknown';
                        statusMap[status] = (statusMap[status] || 0) + 1;
                      });
                      const statusOrder = ['Open', 'Pending', 'Resolved', 'Closed'];
                      const sorted = Object.entries(statusMap).sort((a, b) => {
                        const ai = statusOrder.indexOf(a[0]);
                        const bi = statusOrder.indexOf(b[0]);
                        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
                      });
                      return (
                        <div>
                          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Ticket Statuses</h3>
                          <div className="flex flex-wrap gap-1.5">
                            {sorted.map(([status, count]) => (
                              <span key={status} className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs border ${STATUS_COLORS[status] || 'bg-gray-100 text-gray-700 border-gray-200'}`}>
                                {status}
                                <span className="font-bold">{count}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>
            ) : activeTab === 'coverage' ? (
              /* Coverage Analysis Tab — two-column picked / not-picked with exclude filters */
              <div className="space-y-4">
                {(() => {
                  const av = technician.avoidance;
                  const freshdomain = import.meta.env.VITE_FRESHSERVICE_DOMAIN || 'efusion.freshservice.com';

                  if (!av) {
                    return (
                      <div className="text-center py-8">
                        <p className="text-gray-500 text-sm">Coverage data is loading or unavailable.</p>
                        <p className="text-gray-400 text-xs mt-1">Try refreshing the page (Ctrl+Shift+R) if this persists.</p>
                      </div>
                    );
                  }
                  if (!av.applicable) {
                    return (
                      <div className="text-center py-8">
                        <p className="text-gray-500 text-sm">
                          {av.reason === 'weekend'
                            ? 'No coverage window for weekends.'
                            : 'Coverage analysis is not available for this period.'}
                        </p>
                      </div>
                    );
                  }

                  const { totals, days } = av;

                  const allPicked = days.flatMap(d =>
                    (d.tickets || []).filter(t => t.pickedByTech).map(t => ({ ...t, _day: d.date })),
                  );
                  const allNotPicked = days.flatMap(d =>
                    (d.tickets || []).filter(t => !t.pickedByTech).map(t => ({ ...t, _day: d.date })),
                  );

                  const notPickedCategories = [...new Set(allNotPicked.map(t => t.ticketCategory).filter(Boolean))].sort();

                  const filteredNotPicked = allNotPicked.filter(t => {
                    if (coverageExcludedCats.has(t.ticketCategory)) return false;
                    if (coverageExcludeText) {
                      const q = coverageExcludeText.toLowerCase();
                      if (t.subject?.toLowerCase().includes(q)) return false;
                    }
                    return true;
                  });
                  const excludedCount = allNotPicked.length - filteredNotPicked.length;

                  const isOvernight = (ticket) => {
                    if (!ticket._day) return true;
                    const cutoff = new Date(ticket._day + 'T10:00:00Z');
                    return new Date(ticket.createdAt) < cutoff;
                  };

                  const TimeIcon = ({ ticket }) => {
                    const overnight = isOvernight(ticket);
                    return overnight
                      ? <Moon className="w-3 h-3 text-indigo-400 flex-shrink-0" title="Overnight (before 5 AM ET)" />
                      : <Sunrise className="w-3 h-3 text-amber-500 flex-shrink-0" title="Early morning (5 AM ET+)" />;
                  };

                  const fmtWait = (ticket) => {
                    if (!ticket.firstAssignedAt) return null;
                    const diffMs = new Date(ticket.firstAssignedAt) - new Date(ticket.createdAt);
                    if (diffMs < 0) return null;
                    const mins = Math.floor(diffMs / 60000);
                    if (mins < 60) return `${mins}m`;
                    const hrs = Math.floor(mins / 60);
                    const rm = mins % 60;
                    if (hrs < 24) return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`;
                    const days = Math.floor(hrs / 24);
                    const rh = hrs % 24;
                    return rh > 0 ? `${days}d${rh}h` : `${days}d`;
                  };

                  const CoverageTicketRow = ({ ticket, showAssignee, onExcludeCategory }) => {
                    const wait = fmtWait(ticket);
                    return (
                      <div className={`border rounded overflow-hidden hover:shadow-sm transition-all ${isOvernight(ticket) ? 'bg-slate-50 border-gray-200' : 'bg-amber-50/40 border-amber-200'}`}>
                        <div className="flex items-stretch">
                          <div className={`${PRIORITY_STRIP_COLORS[ticket.priority] || 'bg-gray-400'} w-1 flex-shrink-0`}></div>
                          <div className="flex-1 px-2 py-1.5 flex items-center gap-1.5 min-w-0">
                            <TimeIcon ticket={ticket} />
                            <a
                              href={`https://${freshdomain}/a/tickets/${ticket.freshserviceTicketId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:text-blue-800 flex-shrink-0"
                              title={`#${ticket.freshserviceTicketId}`}
                            >
                              <ExternalLink className="w-3 h-3" />
                            </a>
                            <span className="text-gray-900 font-medium text-xs truncate min-w-0 flex-1">{ticket.subject}</span>
                            <span className={`${STATUS_COLORS[ticket.status] || 'bg-gray-100 text-gray-700'} px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0`}>
                              {ticket.status}
                            </span>
                            {ticket.ticketCategory && (
                              <button
                                onClick={onExcludeCategory ? (e) => { e.stopPropagation(); onExcludeCategory(ticket.ticketCategory); } : undefined}
                                className={`px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 truncate max-w-[90px] ${onExcludeCategory ? 'bg-blue-50 text-blue-700 hover:bg-red-50 hover:text-red-600 hover:line-through cursor-pointer' : 'bg-blue-50 text-blue-700'}`}
                                title={onExcludeCategory ? `Click to hide "${ticket.ticketCategory}"` : ticket.ticketCategory}
                              >
                                {ticket.ticketCategory}
                              </button>
                            )}
                            {showAssignee && ticket.assignedTechName && (
                              <span className="text-orange-700 font-semibold text-[10px] flex-shrink-0 whitespace-nowrap">
                                → {ticket.assignedTechName}
                              </span>
                            )}
                            {wait && (
                              <span className="bg-purple-50 text-purple-700 border border-purple-200 px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 whitespace-nowrap" title="Time from creation to first assignment">
                                ⏱ {wait}
                              </span>
                            )}
                            <span className="text-gray-400 text-[10px] flex-shrink-0 whitespace-nowrap">
                              {new Date(ticket.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  };

                  return (
                    <>
                      {/* Summary Cards */}
                      <div className="grid grid-cols-3 gap-3">
                        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 text-center">
                          <div className="text-2xl font-bold text-gray-900">{totals.eligible}</div>
                          <div className="text-xs text-gray-500 uppercase font-medium mt-1">Eligible (overnight)</div>
                        </div>
                        <div className="bg-white rounded-lg shadow-sm border-2 border-green-300 p-4 text-center">
                          <div className="text-2xl font-bold text-green-700">{totals.picked}</div>
                          <div className="text-xs text-gray-500 uppercase font-medium mt-1">Picked by {technician.name?.split(' ')[0]}</div>
                        </div>
                        <div className="bg-white rounded-lg shadow-sm border-2 border-orange-300 p-4 text-center">
                          <div className="text-2xl font-bold text-orange-700">{totals.notPicked}</div>
                          <div className="text-xs text-gray-500 uppercase font-medium mt-1">Not Picked</div>
                        </div>
                      </div>

                      {/* Daily Breakdown (weekly view) */}
                      {days.length > 1 && (
                        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Daily Breakdown</h3>
                          <div className="grid grid-cols-5 gap-2">
                            {days.map((day) => {
                              const dayDate = new Date(day.date + 'T12:00:00');
                              const dayName = dayDate.toLocaleDateString('en-US', { weekday: 'short' });
                              const dayLabel = dayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                              const dayPicked = (day.tickets || []).filter(t => t.pickedByTech).length;
                              const dayTotal = (day.tickets || []).length;
                              const dayNotPicked = dayTotal - dayPicked;
                              const hInfo = getHolidayInfo(day.date);
                              const hTip = getHolidayTooltip(day.date);
                              return (
                                <div
                                  key={day.date}
                                  className={`text-center p-3 rounded-lg border ${hInfo.isCanadian ? 'bg-rose-50 border-rose-300' : hInfo.isUS ? 'bg-indigo-50 border-indigo-200' : 'bg-gray-50 border-gray-200'}`}
                                  title={hTip || undefined}
                                >
                                  <div className={`text-[10px] font-bold uppercase ${hInfo.isCanadian ? 'text-rose-600' : hInfo.isUS ? 'text-indigo-500' : 'text-gray-500'}`}>{dayName}</div>
                                  <div className="text-[9px] text-gray-400 mb-1">{dayLabel}</div>
                                  {hInfo.isHoliday && (
                                    <div className={`text-[8px] font-semibold mb-1 truncate ${hInfo.isCanadian ? 'text-rose-600' : 'text-indigo-500'}`}>
                                      {hInfo.isCanadian ? `🍁 ${hInfo.canadianName}` : `🇺🇸 ${hInfo.usName}`}
                                    </div>
                                  )}
                                  <div className="text-lg font-bold text-gray-900">{dayTotal}</div>
                                  <div className="text-[10px] text-gray-400">eligible</div>
                                  <div className="flex items-center justify-center gap-2 mt-1.5">
                                    <span className="text-[10px] font-bold text-green-700">{dayPicked} ✓</span>
                                    <span className="text-[10px] text-gray-300">|</span>
                                    <span className="text-[10px] font-bold text-orange-700">{dayNotPicked} ✗</span>
                                  </div>
                                  <div className="text-[9px] text-gray-400 mt-1 truncate" title={day.windowLabel}>
                                    {day.windowLabel}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Single day window label */}
                      {days.length === 1 && days[0].windowLabel && (() => {
                        const dayHoliday = getHolidayInfo(days[0].date);
                        const holidayTip = getHolidayTooltip(days[0].date);
                        return (
                          <div className={`rounded-lg border px-4 py-2 ${dayHoliday.isCanadian ? 'bg-rose-50 border-rose-300' : dayHoliday.isUS ? 'bg-indigo-50 border-indigo-300' : 'bg-indigo-50 border-indigo-200'}`}>
                            <span className="text-xs text-indigo-700 font-medium">Coverage window: </span>
                            <span className="text-xs text-indigo-900 font-semibold">{days[0].windowLabel}</span>
                            {holidayTip && (
                              <span className={`ml-3 text-xs font-semibold ${dayHoliday.isCanadian ? 'text-rose-700' : 'text-indigo-600'}`}>
                                {holidayTip}
                              </span>
                            )}
                          </div>
                        );
                      })()}

                      {/* Toolbar: Merged Timeline button + Exclude filters */}
                      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3">
                        <div className="flex items-center gap-3 mb-2">
                          <button
                            onClick={() => setShowMergedTimeline(true)}
                            className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold transition-colors shadow-sm whitespace-nowrap"
                          >
                            <Layers className="w-3.5 h-3.5" />
                            Merged Timeline
                          </button>
                          <span className="text-gray-300">|</span>
                          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                            Exclude:
                          </span>
                          <div className="relative flex-1">
                            <input
                              type="text"
                              value={coverageExcludeText}
                              onChange={(e) => setCoverageExcludeText(e.target.value)}
                              placeholder="Type keyword to hide matching…"
                              className="w-full px-2.5 py-1 border border-gray-300 rounded text-xs focus:ring-1 focus:ring-orange-400 focus:border-orange-400"
                            />
                            {coverageExcludeText && (
                              <button
                                onClick={() => setCoverageExcludeText('')}
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 hover:bg-gray-100 rounded"
                              >
                                <X className="w-3 h-3 text-gray-400" />
                              </button>
                            )}
                          </div>
                          {(coverageExcludedCats.size > 0 || coverageExcludeText) && (
                            <button
                              onClick={() => { setCoverageExcludedCats(new Set()); setCoverageExcludeText(''); }}
                              className="px-2 py-1 rounded text-[10px] font-medium bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 whitespace-nowrap"
                            >
                              Clear all
                            </button>
                          )}
                        </div>
                        {notPickedCategories.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {notPickedCategories.map(cat => {
                              const isExcluded = coverageExcludedCats.has(cat);
                              const catCount = allNotPicked.filter(t => t.ticketCategory === cat).length;
                              return (
                                <button
                                  key={cat}
                                  onClick={() => {
                                    setCoverageExcludedCats(prev => {
                                      const next = new Set(prev);
                                      if (next.has(cat)) next.delete(cat);
                                      else next.add(cat);
                                      return next;
                                    });
                                  }}
                                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium border transition-all ${
                                    isExcluded
                                      ? 'bg-gray-100 text-gray-400 border-gray-200 line-through'
                                      : 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                                  }`}
                                >
                                  {cat} <span className="opacity-60">{catCount}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                        {excludedCount > 0 && (
                          <div className="mt-1.5 text-[10px] text-gray-400">
                            {excludedCount} ticket{excludedCount !== 1 ? 's' : ''} hidden by filters
                          </div>
                        )}
                      </div>

                      {/* Two-column: Picked | Not Picked — both start at the same top edge */}
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                        {/* LEFT — Picked */}
                        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3">
                          <h3 className="text-xs font-semibold text-green-700 uppercase tracking-wider mb-2 flex items-center">
                            Picked by {technician.name?.split(' ')[0]}
                            <span className="ml-2 bg-green-100 text-green-700 px-2 py-0.5 rounded-full text-xs font-semibold">
                              {allPicked.length}
                            </span>
                          </h3>
                          {allPicked.length === 0 ? (
                            <p className="text-gray-400 text-sm text-center py-6">No tickets picked up in this window.</p>
                          ) : (
                            <div className="space-y-1 max-h-[600px] overflow-y-auto">
                              {allPicked.map(t => <CoverageTicketRow key={t.id} ticket={t} showAssignee={false} />)}
                            </div>
                          )}
                        </div>

                        {/* RIGHT — Not Picked */}
                        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3">
                          <h3 className="text-xs font-semibold text-orange-700 uppercase tracking-wider mb-2 flex items-center">
                            Not Picked
                            <span className="ml-2 bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full text-xs font-semibold">
                              {filteredNotPicked.length}
                            </span>
                            {excludedCount > 0 && (
                              <span className="ml-1 text-gray-400 text-[10px] font-normal normal-case">
                                of {allNotPicked.length}
                              </span>
                            )}
                          </h3>
                          {filteredNotPicked.length === 0 ? (
                            <div className="bg-green-50 rounded-lg border border-green-200 p-4 text-center">
                              <p className="text-green-700 font-medium text-sm">
                                {allNotPicked.length === 0
                                  ? 'All eligible tickets were picked up.'
                                  : 'All tickets hidden by filters.'}
                              </p>
                            </div>
                          ) : (
                            <div className="space-y-1 max-h-[600px] overflow-y-auto">
                              {filteredNotPicked.map(t => (
                                <CoverageTicketRow
                                  key={t.id}
                                  ticket={t}
                                  showAssignee={true}
                                  onExcludeCategory={(cat) => {
                                    setCoverageExcludedCats(prev => {
                                      const next = new Set(prev);
                                      next.add(cat);
                                      return next;
                                    });
                                  }}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Legend */}
                      <div className="flex items-center gap-6 text-[10px] text-gray-400 px-1">
                        <div className="flex items-center gap-1">
                          <Moon className="w-3 h-3 text-indigo-400" />
                          <span>Overnight (before 5 AM ET)</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Sunrise className="w-3 h-3 text-amber-500" />
                          <span>Early morning (5 AM ET+)</span>
                        </div>
                        <span className="text-gray-300">|</span>
                        <span>Click a category on a ticket to exclude it</span>
                      </div>

                      {/* ── Merged Timeline Modal ── */}
                      {showMergedTimeline && (() => {
                        const techStart = technician.workStartTime || '09:00';
                        const techEnd = technician.workEndTime || '17:00';
                        const techTz = technician.timezone || 'America/Los_Angeles';

                        const extendedAll = days.flatMap(d =>
                          (d.extendedTickets || []).map(t => ({ ...t, _day: d.date, _picked: t.pickedByTech, _section: 'after9am' })),
                        );

                        const coverageAll = [
                          ...allPicked.map(t => ({ ...t, _picked: true, _section: 'coverage' })),
                          ...allNotPicked.map(t => ({ ...t, _picked: false, _section: 'coverage' })),
                        ];

                        const allMerged = [...coverageAll, ...extendedAll]
                          .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

                        const mergedFiltered = allMerged.filter(t => {
                          if (!t._picked) {
                            if (coverageExcludedCats.has(t.ticketCategory)) return false;
                            if (coverageExcludeText) {
                              const q = coverageExcludeText.toLowerCase();
                              if (t.subject?.toLowerCase().includes(q)) return false;
                            }
                          }
                          return true;
                        });

                        const mergedCategories = [...new Set(allMerged.map(t => t.ticketCategory).filter(Boolean))].sort();
                        const mergedExcludedCount = allMerged.length - mergedFiltered.length;
                        const mergedPickedCount = mergedFiltered.filter(t => t._picked).length;
                        const mergedNotPickedCount = mergedFiltered.filter(t => !t._picked).length;

                        const tzCity = techTz.split('/').pop().replace(/_/g, ' ');

                        const toUTCForDate = (dateStr, timeStr) => {
                          const [h, m] = timeStr.split(':');
                          const utc = new Date(`${dateStr}T${h}:${m}:00Z`);
                          if (techTz.includes('Toronto') || techTz.includes('New_York')) utc.setUTCHours(utc.getUTCHours() + 5);
                          else if (techTz.includes('Halifax') || techTz.includes('Moncton')) utc.setUTCHours(utc.getUTCHours() + 4);
                          else if (techTz.includes('St_Johns')) { utc.setUTCHours(utc.getUTCHours() + 3); utc.setUTCMinutes(utc.getUTCMinutes() + 30); }
                          else if (techTz.includes('Vancouver') || techTz.includes('Los_Angeles')) utc.setUTCHours(utc.getUTCHours() + 8);
                          return utc;
                        };

                        const TimelineSeparator = ({ label, color }) => (
                          <div className="flex items-center gap-2 py-1.5 my-1">
                            <div className={`flex-1 h-px ${color}`}></div>
                            <span className={`text-[10px] font-bold uppercase tracking-wider whitespace-nowrap ${color.replace('bg-', 'text-')}`}>{label}</span>
                            <div className={`flex-1 h-px ${color}`}></div>
                          </div>
                        );

                        const DayHeader = ({ dateStr, dayPicked, dayNotPicked, dayTotal }) => {
                          const d = new Date(dateStr + 'T12:00:00');
                          const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
                          const hInfo = getHolidayInfo(dateStr);
                          const hTip = getHolidayTooltip(dateStr);
                          return (
                            <div
                              className={`flex items-center gap-3 py-2 mt-3 mb-1 border-b-2 first:mt-0 ${hInfo.isCanadian ? 'border-rose-400 bg-rose-50/50' : hInfo.isUS ? 'border-indigo-400 bg-indigo-50/50' : 'border-indigo-300'}`}
                              title={hTip || undefined}
                            >
                              <CalendarDays className={`w-4 h-4 flex-shrink-0 ${hInfo.isCanadian ? 'text-rose-600' : 'text-indigo-600'}`} />
                              <span className={`text-sm font-bold ${hInfo.isCanadian ? 'text-rose-900' : 'text-indigo-900'}`}>{label}</span>
                              {hInfo.isHoliday && (
                                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${hInfo.isCanadian ? 'bg-rose-100 text-rose-700 border border-rose-300' : 'bg-indigo-100 text-indigo-700 border border-indigo-300'}`}>
                                  {hInfo.isCanadian ? `🍁 ${hInfo.canadianName}` : `🇺🇸 ${hInfo.usName}`}
                                </span>
                              )}
                              <div className="flex items-center gap-2 ml-auto text-[10px]">
                                <span className="text-gray-500">{dayTotal} eligible</span>
                                <span className="text-green-700 font-semibold">{dayPicked} picked</span>
                                <span className="text-orange-700 font-semibold">{dayNotPicked} not</span>
                              </div>
                            </div>
                          );
                        };

                        const getLocalDateLabel = (utcDate) => {
                          const d = new Date(utcDate);
                          const dow = d.getDay();
                          const isWkend = dow === 0 || dow === 6;
                          const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
                          return { label, isWkend };
                        };

                        const getPTDateStr = (utcDate) => {
                          const d = new Date(utcDate);
                          return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
                        };

                        const insertMarkersForDay = (tickets, dateStr) => {
                          const agentStart = toUTCForDate(dateStr, techStart);
                          const hqOnline = new Date(days.find(d => d.date === dateStr)?.windowEnd || `${dateStr}T17:00:00Z`);
                          const agentEnd = toUTCForDate(dateStr, techEnd);
                          const items = [];
                          let sI = false, hI = false, eI = false;
                          let lastPTDate = null;

                          for (const ticket of tickets) {
                            const created = new Date(ticket.createdAt);
                            const ptDate = getPTDateStr(created);

                            if (lastPTDate && ptDate !== lastPTDate) {
                              const { label, isWkend } = getLocalDateLabel(created);
                              const hInfo = getHolidayInfo(ptDate);
                              const holidayLabel = hInfo.isCanadian ? ` — 🍁 ${hInfo.canadianName}` : hInfo.isUS ? ` — 🇺🇸 ${hInfo.usName}` : '';
                              items.push({
                                _marker: true,
                                key: `daychange-${ptDate}`,
                                label: `${label}${isWkend ? ' (Weekend)' : ''}${holidayLabel}`,
                                color: isWkend ? 'bg-slate-400' : hInfo.isCanadian ? 'bg-rose-400' : hInfo.isUS ? 'bg-indigo-400' : 'bg-indigo-300',
                              });
                            }
                            lastPTDate = ptDate;

                            if (!sI && created >= agentStart) { items.push({ _marker: true, key: `start-${dateStr}`, label: `Agent Start — ${techStart} ${tzCity}`, color: 'bg-green-400' }); sI = true; }
                            if (!hI && created >= hqOnline) { items.push({ _marker: true, key: `hq-${dateStr}`, label: 'Vancouver Online — 9:00 AM PT', color: 'bg-blue-400' }); hI = true; }
                            if (!eI && created >= agentEnd) { items.push({ _marker: true, key: `end-${dateStr}`, label: `Agent End — ${techEnd} ${tzCity}`, color: 'bg-red-400' }); eI = true; }
                            items.push(ticket);
                          }
                          if (!sI) items.push({ _marker: true, key: `start-${dateStr}`, label: `Agent Start — ${techStart} ${tzCity}`, color: 'bg-green-400' });
                          if (!hI) items.push({ _marker: true, key: `hq-${dateStr}`, label: 'Vancouver Online — 9:00 AM PT', color: 'bg-blue-400' });
                          if (!eI) items.push({ _marker: true, key: `end-${dateStr}`, label: `Agent End — ${techEnd} ${tzCity}`, color: 'bg-red-400' });
                          return items;
                        };

                        const isWeeklyView = days.length > 1;

                        const buildTimeline = () => {
                          if (!isWeeklyView || mergedViewMode === 'combined') {
                            return insertMarkersForDay(mergedFiltered, days[0]?.date || '');
                          }
                          const result = [];
                          for (const day of days) {
                            const dayTickets = mergedFiltered.filter(t => t._day === day.date);
                            const dayPicked = dayTickets.filter(t => t._picked).length;
                            const dayTotal = dayTickets.length;
                            result.push({ _dayHeader: true, key: `dh-${day.date}`, dateStr: day.date, dayPicked, dayNotPicked: dayTotal - dayPicked, dayTotal });
                            result.push(...insertMarkersForDay(dayTickets, day.date));
                          }
                          return result;
                        };

                        const timelineItems = buildTimeline();

                        return (
                          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center p-4 pt-6 overflow-y-auto" onClick={() => setShowMergedTimeline(false)}>
                            <div className="bg-white rounded-xl shadow-2xl w-full max-w-6xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                              {/* Header with nav arrows */}
                              <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 flex-shrink-0">
                                <div className="flex items-center gap-3">
                                  <Layers className="w-5 h-5 text-indigo-600" />
                                  <div>
                                    <h2 className="text-base font-bold text-gray-900">Merged Timeline — {technician.name}</h2>
                                    <p className="text-[11px] text-gray-500">
                                      {days.length === 1 ? days[0].windowLabel : `${days[0]?.windowLabel?.split('→')[0]}→ … → ${days[days.length - 1]?.windowLabel?.split('→')[1]}`}
                                      {' '}+ extended to 5 PM PT
                                    </p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-3">
                                  {/* Rolling / Combined toggle (weekly only) */}
                                  {isWeeklyView && (
                                    <>
                                      <div className="flex bg-gray-100 rounded-lg p-0.5">
                                        <button
                                          onClick={() => setMergedViewMode('rolling')}
                                          className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-all ${mergedViewMode === 'rolling' ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
                                        >
                                          Day by Day
                                        </button>
                                        <button
                                          onClick={() => setMergedViewMode('combined')}
                                          className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-all ${mergedViewMode === 'combined' ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
                                        >
                                          Combined
                                        </button>
                                      </div>
                                      <span className="text-gray-200">|</span>
                                    </>
                                  )}
                                  {/* Prev / Next navigation */}
                                  <div className="flex items-center gap-1">
                                    <button
                                      onClick={() => { setShowMergedTimeline(false); handlePreviousDay(); setTimeout(() => setShowMergedTimeline(true), 400); }}
                                      className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
                                      title={viewMode === 'weekly' ? 'Previous week' : 'Previous day'}
                                    >
                                      <ChevronLeft className="w-5 h-5 text-gray-600" />
                                    </button>
                                    <button
                                      onClick={() => { setShowMergedTimeline(false); handleToday(); setTimeout(() => setShowMergedTimeline(true), 400); }}
                                      className="px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                                    >
                                      {viewMode === 'weekly' ? 'This Week' : 'Today'}
                                    </button>
                                    <button
                                      onClick={() => { setShowMergedTimeline(false); handleNextDay(); setTimeout(() => setShowMergedTimeline(true), 400); }}
                                      className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
                                      title={viewMode === 'weekly' ? 'Next week' : 'Next day'}
                                    >
                                      <ChevronRight className="w-5 h-5 text-gray-600" />
                                    </button>
                                  </div>
                                  <span className="text-gray-200">|</span>
                                  <div className="flex items-center gap-2 text-xs">
                                    <span className="flex items-center gap-1 text-green-700 font-semibold"><span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block"></span> Picked {mergedPickedCount}</span>
                                    <span className="flex items-center gap-1 text-gray-500 font-semibold"><span className="w-2.5 h-2.5 rounded-full bg-gray-400 inline-block"></span> Not Picked {mergedNotPickedCount}</span>
                                    {mergedExcludedCount > 0 && <span className="text-gray-400">({mergedExcludedCount} hidden)</span>}
                                  </div>
                                  <button onClick={() => setShowMergedTimeline(false)} className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors">
                                    <X className="w-5 h-5 text-gray-500" />
                                  </button>
                                </div>
                              </div>

                              {/* Filters */}
                              <div className="px-5 py-2 border-b border-gray-100 flex-shrink-0">
                                <div className="flex items-center gap-3 mb-1.5">
                                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Exclude:</span>
                                  <div className="relative flex-1">
                                    <input
                                      type="text"
                                      value={coverageExcludeText}
                                      onChange={(e) => setCoverageExcludeText(e.target.value)}
                                      placeholder="Type keyword to hide matching…"
                                      className="w-full px-2.5 py-1 border border-gray-300 rounded text-xs focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400"
                                    />
                                    {coverageExcludeText && (
                                      <button onClick={() => setCoverageExcludeText('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 hover:bg-gray-100 rounded">
                                        <X className="w-3 h-3 text-gray-400" />
                                      </button>
                                    )}
                                  </div>
                                  {(coverageExcludedCats.size > 0 || coverageExcludeText) && (
                                    <button onClick={() => { setCoverageExcludedCats(new Set()); setCoverageExcludeText(''); }} className="px-2 py-1 rounded text-[10px] font-medium bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 whitespace-nowrap">
                                      Clear all
                                    </button>
                                  )}
                                </div>
                                {mergedCategories.length > 0 && (
                                  <div className="flex flex-wrap gap-1">
                                    {mergedCategories.map(cat => {
                                      const isExcluded = coverageExcludedCats.has(cat);
                                      const catCount = allMerged.filter(t => t.ticketCategory === cat).length;
                                      return (
                                        <button
                                          key={cat}
                                          onClick={() => {
                                            setCoverageExcludedCats(prev => {
                                              const next = new Set(prev);
                                              if (next.has(cat)) next.delete(cat);
                                              else next.add(cat);
                                              return next;
                                            });
                                          }}
                                          className={`px-2 py-0.5 rounded-full text-[10px] font-medium border transition-all ${isExcluded ? 'bg-gray-100 text-gray-400 border-gray-200 line-through' : 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'}`}
                                        >
                                          {cat} <span className="opacity-60">{catCount}</span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>

                              {/* Timeline list with markers */}
                              <div className="flex-1 overflow-y-auto px-5 py-2">
                                <div className="space-y-0.5">
                                  {timelineItems.map((item, idx) => {
                                    if (item._dayHeader) {
                                      return <DayHeader key={item.key} dateStr={item.dateStr} dayPicked={item.dayPicked} dayNotPicked={item.dayNotPicked} dayTotal={item.dayTotal} />;
                                    }
                                    if (item._marker) {
                                      return <TimelineSeparator key={item.key} label={item.label} color={item.color} />;
                                    }
                                    const ticket = item;
                                    const picked = ticket._picked;
                                    const overnight = isOvernight(ticket);
                                    const wait = fmtWait(ticket);
                                    const isExtended = ticket._section === 'after9am';
                                    return (
                                      <div
                                        key={`${ticket.id}-${idx}`}
                                        className={`border rounded overflow-hidden transition-all ${
                                          picked
                                            ? (isExtended ? 'bg-green-50/40 border-green-200' : 'bg-green-50 border-green-200')
                                            : (isExtended ? 'bg-gray-50 border-gray-200 opacity-60' : 'bg-gray-100 border-gray-300 opacity-75')
                                        }`}
                                      >
                                        <div className="flex items-stretch">
                                          <div className={`${PRIORITY_STRIP_COLORS[ticket.priority] || 'bg-gray-400'} w-1 flex-shrink-0`}></div>
                                          <div className={`w-1 flex-shrink-0 ${picked ? 'bg-green-500' : 'bg-gray-400'}`}></div>
                                          <div className="flex-1 px-2 py-1.5 flex items-center gap-1.5 min-w-0">
                                            {overnight
                                              ? <Moon className="w-3 h-3 text-indigo-400 flex-shrink-0" />
                                              : <Sunrise className="w-3 h-3 text-amber-500 flex-shrink-0" />}
                                            <span className="text-gray-400 text-[10px] flex-shrink-0 whitespace-nowrap w-[68px]">
                                              {new Date(ticket.createdAt).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' })}{' '}
                                              {new Date(ticket.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' })}
                                            </span>
                                            <a
                                              href={`https://${freshdomain}/a/tickets/${ticket.freshserviceTicketId}`}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="text-blue-600 hover:text-blue-800 flex-shrink-0"
                                              title={`#${ticket.freshserviceTicketId}`}
                                            >
                                              <ExternalLink className="w-3 h-3" />
                                            </a>
                                            <span className={`font-medium text-xs truncate min-w-0 flex-1 ${picked ? 'text-gray-900' : 'text-gray-500'}`}>
                                              {ticket.subject}
                                            </span>
                                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${picked ? 'bg-green-100 text-green-800 border border-green-300' : 'bg-gray-200 text-gray-600'}`}>
                                              {picked ? `✓ ${technician.name?.split(' ')[0]}` : '✗ Not picked'}
                                            </span>
                                            <span className={`${STATUS_COLORS[ticket.status] || 'bg-gray-100 text-gray-700'} px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0`}>
                                              {ticket.status}
                                            </span>
                                            {ticket.ticketCategory && (
                                              <button
                                                onClick={() => { setCoverageExcludedCats(prev => { const n = new Set(prev); n.add(ticket.ticketCategory); return n; }); }}
                                                className="px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 truncate max-w-[100px] bg-blue-50 text-blue-700 hover:bg-red-50 hover:text-red-600 hover:line-through cursor-pointer"
                                                title={`Click to hide "${ticket.ticketCategory}"`}
                                              >
                                                {ticket.ticketCategory}
                                              </button>
                                            )}
                                            {!picked && ticket.assignedTechName && (
                                              <span className="text-orange-700 font-semibold text-[10px] flex-shrink-0 whitespace-nowrap">
                                                → {ticket.assignedTechName}
                                              </span>
                                            )}
                                            {wait && (
                                              <span className="bg-purple-50 text-purple-700 border border-purple-200 px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 whitespace-nowrap" title="Time to first assignment">
                                                ⏱ {wait}
                                              </span>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>

                              {/* Footer legend */}
                              <div className="px-5 py-2 border-t border-gray-200 flex items-center gap-6 text-[10px] text-gray-400 flex-shrink-0">
                                <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block"></span> Picked</div>
                                <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-400 inline-block"></span> Not picked</div>
                                <div className="flex items-center gap-1"><Moon className="w-3 h-3 text-indigo-400" /> Overnight</div>
                                <div className="flex items-center gap-1"><Sunrise className="w-3 h-3 text-amber-500" /> Morning</div>
                                <div className="flex items-center gap-1"><span className="w-4 h-0.5 bg-green-400 inline-block rounded"></span> Agent start</div>
                                <div className="flex items-center gap-1"><span className="w-4 h-0.5 bg-blue-400 inline-block rounded"></span> HQ online</div>
                                <div className="flex items-center gap-1"><span className="w-4 h-0.5 bg-red-400 inline-block rounded"></span> Agent end</div>
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                    </>
                  );
                })()}
              </div>
            ) : csatLoading && activeTab === 'csat' ? (
              <div className="text-center py-8">
                <div className="text-gray-400 mb-2">
                  <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-yellow-600 mx-auto"></div>
                </div>
                <p className="text-gray-600 font-medium text-sm">Loading CSAT responses...</p>
              </div>
            ) : displayedTickets.length === 0 ? (
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
                  {activeTab === 'csat' && 'No customer satisfaction responses recorded for this agent.'}
                </p>
              </div>
            ) : activeTab === 'csat' ? (
              /* CSAT Tab: Compact Card Grid */
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {displayedTickets.map((ticket) => (
                  <CSATCard key={ticket.id} ticket={ticket} />
                ))}
              </div>
            ) : (
              /* Other Tabs: List View */
              <div className="space-y-1">
                {displayedTickets.map((ticket) => (
                  <TicketCard key={ticket.id} ticket={ticket} />
                ))}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* CSAT Feedback Expansion Modal */}
      {expandedCSATTicket && (
        <div 
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setExpandedCSATTicket(null)}
        >
          <div 
            className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="sticky top-0 bg-white border-b-2 border-gray-200 p-6 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <a
                    href={`https://${import.meta.env.VITE_FRESHSERVICE_DOMAIN || 'efusion.freshservice.com'}/a/tickets/${expandedCSATTicket.freshserviceTicketId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:text-blue-800 font-bold flex items-center gap-1"
                  >
                    #{expandedCSATTicket.freshserviceTicketId}
                    <ExternalLink className="w-4 h-4" />
                  </a>
                  <span className="text-sm text-gray-600">
                    {expandedCSATTicket.csatSubmittedAt && new Date(expandedCSATTicket.csatSubmittedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                </div>
                <h3 className="font-semibold text-gray-900 text-lg">
                  {expandedCSATTicket.subject}
                </h3>
              </div>
              <button
                onClick={() => setExpandedCSATTicket(null)}
                className="text-gray-400 hover:text-gray-600 transition-colors p-2"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6">
              {/* Score Display */}
              <div className="bg-gray-50 rounded-lg p-6 mb-6 text-center">
                <div className="flex items-center justify-center gap-2 mb-3">
                  {[1, 2, 3, 4].map(i => (
                    <Star
                      key={i}
                      className={`w-8 h-8 ${i <= expandedCSATTicket.csatScore ? 'text-yellow-500 fill-yellow-500' : 'text-gray-300'}`}
                    />
                  ))}
                </div>
                <div className="flex items-center justify-center gap-4">
                  <span className="text-6xl">
                    {expandedCSATTicket.csatScore >= 4 ? '😊' : expandedCSATTicket.csatScore === 3 ? '😐' : expandedCSATTicket.csatScore === 2 ? '😕' : '😞'}
                  </span>
                  <div>
                    <div className={`text-5xl font-bold ${
                      expandedCSATTicket.csatScore >= 4 ? 'text-green-600' :
                        expandedCSATTicket.csatScore === 3 ? 'text-yellow-600' :
                          expandedCSATTicket.csatScore === 2 ? 'text-orange-600' : 'text-red-600'
                    }`}>
                      {expandedCSATTicket.csatScore}/{expandedCSATTicket.csatTotalScore || 4}
                    </div>
                    <div className="text-sm text-gray-600 uppercase font-semibold">
                      {expandedCSATTicket.csatRatingText || 'Rating'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Full Feedback */}
              <div className="mb-6">
                <h4 className="text-sm font-bold text-gray-700 mb-3 uppercase tracking-wide">
                  Customer Feedback:
                </h4>
                <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-4">
                  <p className="text-gray-800 italic leading-relaxed whitespace-pre-wrap">
                    &quot;{expandedCSATTicket.csatFeedback}&quot;
                  </p>
                </div>
              </div>

              {/* Requester Info */}
              {expandedCSATTicket.requesterName && (
                <div className="bg-gray-50 rounded-lg p-4">
                  <div className="flex items-center gap-2 text-sm">
                    <User className="w-4 h-4 text-gray-600" />
                    <span className="font-semibold text-gray-900">{expandedCSATTicket.requesterName}</span>
                    {expandedCSATTicket.requesterEmail && (
                      <span className="text-gray-500">• {expandedCSATTicket.requesterEmail}</span>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="border-t border-gray-200 p-4 bg-gray-50 flex justify-end">
              <button
                onClick={() => setExpandedCSATTicket(null)}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
