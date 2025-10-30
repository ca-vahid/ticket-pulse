# Centralized Filtering Architecture

## Overview

All ticket filtering logic in the Ticket Pulse dashboard is now centralized in a single utility module to ensure consistency across all views and components.

## Why Centralized?

**Problem (Before):**
- Filtering logic was duplicated in multiple components
- Different implementations could lead to inconsistent results
- Daily and weekly views could show different results for the same search
- Bugs in one place didn't get fixed everywhere
- Data selection logic relied on field existence instead of explicit viewMode checks
- This caused cross-contamination between daily and weekly data

**Solution (Now):**
- Single source of truth for all filtering logic
- Consistent behavior across Dashboard, TechnicianDetail, and all other views
- Easier to maintain and test
- Fixes apply everywhere automatically
- **Data selection explicitly based on viewMode, not field existence**
- Prevents mixing daily and weekly data structures

## Architecture

### Core Module: `frontend/src/utils/ticketFilter.js`

This module exports the following functions:

#### `filterTickets(tickets, searchTerm, selectedCategories)`
**Purpose:** Filter an array of tickets by search term and categories

**Parameters:**
- `tickets` (Array): Tickets to filter
- `searchTerm` (string): Term to search for
- `selectedCategories` (Array): Category names to filter by

**Returns:** Filtered array of tickets

**Search Logic:**
- Searches across: subject, ticket ID, requester name, AND category
- Uses OR logic (match ANY field to include the ticket)
- Case-insensitive matching

**Category Logic:**
- Uses AND logic (must match selected categories)
- If no categories selected, all tickets pass category filter

#### `filterTechnicianTickets(technician, searchTerm, selectedCategories, isWeeklyView)`
**Purpose:** Apply filters to a technician's tickets and calculate stats

**Parameters:**
- `technician` (Object): Technician with ticket arrays
- `searchTerm` (string): Search term
- `selectedCategories` (Array): Categories to filter
- `isWeeklyView` (boolean): Whether using weekly or daily view

**Returns:**
```javascript
{
  filtered: Array,      // Filtered tickets
  stats: Object,        // Calculated statistics
  count: number         // Number of filtered tickets
}
```

**Automatically selects appropriate ticket array:**
- Daily view: Uses `technician.tickets`
- Weekly view: Uses `technician.weeklyTickets`

#### `getAvailableCategories(tickets)`
**Purpose:** Extract unique category names from tickets

**Parameters:**
- `tickets` (Array): Array of tickets

**Returns:** Sorted array of unique category names

#### `calculateFilteredStats(tickets)`
**Purpose:** Calculate stats from filtered tickets

**Returns:** Object with counts for open, pending, self-picked, assigned, closed

## Usage Examples

### Dashboard (Daily View)
```javascript
import { filterTickets } from '../utils/ticketFilter';

const matchingTickets = filterTickets(techTickets, searchTerm, selectedCategories);
```

### Dashboard (Weekly View)
```javascript
// Same function, different data source
const matchingTickets = filterTickets(techTickets, searchTerm, selectedCategories);
// (techTickets comes from weeklyTickets array)
```

### TechnicianDetail
```javascript
import { filterTickets, getAvailableCategories } from '../utils/ticketFilter';

// Get available categories
const categories = getAvailableCategories(allTickets);

// Filter tickets
const filtered = filterTickets(tabTickets, searchTerm, selectedCategories);
```

## Data Consistency

### Daily vs Weekly View

**Daily View:**
- Source: `technician.tickets` (open tickets for selected date)
- Purpose: Show current workload

**Weekly View:**
- Source: `technician.weeklyTickets` (all tickets assigned during the week)
- Purpose: Show weekly trends

**Important:** These are different datasets by design:
- Daily: Only open/pending tickets from TODAY
- Weekly: ALL tickets assigned during the WEEK (including closed)

**Filtering is identical** but applied to different datasets:
- A search for "bst" will find different results in daily vs weekly
- This is CORRECT because the data is different
- But the FILTERING LOGIC is the same

## Consistency Checks

### Search Fields
All views search these fields in this order:
1. Subject (case-insensitive)
2. Ticket ID (case-sensitive for numbers)
3. Requester Name (case-insensitive)
4. Category (case-insensitive)

