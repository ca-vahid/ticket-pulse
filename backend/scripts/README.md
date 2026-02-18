# Backend Scripts

This directory contains utility scripts for maintaining and troubleshooting the Ticket Pulse application.

## Available Scripts

### `backfill-pickup-times.js`

**Purpose**: Backfill missing pickup times (firstAssignedAt) for tickets by fetching their activity history from FreshService.

**When to use**:
- After initial setup when historical tickets don't have pickup times
- When you notice many tickets showing "Age" instead of "Pickup" time in the UI
- After a sync failure that missed activity analysis

**Usage**:
```bash
# From the backend directory
node scripts/backfill-pickup-times.js [options]
```

**Options**:
- `--days=N` - Only process tickets created in the last N days (default: 30)
- `--limit=N` - Process N tickets per batch (default: 100)
- `--all` - Process all batches until complete (default: one batch only)
- `--concurrency=N` - Number of parallel API calls (default: 5)
- `--help`, `-h` - Show help message

**Examples**:

```bash
# Process one batch of 100 tickets from the last 30 days (safest for first run)
node scripts/backfill-pickup-times.js

# Process all tickets from the last 30 days
node scripts/backfill-pickup-times.js --all

# Process all tickets from the last 7 days only
node scripts/backfill-pickup-times.js --days=7 --all

# Process only 50 tickets (useful for testing)
node scripts/backfill-pickup-times.js --limit=50

# Process all tickets from last 60 days with higher concurrency
node scripts/backfill-pickup-times.js --days=60 --all --concurrency=10
```

**Output**:
```
🔄 Starting Pickup Time Backfill

Options:
  - Days to sync: 30
  - Batch limit: 100
  - Process all: Yes
  - Concurrency: 5 parallel requests

✅ Backfill Complete!

Summary:
  - Tickets processed: 247
  - Successfully updated: 245
  - Failed: 2
  - Batches processed: 3
  - Total duration: 45.2s

✨ Pickup times have been backfilled. The frontend will now show pickup times for these tickets.
```

**Important Notes**:
- The script respects FreshService API rate limits by using controlled concurrency
- Failed tickets are logged but don't stop the entire process
- The script only processes tickets that are:
  - Assigned to a technician (`assignedTechId` is not null)
  - Missing `firstAssignedAt` timestamp
  - Created within the specified date range
- Closed/resolved tickets are also processed if they meet the criteria

**Troubleshooting**:

If you see many failures:
1. Check your FreshService API key is valid
2. Verify network connectivity to FreshService
3. Check the backend logs for specific error messages
4. Try reducing `--concurrency` to avoid rate limiting

If no tickets are processed:
- All tickets already have pickup times (good!)
- Try increasing `--days` to look further back
- Check that tickets exist in the database with `assignedTechId` but no `firstAssignedAt`

**Performance**:
- Processing ~100 tickets takes approximately 15-20 seconds with concurrency of 5
- Each ticket requires one FreshService API call to fetch activities
- FreshService API rate limit is 5000 requests/hour (~83/minute)
