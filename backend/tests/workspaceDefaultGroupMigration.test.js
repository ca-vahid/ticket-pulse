// QA 08-06 — migration/model sync guard for the two Phase-1 migrations:
// the Prisma models and the SQL migrations must describe the same columns,
// and the SQL must stay idempotent (safe to re-run / pre-created dev DBs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(root, '../prisma/schema.prisma'), 'utf8');

function migrationSql(folder) {
  return fs.readFileSync(path.join(root, '../prisma/migrations', folder, 'migration.sql'), 'utf8');
}

describe('workspace default group migration (20260807000000)', () => {
  const sql = migrationSql('20260807000000_workspace_default_group');

  test('model column, mapping and relation exist', () => {
    expect(schema).toMatch(/defaultInternalGroupId\s+Int\?\s+@map\("default_internal_group_id"\)/);
    expect(schema).toMatch(/defaultInternalGroup\s+Group\?\s+@relation\("WorkspaceDefaultInternalGroup"/);
    // The FK clears on group deletion, never blocks it.
    expect(schema).toMatch(/onDelete: SetNull/);
    // Back-relation on Group.
    expect(schema).toMatch(/workspaceDefaults\s+Workspace\[\]\s+@relation\("WorkspaceDefaultInternalGroup"\)/);
  });

  test('SQL adds the column + guarded FK idempotently', () => {
    expect(sql).toMatch(/ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "default_internal_group_id" INTEGER/);
    expect(sql).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_default_internal_group_id_fkey'/);
    expect(sql).toMatch(/REFERENCES "groups"\("id"\)/);
    expect(sql).toMatch(/ON DELETE SET NULL/);
  });
});

describe('workflow last-suppression migration (20260807100000)', () => {
  const sql = migrationSql('20260807100000_workflow_last_suppression');

  test('model columns and mappings exist', () => {
    expect(schema).toMatch(/lastSuppressedAt\s+DateTime\?\s+@map\("last_suppressed_at"\)/);
    expect(schema).toMatch(/lastSuppressedReason\s+String\?\s+@map\("last_suppressed_reason"\)\s+@db\.VarChar\(80\)/);
  });

  test('SQL adds both columns idempotently', () => {
    expect(sql).toMatch(/ALTER TABLE "notification_workflows" ADD COLUMN IF NOT EXISTS "last_suppressed_at" TIMESTAMP\(3\)/);
    expect(sql).toMatch(/ALTER TABLE "notification_workflows" ADD COLUMN IF NOT EXISTS "last_suppressed_reason" VARCHAR\(80\)/);
  });
});
