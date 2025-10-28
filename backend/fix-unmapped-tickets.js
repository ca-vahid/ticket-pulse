import { PrismaClient } from '@prisma/client';
import technicianRepository from './src/services/technicianRepository.js';

const prisma = new PrismaClient();

async function fixUnmappedTickets() {
  try {
    console.log('============================================================');
    console.log('Fix Script: Map Tickets with NULL assignedTechId');
    console.log('============================================================\n');

    // Find tickets with NULL assignedTechId but with firstAssignedAt or closed status
    // (these likely have a responder in FreshService)
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
        assignedBy: true,
      },
      take: 100, // Limit to first 100 to avoid overwhelming the script
    });

    console.log(`[1/3] Found ${brokenTickets.length} tickets with NULL assignedTechId\n`);

    if (brokenTickets.length === 0) {
      console.log('✅ No tickets need fixing!\n');
      return;
    }

    // Show sample
    console.log('Sample tickets:');
    brokenTickets.slice(0, 5).forEach(t => {
      console.log(`  #${t.freshserviceTicketId}: ${t.subject?.substring(0, 40)}... | Status: ${t.status}`);
    });
    console.log();

    // Get all technicians and build ID mapping
    console.log('[2/3] Building technician ID map...');
    const technicians = await technicianRepository.getAllActive();
    const fsIdToInternalId = new Map();
    const internalIdToName = new Map();

    technicians.forEach(tech => {
      fsIdToInternalId.set(Number(tech.freshserviceId), tech.id);
      internalIdToName.set(tech.id, tech.name);
    });

    console.log(`   Built map for ${technicians.length} active technicians\n`);

    // Now fetch each ticket from FreshService and map it
    console.log('[3/3] Fetching tickets from FreshService and mapping...');
    console.log('   (This will take a while due to API rate limiting)\n');

    const apiKey = process.env.FRESHSERVICE_API_KEY;
    const domain = process.env.FRESHSERVICE_DOMAIN;
    const authHeader = 'Basic ' + Buffer.from(apiKey + ':X').toString('base64');

    let fixed = 0;
    let notFound = 0;
    let errors = 0;

    for (let i = 0; i < brokenTickets.length; i++) {
      const ticket = brokenTickets[i];

      try {
        // Rate limiting: 1 request per second
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 1100));
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
          console.log(`   ✗ #${ticket.freshserviceTicketId}: API error ${response.status}`);
          errors++;
          continue;
        }

        const data = await response.json();
        const fsTicket = data.ticket;

        if (!fsTicket.responder_id) {
          notFound++;
          continue;
        }

        // Map responder_id to internal ID
        const internalId = fsIdToInternalId.get(Number(fsTicket.responder_id));

        if (!internalId) {
          console.log(`   ✗ #${ticket.freshserviceTicketId}: Responder ${fsTicket.responder_id} not in database`);
          notFound++;
          continue;
        }

        // Update ticket
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: { assignedTechId: internalId },
        });

        fixed++;

        if (fixed <= 10) {
          const techName = internalIdToName.get(internalId);
          console.log(`   ✓ #${ticket.freshserviceTicketId} → ${techName}`);
        } else if (fixed % 10 === 0) {
          console.log(`   ... ${fixed} tickets fixed so far`);
        }

      } catch (error) {
        console.log(`   ✗ #${ticket.freshserviceTicketId}: ${error.message}`);
        errors++;
      }
    }

    console.log('\n============================================================');
    console.log('Summary:');
    console.log('────────────────────────────────────────────────────────────');
    console.log(`   Total tickets processed:  ${brokenTickets.length}`);
    console.log(`   ✅ Successfully fixed:     ${fixed}`);
    console.log(`   ⚠️  No responder found:     ${notFound}`);
    console.log(`   ❌ Errors:                 ${errors}`);
    console.log('============================================================\n');

  } catch (error) {
    console.error('\n❌ Error during fix:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

fixUnmappedTickets()
  .then(() => {
    console.log('Fix script finished\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Fix script failed:', error);
    process.exit(1);
  });
