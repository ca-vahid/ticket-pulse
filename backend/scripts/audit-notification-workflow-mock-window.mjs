import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const { Client } = pg;

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage() {
  return [
    'Usage:',
    '  node backend/scripts/audit-notification-workflow-mock-window.mjs --since "2026-06-02 02:47:32" [--out scratchpad/audit.json]',
    '',
    'Environment:',
    '  DATABASE_URL must point at the database to audit. The script prints aggregate evidence only.',
  ].join('\n');
}

function redactText(value = '') {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[phone]')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(value = '') {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pct(part, whole) {
  if (!whole) return null;
  return Math.round((Number(part || 0) / Number(whole || 0)) * 1000) / 10;
}

function parseIntValue(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sslConfig(connectionString) {
  if (!connectionString) return undefined;
  return /sslmode=require|sslmode=verify-full|sslmode=verify-ca/i.test(connectionString)
    ? undefined
    : { rejectUnauthorized: false };
}

function copyRiskFlags(row) {
  const content = `${row.subject || ''}\n${stripHtml(row.html_body || '')}\n${row.text_body || ''}`;
  const flags = [];
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(content)) flags.push('emoji');
  if (/\b(?:within\s+\d+\s+(?:business\s+)?(?:minute|hour|day|week)s?|by\s+(?:end of day|tomorrow|the next business day)|typically|usually|often\s+(?:resolved|completed|handled|addressed)|estimated\s+(?:response|resolution)|expected\s+(?:response|resolution))\b/i.test(content)) {
    flags.push('unsupported_timing_claim');
  }
  if (/\b(?:bedrock|rock solid|launchpad|launch pad|blast off|mission control|magic|sparkle|sprinkle|wizard|core sample|loose colluvium|good ground)\b/i.test(content)) {
    flags.push('playful_copy');
  }
  if (/\b(?:openai|anthropic|claude\s+(?:model|provider)|gpt(?:-[a-z0-9._-]+)?\s+(?:model|provider|fallback)|audit\s+id|tp-nwf-)\b/i.test(content)) {
    flags.push('internal_leak');
  }
  return flags;
}

function gate(status, detail, evidence = {}) {
  return { status, detail, evidence };
}

