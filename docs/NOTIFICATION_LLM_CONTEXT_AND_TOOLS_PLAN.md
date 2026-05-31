# Notification Workflow LLM Context And Tools Plan

## Goal

Make notification workflow emails materially more accurate by adding two layers:

- Deterministic context enrichment before the LLM writes anything.
- Optional, workspace-controlled LLM tool use for cases where the model needs to inspect recent tickets, thread history, or outage-like signals before producing an email.

This is for live helpdesk communication, including after-hours and emergency-adjacent workflows. The design must fail safely, preserve mock-mode auditability, and prevent the model from making unsupported claims such as "global outage" unless a deterministic tool produced evidence for that claim.

## Research Notes

The implementation should follow these constraints from current platform and security guidance:

- Tool calling is an application-driven loop: model requests a tool, the app executes it, the app returns tool output, then the model continues. Keep Ticket Pulse in control of execution, not the model.
- Use strict function/tool schemas and server-side validation. OpenAI recommends strict function schemas for reliable arguments, and Anthropic supports strict tool use for schema conformance.
- When the model is connected to tools or app data, use function/tool calling. When the final response needs a shape, enforce a structured schema as well.
- Treat ticket bodies, email history, and tool outputs as untrusted data. Prompt injection cannot be solved by prompts alone, so tool allowlists, input validation, output validation, redaction, and authorization checks are required.
- Use guardrails at the tool boundary, not only around the overall agent. Validate every custom tool invocation before execution and validate every result before it is exposed to the model or UI.
- Retrieval should start with bounded, explainable database search. PostgreSQL full-text search and `pg_trgm` are good first steps for short ticket text and fuzzy keyword matching. Semantic/vector retrieval can be a later enhancement after we have deterministic audit coverage.

References:

- OpenAI function calling: https://developers.openai.com/api/docs/guides/function-calling
- OpenAI structured outputs: https://developers.openai.com/api/docs/guides/structured-outputs
- OpenAI retrieval and hybrid search: https://developers.openai.com/api/docs/guides/retrieval
- Anthropic tool use overview: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- Anthropic tool loop model: https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works
- OpenAI prompt injection guidance: https://openai.com/index/designing-agents-to-resist-prompt-injection/
- OpenAI guardrails guidance: https://openai.github.io/openai-agents-python/guardrails/
- OWASP Top 10 for LLM Applications: https://owasp.org/www-project-top-10-for-large-language-model-applications/
- NIST AI RMF and GenAI profile: https://www.nist.gov/itl/ai-risk-management-framework
- PostgreSQL `pg_trgm`: https://www.postgresql.org/docs/17/pgtrgm.html
- PostgreSQL full-text search: https://www.postgresql.org/docs/17/textsearch.html

## Current Repo Baseline

- `backend/src/services/notificationWorkflowEngine.js` uses `providerGateway.sendJson` for `notification_workflow_generation`; this is currently a single-shot JSON generation step.
- `backend/src/services/assignmentPipelineService.js`, daily review, and competency analysis already use `providerGateway.runToolTurn`.
- `backend/src/services/assignmentTools.js` already contains useful read-only search and history patterns, but those tools are assignment-specific and should not be directly exposed to requester email generation.
- `notification_workflow_runs`, `notification_workflow_step_runs`, `notification_deliveries`, and `ai_provider_attempts` already provide the right audit spine.
- Mock mode already creates dry-run live executions and mocked delivery rows. This is the correct rollout surface for testing generated emails over time.
- Tickets already store `toEmails`, `ccEmails`, `replyCcEmails`, `fwdEmails`, requester, assigned agent, categories, priority signals, activities, and thread entries.

## Non-Negotiable Safety Rules

