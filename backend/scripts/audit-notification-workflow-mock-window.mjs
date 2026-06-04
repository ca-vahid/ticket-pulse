import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const { Client } = pg;

const TEST_EMAIL_TYPE = 'notification_workflow_test_email';

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
    '  node backend/scripts/audit-notification-workflow-mock-window.mjs --since "2026-06-01T00:00:00Z" [--timezone America/Vancouver] [--out scratchpad/audit.json]',
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

function increment(map, key, amount = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + amount;
}

function extractPhraseCounts(content, regex) {
  const counts = {};
  for (const match of content.matchAll(regex)) {
    increment(counts, match[0].toLowerCase());
  }
  return counts;
}

function copyPolicyFindings(row) {
  const content = `${row.subject || ''}\n${stripHtml(row.html_body || '')}\n${row.text_body || ''}`;
  const findings = [];

  if (/\b(?:openai|anthropic|claude\s+(?:model|provider)|gpt(?:-[a-z0-9._-]+)?\s+(?:model|provider|fallback)|audit\s+id|tp-nwf-)\b/i.test(content)) {
    findings.push({
      ruleId: 'internal_leak',
      severity: 'hard_block',
      detail: 'Provider, model, or audit implementation detail appeared in requester-facing copy.',
    });
  }

  if (/<script[\s\S]*?>|javascript:/i.test(`${row.html_body || ''}\n${row.text_body || ''}`)) {
    findings.push({
      ruleId: 'unsafe_html',
      severity: 'hard_block',
      detail: 'Unsafe script or javascript URL pattern appeared in rendered body.',
    });
  }

  if (/\b(?:within\s+\d+\s+(?:business\s+)?(?:minute|hour|day|week)s?|by\s+(?:end of day|tomorrow|the next business day)|typically|usually|often\s+(?:resolved|completed|handled|addressed)|estimated\s+(?:response|resolution)|expected\s+(?:response|resolution))\b/i.test(content)) {
    findings.push({
      ruleId: 'unsupported_timing_claim',
      severity: 'auto_repair',
      detail: 'Timing or resolution expectation needs deterministic evidence.',
    });
  }

  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(content)) {
    findings.push({
      ruleId: 'emoji',
      severity: 'audit_only',
      detail: 'Emoji or symbol style appeared; allowed when workflow tone permits it.',
    });
  }

  if (/\b(?:bedrock|rock solid|launchpad|launch pad|blast off|mission control|magic|sparkle|sprinkle|wizard|core sample|loose colluvium|good ground)\b/i.test(content)) {
    findings.push({
      ruleId: 'playful_copy',
      severity: 'audit_only',
      detail: 'Playful or branded metaphor appeared; allowed when workflow tone permits it.',
    });
  }

  return findings;
}

function summarizeDefinition(definition = {}) {
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : [];
  const llmNodes = nodes
    .filter((node) => node.type === 'llm_generate' || node.data?.type === 'llm_generate')
    .map((node) => {
      const data = node.data || {};
      const prompt = data.prompt || data.systemPrompt || data.instructions || '';
      return {
        nodeId: node.id,
        outputMode: data.outputMode || data.output_mode || null,
        toolMode: data.toolMode || data.tool_mode || null,
        promptPresent: Boolean(prompt),
        promptLength: String(prompt || '').length,
        tone: data.tone || data.toneMode || data.tone_mode || null,
        requesterGuardrails: data.requesterGuardrails || data.requester_guardrails || null,
        policy: data.policy || data.guardrailPolicy || data.guardrail_policy || null,
      };
    });
  const sendNodes = nodes
    .filter((node) => node.type === 'send_email' || node.data?.type === 'send_email')
    .map((node) => {
      const data = node.data || {};
      return {
        nodeId: node.id,
        includeHeader: data.includeHeader ?? data.include_header ?? null,
        headerBlockId: data.headerBlockId ?? data.header_block_id ?? null,
        footerBlockId: data.footerBlockId ?? data.footer_block_id ?? null,
      };
    });

  return {
    nodeCount: nodes.length,
    llmNodes,
    sendNodes,
  };
}

