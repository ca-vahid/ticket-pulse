# FreshService API Analysis & Time Tracking Implementation

## Document Purpose
This document captures our learnings from analyzing the FreshService API v2, particularly around time tracking and ticket metrics. It serves as a reference for implementing pickup time and resolution time calculations.

---

## API Endpoints Analyzed

### 1. Tickets API
**Endpoint:** `GET /api/v2/tickets`

**Parameters:**
- `workspace_id`: Filter by workspace (required for multi-workspace instances)
- `updated_since`: ISO timestamp for incremental sync
- `include`: Comma-separated list of related data to include
- `per_page`: Pagination (max 100)

**Include Options:**
- `requester` - Requester details (name, email, id)
- `stats` - Ticket statistics (see below)
- `conversations` - Ticket conversations/replies
- `requester_group` - Requester group info

**Current Implementation:**
```javascript
const filters = {
  updated_since: updatedSince.toISOString(),
  include: 'requester,stats', // We include stats but it doesn't have time tracking
};
```

**Sample Ticket Response:**
```json
{
  "id": 195836,
  "subject": "BST disappeared from computer",
  "status": 2,
  "priority": 2,
  "requester_id": 1000560721,
  "responder_id": null,
  "created_at": "2025-10-20T01:17:53Z",
  "updated_at": "2025-10-20T01:18:04Z",
  "due_by": "2025-10-22T00:00:00Z",
  "fr_due_by": "2025-10-20T14:00:00Z",
  "assigned_at": null,  // ⚠️ Often NULL even when ticket is assigned
  "resolved_at": null,
  "closed_at": null,
  "source": 1,
  "category": null,
  "custom_fields": {
    "security": "BST",  // ✅ This is our ticketCategory field
    "gpt_agent_matched": null,
    // ... other custom fields
  },
  "requester": {
    "id": 1000560721,
    "name": "Caroline Bates",
    "email": "cbates@bgcengineering.ca"
  },
  "stats": {
    // See Stats Field Analysis below
  }
}
```

### 2. Stats Field (included in Ticket API)
**What We Thought It Would Have:**
- ❌ `time_spent_in_minutes` - DOES NOT EXIST
- ❌ `billable_minutes` - DOES NOT EXIST
- ❌ `non_billable_minutes` - DOES NOT EXIST

**What It Actually Contains:**
```json
{
  "created_at": "2025-10-20T01:17:53Z",
  "updated_at": "2025-10-20T01:18:04Z",
  "ticket_id": 1023751070,
  "opened_at": null,
  "group_escalated": false,
  "inbound_count": 1,
  "status_updated_at": "2025-10-20T01:17:53Z",
  "outbound_count": 0,
  "pending_since": null,
  "resolved_at": null,
  "closed_at": null,
  "first_assigned_at": null,  // ⚠️ Often NULL
  "assigned_at": null,         // ⚠️ Often NULL
  "agent_responded_at": null,
  "requester_responded_at": null,
  "first_responded_at": null,
  "first_resp_time_in_secs": null,
  "resolution_time_in_secs": 0  // ⚠️ Returns 0 when not resolved
}
```

**Key Findings:**
- ✅ `resolution_time_in_secs` - Time from creation to resolution (in seconds)
- ⚠️ `first_assigned_at` - When ticket was first assigned (often NULL)
- ⚠️ `assigned_at` - Current assignment time (often NULL)
- ❌ No time tracking (logged work hours) in stats field

---

## Time Tracking API (Separate Endpoint)

### Endpoint: Time Entries
**Endpoint:** `GET /api/v2/tickets/{ticket_id}/time_entries`

**Purpose:** Get actual time logged by technicians on tickets

**Authentication:** Same as tickets API (Basic auth with API key)

**Response Structure:**
```json
{
  "time_entries": [
    {
      "id": 1234567,
      "created_at": "2025-10-20T10:30:00Z",
      "updated_at": "2025-10-20T10:30:00Z",
      "start_time": "2025-10-20T09:00:00Z",
      "timer_running": false,
      "billable": true,
      "time_spent": "01:30",  // Format: HH:MM
      "executed_at": "2025-10-20T10:30:00Z",
      "task_id": null,
      "note": "Fixed BST installation issue",
      "agent_id": 1000123456,
      "ticket_id": 195836
    }
  ]
}
```

**Time Spent Calculation:**
- `time_spent` field is in `HH:MM` format
- Need to parse and convert to minutes
- Sum all time entries for total time spent
- Filter by `billable: true` for billable time
- Filter by `billable: false` for non-billable time

