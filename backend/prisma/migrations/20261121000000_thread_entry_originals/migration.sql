-- Inline answers (21 Nov 2026): the original e-mail behind an inbound reply,
-- kept out of ticket_thread_entries.raw_payload so thread reads never load it.
-- Additive only. A new, empty table: no lock on the live thread table beyond
-- the FK check (CREATE TABLE ... REFERENCES takes a SHARE ROW EXCLUSIVE lock
-- on ticket_thread_entries for the moment of creation only).

CREATE TABLE IF NOT EXISTS "ticket_thread_entry_originals" (
    "entry_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "html" TEXT,
    "text" TEXT,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_thread_entry_originals_pkey" PRIMARY KEY ("entry_id"),
    CONSTRAINT "ticket_thread_entry_originals_entry_id_fkey" FOREIGN KEY ("entry_id")
        REFERENCES "ticket_thread_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ticket_thread_entry_originals_workspace_id_idx"
    ON "ticket_thread_entry_originals"("workspace_id");
