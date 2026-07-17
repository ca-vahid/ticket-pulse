-- QA 07-16 #3: per-ticket tasks (dual-origin, mirrored to FreshService).
CREATE TABLE "ticket_tasks" (
  "id"               SERIAL PRIMARY KEY,
  "workspace_id"     INTEGER NOT NULL,
  "ticket_id"        INTEGER NOT NULL,
  "title"            VARCHAR(500) NOT NULL,
  "description"      TEXT,
  "status"           VARCHAR(20) NOT NULL DEFAULT 'open',
  "assigned_tech_id" INTEGER,
  "due_at"           TIMESTAMP(3),
  "notify_agent"     BOOLEAN NOT NULL DEFAULT true,
  "notified_at"      TIMESTAMP(3),
  "origin"           VARCHAR(20) NOT NULL DEFAULT 'ticketpulse',
  "fs_task_id"       BIGINT,
  "sort_order"       INTEGER NOT NULL DEFAULT 0,
  "created_by"       VARCHAR(255),
  "created_by_name"  VARCHAR(255),
  "completed_at"     TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ticket_tasks_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ticket_tasks_assigned_tech_id_fkey" FOREIGN KEY ("assigned_tech_id") REFERENCES "technicians"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ticket_tasks_workspace_id_fs_task_id_key" ON "ticket_tasks"("workspace_id", "fs_task_id");
CREATE INDEX "ticket_tasks_workspace_id_ticket_id_idx" ON "ticket_tasks"("workspace_id", "ticket_id");
CREATE INDEX "ticket_tasks_assigned_tech_id_status_idx" ON "ticket_tasks"("assigned_tech_id", "status");