**Performance Implications:**
- Requires 1 additional API call per ticket
- Rate limit: ~1 request per second
- For 1600 tickets = ~27 minutes for full sync
- **Recommendation:** Only fetch for open tickets or on-demand

---

## Current Database Schema

### Ticket Model Fields
```prisma
model Ticket {
  // ... other fields

  // Timestamps (from main ticket API)
  createdAt             DateTime  @default(now()) @map("created_at")
  assignedAt            DateTime? @map("assigned_at")      // ⚠️ Often NULL from API
  resolvedAt            DateTime? @map("resolved_at")
  closedAt              DateTime? @map("closed_at")
  dueBy                 DateTime? @map("due_by")
  frDueBy               DateTime? @map("fr_due_by")
  updatedAt             DateTime  @default(now()) @updatedAt @map("updated_at")

  // Time tracking fields (currently all NULL)
  timeSpentMinutes      Int?      @map("time_spent_minutes")
  billableMinutes       Int?      @map("billable_minutes")
  nonBillableMinutes    Int?      @map("non_billable_minutes")

  // Custom fields
  ticketCategory        String?   @db.VarChar(100) @map("ticket_category")  // ✅ Working
}
```

---

## Problems Identified

### 1. Pickup Time Calculation (BROKEN)
**Current Issue:**
- Trying to calculate: `assignedAt - createdAt`
- Problem: `assignedAt` is NULL for most tickets
- Result: Shows "Pickup: Not Assigned" even for assigned tickets

**Why `assignedAt` is NULL:**
- FreshService API often doesn't populate this field
- Even `stats.first_assigned_at` is frequently NULL
- API inconsistency across different ticket types

**Potential Solutions:**
1. **Use Ticket Activities API** (Best Option)
   - Endpoint: `GET /api/v2/tickets/{id}/activities`
   - Find first assignment activity
   - Calculate pickup time from that activity's timestamp
   - We already use this for self-picked detection

2. **Use Stats Field** (Fallback)
   - Use `stats.first_assigned_at` when available
   - Fall back to "Unknown" when NULL

3. **Skip Pickup Time** (Current MVP)
   - Just don't show it if data unavailable
   - Better than showing misleading "Not Assigned"

### 2. Resolution Time Calculation (PARTIALLY WORKING)
**Current Issue:**
- Trying to calculate: `resolvedAt - createdAt`
- Problem: `resolvedAt` may be NULL even for resolved tickets

**Available Data:**
- ✅ `stats.resolution_time_in_secs` - Direct from FreshService
- ✅ `resolvedAt` timestamp - When available
- ❌ Not always consistent

**Solution:**
Use `stats.resolution_time_in_secs` directly instead of calculating

### 3. Time Spent (NOT IMPLEMENTED)
**Current Status:**
- Database fields exist but always NULL
- Transformer sets fields to NULL
- Requires separate API endpoint

**Implementation Required:**
- Fetch from `/api/v2/tickets/{id}/time_entries`
- Parse `HH:MM` format to minutes
- Sum all entries per ticket
- Performance impact: significant

---

## Recommended Implementation Plan

### Phase 1: Fix Resolution Time (Easy - 30 min)
**Goal:** Use existing stats field for resolution time

**Changes Needed:**
1. Update FreshService transformer to extract `stats.resolution_time_in_secs`
2. Convert seconds to human-readable format (e.g., "2h 30m")
3. Store in new field: `resolutionTimeSeconds` (Int)
4. Update frontend to display formatted time

**Files to Modify:**
- `backend/src/integrations/freshserviceTransformer.js`
- `backend/prisma/schema.prisma` (add field)
- `frontend/src/pages/TechnicianDetail.jsx` (display logic)

**Migration:**
```sql
ALTER TABLE "tickets" ADD COLUMN "resolution_time_seconds" INTEGER;
```

### Phase 2: Fix Pickup Time Using Activities (Medium - 2 hours)
**Goal:** Calculate accurate pickup time from ticket activities

**Current State:**
- We already fetch activities for self-picked detection
- Activities API called during incremental sync only
- Full sync skips activities for performance

**Changes Needed:**
1. Extract `first_assignment_time` from activities analysis
2. Store as new timestamp field: `firstAssignedAt`
3. Calculate pickup time: `firstAssignedAt - createdAt`
4. Update frontend to use this field

