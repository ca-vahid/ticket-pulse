# Notification Workflow Mock-Mode Audit - 2026-06-01

Audit window: June 1, 2026 00:00-24:00 America/Vancouver (`2026-06-01T07:00:00Z` to `2026-06-02T07:00:00Z`)

Scope: production Ticket Pulse notification workflow runs, mock-mode output, LLM/context behavior, tool behavior, delivery suppression, and robustness gaps.

## Executive Summary

The mock-mode workflow system mostly behaved correctly as a safety harness:

- Production workflow sends were suppressed. The workflow send node created `mocked` deliveries for mock runs and did not call the outbound provider for those deliveries.
- The active assignment workflow completed reliably: 70 mock assignment deliveries, 74 OpenAI LLM attempts, zero provider failures, zero run failures, zero failed workflow steps.
- The after-hours ticket-created workflow correctly skipped noisy monitor/vendor tickets: 16 mock runs stopped on `Noise ticket skipped` with no LLM calls and no deliveries.
- LLM generation was stable from an infrastructure perspective: all 74 workflow-generation provider attempts succeeded on OpenAI `gpt-5.5`; no fallback attempts, no schema repairs, no token-limit hits.

The largest gaps are not basic execution failures. They are correctness, audit visibility, and launch-readiness issues:

- The workspace policy is still `context_only`, so production mock runs did not exercise read-only LLM tool calls at all.
- Five ticket/event groups produced duplicate mock assignment notifications because the event dedupe stamp changed between assignment paths or repeat assignment runs.
- Two LLM generations silently degraded to template fallback because the output guard rejected legitimate "Claude" product wording as provider/internal wording.
- The broader-issue signal is too permissive: 64 of 74 LLM generations were tagged `possible_broader_issue`.
- Stored audit payloads are bloated and contain unnecessary personal/contact/avatar data for skipped after-hours actions.
- The generated copy is too playful and too willing to make response-time claims for requester-facing mail.

## Production Evidence

### Active Configuration

- Workspace `IT` had two enabled workflows in mock mode:
  - `ticket_assigned`, trigger `ticket.assigned`, published version 1.
  - `ticket_created_after_hours`, trigger `ticket.created`, published version 1.
- Standard `ticket_created`, `ticket_reassigned`, and `ticket_resolved_closed` were not enabled.
- After-hours policy was enabled and configured to suppress the standard ticket-created workflow.
- LLM tool policy was `context_only`, not `tools_enabled`.
- Enabled tool catalog entries existed, but the mode prevented model-driven tool calls.

### Run Volume

| Workflow | Mode | Event | Source | Count | Result |
| --- | --- | --- | --- | ---: | --- |
| `ticket_assigned` | mock | `ticket.assigned` | `assignment_pipeline` | 51 | completed |
| `ticket_assigned` | mock | `ticket.assigned` | `assignment_fast_sync` | 16 | completed |
| `ticket_assigned` | mock | `ticket.assigned` | `freshservice_webhook` | 3 | completed |
| `ticket_assigned` | preview | `ticket.assigned` | `preview` | 1 | completed |
| `ticket_created_after_hours` | mock | `ticket.created` | `freshservice_webhook` | 14 | completed |
| `ticket_created_after_hours` | mock | `ticket.created` | `freshservice_sync` | 1 | completed |
| `ticket_created_after_hours` | mock | `ticket.created` | `assignment_fast_sync` | 1 | completed |
| `ticket_created_after_hours` | preview | `ticket.created` | `preview` | 3 | completed |

Totals:

- 90 workflow runs.
- 86 mock runs.
- 4 preview runs.
- 0 failed runs.
- 0 failed workflow steps.
- 0 failed AI provider attempts.

### Deliveries

- 70 `ticket.assigned` deliveries were recorded with status `mocked`.
- 0 live workflow deliveries were sent from mock execution.
- 4 `notification_workflow_test_email` deliveries were actually sent. These were explicit test emails tied to audit/preview, not normal workflow sends.
- No forbidden outage wording was found in mocked assignment email bodies.

### LLM and Context

- 74 `llm_generate` steps completed.
- 74 AI provider attempts succeeded.
- Provider/model: OpenAI `gpt-5.5`.
- Fallback attempts: 0.
- Tool-mode runs: 0.
- LLM tool step rows: 0.
- Input tokens: 354,080 total.
- Output tokens: 33,763 total.
- Median LLM duration: about 8.0 seconds.
- P95 LLM duration: about 11.4 seconds.
- Output token average: about 444.
- Token limit hits: 0.
- Schema repairs: 0.

