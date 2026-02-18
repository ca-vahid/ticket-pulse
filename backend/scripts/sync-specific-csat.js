// Sync CSAT for specific tickets immediately
import FreshServiceClient from '../src/integrations/freshservice.js';
import ticketRepository from '../src/services/ticketRepository.js';
import csatService from '../src/services/csatService.js';
import dotenv from 'dotenv';

dotenv.config();

const ticketsToSync = [199938, 198296]; // Add more ticket IDs here

async function syncSpecificCSAT() {
  console.log('\n=== Syncing Specific CSAT Tickets ===\n');
  
  try {
    const client = new FreshServiceClient(
      process.env.FRESHSERVICE_DOMAIN,
      process.env.FRESHSERVICE_API_KEY
    );

    for (const ticketId of ticketsToSync) {
      console.log(`Processing INC-${ticketId}...`);
      
      try {
        const found = await csatService.syncTicketCSAT(client, ticketRepository, ticketId);
        
        if (found) {
          console.log(`  ✓ Updated CSAT for INC-${ticketId}`);
        } else {
          console.log(`  - No CSAT response for INC-${ticketId}`);
        }
      } catch (error) {
        console.error(`  ✗ Error: ${error.message}`);
      }
    }
    
    console.log('\n✅ Sync complete!\n');
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    process.exit(0);
  }
}

syncSpecificCSAT();

