CREATE TABLE "notification_llm_tool_policies" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "mode" VARCHAR(30) NOT NULL DEFAULT 'context_only',
    "enabled_tools" JSONB NOT NULL DEFAULT '[]',
    "tool_settings" JSONB NOT NULL DEFAULT '{}',
    "max_turns" INTEGER NOT NULL DEFAULT 4,
    "max_tool_calls" INTEGER NOT NULL DEFAULT 6,
    "total_timeout_ms" INTEGER NOT NULL DEFAULT 20000,
    "per_tool_timeout_ms" INTEGER NOT NULL DEFAULT 3000,
    "include_private_notes" BOOLEAN NOT NULL DEFAULT false,
    "redaction_enabled" BOOLEAN NOT NULL DEFAULT true,
    "policy_version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_llm_tool_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_llm_tool_policies_workspace_id_key" ON "notification_llm_tool_policies"("workspace_id");
CREATE INDEX "notification_llm_tool_policies_workspace_id_mode_idx" ON "notification_llm_tool_policies"("workspace_id", "mode");

ALTER TABLE "notification_llm_tool_policies"
ADD CONSTRAINT "notification_llm_tool_policies_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
