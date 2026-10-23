/**
 * QA 10-22 #2: copy FreshService tags onto the Ticket Pulse tags of a
 * workspace's existing FreshService-born tickets (new and updated tickets get
 * them from the sync; see services/fsTagSyncService.js).
 *
 *   node scripts/fs-tag-backfill.mjs --ws 4            # dry run: counts only
 *   node scripts/fs-tag-backfill.mjs --ws 4 --apply    # write the links
 *   options: --days 365 (tickets created in the last N days, default all)
 *            --limit 2000
 *
 * One FreshService detail read per ticket with include=tags (tags come back
 * only when asked for), at low priority, about three a second. The workspace must be in
 * FS_TAG_SYNC_WORKSPACE_IDS (default 4).
 */
import prisma from '../src/services/prisma.js';
import settingsRepository from '../src/services/settingsRepository.js';
import { createFreshServiceClient } from '../src/integrations/freshservice.js';
import { cleanFsTags, isFsTagSyncWorkspace, reconcileFsTags } from '../src/services/fsTagSyncService.js';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : fallback;
};
const ws = Number(arg('ws'));
const apply = arg('apply', false) === true;
const days = arg('days') ? Number(arg('days')) : null;
const limit = Math.min(Number(arg('limit', 2000)) || 2000, 5000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!Number.isInteger(ws) || ws <= 0) { console.error('--ws <id> is required'); process.exit(1); }
if (!isFsTagSyncWorkspace(ws)) { console.error(`ws${ws} is not in FS_TAG_SYNC_WORKSPACE_IDS`); process.exit(1); }

const cfg = await settingsRepository.getFreshServiceConfigForWorkspace(ws);
if (!cfg?.domain || !cfg?.apiKey) { console.error(`ws${ws}: no FreshService config`); process.exit(1); }
const client = createFreshServiceClient(cfg.domain, cfg.apiKey, { priority: 'low', source: 'fs-tag-backfill' });

const tickets = await prisma.ticket.findMany({
  where: {
    workspaceId: ws,
    origin: 'freshservice',
    freshserviceTicketId: { not: null },
    status: { notIn: ['Deleted', 'Spam'] },
    ...(days ? { createdAt: { gte: new Date(Date.now() - days * 86400e3) } } : {}),
  },
  select: { id: true, workspaceId: true, origin: true, freshserviceTicketId: true },
  orderBy: { id: 'desc' },
  take: limit,
});
console.log(`ws${ws}: ${tickets.length} FreshService tickets, ${apply ? 'APPLY' : 'dry run'}`);

const totals = { read: 0, withTags: 0, added: 0, removed: 0, created: 0, failed: 0 };
const names = new Map();
for (const t of tickets) {
  try {
    const fs = await client.fetchTicketSnapshot(String(t.freshserviceTicketId), { include: 'tags' });
    totals.read += 1;
    const tags = cleanFsTags(fs?.tags);
    if (tags.length) totals.withTags += 1;
    for (const n of tags) names.set(n, (names.get(n) || 0) + 1);
    if (apply) {
      const r = await reconcileFsTags(t, Array.isArray(fs?.tags) ? fs.tags : []);
      if (r) { totals.added += r.added; totals.removed += r.removed; totals.created += r.created; }
    }
  } catch (err) {
    totals.failed += 1;
    console.warn(`ticket ${t.id}: ${err.message}`);
  }
  await sleep(350);
}
console.log(JSON.stringify(totals));
console.log(`distinct tags: ${names.size}`);
console.log([...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([n, c]) => `  ${c}\t${n}`).join('\n'));
await prisma.$disconnect();