### Category Filter
All views apply category filter the same way:
- If no categories selected: all tickets pass
- If categories selected: only tickets matching those categories pass

### Results Count
All views calculate results count the same way:
- Count of filtered tickets across all technicians
- Updated in real-time as filters change

## Backend Data Requirements

For filtering to work correctly, backend must provide these fields on each ticket:

```javascript
{
  id: number,
  freshserviceTicketId: number,
  subject: string,
  requesterName: string,          // CRITICAL: Must be flattened from requester.name
  ticketCategory: string,
  status: 'Open' | 'Pending' | 'Closed' | 'Resolved',
  isSelfPicked: boolean,
  assignedBy: string,
  // ... other fields
}
```

**Important:** The `requesterName` field must be extracted from the nested `requester` object by the backend using the `transformTicket()` function.

## Testing the Consistency

To verify daily and weekly views are consistent:

1. Search for a keyword (e.g., "bst") in daily view
2. Note the number of results
3. Switch to weekly view
4. Search for the same keyword
5. **Expected:** Different number of results (because different datasets), but same filtering logic applied

Example:
- Daily: Search "bst" → finds 3 matching tickets from TODAY
- Weekly: Search "bst" → finds 4 matching tickets from THIS WEEK
- Both used the same search logic, just on different data

## ⚠️ CRITICAL RULES (Must Always Follow)

These rules ensure the filtering system works correctly and prevent bugs:

### Rule 1: Use viewMode for Data Selection, Not Field Existence
```javascript
// ❌ WRONG - can cause data cross-contamination
const techTickets = tech.weeklyTickets ? tech.weeklyTickets : tech.tickets;

// ✅ CORRECT - always uses the right data
const techTickets = viewMode === 'weekly' ? (tech.weeklyTickets || []) : (tech.tickets || []);
```

**Why:** When switching between views, both fields might exist from previous requests. Field existence checks fail in this case.

### Rule 2: Always Use Centralized filterTickets()
```javascript
// ❌ WRONG - inline filtering logic
const filtered = tickets.filter(t => t.subject.includes(search));

// ✅ CORRECT - uses centralized function
const filtered = filterTickets(tickets, searchTerm, selectedCategories);
```

**Why:** Ensures all views use identical search logic. Any filter logic must go in ticketFilter.js.

### Rule 3: Keep Filtering Separate from Data Fetching
```javascript
// ❌ WRONG - filters during fetch
const response = await api.get('/weekly', { params: { search } });

// ✅ CORRECT - fetch all data, filter on frontend
const response = await api.get('/weekly');
const filtered = filterTickets(response.data.technicians[0].weeklyTickets, search);
```

**Why:** Prevents server-side and client-side filters from having different logic.

### Rule 4: Document Any Field Dependencies
If you add a new field to tickets (e.g., `customField`), update:
1. `filterTickets()` in ticketFilter.js if it should be searchable
2. Backend transformTicket() if it needs transformation
3. Tests in ticketFilter.js
4. This documentation file

### Rule 5: Test Both Daily and Weekly When Changing Filters
Any change to filtering logic must be tested in:
- Daily view (with today's data)
- Weekly view (with week's data)
- Category filtering
- Combined search + category

## Future Improvements

If needed, we can:
1. Add advanced search operators (AND, OR, NOT)
2. Create saved filter presets
3. Add search history
4. Support regex patterns
5. Add custom field filters
6. Add field-specific search (e.g., subject:"foo" OR requester:"bar")

## Files Modified

- ✅ `frontend/src/utils/ticketFilter.js` (NEW - centralized utility)
- ✅ `frontend/src/pages/Dashboard.jsx` (Updated to use utility)
- ✅ `frontend/src/pages/TechnicianDetailNew.jsx` (Updated to use utility)
- ✅ `frontend/src/pages/TechnicianDetail.jsx` (Old - deprecated)
- 🔄 Backend: `backend/src/routes/dashboard.routes.js` (Uses transformTicket for consistency)

## Maintenance Notes

When adding new filter types:
1. Add logic to `filterTickets()` function
2. Update this documentation
3. Verify in all views (Dashboard daily, Dashboard weekly, TechnicianDetail)
4. Test both empty and populated filter states
5. Test with edge cases (special characters, very long strings, etc.)