- [x] V1 notification tools are read-only only. The LLM cannot send email, update FreshService, change priorities, modify workflows, or toggle settings.
- [x] The existing deterministic email node remains the only place where delivery can happen. The model may submit email content, not perform delivery.
- [x] Tool availability is server-defined and workspace-allowlisted. Admins can enable, disable, and configure known tools; they cannot create arbitrary tool code from the UI.
- [x] Every tool input is validated with Zod or equivalent schema validation before execution.
- [x] Every tool output is bounded, redacted, timestamped, and marked as untrusted evidence.
- [x] Tool loops have hard budgets: max turns, max tool calls, max wall-clock time, per-tool timeout, max output size, and max tokens.
- [x] The final email must pass strict structured validation and HTML sanitization before the template or send node can use it.
- [x] Unsupported high-impact claims are blocked or downgraded. "Global outage" requires explicit tool evidence from an outage/status source. Ticket-volume evidence alone can support wording like "we are seeing multiple similar reports."
- [x] Prompt injection content in tickets or thread entries is never allowed to alter tool policy, send policy, workflow policy, or system instructions.
- [x] Mock mode must persist the same context/tool audit that live mode would use, while still suppressing SendGrid delivery.

## Phase 1: Deterministic Context Enrichment

### Intent

Improve response quality without introducing an agent loop. The LLM still produces one structured email, but it receives a curated evidence bundle built by Ticket Pulse.

### Backend Work

- [x] Add `backend/src/services/notificationContextEnrichmentService.js`.
- [x] Add a normalized context bundle contract:
  - `bundleVersion`
  - `generatedAt`
  - `workspace`
  - `ticket`
  - `requester`
  - `assignedAgent`
  - `recipients`
  - `businessWindow`
  - `threadSummary`
  - `recentSimilarTickets`
  - `outageSignals`
  - `prioritySignals`
  - `actionLinks`
  - `redactions`
  - `evidenceLimits`
  - `contextHash`
- [x] Include base ticket facts from the current event context and DB:
  - FreshService ticket ID, internal ticket ID, subject, status, priority, assessed priority.
  - category, subcategory, ticket category, internal category/subcategory.
  - requester name/email/department/title.
  - assigned agent name/email.
  - original To/Cc/reply-Cc/forwarded email arrays.
  - created/updated timestamps in workspace-local time.
- [x] Include a compact thread summary:
  - newest public requester messages.
  - newest public agent replies if available.
  - private/internal notes excluded from requester-facing context by default.
  - configurable admin option to include private notes as internal-only evidence, never quoteable in requester email.
- [x] Include recent similar ticket candidates:
  - same workspace only.
  - default windows: 1 hour, 4 hours, 24 hours.
  - match on internal category/subcategory, FreshService category/subcategory, requester department, subject/description keywords.
  - start with PostgreSQL `ILIKE`, full-text search, and optional `pg_trgm` similarity indexes.
  - cap results per window, default 5.
  - return minimal fields: ticket ID, subject excerpt, created time, status, category, requester department, assigned agent, resolved/closed marker.
- [x] Add deterministic outage-like signals:
  - count similar tickets by time window.
  - count distinct requesters/departments.
  - count currently open similar tickets.
  - threshold settings per workspace.
  - output `signalLevel`: `none`, `watch`, `possible_broader_issue`, `confirmed_external_source`.
  - output allowed phrases. Example: `possible_broader_issue` allows "we are seeing multiple similar reports", not "global outage".
- [x] Add redaction helpers:
  - strip HTML/script from thread text.
  - cap content length.
  - redact obvious secrets, tokens, passwords, session IDs, MFA codes, and API keys.
  - mark redaction counts in the bundle.
- [x] Add `contextHash` computed from deterministic inputs so audit can compare reruns.
- [x] Update `llm_generate` node execution in `notificationWorkflowEngine.js`:
  - Build the context bundle before provider call.
  - Add it to prompt scope as `state.context.enrichment`.
  - Add it to the LLM prompt under a clearly delimited "Evidence Bundle" section.
  - Keep final output schema as `{ subject, html, text }` initially, but add optional fields in schema defaults:
    - `confidence`
    - `citedSignals`
    - `unsupportedClaimsRemoved`
  - Persist the bundle summary and hash in the `llm_generate` step output.
- [x] Add a workflow/node setting:
  - `contextEnrichmentEnabled`: default true for LLM nodes.
  - `includeThreadHistory`: default true.
  - `includeSimilarTickets`: default true.
  - `includeOutageSignals`: default true.
  - These should be workspace-defaulted later, not heavily per-workflow in V1.

### Schema And Migrations

