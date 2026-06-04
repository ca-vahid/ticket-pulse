# Notification Workflow Operations Playbook

Last updated: 2026-06-03

## Daily Audit Report

Run this once per business day while notification workflows are in mock mode and during the first live-send rollout window.

```powershell
$since = (Get-Date).AddDays(-1).ToUniversalTime().ToString("o")
npm run audit:notification-workflows --prefix backend -- --since $since --timezone America/Vancouver --out scratchpad/notification-workflow-daily-audit.json
npm run audit:notification-workflow-payloads --prefix backend -- --since $since --sample-limit 50
```

Review these fields first:

- `gates.duplicateTicketEventGroups`
- `gates.llmFallbackVisibility`
- `gates.possibleBroaderIssueRate`
- `gates.compactPayloads`
- `gates.copyPolicy`
- `summary`
- `providerAttempts`
- `fallbackCauses`

Use `GET /api/notification-workflows/health` for the same operational counters in the app. The warning types to treat as daily review items are `duplicate_suppression_spike`, `duplicate_mock_delivery_groups`, `provider_schema_failures`, `template_fallback_rate`, `guard_hard_block_count`, `payload_minimization_failure`, and `possible_broader_issue_rate`.

## Disable A Workflow

1. Open Settings > Mail Workflows.
2. Select the workflow.
3. Turn off the workflow enabled control.
4. Save and confirm the workflow no longer appears as enabled in the header health cards.
5. Run the daily audit report after the next sync window and confirm no new rows for that workflow key.

## Force Mock Mode

1. Open Settings > Mail Workflows.
2. Select the workflow.
3. Enable mock mode.
4. Save and publish the workflow version.
5. Confirm `/api/notification-workflows/health` shows the workflow in mock-enabled counts.
6. Trigger a preview or wait for the next live event and confirm deliveries are `mocked`, not `queued` or `sent`.

## Inspect A Degraded Run

1. Open Workflow Audit.
2. Filter by health: fallback, repaired, warning, or failed.
3. Open the run detail.
4. Check Run warnings, Run health, LLM diagnostics, guard policy issues, provider/model attempt status, and fallback source.
5. For provider/schema failures, compare the run timestamp with `providerAttempts` from the daily audit report.
6. For guard issues, confirm `policyTier`, `ruleId`, and `actionTaken` are present.

## Replay Preview Safely

1. Use Workflow Audit test email only for mock or preview rows.
2. Confirm the banner subject starts with `[TEST]`.
3. Confirm the delivery type is `notification_workflow_test_email`.
4. Do not use test-email rows as duplicate-risk evidence; the audit scripts exclude them from real workflow duplicate gates.

## Clean Or Redact A Bad Audit Payload Row

Use cleanup only when a payload contains raw contact objects, base64 image data, avatar/photo fields, or direct contact values.

1. Run the dry-run payload audit and record sample row IDs.
2. Confirm the row belongs to `notification_deliveries.payload` or `notification_workflow_step_runs.output`.
3. Prefer application-level sanitizer fixes before historical cleanup.
4. If cleanup is required, redact only the affected JSON keys and keep workflow ID, run ID, ticket ID, event type, delivery status, dedupe key, and diagnostic booleans.
5. Re-run the payload audit and attach the before/after counts to the incident note.

## Rollback Thresholds

Keep workflows in mock mode or pause live send expansion when any of these remain true after deployment:

- Real workflow duplicate groups are non-zero.
- Provider/schema failures are non-zero after the provider payload fix is deployed.
- Template fallback or guard hard-block count is non-zero without an understood ticket-specific cause.
- Payload minimization failures are non-zero for new rows.
- Possible broader-issue rate is above the configured health threshold and samples are not explainable.
- Manual review finds unsupported timing promises in requester-facing copy.