function evaluate({ runs, deliveries, duplicateGroups, llm, signalLevels, copyReview, minManualReview }) {
  const mockRuns = parseIntValue(runs.mock_runs);
  const mockedDeliveries = parseIntValue(deliveries.mocked);
  const payloadDeliveries = parseIntValue(deliveries.deliveries);
  const llmSteps = parseIntValue(llm.llm_steps);
  const possibleCount = signalLevels
    .filter((row) => row.signal_level === 'possible_broader_issue')
    .reduce((sum, row) => sum + parseIntValue(row.count), 0);

  return {
    duplicateTicketEventGroups: mockedDeliveries > 0
      ? gate(duplicateGroups.length === 0 ? 'pass' : 'fail', `${duplicateGroups.length} duplicate mocked delivery group(s).`, { mockedDeliveries })
      : gate('missing_evidence', 'No mocked deliveries exist in this window.', { mockedDeliveries }),
    llmRejectedFallbackVisibility: llmSteps > 0
      ? gate('pass', `${llm.guard_rejected} guard rejection(s), ${llm.template_fallback_used} visible fallback marker(s).`, llm)
      : gate('missing_evidence', 'No LLM steps exist in this window.', llm),
    possibleBroaderIssueRate: llmSteps > 0
      ? gate(pct(possibleCount, llmSteps) <= 15 ? 'pass' : 'review', `${pct(possibleCount, llmSteps)}% possible_broader_issue rate.`, { possibleCount, llmSteps })
      : gate('missing_evidence', 'No LLM context rows exist in this window.', { possibleCount, llmSteps }),
    compactPayloads: payloadDeliveries > 0
      ? gate(deliveries.base64_payloads === 0 && deliveries.active_contact_payloads === 0 ? 'pass' : 'fail', `${deliveries.base64_payloads} base64 payload(s), ${deliveries.active_contact_payloads} activeContact payload(s).`, deliveries)
      : gate('missing_evidence', 'No workflow delivery payloads exist in this window.', deliveries),
    professionalCopy: copyReview.reviewed >= minManualReview
      ? gate(copyReview.flagged === 0 ? 'pass' : 'review', `${copyReview.reviewed} output(s) scanned, ${copyReview.flagged} flagged for manual review.`, copyReview)
      : gate('missing_evidence', `Only ${copyReview.reviewed} output(s) available; ${minManualReview} required.`, copyReview),
    oneBusinessDayMockAudit: mockRuns >= minManualReview
      ? gate('review', 'Window has enough mock runs for audit volume, but business-day coverage must be confirmed against the selected timezone.', { mockRuns })
      : gate('missing_evidence', `Only ${mockRuns} mock run(s) in this window; ${minManualReview} required for the review sample.`, { mockRuns }),
  };
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(usage());
    return;
  }

  const since = argValue('--since');
  if (!since) throw new Error('Missing --since timestamp.');
  const minManualReview = Number.parseInt(argValue('--min-review', '20'), 10) || 20;
  const outPath = argValue('--out');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');

  const client = new Client({ connectionString, ssl: sslConfig(connectionString) });
  await client.connect();

  const [clock, runs, deliveries, duplicateGroups, llm, signalLevels, deliveryRows] = await Promise.all([
    client.query('select now() as db_now, current_setting(\'TimeZone\') as timezone'),
    client.query(`
      select count(*)::int as runs,
             count(*) filter (where execution_mode='mock')::int as mock_runs,
             count(*) filter (where execution_mode='preview')::int as preview_runs,
             count(*) filter (where status='failed')::int as failed_runs,
             min(started_at)::text as first_run,
             max(started_at)::text as last_run
      from notification_workflow_runs
      where started_at >= $1::timestamp
    `, [since]),
    client.query(`
      select count(*)::int as deliveries,
             count(*) filter (where status='mocked')::int as mocked,
             count(*) filter (where notification_type='notification_workflow_test_email')::int as test_emails,
             count(*) filter (where payload::text like '%data:image%')::int as base64_payloads,
             count(*) filter (where payload::text like '%activeContact%')::int as active_contact_payloads,
             percentile_cont(0.5) within group (order by length(coalesce(payload::text,'')))::int as p50_payload_chars,
             max(length(coalesce(payload::text,'')))::int as max_payload_chars
      from notification_deliveries
      where queued_at >= $1::timestamp and workflow_run_id is not null
    `, [since]),
    client.query(`
      select ticket_id, event_type, notification_type, count(*)::int as count
      from notification_deliveries
      where queued_at >= $1::timestamp
        and status='mocked'
        and ticket_id is not null
      group by 1,2,3
      having count(*) > 1
      order by count desc, ticket_id
    `, [since]),
    client.query(`
      select count(*)::int as llm_steps,
             count(*) filter (where output->>'guardRejected' = 'true')::int as guard_rejected,
             count(*) filter (where output->>'templateFallbackUsed' = 'true')::int as template_fallback_used,
             count(*) filter (where status='failed')::int as failed_step_rows
      from notification_workflow_step_runs
      where started_at >= $1::timestamp and node_type='llm_generate'
    `, [since]),
    client.query(`
      select coalesce(output #>> '{llm,context,signalLevel}', output #>> '{context,signalLevel}', output #>> '{outageSignals,signalLevel}', 'unknown') as signal_level,
             count(*)::int as count
      from notification_workflow_step_runs
      where started_at >= $1::timestamp and node_type='llm_generate'
      group by 1
      order by count desc
    `, [since]),
    client.query(`
      select d.id, d.workflow_run_id, d.ticket_id, d.event_type, d.notification_type, d.status,
             d.subject, d.html_body, d.text_body, d.queued_at::text as queued_at,
             t.priority, t.assessed_priority, t.ticket_category, t.category, t.sub_category
      from notification_deliveries d
      left join tickets t on t.id = d.ticket_id
      where d.queued_at >= $1::timestamp
        and d.workflow_run_id is not null
        and d.notification_type <> 'notification_workflow_test_email'
      order by d.queued_at desc, d.id desc
      limit $2
    `, [since, minManualReview]),
  ]);

  await client.end();

  const copySamples = deliveryRows.rows.map((row) => ({
    deliveryId: row.id,
    workflowRunId: row.workflow_run_id,
    ticketId: row.ticket_id,
    eventType: row.event_type,
    notificationType: row.notification_type,
    status: row.status,
    priority: row.assessed_priority || row.priority || null,
    category: row.ticket_category || row.category || null,
    subCategory: row.sub_category || null,
    queuedAt: row.queued_at,
    flags: copyRiskFlags(row),
    subjectPreview: redactText(row.subject).slice(0, 140),
  }));
  const copyReview = {
    reviewed: copySamples.length,
    flagged: copySamples.filter((sample) => sample.flags.length > 0).length,
    flaggedSamples: copySamples.filter((sample) => sample.flags.length > 0),
    samples: copySamples.map((sample) => ({
      deliveryId: sample.deliveryId,
      workflowRunId: sample.workflowRunId,
      ticketId: sample.ticketId,
      eventType: sample.eventType,
      priority: sample.priority,
      category: sample.category,
      subCategory: sample.subCategory,
      flags: sample.flags,
      subjectPreview: sample.subjectPreview,
    })),
  };

  const result = {
    generatedAt: new Date().toISOString(),
    since,
    clock: clock.rows[0],
    runs: runs.rows[0],
    deliveries: deliveries.rows[0],
    duplicateGroups: duplicateGroups.rows,
    llm: llm.rows[0],
    signalLevels: signalLevels.rows,
    copyReview,
  };
  result.gates = evaluate({
    runs: result.runs,
    deliveries: result.deliveries,
    duplicateGroups: result.duplicateGroups,
    llm: result.llm,
    signalLevels: result.signalLevels,
    copyReview,
    minManualReview,
  });

  const output = JSON.stringify(result, null, 2);
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, `${output}\n`);
  }
  console.log(output);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
