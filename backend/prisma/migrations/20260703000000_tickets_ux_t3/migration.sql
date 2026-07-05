-- Tickets UX Uplift Phase T3: mailbox→group routing, scheduled tickets,
-- category↔group affinity groundwork, category/group watchers, reply templates.

-- T3.1 Mailbox→group routing: email-born tickets inherit the mailbox's group/type.
ALTER TABLE "mailbox_connections" ADD COLUMN "default_group_id" BIGINT;
ALTER TABLE "mailbox_connections" ADD COLUMN "default_ticket_type" VARCHAR(30);

-- T3.4 Scheduled tickets: createTicket payload replayed verbatim at activation.
CREATE TABLE "scheduled_tickets" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "scheduled_for_at" TIMESTAMP(3) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "created_by" VARCHAR(255),
    "created_by_name" VARCHAR(255),
    "activated_at" TIMESTAMP(3),
    "ticket_id" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_tickets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "scheduled_tickets_status_scheduled_for_at_idx" ON "scheduled_tickets"("status", "scheduled_for_at");
CREATE INDEX "scheduled_tickets_workspace_id_status_idx" ON "scheduled_tickets"("workspace_id", "status");

ALTER TABLE "scheduled_tickets" ADD CONSTRAINT "scheduled_tickets_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- T3.3 Category↔group affinity groundwork (flag-gated admin UX later).
CREATE TABLE "category_group_links" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "category_id" INTEGER NOT NULL,
    "group_id" BIGINT NOT NULL,
    "created_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_group_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "category_group_links_workspace_id_category_id_group_id_key" ON "category_group_links"("workspace_id", "category_id", "group_id");
CREATE INDEX "category_group_links_workspace_id_group_id_idx" ON "category_group_links"("workspace_id", "group_id");

ALTER TABLE "category_group_links" ADD CONSTRAINT "category_group_links_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "category_group_links" ADD CONSTRAINT "category_group_links_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "competency_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- T3.6 Watchers: per-category or per-group subscriptions (never per-ticket).
CREATE TABLE "ticket_watch_subscriptions" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "user_email" VARCHAR(255) NOT NULL,
    "user_name" VARCHAR(255),
    "scope_type" VARCHAR(20) NOT NULL,
    "category_id" INTEGER,
    "group_id" BIGINT,
    "notify_created" BOOLEAN NOT NULL DEFAULT true,
    "notify_requester_reply" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_watch_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ticket_watch_subscriptions_workspace_id_user_email_scope_t_key" ON "ticket_watch_subscriptions"("workspace_id", "user_email", "scope_type", "category_id", "group_id");
CREATE INDEX "ticket_watch_subscriptions_workspace_id_scope_type_idx" ON "ticket_watch_subscriptions"("workspace_id", "scope_type");
CREATE INDEX "ticket_watch_subscriptions_user_email_idx" ON "ticket_watch_subscriptions"("user_email");

ALTER TABLE "ticket_watch_subscriptions" ADD CONSTRAINT "ticket_watch_subscriptions_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- T3.7 Reply templates (canned quick notes), optionally category-scoped.
CREATE TABLE "reply_templates" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "body_html" TEXT,
    "body_text" TEXT NOT NULL,
    "category_id" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reply_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reply_templates_workspace_id_is_active_idx" ON "reply_templates"("workspace_id", "is_active");

ALTER TABLE "reply_templates" ADD CONSTRAINT "reply_templates_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
