/**
 * Centralized ticket filtering utility
 * Used consistently across Dashboard, TechnicianDetail, and all other views
 *
 * This ensures filtering logic is DRY and consistent everywhere
 */

/**
 * Filter tickets by search term and selected categories
 * @param {Array} tickets - Array of ticket objects
 * @param {string} searchTerm - Search term to match against ticket fields
 * @param {Array} selectedCategories - Array of selected category names to filter by
 * @returns {Array} Filtered tickets matching all criteria
 */
export const filterTickets = (tickets = [], searchTerm = '', selectedCategories = []) => {
  if (!tickets || tickets.length === 0) return [];

  let filtered = [...tickets];

  // Step 1: Apply search filter (searches across multiple fields)
  if (searchTerm && searchTerm.trim()) {
    const searchLower = searchTerm.toLowerCase().trim();
    filtered = filtered.filter(ticket => {
      if (!ticket) return false;

      // Search in all these fields (OR logic - match any one)
      const subjectMatch = ticket.subject?.toLowerCase().includes(searchLower);
      const ticketIdMatch = ticket.freshserviceTicketId?.toString().includes(searchTerm);
      const requesterMatch = ticket.requesterName?.toLowerCase().includes(searchLower);
      const categoryMatch = ticket.ticketCategory?.toLowerCase().includes(searchLower);

      return subjectMatch || ticketIdMatch || requesterMatch || categoryMatch;
    });
  }

  // Step 2: Apply category filter (AND logic - must match selected categories)
  if (selectedCategories && selectedCategories.length > 0) {
    filtered = filtered.filter(ticket => {
      if (!ticket) return false;
      return selectedCategories.includes(ticket.ticketCategory);
    });
  }

  return filtered;
};

/**
 * Apply filters to a technician's tickets and calculate filtered stats
 * @param {Object} technician - Technician object with ticket arrays
 * @param {string} searchTerm - Search term to match
 * @param {Array} selectedCategories - Selected categories to filter by
 * @param {boolean} isWeeklyView - Whether this is weekly view (affects which ticket field to use)
 * @returns {Object} Filtered tickets and calculated stats
 */
export const filterTechnicianTickets = (technician, searchTerm = '', selectedCategories = [], isWeeklyView = false) => {
  if (!technician) return { filtered: [], stats: {} };

  // Get the appropriate ticket array based on view mode
  const ticketsToFilter = isWeeklyView
    ? (technician.weeklyTickets || [])
    : (technician.tickets || []);

  // Apply filters using centralized function
  const filteredTickets = filterTickets(ticketsToFilter, searchTerm, selectedCategories);

  // Calculate stats from filtered tickets
  const stats = calculateFilteredStats(filteredTickets);

  return {
    filtered: filteredTickets,
    stats: stats,
    count: filteredTickets.length,
  };
};

/**
 * Calculate statistics from a filtered ticket array
 * @param {Array} tickets - Filtered tickets
 * @returns {Object} Statistics object
 */
export const calculateFilteredStats = (tickets = []) => {
  if (!tickets || tickets.length === 0) {
    return {
      openOnlyCount: 0,
      pendingCount: 0,
      selfPickedCount: 0,
      assignedCount: 0,
      closedCount: 0,
    };
  }

  const openOnlyCount = tickets.filter(t => t.status === 'Open').length;
  const pendingCount = tickets.filter(t => t.status === 'Pending').length;
  const selfPickedCount = tickets.filter(t => t.isSelfPicked || t.assignedBy === tickets[0]?.assignedTech?.name).length;
  const assignedCount = tickets.filter(t => !t.isSelfPicked && t.assignedBy && t.assignedBy !== tickets[0]?.assignedTech?.name).length;
  const closedCount = tickets.filter(t => ['Closed', 'Resolved'].includes(t.status)).length;

  return {
    openOnlyCount,
    pendingCount,
    selfPickedCount,
    assignedCount,
    closedCount,
  };
};

/**
 * Get available categories from a ticket array
 * @param {Array} tickets - Array of tickets
 * @returns {Array} Sorted unique category names
 */
export const getAvailableCategories = (tickets = []) => {
  if (!tickets || tickets.length === 0) return [];

  const categorySet = new Set();
  tickets.forEach(ticket => {
    if (ticket && ticket.ticketCategory) {
      categorySet.add(ticket.ticketCategory);
    }
  });

  return Array.from(categorySet).sort();
};

/**
 * Calculate total results count from filtered technicians
 * @param {Array} technicians - Array of technician objects with filtering applied
 * @returns {number} Total number of matching tickets across all technicians
 */
export const calculateResultsCount = (technicians = [], isWeeklyView = false) => {
  if (!technicians || technicians.length === 0) return 0;

  return technicians.reduce((total, tech) => {
    if (!tech) return total;
    const ticketField = isWeeklyView ? 'weeklyTickets' : 'tickets';
    const tickets = tech[ticketField] || [];
    return total + tickets.length;
  }, 0);
};

export default {
  filterTickets,
  filterTechnicianTickets,
  calculateFilteredStats,
  getAvailableCategories,
  calculateResultsCount,
};