- [x] Add `NotificationLlmToolPolicy` or similar workspace-level table even in Phase 1 so we do not hardcode future policy:
  - `workspaceId`
  - `mode`: `off`, `context_only`, `tools_enabled`
  - `enabledTools` JSON
  - `toolSettings` JSON
  - `maxTurns`
  - `maxToolCalls`
  - `totalTimeoutMs`
  - `perToolTimeoutMs`
  - `includePrivateNotes`
  - `redactionEnabled`
  - `updatedBy`
  - timestamps
- [x] Default existing workspaces to `context_only`, not `tools_enabled`.
- [ ] Add optional `NotificationWorkflowContextSnapshot` if step output size becomes too large:
  - `workspaceId`
  - `runId`
  - `stepRunId`
  - `bundleVersion`
  - `contextHash`
  - `summary`
  - `bundle`
  - `createdAt`
- [x] If not adding the snapshot table in Phase 1, persist only the summary/hash in step output and keep full bundle behind a feature flag.

### API Work

- [x] Add `GET /api/notification-workflows/llm-tools/policy`.
- [x] Add `PUT /api/notification-workflows/llm-tools/policy`.
- [x] Add `GET /api/notification-workflows/llm-tools/catalog`.
- [x] Add `POST /api/notification-workflows/llm-tools/context-preview`.
  - Input: `ticketId`, optional draft policy.
  - Output: redacted context bundle and signal summary.
- [x] Extend audit detail endpoint to include context summary/hash.

### UI Work

- [x] Add a workspace-level "LLM context and tools" settings section inside Mail Workflows.
- [x] Use a segmented control:
  - `Off`
  - `Context only`
  - `Context + tools`
- [x] Show "Context only" as the recommended default during rollout.
- [x] Show concise signal cards:
  - Thread history
  - Similar tickets
  - Outage signals
  - Recipient context
- [x] Add per-source toggles and parameters:
  - Thread history: enabled, max entries, private notes off/on with warning.
  - Similar tickets: enabled, lookback windows, max results.
  - Outage signals: enabled, thresholds, department diversity requirement.
  - Redaction: enabled and locked on by default.
- [x] Add "Preview context" drawer:
  - ticket search input.
  - redacted evidence bundle.
  - similar tickets timeline.
  - outage signal explanation.
  - exact phrases the LLM is allowed to use.
- [x] Extend Mock Audit detail drawer:
  - Evidence tab: context bundle summary.
  - Signals tab: similar-ticket and outage thresholds.
  - Email tab: rendered email.
  - Diagnostics tab: provider attempt and token data.

## Phase 2: Bounded Tool-Enabled Notification Generation

### Intent

Allow the LLM to decide which approved read-only tool to call when static context is insufficient, then force it to submit final email content through a strict final tool.

### Backend Work

- [x] Add `backend/src/services/notificationWorkflowTools.js`.
- [x] Add `backend/src/services/notificationWorkflowLlmPipelineService.js`.
- [x] Keep tool implementations separate from `assignmentTools.js`; reuse shared helper functions where possible.
- [x] Use `providerGateway.runToolTurn` instead of adding provider-specific loops to the workflow engine.
- [x] Create a final required tool:
  - `submit_notification_email`
  - strict schema:
    - `subject`
    - `html`
    - `text`
    - `confidence`: `low`, `medium`, `high`
    - `citedSignals`: array of evidence IDs from the context/tool outputs
    - `claimLevel`: `routine`, `multiple_similar_reports`, `confirmed_outage`
    - `unsupportedClaimsRemoved`: array
    - `internalDiagnostics`: short admin-only explanation
- [x] Only accept a final result from `submit_notification_email`.
- [x] If no final tool call happens, use existing safe fallback behavior:
  - template fallback if configured.
  - otherwise fail the LLM step and do not send.
- [x] Disable parallel tool calls for notification generation unless the provider abstraction can validate all calls independently.
- [x] Store tool events:
  - V1 stores each tool call as a `notification_workflow_step_runs` row with `nodeType='llm_tool'`.
  - Fields covered through step input/output: workspace/run/step, turn, tool use ID, tool name, input, output, status, duration, error, and timestamps.
  - Tool events are also summarized in the parent `llm_generate` step output.
