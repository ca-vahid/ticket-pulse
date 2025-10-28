/**
 * Debug date calculations in weekly-stats endpoint
 */

import { getTodayRange } from './src/utils/timezone.js';

function debugDateCalculation() {
  console.log('═'.repeat(80));
  console.log('DEBUG: Date Calculation for weekly-stats endpoint');
  console.log('═'.repeat(80));
  console.log();

  const timezone = 'America/Los_Angeles';
  const dateParam = '2025-08-25';

  // How the endpoint calculates Monday
  const [year, month, day] = dateParam.split('-').map(Number);
  const selectedDate = new Date(year, month - 1, day, 12, 0, 0);
  const currentDay = (selectedDate.getDay() + 6) % 7; // Convert to Monday=0
  const monday = new Date(selectedDate);
  monday.setDate(selectedDate.getDate() - currentDay);

  console.log('INPUT: dateParam = 2025-08-25');
  console.log(`selectedDate = new Date(${year}, ${month-1}, ${day}, 12, 0, 0)`);
  console.log(`  → ${selectedDate.toString()}`);
  console.log(`  → ISO: ${selectedDate.toISOString()}`);
  console.log(`  → Day of week: ${selectedDate.getDay()} (0=Sun, 1=Mon, ...)`);
  console.log(`  → currentDay (Mon=0): ${currentDay}`);
  console.log();

  console.log(`monday = ${monday.toString()}`);
  console.log(`  → ISO: ${monday.toISOString()}`);
  console.log();

  console.log('DAY-BY-DAY CALCULATION:');
  console.log('─'.repeat(80));

  for (let i = 0; i < 7; i++) {
    const date = new Date(monday);
    date.setDate(monday.getDate() + i);

    const result = getTodayRange(timezone, date);

    console.log(`Day ${i}: date = ${date.toString()}`);
    console.log(`       → ISO: ${date.toISOString()}`);
    console.log(`       → ISO date part: ${date.toISOString().split('T')[0]}`);
    console.log(`       → getTodayRange(PST, date):`);
    console.log(`           start: ${result.start.toISOString()}`);
    console.log(`           end:   ${result.end.toISOString()}`);
    console.log();
  }

  console.log('═'.repeat(80));
  console.log();

  console.log('VERIFICATION: How verification script creates dates');
  console.log('─'.repeat(80));

  for (let i = 0; i < 7; i++) {
    const date = new Date('2025-08-25T00:00:00Z');
    date.setDate(date.getDate() + i);

    const result = getTodayRange(timezone, date);

    console.log(`Day ${i}: date = ${date.toString()}`);
    console.log(`       → ISO: ${date.toISOString()}`);
    console.log(`       → ISO date part: ${date.toISOString().split('T')[0]}`);
    console.log(`       → getTodayRange(PST, date):`);
    console.log(`           start: ${result.start.toISOString()}`);
    console.log(`           end:   ${result.end.toISOString()}`);
    console.log();
  }

  console.log('═'.repeat(80));
}

debugDateCalculation();
