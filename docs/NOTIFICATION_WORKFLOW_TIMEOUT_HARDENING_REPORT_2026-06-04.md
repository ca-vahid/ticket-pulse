# Notification Workflow Timeout Hardening Report - 2026-06-04

## Summary

TP-NWF-259 was reported as appearing to run for a long time in the Workflow Audit UI. Production database review showed the run was not stuck: it completed successfully in about 10 seconds. The long-running appearance came from the audit UI holding a stale snapshot of a run that had briefly been `running` when the browser loaded it.

The system has now been tightened in three places:

- Active workflow execution has a hard 2 minute timeout.
- Stale persisted `running` or `queued` workflow runs older than 15 minutes are automatically marked failed by a watchdog.
- The Workflow Audit UI auto-refreshes while visible runs, steps, or deliveries are active.

## Initial Issue

The operator reported that audit run `TP-NWF-259` had been running for a while.

`TP-NWF-259` maps directly to `notification_workflow_runs.id = 259`.

Production inspection showed:

- Run ID: `259`
- Audit ID: `TP-NWF-259`
- Workflow: `Ticket assigned`
- Event type: `ticket.assigned`
- Trigger source: `assignment_pipeline`
- Execution mode: `mock`
- Ticket: Freshservice `225483`
- Run status: `completed`
- Started: `2026-06-04 17:10:16 UTC`
- Completed: `2026-06-04 17:10:26 UTC`
- Duration: `10.05s`
- Delivery: mocked delivery row `290`
- LLM provider attempt: OpenAI `gpt-5.5`, succeeded in about `9.62s`

No stale production runs were found at the time of review:

- Current `running` or `queued` notification workflow runs: `0`
- Recent two-hour status count: all recent notification workflow runs were `completed` mock runs.

## What Happened

The backend completed TP-NWF-259 normally. The LLM step was the slowest part, which is expected for a generated email workflow. It completed in under 10 seconds and then the send step created a mocked delivery instead of sending email because the workflow was in mock mode.

The confusing part was the UI. The Workflow Audit panel loaded run data when the tab opened or when filters/page changed. It also had a manual Refresh button. It did not automatically poll while a run was active. If the browser loaded TP-NWF-259 during its short `running` window, that old state could remain visible until the user manually refreshed.

## Design Gap

The workflow system had strong limits inside the tool-enabled LLM path:

- Default total tool-mode timeout: `20s`
- Maximum configurable tool-mode timeout: `60s`
- Default per-tool timeout: `3s`
- Maximum configurable per-tool timeout: `15s`
- Max turns and max tool calls are also enforced.

However, the broader workflow engine did not have a hard outer timeout. The direct JSON LLM path also depended on provider behavior rather than an explicit workflow deadline. That meant a rare hung provider call, stuck send operation, process crash, or missed final DB update could leave audit rows looking active indefinitely.

## Hardening Implemented

### 1. Hard Active-Run Timeout

Every notification workflow execution now gets an outer 2 minute deadline.

When the deadline is reached:

- The workflow abort signal fires.
- Provider calls receive the abort signal.
- The currently executing step is marked `failed`.
- The workflow run is marked `failed`.
- Any linked provider attempt still marked `running` is marked `failed`.
- The run and step error text includes an execution-timeout message.
- Mock/preview execution returns a failed audit result instead of appearing to run forever.

This timeout is intentionally much lower than 10-15 minutes because notification workflows are user-facing operational mail flows, not long backfill jobs.

### 2. Stale-Run Watchdog

A watchdog now reconciles persisted active rows that outlive the process that started them.

Rules:

- Looks for `notification_workflow_runs` with status `running` or `queued`.
- Marks rows older than 15 minutes as `failed`.
- Marks active step rows for those runs as `failed`.
- Marks linked active AI provider attempts as `failed`.
- Writes a clear `notification_workflow_stale_timeout` error message.
- Runs once on app startup.
- Continues running every 5 minutes while the backend process is up.
- Stops during graceful shutdown.

This covers process restarts, crashes, interrupted deployments, or any future edge case where the normal completion update is missed.

### 3. Workflow Audit Auto-Refresh

The Workflow Audit UI now detects active visible rows:

- Run status is `running` or `queued`.
- Any step status is `running` or `queued`.
- Any delivery status is `running` or `queued`.

While active rows are visible, the panel refreshes every 5 seconds. Once all visible rows settle, polling stops.

This prevents the stale-snapshot behavior that made TP-NWF-259 look stuck.

## Files Changed

- `backend/src/services/notificationWorkflowRunTimeouts.js`
  - Shared timeout constants and display helpers.
- `backend/src/services/notificationWorkflowEngine.js`
  - Adds the 2 minute workflow execution timeout and abort propagation.
- `backend/src/services/notificationWorkflowRunWatchdogService.js`
  - Adds startup and periodic stale-run cleanup.
- `backend/src/app.js`
  - Starts and stops the watchdog service.
- `backend/tests/notificationWorkflowEnginePersistence.test.js`
  - Adds coverage for hard workflow timeout behavior.
- `frontend/src/components/settings/NotificationWorkflowsPanel.jsx`
  - Adds active-run detection and auto-refresh polling for Workflow Audit.

## Expected Operator Behavior After This Change

If a normal run is in progress:

- The audit row may show `running` briefly.
- The UI refreshes automatically every 5 seconds while it remains active.
- The run should settle to `completed` or `failed` without manual refresh.

If a workflow execution hangs:

- It fails after 2 minutes.
- The audit detail shows the timeout error on the run and active step.
- It does not remain indefinitely active.

If a backend restart leaves an active row behind:

- Startup reconciliation marks it failed if it is older than 15 minutes.
- The recurring watchdog catches it within the next 5 minute cleanup cycle.

## QA Focus

- Run a mock notification workflow and watch the Workflow Audit tab without pressing Refresh.
- Confirm an active row refreshes and settles automatically.
- Confirm completed rows stop triggering auto-refresh.
- Confirm normal successful runs still show LLM provider, delivery, and rendered email details.
- Confirm a forced test timeout marks the LLM step and run as failed with a timeout message.
- Confirm production health remains healthy after deploy.

## Conclusion

TP-NWF-259 itself was healthy and completed in 10 seconds. The issue was observability and failure containment: the audit UI could show stale active state, and the workflow engine did not have a single outer timeout around the entire run. The system now has both: active runs refresh in the UI, normal executions have a 2 minute cap, and orphaned active rows are cleaned up after 15 minutes.