- [x] Add run-level budget accounting:
  - max turns default 4.
  - max tool calls default 6.
  - max total runtime default 20 seconds.
  - per-tool timeout default 3 seconds.
  - max tool output default 12 KB per call.
  - max full prompt/context size default 40 KB before truncation.
- [x] Add circuit breakers:
  - provider failure falls back through provider gateway.
  - tool failure returns structured `{ error, retryable, degradedContext }` to the model.
  - too many failures stops tool loop and uses fallback path.
  - timeout stops tool loop and fails closed or uses deterministic template.
- [x] Add claim guard:
  - Parse final `claimLevel`.
  - Compare `claimLevel` to context/tool evidence.
  - Downgrade or reject unsupported claim levels.
  - Reject HTML/text containing blocked phrases unless evidence allows them.
- [x] Add output guard:
  - sanitize HTML.
  - strip internal diagnostics from requester-facing fields.
  - block quoted private notes.
  - enforce subject length and body size limits.
  - validate recipient-independent content before send node runs.

### V1 Tool Catalog

- [x] `get_notification_context`
  - Returns the deterministic context bundle or a requested subset.
  - Always enabled in tool mode.
- [x] `get_ticket_thread_summary`
  - Returns bounded, redacted thread entries for the current ticket.
  - Workspace policy controls private-note inclusion.
- [x] `find_similar_tickets`
  - Searches recent and historical tickets using deterministic filters and text similarity.
  - Inputs: keywords, category filters, windows, status, limit.
  - Hard cap results.
- [x] `detect_related_ticket_spike`
  - Runs deterministic counts across recent windows.
  - Returns signal level and allowed public phrasing.
- [x] `search_recent_tickets`
  - General read-only search constrained to workspace and time window.
  - Useful for "is this happening today?" checks.
- [ ] Future, not V1 unless already integrated:
  - `get_status_page_context`
  - `get_monitoring_incident_context`
  - `get_known_change_window`
  - `get_knowledge_base_article`

### Workspace Tool Policy

- [x] Workspace defaults:
  - `mode: context_only`
  - enabled tools in tool mode:
    - `get_notification_context`
    - `find_similar_tickets`
    - `detect_related_ticket_spike`
    - `get_ticket_thread_summary`
  - private notes disabled.
  - tool mode disabled until mock audit has enough reviewed runs.
- [x] Admins can enable/disable known tools per workspace.
- [x] Admins can configure thresholds and limits, not edit tool schema or tool prompt descriptions in V1.
- [x] Add policy versioning:
  - Store `policyVersion` on each run.
  - Store policy snapshot in audit so later changes do not rewrite history.

### API Work

- [x] Extend `GET /api/notification-workflows/llm-tools/catalog`:
  - name, label, description, risk level, default enabled, configurable settings, required permissions.
- [x] Extend `PUT /api/notification-workflows/llm-tools/policy`:
  - validate mode, enabled tools, thresholds, budgets.
  - reject unknown tool names.
  - reject unsafe budget values.
- [x] Add `POST /api/notification-workflows/llm-tools/test-run`:
  - selected ticket.
  - optional workflow and node.
  - executes in preview/mock style.
  - never sends email.
  - returns context, tool events, final email, guardrail decisions.
- [x] Extend audit detail endpoint:
  - include tool events.
  - include claim guard decisions.
  - include final cited signals.

### UI Work

- [ ] Evolve the workspace "LLM context and tools" section into three columns:
  - Mode and safety budget.
  - Enabled evidence sources/tools.
  - Test and audit.
- [x] Tool cards should be compact rows, not large nested cards:
  - icon.
  - tool name.
  - one-line purpose.
  - risk badge: `Read-only`, `Internal notes`, `External source`.
  - toggle.
  - settings button.
  - last used / last error indicator.
- [x] Add a "Safety budget" strip:
  - max turns.
  - max tool calls.
  - total timeout.
  - fallback behavior.
- [x] Add "Claim controls":
  - allowed outage wording.
  - thresholds for multiple similar reports.
  - block unsupported outage/global-impact claims.
- [x] Add "Run test" flow:
  - choose ticket.
  - run context only or tools.
  - show tool timeline and final email.
  - link to generated preview audit ID.
