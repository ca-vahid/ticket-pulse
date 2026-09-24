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
console.error('daily-brief-probe: db host =', url.replace(/\/\/[^@]*@/, '//***@').split('?')[0]);
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
    SELECT count(*) FILTER (WHERE assigned_tech_id IS NULL AND parked_until IS NULL)::int AS unassigned_open,
      count(*) FILTER (WHERE updated_at < now() - interval '3 days' AND parked_until IS NULL)::int AS stale3d
      , count(*) FILTER (WHERE parked_until IS NOT NULL)::int AS parked
    FROM tickets WHERE workspace_id=$1 AND status IN ('Open','Pending') AND COALESCE(is_noise,false)=false`, ws.id))[0];
  // Parked tickets (Sep 2026) wait on purpose: counted apart, never stale or unassigned work.
  w.assigners = await prisma.$queryRawUnsafe(`
    SELECT COALESCE(tech.name,'(unassigned)') AS who, count(*)::int AS n
    FROM tickets t LEFT JOIN technicians tech ON tech.id=t.assigned_tech_id
    WHERE t.workspace_id=$1 AND t.created_at >= ${W} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, ws.id);
  w.notable = await prisma.$queryRawUnsafe(`
    SELECT t.freshservice_ticket_id AS fs, t.subject, t.priority, t.status
    FROM tickets t WHERE t.workspace_id=$1 AND t.created_at >= ${W} AND t.priority >= 3
    ORDER BY t.priority DESC, t.created_at DESC LIMIT 8`, ws.id);
  // ---- IT (ws1) per-agent review: tickets Vahid may need to raise with each
  // person at standup (Tue/Thu). Three lanes, each with the evidence needed to
  // judge "valid note" at brief time (last agent-content entry + snippet):
  //  A. urgent_no_action  — P3/P4 Open with NO agent-content entry ever
  //  B. overdue           — Open past dueBy; lastAgentAt/lastNote show whether
  //                         anything was said after it went overdue
  //  C. stale_pending     — Pending with no agent-content entry in 5+ days
  //                         (pendingSince approximated by last status_event)
  // Agent-content = reply|public_reply|note|private_note|forward (activity/
  // status/group/assignment events are machine noise, not "actions").
  if (ws.id === 1) {
    w.agentReview = await safe('agentReview', () => prisma.$queryRawUnsafe(`
      WITH content AS (
        SELECT e.ticket_id, max(e.occurred_at) AS last_agent_at
        FROM ticket_thread_entries e
        WHERE e.event_type IN ('reply','public_reply','note','private_note','forward')
          AND e.event_type <> 'customer_reply'
        GROUP BY e.ticket_id
      ), lastnote AS (
        SELECT DISTINCT ON (e.ticket_id) e.ticket_id, e.occurred_at,
          left(regexp_replace(COALESCE(e.body_text,''), '\s+', ' ', 'g'), 140) AS snippet
        FROM ticket_thread_entries e
        WHERE e.event_type IN ('note','private_note','reply','public_reply')
        ORDER BY e.ticket_id, e.occurred_at DESC
      ), lastst AS (
        SELECT e.ticket_id, max(e.occurred_at) AS last_status_at
        FROM ticket_thread_entries e WHERE e.event_type = 'status_event' GROUP BY e.ticket_id
      )
      SELECT tech.name AS agent, t.freshservice_ticket_id AS fs, t.id AS tp_id, t.origin,
        left(t.subject, 90) AS subject, t.status, t.priority, t.due_by AS due,
        t.created_at::date AS created, c.last_agent_at, ls.last_status_at,
        ln.snippet AS last_note, ln.occurred_at AS last_note_at,
        CASE
          WHEN t.priority >= 3 AND t.status NOT IN ('Resolved','Closed') AND c.last_agent_at IS NULL THEN 'urgent_no_action'
          WHEN t.due_by IS NOT NULL AND t.due_by < now() AND t.status = 'Open' THEN 'overdue'
          ELSE 'stale_pending' END AS lane
      FROM tickets t
      JOIN technicians tech ON tech.id = t.assigned_tech_id
      LEFT JOIN content c ON c.ticket_id = t.id
      LEFT JOIN lastnote ln ON ln.ticket_id = t.id
      LEFT JOIN lastst ls ON ls.ticket_id = t.id
      WHERE t.workspace_id = 1 AND COALESCE(t.is_noise, false) = false
        AND t.parked_until IS NULL  -- parked tickets wait on purpose (v3.9.78)
        AND (
          (t.priority >= 3 AND t.status NOT IN ('Resolved','Closed') AND c.last_agent_at IS NULL)
          OR (t.due_by IS NOT NULL AND t.due_by < now() AND t.status = 'Open')
          OR (t.status = 'Pending'
              AND COALESCE(c.last_agent_at, t.created_at) < now() - interval '5 days')
        )
      ORDER BY tech.name, t.priority DESC, t.due_by NULLS LAST, t.created_at`)
      .then((rows) => {
        const ranked = { urgent_no_action: 0, overdue: 1, stale_pending: 2 };
        const byAgent = new Map();
        for (const r of rows) {
          if (!byAgent.has(r.agent)) byAgent.set(r.agent, []);
          byAgent.get(r.agent).push(r);
        }
        const capped = [];
        for (const [, list] of byAgent) {
          list.sort((a, b) => (ranked[a.lane] - ranked[b.lane])
            || (new Date(b.created) - new Date(a.created)));
          const kept = list.slice(0, 6);
          if (list.length > 6) kept.push({ agent: list[0].agent, lane: 'truncated', more: list.length - 6 });
          capped.push(...kept);
        }
        return capped;
      }));
    // Per-agent workload for the IT memo's "overdue inside the bar" table and
    // the weekly overview. new/resolved use a FIXED 7-day window regardless of
    // the probe's --hours (a 24 h daily would otherwise read "this week" as one
    // day). tech_id feeds the Tickets deep links (?assignee=<id>&status=…).
    const W7 = `now() - interval '7 days'`;
    w.agentStats = await safe('agentStats', () => prisma.$queryRawUnsafe(`
      SELECT tech.name AS agent, tech.id AS tech_id, tech.is_active AS active,
        count(*) FILTER (WHERE t.created_at >= ${W7})::int AS assigned_new,
        count(*) FILTER (WHERE t.resolved_at >= ${W7})::int AS resolved,
        count(*) FILTER (WHERE t.status IN ('Open','Pending'))::int AS open_now,
        count(*) FILTER (WHERE t.status = 'Open' AND t.due_by IS NOT NULL AND t.due_by < now())::int AS overdue_now,
        count(*) FILTER (WHERE t.status = 'Pending' AND t.parked_until IS NULL)::int AS pending_now,
        count(*) FILTER (WHERE t.parked_until IS NOT NULL AND t.status IN ('Open','Pending'))::int AS parked_now,
        COALESCE(max(EXTRACT(day FROM now() - t.created_at)) FILTER (WHERE t.status IN ('Open','Pending')), 0)::int AS oldest_open_days
      FROM tickets t JOIN technicians tech ON tech.id = t.assigned_tech_id
      WHERE t.workspace_id = 1 AND COALESCE(t.is_noise, false) = false
        AND (t.created_at >= ${W7} OR t.resolved_at >= ${W7} OR t.status IN ('Open','Pending'))
      GROUP BY tech.id, tech.name, tech.is_active HAVING count(*) FILTER (WHERE t.status IN ('Open','Pending')) > 0
        OR count(*) FILTER (WHERE t.resolved_at >= ${W7}) > 0
      ORDER BY tech.name LIMIT 30`));
  }
  out.workspaces.push(w);
}
writeFileSync(path.join(DIR, 'daily-data.json'), JSON.stringify(out, (k, v) => typeof v === 'bigint' ? Number(v) : v, 1));
console.log(JSON.stringify(out, (k, v) => typeof v === 'bigint' ? Number(v) : v));
await prisma.$disconnect();
