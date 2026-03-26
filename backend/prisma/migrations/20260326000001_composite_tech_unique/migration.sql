-- Change technician unique constraint from freshservice_id alone
-- to composite (freshservice_id, workspace_id).
-- This allows the same FreshService agent to exist in multiple workspaces
-- with separate records, separate ticket assignments, and separate settings.

-- Drop the old unique constraint
DROP INDEX IF EXISTS "technicians_freshservice_id_key";

-- Create composite unique constraint
CREATE UNIQUE INDEX "technicians_freshservice_id_workspace_id_key"
  ON "technicians"("freshservice_id", "workspace_id");
