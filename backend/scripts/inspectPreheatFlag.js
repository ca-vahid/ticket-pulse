/**
 * Confirm every workspace has an AssignmentConfig row with the new
 * preheat flag, and report its current value. Should be `false` for all
 * after the migration since DEFAULT false applies to existing rows too.
 */
import prisma from '../src/services/prisma.js';

async function main() {
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, name: true },
    orderBy: { id: 'asc' },
  });

  for (const ws of workspaces) {
    const cfg = await prisma.assignmentConfig.findUnique({
      where: { workspaceId: ws.id },
      select: {
        dailyReviewEnabled: true,
        dailyReviewPreheatEnabled: true,
        dailyReviewRunHour: true,
        dailyReviewRunMinute: true,
      },
    });
    if (!cfg) {
      console.log(`ws=${ws.id} (${ws.name}): no AssignmentConfig row`);
      continue;
    }
    console.log(
      `ws=${ws.id} (${ws.name}): preheat=${cfg.dailyReviewPreheatEnabled} | ` +
      `reviewEnabled=${cfg.dailyReviewEnabled} runAt=${cfg.dailyReviewRunHour}:${String(cfg.dailyReviewRunMinute).padStart(2, '0')}`,
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