Context signal distribution:

- `possible_broader_issue`: 64 of 74.
- `watch`: 8 of 74.
- `none`: 2 of 74.
- `null`/failed LLM output: 2 of 74.

## What Worked

1. Mock mode suppressed real workflow sends.

   Code path: `executeWorkflow()` sets `dryRun: true`, `executionMode: "mock"`, and `executeLlm: true` when `workflow.mockModeEnabled` is true. The send node creates a delivery with status `mocked` and returns before calling `processDelivery()`.

2. Run, step, delivery, and provider audit rows are linked.

   The run table links workflow, ticket, event context, dry-run flag, execution mode, and dedupe key. Step rows are recorded for each graph node. Provider attempts link back through `notificationWorkflowRunId`.

3. Noise suppression worked.

   The after-hours created workflow ran for noisy monitor/vendor/payment/license tickets and stopped after `skip-noise`, with no LLM call and no delivery. This is the right behavior.

4. Provider routing was stable.

   All production mock LLM calls succeeded through the provider gateway, and the focused backend tests passed:

   - `notificationWorkflowEnginePersistence.test.js`
   - `notificationWorkflowLlmPipelineService.test.js`
   - `notificationContextEnrichmentService.test.js`
   - `openAiProvider.test.js`
   - `providerGateway.test.js`

   Result: 5 suites passed, 32 tests passed.

5. Output guard blocked high-risk classes.

   The guard prevented provider/internal terms and forbidden outage language from LLM-generated output. There were no mocked assignment emails with `global outage`, `company-wide outage`, or `confirmed outage`.

## Findings and Improvements

### P0 - Before Live Workflow Sends

- [ ] Add cross-source notification dedupe.

  Evidence: five ticket/event groups produced duplicate mock assignment notifications. One ticket produced three assignment workflow runs. Causes included repeated `assignment_pipeline` executions and near-identical timestamps from `assignment_pipeline`, `assignment_fast_sync`, and `freshservice_webhook`.

  Current dedupe keys include the event dedupe stamp. If that stamp changes by seconds or minutes, the same ticket/assignment can generate another notification. Add a canonical lifecycle notification key such as `workflowId + workflowVersion + eventType + ticketId + assignedTechId + firstAssignedAt/activityId`, with timestamp rounding only as a fallback. Add a second delivery-level uniqueness guard for assignment notifications per ticket/current assignee/workflow.

- [ ] Make LLM failure visible even when the run completes.

  Evidence: run IDs 63 and 67 completed and created mocked deliveries, but their LLM node output had `failed: true` and error `Requester-facing email cannot mention model/provider/audit internals.` Provider attempts were still `succeeded`, and the workflow fell back to template copy.

  Add run-level warning metadata or a derived `completed_with_warnings` state when any step output includes `failed: true`. Surface this in mock audit health, run list badges, and export data. Track fallback template usage separately from normal LLM success.

- [ ] Fix the output guard false positive for legitimate product names.

  Evidence: tickets about "Claude account" and "Claude AI Desktop Version" triggered the internal-provider guard because `Claude` is also a provider/model name. In these cases the word was the actual requested software, not an internal model leak.

  Make the guard context-aware: allow provider-like words when they appear in ticket subject/description/category as the user-facing product, but still block phrases like `Claude model`, `Anthropic provider`, `GPT fallback`, `audit id`, or `TP-NWF`. Add tests for both cases.

- [ ] Stop persisting embedded avatars/contact data in send-step output and delivery payloads.

  Evidence: 70 delivery payloads contained `data:image` and `activeContact`; p50 delivery payload size was about 10.7 KB. Send-step output p50 was about 75 KB because skipped after-hours diagnostics still included a full active-contact object with photo data.

  Persist only compact diagnostics: `applied`, `skipped`, `reason`, `hasActiveContact`, `phoneVerified`, and maybe `rotationLabel`. Do not persist `photoUrl`, phone, email, or base64 image in workflow step output or delivery payload unless the after-hours block was actually rendered and the field is explicitly needed.

### P1 - Quality and Robustness

- [ ] Exercise actual LLM tools in mock mode before live launch.

  Evidence: the policy was `context_only`; tool-mode count was 0 and no `llm_tool` step rows were created. The tool code has tests, but production mock runs did not validate tool selection, tool result replay, tool budgets, timeout behavior, or final `submit_notification_email` flow.

  Run a staged canary with `tools_enabled` on one workflow or a sampled subset. Require audit rows for `get_notification_context`, at least one related-ticket/thread tool where appropriate, and `submit_notification_email`. Keep the default policy conservative until the canary passes.

