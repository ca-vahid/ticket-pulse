# Notification Workflow Day 3 Hardening Plan

Created: 2026-06-03 local time

Source audit: production notification workflow mock-mode data from `2026-06-01T00:00:00Z` through `2026-06-04T03:44:08Z`.

Phase 0 baseline artifact: `scratchpad/notification-workflow-day3-baseline-2026-06-03.json`

Goal: close the remaining live-send blockers while keeping requester-facing copy warm, relaxed, and company-appropriate. Guardrails should protect facts, privacy, internal implementation details, and unsupported promises. They should not block harmless personality, emojis, or playful wording when the workflow allows that tone.

## Completion Rules

- [ ] A phase is done only when every `[ ]` substep beneath it is complete.
- [ ] Every backend behavior change has a focused automated test before the phase is marked done.
- [ ] Every audit or UI behavior change is verified against real or representative workflow run data.
- [ ] No live-send expansion happens until the go/no-go phase has passing production mock evidence.
- [ ] Preview and manual test-email behavior stays separate from live/mock duplicate-risk gates.

## Phase 0 - Baseline The Current State

- [x] Export and save the current production workflow audit summary.
  - [x] Capture run totals, trigger sources, workflow keys, execution modes, delivery statuses, LLM outcomes, tool outcomes, provider attempts, fallback counts, and duplicate groups.
  - [x] Capture current enabled workflows, published versions, LLM node settings, and guardrail policy settings.
  - [x] Capture current audit payload risk counts for `activeContact`, base64 image data, avatar/photo fields, and email-like data.
  - [x] Capture current copy-scan counts separately for hard risks, unsupported timing claims, and relaxed/playful style.
- [x] Update `backend/scripts/audit-notification-workflow-mock-window.mjs` or add a day-3 audit script.
  - [x] Report workflow-level status and degraded status separately.
  - [x] Report duplicate groups excluding preview and manual test email rows.
  - [x] Report LLM fallback cause buckets: provider/schema, guard rejection, citation repair, timing repair, template fallback, and tool failure.
  - [x] Report broader-issue signal rates with sample run IDs.
  - [x] Report payload minimization failures by class, not by raw sensitive value.
  - [x] Report copy policy findings by severity: hard block, auto-repair, audit-only.
- [x] Store the baseline artifact under `scratchpad/` and link it from this plan.

Done when:

- [x] The starting point is reproducible from one command.
- [x] The report distinguishes real live/mock risks from expected preview/test activity.

## Phase 1 - Add Degraded Run Status And Fallback Visibility

- [x] Define run health states for notification workflow audit.
  - [x] `completed_clean`: all required steps succeeded without repair or fallback.
  - [x] `completed_with_repair`: output was repaired but no template fallback was needed.
  - [x] `completed_with_fallback`: template fallback was used.
  - [x] `completed_with_warning`: non-blocking audit-only policy warnings were recorded.
  - [x] `failed`: workflow failed before delivery or required terminal step.
- [x] Implement backend run-health classification.
  - [x] Derive health from step outputs, provider attempts, guard policy output, and delivery rows.
  - [x] Preserve the existing workflow `status` field for execution state.
  - [x] Expose computed health in notification workflow run-list and run-detail API responses.
- [x] Persist enough fallback metadata for audit.
  - [x] Record `fallbackUsed`, `fallbackReason`, `fallbackSource`, and `fallbackTemplateId` where applicable.
  - [x] Record provider/schema error class without storing unsafe rejected model output.
  - [x] Record guard policy tier and rule IDs that caused repair or fallback.
- [x] Update Workflow Audit UI.
  - [x] Add filters for clean, repaired, fallback, warning, and failed runs.
  - [x] Add visible badges on run cards.
  - [x] Add a run-detail panel section explaining the fallback or repair cause.
  - [x] Ensure completed-with-fallback runs do not look identical to clean runs.
- [x] Add tests.
  - [x] Unit test run-health classification for clean, repaired, fallback, provider/schema failure, guard rejection, and tool failure cases.
  - [x] Route test that audit API includes computed health and fallback cause.
  - [x] Frontend test or focused smoke check for the new badges and filters.

