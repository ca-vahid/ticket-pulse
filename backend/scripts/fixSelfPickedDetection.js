import { PrismaClient } from '@prisma/client';
import { createFreshServiceClient } from '../src/integrations/freshservice.js';
import { analyzeTicketActivities } from '../src/integrations/freshserviceTransformer.js';
import settingsRepository from '../src/services/settingsRepository.js';
import logger from '../src/utils/logger.js';

const prisma = new PrismaClient();

async function fixSelfPickedDetection() {
  try {
    console.log('Starting self-picked detection fix...');

    // Initialize FreshService client
    const config = await settingsRepository.getFreshServiceConfig();
    const client = createFreshServiceClient(config.domain, config.apiKey);

    // Get all assigned tickets
    const tickets = await prisma.ticket.findMany({
      where: {
        assignedTechId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 20, // Process last 20 assigned tickets (reduced to avoid rate limiting)
    });

    console.log(`Found ${tickets.length} assigned tickets to analyze`);

    let updatedCount = 0;
    let selfPickedCount = 0;
    let rateLimitErrors = 0;

    for (const ticket of tickets) {
      try {
        // Fetch activities for this ticket
        const activities = await client.fetchTicketActivities(ticket.freshserviceTicketId);

        // Analyze for self-picked
        const analysis = analyzeTicketActivities(activities);

        // Update ticket if detection result is different
        if (analysis.isSelfPicked !== ticket.isSelfPicked) {
          await prisma.ticket.update({
            where: { id: ticket.id },
            data: { isSelfPicked: analysis.isSelfPicked },
          });

          updatedCount++;
          if (analysis.isSelfPicked) {
            selfPickedCount++;
            console.log(`✓ Ticket ${ticket.freshserviceTicketId}: SELF-PICKED`);
          } else {
            console.log(`✓ Ticket ${ticket.freshserviceTicketId}: Coordinator-assigned`);
          }
        }

        // Rate limiting - wait 1.5 seconds between requests (slower to avoid 429)
        await new Promise(resolve => setTimeout(resolve, 1500));
      } catch (error) {
        if (error.message.includes('429')) {
          rateLimitErrors++;
          console.log(`⚠ Rate limit hit for ticket ${ticket.freshserviceTicketId}, stopping...`);
          break; // Stop processing if we hit rate limit
        }
        console.error(`Error processing ticket ${ticket.freshserviceTicketId}:`, error.message);
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Total tickets processed: ${tickets.length}`);
    console.log(`Tickets updated: ${updatedCount}`);
    console.log(`Self-picked tickets found: ${selfPickedCount}`);
    console.log(`Coordinator-assigned tickets: ${updatedCount - selfPickedCount}`);
    console.log(`Rate limit errors: ${rateLimitErrors}`);

    console.log(`\n=== Summary ===`);
    console.log(`Total tickets processed: ${tickets.length}`);
    console.log(`Tickets updated: ${updatedCount}`);
    console.log(`Self-picked tickets found: ${selfPickedCount}`);
    console.log(`Coordinator-assigned tickets: ${updatedCount - selfPickedCount}`);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fixSelfPickedDetection();
