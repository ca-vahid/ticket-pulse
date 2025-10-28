# Current Sync Architecture Analysis

## Existing Sync Methods

### 1. performFullSync() - Orchestrator (line 359)
- Calls syncTechnicians() → syncTickets() → syncRequesters()
- Handles sync logs and SSE broadcasts

### 2. syncTickets() - Full/Incremental Sync (line 126)
```javascript
1. Determine time range (incremental vs full)
2. Fetch tickets from FreshService
3. Transform tickets
4. ✅ Get technicians and build ID map (lines 177-184)
5. ✅ Map technician IDs to tickets
6. Batch fetch existing tickets
7. Conditionally analyze activities
8. Upsert tickets to database
```

### 3. syncWeek() - Week-Specific Sync (line 661)
```javascript
1. Fetch tickets for specific week
2. Transform tickets
3. ❌ MISSING: Map technician IDs
4. Upsert tickets to database
5. Analyze activities for all tickets
6. Backfill pickup times
```

## The Problem

**Code Duplication & Missing Logic:**
- syncTickets() and syncWeek() duplicate ~80% of logic
- syncWeek() is missing the critical technician ID mapping (lines 177-184)
- Each method has slightly different activity analysis logic
- Both have their own rate limiting strategies

**Result:** Tickets synced via syncWeek() have assignedTechId=NULL and don't appear in dashboard stats.

## Proposed Modular Architecture

### Core Sync Module Pattern

```javascript
// syncService.js
class SyncService {

  // ========================================
  // REUSABLE CORE METHODS (PRIVATE)
  // ========================================

  /**
   * Step 1: Fetch tickets from FreshService
   */
  async _fetchTickets(client, filters) {
    // Returns raw FreshService tickets
  }

  /**
   * Step 2: Transform and map technician IDs
   */
  async _prepareTicketsForDatabase(fsTickets) {
    // 1. Transform tickets
    // 2. Get technicians from DB
    // 3. Build FS ID → Internal ID map
    // 4. Apply mapping to tickets
    // Returns tickets ready for upsert
  }

  /**
   * Step 3: Upsert tickets to database
   */
  async _upsertTickets(tickets) {
    // Batch upsert with conflict handling
    // Returns count of synced tickets
  }

  /**
   * Step 4: Analyze activities with rate limiting
   */
  async _analyzeTicketActivities(client, tickets, options = {}) {
    // options: { concurrency, batchDelay, skipExisting }
    // Returns analysis results
  }

  /**
   * Step 5: Update tickets with activity analysis
   */
  async _updateTicketsWithAnalysis(analysisResults) {
    // Batch update tickets with firstAssignedAt, isSelfPicked, assignedBy
  }

  // ========================================
  // PUBLIC SYNC METHODS
  // ========================================

  /**
   * Full/Incremental ticket sync
   */
  async syncTickets(options = {}) {
    const client = await this._initializeClient();

    // Determine time range
    const filters = this._buildSyncFilters(options);

    // Use core modules
    const fsTickets = await this._fetchTickets(client, filters);
    const preparedTickets = await this._prepareTicketsForDatabase(fsTickets);
    const syncCount = await this._upsertTickets(preparedTickets);

    // Optionally analyze activities
    if (options.analyzeActivities) {
      const analysis = await this._analyzeTicketActivities(client, preparedTickets, {
        skipExisting: true,
        concurrency: 1
      });
      await this._updateTicketsWithAnalysis(analysis);
    }

    return syncCount;
  }

  /**
   * Week-specific sync (now uses same core modules)
   */
  async syncWeek({ startDate, endDate, concurrency = 3 }) {
    const client = await this._initializeClient();

    // Build week-specific filters
    const filters = {
      updated_since: new Date(startDate + 'T00:00:00Z').toISOString(),
      include: 'requester,stats'
    };

    // Use SAME core modules as syncTickets
    const fsTickets = await this._fetchTickets(client, filters);
    const weekTickets = fsTickets.filter(t => /* week range */);

    const preparedTickets = await this._prepareTicketsForDatabase(weekTickets);
    const syncCount = await this._upsertTickets(preparedTickets);

    // Always analyze for week sync
    const analysis = await this._analyzeTicketActivities(client, preparedTickets, {
      concurrency,
      batchDelay: 1500
    });
    await this._updateTicketsWithAnalysis(analysis);

    return { ticketsSynced: syncCount, ... };
  }
}
```

## Benefits of Modular Approach

### 1. **Single Source of Truth**
- Technician ID mapping happens in ONE place (`_prepareTicketsForDatabase`)
- All sync methods use the same logic
- Bug fixes apply everywhere automatically

### 2. **Consistency Guaranteed**
- Every ticket gets proper technician assignment
- Same transformation logic everywhere
- Unified error handling

### 3. **Easier to Maintain**
- Core logic is ~200 lines instead of ~600 duplicated lines
- Changes to sync logic only need to be made once
- Easier to add new sync methods (e.g., syncMonth, syncDay)

### 4. **Testable**
- Each core method can be unit tested independently
- Mock dependencies easily
- Test different scenarios without running full syncs

### 5. **Flexible**
- Options pattern allows different behaviors
- Easy to add features (e.g., dry-run mode, progress callbacks)
- Can compose methods for custom sync strategies

## Migration Strategy

### Phase 1: Extract Core Methods (No Breaking Changes)
1. Create private `_prepareTicketsForDatabase()` method
2. Extract activity analysis to `_analyzeTicketActivities()`
3. Both old methods still work

### Phase 2: Migrate syncWeek() to Use Core Methods
1. Refactor syncWeek() to call core methods
2. Test thoroughly with current week data
3. Verify all 108 tickets appear correctly

### Phase 3: Migrate syncTickets() to Use Core Methods
1. Refactor syncTickets() to call core methods
2. Ensure incremental/full sync still works
3. Test with production data

### Phase 4: Cleanup
1. Remove duplicated code
2. Add JSDoc comments
3. Add unit tests for core methods

## Immediate Fix (Quick Win)

Before full refactor, we can do a quick fix to syncWeek():

```javascript
// In syncWeek(), after line 699 (transform tickets):
const transformedTickets = tickets.map(t => transformTicket(t));

// ADD THIS (copy from syncTickets lines 177-184):
const technicians = await technicianRepository.getAllActive();
const fsIdToInternalId = new Map(
  technicians.map(tech => [Number(tech.freshserviceId), tech.id])
);
const ticketsWithTechIds = mapTechnicianIds(transformedTickets, fsIdToInternalId);

// Then upsert ticketsWithTechIds instead of transformedTickets
```

This 6-line addition will immediately fix the bug, then we can refactor at leisure.
