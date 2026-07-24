-- Dashboard workload query speedup (QA 07-23 #6).
-- getAllActiveScoped hydrates every Open/Pending ticket per active technician to
-- compute per-agent workload. That branch is unbounded by date, so a large
-- backlog (e.g. the Accounting workspace) forced a status-only scan across all
-- workspaces. These composite indexes let Postgres scan open/pending tickets
-- scoped to a workspace / technician directly.
-- IF NOT EXISTS keeps this safe to re-apply across dev/prod.
CREATE INDEX IF NOT EXISTS "tickets_workspace_id_status_idx" ON "tickets"("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "tickets_assigned_tech_id_status_idx" ON "tickets"("assigned_tech_id", "status");
