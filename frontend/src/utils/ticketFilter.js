/**
 * Centralized ticket filtering utility
 * Used consistently across Dashboard, TechnicianDetail, and all other views
 *
 * This ensures filtering logic is DRY and consistent everywhere
 * 
 * Search syntax:
 * - Spaces = AND: "vpn laptop" matches tickets with BOTH terms
 * - OR or | = OR: "vpn OR printer" or "vpn | printer" matches tickets with EITHER term
 * - Combined: "vpn laptop OR printer" means "(vpn AND laptop) OR printer"
 */

/**
 * Parse a search query into AND/OR groups
 * @param {string} searchTerm - Raw search input from user
 * @returns {Array<Array<string>>} Array of AND-groups, where groups are OR-ed together
 * 
 * Examples:
 * - "vpn" → [["vpn"]]
 * - "vpn laptop" → [["vpn", "laptop"]] (AND)
 * - "vpn OR printer" → [["vpn"], ["printer"]] (OR)
 * - "vpn laptop OR printer" → [["vpn", "laptop"], ["printer"]]
 * - "vpn | printer | network" → [["vpn"], ["printer"], ["network"]]
 */
export const parseSearchQuery = (searchTerm = '') => {
  if (!searchTerm || !searchTerm.trim()) {
    return [];
  }

  // Split by OR or | (case insensitive for OR)
  // Use regex to split by " OR " or " | " or just "|"
  const orGroups = searchTerm
    .split(/\s+OR\s+|\s*\|\s*/i)
    .map(group => group.trim())
    .filter(group => group.length > 0);

  // For each OR group, split by spaces to get AND terms
  const parsedQuery = orGroups.map(group => {
    return group
      .toLowerCase()
      .split(/\s+/)
      .filter(term => term.length > 0);
  }).filter(group => group.length > 0);

  return parsedQuery;
};

export const getTicketCategoryLabel = (ticket, categoryMode = ticket?.categoryMode) => {
  if (!ticket) return '';
  if (categoryMode === 'legacy') return ticket.ticketCategory || ticket.categoryLabel || '';
  if (ticket.categoryLabel) return ticket.categoryLabel;
  if (ticket.canonicalCategory) return ticket.canonicalCategory;
  if (ticket.canonicalSkill) return ticket.canonicalSkill;
  if (ticket.internalCategory?.name || ticket.internalSubcategory?.name) {
    return [ticket.internalCategory?.name, ticket.internalSubcategory?.name].filter(Boolean).join(' / ');
  }
  if (ticket.skill || ticket.subskill) return [ticket.skill, ticket.subskill].filter(Boolean).join(' / ');
  if (ticket.tpSkill || ticket.tpSubskill) return [ticket.tpSkill, ticket.tpSubskill].filter(Boolean).join(' / ');
  return ticket.ticketCategory || '';
};

export const getTicketCategoryParts = (ticket, categoryMode = ticket?.categoryMode) => {
  if (!ticket) {
    return {
      categoryMode: categoryMode || 'legacy',
      categoryId: null,
      subcategoryId: null,
      categoryName: null,
      subcategoryName: null,
      categoryLabel: '',
      legacyCategory: null,
    };
  }

  if (categoryMode === 'legacy') {
    const label = ticket.ticketCategory || ticket.categoryLabel || '';
    return {
      categoryMode: 'legacy',
      categoryId: null,
      subcategoryId: null,
      categoryName: label || null,
      subcategoryName: null,
      categoryLabel: label,
      legacyCategory: label || null,
    };
  }

  const categoryName = ticket.categoryName || ticket.internalCategory?.name || ticket.skill || ticket.tpSkill || null;
  const subcategoryName = ticket.subcategoryName || ticket.internalSubcategory?.name || ticket.subskill || ticket.tpSubskill || null;
  return {
    categoryMode: 'canonical',
    categoryId: ticket.categoryId ?? ticket.internalCategoryId ?? ticket.internalCategory?.id ?? null,
    subcategoryId: ticket.subcategoryId ?? ticket.internalSubcategoryId ?? ticket.internalSubcategory?.id ?? null,
    categoryName,
    subcategoryName,
    categoryLabel: ticket.categoryLabel || getTicketCategoryLabel(ticket, 'canonical'),
    legacyCategory: ticket.legacyCategory || ticket.ticketCategory || null,
  };
};

export const buildCategoryFilterState = ({
  mode = 'legacy',
  categoryIds = [],
  subcategoryIds = [],
  legacyCategories = [],
} = {}) => ({
  mode,
  categoryIds: categoryIds.map(Number).filter(Number.isInteger),
  subcategoryIds: subcategoryIds.map(Number).filter(Number.isInteger),
  legacyCategories: legacyCategories.map(String).filter(Boolean),
});

export const normalizeCategoryFilterState = (selectedCategories = [], categoryMode = 'legacy') => {
  if (selectedCategories && !Array.isArray(selectedCategories) && typeof selectedCategories === 'object') {
    return buildCategoryFilterState({
      mode: selectedCategories.mode || categoryMode,
      categoryIds: selectedCategories.categoryIds || [],
      subcategoryIds: selectedCategories.subcategoryIds || [],
      legacyCategories: selectedCategories.legacyCategories || selectedCategories.categories || [],
    });
  }
  return buildCategoryFilterState({
    mode: categoryMode,
    legacyCategories: Array.isArray(selectedCategories) ? selectedCategories : [],
  });
};