Done when:

- [x] A completed workflow with template fallback is visibly degraded in audit.
- [x] Fallback reason is searchable and reviewable without reading raw JSON.

## Phase 2 - Finish Source-Aware Duplicate Protection

- [x] Define canonical lifecycle notification fingerprints.
  - [x] For `ticket.created`, include workspace, workflow key, event type, ticket ID, requester recipient, and stable FreshService created timestamp.
  - [x] For `ticket.assigned`, include workspace, workflow key, event type, ticket ID, current assignee, requester recipient, assignment episode ID or stable FreshService assignment activity evidence.
  - [x] For `ticket.reassigned`, include workspace, workflow key, event type, ticket ID, previous assignee, new assignee, requester recipient, and assignment episode or activity evidence.
  - [x] For `ticket.resolved_closed`, include workspace, workflow key, event type, ticket ID, requester recipient, and resolved/closed transition evidence.
- [x] Normalize event source handling.
  - [x] Treat `assignment_pipeline`, `assignment_fast_sync`, `freshservice_webhook`, and `freshservice_sync` as possible sources for the same lifecycle event.
  - [x] Do not use source timestamps or `dedupeStamp` as the primary identity for requester-facing sends.
  - [x] Keep preview and manual test emails out of live/mock duplicate blocking.
- [x] Add delivery-level idempotency.
  - [x] Check for an existing matching workflow delivery before queueing or sending.
  - [x] Handle unique-key conflicts as a skipped duplicate, not as an error.
  - [x] Persist duplicate-suppression metadata in run and step output.
- [x] Add duplicate health reporting.
  - [x] Show suppressed duplicate count by source and event type.
  - [x] Show unsuppressed duplicate groups as a launch-gate failure.
- [x] Add tests using production-shaped cases.
  - [x] Same assignment from assignment pipeline and webhook.
  - [x] Same assignment from repeated assignment pipeline runs.
  - [x] Same assignment from fast sync after pipeline completion.
  - [x] Same ticket reassigned to a different agent should still notify.
  - [x] Preview and test email duplicates should still be allowed.

Done when:

- [x] Production mock duplicate groups for real workflow emails are zero.
- [x] Suppressed duplicate evidence is visible in audit.

## Phase 3 - Redesign Guardrails As Policy Tiers

- [x] Split guardrail policy into three tiers.
  - [x] Hard block: privacy leaks, direct contact data leaks, internal provider/model/audit leaks, unsafe HTML/script content, invalid required evidence structure.
  - [x] Auto-repair: unsupported timing promises, overconfident broader-issue wording, unknown cited evidence IDs that can be stripped safely, overly specific operational claims without evidence.
  - [x] Audit-only: playful tone, emojis, branded metaphors, casual wording, harmless personality.
- [x] Update workflow policy defaults.
  - [x] Keep factual/privacy/internal-leak protection strict by default.
  - [x] Allow relaxed style by default for low-risk requester emails unless the workflow chooses a stricter tone.
  - [x] Make stricter tone available per workflow for security, executive, urgent, or sensitive workflows.
- [x] Add workflow-specific policy controls.
  - [x] Add tone modes: `friendly`, `playful`, `professional`, and `custom`.
  - [x] Add toggles for hard-block rules, auto-repair rules, and audit-only warnings.
  - [x] Add a setting to disable requester-facing guardrails only for preview/manual testing, not for live sends.
  - [x] Store policy settings with workflow version so historical audit remains explainable.
- [x] Change guard behavior.
  - [x] Do not block an entire LLM output for audit-only style findings.
  - [x] Prefer targeted repair over template fallback when only one sentence or phrase is problematic.
  - [x] Only fallback to template when hard-block or repair-failed conditions remain.
  - [x] Persist `policyTier`, `ruleId`, `actionTaken`, and `beforeAfterSummary` for audit.
