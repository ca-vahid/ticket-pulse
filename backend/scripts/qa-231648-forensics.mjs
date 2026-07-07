// Read-only forensics: why did resolving 231648 show "network error" twice
// yet succeed, and why did the requester get TWO resolved emails?
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient({ datasources: { db: { url: process.env.PURL } } });

const ticket = await prisma.ticket.findFirst({
  where: { freshserviceTicketId: BigInt(231648) },
  select: { id: true, workspaceId: true, origin: true, status: true, resolvedAt: true, closedAt: true, freshserviceUpdatedAt: true, subject: true },
});
console.log('=== TICKET ===', { ...ticket, freshserviceTicketId: '231648' });
if (!ticket) process.exit(0);

const activities = await prisma.ticketActivity.findMany({
  where: { ticketId: ticket.id, activityType: { contains: 'status' } },
  orderBy: { performedAt: 'desc' }, take: 8,
  select: { activityType: true, performedBy: true, performedAt: true, details: true },
}).catch(() => []);
console.log('=== STATUS ACTIVITIES ===');
for (const a of activities) console.log(a.performedAt?.toISOString(), a.activityType, a.performedBy, JSON.stringify(a.details)?.slice(0, 140));

const runs = await prisma.notificationWorkflowRun.findMany({
  where: { ticketId: ticket.id },
  orderBy: { startedAt: 'desc' }, take: 10,
  select: { id: true, eventType: true, status: true, startedAt: true, dedupeKey: true, triggerSource: true },
});
console.log('=== WORKFLOW RUNS ===');
for (const r of runs) console.log(r.startedAt.toISOString(), r.eventType, r.status, r.triggerSource, '| key:', r.dedupeKey.slice(-70));

const deliveries = await prisma.notificationDelivery.findMany({
  where: { ticketId: ticket.id },
  orderBy: { createdAt: 'desc' }, take: 10,
  select: { id: true, status: true, createdAt: true, notificationType: true, toRecipients: true, dedupeKey: true },
}).catch(() => []);
console.log('=== DELIVERIES ===');
for (const d of deliveries) console.log(d.createdAt?.toISOString(), d.notificationType, d.status, JSON.stringify(d.toRecipients)?.slice(0, 60), '| key:', d.dedupeKey?.slice(-70));
await prisma.$disconnect();
