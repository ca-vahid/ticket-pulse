/**
 * Backfill Script: Fix tickets with missing assignedTechId
 *
 * Problem: syncWeek() was missing technician ID mapping, causing ~87 tickets
 * to have assignedFreshserviceId but assignedTechId=NULL. This makes them
 * invisible in dashboard stats.
 *
 * Solution: Map assignedFreshserviceId to assignedTechId for all affected tickets.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function backfillTechnicianAssignments() {
  console.log('='.repeat(60));
  console.log('Backfill Script: Fixing Missing Technician Assignments');
  console.log('='.repeat(60));

  try {
    // Step 1: Find all tickets with assignedBy name but no assignedTechId
    console.log('\n[1/4] Finding tickets with missing assignedTechId...');
    const brokenTickets = await prisma.ticket.findMany({
      where: {
        assignedBy: {
          not: null,
        },
        assignedTechId: null,
      },
      select: {
        id: true,
        freshserviceTicketId: true,
        assignedBy: true,
        subject: true,
        createdAt: true,
        firstAssignedAt: true,
      },
    });

    console.log(`   Found ${brokenTickets.length} tickets needing repair`);

    if (brokenTickets.length === 0) {
      console.log('\n✅ No tickets need repair! All tickets are properly linked.');
      return;
    }

    // Show sample of broken tickets
    console.log('\n   Sample of affected tickets:');
    brokenTickets.slice(0, 5).forEach(t => {
      console.log(`   - #${t.freshserviceTicketId}: Assigned by "${t.assignedBy}" → NO INTERNAL LINK`);
    });
    if (brokenTickets.length > 5) {
      console.log(`   ... and ${brokenTickets.length - 5} more`);
    }

    // Step 2: Get all technicians and build name → ID mapping
    console.log('\n[2/4] Building technician name → Internal ID mapping...');
    const technicians = await prisma.technician.findMany({
      select: {
        id: true,
        name: true,
        isActive: true,
      },
    });

    const nameToInternalId = new Map();
    const internalIdToName = new Map();

    technicians.forEach(tech => {
      nameToInternalId.set(tech.name, tech.id);
      internalIdToName.set(tech.id, tech.name);
    });

    console.log(`   Built mapping for ${technicians.length} technicians`);

    // Step 3: Update tickets with correct assignedTechId
    console.log('\n[3/4] Updating tickets with correct technician assignments...');

    let fixed = 0;
    let notFound = 0;
    const notFoundNames = new Set();

    for (const ticket of brokenTickets) {
      const assignedByName = ticket.assignedBy;
      const internalId = nameToInternalId.get(assignedByName);

      if (internalId) {
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: { assignedTechId: internalId },
        });
        fixed++;

        if (fixed <= 5) {
          console.log(`   ✓ #${ticket.freshserviceTicketId} → ${assignedByName} (ID: ${internalId})`);
        }
      } else {
        notFound++;
        notFoundNames.add(assignedByName);
      }
    }

    if (fixed > 5) {
      console.log(`   ... and ${fixed - 5} more tickets fixed`);
    }

    // Step 4: Report results
    console.log('\n[4/4] Summary:');
    console.log('─'.repeat(60));
    console.log(`   Total tickets processed:  ${brokenTickets.length}`);
    console.log(`   ✅ Successfully fixed:     ${fixed}`);
    console.log(`   ⚠️  Could not map:          ${notFound}`);
    console.log('─'.repeat(60));

    if (notFound > 0) {
      console.log('\n⚠️  Some tickets could not be mapped (technician name not in DB):');
      notFoundNames.forEach(name => {
        const count = brokenTickets.filter(t => t.assignedBy === name).length;
        console.log(`   - "${name}": ${count} ticket(s)`);
      });
      console.log('\n   These may be inactive technicians, external responders, or name mismatches.');
    }

    if (fixed > 0) {
      console.log('\n✅ Backfill completed successfully!');
      console.log('   Dashboard should now show all tickets correctly.');
    }

  } catch (error) {
    console.error('\n❌ Error during backfill:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the backfill
backfillTechnicianAssignments()
  .then(() => {
    console.log('\n' + '='.repeat(60));
    console.log('Backfill script finished');
    console.log('='.repeat(60) + '\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Backfill script failed:', error);
    process.exit(1);
  });
