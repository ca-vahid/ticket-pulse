-- Contacts (QA 11-26 item 2): a workspace's own list of people outside the
-- directory that its admins want to pick as requesters or recipients.
-- New table only; nothing existing changes (requesters is untouched, so the
-- app keeps working if this runs after the deploy). Safe to run twice.
--   * a link workspace -> requester: requester rows stay global and are never
--     deleted; removing a contact deletes the link row only;
--   * created_requester: this link's Contacts form minted the requester row.
--     When the last link goes and the person has no tickets, the row is hidden
--     from pickers (requesters.suppressed_at, reason 'contact_removed').

CREATE TABLE IF NOT EXISTS "workspace_contacts" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "requester_id" INTEGER NOT NULL,
  "note" VARCHAR(255),
  "added_by_email" VARCHAR(255),
  "created_requester" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspace_contacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspace_contacts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workspace_contacts_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "requesters"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_contacts_workspace_id_requester_id_key" ON "workspace_contacts" ("workspace_id", "requester_id");
CREATE INDEX IF NOT EXISTS "workspace_contacts_workspace_id_idx" ON "workspace_contacts" ("workspace_id");
CREATE INDEX IF NOT EXISTS "workspace_contacts_requester_id_idx" ON "workspace_contacts" ("requester_id");