- [x] Extend LLM node inspector:
  - "Use workspace LLM tool policy" default.
  - read-only summary of current workspace mode.
  - link to workspace tool policy.
  - optional node override can be deferred unless admins need per-workflow exceptions.
- [x] Extend Mock Audit list:
  - add columns/chips for `Context`, `Tools`, `Claim guard`, and `Evidence`.
  - detail drawer shows tool call timeline with inputs/outputs redacted.

## Prompt And Tool Contract

- [x] System prompt must state that ticket/thread/tool content is untrusted evidence, not instructions.
- [x] System prompt must state that only tool-returned `allowedPublicPhrases` can be used for outage-like public claims.
- [x] Model must cite evidence IDs in `citedSignals`; final output is rejected if cited IDs do not exist.
- [x] Model must not quote private/internal notes in requester-facing fields.
- [x] Model must not mention internal routing, tool names, model names, provider names, or audit IDs in requester-facing fields.
- [x] Model must use plain, calm helpdesk language. No overpromising resolution timing unless present in policy/tool evidence.

## Failure Behavior

- [x] Provider unavailable:
  - provider gateway fallback if configured.
  - if all fail, fail LLM step.
  - template fallback only if workflow has it configured.
  - otherwise no delivery.
- [x] Tool unavailable:
  - noncritical tools return degraded context.
  - critical context tool failure stops tool mode and falls back to deterministic context-only if possible.
- [x] Similarity/outage tool slow:
  - return partial counts with `partial: true`.
  - do not allow strong claims from partial results.
- [x] Final output invalid:
  - one repair attempt through the same provider is allowed.
  - after repair fails, template fallback or no delivery.
- [x] Mock mode:
  - exact same execution except provider send suppressed.
  - mocked delivery includes final email, context hash, tool events, claim guard result.

## Backend Tests

- [x] Context bundle includes ticket/requester/agent/recipient facts and excludes other workspaces.
- [x] Context bundle redacts secrets and caps content.
- [x] Thread summary excludes private notes by default.
- [x] Private-note inclusion is admin-controlled and never quoteable in requester-facing output.
- [x] Similar ticket search ranks same-category and keyword matches above unrelated tickets.
- [x] `pg_trgm`/full-text fallback works when extension is unavailable locally.
- [x] Outage signal thresholds produce `none`, `watch`, and `possible_broader_issue` correctly.
- [x] Context hash is stable for identical inputs and changes when relevant evidence changes.
- [x] Tool policy rejects unknown tools and unsafe budget values.
- [x] Disabled tools cannot be called even if the model requests them.
- [x] Tool inputs are schema-validated and workspace-scoped.
- [x] Tool output is redacted and capped before being returned to the model.
- [x] Tool loop respects max turns, max tool calls, per-tool timeout, and total timeout.
- [x] Tool loop persists tool events with status, duration, input, output, and errors.
- [x] Final `submit_notification_email` is required in tool mode.
- [x] Unsupported "global outage" claim is rejected without confirmed evidence.
- [x] "Multiple similar reports" wording is allowed only when deterministic threshold evidence exists.
- [x] Mock mode records context/tool audit and mocked delivery without calling SendGrid/processDelivery.
- [x] Live mode without mock still sends only after validation succeeds.
- [x] Preview remains preview and does not create mocked delivery rows.
- [x] After-hours routing still suppresses or selects workflows before enrichment/tool mode runs.
- [x] Per-workspace tool policy does not affect other workspaces.
- [x] Provider fallback attempts remain linked to `notificationWorkflowRunId`.

## Frontend Tests

- [x] Policy panel loads workspace defaults.
- [x] Mode segmented control saves and refreshes.
- [x] Tool toggles persist.
- [x] Unsafe settings show validation errors.
- [x] Preview context drawer renders redacted bundle, similar tickets, and signal thresholds.
- [x] Test-run flow renders tool timeline and final guarded email.
- [x] LLM node inspector displays workspace policy summary.
- [x] Mock Audit list shows context/tool/claim badges.
- [x] Mock Audit detail drawer renders context, signals, tool events, provider diagnostics, recipients, and email.
- [x] Mobile and desktop layout does not overlap controls or text.

## Validation Evidence

