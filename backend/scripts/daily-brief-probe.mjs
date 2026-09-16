// Daily brief data probe (read-only, prod). Usage: node daily-brief-probe.mjs [hours]
// Tracked since 15 Sep 2026 (the /arm-briefs skill depends on it). Read-only: SELECTs and one /health GET.
// Collects per-workspace ticket signals for the window + platform sanity checks.
// Writes daily-data.json next to itself and prints a digest for the analyst (Claude).
import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Output dir: BRIEF_OUT_DIR, else the current directory (the /arm-briefs skill passes the session scratchpad).
const DIR = process.env.BRIEF_OUT_DIR || process.cwd();
// Prod connection: DATABASE_URL in the environment (the skill fetches it from Azure app settings),
// else the untracked backend/scripts/.env.prod (PROD_DATABASE_URL=...). Never commit either.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL || (() => {
  try { return readFileSync(path.join(HERE, '.env.prod'), 'utf8').match(/PROD_DATABASE_URL=(.+)/)?.[1]?.trim().replace(/^"|"$/g, ''); } catch { return null; }
})();
if (!url) { console.error('daily-brief-probe: set DATABASE_URL (prod) or create backend/scripts/.env.prod with PROD_DATABASE_URL=...'); process.exit(2); }
const prisma = new PrismaClient({ datasources: { db: { url } } });
const HOURS = Number(process.argv[2]) || 24;
const W = `now() - interval '${HOURS} hours'`;
const out = { generatedAt: new Date().toISOString(), windowHours: HOURS, sanity: {}, workspaces: [] };
const safe = async (name, fn) => { try { return await fn(); } catch (e) { out.sanity[`${name}_error`] = String(e.message).split('\n')[0]; return null; } };

// ---- platform sanity ----
out.sanity.health = await safe('health', async () => (await fetch('https://ticket-pulse-app.azurewebsites.net/health')).json());
out.sanity.syncLogs = await safe('sync', () => prisma.$queryRawUnsafe(`
  SELECT workspace_id AS ws, status, count(*)::int AS n, max(started_at) AS last
  FROM sync_logs WHERE started_at >= ${W} GROUP BY 1,2 ORDER BY 1,2`));
// Queued runs waiting out business hours / holidays are BY DESIGN (they drain
// when hours resume) — only genuinely unexplained queued/running runs are stuck.
// Aug 3 (Civic Holiday) false-alarmed 136 correctly-parked runs before this split.
out.sanity.stuckRuns = await safe('stuck', () => prisma.$queryRawUnsafe(`
  SELECT r.id, r.ticket_id, r.status, r.created_at, t.workspace_id AS ws
  FROM assignment_pipeline_runs r JOIN tickets t ON t.id=r.ticket_id
  WHERE r.status IN ('queued','running') AND r.created_at < now() - interval '45 minutes'
    AND NOT (r.status='queued' AND (r.queued_reason ILIKE '%business hours%' OR r.queued_reason ILIKE '%holiday%'))
  LIMIT 10`));
out.sanity.afterHoursQueued = await safe('ahQueued', () => prisma.$queryRawUnsafe(`
  SELECT t.workspace_id AS ws, count(*)::int AS n, min(r.created_at) AS oldest
  FROM assignment_pipeline_runs r JOIN tickets t ON t.id=r.ticket_id
  WHERE r.status='queued' AND (r.queued_reason ILIKE '%business hours%' OR r.queued_reason ILIKE '%holiday%')
  GROUP BY 1 ORDER BY 2 DESC`));
out.sanity.failedRuns = await safe('failedRuns', () => prisma.$queryRawUnsafe(`
  SELECT t.workspace_id AS ws, count(*)::int AS n FROM assignment_pipeline_runs r
  JOIN tickets t ON t.id=r.ticket_id
  WHERE r.status LIKE 'failed%' AND r.created_at >= ${W} GROUP BY 1`));
out.sanity.webhookFailures = await safe('webhooks', () => prisma.$queryRawUnsafe(`
  SELECT status, count(*)::int AS n FROM webhook_deliveries
  WHERE created_at >= ${W} GROUP BY 1 ORDER BY 2 DESC LIMIT 6`));
out.sanity.observeIntegrity = await safe('observe', () => prisma.$queryRawUnsafe(`
  SELECT count(*)::int AS bad FROM assignment_pipeline_runs r JOIN tickets t ON t.id=r.ticket_id
  WHERE t.workspace_id=2 AND t.group_id IN (1000210021,1000210020)
    AND r.created_at >= ${W} AND r.decision IN ('auto_assigned','noise_dismissed')`));
