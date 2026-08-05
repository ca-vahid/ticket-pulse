-- Editable resolution due date (QA 08-04 #13): who last set tickets.due_by.
-- 'sla'    = the per-priority SLA policy clock stamped it at creation
-- 'manual' = an agent set/edited it in-app (future SLA recomputes must skip it)
-- NULL     = legacy rows / SLA-owned (treated like 'sla')
-- Additive; safe to re-apply.
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "due_by_set_by" VARCHAR(10);