- [x] Backend focused tests passed: `notificationLlmToolPolicyService.test.js`, `notificationContextEnrichmentService.test.js`, `notificationWorkflowLlmPipelineService.test.js`, `notificationWorkflowEnginePersistence.test.js`, and `notificationWorkflowDefinition.test.js` with 32 passing tests.
- [x] Backend lint passed: `npm run lint --prefix backend`.
- [x] Frontend lint passed with the existing warning baseline and no errors: `npm run lint --prefix frontend`.
- [x] Frontend production build passed: `npm run build --prefix frontend`.
- [x] Local browser smoke passed on `/settings#notification-workflows`: LLM context/tools panel, safety budget controls, claim controls, context preview action, and run-tool-test action render without new page errors.
- [x] Local API tool-mode smoke passed in preview mode: temporarily enabled tools for IT workspace, ran `POST /api/notification-workflows/llm-tools/test-run` for workflow `Ticket assigned` and ticket `27222`, received `status=completed`, `executionMode=preview`, `toolSteps=3`, `llmToolMode=true`, and restored policy mode to `context_only`.

## Deployment And Rollout

- [x] Ship Phase 1 with `context_only` default.
- [ ] Run existing mock mode for at least one work week before enabling `tools_enabled` in production.
- [ ] Add a workspace admin banner when tool mode is first enabled:
  - "The LLM may call read-only Ticket Pulse evidence tools. Email delivery still uses workflow send rules."
- [ ] Enable tool mode first on a single non-critical workflow in mock mode.
- [ ] Review mock audit:
  - unsupported claims.
  - missed similar-ticket patterns.
  - bad recipient/body phrasing.
  - latency and token usage.
- [ ] Only then enable live delivery for workflows that pass audit review.
- [ ] Add production smoke checks:
  - catalog endpoint exists.
  - policy endpoint exists.
  - context preview works for a known ticket.
  - mock run captures context/tool events.
  - live send path still works for non-tool workflow.

## Implementation Sequence

### Milestone A: Policy And Context Foundation

- [x] Migration for workspace LLM tool policy.
- [x] Tool catalog constants with read-only V1 tools.
- [x] Policy get/update routes.
- [x] Context enrichment service.
- [x] Context preview route.
- [x] LLM node includes context in single-shot generation.
- [x] Audit detail includes context summary/hash.
- [x] Backend tests for context and policy.

### Milestone B: UI For Workspace Context Policy

- [x] Add workspace LLM context/tools panel.
- [x] Add tool catalog rows and safety budget controls.
- [x] Add context preview drawer.
- [x] Add LLM node policy summary.
- [x] Add frontend tests and visual pass.

### Milestone C: Tool Loop Runtime

- [x] Notification tool executor with schemas.
- [x] Notification LLM pipeline service using `providerGateway.runToolTurn`.
- [x] Final `submit_notification_email` tool.
- [x] Tool event persistence.
- [x] Claim guard and output guard.
- [x] Mock/live/preview behavior integrated.
- [x] Backend tests for tool loop, guardrails, budgets, and mock mode.

### Milestone D: Audit UI And Rollout Controls

- [x] Audit detail tool timeline.
- [x] Evidence and claim guard tabs.
- [x] Test-run flow.
- [ ] Last-used/last-error tool indicators.
- [ ] Production smoke scripts/checklist.

## Open Decisions Before Build

- [ ] Should private/internal notes ever be included as internal-only evidence, or should V1 hard-block them entirely?
- [ ] Should `context_only` become default for all LLM nodes immediately, or only newly edited/published workflows?
- [ ] Should a workflow be allowed to opt out of workspace context policy?
- [ ] Should we invest in `pg_trgm` indexes first, or ship simple full-text/ILIKE search and add trigram after measuring prod query cost?
- [ ] Should confirmed outage evidence come only from future monitoring/status integrations, or can an admin manually mark a known outage in Ticket Pulse?

## Recommendation

Build Phase 1 first and ship it behind mock audit immediately. It provides the biggest accuracy improvement with the lowest risk. Then build Phase 2 as an optional workspace mode that remains read-only, bounded, and mock-first. Do not expose arbitrary admin-created tools in V1; expose a curated server-side catalog and let admins enable, disable, and configure those tools per workspace.
