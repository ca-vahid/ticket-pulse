-- Native ticketing foundations (dual-origin model).
-- Existing rows: origin backfills to 'freshservice' via the column default (metadata-only in PG11+).
-- freshservice ids become nullable so tickets/requesters can be born in Ticket Pulse;
-- unique indexes tolerate NULLs, so FS-sourced uniqueness is unchanged.

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "native_ticketing_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "requesters" ALTER COLUMN "freshservice_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "mirror_error" TEXT,
ADD COLUMN     "mirror_state" VARCHAR(20),
ADD COLUMN     "mirrored_at" TIMESTAMP(3),
ADD COLUMN     "native_number" INTEGER,
ADD COLUMN     "origin" VARCHAR(20) NOT NULL DEFAULT 'freshservice',
ALTER COLUMN "freshservice_ticket_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ticket_thread_entries" ADD COLUMN     "author_type" VARCHAR(20),
ADD COLUMN     "mirror_state" VARCHAR(20),
ADD COLUMN     "mirrored_at" TIMESTAMP(3),
ALTER COLUMN "external_entry_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "groups" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "freshservice_id" BIGINT,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "groups_workspace_id_is_active_idx" ON "groups"("workspace_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "groups_workspace_id_freshservice_id_key" ON "groups"("workspace_id", "freshservice_id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_native_number_key" ON "tickets"("native_number");

-- CreateIndex
CREATE INDEX "tickets_workspace_id_origin_idx" ON "tickets"("workspace_id", "origin");

-- CreateIndex
CREATE INDEX "tickets_mirror_state_idx" ON "tickets"("mirror_state");

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Native ticket numbering: TP-born tickets draw "TP-<n>" display numbers from this
-- sequence (starts at 1000 so early numbers don't look like test data).
CREATE SEQUENCE IF NOT EXISTS "ticket_native_number_seq" START WITH 1000;
