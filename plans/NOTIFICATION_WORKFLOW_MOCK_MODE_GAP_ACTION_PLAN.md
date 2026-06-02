# Notification Workflow Mock-Mode Gap Action Plan

Created: 2026-06-01

Source audit: `plans/NOTIFICATION_WORKFLOW_MOCK_MODE_AUDIT_2026-06-01.md`

Goal: close the mock-mode gaps that block safe live workflow sends for Ticket Pulse notification workflows.

## Completion Rules

- A parent step is done only when every `[ ]` substep beneath it is complete.
- Keep changes scoped to the notification workflow, lifecycle notification, LLM context, and audit surfaces unless a shared helper is clearly required.
- Each implementation step must include a focused test or production mock-audit verification query before being marked done.

## Step 1 - Prevent Duplicate Notifications Across Sources

- [x] Reproduce the duplicate cases in tests using the production shapes from the audit:
  - Same ticket and assignee emitted by `assignment_pipeline` and `freshservice_webhook` with timestamps one second apart.
  - Same ticket and assignee emitted by repeated `assignment_pipeline` runs with different `dedupeStamp` values.
  - Same ticket and assignee emitted by `assignment_fast_sync` after assignment pipeline completion.
- [x] Add a canonical lifecycle notification fingerprint in `backend/src/services/ticketLifecycleNotificationService.js`.
  - For `ticket.assigned`, include `workspaceId`, `eventType`, `ticketId`, `assignedTechId`, and stable assignment evidence such as `firstAssignedAt`, assignment episode id, or FreshService activity id when available.
  - For `ticket.reassigned`, include old assignee and new assignee when available.
  - For `ticket.created` and `ticket.resolved_closed`, keep event-specific stable timestamps but avoid ingest-source timestamps as the primary identity.
- [x] Update workflow dedupe in `backend/src/services/notificationWorkflowEngine.js` to prefer the canonical lifecycle fingerprint when present.
- [x] Add a delivery-level guard for requester-facing workflow notifications.
  - For assignment notifications, prevent more than one workflow delivery for the same ticket, workflow version, event type, and current assignee unless the assignee changes.
  - Preserve explicit preview and test-email behavior.
- [x] Update mock-audit queries or route output to expose duplicate ticket/event groups as a health warning.
- [x] Validate locally with focused backend tests.
- [ ] Validate against the next production mock window: duplicate ticket/event groups should be zero.

Done when:

- [x] Duplicate production shapes are covered by tests.
- [x] Mock mode records at most one assignment notification per stable assignment.
- [x] Preview and manual test emails still work.

## Step 2 - Fix Legitimate Product Names Blocked By The LLM Output Guard

- [x] Add regression tests in `backend/tests` for output guard behavior:
  - `Claude account` and `Claude AI Desktop Version` are allowed when `Claude` appears in ticket evidence.
  - `OpenAI provider`, `Claude model`, `GPT fallback`, `Anthropic provider`, `audit id`, and `TP-NWF` are still blocked when they are not legitimate ticket content.
- [x] Change `backend/src/services/notificationWorkflowOutputGuard.js` from broad word blocking to context-aware internal-leak detection.
  - Build allowed product terms from ticket subject, description, category, and thread evidence.
  - Permit model/provider-like words only when they appear as user-facing ticket content.
  - Keep strict blocks for provider plumbing phrases and audit identifiers.
- [x] Pass context evidence into the guard consistently from both JSON-mode and tool-mode LLM paths.
- [x] Add warning metadata when an LLM output is rejected and template fallback is used.
  - Persist enough information to show `llm_failed`, `guard_rejected`, and `template_fallback_used`.
  - Avoid storing raw rejected model output if it may contain blocked internals.
- [x] Surface the warning in mock audit UI/API so completed runs with rejected LLM output are not visually indistinguishable from clean runs.
- [x] Validate with the two observed production tickets or equivalent preview fixtures.

Done when:

- [x] Legitimate product names no longer force template fallback.
- [x] Internal provider/audit leaks are still blocked.
- [x] LLM fallback is visible as a warning in audit data.

## Step 3 - Tighten Broader-Issue Detection

- [x] Add fixtures for signal classification in `backend/tests/notificationContextEnrichmentService.test.js`.
  - True broader issue: multiple open similar tickets, distinct requesters, distinct departments, tight category/keyword match.
  - Watch only: several related tickets without enough requester/department diversity.
  - Routine cluster: new-hire hardware, procurement, scheduled monitor reports, or vendor/payment noise.
  - None: isolated ticket with weak similarity.
- [x] Update `outageSignals()` in `backend/src/services/notificationContextEnrichmentService.js`.
  - Use `distinctRequesterThreshold`; it is configured but currently not part of the `possible_broader_issue` decision.
  - Require meaningful category/subcategory or keyword overlap.
  - Prefer open/unresolved similar tickets over all historical matches.
  - Exclude known routine cluster categories from outage-style phrasing.
