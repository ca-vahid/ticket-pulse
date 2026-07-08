// Replay a pipeline run's FreshService write-back through the real action
// service (same path the orphan-sync recovery uses, with all its guards —
// including the "already assigned meanwhile" check). For runs whose sync
// failed transiently and where waiting for the in-app sweeper isn't an option.
//
//   DATABASE_URL=<prod> node --env-file=.env scripts/replay-sync-run.mjs <runId>
import prisma from '../src/services/prisma.js';
import freshServiceActionService from '../src/services/freshServiceActionService.js';

const runId = Number(process.argv[2]);
if (!runId) { console.error('usage: replay-sync-run.mjs <runId>'); process.exit(1); }

const run = await prisma.assignmentPipelineRun.findUnique({
  where: { id: runId },
  select: { id: true, workspaceId: true, decision: true, syncStatus: true, syncError: true },
});
if (!run) { console.error('run not found'); process.exit(1); }
console.log('before:', JSON.stringify(run));

await freshServiceActionService.execute(runId, run.workspaceId, false);

const after = await prisma.assignmentPipelineRun.findUnique({
  where: { id: runId },
  select: { syncStatus: true, syncError: true, syncedAt: true },
});
console.log('after:', JSON.stringify(after, (k, v) => (v instanceof Date ? v.toISOString() : v)));
await prisma.$disconnect();