export const hasCategoryFilters = (filterState = {}) => {
  const normalized = normalizeCategoryFilterState(filterState, filterState?.mode || 'legacy');
  return normalized.categoryIds.length > 0
    || normalized.subcategoryIds.length > 0
    || normalized.legacyCategories.length > 0;
};

export const ticketMatchesCategoryFilters = (ticket, filterState = {}) => {
  const normalized = normalizeCategoryFilterState(filterState, filterState?.mode || ticket?.categoryMode || 'legacy');
  if (!hasCategoryFilters(normalized)) return true;

  if (normalized.mode === 'canonical') {
    const parts = getTicketCategoryParts(ticket, 'canonical');
    const hasCategoryIds = normalized.categoryIds.length > 0;
    const hasSubcategoryIds = normalized.subcategoryIds.length > 0;
    const matchesCategory = hasCategoryIds && normalized.categoryIds.includes(Number(parts.categoryId));
    const matchesSubcategory = hasSubcategoryIds && normalized.subcategoryIds.includes(Number(parts.subcategoryId));

    if (hasCategoryIds && hasSubcategoryIds) return matchesCategory || matchesSubcategory;
    if (hasCategoryIds) return matchesCategory;
    if (hasSubcategoryIds) return matchesSubcategory;
    return true;
  }

  return normalized.legacyCategories.includes(getTicketCategoryLabel(ticket, 'legacy'));
};

/**
 * Check if a ticket matches the parsed query
 * @param {Object} ticket - Ticket object to check
 * @param {Array<Array<string>>} parsedQuery - Parsed query from parseSearchQuery
 * @param {string} originalSearchTerm - Original search term (for ticket ID matching which is case-sensitive)
 * @returns {boolean} True if ticket matches any OR group (where all AND terms in that group match)
 */
export const ticketMatchesQuery = (ticket, parsedQuery, _originalSearchTerm = '', categoryMode = ticket?.categoryMode) => {
  if (!ticket || !parsedQuery || parsedQuery.length === 0) {
    return true; // No query = match all
  }

  // Build searchable text from ticket fields (lowercase for comparison)
  const searchableText = [
    ticket.subject || '',
    ticket.requesterName || '',
    getTicketCategoryLabel(ticket, categoryMode),
    ticket.ticketCategory || '',
  ].join(' ').toLowerCase();

  // Ticket ID needs special handling (can be numeric, case-sensitive check)
  const ticketIdStr = ticket.freshserviceTicketId?.toString() || '';

  // Check each OR group - ticket matches if ANY group matches
  return parsedQuery.some(andGroup => {
    // For this AND group, ALL terms must match
    return andGroup.every(term => {
      // Check if term matches any searchable field
      const matchesText = searchableText.includes(term);
      // Also check ticket ID (using original term from search for case-sensitivity)
      const matchesId = ticketIdStr.includes(term);
      return matchesText || matchesId;
    });
  });
};

/**
 * Filter tickets by search term and selected categories
 * @param {Array} tickets - Array of ticket objects
 * @param {string} searchTerm - Search term to match against ticket fields (supports AND/OR syntax)
 * @param {Array} selectedCategories - Array of selected category names to filter by
 * @returns {Array} Filtered tickets matching all criteria
 */
export const filterTickets = (tickets = [], searchTerm = '', selectedCategories = [], options = {}) => {
  if (!tickets || tickets.length === 0) return [];
  const categoryMode = options.categoryMode || selectedCategories?.mode || tickets.find(Boolean)?.categoryMode || 'legacy';
  const categoryFilterState = normalizeCategoryFilterState(selectedCategories, categoryMode);

  let filtered = [...tickets];

  // Step 1: Apply search filter with AND/OR support
  if (searchTerm && searchTerm.trim()) {
    const parsedQuery = parseSearchQuery(searchTerm);
    
    if (parsedQuery.length > 0) {
      filtered = filtered.filter(ticket => {
        if (!ticket) return false;
        return ticketMatchesQuery(ticket, parsedQuery, searchTerm, categoryMode);
      });
    }
  }

  // Step 2: Apply category filter (AND logic - must match selected categories)
  if (hasCategoryFilters(categoryFilterState)) {
    filtered = filtered.filter(ticket => {
      if (!ticket) return false;
      return ticketMatchesCategoryFilters(ticket, categoryFilterState);
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
export const getAvailableCategories = (tickets = [], categoryMode = tickets.find(Boolean)?.categoryMode) => {
  if (!tickets || tickets.length === 0) return [];

  const categorySet = new Set();
  tickets.forEach(ticket => {
    const categoryLabel = getTicketCategoryLabel(ticket, categoryMode);
    if (categoryLabel) {
      categorySet.add(categoryLabel);
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
  parseSearchQuery,
  getTicketCategoryLabel,
  getTicketCategoryParts,
  buildCategoryFilterState,
  normalizeCategoryFilterState,
  hasCategoryFilters,
  ticketMatchesCategoryFilters,
  ticketMatchesQuery,
  filterTickets,
  filterTechnicianTickets,
  calculateFilteredStats,
  getAvailableCategories,
  calculateResultsCount,
};