- [x] Add a new non-outage signal level if useful, such as `routine_cluster` or `related_activity`, so the LLM receives accurate context without implying outage impact.
- [x] Update allowed public phrases.
  - `possible_broader_issue`: allow conservative broader-impact wording.
  - `watch`: allow only `we are reviewing similar reports`.
  - `routine_cluster`: do not allow outage-like wording.
- [x] Update UI/audit labels so signal levels are understandable to admins.
- [ ] Re-run the production mock-audit query after the next mock window.

Done when:

- [ ] `possible_broader_issue` is rare and explainable.
- [x] Routine onboarding/procurement/monitor clusters do not unlock outage-like copy.
- [x] Tests cover all signal levels.

## Step 4 - Sanitize Audit Payloads And Step Outputs

- [x] Add tests for persisted send-step output and delivery payloads.
  - Skipped after-hours action diagnostics must not include `photoUrl`, base64 data, direct phone number, or personal email.
  - Applied after-hours action diagnostics should include only the minimum requester-visible fields needed for replay.
  - Delivery payloads must not contain `data:image`.
- [x] Add a compact action-link diagnostics helper in `backend/src/services/notificationWorkflowEngine.js`.
  - Keep `requested`, `applied`, `skipped`, `reason`, `forced`, `liveWouldSkipReason`, `hasActiveContact`, `phoneVerified`, and `rotationLabel`.
  - Drop `photoUrl`, full `activeContact`, direct email, and base64 data.
- [x] Use compact diagnostics in:
  - Step output for `send_email`.
  - `notification_deliveries.payload.actionLinks`.
  - Mock audit replay output.
- [x] Keep rendered email bodies unchanged unless the actual requester-facing block needs the contact phone.
- [x] Add a migration or cleanup script only if old bloated rows materially affect audit performance.
- [ ] Re-run payload-size query after implementation.

Done when:

- [x] New delivery payloads contain no `data:image`.
- [x] New send-step outputs are compact.
- [x] Audit UI still shows useful action-link diagnostics.

## Step 5 - Make Requester Copy Professional And Evidence-Based

- [x] Add tests for LLM prompt defaults and output guard policy.
  - No emoji in requester-facing workflow emails unless explicitly allowed.
  - No playful metaphors for security, identity/access, high/urgent priority, onboarding, hardware failure, or executive-support tickets.
  - No response-time or resolution-time promise without deterministic SLA or historical metric evidence.
- [x] Update default LLM system prompt in `backend/src/services/notificationWorkflowEngine.js`.
  - Default to concise, professional, helpful IT helpdesk copy.
  - Treat humor and field jargon as opt-in and low-risk only.
  - Tell the model not to invent response or resolution estimates.
- [x] Update workflow editor defaults in `frontend/src/components/settings/NotificationWorkflowsPanel.jsx`.
  - Remove `light hearted and fun casual` from the default prompt.
  - Replace it with configurable tone guidance and clear risk boundaries.
- [x] Add deterministic timing evidence before allowing timing language.
  - Since we have no SLA yet, use category/subcategory historical stats only when sample size is sufficient, otherwise, use neutral follow-up language.
- [x] Extend `guardNotificationEmailPayload()` to reject unsupported timing claims.
  - Flag phrases like `within 1 business day`, `typically`, `often resolved`, and similar claims unless timing evidence is present.
- [ ] Re-run sample mock emails and manually review at least 20 outputs across priority/category types.

Done when:

- [ ] Mock outputs are professional by default.
- [x] Timing claims are tied to deterministic evidence or removed.
- [x] Copy guard catches unsupported playful or SLA-like language.

## Step 6 - Re-Audit Before Live Sends

- [x] Run focused backend tests:
  - `notificationWorkflowEnginePersistence.test.js`
  - `notificationWorkflowLlmPipelineService.test.js`
  - `notificationContextEnrichmentService.test.js`
  - `notificationWorkflowOutputGuard` tests after they are added.
  - Lifecycle notification dedupe tests after they are added.
- [ ] Run a one-business-day production mock audit after the fixes deploy.
- [ ] Confirm launch gates:
  - Duplicate ticket/event groups: zero.
  - LLM rejected-but-fallback runs: zero unexpected, all visible when present.
  - `possible_broader_issue` rate: low and explainable.
  - New payloads: no base64 images or full contact objects.
  - Copy review: no unsupported timing promises or inappropriate playful tone.
- [x] Decide whether to enable `tools_enabled` canary before live sends.
  - If yes, run a sampled canary and verify `llm_tool` step rows, tool budgets, and `submit_notification_email`.
  - If no, document why context-only is sufficient for the first live workflow.
- [x] Create a short go/no-go note linked to this plan and the new audit results.

Done when:

- [ ] All launch gates pass.
- [x] The go/no-go note is written.
- [x] Live-send scope is explicitly chosen.
