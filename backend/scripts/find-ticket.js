import { Client } from 'pg';

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function main() {
  await client.connect();
  // All runs (any status) for our ticket
  const r = await client.query(
    `SELECT id, status, decision, trigger_source, queued_at, queued_reason,
            claimed_at, decided_at, created_at, updated_at, error_message
       FROM assignment_pipeline_runs
      WHERE ticket_id = 22256
      ORDER BY created_at DESC`,
  );
  console.log(`All runs for ticket 22256 (${r.rowCount}):`);
  for (const row of r.rows) console.log(row);

  // Currently queued runs (so we can see what 'Queued for Business Hours' has)
  const q = await client.query(
    `SELECT r.id, r.ticket_id, t.freshservice_ticket_id, t.subject,
            r.trigger_source, r.queued_at, r.queued_reason, r.created_at
       FROM assignment_pipeline_runs r
       JOIN tickets t ON t.id = r.ticket_id
      WHERE r.status = 'queued'
      ORDER BY r.created_at ASC`,
  );
  console.log(`\nAll currently queued runs (${q.rowCount}):`);
  for (const row of q.rows) console.log(row);
}
main().catch(console.error).finally(() => client.end());
