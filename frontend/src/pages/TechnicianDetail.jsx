import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useDashboard } from '../contexts/DashboardContext';
import SearchBox from '../components/SearchBox';
import CategoryFilter from '../components/CategoryFilter';
import { filterTickets } from '../utils/ticketFilter';
import ExportButton from '../components/ExportButton';
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
  ExternalLink,
} from 'lucide-react';

const PRIORITY_COLORS = {
  1: 'bg-blue-100 text-blue-800 border-blue-200',
  2: 'bg-green-100 text-green-800 border-green-200',
  3: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  4: 'bg-red-100 text-red-800 border-red-200',
};

const PRIORITY_LABELS = {
  1: 'Low',
  2: 'Medium',
  3: 'High',
  4: 'Urgent',
};

const STATUS_COLORS = {
  'Open': 'bg-red-100 text-red-800 border-red-300',
  'Pending': 'bg-yellow-100 text-yellow-800 border-yellow-300',
  'In Progress': 'bg-blue-100 text-blue-800 border-blue-300',
  'Resolved': 'bg-green-100 text-green-800 border-green-300',
  'Closed': 'bg-gray-100 text-gray-800 border-gray-300',
};

export default function TechnicianDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { getTechnician } = useDashboard();
  const [technician, setTechnician] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [highlightedSection, setHighlightedSection] = useState(null);

  // Search state - persisted in sessionStorage
  const [searchTerm, setSearchTerm] = useState(() => {
    // Priority: navigation state > sessionStorage > default
    const navSearch = location.state?.searchTerm;
    if (navSearch !== undefined) return navSearch;

    const stored = sessionStorage.getItem('techDetail_search');
    return stored || '';
  });

  // Category filter state - persisted in sessionStorage
  const [selectedCategories, setSelectedCategories] = useState(() => {
    // Priority: navigation state > sessionStorage > default
    const navCategories = location.state?.selectedCategories;
    if (navCategories !== undefined) return navCategories;

    const stored = sessionStorage.getItem('techDetail_categories');
    return stored ? JSON.parse(stored) : [];
  });

  // Helper to format date as YYYY-MM-DD in local timezone
  const formatDateLocal = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Calculate ticket age in hours
  const calculateAge = (createdAt) => {
    const created = new Date(createdAt);
    const now = new Date();
    const diffMs = now - created;
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    return `${hours}h`;
  };

  // Format resolution time from seconds (from FreshService stats)
  const formatResolutionTime = (resolutionTimeSeconds) => {
    if (!resolutionTimeSeconds || resolutionTimeSeconds === 0) return null;

    const totalMinutes = Math.floor(resolutionTimeSeconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    const minutes = totalMinutes % 60;

    // Show days, hours, and minutes (only non-zero values)
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
    if (!passedDate) return null; // Today

    // Check if it's already today
    const isCurrentDay = new Date(passedDate).toDateString() === new Date().toDateString();
    if (isCurrentDay) return null; // Today

    // Convert to YYYY-MM-DD string
    return formatDateLocal(new Date(passedDate));
  }); // null = today, string (YYYY-MM-DD) = historical date

  useEffect(() => {
    const fetchTechnician = async () => {
      try {
        setIsLoading(true);
        // selectedDate is already in YYYY-MM-DD format or null
        const data = await getTechnician(parseInt(id, 10), 'America/Los_Angeles', selectedDate);
        setTechnician(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    };

    fetchTechnician();
  }, [id, getTechnician, selectedDate]);

  // Persist search term to sessionStorage whenever it changes
  useEffect(() => {
    sessionStorage.setItem('techDetail_search', searchTerm);
  }, [searchTerm]);

  // Persist selected categories to sessionStorage whenever they change
  useEffect(() => {
    sessionStorage.setItem('techDetail_categories', JSON.stringify(selectedCategories));
  }, [selectedCategories]);

  const handleBack = () => {
    // Pass the selected date and filters back to dashboard via state
    navigate('/dashboard', {
      state: {
        returnDate: selectedDate || formatDateLocal(new Date()),
        searchTerm: searchTerm,
        selectedCategories: selectedCategories,
        viewMode: location.state?.viewMode || 'daily',
        returnWeek: location.state?.selectedWeek,
      },
    });
  };

  // Date navigation handlers
  const handlePreviousDay = () => {
    const currentDate = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();
    currentDate.setDate(currentDate.getDate() - 1);
    const newDateStr = formatDateLocal(currentDate);
    setSelectedDate(newDateStr);
  };

  const handleNextDay = () => {
    const currentDate = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();
    currentDate.setDate(currentDate.getDate() + 1);
    const newDateStr = formatDateLocal(currentDate);
    setSelectedDate(newDateStr);
  };

  const handleToday = () => {
    setSelectedDate(null);
  };

  const handleDateChange = (e) => {
    const dateValue = e.target.value;
    if (dateValue) {
      setSelectedDate(dateValue); // Already in YYYY-MM-DD format
    }
  };

  // Calculate display values
  const isToday = !selectedDate;
  const displayDate = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();
  const formattedDate = displayDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

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

  // Categorize tickets on the selected date
  const selfPickedTickets = technician.ticketsOnDate?.filter(ticket =>
    ticket.isSelfPicked || ticket.assignedBy === technician.name,
  ) || [];

  const assignedTickets = technician.ticketsOnDate?.filter(ticket =>
    !ticket.isSelfPicked && ticket.assignedBy !== technician.name,
  ) || [];

  const closedTickets = technician.closedTicketsOnDate || [];
  const openTickets = technician.openTickets || [];

  // Extract unique categories from all tickets
  const allTickets = [...selfPickedTickets, ...assignedTickets, ...closedTickets, ...openTickets];
  const categorySet = new Set();
  allTickets.forEach(ticket => {
    if (ticket.ticketCategory) {
      categorySet.add(ticket.ticketCategory);
    }
  });
  const availableCategories = Array.from(categorySet).sort();

  // Apply filters to all ticket arrays using centralized filter utility
  // This supports AND/OR search syntax (spaces = AND, OR/| = OR)
  const filteredSelfPickedTickets = filterTickets(selfPickedTickets, searchTerm, selectedCategories);
  const filteredAssignedTickets = filterTickets(assignedTickets, searchTerm, selectedCategories);
  const filteredClosedTickets = filterTickets(closedTickets, searchTerm, selectedCategories);
  const filteredOpenTickets = filterTickets(openTickets, searchTerm, selectedCategories);

  // Calculate total results count
  const searchResultsCount = (searchTerm || selectedCategories.length > 0)
    ? filteredSelfPickedTickets.length + filteredAssignedTickets.length + filteredClosedTickets.length + filteredOpenTickets.length
    : 0;

  const loadLevelColors = {
    light: 'bg-green-100 text-green-800',
    medium: 'bg-yellow-100 text-yellow-800',
    heavy: 'bg-red-100 text-red-800',
  };

  // Stat card click handlers
  const handleStatClick = (section) => {
    setHighlightedSection(section);
    // Scroll to section
    const element = document.getElementById(section);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Clear highlight after 2 seconds
      setTimeout(() => setHighlightedSection(null), 2000);
    }
  };

  // Compact Ticket Card Component
  const TicketCard = ({ ticket, showAssignmentBadge = false }) => {
    calculateAge(ticket.createdAt);
    const pickupTime = calculatePickupTime(ticket.createdAt, ticket.firstAssignedAt);
    const resolutionTime = formatResolutionTime(ticket.resolutionTimeSeconds);
    const isOpen = ticket.status === 'Open';
    const isPending = ticket.status === 'Pending';
    const isClosed = ticket.status === 'Closed' || ticket.status === 'Resolved';

    // Check if ticket is self-assigned (same logic as dashboard)
    const isSelfAssigned = ticket.isSelfPicked || ticket.assignedBy === technician.name;

    return (
      <div className={`border rounded-lg p-3 hover:shadow-md transition-shadow ${
        isOpen ? 'bg-red-50 border-red-200' : isPending ? 'bg-yellow-50 border-yellow-200' : 'bg-white'
      }`}>
        {/* Header Row: Status, Priority, Assignment, ID */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5">
            <span className={`${STATUS_COLORS[ticket.status]} px-2 py-0.5 rounded text-[10px] font-semibold border`}>
              {ticket.status}
            </span>
            <span className={`${PRIORITY_COLORS[ticket.priority]} px-2 py-0.5 rounded text-[10px] font-medium border`}>
              {PRIORITY_LABELS[ticket.priority]}
            </span>
            {showAssignmentBadge && isSelfAssigned && (
              <span className="bg-purple-200 text-purple-900 px-2 py-0.5 rounded text-[10px] font-medium">
                SELF
              </span>
            )}
            {showAssignmentBadge && !isSelfAssigned && ticket.assignedBy && ticket.assignedBy !== technician.name && (
              <span className="bg-orange-200 text-orange-900 px-2 py-0.5 rounded text-[10px] font-medium">
                by {ticket.assignedBy.split(' ')[0]}
              </span>
            )}
          </div>
          <a
            href={`https://it.bgcengineering.ca/a/tickets/${ticket.freshserviceTicketId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-blue-600 hover:text-blue-800 font-mono hover:underline flex items-center gap-0.5"
            title="Open in FreshService"
          >
            #{ticket.freshserviceTicketId?.toString()}
            <ExternalLink className="w-2.5 h-2.5" />
          </a>
        </div>

        {/* Category Row - Separate line for visibility */}
        {ticket.ticketCategory && (
          <div className="mb-2">
            <span className="bg-indigo-100 text-indigo-800 px-2 py-1 rounded text-xs font-medium border border-indigo-300 inline-block">
              📂 {ticket.ticketCategory}
            </span>
          </div>
        )}

        {/* Subject - Clickable */}
        <a
          href={`https://it.bgcengineering.ca/a/tickets/${ticket.freshserviceTicketId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="block hover:text-blue-600 transition-colors"
        >
          <h3 className="font-semibold text-sm mb-2 line-clamp-2 leading-tight">
            {ticket.subject}
          </h3>
        </a>

        {/* Requester - Prominent Display */}
        {ticket.requesterName && (
          <div className="bg-blue-50 border border-blue-200 rounded px-2 py-1.5 mb-2">
            <div className="flex items-center gap-1.5">
              <User className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-blue-900 truncate">
                  {ticket.requesterName}
                </p>
                {ticket.requesterEmail && (
                  <p className="text-[10px] text-blue-700 truncate">
                    {ticket.requesterEmail}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Metrics Row */}
        <div className="grid grid-cols-3 gap-2 text-[10px]">
          {/* Pickup Time - Only show if we have the data */}
          {pickupTime && (
            <div className="bg-green-50 rounded px-2 py-1">
              <p className="text-gray-500 mb-0.5">Pickup Time</p>
              <p className="font-semibold text-green-700">{pickupTime}</p>
            </div>
          )}

          {/* Resolution Time - Show for closed tickets */}
          {isClosed && resolutionTime && (
            <div className="bg-blue-50 rounded px-2 py-1">
              <p className="text-gray-500 mb-0.5">Resolution</p>
              <p className="font-semibold text-blue-700">{resolutionTime}</p>
            </div>
          )}

          {/* Time Spent - Show if available */}
          {formatTimeSpent(ticket.timeSpentMinutes) && (
            <div className="bg-purple-50 rounded px-2 py-1">
              <p className="text-gray-500 mb-0.5">Time Spent</p>
              <p className="font-semibold text-purple-700">{formatTimeSpent(ticket.timeSpentMinutes)}</p>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Compact Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-[1920px] mx-auto px-4 py-3">
          <button
            onClick={handleBack}
            className="flex items-center gap-1 text-blue-600 hover:text-blue-700 mb-2 text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </button>

          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="bg-blue-100 rounded-full p-2">
                <User className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-gray-800">
                  {technician.name}
                </h1>
                <div className="flex items-center gap-3 text-xs text-gray-600">
                  {technician.email && (
                    <div className="flex items-center gap-1">
                      <Mail className="w-3 h-3" />
                      <span>{technician.email}</span>
                    </div>
                  )}
                  {technician.timezone && (
                    <div className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      <span>{technician.timezone}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Export Button */}
              <ExportButton
                tickets={[...filteredSelfPickedTickets, ...filteredAssignedTickets, ...filteredClosedTickets, ...filteredOpenTickets]}
                technicians={[technician]}
                viewMode={technician.name}
                selectedDate={new Date(selectedDate)}
              />

              {isToday && (
                <div className={`${loadLevelColors[technician.loadLevel]} px-2 py-1 rounded text-xs font-semibold`}>
                  {technician.loadLevel.toUpperCase()}
                </div>
              )}
            </div>
          </div>

          {/* Compact Date Navigation */}
          <div className="flex items-center justify-between bg-gray-50 rounded p-2 border">
            <div className="flex items-center gap-2">
              <button
                onClick={handlePreviousDay}
                className="p-1 hover:bg-white rounded border"
                title="Previous Day"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={handleNextDay}
                className="p-1 hover:bg-white rounded border"
                title="Next Day"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-1 px-2 py-1 bg-white rounded border">
                <Calendar className="w-3 h-3 text-gray-600" />
                <input
                  type="date"
                  value={selectedDate || formatDateLocal(new Date())}
                  onChange={handleDateChange}
                  className="border-none outline-none text-xs font-medium cursor-pointer"
                />
              </div>
              <div className="text-xs font-medium text-gray-700">
                {formattedDate}
              </div>
            </div>
            {!isToday && (
              <button
                onClick={handleToday}
                className="px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 text-xs font-medium"
              >
                Today
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content - Compact */}
      <main className="max-w-[1920px] mx-auto px-4 py-4">
        {/* Compact Statistics Cards - Clickable */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3">
          <div
            onClick={() => handleStatClick('self-picked-section')}
            className="bg-white rounded border p-2 cursor-pointer hover:shadow-md transition-shadow"
          >
            <p className="text-[10px] text-gray-600 mb-0.5">Self-Picked</p>
            <p className="text-xl font-bold text-purple-600">{selfPickedTickets.length}</p>
          </div>

          <div
            onClick={() => handleStatClick('assigned-section')}
            className="bg-white rounded border p-2 cursor-pointer hover:shadow-md transition-shadow"
          >
            <p className="text-[10px] text-gray-600 mb-0.5">Assigned</p>
            <p className="text-xl font-bold text-orange-600">{assignedTickets.length}</p>
          </div>

          <div
            onClick={() => handleStatClick('closed-section')}
            className="bg-white rounded border p-2 cursor-pointer hover:shadow-md transition-shadow"
          >
            <p className="text-[10px] text-gray-600 mb-0.5">
              {isToday ? 'Closed Today' : 'Closed on Date'}
            </p>
            <p className="text-xl font-bold text-green-600">{closedTickets.length}</p>
          </div>

          <div
            onClick={() => handleStatClick('created-section')}
            className="bg-white rounded border p-2 cursor-pointer hover:shadow-md transition-shadow"
          >
            <p className="text-[10px] text-gray-600 mb-0.5">
              {isToday ? 'Created Today' : 'Created on Date'}
            </p>
            <p className="text-xl font-bold text-blue-600">{technician.totalTicketsOnDate || 0}</p>
          </div>

          <div
            onClick={() => handleStatClick('open-section')}
            className="bg-white rounded border p-2 cursor-pointer hover:shadow-md transition-shadow"
          >
            <p className="text-[10px] text-gray-600 mb-0.5">
              {isToday ? 'Open Tickets' : 'Open on Date'}
            </p>
            <p className="text-xl font-bold text-yellow-600">{openTickets.length}</p>
            {!isToday && (
              <p className="text-[8px] text-gray-500">Approx.</p>
            )}
          </div>
        </div>

        {/* Search and Filter Controls - Always visible */}
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

        {/* Self-Picked Tickets */}
        <div
          id="self-picked-section"
          className={`bg-white rounded border p-3 mb-3 transition-all ${
            highlightedSection === 'self-picked-section' ? 'ring-2 ring-purple-400' : ''
          }`}
        >
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-1">
            <Star className="w-4 h-4 text-purple-600 fill-purple-600" />
            Self-Picked Tickets ({searchTerm ? `${filteredSelfPickedTickets.length} of ${selfPickedTickets.length}` : selfPickedTickets.length})
          </h2>
          {filteredSelfPickedTickets.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {filteredSelfPickedTickets.map((ticket) => (
                <TicketCard key={ticket.id} ticket={ticket} showAssignmentBadge={true} />
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-gray-500 text-xs">
              {searchTerm ? 'No matching tickets' : 'No self-picked tickets on this date'}
            </div>
          )}
        </div>

        {/* Assigned Tickets */}
        <div
          id="assigned-section"
          className={`bg-white rounded border p-3 mb-3 transition-all ${
            highlightedSection === 'assigned-section' ? 'ring-2 ring-orange-400' : ''
          }`}
        >
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-1">
            <User className="w-4 h-4 text-orange-600" />
            Assigned Tickets ({searchTerm ? `${filteredAssignedTickets.length} of ${assignedTickets.length}` : assignedTickets.length})
          </h2>
          {filteredAssignedTickets.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {filteredAssignedTickets.map((ticket) => (
                <TicketCard key={ticket.id} ticket={ticket} showAssignmentBadge={true} />
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-gray-500 text-xs">
              {searchTerm ? 'No matching tickets' : 'No assigned tickets on this date'}
            </div>
          )}
        </div>

        {/* Closed Tickets */}
        <div
          id="closed-section"
          className={`bg-white rounded border p-3 mb-3 transition-all ${
            highlightedSection === 'closed-section' ? 'ring-2 ring-green-400' : ''
          }`}
        >
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-1">
            <CheckCircle className="w-4 h-4 text-green-600" />
            {isToday ? 'Closed Today' : `Closed on ${formattedDate}`} ({searchTerm ? `${filteredClosedTickets.length} of ${closedTickets.length}` : closedTickets.length})
          </h2>
          {filteredClosedTickets.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {filteredClosedTickets.map((ticket) => (
                <TicketCard key={ticket.id} ticket={ticket} showAssignmentBadge={false} />
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-gray-500 text-xs">
              {searchTerm ? 'No matching tickets' : 'No tickets closed on this date'}
            </div>
          )}
        </div>

        {/* Created Tickets (for reference) */}
        <div
          id="created-section"
          className={`bg-white rounded border p-3 mb-3 transition-all ${
            highlightedSection === 'created-section' ? 'ring-2 ring-blue-400' : ''
          }`}
        >
          <h2 className="text-sm font-semibold mb-2">
            {isToday ? 'All Tickets Created Today' : `All Tickets Created on ${formattedDate}`} ({technician.totalTicketsOnDate || 0})
          </h2>
          <p className="text-xs text-gray-600 mb-2">
            This includes both self-picked and assigned tickets listed above.
          </p>
        </div>

        {/* Open Tickets - Moved to Bottom */}
        <div
          id="open-section"
          className={`bg-white rounded border p-3 transition-all ${
            highlightedSection === 'open-section' ? 'ring-2 ring-yellow-400' : ''
          }`}
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">
              {isToday ? 'Current Open Tickets' : `Tickets Open on ${formattedDate}`} ({searchTerm ? `${filteredOpenTickets.length} of ${openTickets.length}` : openTickets.length})
            </h2>
            {!isToday && (
              <span className="text-[10px] text-gray-500 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200">
                Approximated
              </span>
            )}
          </div>
          {filteredOpenTickets.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {filteredOpenTickets.map((ticket) => (
                <TicketCard key={ticket.id} ticket={ticket} showAssignmentBadge={false} />
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-gray-500 text-xs">
              <CheckCircle className="w-8 h-8 mx-auto mb-2 text-gray-400" />
              <p>{searchTerm ? 'No matching tickets' : isToday ? 'No open tickets' : 'No tickets were open on this date'}</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
