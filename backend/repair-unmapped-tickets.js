/**
 * Comprehensive Ticket Repair Script
 *
 * Purpose: Fix historical tickets that have NULL assignedTechId but DO have
 * a responder_id in FreshService. This happened because older sync code didn't
 * properly map technician IDs.
 *
 * The refactored sync code (post-Oct 2024) correctly maps all tickets, so this
 * script is only needed ONCE to repair historical data.
 *
 * Future syncs (including historical weeks) will work correctly without needing this fix.
 */

import { PrismaClient } from '@prisma/client';
import technicianRepository from './src/services/technicianRepository.js';

const prisma = new PrismaClient();

async function repairUnmappedTickets() {
  try {
    console.log('═'.repeat(70));
    console.log('COMPREHENSIVE TICKET REPAIR SCRIPT');
    console.log('═'.repeat(70));
    console.log();
    console.log('This script fixes tickets with NULL assignedTechId by fetching their');
    console.log('responder_id from FreshService and mapping to internal technician IDs.');
    console.log();

    // Step 1: Find all unmapped tickets
    console.log('[1/5] Finding tickets with missing assignedTechId...');
    const brokenTickets = await prisma.ticket.findMany({
      where: {
        assignedTechId: null,
        OR: [
          { firstAssignedAt: { not: null } },
          { status: { in: ['Closed', 'Resolved'] } },
        ],
      },
      select: {
        id: true,
        freshserviceTicketId: true,
        subject: true,
        status: true,
        firstAssignedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' }, // Most recent first
    });

    console.log(`   Found ${brokenTickets.length} tickets needing repair\n`);

    if (brokenTickets.length === 0) {
      console.log('✅ No tickets need fixing!\n');
      return { fixed: 0, skipped: 0, errors: 0 };
    }

    // Show sample
    console.log('   Sample tickets:');
    brokenTickets.slice(0, 5).forEach(t => {
      console.log(`     #${t.freshserviceTicketId}: ${t.subject?.substring(0, 50)}...`);
    });
    console.log();

    // Step 2: Build technician ID mapping
    console.log('[2/5] Building technician ID map...');
    const technicians = await technicianRepository.getAllActive();
    const fsIdToInternalId = new Map();
    const internalIdToName = new Map();

    technicians.forEach(tech => {
      fsIdToInternalId.set(Number(tech.freshserviceId), tech.id);
      internalIdToName.set(tech.id, tech.name);
    });

    console.log(`   Built map for ${technicians.length} active technicians\n`);

    // Step 3: Fetch tickets from FreshService and map
    console.log('[3/5] Fetching tickets from FreshService and mapping...');
    console.log(`   Processing ${brokenTickets.length} tickets (rate limited to 1 req/sec)`);
    console.log(`   Estimated time: ${Math.ceil(brokenTickets.length / 60)} minutes\n`);

    const apiKey = process.env.FRESHSERVICE_API_KEY;
    const domain = process.env.FRESHSERVICE_DOMAIN;
    const authHeader = 'Basic ' + Buffer.from(apiKey + ':X').toString('base64');

    let fixed = 0;
    let skipped = 0; // No responder in FreshService
    let errors = 0;
    let lastProgressUpdate = 0;

    for (let i = 0; i < brokenTickets.length; i++) {
      const ticket = brokenTickets[i];

      try {
        // Rate limiting: 1 request per second
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 1100));
        }

        // Progress reporting every 10 tickets
        if (i - lastProgressUpdate >= 10 || i === brokenTickets.length - 1) {
          const percent = Math.round((i / brokenTickets.length) * 100);
          console.log(`   Progress: ${i}/${brokenTickets.length} (${percent}%) | Fixed: ${fixed}, Skipped: ${skipped}, Errors: ${errors}`);
          lastProgressUpdate = i;
        }

        // Fetch ticket from FreshService
        const response = await fetch(
          `https://${domain}/api/v2/tickets/${ticket.freshserviceTicketId}`,
          {
            headers: {
              'Authorization': authHeader,
              'Content-Type': 'application/json',
            },
          }
        );

        if (!response.ok) {
          if (response.status === 404) {
            skipped++; // Ticket deleted from FreshService
            continue;
          }
          console.log(`   ✗ #${ticket.freshserviceTicketId}: API error ${response.status}`);
          errors++;
          continue;
        }

        const data = await response.json();
        const fsTicket = data.ticket;

        // Skip if no responder
        if (!fsTicket.responder_id) {
          skipped++;
          continue;
        }

        // Map responder_id to internal ID
        const internalId = fsIdToInternalId.get(Number(fsTicket.responder_id));

        if (!internalId) {
          // Responder not in our active technicians list
          skipped++;
          continue;
        }

        // Update ticket in database
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: { assignedTechId: internalId },
        });

        fixed++;

      } catch (error) {
        const errorMsg = error.message?.substring(0, 50) || String(error).substring(0, 50);
        if (errors < 10) { // Only log first 10 errors
          console.log(`   ✗ #${ticket.freshserviceTicketId}: ${errorMsg}`);
        }
        errors++;
      }
    }

    console.log(`\n   Final: ${brokenTickets.length}/${brokenTickets.length} (100%)\n`);

    // Step 4: Verify repair
    console.log('[4/5] Verifying repair...');
    const remainingUnmapped = await prisma.ticket.count({
      where: {
        assignedTechId: null,
        OR: [
          { firstAssignedAt: { not: null } },
          { status: { in: ['Closed', 'Resolved'] } },
        ],
      },
    });

    console.log(`   Unmapped tickets remaining: ${remainingUnmapped}`);
    console.log(`   (These likely have no responder in FreshService)\n`);

    // Step 5: Summary
    console.log('[5/5] Summary');
    console.log('─'.repeat(70));
    console.log(`   Total tickets processed:      ${brokenTickets.length}`);
    console.log(`   ✅ Successfully fixed:         ${fixed}`);
    console.log(`   ⏭️  Skipped (no responder):     ${skipped}`);
    console.log(`   ❌ Errors:                     ${errors}`);
    console.log(`   📊 Remaining unmapped:         ${remainingUnmapped}`);
    console.log('─'.repeat(70));

    if (fixed > 0) {
      console.log();
      console.log('✅ Repair completed successfully!');
      console.log('   Dashboard should now show correct historical ticket counts.');
      console.log('   Future syncs will work correctly without needing this repair.');
    }

    console.log();
    console.log('═'.repeat(70));
    console.log();

    return { fixed, skipped, errors, remaining: remainingUnmapped };

  } catch (error) {
    console.error('\n❌ Error during repair:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the repair
repairUnmappedTickets()
  .then((result) => {
    console.log('Repair script finished\n');
    process.exit(result.errors > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error('\n❌ Repair script failed:', error);
    process.exit(1);
  });
