/**
 * Final verification: Compare calendar API vs sum of technician breakdowns
 */

import fetch from 'node-fetch';
import fs from 'fs';

// Load cookies
const cookies = fs.readFileSync('/tmp/cookies.txt', 'utf8');
const cookieHeader = cookies.trim();

async function finalVerification() {
  try {
    console.log('═'.repeat(80));
    console.log('FINAL VERIFICATION: Calendar vs Technician Breakdown');
    console.log('Week: Aug 25-31, 2025');
    console.log('═'.repeat(80));
    console.log();

    // 1. Fetch calendar daily counts from /weekly-stats
    console.log('[1/3] Fetching calendar daily counts from /weekly-stats endpoint...');
    const statsResponse = await fetch(
      'http://localhost:3000/api/dashboard/weekly-stats?date=2025-08-25&timezone=America/Los_Angeles',
      {
        headers: {
          'Cookie': cookieHeader,
        },
      }
    );
    const statsData = await statsResponse.json();
    const calendarCounts = statsData.data.dailyCounts;

    console.log('Calendar daily counts:');
    calendarCounts.forEach(day => {
      const dayName = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][day.dayOfWeek];
      console.log(`  ${dayName} ${day.date}: ${day.count}`);
    });
    console.log();

    // 2. Fetch weekly dashboard data
    console.log('[2/3] Fetching weekly dashboard from /weekly endpoint...');
    const weeklyResponse = await fetch(
      'http://localhost:3000/api/dashboard/weekly?weekStart=2025-08-25&timezone=America/Los_Angeles',
      {
        headers: {
          'Cookie': cookieHeader,
        },
      }
    );
    const weeklyData = await weeklyResponse.json();
    const technicians = weeklyData.data.technicians;

    console.log(`Loaded ${technicians.length} technicians`);
    console.log();

    // 3. Sum up each day's counts across all technicians
    console.log('[3/3] Summing technician daily breakdowns...');
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const technicianSums = Array(7).fill(0);

    for (const tech of technicians) {
      if (tech.dailyBreakdown) {
        tech.dailyBreakdown.forEach((day, index) => {
          technicianSums[index] += day.total;
        });
      }
    }

    console.log('Sum of technician daily breakdowns:');
    technicianSums.forEach((count, index) => {
      console.log(`  ${dayNames[index]} 2025-08-${25+index}: ${count}`);
    });
    console.log();

    // 4. Compare
    console.log('COMPARISON:');
    console.log('─'.repeat(80));
    console.log('Day         | Calendar API | Technician Sum | Match?');
    console.log('─'.repeat(80));

    let allMatch = true;
    for (let i = 0; i < 7; i++) {
      const calendarCount = calendarCounts[i].count;
      const techSum = technicianSums[i];
      const match = calendarCount === techSum ? '✓' : '✗ MISMATCH';

      if (calendarCount !== techSum) {
        allMatch = false;
      }

      console.log(`${dayNames[i]} 2025-08-${25+i} | ${String(calendarCount).padStart(12)} | ${String(techSum).padStart(14)} | ${match}`);

      if (calendarCount !== techSum) {
        console.log(`  ⚠️  Difference: ${techSum - calendarCount}`);
      }
    }

    console.log('─'.repeat(80));
    console.log();

    if (allMatch) {
      console.log('✅ SUCCESS: All counts match! Calendar totals equal sum of technician counts.');
    } else {
      console.log('❌ FAILURE: Counts do not match. Investigation needed.');
    }

    console.log();
    console.log('═'.repeat(80));

  } catch (error) {
    console.error('Error:', error);
  }
}

finalVerification();
