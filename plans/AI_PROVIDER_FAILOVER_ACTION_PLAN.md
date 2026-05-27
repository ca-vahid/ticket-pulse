# AI Provider Failover Action Plan

## Purpose

Build Ticket Pulse so each workspace can select AI providers/models, keep Anthropic and OpenAI available, and automatically fall back to the alternate provider when the primary provider is unavailable.

This plan is based on `docs/AI_PROVIDER_FAILOVER_IMPLEMENTATION_GUIDE.md` plus a repo audit on 2026-05-27.

## Status

- [x] Code implementation completed on 2026-05-27.
- [x] Prisma schema validated with repo-local Prisma 5.
- [x] Prisma client regenerated.
- [x] Backend lint passed.
- [x] Full backend test suite passed.
- [x] Frontend test suite passed.
- [x] Frontend lint passed with existing warnings only.
- [x] Frontend production build passed.
- [ ] Production/staging rollout observation remains pending because it requires a live rollout window and at least one business day of monitoring.

## Current Code Audit

- [x] Confirm scope before implementation: failover covers assignment automation and the app's other AI-assisted operational workflows.
- [x] Migrated `backend/src/services/assignmentPipelineService.js` from direct Anthropic streaming to the provider gateway.
- [x] Migrated `backend/src/services/competencyAnalysisService.js` from direct Anthropic streaming to the provider gateway.
- [x] Migrated `backend/src/services/assignmentDailyReviewService.js` findings and meeting briefing calls to the provider gateway.
- [x] Migrated `backend/src/services/assignmentDailyReviewConsolidationService.js` to the provider gateway while preserving heartbeats and cancellation.
- [x] Migrated `backend/src/services/ticketReclassificationService.js` to provider settings and gateway calls.
- [x] Migrated `backend/src/services/calendarLeaveService.js` simple JSON classification to the provider gateway.
- [x] Reduced active use of `backend/src/services/anthropicService.js`; provider-specific SDK use now lives in provider adapters.
- [x] Migrated `backend/src/services/llmService.js` auto-response classification/generation to the provider gateway.
- [x] Replaced provider-specific model normalization with provider-agnostic `normalizeAiModel(...)`.
- [x] Preserved `LlmConfig` for auto-response prompts/templates while routing runtime calls through provider settings.
- [x] Replaced Assignment Review raw model free-text with provider/model/fallback controls.
- [x] Added provider health and fallback status in the assignment UI.

## Locked Decisions

- [x] OpenAI fallback model defaults to `gpt-5.5`.
- [x] API keys remain deployment-level secrets via App Service/Key Vault: `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`.
- [x] Provider selection is per workspace and per operation.
- [x] OpenAI fallback may disable Anthropic-only features such as Anthropic web search/extended thinking when no validated equivalent exists.
- [x] Failover retries from a safe checkpoint and never switches in the middle of an active stream/tool response.
- [x] Auto-response is included in the first implementation, with the configured fallback message retained as the final non-AI fallback.

## Phase 1 - Provider Settings And Data Model

- [x] Added `backend/src/utils/aiProviders.js`.
- [x] Added `isAnthropicModel(model)`.
- [x] Added `isOpenAiModel(model)`.
- [x] Added `providerForModel(model)`.
- [x] Added `normalizeAiModel(model, provider, fallbackModel)`.
- [x] Added supported model metadata for labels, operation support, streaming, tools, JSON, thinking, and cost notes.
- [x] Kept `backend/src/utils/anthropicModels.js` as a compatibility shim.
- [x] Added workspace-scoped `ai_provider_settings`.
- [x] Added operation values for assignment, competency, Daily Review, consolidation, reclassification, calendar leave, and auto-response.
- [x] Added unique index on `workspaceId + operation`.
- [x] Added `ai_provider_attempts` audit storage with run links, provider/model, status, fallback reason, errors, duration, tokens, and raw metadata.
- [x] Added `ai_provider_health_events` with rolling health fields and indexes.
- [x] Added provider/fallback fields to assignment pipeline, competency, Daily Review, Daily Review consolidation, and reclassification run tables.
- [x] Kept existing `llmModel` columns for compatibility/history.
- [x] Backfilled provider values from existing model names.
- [x] Generated Prisma client after schema changes.

## Phase 2 - Provider Gateway Foundation

- [x] Created shared provider gateway under `backend/src/services/aiProviders/`.
- [x] Defined provider-neutral simple JSON request contract.
- [x] Defined provider-neutral tool-turn request contract using existing callback/event conventions.
- [x] Implemented `anthropicProvider.js`.
- [x] Implemented `openAiProvider.js`.
- [x] Implemented `providerModelResolver.js`.
- [x] Implemented `providerHealthService.js`.
- [x] Implemented provider error classification.
- [x] Auto-fallback only occurs for retryable provider/config/availability failures.
- [x] Schema validation, bad requests, and prompt/tool-output bugs do not auto-fallback.
- [x] Gateway performs one fallback attempt by default.

