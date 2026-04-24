/**
 * Probe: for today's daily-review cohort, report how many tickets have
 * descriptionText / requester.department / requester.jobTitle populated
 * in our DB. If the answer is "most of them" then the data is there and
 * the LLM just isn't being given it.
 */
import { formatInTimeZone } from 'date-fns-tz';
import prisma from '../src/services/prisma.js';

async function probe(workspaceId) {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, defaultTimezone: true },
  });
  if (!ws) return;
  const tz = ws.defaultTimezone || 'America/Los_Angeles';
  const today = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');
  const startIso = formatInTimeZone(
    new Date(`${today}T12:00:00.000Z`), tz,
    'yyyy-MM-dd\'T\'00:00:00XXX',
  );
  const start = new Date(startIso);

  const tickets = await prisma.ticket.findMany({
    where: { workspaceId, createdAt: { gte: start } },
    select: {
      id: true,
      freshserviceTicketId: true,
      subject: true,
      description: true,
      descriptionText: true,
      requesterId: true,
      requester: {
        select: { name: true, email: true, department: true, jobTitle: true, timeZone: true },
      },
      assignedTech: {
        select: { name: true, location: true, timezone: true },
      },
    },
  });

  const total = tickets.length;
  if (total === 0) {
    console.log(`ws=${workspaceId} (${ws.name}): no tickets created today`);
    return;
  }
  const has = (pred) => tickets.filter(pred).length;
  const pct = (n) => `${n}/${total} (${Math.round((n / total) * 100)}%)`;

  console.log(`\nws=${workspaceId} (${ws.name}): ${total} ticket(s) created today`);
  console.log(`  description present:        ${pct(has((t) => !!t.description))}`);
  console.log(`  descriptionText present:    ${pct(has((t) => !!t.descriptionText))}`);
  console.log(`  requester linked:           ${pct(has((t) => !!t.requester))}`);
  console.log(`  requester.department:       ${pct(has((t) => !!t.requester?.department))}`);
  console.log(`  requester.jobTitle:         ${pct(has((t) => !!t.requester?.jobTitle))}`);
  console.log(`  requester.timeZone:         ${pct(has((t) => !!t.requester?.timeZone))}`);
  console.log(`  assignedTech.location:      ${pct(has((t) => !!t.assignedTech?.location))}`);
  console.log(`  assignedTech.timezone:      ${pct(has((t) => !!t.assignedTech?.timezone))}`);

  // Show a sample so we can see what the LLM IS missing
  const sample = tickets.find((t) => t.descriptionText && t.requester);
  if (sample) {
    const desc = sample.descriptionText.replace(/\s+/g, ' ').slice(0, 240);
    console.log(`  sample #${sample.freshserviceTicketId}: "${sample.subject}"`);
    console.log(`    requester: ${sample.requester.name} (${sample.requester.jobTitle || '?'} / ${sample.requester.department || '?'})`);
    console.log(`    desc: ${desc}${sample.descriptionText.length > 240 ? '...' : ''}`);
  }
}

async function main() {
  const ws = await prisma.workspace.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  for (const w of ws) await probe(w.id);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
