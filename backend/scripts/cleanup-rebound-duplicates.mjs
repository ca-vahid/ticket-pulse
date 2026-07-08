/**
 * Cleanup for the bounce-detection loop (#230490): the state-check trigger
 * used to materialize a duplicate 'rebound_exhausted' review row per sync
 * pass, with an inflated narrative ("rejected by N successive auto-assigned
 * technicians" after ONE self-picked return).
 *
 * For each ticket with completed+pending_review rebound_exhausted runs:
 *  1. keep the NEWEST row, mark older duplicates superseded
 *  2. rewrite the kept row's message/reasoning/reboundCount from the actual
 *     assignment episodes (who returned it, self-picked or assigned, when,
 *     how many distinct returns)
 *
 * Touches ONLY synthesized rebound_exhausted rows that are still undecided.
 * Run from backend/:  node scripts/cleanup-rebound-duplicates.mjs        (dev)
 *                     PROD=1 node scripts/cleanup-rebound-duplicates.mjs (prod)
 */
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_AUTO_REBOUNDS = 3;

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const dbUrl = process.env.PROD
  ? loadEnv(path.resolve(__dirname, '.env.prod')).PROD_DATABASE_URL
  : loadEnv(path.resolve(__dirname, '../.env')).DATABASE_URL;
if (!dbUrl) { console.error('No database URL'); process.exit(1); }
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

const undecided = await prisma.assignmentPipelineRun.findMany({
  where: { triggerSource: 'rebound_exhausted', status: 'completed', decision: 'pending_review' },
  orderBy: { id: 'desc' },
  select: { id: true, ticketId: true, workspaceId: true, reboundFrom: true },
});

const byTicket = new Map();
for (const run of undecided) {
  if (!byTicket.has(run.ticketId)) byTicket.set(run.ticketId, []);
  byTicket.get(run.ticketId).push(run); // desc order — first is newest
}

let supersededTotal = 0;
let rewritten = 0;

for (const [ticketId, runs] of byTicket) {
  const [keep, ...dupes] = runs;

  if (dupes.length > 0) {
    const res = await prisma.assignmentPipelineRun.updateMany({
      where: { id: { in: dupes.map((d) => d.id) } },
      data: {
        status: 'superseded',
        errorMessage: 'Superseded duplicate — this bounce was re-detected by a sync loop (fixed); the remaining review row carries the accurate history',
        updatedAt: new Date(),
      },
    });
    supersededTotal += res.count;
  }

  // Rebuild the kept row's story from the actual episodes.
  const rejectionCount = Math.max(1, await prisma.ticketAssignmentEpisode.count({
    where: { ticketId, endMethod: 'rejected' },
  }));
  const lastRejected = await prisma.ticketAssignmentEpisode.findFirst({
    where: { ticketId, endMethod: 'rejected' },
    orderBy: { endedAt: 'desc' },
    select: { technicianId: true, startMethod: true, endedAt: true, endActorName: true },
  });
  const tech = lastRejected?.technicianId
    ? await prisma.technician.findUnique({ where: { id: lastRejected.technicianId }, select: { id: true, name: true } })
    : null;
  const name = tech?.name || keep.reboundFrom?.previousTechName || 'The previous assignee';
  const selfPicked = lastRejected?.startMethod === 'self_picked';
  const when = lastRejected?.endedAt ? new Date(lastRejected.endedAt).toISOString() : keep.reboundFrom?.unassignedAt || null;
  const returnedPhrase = `${name} ${selfPicked
    ? 'picked this ticket up themselves and later returned it to the queue'
    : 'was assigned this ticket and returned it to the queue'}${when ? ` on ${when.slice(0, 10)}` : ''}`;
  const times = `${rejectionCount} time${rejectionCount === 1 ? '' : 's'}`;

  await prisma.assignmentPipelineRun.update({
    where: { id: keep.id },
    data: {
      errorMessage: rejectionCount > MAX_AUTO_REBOUNDS
        ? `Returned to the queue ${times} — automatic re-routing stopped; assign manually`
        : `Returned to the queue ${times} — awaiting manual assignment`,
      reboundFrom: {
        ...(keep.reboundFrom || {}),
        previousTechId: tech?.id ?? keep.reboundFrom?.previousTechId ?? null,
        previousTechName: name,
        unassignedAt: when,
        unassignedByName: lastRejected?.endActorName || keep.reboundFrom?.unassignedByName || null,
        reboundCount: rejectionCount,
      },
      recommendation: {
        recommendations: [],
        overallReasoning: `${returnedPhrase}. This ticket has been returned to the queue ${times}${rejectionCount > MAX_AUTO_REBOUNDS
          ? ` — past the automatic re-routing limit of ${MAX_AUTO_REBOUNDS} — so no further automatic assignment will happen`
          : ' and automatic re-routing did not result in an accepted assignment'}. Assign it manually or dismiss.`,
        ticketClassification: 'needs_manual_review',
        confidence: 'low',
      },
      updatedAt: new Date(),
    },
  });
  rewritten += 1;
  console.log(`ticket ${ticketId}: kept run ${keep.id} (rewritten, ${times}), superseded ${dupes.length} duplicate(s)`);
}

console.log(`\nDone: ${rewritten} review row(s) rewritten with accurate history, ${supersededTotal} duplicate(s) superseded.`);
await prisma.$disconnect();
