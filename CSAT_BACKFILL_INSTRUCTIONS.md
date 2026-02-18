# CSAT Backfill Instructions

## Overview
This document provides instructions for running the CSAT backfill script to populate historical ticket data with customer satisfaction survey responses.

## Prerequisites
- Backend server is running
- Database connection is configured
- FreshService API credentials are set in `.env`

## Running the Backfill Script

### Option 1: Dry Run (Recommended First)
Test the script without making any database changes:

```bash
cd backend
node scripts/backfill-csat.js --dry-run
```

This will:
- Show you which tickets would be updated
- Display CSAT scores and feedback that would be saved
- Give you statistics without modifying the database

### Option 2: Limited Backfill (For Testing)
Process a small number of tickets to verify everything works:

```bash
cd backend
node scripts/backfill-csat.js --limit=100
```

### Option 3: Full Backfill (All Historical Tickets)
Process ALL closed/resolved tickets in the database:

```bash
cd backend
node scripts/backfill-csat.js --limit=999999
```

**Note:** This may take 30+ minutes depending on the number of tickets. The script includes:
- Rate limiting (100ms between requests)
- Batch processing
- Progress tracking with ETA
- Error handling (continues on individual failures)

### Option 4: Custom Batch Size
Process tickets with custom batch size for better monitoring:

```bash
cd backend
node scripts/backfill-csat.js --limit=5000 --batch-size=100
```

## Script Parameters

| Parameter | Description | Default | Example |
|-----------|-------------|---------|---------|
| `--limit` | Maximum number of tickets to process | 1000 | `--limit=5000` |
| `--batch-size` | Tickets per batch | 50 | `--batch-size=100` |
| `--dry-run` | Run without database updates | false | `--dry-run` |

## Expected Output

### Dry Run Example:
```
=== CSAT Backfill Script ===
Mode: DRY RUN
Limit: 100 tickets
Batch size: 50 tickets

Step 1: Fetching tickets without CSAT responses...
✓ Found 95 tickets to check

Step 2: Checking tickets for CSAT responses...

--- Batch 1/2 (50 tickets) ---
  ✓ INC-199938: Found CSAT score 1/4
    Feedback: "This IT response was extremely unhelpful..."
    [DRY RUN] Would update ticket 199938
  Progress: 50/95 (5.2/sec, ~9s remaining)

=== Backfill Complete ===
Total processed: 95
CSAT responses found: 0 (0.00%)
Records updated: 0
Errors: 0
Time elapsed: 18.3s
Average rate: 5.19 tickets/second

NOTE: This was a DRY RUN. No database changes were made.
Run without --dry-run to actually update the database.
```

### Full Run Example:
```
=== CSAT Backfill Script ===
Mode: LIVE
Limit: 999999 tickets
Batch size: 50 tickets

Step 1: Fetching tickets without CSAT responses...
✓ Found 3,247 tickets to check

Step 2: Checking tickets for CSAT responses...

--- Batch 1/65 (50 tickets) ---
  ✓ INC-199938: Found CSAT score 1/4
    Feedback: "This IT response was extremely unhelpful..."
  Progress: 50/3247 (4.8/sec, ~676s remaining)

... (processing continues) ...

=== Backfill Complete ===
Total processed: 3,247
CSAT responses found: 9 (0.28%)
Records updated: 9
Errors: 0
Time elapsed: 675.4s
Average rate: 4.81 tickets/second

Backfill script completed successfully.
```

## Verification

After running the backfill, verify the data:

### 1. Check Database
```sql
-- Count tickets with CSAT
SELECT COUNT(*) FROM tickets WHERE csat_score IS NOT NULL;

-- View recent CSAT responses
SELECT 
  freshservice_ticket_id,
  csat_score,
  csat_total_score,
  csat_rating_text,
  csat_submitted_at,
  LEFT(csat_feedback, 50) as feedback_preview
FROM tickets
WHERE csat_score IS NOT NULL
ORDER BY csat_submitted_at DESC
LIMIT 10;

-- Check specific ticket (INC-199938)
SELECT 
  freshservice_ticket_id,
  subject,
  csat_score,
  csat_total_score,
  csat_rating_text,
  csat_feedback,
  csat_submitted_at
FROM tickets
WHERE freshservice_ticket_id = 199938;
```

### 2. Check UI
1. Navigate to Dashboard
2. Look for technicians with CSAT indicators (yellow badge with star)
3. Click on a technician with CSAT
4. Click the "CSAT" tab
5. Verify CSAT tickets are displayed with scores and feedback

### 3. Check Specific Ticket
- Go to technician detail page
- Open CSAT tab
- Look for ticket INC-199938
- Should show: Score 1/4, rating "Poor", and long feedback

## Expected Results

Based on your data (~1 CSAT per 300-400 tickets):
- **For 3,000 tickets**: Expect ~8-10 CSAT responses
- **For 10,000 tickets**: Expect ~25-33 CSAT responses
- **Processing time**: ~5-10 tickets/second

## Troubleshooting

### Issue: "No tickets to process"
**Solution**: All tickets already have CSAT data or no closed tickets exist in database

### Issue: Many "404 Not Found" errors
**Solution**: Normal! Most tickets don't have CSAT responses. 404 means no CSAT for that ticket.

### Issue: Script running very slowly
**Solution**: 
- Check network connection to FreshService
- Increase `--batch-size` for better performance
- Verify API rate limits aren't being hit

### Issue: "Failed to fetch CSAT for ticket X"
**Solution**: Individual ticket errors are logged but script continues. Check logs for details.

## Re-running the Backfill

The script only processes tickets where `csat_response_id IS NULL`, so:
- Safe to run multiple times
- Only checks tickets without CSAT data
- Won't duplicate CSAT data
- Can be used to catch newly submitted CSAT responses

## Scheduled Backfill (Optional)

To automatically check for new CSAT responses daily:

### Windows Task Scheduler:
1. Open Task Scheduler
2. Create Basic Task
3. Schedule: Daily at 2:00 AM
4. Action: Start a program
5. Program: `node`
6. Arguments: `C:\path\to\backend\scripts\backfill-csat.js --limit=500`
7. Start in: `C:\path\to\backend`

### Linux Cron:
```bash
# Edit crontab
crontab -e

# Add daily job at 2 AM
0 2 * * * cd /path/to/backend && node scripts/backfill-csat.js --limit=500 >> /var/log/csat-backfill.log 2>&1
```

## Support

If you encounter issues:
1. Check `backend/logs/` for detailed error logs
2. Run with `--dry-run` to see what would happen
3. Start with small `--limit` values to test
4. Verify FreshService API credentials are correct

## Summary

**Recommended workflow:**
1. `node scripts/backfill-csat.js --dry-run --limit=50` - Test with small sample
2. `node scripts/backfill-csat.js --limit=500` - Process first 500 tickets
3. Verify in UI and database
4. `node scripts/backfill-csat.js --limit=999999` - Process all remaining tickets
5. Set up scheduled task for daily updates (optional)

---

**Last Updated:** November 20, 2025