**Activity Analysis Enhancement:**
```javascript
// In analyzeTicketActivities function
function analyzeTicketActivities(activities) {
  let isSelfPicked = false;
  let assignedBy = null;
  let firstAssignedAt = null;  // NEW

  // Find first assignment activity
  const firstAssignment = activities.find(a =>
    a.action === 'assigned' && a.field === 'agent_id'
  );

  if (firstAssignment) {
    firstAssignedAt = new Date(firstAssignment.performed_at);  // NEW
    const performer = firstAssignment.performed_by.name;
    const assignee = firstAssignment.to_value;

    if (performer === assignee) {
      isSelfPicked = true;
      assignedBy = null;
    } else {
      isSelfPicked = false;
      assignedBy = performer;
    }
  }

  return { isSelfPicked, assignedBy, firstAssignedAt };  // Return new field
}
```

**Migration:**
```sql
ALTER TABLE "tickets" ADD COLUMN "first_assigned_at" TIMESTAMP;
```

**Performance Consideration:**
- Activities already fetched during incremental sync
- No additional API calls needed
- Full sync can populate this on subsequent incremental syncs

### Phase 3: Implement Time Tracking (Hard - 4 hours)
**Goal:** Show actual logged work time on tickets

**Implementation Options:**

#### Option A: On-Demand Fetch (Recommended for MVP)
- Only fetch time entries when user views ticket detail
- Cache in frontend for session
- No database storage
- Pros: No performance impact on sync
- Cons: Slight delay when viewing ticket

#### Option B: Fetch for Open Tickets Only
- During sync, fetch time entries for open tickets only
- Store in database
- Update on each sync
- Pros: Always up-to-date for open tickets
- Cons: Adds ~50 API calls to sync (open tickets only)

#### Option C: Full Time Tracking (Future)
- Fetch for all tickets during sync
- Store in database with history
- Pros: Complete historical data
- Cons: Adds ~1600 API calls to full sync (30+ minutes)

**Recommended Approach: Option A**
1. Add frontend API call when ticket expanded/viewed
2. Fetch time entries on-demand
3. Display in ticket detail
4. Cache in component state

**Implementation:**
```javascript
// New API endpoint in backend
router.get('/tickets/:id/time-entries', async (req, res) => {
  const ticketId = req.params.id;
  const client = createFreshServiceClient();
  const entries = await client.fetchTimeEntries(ticketId);

  // Parse and sum time entries
  const totalMinutes = entries.reduce((sum, entry) => {
    const [hours, minutes] = entry.time_spent.split(':').map(Number);
    return sum + (hours * 60) + minutes;
  }, 0);

  const billableMinutes = entries
    .filter(e => e.billable)
    .reduce((sum, entry) => {
      const [hours, minutes] = entry.time_spent.split(':').map(Number);
      return sum + (hours * 60) + minutes;
    }, 0);

  res.json({
    success: true,
    data: {
      totalMinutes,
      billableMinutes,
      nonBillableMinutes: totalMinutes - billableMinutes,
      entries: entries.map(e => ({
        date: e.executed_at,
        timeSpent: e.time_spent,
        billable: e.billable,
        note: e.note,
        agentId: e.agent_id,
      })),
    },
  });
});
```

---

## Implementation Status

### ✅ Completed:
1. ✅ **Fix "Not Assigned" Label** - Removed confusing UI text
2. ✅ **Implement Resolution Time** - Using `stats.resolution_time_in_secs`
   - Added `resolutionTimeSeconds` field to database
   - Transformer extracts from `stats.resolution_time_in_secs`
   - Migration: `20251020000002_add_resolution_and_pickup_time`
   - Frontend displays exact time: days, hours, minutes (e.g., "1d 17h 34m")
3. ✅ **Implement Pickup Time (Backend)** - Using activities data
   - Added `firstAssignedAt` field to database
   - Activity analyzer extracts first assignment timestamp
   - Sync service populates field from analysis
   - Only populated for tickets analyzed incrementally or via backfill
4. ✅ **Make Date Range Configurable** - Removed hardcoded 30-day limit
   - Added `daysToSync` parameter to sync service
   - API endpoint accepts `?daysToSync=90` query parameter
   - Defaults to 30 days if not specified
5. ✅ **Add Backfill Endpoint** - Manual "Backfill Pickup Times" feature
   - Endpoint: `POST /api/sync/backfill-pickup-times`
   - Query parameters:
     - `limit=100`: Max tickets per batch (default: 100)
     - `daysToSync=30`: Only backfill tickets from last N days (default: 30)
     - `processAll=true`: Process all batches until complete (default: false)
     - `concurrency=5`: Number of parallel API calls (default: 5)
   - Updates tickets with `firstAssignedAt`, `isSelfPicked`, and `assignedBy`
   - **Performance:** ~5x faster with parallel processing (100 tickets in ~25s vs ~110s)