- [ ] Tighten broader-issue detection.

  Evidence: 64 of 74 LLM generations were tagged `possible_broader_issue`. That is too high for an outage/broader-impact signal. The code exposes `distinctRequesterThreshold`, but the signal logic currently does not use it.

  Require stronger evidence: distinct requesters, tighter category/subcategory match, relevant keyword overlap, open/unresolved status, and exclusion rules for routine onboarding/procurement/hardware batches. Consider separate labels for `routine_cluster` vs `possible_broader_issue` so the LLM does not over-infer outage-like impact.

- [ ] Replace generic response-time claims with deterministic metrics.

  Evidence: 61 of 70 mocked assignment emails mentioned `business day`; 65 used `typically`. These claims were often plausible, but not clearly tied to measured service data or a configured SLA.

  Provide a deterministic ETA block from historical category/subcategory stats or the public status estimator. If no reliable data exists, use neutral language like `The assigned agent will review this and follow up with next steps` rather than invented timing.

- [ ] Rework the LLM tone policy.

  Evidence: at least 8 mocked assignment emails used overly playful copy, including field-jargon jokes, emoji, and metaphors. The current prompt explicitly asks for `light hearted and fun casual` and field jargon.

  Make professional and concise the default. Add an optional tone setting, but block humor/emoji for security, identity/access, new hire setup, executive support, hardware failure, and any high/urgent priority. Add a copy-quality guard for emoji and "joke" patterns.

- [ ] Redact and normalize prompt variables, not only the context bundle.

  Evidence: the failed LLM step prompt included raw requester email, raw ticket description, and a long legal/privacy footer. Context enrichment redacts structured evidence, but Liquid-injected prompt variables can still carry raw data.

  Build LLM prompts from the redacted context bundle by default. If custom Liquid variables are allowed, expose redacted variables and strip common email disclaimers/footers before sending to the model and before persisting prompts.

- [ ] Separate test-email telemetry from workflow-send telemetry.

  Evidence: 4 deliveries had status `sent` during the mock audit window, but all were `notification_workflow_test_email`. That is expected, but it makes simple "sent vs mocked" counts misleading.

  Use a distinct delivery status such as `test_sent`, a separate `execution_mode: test`, or an explicit `isTestEmail` field. Health cards should count workflow sends and manual test sends separately.

### P2 - Observability and Design Polish

- [ ] Add mock-audit health metrics.

  Add health cards for duplicate ticket/event groups, LLM failed-but-fell-back count, tool-mode count, output guard rejects by reason, broader-issue distribution, payload size p95, and test-email count.

- [ ] Add launch gates for enabling live workflow sends.

  Recommended gates:

  - No duplicate ticket/event groups over at least one business day.
  - No LLM guard false positives on legitimate product names.
  - Tool-mode canary passes with persisted `llm_tool` steps.
  - Broader-issue rate is explainable and below an agreed threshold.
  - No persisted base64/avatar data in workflow audit payloads.
  - Copy review passes for tone, SLA claims, and action-link text.

- [ ] Persist compact run snapshots for audit review.

  The current tables have enough data, but audit review requires joining runs, steps, deliveries, and provider attempts. Add a derived run snapshot or materialized view for mock audit that contains status, warnings, provider/model, token usage, tool calls, action-link diagnostics, delivery outcome, and short sanitized email snippets.

- [ ] Add tests for the observed first-day edge cases.

  Add regression tests for:

  - Legitimate `Claude`/`GPT` software ticket wording does not trip provider-internal guard.
  - Provider/internal mentions still fail when they are not present in ticket context.
  - LLM node `failed: true` marks the run/audit as warning.
  - Duplicate assignment events from pipeline and webhook dedupe to one notification.
  - Skipped after-hours action diagnostics omit active-contact photo/base64.
  - Similar-ticket signal uses `distinctRequesterThreshold`.

## Suggested Next Sequence

1. Fix P0 dedupe, guard false positives, LLM-warning visibility, and payload sanitization.
2. Run another one-day mock audit with the same queries.
3. Enable a limited `tools_enabled` canary in mock mode and verify tool rows plus final email submission.
4. Tune broader-issue thresholds and tone/SLA policy from reviewed samples.
5. Only then consider live sends for one low-risk workflow, with test-email telemetry separated.
