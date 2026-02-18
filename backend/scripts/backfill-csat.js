/**
 * CSAT Backfill Script
 * 
 * This script backfills CSAT (Customer Satisfaction) responses for existing tickets.
 * Since CSAT responses are rare (~1 in 300-400 tickets), this script will:
 * 1. Get all closed/resolved tickets without CSAT data
 * 2. Check each ticket for CSAT responses via FreshService API
 * 3. Update the database with found CSAT data
 * 
 * Usage:
 *   node scripts/backfill-csat.js [--limit=1000] [--batch-size=50]
 * 
 * Options:
 *   --limit=N       Maximum number of tickets to process (default: 1000)
 *   --batch-size=N  Number of tickets to process in each batch (default: 50)
 *   --dry-run       Run without updating the database
 */

import FreshServiceClient from '../src/integrations/freshservice.js';
import ticketRepository from '../src/services/ticketRepository.js';
import csatService from '../src/services/csatService.js';
import logger from '../src/utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

// Parse command line arguments
const args = process.argv.slice(2);
const limit = parseInt(args.find(arg => arg.startsWith('--limit='))?.split('=')[1]) || 1000;
const batchSize = parseInt(args.find(arg => arg.startsWith('--batch-size='))?.split('=')[1]) || 50;
const dryRun = args.includes('--dry-run');

async function backfillCSAT() {
  const startTime = Date.now();
  
  console.log('\n=== CSAT Backfill Script ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Limit: ${limit} tickets`);
  console.log(`Batch size: ${batchSize} tickets\n`);

  try {
    // Initialize FreshService client
    const client = new FreshServiceClient(
      process.env.FRESHSERVICE_DOMAIN,
      process.env.FRESHSERVICE_API_KEY
    );

    // Get all closed/resolved tickets without CSAT
    console.log('Step 1: Fetching tickets without CSAT responses...');
    const tickets = await ticketRepository.getAllClosedWithoutCSAT(limit);
    console.log(`✓ Found ${tickets.length} tickets to check\n`);

    if (tickets.length === 0) {
      console.log('No tickets to process. Exiting.');
      return;
    }

    // Process in batches
    const results = {
      total: tickets.length,
      processed: 0,
      csatFound: 0,
      updated: 0,
      errors: 0,
      startTime,
    };

    console.log('Step 2: Checking tickets for CSAT responses...\n');

    for (let i = 0; i < tickets.length; i += batchSize) {
      const batch = tickets.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(tickets.length / batchSize);

      console.log(`\n--- Batch ${batchNum}/${totalBatches} (${batch.length} tickets) ---`);

      for (const ticket of batch) {
        results.processed++;
        const ticketId = Number(ticket.freshserviceTicketId);

        try {
          // Fetch CSAT response
          const csatResponse = await client.fetchCSATResponse(ticketId);

          if (csatResponse) {
            results.csatFound++;

            // Transform CSAT data
            const csatData = csatService.transformCSATResponse(csatResponse);

            if (csatData) {
              console.log(`  ✓ INC-${ticketId}: Found CSAT score ${csatData.csatScore}/${csatData.csatTotalScore}`);
              
              if (csatData.csatFeedback) {
                const feedbackPreview = csatData.csatFeedback.substring(0, 80);
                console.log(`    Feedback: "${feedbackPreview}${csatData.csatFeedback.length > 80 ? '...' : ''}"`);
              }

              // Update database (unless dry run)
              if (!dryRun) {
                await ticketRepository.updateByFreshserviceId(ticketId, csatData);
                results.updated++;
              } else {
                console.log(`    [DRY RUN] Would update ticket ${ticketId}`);
              }
            }
          }

          // Progress indicator every 10 tickets
          if (results.processed % 10 === 0) {
            const elapsed = (Date.now() - startTime) / 1000;
            const rate = results.processed / elapsed;
            const remaining = (results.total - results.processed) / rate;
            console.log(`  Progress: ${results.processed}/${results.total} (${rate.toFixed(1)}/sec, ~${Math.ceil(remaining)}s remaining)`);
          }

          // Rate limiting: Small delay between requests
          await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
          results.errors++;
          // Handle axios errors that have circular references
          // Extract only safe properties to avoid circular reference errors
          let errorMsg = 'Unknown error';
          try {
            if (error.response?.status === 429) {
              errorMsg = 'Rate limited - max retries exceeded';
            } else if (error.response?.status) {
              errorMsg = `HTTP ${error.response.status}`;
            } else if (typeof error === 'string') {
              errorMsg = error;
            } else if (error.message && typeof error.message === 'string') {
              errorMsg = error.message;
            }
          } catch (e) {
            errorMsg = 'Error while processing error message';
          }
          console.error(`  ✗ INC-${ticketId}: ${errorMsg}`);
        }
      }

      // Longer delay between batches
      if (i + batchSize < tickets.length) {
        console.log(`\n  Waiting 2 seconds before next batch...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Summary
    const elapsed = (Date.now() - startTime) / 1000;
    console.log('\n\n=== Backfill Complete ===');
    console.log(`Total processed: ${results.processed}`);
    console.log(`CSAT responses found: ${results.csatFound} (${(results.csatFound / results.processed * 100).toFixed(2)}%)`);
    console.log(`Records updated: ${dryRun ? 0 : results.updated}`);
    console.log(`Errors: ${results.errors}`);
    console.log(`Time elapsed: ${elapsed.toFixed(1)}s`);
    console.log(`Average rate: ${(results.processed / elapsed).toFixed(2)} tickets/second\n`);

    if (dryRun) {
      console.log('NOTE: This was a DRY RUN. No database changes were made.');
      console.log('Run without --dry-run to actually update the database.\n');
    }

  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    logger.error('CSAT backfill error:', error);
    process.exit(1);
  }
}

// Run the backfill
backfillCSAT()
  .then(() => {
    console.log('Backfill script completed successfully.');
    process.exit(0);
  })
  .catch(error => {
    console.error('Backfill script failed:', error);
    process.exit(1);
  });