- [x] Add tests.
  - [x] Playful copy passes when tone allows it.
  - [x] Emojis pass when tone allows them.
  - [x] Internal provider/model/audit leaks are blocked.
  - [x] Direct contact/avatar/base64 leaks are blocked.
  - [x] Unsupported timing claims are repaired or removed, not silently accepted.
  - [x] Manual workflow-added style guidance is respected without weakening factual/privacy rules.

Done when:

- [x] Relaxed requester copy is allowed intentionally.
- [x] Hard safety and factual protections remain enforceable.
- [x] Audit shows whether the policy blocked, repaired, or only warned.

## Phase 4 - Make Timing And Operational Claims Evidence-Based

- [x] Inventory current sources of deterministic timing evidence.
  - [x] FreshService `dueBy` and `frDueBy`.
  - [x] Any workspace SLA settings or FreshService SLA metadata available in sync data.
  - [x] Historical category/subcategory timing stats with sample-size thresholds.
  - [x] Priority-specific timing rules if they are explicit product configuration.
- [x] Define allowed timing-claim policy.
  - [x] Allow explicit SLA/due-date statements only when deterministic evidence exists.
  - [x] Allow historical phrasing only when sample size and confidence threshold pass.
  - [x] Otherwise use neutral language like "the team has the ticket and will follow up from the ticket."
- [x] Update prompt and templates.
  - [x] Remove default phrases like `estimated resolution`, `within 1 business day`, `typically`, and `by the next business day` unless evidence is injected.
  - [x] Provide safe replacement phrases to the LLM.
  - [x] Keep friendly/playful tone options independent from timing claims.
- [x] Add a repair pass for unsupported timing claims.
  - [x] Remove or rewrite only the unsupported phrase.
  - [x] Preserve the rest of the LLM-generated copy when it is otherwise acceptable.
  - [x] Record the repair in audit.
- [ ] Add tests and review.
  - [x] Unit test timing claim detection and repair.
  - [x] Test deterministic SLA evidence allows a claim.
  - [x] Test no-evidence cases are rewritten.
  - [ ] Manually review at least 20 mock outputs after deployment.

Done when:

- [ ] No requester-facing output makes response-time or resolution-time promises without evidence.
- [ ] Friendly/playful style remains available.

## Phase 5 - Tighten Broader-Issue Detection

- [x] Define stronger broader-issue criteria.
  - [x] Require multiple open or recently active similar tickets.
  - [x] Require distinct requesters, departments, or locations when available.
  - [x] Require meaningful topic/category/subcategory similarity.
  - [x] Discount routine onboarding, procurement, access requests, scheduled alerts, preview/test data, and noisy monitor patterns.
  - [x] Separate `watch`, `routine_cluster`, and `possible_broader_issue` clearly.
- [x] Update context enrichment.
  - [x] Add confidence score and rationale fields.
  - [x] Record which criteria passed and failed.
  - [x] Only allow customer-facing broader-issue wording when confidence is high enough.
  - [x] Provide conservative allowed phrases for lower-confidence `watch` signals.
- [x] Update LLM context and prompt.
  - [x] Tell the LLM not to imply an outage or widespread issue unless the context explicitly permits it.
  - [x] Include the allowed public phrase list and confidence level.
  - [x] Avoid public broader-issue phrasing for routine clusters.
- [x] Update audit UI.
  - [x] Show signal level, confidence, similar-ticket counts, distinct requester count, and why the level was chosen.
  - [x] Add filters for signal levels.
  - [x] Flag unexpectedly high `possible_broader_issue` rates.
- [x] Add tests.
  - [x] True broader issue with strong similarity and distinct requesters.
  - [x] Watch-only cluster with weak diversity.
  - [x] Routine cluster with high volume but no outage implication.
  - [x] Isolated ticket with weak similarity.

Done when:

- [ ] `possible_broader_issue` is rare, explainable, and backed by visible evidence.
- [ ] Routine clusters do not unlock outage-style requester copy.

## Phase 6 - Minimize Audit Payloads And Step Outputs