## Phase 3 - OpenAI Tool And Message Conversion

- [x] Implemented `convertAnthropicToolsToOpenAiResponses(tools)`.
- [x] Converts `input_schema` to `parameters`.
- [x] Adds `type: "function"`.
- [x] Strips Anthropic-only fields such as `cache_control` and `eager_input_streaming`.
- [x] Rejects unsupported Anthropic server tools such as `web_search_20250305`.
- [x] Implemented `convertAnthropicMessagesToOpenAiInput(messages)`.
- [x] Converts plain text, tool use, tool results, and thinking/reasoning blocks.
- [x] Passes system prompt as top-level OpenAI `instructions`.
- [x] Implemented `buildAnthropicBlocksFromOpenAiResponse(responseOutput)`.
- [x] Preserves OpenAI function-call and callable IDs for tool-result linkage.
- [x] Uses Anthropic block shape as the canonical in-memory transcript format.
- [x] Added converter unit tests.
- [x] Added token guard in OpenAI provider before large requests.
- [x] Added OpenAI self-identification addendum for Anthropic/Claude prompt references.

## Phase 4 - Assignment Pipeline Migration

- [x] Replaced direct `new Anthropic(...)` use in `assignmentPipelineService`.
- [x] Removed Anthropic-only normalization from assignment route/repository model handling.
- [x] Load provider settings for `assignment_pipeline`.
- [x] Stamp `llmProvider`, model, attempt count, and fallback metadata on `AssignmentPipelineRun`.
- [x] Preserved existing SSE event names consumed by `LivePipelineView`.
- [x] Added optional provider SSE events: `provider_attempt_started`, `provider_fallback_started`, `provider_attempt_failed`, and `provider_health`.
- [x] Kept side effects safe by retrying only before final recommendation persistence/writeback.
- [x] Fallback retries from the original user message and same tools.
- [x] Provider failures after final persistence/writeback are recorded and not retried automatically.
- [x] Provider/fallback metadata is available through structured attempt rows and run fields.
- [x] Fallback parsing no longer assumes the model was Claude.
- [x] Added backend gateway tests for primary success, fallback success, fallback disabled, schema validation no-fallback, and fallback events.

## Phase 5 - Other Anthropic Assignment Surfaces

- [x] Migrated `competencyAnalysisService` while preserving tools, step persistence, streaming callbacks, and provider metadata.
- [x] Migrated `assignmentDailyReviewService` findings and meeting briefing generation while preserving structured validation and ticket ID sanitization.
- [x] Migrated `assignmentDailyReviewConsolidationService` while preserving thinking/reasoning support, heartbeat events, cancellation, and consolidation tool call.
- [x] Migrated `ticketReclassificationService` with operation settings, dry-run preview support, batch concurrency, per-ticket attempt rows, and no Freshservice writes.
- [x] Migrated `calendarLeaveService` while preserving cached deterministic behavior and adding provider metadata.
- [x] Reduced `anthropicService.js` to legacy compatibility; no migrated workflow depends on it.

## Phase 6 - Auto-Response Path Alignment

- [x] Auto-response classification/generation supports Anthropic fallback in this release.
- [x] Moved `llmService.js` onto the provider gateway while preserving `LlmConfig` prompts/templates.
- [x] Added operation settings for `autoresponse_classification` and `autoresponse_generation`.
- [x] Added Anthropic simple JSON support for auto-response prompts.
- [x] Kept existing fallback message behavior as the final non-AI fallback after both providers fail.
- [x] Updated `LlmAdminPanel` runtime model settings to show provider-aware model choices.

## Phase 7 - API Endpoints And Admin UI

- [x] Added `backend/src/routes/aiProvider.routes.js`.
- [x] Added `GET /api/ai-providers/settings`.
- [x] Added `PUT /api/ai-providers/settings`.
- [x] Added `GET /api/ai-providers/health`.
- [x] Added `POST /api/ai-providers/test`.
- [x] Added `GET /api/ai-providers/models`.
- [x] Mounted routes in `backend/src/routes/index.js` behind existing auth/workspace middleware.
- [x] Provider settings writes are admin-only; health/settings reads are reviewer-readable.
- [x] Test endpoint uses Anthropic Messages API and OpenAI Responses API through provider adapters.
- [x] Tool-capable operation tests include a minimal tool call.
- [x] Added `AiProviderSettingsPanel` under Assignment Review configuration.
- [x] Panel includes primary/fallback provider controls, model dropdowns, auto-fallback toggle, operation selector, health cards, test buttons, and server-side key copy.
- [x] Replaced Assignment Review `LLM Model` free-text input.
- [x] Replaced Anthropic-only config warning with provider-specific configured status.
- [x] Added frontend `aiProviderAPI` helpers.
- [x] Added 30-second provider health polling while settings panel is open.
- [x] Added provider/fallback badges and fallback banner on run detail pages.

