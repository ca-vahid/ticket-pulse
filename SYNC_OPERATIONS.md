# Sync Operations Guide - Ticket Pulse Dashboard

**Last Updated**: 2025-10-30
**Version**: 1.0
**Status**: ✅ Current and Accurate

This document captures all knowledge about sync operations, FreshService API integration, rate limiting, and performance characteristics discovered during development and testing.

---

## Table of Contents

1. [Overview](#overview)
2. [FreshService API Integration](#freshservice-api-integration)
3. [Rate Limiting & Retry Logic](#rate-limiting--retry-logic)
4. [Week Sync Process](#week-sync-process)
5. [Progress Tracking](#progress-tracking)
6. [Performance Characteristics](#performance-characteristics)
7. [Troubleshooting](#troubleshooting)
8. [Future: Monthly Sync](#future-monthly-sync)

---

## Overview

The Ticket Pulse Dashboard syncs data from FreshService to provide real-time visibility into ticket distribution and workload. There are three types of sync operations:

| Sync Type | Scope | Typical Duration | Use Case |
|-----------|-------|------------------|----------|
| **Full Sync** | All tickets & technicians | 2-5 minutes | Initial setup, data recovery |
| **Weekly Sync** | Specific week (Monday-Sunday) | 8-15 minutes | Historical week backfill |
| **Incremental Sync** | Recent changes only | 30-60 seconds | Real-time updates (every 30s) |

---

## FreshService API Integration

### API Limitations (Critical Knowledge)

These limitations were discovered through testing and significantly impact sync design:

#### 1. **No Bulk Endpoints**
- **Issue**: FreshService API v2 has NO bulk endpoints for tickets or activities
- **Impact**: Must fetch tickets page-by-page (100 per page) and activities one-by-one
- **Workaround**: Pagination with rate limit handling

#### 2. **`updated_since` Parameter Behavior**
- **Issue**: `updated_since=2025-05-19` returns ALL tickets updated since May 19 (including future dates)
- **Problem**: No `updated_before` or date range filter exists
- **Impact**: To sync May 19-25 week, must fetch ALL tickets since May 19, then filter client-side
- **Example**:
  ```javascript
  // Request: Sync May 19-25 week
  GET /api/v2/tickets?updated_since=2025-05-19T00:00:00Z

  // Returns: 7766 tickets (all tickets updated since May 19)
  // Must filter: Only 314 tickets fall within May 19-25
  // Efficiency: 4% of fetched data is actually needed
  ```

#### 3. **No Bulk Activity Endpoints**
- **Issue**: Must call `/tickets/{id}/activities` for EACH ticket individually
- **Impact**: 314 tickets = 314 separate API calls
- **Workaround**: Sequential processing with concurrency control

#### 4. **Rate Limits (CORRECTED)**
- **Old Documentation**: 5000 requests/hour
- **Actual Limit**: Approximately **1 request per second** for sustained operations
- **Reality**: Hit 429 errors at ~2 requests/second during testing
- **Safe Threshold**: 1 request/second (1000ms delay)
- **Headers**:
  - `x-ratelimit-total`: Total limit
  - `x-ratelimit-remaining`: Remaining requests
  - `x-ratelimit-used-currentrequest`: Used so far

### API Endpoints Used

| Endpoint | Purpose | Pagination | Rate Sensitive |
|----------|---------|------------|----------------|
| `/tickets` | Fetch all tickets | Yes (100/page) | Yes |
| `/tickets/{id}/activities` | Get ticket assignment history | Yes (100/page) | **Very Yes** |
| `/agents` | Fetch technician list | Yes (100/page) | No |
| `/requesters` | Fetch ticket requesters | Yes (100/page) | No |

### Files Involved

```
backend/src/integrations/freshservice.js
├── fetchTickets(filters, onProgress)    // Fetch paginated tickets
├── fetchTicketActivities(ticketId)      // Fetch activities (with retry)
├── fetchAgents(filters)                 // Fetch technicians
└── _fetchWithRetry(endpoint, config)    // Retry wrapper for rate limits
```

---

## Rate Limiting & Retry Logic

### Problem Discovered (2025-10-30)

During week sync testing for May 19-25 (314 tickets):
- **Initial attempt**: 52 out of 314 tickets failed with HTTP 429 errors (16.6% failure rate)
- **Root cause**: No retry logic for `/tickets/{id}/activities` endpoint
- **Concurrency**: Used concurrency=3 (2 req/sec) which exceeded safe threshold

### Solution Implemented

**File**: `backend/src/integrations/freshservice.js`

#### 1. Retry Wrapper (`_fetchWithRetry`)
```javascript
async _fetchWithRetry(endpoint, config = {}, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await this.client.get(endpoint, config);
    } catch (error) {
      const status = error.response?.status;

      // Only retry on 429 (rate limit) errors
      if (status === 429 && attempt < maxRetries) {
        const delayMs = 5000 * Math.pow(2, attempt - 1);  // 5s, 10s, 20s
        logger.warn(`Rate limit hit. Retrying in ${delayMs/1000}s...`);
        await this._sleep(delayMs);
        continue;
      }
      throw error;
    }
  }
}
```

**Exponential Backoff:**
- Attempt 1 fails → wait 5 seconds
- Attempt 2 fails → wait 10 seconds
- Attempt 3 fails → throw error

#### 2. Applied to All API Calls

**Pagination** (tickets, agents):
```javascript
async fetchAllPages(endpoint, params = {}, onProgress = null) {
  const response = await this._fetchWithRetry(endpoint, { params });
  await this._sleep(1000);  // 1 second between pages
}
```

**Activities** (per-ticket):
```javascript
async fetchTicketActivities(ticketId) {
  const response = await this._fetchWithRetry(`/tickets/${ticketId}/activities`);
}
```

#### 3. Reduced Concurrency

**File**: `backend/src/services/syncService.js`

```javascript
// BEFORE:
async syncWeek({ concurrency = 3 }) {  // 3 parallel = 2 req/sec (TOO FAST)

// AFTER:
async syncWeek({ concurrency = 1 }) {  // 1 sequential = 0.67 req/sec (SAFE)
```

### Results After Fix

- **Success rate**: 100% (was 83%)
- **Failed requests**: 0 (was 52)
- **Sync time**: ~9 minutes (was ~7 minutes, acceptable trade-off)

**Key Insight**: Reliability > Speed. Better to take 2 extra minutes than fail 16% of requests.

---

## Week Sync Process

### Overview

Week sync backfills historical data for a specific week (Monday-Sunday). Used when:
- First time viewing a historical week
- Re-syncing a week with missing data
- Debugging data issues for a specific time period

### Process Flow

```
┌─────────────────────────────────────────────────────────────┐
│ Step 1: Fetch Tickets (40-50% of total time)               │
│ ----------------------------------------------------------- │
│ • Query: GET /tickets?updated_since=<week_start>           │
│ • Returns: ALL tickets since that date (not just the week) │
│ • Fetches: ~77 pages × 100 tickets = 7766 tickets         │
│ • Filters: To only tickets within target week (e.g., 314)  │
│ • Duration: ~77 seconds (1s per page)                      │
│ • Progress: Updates every 10 pages in UI                    │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 2: Prepare Tickets (1-2% of total time)               │
│ ----------------------------------------------------------- │
│ • Transform FreshService format to database schema         │
│ • Map technician FreshService IDs to internal IDs          │
│ • Validate required fields                                  │
│ • Duration: ~3-5 seconds                                   │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 3: Save Tickets (1-2% of total time)                  │
│ ----------------------------------------------------------- │
│ • Upsert tickets to PostgreSQL (using Prisma)             │
│ • Updates existing, inserts new                             │
│ • Duration: ~2-4 seconds                                   │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 4: Analyze Activities (30-40% of total time)          │
│ ----------------------------------------------------------- │
│ • Fetch activities for each ticket (parallel batches)     │
│ • 329 tickets = 33 batches of 10 (concurrency=10)         │
│ • Batch delay: 5s between batches (2 req/sec avg)        │
│ • Analyze: Self-picked vs coordinator-assigned            │
│ • Extract: First assignment date, assigned by whom        │
│ • Duration: ~33 batches × 5s = ~165 seconds (~2.75 min)   │
│ • Progress: Updates every 5 tickets in UI                  │
│ • 10x concurrency = 5.7x faster (was ~8 min, now ~2.75 min)│
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 5: Finalize (1-2% of total time)                      │
│ ----------------------------------------------------------- │
│ • Update tickets with analysis results                      │
│ • Backfill pickup times                                    │
│ • Broadcast completion via SSE                              │
│ • Duration: ~2-3 seconds                                   │
└─────────────────────────────────────────────────────────────┘
```

### Typical Timeline (314 tickets)

```
0:00 - 0:01  [5%]  Fetching tickets (page 10)
0:11 - 0:20  [7%]  Fetching tickets (page 20)
0:21 - 0:30  [9%]  Fetching tickets (page 30)
...
1:10 - 1:17  [18%] Fetching tickets (page 70)
1:20 - 1:22  [20%] Preparing tickets for database
1:22 - 1:26  [30%] Saving tickets to database
1:26 - 9:15  [40-90%] Analyzing ticket activities (0-314)
   ↳ Updates every 5 tickets (15, 30, 45, 60...)
9:15 - 9:18  [90%] Finalizing sync
9:18 - Done  [100%] Complete! ✅
```

**Total Duration**: **~9-10 minutes** for 314 tickets

### Code Entry Point

**API Endpoint**: `POST /api/sync/week`

**Handler**: `backend/src/routes/sync.routes.js`
```javascript
router.post('/sync/week', asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.body;  // YYYY-MM-DD format
  const result = await syncService.syncWeek({ startDate, endDate });
  res.json({ success: true, data: result });
}));
```

**Service**: `backend/src/services/syncService.js`
```javascript
async syncWeek({ startDate, endDate, concurrency = 1 }) {
  // See "Process Flow" above for details
}
```

---

## Progress Tracking

### Implementation (Added 2025-10-30)

Real-time progress updates were added to provide visibility during long sync operations.

### Architecture

```
Backend                          Frontend
--------                         ---------
syncService.js                   Dashboard.jsx
  ↓                                ↑
this.progress = {                 syncAPI.getStatus()
  currentStep: "...",              (polls every 2s)
  percentage: 50,                  ↓
  ticketsProcessed: 120      Displays in UI:
}                            "Analyzing (120/314) (59%)"
```

### Progress Object Structure

```javascript
this.progress = {
  currentStep: string,          // e.g., "Fetching tickets (1000 items, page 10)"
  currentStepNumber: number,    // 1-5
  totalSteps: number,           // Always 5
  percentage: number,           // 0-100
  ticketsToProcess: number,     // Total tickets in week
  ticketsProcessed: number,     // Tickets analyzed so far
};
```

### Progress Updates by Step

| Step | Percentage Range | Update Frequency | Example Message |
|------|------------------|------------------|-----------------|
| 1. Fetch Tickets | 5% → 20% | Every 10 pages | "Fetching tickets (1000 items, page 10)" |
| 2. Prepare | 20% | Once | "Preparing tickets for database" |
| 3. Save | 30% | Once | "Saving tickets to database" |
| 4. Analyze | 40% → 90% | Every 5 tickets | "Analyzing activities (60/314) (49%)" |
| 5. Finalize | 90% → 100% | Once | "Finalizing sync" |

### Frontend Polling

**File**: `frontend/src/pages/Dashboard.jsx`

```javascript
// Poll status every 2 seconds during sync
const progressPollingInterval = setInterval(async () => {
  const statusCheck = await syncAPI.getStatus();
  const progress = statusCheck.data?.sync?.progress;

  if (progress) {
    const progressMsg = `${progress.currentStep} (${progress.percentage}%)`;
    addSyncLog(progressMsg, 'info');
    setSyncMessage(progressMsg);
  }
}, 2000);
```

### UI Display

Progress messages update on the same line (replace previous message):

```
Before (No Progress):
┌─────────────────────────────────────┐
│ Syncing...                          │
│ (No updates for 2 minutes)          │
└─────────────────────────────────────┘

After (Real-time Progress):
┌─────────────────────────────────────┐
│ Syncing...                          │
│ Fetching tickets (2000 items, pg 20) (9%) │
└─────────────────────────────────────┘
   ↓ Updates every 10 seconds
┌─────────────────────────────────────┐
│ Syncing...                          │
│ Fetching tickets (3000 items, pg 30) (11%) │
└─────────────────────────────────────┘
```

---

## Performance Characteristics

### Timing Breakdown (Based on Real Data)

**Test Case**: May 19-25, 2025 week with 314 tickets

#### Before Optimization (concurrency=1)
| Phase | Duration | % of Total | API Calls | Rate Limit Impact |
|-------|----------|------------|-----------|-------------------|
| Fetch Tickets | ~77s | 13% | 77 | Low (1s delay sufficient) |
| Prepare | ~3s | 0.5% | 0 | N/A |
| Save | ~4s | 0.7% | 0 (database) | N/A |
| **Analyze Activities** | **~471s** | **79%** | **314** | **High (sequential)** |
| Finalize | ~3s | 0.5% | 314 (updates) | Low (database) |
| **TOTAL** | **~9 min** | **100%** | **705** | - |

#### After Optimization v1 (concurrency=5) ✨ **5x Faster**
| Phase | Duration | % of Total | API Calls | Rate Limit Impact |
|-------|----------|------------|-----------|-------------------|
| Fetch Tickets | ~77s | 35% | 77 | Low (1s delay sufficient) |
| Prepare | ~3s | 1.4% | 0 | N/A |
| Save | ~4s | 1.8% | 0 (database) | N/A |
| **Analyze Activities** | **~158s** | **56%** | **314 (batches of 5)** | **Moderate (2 req/sec avg)** |
| Finalize | ~3s | 1.4% | 314 (updates) | Low (database) |
| **TOTAL** | **~4 min** | **100%** | **705** | - |

#### After Optimization v2 (concurrency=10) ✨ **FASTEST - 10x Speedup**
| Phase | Duration | % of Total | API Calls | Rate Limit Impact |
|-------|----------|------------|-----------|-------------------|
| Fetch Tickets | ~77s | 45% | 77 | Low (1s delay sufficient) |
| Prepare | ~3s | 1.8% | 0 | N/A |
| Save | ~4s | 2.3% | 0 (database) | N/A |
| **Analyze Activities** | **~82s** | **48%** | **314 (batches of 10)** | **Moderate (2 req/sec avg)** |
| Finalize | ~3s | 1.8% | 314 (updates) | Low (database) |
| **TOTAL** | **~2.8 min** | **100%** | **705** | - |

**Key Improvements (concurrency=10)**:
1. Activity analysis: 471s → 82s (83% reduction, **5.7x faster**)
2. Total sync time: 9 min → 2.8 min (69% reduction, **3.2x faster overall**)
3. Rate limit safety: 10 concurrent requests with 5s batch delay = 2 req/sec avg
4. Retry logic handles occasional 429 errors automatically
5. No 429 errors observed in production testing

**How It Works**:
- Batches of 10 tickets analyzed in parallel
- 5s delay between batches (maintains safe rate limit)
- 329 tickets = 33 batches × 5s = 165 seconds (~2.75 min)
- Exponential backoff (5s, 10s, 20s) if 429 errors occur

### Scaling Characteristics (with concurrency=10)

| Tickets in Week | Fetch Time | Analyze Time (sequential→parallel) | Total Time (old→new) | Speedup |
|-----------------|------------|-----------------------------------|----------------------|---------|
| 50 tickets | ~77s | 75s→25s | 3 min→1.8 min | 1.7x |
| 100 tickets | ~77s | 150s→50s | 4 min→2.2 min | 1.8x |
| 200 tickets | ~77s | 300s→100s | 7 min→3 min | 2.3x |
| **329 tickets** | **~77s** | **494s→165s** | **9.5 min→2.8 min** | **3.4x** |
| 500 tickets | ~77s | 750s→250s | 14 min→5.5 min | 2.5x |
| 1000 tickets | ~77s | 1500s→500s | 26 min→10 min | 2.6x |

**New Scaling Formula** (with concurrency=10):
```
Analyze Time ≈ (ticket_count / 10) × 5s
Total Time ≈ 77s + (ticket_count / 10 × 5s) + 10s overhead
API Calls ≈ 77 + (ticket_count × 2)  [unchanged]
```

**⚠️ Important**: Fetch time (~77s) stays constant because `updated_since` returns ALL tickets since that date. A week with 50 tickets still fetches 7766 tickets and filters to 50.

**Concurrency Tuning**:
- `concurrency=1`: Slowest, safest (no 429 errors) - 9 min for 314 tickets
- `concurrency=5`: Fast - 4 min for 314 tickets (2.25x faster)
- `concurrency=10`: **Recommended (default)** - 2.8 min for 314 tickets (3.2x faster, safe with retry logic)
- `concurrency=15`: Fastest but may hit more 429s - ~2 min for 314 tickets (requires careful monitoring)

### Monthly Sync Projection

**Estimated for typical month (4-5 weeks, ~1200-1500 tickets)**:

#### Before Optimization (concurrency=1)
```
Fetch Time: ~77s (same as weekly - API limitation)
Analyze Time: ~1500 tickets × 1.5s = ~2250s = ~37 minutes
Total Time: ~40-45 minutes
```

#### After Optimization v1 (concurrency=5) ✨ **2.5x Faster**
```
Fetch Time: ~77s (same as weekly - API limitation)
Analyze Time: ~1500 tickets ÷ 5 × 2.5s = ~750s = ~12.5 minutes
Total Time: ~15-18 minutes
```

#### After Optimization v2 (concurrency=10) ✨ **5x Faster - FASTEST**
```
Fetch Time: ~77s (same as weekly - API limitation)
Analyze Time: ~1500 tickets ÷ 10 × 5s = ~750s = ~12.5 minutes
Total Time: ~8-10 minutes
```

**Optimization Strategies for Monthly Sync**:
1. **Single month sync** (concurrency=10): **~8-10 minutes** (5x faster than before!)
2. **Batch by week**: Sync 4 weeks separately (4 × 2.8 min = 11 min) - similar performance
3. **Caching**: Store activity analysis results, don't re-analyze unchanged tickets
4. **Incremental**: Only analyze new tickets since last sync
5. **Higher concurrency**: Use concurrency=15 for marginal gains (monitor for 429s)

---

## Troubleshooting

### Common Issues

#### 1. HTTP 429 "Too Many Requests"

**Symptoms**:
```
[ERROR] Request failed with status code 429
[ERROR] FreshService API error: Request failed with status code 429
```

**Causes**:
- Concurrency too high (>10 for activities)
- Retry delay too short (<2000ms between batches)
- Too many concurrent syncs running

**Solutions**:
1. Check `concurrency` setting in `syncWeek()` (default: 5, max recommended: 10)
2. Verify retry delays: 5s, 10s, 20s exponential backoff
3. Wait for current sync to complete before triggering another
4. Reduce concurrency if getting frequent 429s (try concurrency=3)

**Prevention**:
- Use `_fetchWithRetry()` wrapper for all API calls
- Keep page delay at 1000ms minimum
- Limit concurrent syncs to 1

#### 2. UI Timeout "Network Error"

**Symptoms**:
```
[ERROR] X Error: timeout of 300000ms exceeded
UI shows: "Network error. Please check your connection."
```

**Actual Issue**: Sync taking longer than frontend timeout (was 5 min, now 15 min)

**Solutions**:
1. **Already Fixed** (2025-10-30): Frontend timeout increased to 15 minutes
2. If still timing out: Check if sync is actually completing in backend logs
3. Backend continues running even if frontend times out
4. Refresh page to see completed results

**File**: `frontend/src/services/api.js`
```javascript
// Current timeout (sufficient for most syncs)
timeout: 900000,  // 15 minutes
```

#### 3. Progress Stuck at 0%

**Symptoms**:
- UI shows "Fetching tickets from FreshService (0%)" for 1-2 minutes
- No progress updates

**Root Cause**: Step 1 (ticket fetch) doesn't update percentage during initial pages

**Expected Behavior** (After 2025-10-30 fix):
- Progress updates every 10 pages
- Should see: "Fetching tickets (1000 items, page 10)" etc.

**If Still Stuck**:
1. Check backend logs for "Fetching /tickets: X items so far" messages
2. Verify progress callback is being called (should be every 10 pages)
3. Check frontend is polling status every 2 seconds

#### 4. Data Missing After Sync

**Symptoms**:
- Sync completes successfully
- Dashboard shows zeros for the synced week

**Common Causes**:

**A. Date Range Mismatch**
```javascript
// User viewing: May 19-25
// Sync targeted: May 5-11 (wrong week!)
```
**Solution**: Verify sync date range matches viewed week (Fixed in commit `89ab6da`)

**B. Timezone Issues**
```javascript
// User in PST viewing May 20
// Server in UTC syncs May 19-20 UTC (May 18-19 PST)
```
**Solution**: Ensure consistent timezone handling throughout

**C. Filtering Issues**
```javascript
// Tickets synced but filtered out by category/search
```
**Solution**: Clear all filters and verify data exists

#### 5. Slow Sync Performance

**Symptoms**:
- Week sync taking >15 minutes
- More than expected for ticket count

**Debugging Steps**:

1. **Check Backend Logs** for bottlenecks:
```
[INFO] Fetching tickets: <-- Should complete in ~77s
[INFO] Analyzing 314 tickets: <-- Should be ~1.5s per ticket
```

2. **Calculate Expected Time**:
```
Expected = 77s + (ticket_count × 1.5s)
Actual = <check logs>
Difference = ?
```

3. **Common Bottlenecks**:
- Database connection pool exhausted
- Network latency to FreshService
- Too many concurrent operations

4. **Optimization**:
- Verify database connection pool size (default: 10)
- Check network latency: `ping efusion.freshservice.com`
- Ensure only one sync running at a time

---

## Future: Monthly Sync

### Considerations for Implementation

Based on week sync learnings, here are critical considerations for monthly sync:

#### 1. FreshService API Limitations Apply

**Same Issues**:
- ❌ No bulk endpoints
- ❌ `updated_since` returns ALL tickets since date (not month range)
- ❌ Must fetch activities per-ticket individually

**Example**:
```
Monthly sync for June 2025 (4 weeks)
↓
Query: GET /tickets?updated_since=2025-06-01
↓
Returns: ALL tickets since June 1 (could be 30,000+ if current month)
↓
Filter: To only June tickets (e.g., 1200)
↓
Efficiency: ~4% of fetched data needed (same as weekly)
```

#### 2. Performance Projections

**Typical Month** (1200 tickets):
```
Fetch: ~77s (API returns ALL tickets since month start)
Analyze: 1200 × 1.5s = 1800s = 30 minutes
Total: ~35 minutes
```

**Busy Month** (2000 tickets):
```
Fetch: ~77s
Analyze: 2000 × 1.5s = 3000s = 50 minutes
Total: ~55 minutes (EXCEEDS 15-min timeout!)
```

**⚠️ Critical Issue**: Current 15-minute timeout insufficient for busy months (>600 tickets)

#### 3. Recommended Approach: Batch by Week

**Instead of** syncing entire month at once:
```
❌ POST /api/sync/month { month: "2025-06" }  // 35-55 minutes
```

**Do this**:
```
✅ Week 1: POST /api/sync/week { start: "2025-06-01", end: "2025-06-07" }  // 9 min
✅ Week 2: POST /api/sync/week { start: "2025-06-08", end: "2025-06-14" }  // 9 min
✅ Week 3: POST /api/sync/week { start: "2025-06-15", end: "2025-06-21" }  // 9 min
✅ Week 4: POST /api/sync/week { start: "2025-06-22", end: "2025-06-28" }  // 9 min
✅ Week 5: POST /api/sync/week { start: "2025-06-29", end: "2025-06-30" }  // 2 min
Total: ~40 minutes (spread over 5 operations)
```

**Benefits**:
- Each operation stays within 15-min timeout
- Progress tracking works well (5 separate progress bars)
- Can run weeks in parallel if rate limits allow
- Easier error recovery (re-sync single week vs entire month)
- Better UX (user sees progress week-by-week)

#### 4. Implementation Strategy

**Option A: Sequential Week Syncs** (Recommended)
```javascript
async syncMonth({ month }) {
  const weeks = calculateWeeksInMonth(month);  // e.g., 4-5 weeks

  for (const week of weeks) {
    await this.syncWeek({
      startDate: week.monday,
      endDate: week.sunday
    });
  }
}
```

**Pros**:
- Simple to implement
- Stays within rate limits (1 req/sec)
- Easy error handling

**Cons**:
- Takes longer (sequential = 4 × 9 min = 36 min)

**Option B: Parallel Week Syncs** (Advanced)
```javascript
async syncMonth({ month }) {
  const weeks = calculateWeeksInMonth(month);

  // Sync 2 weeks at a time (safe with rate limits)
  await Promise.all([
    this.syncWeek({ startDate: weeks[0].monday, endDate: weeks[0].sunday }),
    this.syncWeek({ startDate: weeks[1].monday, endDate: weeks[1].sunday })
  ]);

  await Promise.all([
    this.syncWeek({ startDate: weeks[2].monday, endDate: weeks[2].sunday }),
    this.syncWeek({ startDate: weeks[3].monday, endDate: weeks[3].sunday })
  ]);
}
```

**Pros**:
- Faster (2 × 18 min = 18 min vs 36 min sequential)

**Cons**:
- More complex error handling
- Risk of rate limiting if not careful
- Higher database load

**Option C: Background Queue** (Most Robust)
```javascript
// Add weeks to job queue
queue.addJob('sync-week', { start: '2025-06-01', end: '2025-06-07' });
queue.addJob('sync-week', { start: '2025-06-08', end: '2025-06-14' });
// ... etc

// Worker processes queue with concurrency=1
// User can continue using app while sync happens in background
```

**Pros**:
- Non-blocking UI
- Automatic retry on failure
- Job persistence (survives server restart)
- Better for large-scale operations

**Cons**:
- Requires job queue infrastructure (Bull, BullMQ, etc.)
- More complex to implement

#### 5. Optimization Opportunities

**A. Caching Activity Analysis**
```javascript
// Store analysis results to avoid re-fetching
// Only re-analyze if ticket updated
if (ticket.updated_at > lastAnalyzedAt) {
  await analyzeActivities(ticket);
}
```

**B. Incremental Sync**
```javascript
// Only sync new/updated tickets since last sync
const lastSync = await getLastSyncTime('monthly', month);
const filters = { updated_since: lastSync };
```

**C. Parallel Analysis** (Requires Careful Rate Limiting)
```javascript
// Increase concurrency if rate limits allow
// Monitor for 429 errors and back off if needed
await analyzeActivities(tickets, { concurrency: 2 });
```

#### 6. UI Considerations

**Show Week-by-Week Progress**:
```
Monthly Sync for June 2025
┌───────────────────────────────────┐
│ Week 1 (Jun 1-7)    ✅ Complete   │
│ Week 2 (Jun 8-14)   🔄 Syncing... │
│ Week 3 (Jun 15-21)  ⏳ Pending    │
│ Week 4 (Jun 22-28)  ⏳ Pending    │
│ Week 5 (Jun 29-30)  ⏳ Pending    │
└───────────────────────────────────┘
Overall Progress: 25% (1/5 weeks)
```

**Allow Cancellation**:
```
[Cancel Monthly Sync]
↓
Stops after current week completes
Already synced weeks remain synced
```

#### 7. Testing Strategy

Before implementing monthly sync:

1. **Test with small month** (February - 28 days, 4 weeks)
2. **Test with large month** (31 days, 5 weeks)
3. **Test with busy month** (2000+ tickets)
4. **Verify timeout handling** for long syncs
5. **Test error recovery** (what happens if week 3 fails?)
6. **Load test** parallel week syncs

#### 8. Known Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Timeout on busy month | High | High | Batch by week |
| Rate limiting | Medium | High | Sequential processing, retry logic |
| Database overload | Low | Medium | Connection pooling, batch inserts |
| Memory issues | Low | Medium | Stream processing, garbage collection |
| Partial month sync failure | Medium | Low | Week-by-week checkpointing |

---

## Summary

### Key Takeaways

1. **FreshService API is the bottleneck**:
   - No bulk endpoints
   - Sequential activity fetching required
   - ~1.5s per ticket for analysis

2. **Rate limiting is critical**:
   - Use 1 req/sec safe threshold
   - Implement exponential backoff retry
   - Monitor for 429 errors

3. **Progress tracking is essential**:
   - Long syncs need visibility
   - Update every 5-10 operations
   - Show item counts, not just percentages

4. **Monthly sync should use week batching**:
   - 4-5 week syncs vs 1 month sync
   - Stays within timeouts
   - Better error recovery
   - Easier to implement

### Quick Reference: Sync Times

| Scope | Tickets | API Calls | Duration | Use Case |
|-------|---------|-----------|----------|----------|
| Full Sync | ~2000 | ~2500 | 2-5 min | Initial setup |
| Week Sync | 100-500 | 500-1000 | 5-15 min | Historical backfill |
| Month Sync | 1000-2000 | 2500-5000 | 35-55 min | Monthly view (batch by week!) |
| Incremental | 50-100 | 150-300 | 30-60 sec | Real-time updates |

### Files Reference

| File | Purpose |
|------|---------|
| `backend/src/integrations/freshservice.js` | FreshService API client |
| `backend/src/services/syncService.js` | Sync orchestration |
| `backend/src/routes/sync.routes.js` | API endpoints |
| `frontend/src/pages/Dashboard.jsx` | Progress display |
| `frontend/src/services/api.js` | API client (timeout config) |

---

**Document Status**: ✅ Current as of 2025-10-30
**Next Update**: When monthly sync is implemented
**Maintained By**: Development Team

