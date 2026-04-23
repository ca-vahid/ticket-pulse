/**
 * One-off: undo a manual run for a queued ticket.
 *
 * Deletes the current `completed` + `pending_review` pipeline run for a
 * given Freshservice ticket (and its steps), then re-inserts a fresh
 * `queued` row so the next-business-hours drain picks it up again.
 *
 * Usage:
 *   DATABASE_URL=<prod_url> node backend/scripts/requeue-ticket.js <freshservice_ticket_id> [--execute]
 *
 * Without --execute it runs in PREVIEW mode (no writes).
 */
import { Client } from 'pg';

const fsTicketIdArg = process.argv[2];
const execute = process.argv.includes('--execute');

if (!fsTicketIdArg || !/^\d+$/.test(fsTicketIdArg)) {
  console.error('Usage: node backend/scripts/requeue-ticket.js <freshservice_ticket_id> [--execute]');
  process.exit(1);
}
const fsTicketId = Number(fsTicketIdArg);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function main() {
  await client.connect();

  console.log(`\n=== ${execute ? 'EXECUTING' : 'PREVIEW'} requeue for FS ticket ${fsTicketId} ===\n`);

  const ticketRes = await client.query(
    'SELECT id, freshservice_ticket_id, subject, status, assigned_tech_id FROM tickets WHERE freshservice_ticket_id = $1',
    [fsTicketId],
  );
  if (ticketRes.rowCount === 0) {
    console.error(`No ticket found with freshservice_ticket_id=${fsTicketId}`);
    process.exit(1);
  }
  const ticket = ticketRes.rows[0];
  console.log('Ticket:', ticket);

  const runRes = await client.query(
    `SELECT id, ticket_id, workspace_id, status, decision, trigger_source, rebound_from,
            queued_at, queued_reason, claimed_at, decided_at, created_at, updated_at
       FROM assignment_pipeline_runs
      WHERE ticket_id = $1
        AND status = 'completed'
        AND decision = 'pending_review'
      ORDER BY created_at DESC`,
    [ticket.id],
  );

  if (runRes.rowCount === 0) {
    console.error(`No completed+pending_review pipeline run found for ticket ${ticket.id}.`);
    console.error('Nothing to undo. Aborting.');
    process.exit(1);
  }
  if (runRes.rowCount > 1) {
    console.error(`Found ${runRes.rowCount} pending_review runs for this ticket — too ambiguous, aborting.`);
    console.error('Rows:', runRes.rows);
    process.exit(1);
  }
  const run = runRes.rows[0];
  console.log('\nTarget pipeline run to delete:', run);

  // Check for any open run that would conflict with the unique index on
  // (ticket_id) WHERE status IN ('queued','running').
  const conflictRes = await client.query(
    `SELECT id, status FROM assignment_pipeline_runs
      WHERE ticket_id = $1 AND status IN ('queued','running')`,
    [ticket.id],
  );
  if (conflictRes.rowCount > 0) {
    console.error('\nConflict: an open run already exists for this ticket. Aborting.');
    console.error(conflictRes.rows);
    process.exit(1);
  }

  // Check for any TicketAssignment rows pointing at this run — should be
  // none for a pending_review run (no decision applied yet), but verify
  // because the FK is RESTRICT/NoAction (not CASCADE).
  const taRes = await client.query(
    'SELECT id FROM ticket_assignments WHERE pipeline_run_id = $1',
    [run.id],
  );
  if (taRes.rowCount > 0) {
    console.error(`\nCannot delete: ${taRes.rowCount} ticket_assignments rows reference this run.`);
    console.error('Rows:', taRes.rows);
    process.exit(1);
  }

  console.log('\nPlanned actions:');
  console.log(`  1. DELETE assignment_pipeline_steps WHERE pipeline_run_id = ${run.id}`);
  console.log(`  2. DELETE assignment_pipeline_runs WHERE id = ${run.id}`);
  console.log(`  3. INSERT new queued row for ticket_id=${ticket.id}, workspace_id=${run.workspace_id},`);
  console.log(`     trigger_source='${run.trigger_source}', queued_reason='Outside business hours'`);

  if (!execute) {
    console.log('\n(Preview only — re-run with --execute to apply.)');
    return;
  }

  await client.query('BEGIN');
  try {
    const stepsDel = await client.query(
      'DELETE FROM assignment_pipeline_steps WHERE pipeline_run_id = $1',
      [run.id],
    );
    console.log(`Deleted ${stepsDel.rowCount} pipeline steps.`);

    const runDel = await client.query(
      'DELETE FROM assignment_pipeline_runs WHERE id = $1 AND status = $2 AND decision = $3',
      [run.id, 'completed', 'pending_review'],
    );
    if (runDel.rowCount !== 1) {
      throw new Error(`Expected to delete exactly 1 run, deleted ${runDel.rowCount}. Aborting.`);
    }
    console.log(`Deleted pipeline run ${run.id}.`);

    // Match the format of the other auto-queued rows (trigger_source='poll',
    // standard queued_reason) so this ticket drains alongside them at the
    // start of business hours. The original `manual` trigger_source is
    // intentionally NOT preserved — see the notes in the requeue PR.
    const ins = await client.query(
      `INSERT INTO assignment_pipeline_runs
         (ticket_id, workspace_id, status, trigger_source, rebound_from,
          queued_at, queued_reason, created_at, updated_at)
       VALUES ($1, $2, 'queued', 'poll', $3, NOW(), $4, NOW(), NOW())
       RETURNING id, status, trigger_source, queued_reason, queued_at`,
      [
        run.ticket_id,
        run.workspace_id,
        run.rebound_from,
        'Outside business hours (05:00 - 17:00)',
      ],
    );
    console.log('Created new queued run:', ins.rows[0]);

    await client.query('COMMIT');
    console.log('\nCommit OK.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nRolled back due to error:', err);
    process.exit(1);
  }
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => client.end());