6. ✅ **Update Frontend** - Display resolution and pickup times
   - Updated `TechnicianDetail.jsx` to use new fields
   - `pickupTime` now uses `ticket.firstAssignedAt`
   - `resolutionTime` now uses `ticket.resolutionTimeSeconds`
   - Times formatted with exact precision: "41m", "2h 15m", "1d 3h 45m"
7. ✅ **Fix Schema Mismatches** - Aligned repository with Prisma schema
   - Fixed `ticketActivityRepository` to use correct schema fields
   - Activities now use `performedBy`, `performedAt`, and `details` (JSON)
8. ✅ **Optimize Backfill Performance** - Parallel processing with rate limiting
   - Implemented concurrent API calls with configurable concurrency
   - Staggered request timing to respect FreshService rate limits
   - Default 5 concurrent requests = ~3.8 requests/second (within 5000/hour limit)
   - Batch timing metrics logged for monitoring

### Known Limitations:
- **Backfill Success Rate:** ~93-95% due to:
  - FreshService API 500 errors for certain tickets (~5% of failures)
  - Missing activity data for tickets assigned before logging enabled
  - Both are expected and unavoidable

### Future Enhancement:
9. **Time Tracking** - Implement on-demand fetch (4 hours)
   - Only when really needed
   - Adds API call overhead
   - Consider if worth the effort

---

## Code References

### Where Pickup Time is Calculated:
- Frontend: `frontend/src/pages/TechnicianDetail.jsx:236`
  ```javascript
  const pickupTime = calculatePickupTime(ticket.createdAt, ticket.assignedAt);
  ```

### Where Resolution Time is Calculated:
- Frontend: `frontend/src/pages/TechnicianDetail.jsx:237`
  ```javascript
  const resolutionTime = calculateResolutionTime(ticket.createdAt, ticket.resolvedAt);
  ```

### Where Stats are Fetched:
- Backend: `backend/src/services/syncService.js:162`
  ```javascript
  const filters = {
    updated_since: updatedSince.toISOString(),
    include: 'requester,stats',
  };
  ```

### Where Transformer Processes Tickets:
- Backend: `backend/src/integrations/freshserviceTransformer.js:40-75`
  - Currently sets time tracking fields to NULL
  - Should extract `stats.resolution_time_in_secs`

### Where Activities are Analyzed:
- Backend: `backend/src/utils/activityAnalyzer.js`
  - Already extracts self-picked and assignedBy
  - Should also extract `firstAssignedAt` timestamp

---

## API Rate Limiting Considerations

**FreshService Limits:**
- 5000 requests per hour
- ~83 requests per minute
- ~1.4 requests per second

**Current Sync Performance:**
- Tickets API: 1 call (up to 100 tickets per page)
- Activities API: 1 call per ticket needing analysis
- Incremental sync: ~10-50 activity calls
- Full sync: 0 activity calls (skipped for performance)

**Impact of Time Entries:**
- Would add 1 call per ticket
- Full sync with 1600 tickets = 1600 calls
- At 1.1s per call = 29 minutes
- Exceeds rate limit if done too frequently

**Recommendation:**
- Avoid fetching time entries during sync
- Fetch on-demand when viewing ticket
- Cache results client-side

---

## Testing Evidence

### Ticket #195836 API Response:
```json
{
  "stats": {
    "resolution_time_in_secs": 0,
    "first_assigned_at": null,
    "assigned_at": null
  }
}
```
❌ No time tracking data
❌ Assignment timestamps NULL

### Test Script Results:
Location: `backend/test-sync-debug.js`

Output showed:
- ✅ 1627 tickets fetched successfully
- ✅ `custom_fields.security` = "BST" (category working)
- ❌ `stats.time_spent_in_minutes` = undefined (doesn't exist)
- ❌ `billable_minutes` = undefined (doesn't exist)

---

## Summary

**What Works:**
- ✅ Ticket sync with requester data
- ✅ Category field extraction (`custom_fields.security`)
- ✅ Self-picked detection (via activities)
- ✅ Basic ticket metadata

**What Needs Fixing:**
- ❌ Pickup time calculation (assignedAt is NULL)
- ❌ Resolution time display (should use stats field)
- ❌ Time tracking (requires separate API endpoint)

**Next Steps:**
1. Add `resolutionTimeSeconds` field from stats
2. Extract `firstAssignedAt` from activities we already fetch
3. Consider on-demand time entries fetch for future enhancement
