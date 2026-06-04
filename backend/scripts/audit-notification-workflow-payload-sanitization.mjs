#!/usr/bin/env node
import pg from 'pg';

const { Client } = pg;

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function isoDate(value, label) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return date.toISOString();
}

function intValue(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function countRiskRows(client, {
  table,
  idColumn = 'id',
  jsonColumn,
  timeColumn,
  since,
  sampleLimit,
  whereSqlExtra = '',
  label = table,
}) {
  const params = [];
  const where = [];
  if (since) {
    params.push(since);
    where.push(`${timeColumn} >= $${params.length}::timestamptz`);
  }
  if (whereSqlExtra) where.push(whereSqlExtra);
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  params.push(sampleLimit);
  const sampleParam = `$${params.length}`;
  const sql = `
    with scoped as (
      select ${idColumn} as id, ${jsonColumn}::text as payload_text, ${timeColumn} as seen_at
      from ${table}
      ${whereSql}
    ), flagged as (
      select *,
        payload_text ~* '"activeContact"'
          or payload_text ~* '"contact"\\s*:'
          or payload_text ~* '"requester"\\s*:'
          or payload_text ~* '"assignedAgent"\\s*:'
          or payload_text ~* '"previousAgent"\\s*:' as contact_object,
        payload_text ~* '"hasActiveContact"\\s*:\\s*true'
          or payload_text ~* '"has(Requester|AssignedAgent|PreviousAgent)"\\s*:\\s*true' as allowed_contact_flag,
        payload_text ~* 'data:image/[a-z0-9.+-]+;base64,' as base64_image,
        payload_text ~* '(avatar|photo)(url|image|link)?' as avatar_photo,
        payload_text ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}' as email_like
      from scoped
    )
    select
      (select count(*)::int from flagged) as total_rows,
      (select count(*)::int from flagged where contact_object) as contact_object_rows,
      (select count(*)::int from flagged where allowed_contact_flag) as allowed_contact_flag_rows,
      (select count(*)::int from flagged where base64_image) as base64_image_rows,
      (select count(*)::int from flagged where avatar_photo) as avatar_photo_rows,
      (select count(*)::int from flagged where email_like) as email_like_rows,
      coalesce((
        select json_agg(id order by seen_at desc)
        from (
          select id, seen_at
          from flagged
          where contact_object or base64_image or avatar_photo or email_like
          order by seen_at desc
          limit ${sampleParam}
        ) samples
      ), '[]'::json) as sample_ids;
  `;
  const result = await client.query(sql, params);
  return {
    table: label,
    jsonColumn,
    since,
    sampleLimit,
    ...result.rows[0],
  };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const since = isoDate(argValue('--since'), '--since');
  const sampleLimit = Math.min(Math.max(intValue(argValue('--sample-limit', '50')), 1), 500);
  const client = new Client({
    connectionString: databaseUrl,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const [deliveries, stepRuns] = await Promise.all([
      countRiskRows(client, {
        table: 'notification_deliveries',
        jsonColumn: 'payload',
        timeColumn: 'queued_at',
        since,
        sampleLimit,
        whereSqlExtra: "workflow_run_id is not null and coalesce(notification_type, '') <> 'notification_workflow_test_email'",
        label: 'notification_deliveries.real_workflow_payload',
      }),
      countRiskRows(client, {
        table: 'notification_workflow_step_runs',
        jsonColumn: 'output',
        timeColumn: 'started_at',
        since,
        sampleLimit,
        label: 'notification_workflow_step_runs.output',
      }),
    ]);
    const summary = {
      generatedAt: new Date().toISOString(),
      mode: 'dry_run',
      since,
      checks: {
        contactObject: 'JSON contains raw contact/requester/agent objects. Allowed boolean flags are reported separately.',
        base64Image: 'JSON contains data:image base64 payloads.',
        avatarPhoto: 'JSON contains avatar/photo-style keys.',
        emailLike: 'JSON contains email-like values.',
      },
      results: [deliveries, stepRuns],
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