## Phase 8 - Automatic Failover Behavior

- [x] Implemented automatic failover for new attempts when the primary provider is `down`.
- [x] Implemented automatic failover after retryable primary request failure.
- [x] Added provider dwell time before routing back to recovered primaries.
- [x] Audits fallback provider/model, source provider, reason, status, error class, duration, and tokens.
- [x] Does not change an already-running stream mid-turn.
- [x] Does not run providers in parallel.
- [x] Manual rerun-with-fallback action deferred until automatic behavior is stable.
- [x] Both-providers-down guardrails fail cleanly, preserve run state where appropriate, surface errors, and avoid tight retry loops.

## Phase 9 - Tests And Verification

- [x] Unit tested provider detection and model normalization.
- [x] Unit tested provider settings default creation and workspace scoping.
- [x] Unit tested provider resolver with healthy/degraded/down states.
- [x] Unit tested health rolling-window classification.
- [x] Unit tested error classification for provider errors, timeouts, schema validation, and redaction.
- [x] Unit tested OpenAI converter coverage.
- [x] Unit tested migrated service behavior with mocked providers where applicable.
- [x] Integration-style tested gateway fallback with mocked provider failure.
- [x] Tested auto-response provider fallback behavior and final fallback message.
- [x] Tested reclassification through mocked provider gateway with synthetic tickets.
- [x] Tested provider settings UI load/save.
- [x] Tested fallback banner/provider audit UI state.
- [x] Tested Assignment Review config replacement of free-text provider/model entry.
- [x] Ran backend targeted tests for migrated AI services.
- [x] Ran full backend test suite.
- [x] Ran frontend test suite.
- [x] Ran frontend production build.
- [x] Added `scripts/ai-provider-smoke.mjs` for safe dev/staging live smoke checks.
- [x] Documented failover drill in `docs/AI_PROVIDER_FAILOVER_RUNBOOK.md`.

## Phase 10 - Docs, Runbook, And Launch

- [x] Updated `AGENTS.md`.
- [x] Updated `docs/LLM_ADMIN_GUIDE.md`.
- [x] Added `docs/AI_PROVIDER_FAILOVER_RUNBOOK.md`.
- [x] Documented health classification.
- [x] Documented provider testing.
- [x] Documented staging provider-down drill.
- [x] Documented fallback attempt verification.
- [x] Documented recovery after both providers fail.
- [x] Documented expected cost differences.
- [x] Added Azure App Service and Key Vault notes for `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and model defaults.
- [x] Added Application Insights/logging and SQL queries for provider failures and fallback rate.
- [x] Launch control exists through workspace-scoped provider settings and `autoFallbackEnabled`.
- [ ] Enable for one live workspace first.
- [ ] Watch provider health events, assignment success rate, token usage, and error logs for at least one business day.
- [ ] Expand to other workspaces after the first workspace is stable.
- [x] Rollback path exists by disabling `autoFallbackEnabled` or selecting a single primary provider per operation.

## Acceptance Criteria

- [x] Admins can choose primary/fallback AI provider/model per workspace and operation.
- [x] Assignment pipeline supports Anthropic primary when Anthropic is healthy.
- [x] Assignment pipeline supports OpenAI primary when OpenAI is selected.
- [x] Anthropic primary retryable outage/config failure falls back to OpenAI when fallback is enabled.
- [x] OpenAI primary retryable outage/config failure falls back to Anthropic when fallback is enabled.
- [x] Provider health is visible in UI and backed by database health events.
- [x] Run details show provider/model and fallback status.
- [x] Fallback does not duplicate Freshservice assignment, priority, category, note, or closure writebacks because retry occurs before final side-effect checkpoints.
- [x] Unsupported provider/model combinations are rejected before a run starts.
- [x] Existing assignment behavior remains Anthropic-first by default.
- [x] Auto-response is stable and uses provider failover plus the existing fallback message as final fallback.

## Open Questions Resolved

- [x] API keys are global deployment secrets only.
- [x] Approved OpenAI fallback model is `gpt-5.5`.
- [x] Provider selection is per operation, not one global workspace setting.
- [x] Anthropic server tools such as web search are stripped/rejected on OpenAI fallback until validated.
- [x] Reclassification and calendar leave now auto-fallback through the gateway, not later.
