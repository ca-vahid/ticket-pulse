// DEV-ONLY read probe for the Phase TU release-B Prisma query shapes
// (MEGA 09-01, cross-cutting rule: every new query shape gets ONE live run
// before release — mocked tests hid a findFirst-include 500 last train).
// SELECT-only. Refuses to run against anything but localhost.
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const url = envText.match(/^DATABASE_URL="?([^"\n]+)"?/m)?.[1];
if (!url) throw new Error('backend/.env has no DATABASE_URL');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error('refusing: DATABASE_URL is not a localhost dev database');
process.env.DATABASE_URL = url;
const prisma = new PrismaClient({ datasources: { db: { url } } });

const results = [];
async function probe(label, fn) {
  const startedAt = Date.now();
  try {
    const value = await fn();
    results.push({ label, ok: true, ms: Date.now() - startedAt, sample: value });
  } catch (err) {
    results.push({ label, ok: false, ms: Date.now() - startedAt, error: err.message });
  }
}

const anyTicket = await prisma.ticket.findFirst({ orderBy: { id: 'desc' }, select: { id: true, workspaceId: true, groupId: true, internalCategoryId: true, internalSubcategoryId: true, freshserviceUpdatedAt: true } });
const ticketId = anyTicket?.id ?? 1;
const workspaceId = anyTicket?.workspaceId ?? 1;
const anyWorkflow = await prisma.notificationWorkflow.findFirst({ select: { id: true } });
const workflowId = anyWorkflow?.id ?? 1;

// TU-9: waiting-run lookup for coalescing (engine.fieldsUpdatedGate)
await probe('notificationWorkflowRun.findFirst waiting (coalesce)', () => prisma.notificationWorkflowRun.findFirst({
  where: { workflowId, ticketId, eventType: 'ticket.fields_updated', status: 'waiting', resumeAt: { gt: new Date() } },
  orderBy: { resumeAt: 'desc' },
  select: { id: true, eventContext: true, resumeAt: true },
}));

// TU-8: last_replying_agent
await probe('ticketThreadEntry.findFirst last agent reply', () => prisma.ticketThreadEntry.findFirst({
  where: { ticketId, authorType: 'agent', actorEmail: { not: null } },
  orderBy: { occurredAt: 'desc' },
  select: { actorEmail: true },
}));

// TU-8: watchers
const catIds = [anyTicket?.internalCategoryId, anyTicket?.internalSubcategoryId].filter(Boolean);
const scopeOr = [];
if (catIds.length) scopeOr.push({ scopeType: 'category', categoryId: { in: catIds } });
if (anyTicket?.groupId) scopeOr.push({ scopeType: 'group', groupId: BigInt(String(anyTicket.groupId)) });
await probe('ticketWatchSubscription.findMany watchers', () => prisma.ticketWatchSubscription.findMany({
  where: { workspaceId, OR: scopeOr.length ? scopeOr : [{ scopeType: 'category', categoryId: { in: [-1] } }] },
  select: { userEmail: true },
}));

// TU-10 echo guard 1: recent fs_write_back audit row
await probe('ticketActivity.findFirst fs_write_back <=10min', () => prisma.ticketActivity.findFirst({
  where: { ticketId, activityType: 'fs_write_back', performedAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } },
  orderBy: { performedAt: 'desc' },
  select: { details: true },
}));

// TU-10 actor lookup: FS activity lines around the FS updated_at
const at = anyTicket?.freshserviceUpdatedAt ? new Date(anyTicket.freshserviceUpdatedAt).getTime() : Date.now();
await probe('ticketThreadEntry.findMany fs actor window', () => prisma.ticketThreadEntry.findMany({
  where: { ticketId, source: 'freshservice_activity', occurredAt: { gte: new Date(at - 600000), lte: new Date(at + 600000) } },
  orderBy: { occurredAt: 'desc' },
  take: 5,
  select: { actorName: true, content: true },
}));

// TU-5 renderer id → name lookups (through the real module)
const { normalizeTicketChanges } = await import('../src/services/ticketChangeRenderer.js');
const cat = await prisma.competencyCategory.findFirst({ where: { workspaceId }, select: { id: true } });
const grp = await prisma.group.findFirst({ where: { workspaceId }, select: { id: true, freshserviceId: true } });
const tech = await prisma.technician.findFirst({ select: { id: true } });
const req = await prisma.requester.findFirst({ select: { id: true } });
await probe('ticketChangeRenderer.normalizeTicketChanges (ids → names)', () => normalizeTicketChanges({
  internalCategoryId: { from: null, to: cat?.id ?? null },
  internalGroupId: { from: grp?.id ?? null, to: null },
  ...(grp?.freshserviceId ? { groupId: { from: null, to: String(grp.freshserviceId) } } : {}),
  assignedTechId: { from: null, to: tech?.id ?? null },
  requesterId: { from: null, to: req?.id ?? null },
  priority: { from: 2, to: 3 },
  description: { changed: true },
}, { workspaceId }));

// TU-7 route options: workspace custom-field keys for event.changedFields
await probe('customFieldDefinition.findMany (changed-fields options)', () => prisma.customFieldDefinition.findMany({
  where: { workspaceId, isActive: true }, orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }], select: { key: true },
}));

await prisma.$disconnect();
for (const r of results) {
  const tail = r.ok ? JSON.stringify(r.sample, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 200) : `ERROR ${r.error}`;
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.ms}ms  ${r.label}  ${tail}`);
}
if (results.some((r) => !r.ok)) process.exit(1);