- [x] Define an allowlisted audit payload schema.
  - [x] Keep workflow ID, version, node ID, execution mode, event type, ticket ID, delivery status, link IDs, URL presence, applied/skipped reason, and render mode.
  - [x] Drop `activeContact`, direct email addresses, phone numbers, avatar/photo URLs, base64 image data, and full requester or agent objects.
  - [x] Store booleans such as `hasActiveContact` instead of the contact object.
- [x] Sanitize action-link diagnostics.
  - [x] Compact `afterHoursSupport`, `raiseUrgency`, and `publicStatus` payloads.
  - [x] Keep enough data to explain why a link rendered or skipped.
  - [x] Keep rendered email content unchanged unless the actual email block requires less data.
- [x] Add persistence guards.
  - [x] Sanitize before writing `notification_deliveries.payload`.
  - [x] Sanitize before writing send-step output.
  - [x] Sanitize before returning mock audit API payloads.
- [x] Add cleanup tooling.
  - [x] Add a dry-run script to count historical rows with active contact, base64, avatar/photo, and email-like data.
  - [x] Add an execute mode only if historical cleanup is needed for performance or privacy.
- [x] Add tests.
  - [x] Delivery payload does not contain `activeContact`.
  - [x] Delivery payload does not contain `data:image`.
  - [x] Delivery payload does not contain avatar/photo fields.
  - [x] Step output still explains applied/skipped action links.

Done when:

- [x] New workflow delivery payloads contain no active contact objects, base64 image data, avatar/photo fields, or direct contact data.
- [x] Audit remains useful without storing presentation/contact blobs.

## Phase 7 - Harden Provider And Tool Contracts, Then Test Claude

- [x] Centralize provider tool-call continuation sanitization.
  - [x] Whitelist provider API fields for tool-call replay.
  - [x] Strip SDK-only fields such as parsed/derived argument helpers before provider requests.
  - [x] Add provider-specific serializers behind one shared interface.
- [x] Add tool-mode regression tests.
  - [x] Similar-ticket tool call followed by `submit_notification_email`.
  - [x] Spike-detection tool call followed by `submit_notification_email`.
  - [x] Unknown cited evidence ID repair path.
  - [x] Provider/schema failure path records degraded health and fallback cause.
- [ ] Add Claude canary.
  - [ ] Configure a workflow preview/mock sample to run with Claude.
  - [ ] Use tickets that exercise similar-ticket tools, spike tools, timing-claim repair, relaxed tone, and evidence citations.
  - [ ] Compare OpenAI and Claude outputs for schema validity, tool-call continuation, citation behavior, fallback rate, and tone alignment.
  - [ ] Persist canary findings in an audit note.
- [x] Add provider health gates.
  - [x] Alert when provider/schema failures exceed threshold.
  - [x] Alert when tool-mode fallback rate exceeds threshold.
  - [x] Show provider/model and attempt status in workflow audit.

Done when:

- [ ] OpenAI and Claude both pass the same tool-enabled workflow contract.
- [ ] Provider-specific payload bugs cannot silently become clean-looking runs.

## Phase 8 - Improve Workflow Audit And Admin Design

- [x] Update run list.
  - [x] Add badges for clean, repaired, fallback, warning, failed, duplicate suppressed, and tool-enabled.
  - [x] Add filters for health state, workflow, event, trigger source, signal level, provider, and fallback reason.
  - [x] Keep ticket-number search working across loaded runs.
- [x] Update run detail.
  - [x] Show timeline of trigger, context, tools, LLM generation, repair/guard policy, render, send/mock delivery.
  - [x] Show evidence IDs and unknown/stripped citation metadata.
  - [x] Show broader-issue rationale and allowed public phrases.
  - [x] Show duplicate fingerprint and suppression decisions.
  - [x] Show sanitized payload summary, not raw contact/presentation blobs.
- [x] Update workflow editor.
  - [x] Add tone and policy controls in the LLM node or workflow settings.
  - [x] Explain hard-block, auto-repair, and audit-only policy categories in admin-facing labels.
  - [x] Add preview warnings when a workflow disables stricter style controls.
  - [x] Keep live-send controls explicit and workspace-scoped.