out.sanity.mailboxes = await safe('mailboxes', () => prisma.$queryRawUnsafe(
  'SELECT address, is_enabled, last_error FROM mailbox_connections LIMIT 10'));

// ---- per-workspace ----
const wss = await prisma.$queryRawUnsafe("SELECT id, name FROM workspaces WHERE is_active=true ORDER BY id");
for (const ws of wss) {
  const w = { id: ws.id, name: ws.name };
  w.tot = (await prisma.$queryRawUnsafe(`
    SELECT count(*)::int AS created,
      count(*) FILTER (WHERE status IN ('Resolved','Closed'))::int AS done,
      count(*) FILTER (WHERE is_noise)::int AS noise,
      count(*) FILTER (WHERE taxonomy_review_needed)::int AS review_flagged,
      count(*) FILTER (WHERE rejection_count > 0)::int AS bounced,
      count(*) FILTER (WHERE priority >= 3)::int AS high_pri
    FROM tickets WHERE workspace_id=$1 AND created_at >= ${W}`, ws.id))[0];
  w.resolvedInWindow = (await prisma.$queryRawUnsafe(`
    SELECT count(*)::int AS n FROM tickets WHERE workspace_id=$1 AND resolved_at >= ${W}`, ws.id))[0].n;
  w.groups = await prisma.$queryRawUnsafe(`
    SELECT COALESCE(g.name,'(no group)') AS grp, count(*)::int AS n
    FROM tickets t LEFT JOIN groups g ON g.freshservice_id=t.group_id AND g.workspace_id=t.workspace_id
    WHERE t.workspace_id=$1 AND t.created_at >= ${W} GROUP BY 1 ORDER BY 2 DESC LIMIT 6`, ws.id);
  w.cats = await prisma.$queryRawUnsafe(`
    SELECT COALESCE(c.name,'(uncategorized)') AS cat, count(*)::int AS n
    FROM tickets t LEFT JOIN competency_categories c ON c.id=t.internal_category_id
    WHERE t.workspace_id=$1 AND t.created_at >= ${W} GROUP BY 1 ORDER BY 2 DESC LIMIT 6`, ws.id);
  // Bounces that HAPPENED in the window (rejected episodes), not lifetime
  // rejection counts on any ticket sync happened to touch — the old shape
  // resurfaced long-closed tickets as "bouncing" (Aug 25-27 false alarms).
  w.bounces = await prisma.$queryRawUnsafe(`
    SELECT t.freshservice_ticket_id AS fs, t.subject, count(e.id)::int AS n, tech.name AS assignee, c.name AS cat, t.status
    FROM ticket_assignment_episodes e JOIN tickets t ON t.id=e.ticket_id
    LEFT JOIN technicians tech ON tech.id=t.assigned_tech_id
    LEFT JOIN competency_categories c ON c.id=t.internal_category_id
    WHERE t.workspace_id=$1 AND e.end_method='rejected' AND e.ended_at >= ${W}
    GROUP BY t.id, t.freshservice_ticket_id, t.subject, tech.name, c.name, t.status ORDER BY 3 DESC LIMIT 6`, ws.id);
  w.backlog = (await prisma.$queryRawUnsafe(`
    SELECT count(*) FILTER (WHERE assigned_tech_id IS NULL)::int AS unassigned_open,
      count(*) FILTER (WHERE updated_at < now() - interval '3 days')::int AS stale3d
    FROM tickets WHERE workspace_id=$1 AND status IN ('Open','Pending') AND COALESCE(is_noise,false)=false`, ws.id))[0];
  w.assigners = await prisma.$queryRawUnsafe(`
    SELECT COALESCE(tech.name,'(unassigned)') AS who, count(*)::int AS n
    FROM tickets t LEFT JOIN technicians tech ON tech.id=t.assigned_tech_id
    WHERE t.workspace_id=$1 AND t.created_at >= ${W} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, ws.id);
  w.notable = await prisma.$queryRawUnsafe(`
    SELECT t.freshservice_ticket_id AS fs, t.subject, t.priority, t.status
    FROM tickets t WHERE t.workspace_id=$1 AND t.created_at >= ${W} AND t.priority >= 3
    ORDER BY t.priority DESC, t.created_at DESC LIMIT 8`, ws.id);
  out.workspaces.push(w);
}
writeFileSync(path.join(DIR, 'daily-data.json'), JSON.stringify(out, (k, v) => typeof v === 'bigint' ? Number(v) : v, 1));
console.log(JSON.stringify(out, (k, v) => typeof v === 'bigint' ? Number(v) : v));
await prisma.$disconnect();