function summarizeWorkflowConfig(row) {
  const definition = row.published_definition || row.draft_definition || {};
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    key: row.key,
    name: row.name,
    triggerType: row.trigger_type,
    isEnabled: row.is_enabled,
    mockModeEnabled: row.mock_mode_enabled,
    publishedVersion: row.published_version,
    publishedVersionId: row.version_id,
    publishedAt: row.published_at,
    definition: summarizeDefinition(definition),
  };
}

function gate(status, detail, evidence = {}) {
  return { status, detail, evidence };
}

function evaluate({
  runs,
  deliveries,
  realDuplicateGroups,
  llm,
  signalLevels,
  payloadAudit,
  copyReview,
  minManualReview,
}) {
  const mockRuns = parseIntValue(runs.mock_runs);
  const realMockDeliveries = parseIntValue(deliveries.real_mocked);
  const payloadDeliveries = parseIntValue(payloadAudit.deliveries);
  const llmSteps = parseIntValue(llm.llm_steps);
  const possibleCount = signalLevels
    .filter((row) => row.signal_level === 'possible_broader_issue')
    .reduce((sum, row) => sum + parseIntValue(row.count), 0);
  const hardBlockFindings = parseIntValue(copyReview.severityCounts.hard_block);
  const autoRepairFindings = parseIntValue(copyReview.severityCounts.auto_repair);

  return {
    duplicateTicketEventGroups: realMockDeliveries > 0
      ? gate(realDuplicateGroups.length === 0 ? 'pass' : 'fail', `${realDuplicateGroups.length} real mocked duplicate delivery group(s).`, { realMockDeliveries })
      : gate('missing_evidence', 'No real mocked workflow deliveries exist in this window.', { realMockDeliveries }),
    degradedRunVisibility: mockRuns > 0
      ? gate('review', 'Run health is reported separately from workflow execution status.', { mockRuns })
      : gate('missing_evidence', 'No mock runs exist in this window.', { mockRuns }),
    llmFallbackVisibility: llmSteps > 0
      ? gate('pass', `${llm.guard_rejected} guard rejection(s), ${llm.template_fallback_used} template fallback marker(s), ${llm.provider_or_schema} provider/schema fallback marker(s).`, llm)
      : gate('missing_evidence', 'No LLM steps exist in this window.', llm),
    possibleBroaderIssueRate: llmSteps > 0
      ? gate(pct(possibleCount, llmSteps) <= 15 ? 'pass' : 'review', `${pct(possibleCount, llmSteps)}% possible_broader_issue rate.`, { possibleCount, llmSteps })
      : gate('missing_evidence', 'No LLM context rows exist in this window.', { possibleCount, llmSteps }),
    compactPayloads: payloadDeliveries > 0
      ? gate(
          payloadAudit.base64_payloads === 0
            && payloadAudit.active_contact_payloads === 0
            && payloadAudit.avatar_or_photo_payloads === 0
            && payloadAudit.email_like_payloads === 0
            ? 'pass'
            : 'fail',
          `${payloadAudit.base64_payloads} base64, ${payloadAudit.active_contact_payloads} activeContact, ${payloadAudit.avatar_or_photo_payloads} avatar/photo, ${payloadAudit.email_like_payloads} email-like payload(s).`,
          payloadAudit,
        )
      : gate('missing_evidence', 'No workflow delivery payloads exist in this window.', payloadAudit),
    copyPolicy: copyReview.reviewed >= minManualReview
      ? gate(
          hardBlockFindings === 0 && autoRepairFindings === 0 ? 'pass' : 'review',
          `${copyReview.reviewed} output(s) scanned, ${hardBlockFindings} hard-block and ${autoRepairFindings} auto-repair finding(s). Audit-only style findings are not blockers.`,
          copyReview.severityCounts,
        )
      : gate('missing_evidence', `Only ${copyReview.reviewed} output(s) available; ${minManualReview} required.`, copyReview.severityCounts),
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
  const timezone = argValue('--timezone', 'America/Vancouver');
  const minManualReview = Number.parseInt(argValue('--min-review', '20'), 10) || 20;
  const copySampleLimit = Number.parseInt(argValue('--copy-sample-limit', '20'), 10) || 20;
  const latestRunLimit = Number.parseInt(argValue('--latest-run-limit', '20'), 10) || 20;
  const outPath = argValue('--out');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');

  const client = new Client({ connectionString, ssl: sslConfig(connectionString) });
  await client.connect();

  const [
    clock,
    runs,
    runsByLocalDay,
    runsByTrigger,
    runsByWorkflowEvent,
    runHealth,
    deliveries,
    realDuplicateGroups,
    llm,
    fallbackCauses,
    repairedIssues,
    blockedIssues,
    signalLevels,
    signalSamples,
    providerAttempts,
    stepTypes,
    payloadAudit,
    payloadLargestShapes,
    workflowConfigs,
    llmToolPolicy,
    deliveryRows,
    latestRuns,
  ] = await Promise.all([
    client.query('select now() as db_now, current_setting(\'TimeZone\') as timezone'),
    client.query(`
      select count(*)::int as runs,
             count(*) filter (where execution_mode='mock')::int as mock_runs,
             count(*) filter (where execution_mode='preview')::int as preview_runs,
             count(*) filter (where execution_mode='live')::int as live_runs,
             count(*) filter (where status='completed')::int as completed_runs,
             count(*) filter (where status='failed')::int as failed_runs,
             min(started_at)::text as first_run,
             max(started_at)::text as last_run
      from notification_workflow_runs
      where started_at >= $1::timestamp
    `, [since]),
    client.query(`
      select to_char((started_at AT TIME ZONE 'UTC') AT TIME ZONE $2, 'YYYY-MM-DD') as local_day,
             count(*)::int as runs,
             count(*) filter (where execution_mode='mock')::int as mock_runs,
             count(*) filter (where execution_mode='preview')::int as preview_runs,
             count(*) filter (where execution_mode='live')::int as live_runs,
             min(started_at)::text as first_run,
             max(started_at)::text as last_run
      from notification_workflow_runs
      where started_at >= $1::timestamp
      group by 1
      order by 1
    `, [since, timezone]),
    client.query(`
      select coalesce(trigger_source, 'unknown') as trigger_source,
             execution_mode,
             count(*)::int as count
      from notification_workflow_runs
      where started_at >= $1::timestamp
      group by 1, 2
      order by count desc, trigger_source, execution_mode
    `, [since]),
    client.query(`
      select w.key as workflow_key,
             w.name as workflow_name,
             r.event_type,
             r.execution_mode,
             count(*)::int as count
      from notification_workflow_runs r
      join notification_workflows w on w.id = r.workflow_id
      where r.started_at >= $1::timestamp
      group by 1, 2, 3, 4
      order by count desc, workflow_key, event_type, execution_mode
    `, [since]),
    client.query(`
      with run_flags as (
        select r.id,
               r.status,
               bool_or(coalesce(s.output->>'templateFallbackUsed', 'false') = 'true') as fallback_used,
               bool_or(coalesce(s.output->>'guardRejected', 'false') = 'true') as guard_rejected,
               bool_or(coalesce(s.output->>'failureType', '') <> '') as failure_type_present,
               bool_or(s.status = 'failed') as step_failed,
               bool_or(
                 jsonb_typeof(s.output::jsonb->'repairedIssues') = 'array'
                 and jsonb_array_length(s.output::jsonb->'repairedIssues') > 0
               ) as repaired,
               bool_or(
                 jsonb_typeof(s.output::jsonb->'warnings') = 'array'
                 and jsonb_array_length(s.output::jsonb->'warnings') > 0
               ) as warnings
        from notification_workflow_runs r
        left join notification_workflow_step_runs s on s.run_id = r.id
        where r.started_at >= $1::timestamp
        group by r.id, r.status
      )
      select case
               when status = 'failed' then 'failed'
               when fallback_used or guard_rejected or failure_type_present then 'completed_with_fallback'
               when repaired then 'completed_with_repair'
               when warnings or step_failed then 'completed_with_warning'
               else 'completed_clean'
             end as run_health,
             count(*)::int as count
      from run_flags
      group by 1
      order by count desc, run_health
    `, [since]),
    client.query(`
      select count(*)::int as deliveries,
             count(*) filter (where status='mocked')::int as mocked,
             count(*) filter (where status='sent')::int as sent,
             count(*) filter (where status='failed')::int as failed,
             count(*) filter (where status='mocked' and coalesce(notification_type, '') <> $2)::int as real_mocked,
             count(*) filter (where notification_type=$2)::int as test_emails,
             percentile_cont(0.5) within group (order by length(coalesce(payload::text,'')))::int as p50_payload_chars,
             percentile_cont(0.95) within group (order by length(coalesce(payload::text,'')))::int as p95_payload_chars,
             max(length(coalesce(payload::text,'')))::int as max_payload_chars
      from notification_deliveries
      where queued_at >= $1::timestamp and workflow_run_id is not null
    `, [since, TEST_EMAIL_TYPE]),
    client.query(`
      select d.ticket_id,
             t.freshservice_ticket_id::text as freshservice_ticket_id,
             d.event_type,
             d.notification_type,
             count(*)::int as count,
             array_agg(distinct r.trigger_source order by r.trigger_source) as trigger_sources,
             array_agg(r.id order by r.id) as run_ids,
             array_agg(distinct left(coalesce(d.subject,''), 120) order by left(coalesce(d.subject,''), 120)) as subject_previews
      from notification_deliveries d
      join notification_workflow_runs r on r.id = d.workflow_run_id
      left join tickets t on t.id = d.ticket_id
      where d.queued_at >= $1::timestamp
        and d.status = 'mocked'
        and r.execution_mode = 'mock'
        and d.ticket_id is not null
        and coalesce(d.notification_type, '') <> $2
      group by d.ticket_id, t.freshservice_ticket_id, d.event_type, d.notification_type
      having count(*) > 1
      order by count desc, d.ticket_id
    `, [since, TEST_EMAIL_TYPE]),
    client.query(`
      select count(*)::int as llm_steps,
             count(*) filter (where status='completed')::int as completed,
             count(*) filter (where status='failed')::int as failed,
             count(*) filter (where output->>'guardRejected' = 'true')::int as guard_rejected,
             count(*) filter (where output->>'templateFallbackUsed' = 'true')::int as template_fallback_used,
             count(*) filter (where coalesce(output->>'failureType', '') = 'provider_or_schema')::int as provider_or_schema
      from notification_workflow_step_runs
      where started_at >= $1::timestamp and node_type='llm_generate'
    `, [since]),
    client.query(`
      select coalesce(s.output->>'failureType', 'none') as failure_type,
             coalesce(nullif(s.error, ''), nullif(s.output->>'error', ''), 'no error text') as error,
             count(*)::int as count,
             min(r.id)::int as first_run_id,
             max(r.id)::int as last_run_id
      from notification_workflow_step_runs s
      join notification_workflow_runs r on r.id = s.run_id
      where s.started_at >= $1::timestamp
        and s.node_type = 'llm_generate'
        and (
          s.status = 'failed'
          or s.output->>'guardRejected' = 'true'
          or s.output->>'templateFallbackUsed' = 'true'
          or coalesce(s.output->>'failureType', '') <> ''
        )
      group by 1, 2
      order by count desc, failure_type, error
    `, [since]),
    client.query(`
      select issue.value as issue,
             count(*)::int as count,
             min(s.run_id)::int as first_run_id,
             max(s.run_id)::int as last_run_id
      from notification_workflow_step_runs s
      cross join lateral jsonb_array_elements_text(
        case
          when jsonb_typeof(s.output::jsonb->'repairedIssues') = 'array' then s.output::jsonb->'repairedIssues'
          else '[]'::jsonb
        end
      ) as issue(value)
      where s.started_at >= $1::timestamp
        and s.node_type = 'llm_generate'
      group by issue.value
      order by count desc, issue
    `, [since]),
    client.query(`
      select issue.value as issue,
             count(*)::int as count,
             min(s.run_id)::int as first_run_id,
             max(s.run_id)::int as last_run_id
      from notification_workflow_step_runs s
      cross join lateral jsonb_array_elements_text(
        case
          when jsonb_typeof(s.output::jsonb->'blockedIssues') = 'array' then s.output::jsonb->'blockedIssues'
          else '[]'::jsonb
        end
      ) as issue(value)
      where s.started_at >= $1::timestamp
        and s.node_type = 'llm_generate'
      group by issue.value
      order by count desc, issue
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
      select r.id as run_id,
             t.freshservice_ticket_id::text as freshservice_ticket_id,
             left(coalesce(t.subject, ''), 120) as subject_preview,
             coalesce(s.output #>> '{llm,context,signalLevel}', s.output #>> '{context,signalLevel}', s.output #>> '{outageSignals,signalLevel}', 'unknown') as signal_level,
             coalesce(s.output #> '{llm,context,outageSignals}', s.output #> '{context,outageSignals}', s.output #> '{outageSignals}', '{}'::jsonb) as signal_summary
      from notification_workflow_step_runs s
      join notification_workflow_runs r on r.id = s.run_id
      left join tickets t on t.id = r.ticket_id
      where s.started_at >= $1::timestamp
        and s.node_type='llm_generate'
      order by r.id desc
      limit 20
    `, [since]),
    client.query(`
      select provider,
             model,
             status,
             coalesce(error_class, 'none') as error_class,
             left(coalesce(error_message, ''), 160) as error_preview,
             count(*)::int as count,
             min(notification_workflow_run_id)::int as first_run_id,
             max(notification_workflow_run_id)::int as last_run_id
      from ai_provider_attempts
      where started_at >= $1::timestamp
        and notification_workflow_run_id is not null
      group by 1, 2, 3, 4, 5
      order by count desc, provider, model, status
    `, [since]),
    client.query(`
      select node_type,
             status,
             count(*)::int as count,
             percentile_cont(0.5) within group (order by duration_ms)::int as p50_ms,
             percentile_cont(0.95) within group (order by duration_ms)::int as p95_ms,
             max(duration_ms)::int as max_ms
      from notification_workflow_step_runs
      where started_at >= $1::timestamp
      group by 1, 2
      order by count desc, node_type, status
    `, [since]),
    client.query(`
      select count(*)::int as deliveries,
             (
               select count(*)::int
               from notification_deliveries test_delivery
               where test_delivery.queued_at >= $1::timestamp
                 and test_delivery.workflow_run_id is not null
                 and coalesce(test_delivery.notification_type, '') = $2
             ) as test_email_payloads_excluded,
             count(*) filter (where payload::text ~* '"activeContact"\\s*:')::int as active_contact_payloads,
             count(*) filter (where payload::text like '%data:image%')::int as base64_payloads,
             count(*) filter (where payload::text ~* '"[^"]*(avatar|photo)(url|image|link)?[^"]*"\\s*:')::int as avatar_or_photo_payloads,
             count(*) filter (where payload::text ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}')::int as email_like_payloads,
             count(*) filter (where payload::text ~* '"(requester|assignedAgent|previousAgent|contact)"\\s*:')::int as named_contact_payloads,
             percentile_cont(0.5) within group (order by length(coalesce(payload::text,'')))::int as p50_payload_chars,
             percentile_cont(0.95) within group (order by length(coalesce(payload::text,'')))::int as p95_payload_chars,
             max(length(coalesce(payload::text,'')))::int as max_payload_chars
      from notification_deliveries
      where queued_at >= $1::timestamp and workflow_run_id is not null
        and coalesce(notification_type, '') <> $2
    `, [since, TEST_EMAIL_TYPE]),
    client.query(`
      select d.id as delivery_id,
             d.workflow_run_id,
             length(coalesce(d.payload::text, ''))::int as payload_chars,
             (select array_agg(key order by key) from jsonb_object_keys(d.payload::jsonb) as key) as top_level_keys,
             case when jsonb_typeof(d.payload::jsonb -> 'actionLinks') = 'object'
               then (select array_agg(key order by key) from jsonb_object_keys(d.payload::jsonb -> 'actionLinks') as key)
               else null end as action_link_keys,
             case when jsonb_typeof(d.payload::jsonb #> '{actionLinks,afterHoursSupport}') = 'object'
               then (select array_agg(key order by key) from jsonb_object_keys(d.payload::jsonb #> '{actionLinks,afterHoursSupport}') as key)
               else null end as after_hours_support_keys,
             case when jsonb_typeof(d.payload::jsonb #> '{actionLinks,raiseUrgency}') = 'object'
               then (select array_agg(key order by key) from jsonb_object_keys(d.payload::jsonb #> '{actionLinks,raiseUrgency}') as key)
               else null end as raise_urgency_keys,
             case when jsonb_typeof(d.payload::jsonb #> '{actionLinks,publicStatus}') = 'object'
               then (select array_agg(key order by key) from jsonb_object_keys(d.payload::jsonb #> '{actionLinks,publicStatus}') as key)
               else null end as public_status_keys
      from notification_deliveries d
      where d.queued_at >= $1::timestamp
        and d.workflow_run_id is not null
        and coalesce(d.notification_type, '') <> $2
      order by length(coalesce(d.payload::text, '')) desc
      limit 5
    `, [since, TEST_EMAIL_TYPE]),
    client.query(`
      select w.id,
             w.workspace_id,
             w.key,
             w.name,
             w.trigger_type,
             w.is_enabled,
             w.mock_mode_enabled,
             w.published_version,
             w.published_definition,
             w.draft_definition,
             v.id as version_id,
             v.published_at::text as published_at
      from notification_workflows w
      left join notification_workflow_versions v
        on v.workflow_id = w.id and v.version = w.published_version
      where w.is_enabled = true or w.mock_mode_enabled = true
      order by w.workspace_id, w.key
    `),
    client.query(`
      select workspace_id,
             mode,
             enabled_tools,
             tool_settings,
             max_turns,
             max_tool_calls,
             total_timeout_ms,
             per_tool_timeout_ms,
             include_private_notes,
             redaction_enabled,
             policy_version,
             updated_at::text as updated_at
      from notification_llm_tool_policies
      order by workspace_id
    `),
    client.query(`
      select d.id, d.workflow_run_id, d.ticket_id, d.event_type, d.notification_type, d.status,
             d.subject, d.html_body, d.text_body, d.queued_at::text as queued_at,
             t.priority, t.assessed_priority, t.ticket_category, t.category, t.sub_category
      from notification_deliveries d
      left join tickets t on t.id = d.ticket_id
      where d.queued_at >= $1::timestamp
        and d.workflow_run_id is not null
        and coalesce(d.notification_type, '') <> $2
      order by d.queued_at desc, d.id desc
    `, [since, TEST_EMAIL_TYPE]),
    client.query(`
      select r.id,
             r.started_at::text as started_at,
             w.key as workflow_key,
             r.event_type,
             r.execution_mode,
             r.trigger_source,
             r.status,
             t.freshservice_ticket_id::text as freshservice_ticket_id,
             left(coalesce(t.subject, ''), 120) as ticket_subject_preview,
             coalesce(s.status, 'no_llm') as llm_status,
             coalesce(s.output->>'failureType', 'none') as llm_failure_type,
             coalesce(s.output->>'templateFallbackUsed', 'false') as template_fallback_used,
             coalesce(s.output->>'guardRejected', 'false') as guard_rejected,
             left(coalesce(s.error, ''), 160) as llm_error_preview
      from notification_workflow_runs r
      join notification_workflows w on w.id = r.workflow_id
      left join tickets t on t.id = r.ticket_id
      left join notification_workflow_step_runs s on s.run_id = r.id and s.node_type = 'llm_generate'
      where r.started_at >= $1::timestamp
      order by r.id desc
      limit $2
    `, [since, latestRunLimit]),
  ]);

  await client.end();

  const copySamples = [];
  const severityCounts = {};
  const ruleCounts = {};
  const timingPhraseCounts = {};
  const auditOnlyPhraseCounts = {};

  for (const row of deliveryRows.rows) {
    const findings = copyPolicyFindings(row);
    const content = `${row.subject || ''}\n${stripHtml(row.html_body || '')}\n${row.text_body || ''}`;
    const timingPhrases = extractPhraseCounts(content, /\b(?:within\s+\d+\s+(?:business\s+)?(?:minute|hour|day|week)s?|by\s+(?:end of day|tomorrow|the next business day)|typically|usually|often\s+(?:resolved|completed|handled|addressed)|estimated\s+(?:response|resolution)|expected\s+(?:response|resolution))\b/ig);
    const auditOnlyPhrases = extractPhraseCounts(content, /\b(?:bedrock|rock solid|launchpad|launch pad|blast off|mission control|magic|sparkle|sprinkle|wizard|core sample|loose colluvium|good ground)\b/ig);

    for (const [phrase, count] of Object.entries(timingPhrases)) increment(timingPhraseCounts, phrase, count);
    for (const [phrase, count] of Object.entries(auditOnlyPhrases)) increment(auditOnlyPhraseCounts, phrase, count);
    for (const finding of findings) {
      increment(severityCounts, finding.severity);
      increment(ruleCounts, finding.ruleId);
    }

    if (findings.length && copySamples.length < copySampleLimit) {
      copySamples.push({
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
        findings,
        subjectPreview: redactText(row.subject).slice(0, 140),
      });
    }
  }

  const copyReview = {
    reviewed: deliveryRows.rows.length,
    severityCounts,
    ruleCounts,
    timingPhraseCounts,
    auditOnlyPhraseCounts,
    flaggedSamples: copySamples,
    note: 'audit_only findings are style visibility only; they are not blockers when workflow tone permits relaxed copy.',
  };

  const result = {
    generatedAt: new Date().toISOString(),
    since,
    timezone,
    clock: clock.rows[0],
    runs: runs.rows[0],
    runsByLocalDay: runsByLocalDay.rows,
    runsByTrigger: runsByTrigger.rows,
    runsByWorkflowEvent: runsByWorkflowEvent.rows,
    runHealth: runHealth.rows,
    deliveries: deliveries.rows[0],
    realDuplicateGroups: realDuplicateGroups.rows,
    llm: llm.rows[0],
    fallbackCauses: fallbackCauses.rows,
    repairedIssues: repairedIssues.rows,
    blockedIssues: blockedIssues.rows,
    signalLevels: signalLevels.rows,
    signalSamples: signalSamples.rows,
    providerAttempts: providerAttempts.rows,
    stepTypes: stepTypes.rows,
    payloadAudit: payloadAudit.rows[0],
    payloadLargestShapes: payloadLargestShapes.rows,
    workflowConfigs: workflowConfigs.rows.map(summarizeWorkflowConfig),
    llmToolPolicy: llmToolPolicy.rows,
    copyReview,
    latestRuns: latestRuns.rows,
  };

  result.gates = evaluate({
    runs: result.runs,
    deliveries: result.deliveries,
    realDuplicateGroups: result.realDuplicateGroups,
    llm: result.llm,
    signalLevels: result.signalLevels,
    payloadAudit: result.payloadAudit,
    copyReview,
    minManualReview,
  });

  result.summary = {
    runCount: parseIntValue(result.runs.runs),
    mockRunCount: parseIntValue(result.runs.mock_runs),
    previewRunCount: parseIntValue(result.runs.preview_runs),
    realDuplicateGroupCount: result.realDuplicateGroups.length,
    llmFallbackMarkers: parseIntValue(result.llm.template_fallback_used),
    providerOrSchemaMarkers: parseIntValue(result.llm.provider_or_schema),
    possibleBroaderIssueRate: pct(
      result.signalLevels
        .filter((row) => row.signal_level === 'possible_broader_issue')
        .reduce((sum, row) => sum + parseIntValue(row.count), 0),
      parseIntValue(result.llm.llm_steps),
    ),
    hardBlockCopyFindings: parseIntValue(result.copyReview.severityCounts.hard_block),
    autoRepairCopyFindings: parseIntValue(result.copyReview.severityCounts.auto_repair),
    auditOnlyCopyFindings: parseIntValue(result.copyReview.severityCounts.audit_only),
  };

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