- [x] Add UX safeguards.
  - [x] Make fallback/degraded states visually prominent.
  - [x] Avoid hiding important warnings inside collapsed JSON.
  - [x] Keep preview/test email rows clearly labeled as preview/test.

Done when:

- [x] An admin can tell why a run generated, repaired, fell back, or skipped without reading database JSON.
- [x] Relaxed tone settings are understandable and workflow-specific.

## Phase 9 - Deploy, Re-Audit, And Decide Go/No-Go

- [x] Run local validation.
  - [x] Backend focused tests for workflow engine, output guard/policy, context enrichment, provider tools, delivery payloads, and routes.
  - [x] Frontend build and focused UI checks for Workflow Audit and workflow editor.
  - [x] Audit script dry run against non-production or safe production read-only connection.
- [ ] Deploy to production.
  - [ ] Push branch and confirm backend deployment completes.
  - [ ] Confirm frontend/static deployment completes if UI changed.
  - [ ] Confirm `/api/health` is healthy after deployment.
- [ ] Run one-business-day production mock audit.
  - [ ] Confirm real mock delivery volume is non-zero.
  - [ ] Confirm duplicate real workflow groups are zero.
  - [ ] Confirm provider/schema failures are zero after deployment.
  - [ ] Confirm fallback/degraded runs are visible with reasons.
  - [ ] Confirm `possible_broader_issue` rate is low and explainable.
  - [ ] Confirm new payloads contain no active contact objects, base64 images, avatar/photo fields, or direct contact data.
  - [ ] Confirm copy has no unsupported timing promises.
  - [ ] Confirm relaxed/playful style appears only where the workflow tone allows it.
- [ ] Run Claude canary or document why it is deferred.
- [ ] Write go/no-go note.
  - [ ] Link audit output.
  - [ ] List passed and failed gates.
  - [ ] Choose live-send scope if gates pass.
  - [ ] Define rollback steps and monitoring thresholds.

Done when:

- [ ] Launch gates pass with real production mock evidence.
- [ ] Live-send scope and rollback plan are documented.

## Phase 10 - Add Ongoing Monitoring

- [x] Add operational alerts or dashboard cards.
  - [x] Duplicate suppression count spike.
  - [x] Unsuppressed duplicate group detected.
  - [x] Provider/schema failure rate above threshold.
  - [x] Template fallback rate above threshold.
  - [x] Guard hard-block count above threshold.
  - [x] Payload minimization failure detected.
  - [x] Possible broader-issue rate above threshold.
- [x] Add scheduled audit report.
  - [x] Daily mock/live workflow summary.
  - [x] Top degraded reasons.
  - [x] Copy policy findings split by hard block, repair, and audit-only.
  - [x] Provider/tool health summary.
- [x] Add incident playbook.
  - [x] How to disable a workflow.
  - [x] How to force mock mode.
  - [x] How to inspect a degraded run.
  - [x] How to replay preview safely.
  - [x] How to clean or redact a bad audit payload row if needed.

Done when:

- [x] The workflow system has daily visibility after live launch.
- [x] Operators can quickly pause, inspect, and recover without code changes.

## Primary Implementation Targets

- [x] `backend/src/services/notificationWorkflowEngine.js`
- [x] `backend/src/services/notificationWorkflowOutputGuard.js`
- [x] `backend/src/services/notificationContextEnrichmentService.js`
- [x] `backend/src/services/notificationDeliveryService.js`
- [x] `backend/src/routes/notificationWorkflow.routes.js`
- [x] `backend/scripts/audit-notification-workflow-mock-window.mjs`
- [x] `frontend/src/components/settings/NotificationWorkflowsPanel.jsx`
- [x] Focused backend tests for engine persistence, output policy, context enrichment, delivery payloads, provider tool replay, and route audit output.
- [x] Focused frontend tests or browser checks for Workflow Audit and workflow editor controls.
