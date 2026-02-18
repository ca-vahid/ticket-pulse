/**
 * Manual script to backfill pickup times (firstAssignedAt) for tickets
 *
 * This script fetches FreshService activities for tickets missing firstAssignedAt
 * and updates them with the timestamp of their first assignment.
 *
 * Usage:
 *   node scripts/backfill-pickup-times.js [options]
 *
 * Options:
 *   --days=N         Only process tickets created in last N days (default: 30)
 *   --limit=N        Process N tickets per batch (default: 100)
 *   --all            Process all batches until complete (default: process one batch)
 *   --concurrency=N  Number of parallel API calls (default: 5)
 *
 * Examples:
 *   node scripts/backfill-pickup-times.js                    # Process one batch of 100 tickets from last 30 days
 *   node scripts/backfill-pickup-times.js --all              # Process all tickets from last 30 days
 *   node scripts/backfill-pickup-times.js --days=7 --all     # Process all tickets from last 7 days
 *   node scripts/backfill-pickup-times.js --limit=50         # Process 50 tickets only
 */

import syncService from '../src/services/syncService.js';
import logger from '../src/utils/logger.js';

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  daysToSync: 30,
  limit: 100,
  processAll: false,
  concurrency: 5,
};

for (const arg of args) {
  if (arg.startsWith('--days=')) {
    options.daysToSync = parseInt(arg.split('=')[1], 10);
  } else if (arg.startsWith('--limit=')) {
    options.limit = parseInt(arg.split('=')[1], 10);
  } else if (arg === '--all') {
    options.processAll = true;
  } else if (arg.startsWith('--concurrency=')) {
    options.concurrency = parseInt(arg.split('=')[1], 10);
  } else if (arg === '--help' || arg === '-h') {
    console.log(`
Manual Pickup Time Backfill Script

This script fetches FreshService activities for tickets missing firstAssignedAt
and updates them with the timestamp of their first assignment.

Usage:
  node scripts/backfill-pickup-times.js [options]

Options:
  --days=N         Only process tickets created in last N days (default: 30)
  --limit=N        Process N tickets per batch (default: 100)
  --all            Process all batches until complete (default: process one batch)
  --concurrency=N  Number of parallel API calls (default: 5)
  --help, -h       Show this help message

Examples:
  node scripts/backfill-pickup-times.js                    # Process one batch of 100 tickets from last 30 days
  node scripts/backfill-pickup-times.js --all              # Process all tickets from last 30 days
  node scripts/backfill-pickup-times.js --days=7 --all     # Process all tickets from last 7 days
  node scripts/backfill-pickup-times.js --limit=50         # Process 50 tickets only
    `);
    process.exit(0);
  }
}

async function main() {
  try {
    console.log('\n🔄 Starting Pickup Time Backfill\n');
    console.log('Options:');
    console.log(`  - Days to sync: ${options.daysToSync}`);
    console.log(`  - Batch limit: ${options.limit}`);
    console.log(`  - Process all: ${options.processAll ? 'Yes' : 'No (one batch only)'}`);
    console.log(`  - Concurrency: ${options.concurrency} parallel requests`);
    console.log('');

    const startTime = Date.now();

    const result = await syncService.backfillPickupTimes(options);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n✅ Backfill Complete!\n');
    console.log('Summary:');
    console.log(`  - Tickets processed: ${result.ticketsProcessed}`);
    console.log(`  - Successfully updated: ${result.successCount}`);
    console.log(`  - Failed: ${result.failureCount}`);
    console.log(`  - Batches processed: ${result.batchesProcessed}`);
    console.log(`  - Total duration: ${duration}s`);
    console.log('');

    if (result.successCount > 0) {
      console.log('✨ Pickup times have been backfilled. The frontend will now show pickup times for these tickets.');
    }

    if (result.failureCount > 0) {
      console.log('⚠️  Some tickets failed to process. Check the logs for details.');
    }

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Backfill failed:', error.message);
    logger.error('Backfill script error:', error);
    process.exit(1);
  }
}

main();
