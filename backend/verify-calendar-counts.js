/**
 * Verify calendar counts vs sum of technician breakdown
 */

import { PrismaClient } from '@prisma/client';
import { getTodayRange } from './src/utils/timezone.js';
import technicianRepository from './src/services/technicianRepository.js';

const prisma = new PrismaClient();

async function verifyWeekCounts() {
  try {
    console.log('═'.repeat(80));
    console.log('CALENDAR VS TECHNICIAN BREAKDOWN VERIFICATION');
    console.log('Week: Aug 25-31, 2025');
    console.log('═'.repeat(80));
    console.log();

    const timezone = 'America/Los_Angeles';
    const weekStart = new Date('2025-08-25T00:00:00Z');
    const weekEnd = new Date('2025-08-31T23:59:59Z');

    // Fetch all active technicians with tickets
    const technicians = await technicianRepository.getAllActive();

    console.log(`Loaded ${technicians.length} active technicians\n`);

    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    console.log('DAY-BY-DAY VERIFICATION:');
    console.log('─'.repeat(80));
    console.log('Day         | Calendar Count | Sum of Tech Counts | Match?');
    console.log('─'.repeat(80));

    for (let i = 0; i < 7; i++) {
      const date = new Date('2025-08-25T00:00:00Z');
      date.setDate(date.getDate() + i);

      const result = getTodayRange(timezone, date);
      const { start, end } = result;

      // CALENDAR COUNT (using new logic: firstAssignedAt with createdAt fallback)
      const tickets = await prisma.ticket.findMany({
        where: {
          OR: [
            {
              createdAt: {
                gte: weekStart,
                lte: weekEnd,
              },
            },
            {
              firstAssignedAt: {
                gte: weekStart,
                lte: weekEnd,
              },
            },
          ],
          assignedTech: {
            isActive: true,
          },
        },
        select: {
          id: true,
          createdAt: true,
          firstAssignedAt: true,
          assignedTechId: true,
        },
      });

      const calendarCount = tickets.filter(ticket => {
        const assignDate = ticket.firstAssignedAt
          ? new Date(ticket.firstAssignedAt)
          : new Date(ticket.createdAt);
        return assignDate >= start && assignDate <= end;
      }).length;

      // SUM OF TECHNICIAN COUNTS
      let sumOfTechCounts = 0;

      for (const tech of technicians) {
        const dayTickets = tech.tickets.filter(ticket => {
          const assignDate = ticket.firstAssignedAt
            ? new Date(ticket.firstAssignedAt)
            : new Date(ticket.createdAt);
          return assignDate >= start && assignDate <= end;
        });
        sumOfTechCounts += dayTickets.length;
      }

      const match = calendarCount === sumOfTechCounts ? '✓' : '✗ MISMATCH';
      const dateStr = date.toISOString().split('T')[0];

      console.log(`${dayNames[i]} ${dateStr} | ${String(calendarCount).padStart(14)} | ${String(sumOfTechCounts).padStart(18)} | ${match}`);

      if (calendarCount !== sumOfTechCounts) {
        console.log(`  ⚠️  Difference: ${sumOfTechCounts - calendarCount}`);
      }
    }

    console.log('─'.repeat(80));
    console.log();

    // Show breakdown per technician for one sample day (Tuesday)
    console.log('SAMPLE: Tuesday Aug 26 Breakdown by Technician');
    console.log('─'.repeat(80));

    const tuesdayDate = new Date('2025-08-26T00:00:00Z');
    const tuesdayRange = getTodayRange(timezone, tuesdayDate);

    for (const tech of technicians) {
      const dayTickets = tech.tickets.filter(ticket => {
        const assignDate = ticket.firstAssignedAt
          ? new Date(ticket.firstAssignedAt)
          : new Date(ticket.createdAt);
        return assignDate >= tuesdayRange.start && assignDate <= tuesdayRange.end;
      });

      if (dayTickets.length > 0) {
        console.log(`  ${tech.name}: ${dayTickets.length} tickets`);
      }
    }

    console.log();
    console.log('═'.repeat(80));

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

verifyWeekCounts();
