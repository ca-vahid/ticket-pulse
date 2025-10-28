/**
 * Analyze date field usage in Aug 25-31 week
 * Compare createdAt vs firstAssignedAt for ticket counting
 */

import { PrismaClient } from '@prisma/client';
import { getTodayRange } from './src/utils/timezone.js';

const prisma = new PrismaClient();

async function analyzeWeek() {
  try {
    console.log('═'.repeat(70));
    console.log('DATE FIELD ANALYSIS: Aug 25-31, 2025');
    console.log('═'.repeat(70));
    console.log();

    // Calculate week range
    const weekStart = new Date('2025-08-25T00:00:00Z');
    const weekEnd = new Date('2025-08-31T23:59:59Z');

    console.log(`Week: ${weekStart.toISOString()} to ${weekEnd.toISOString()}\n`);

    // Get all tickets in the week (by createdAt OR firstAssignedAt)
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
      include: {
        assignedTech: true,
      },
    });

    console.log(`Total tickets in week range: ${tickets.length}\n`);

    // Analyze date field differences
    let sameDate = 0;
    let differentDate = 0;
    let noFirstAssigned = 0;

    const dateDifferences = [];

    for (const ticket of tickets) {
      if (!ticket.firstAssignedAt) {
        noFirstAssigned++;
      } else {
        const created = new Date(ticket.createdAt);
        const assigned = new Date(ticket.firstAssignedAt);

        const createdDay = created.toISOString().split('T')[0];
        const assignedDay = assigned.toISOString().split('T')[0];

        if (createdDay === assignedDay) {
          sameDate++;
        } else {
          differentDate++;
          dateDifferences.push({
            ticketId: ticket.freshserviceTicketId,
            createdDay,
            assignedDay,
            tech: ticket.assignedTech?.name,
            subject: ticket.subject?.substring(0, 40),
          });
        }
      }
    }

    console.log('DATE FIELD COMPARISON:');
    console.log('─'.repeat(70));
    console.log(`  Same date (createdAt = firstAssignedAt):     ${sameDate}`);
    console.log(`  Different date (createdAt ≠ firstAssignedAt): ${differentDate}`);
    console.log(`  No firstAssignedAt (NULL):                    ${noFirstAssigned}`);
    console.log('─'.repeat(70));
    console.log();

    if (differentDate > 0) {
      console.log('SAMPLE TICKETS WITH DATE DIFFERENCES:');
      console.log('(These cause calendar vs technician count discrepancies)');
      console.log();
      dateDifferences.slice(0, 10).forEach(d => {
        console.log(`  #${d.ticketId} | Created: ${d.createdDay} → Assigned: ${d.assignedDay}`);
        console.log(`    Tech: ${d.tech}`);
        console.log(`    Subject: ${d.subject}...`);
        console.log();
      });
    }

    // Count by day using EACH method
    console.log('DAY-BY-DAY COMPARISON:');
    console.log('─'.repeat(70));
    console.log('Day        | By createdAt | By firstAssignedAt | Difference');
    console.log('─'.repeat(70));

    const timezone = 'America/Los_Angeles';
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    for (let i = 0; i < 7; i++) {
      const date = new Date('2025-08-25T00:00:00Z');
      date.setDate(date.getDate() + i);

      const result = getTodayRange(timezone, date);
      const { start, end } = result;

      // Count by createdAt
      const countByCreated = tickets.filter(ticket => {
        const created = new Date(ticket.createdAt);
        return created >= start && created <= end;
      }).length;

      // Count by firstAssignedAt (with createdAt fallback)
      const countByAssigned = tickets.filter(ticket => {
        const assignDate = ticket.firstAssignedAt
          ? new Date(ticket.firstAssignedAt)
          : new Date(ticket.createdAt);
        return assignDate >= start && assignDate <= end;
      }).length;

      const diff = countByAssigned - countByCreated;
      const diffStr = diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : '0';

      console.log(`${dayNames[i]} ${date.toISOString().split('T')[0]} | ${String(countByCreated).padStart(12)} | ${String(countByAssigned).padStart(18)} | ${diffStr}`);
    }

    console.log('─'.repeat(70));
    console.log();

    console.log('RECOMMENDATION:');
    console.log('  Use firstAssignedAt (with createdAt fallback) because:');
    console.log('  - Dashboard tracks workload distribution by assignment date');
    console.log('  - A ticket created Mon but assigned Tue should count toward Tue');
    console.log('  - Matches existing technician breakdown logic');
    console.log();

    console.log('═'.repeat(70));

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

analyzeWeek();
