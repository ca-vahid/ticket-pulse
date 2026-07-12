// One-time: SLAs are now defined per ticket type — replicate each generic
// (ticket_type_id NULL) row to every active type in its workspace, then
// delete the generic row. Behavior-preserving: the same clocks now match via
// the type-specific rows.
// Run: node --env-file=.env scripts/migrate-generic-slas-to-types.mjs [--apply]
import prisma from '../src/services/prisma.js';

const APPLY = process.argv.includes('--apply');
const generics = await prisma.slaPolicy.findMany({ where: { ticketTypeId: null } });
if (!generics.length) { console.log('no generic SLA rows — nothing to do'); process.exit(0); }

for (const row of generics) {
  const types = await prisma.ticketTypeDefinition.findMany({
    where: { workspaceId: row.workspaceId, isActive: true },
    select: { id: true, name: true },
  });
  console.log(`ws${row.workspaceId} P${row.priority} generic (fr=${row.firstResponseMinutes} res=${row.resolveMinutes}) -> ${types.map((t) => t.name).join(', ')}`);
  if (!APPLY) continue;
  for (const type of types) {
    const exists = await prisma.slaPolicy.findFirst({
      where: { workspaceId: row.workspaceId, priority: row.priority, ticketTypeId: type.id },
    });
    if (exists) { console.log(`  ${type.name}: already has a row — kept`); continue; }
    await prisma.slaPolicy.create({
      data: {
        workspaceId: row.workspaceId,
        priority: row.priority,
        ticketTypeId: type.id,
        firstResponseMinutes: row.firstResponseMinutes,
        resolveMinutes: row.resolveMinutes,
        isActive: row.isActive,
        updatedBy: 'migrate-generic-slas-to-types',
      },
    });
    console.log(`  ${type.name}: created`);
  }
  await prisma.slaPolicy.delete({ where: { id: row.id } });
  console.log('  generic row deleted');
}
console.log(APPLY ? 'done (applied)' : 'dry run — pass --apply');
process.exit(0);
