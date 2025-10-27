-- Add workspace_id column to technicians table
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS workspace_id BIGINT;

-- Create index on workspace_id
CREATE INDEX IF NOT EXISTS technicians_workspace_id_idx ON technicians(workspace_id);
