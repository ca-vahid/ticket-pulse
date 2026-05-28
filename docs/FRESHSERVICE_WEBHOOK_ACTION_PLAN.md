# FreshService Webhook Action Plan

Date: 2026-05-28

## Goal

Add a per-workspace FreshService ticket webhook that accelerates new-ticket assignment processing while keeping the existing scheduled sync and assignment fast-sync polling as the reliability backstop.

The webhook must not bypass the existing sync pipeline. It should fetch and upsert the FreshService ticket through shared code first, then trigger the same assignment eligibility and dedupe rules used by polling.

## Current Code Audit

- The existing `backend/src/routes/webhook.routes.js` and `backend/src/controllers/webhook.controller.js` path is legacy v1. It uses one global shared secret and the assignment handler only works if the ticket is already in the local database. It has been tagged as legacy and should not be extended for the new design.
- External webhook routes must stay mounted before `requireAuth` in `backend/src/routes/index.js`, because FreshService will not have a user session. Authentication must be webhook-specific, not session-based.
- The best reusable backend seam is inside `backend/src/services/syncService.js`. `syncAssignmentCandidatesNow()` already performs a fast assignment-oriented sync, but it is lookback/list based. The webhook needs a single-ticket variant that shares the same transform, technician mapping, noise evaluation, priority-event recording, notification queueing, and cache invalidation behavior.
- Assignment triggering should reuse `_pollForUnassignedTickets()` after the ticket is upserted, because it already checks workspace assignment config, `pollForUnassigned`, `pollMaxPerCycle`, open/running/completed pipeline run dedupe, noise status, and unassigned state.
- The Assignment settings surface is the right admin UI location. `AssignmentReview.jsx` already has a "Ticket Detection" section with polling controls, so webhook enablement and setup belongs there rather than the global FreshService settings.
- `AssignmentPipelineRun.triggerSource` already documents `webhook`, so no new run-source field is needed unless we want a separate trigger source such as `freshservice_webhook`.

## Design Principles

- Keep polling intact. Webhook is a low-latency accelerator, not the source of truth.
- One webhook configuration per workspace, independently enabled, disabled, rotated, and observed.
- Never run the assignment pipeline from raw webhook payload data. Always fetch the ticket from FreshService and validate workspace ownership first.
- Keep legacy v1 webhook code isolated. New code should use new names, routes, repositories, services, and docs.
- Use narrow, testable services. Route handlers should authenticate, normalize, enqueue or call the service, and return quickly.

## [x] Phase 1: Foundations and Shared Ingest Boundary

- [x] Add a workspace-scoped webhook configuration model and migration.
  - Proposed table: `workspace_webhook_configs`.
  - Fields: `id`, `workspaceId` unique FK, `enabled`, `secretHash`, `secretLast4`, `lastReceivedAt`, `lastAcceptedAt`, `lastRejectedAt`, `lastErrorAt`, `lastErrorMessage`, `createdAt`, `updatedAt`.
  - Keep this separate from `AssignmentConfig` because it stores external auth material and operational receipt state, while `AssignmentConfig` remains assignment behavior.

- [x] Add `workspaceWebhookRepository` and `workspaceWebhookService`.
  - Responsibilities: get config, create default disabled config, enable/disable, generate secret, hash secret, rotate secret, verify supplied secret, update receipt/error timestamps.
  - Return the raw secret only on create/rotate responses. Store only the hash and a short display suffix.

- [x] Extract a reusable ticket upsert helper from `syncService`.
  - Proposed helper: `syncService.syncFreshServiceTicketSnapshot(workspaceId, fsTicket, options)`.
  - It should centralize the current repeated logic from `syncTickets()` and `syncAssignmentCandidatesNow()`: requester name capture, `_prepareTicketsForDatabase`, existing ticket lookup, responder tech resolution, noise evaluation, `ticketRepository.upsert`, priority event recording, FreshService assignment notifications, noise dismissal, read-cache clearing, and result metadata.
  - This avoids a webhook-only upsert shortcut that drifts from scheduled sync behavior.

- [x] Add a single-ticket FreshService fetch path.
  - Extend the FreshService client with a method that can fetch one ticket with the same useful include shape as list sync, preferably `include=requester,stats`.
  - Validate the returned ticket's FreshService workspace ID against the selected Ticket Pulse workspace before upsert or assignment.

- [x] Add focused backend tests for the extracted ingest boundary.
  - Cover new ticket upsert, existing ticket update, assigned ticket no assignment trigger, noise ticket dismissal, FreshService priority change event recording, unknown responder resolution, and workspace mismatch rejection.

## [x] Phase 2: Webhook Route, Authentication, and Assignment Trigger

- [x] Create a new v2 webhook route module instead of extending legacy v1.
  - Proposed file: `backend/src/routes/freshserviceWebhook.routes.js`.
  - Proposed endpoint: `POST /api/freshservice-webhooks/:workspaceSlug/tickets`.
  - Mount it before `requireAuth` in `backend/src/routes/index.js`, with a clear comment that this is the v2 FreshService ticket-ingest webhook.

- [x] Implement strict webhook authentication and payload normalization.
  - Accept the per-workspace secret through a documented header, with a tokenized URL fallback only if FreshService cannot send custom headers in the target setup.
  - Normalize FreshService ticket ID from known payload shapes.
  - Reject disabled workspaces, disabled webhook configs, missing ticket IDs, invalid secrets, and workspace mismatches with non-secret logs.

- [x] Add `freshServiceWebhookIngestService`.
  - Responsibilities: resolve workspace, verify config, record receipt, fetch FreshService ticket, call `syncFreshServiceTicketSnapshot`, and decide whether assignment polling should run.
  - Return a small structured result: `accepted`, `freshserviceTicketId`, `ticketId`, `synced`, `assignmentTriggered`, `skippedReason`.

- [x] Trigger assignment through the existing polling path after upsert.
  - Call `_pollForUnassignedTickets(workspaceId, { ticketIdsOverride: [ticketId], maxPerCycleOverride: 1, waitForCompletion: false, settleAfterMs: 1000, triggerSourceOverride: 'webhook' })`.
  - If `_pollForUnassignedTickets()` currently hardcodes `triggerSource='poll'`, update it to accept an override while keeping the default as `poll`.
  - Keep business-hours queueing, priority-only after-hours behavior, stale-run dedupe, and auto-assign behavior inside `assignmentPipelineService.runPipeline()`.

- [x] Add route/service tests and idempotency coverage.
  - Cover valid webhook, invalid secret, disabled webhook, inactive workspace, FreshService 404/403/429 handling, duplicate delivery while a run is queued/running, already-assigned ticket, noise ticket, and malformed payload.

## [ ] Phase 3: Admin UI, Operations, and Rollout

- [x] Extend Assignment settings with a Webhook card in "Ticket Detection".
  - Show enabled state, workspace-specific webhook URL, secret status/suffix, last received/accepted/error timestamps, and copy/regenerate controls.
  - Add API methods in `frontend/src/services/api.js` for get/update/rotate/test webhook config.

- [x] Add authenticated admin endpoints for webhook management.
  - Proposed endpoints under `/api/assignment/webhook-config` or `/api/workspaces/:id/webhook-config`.
  - Require workspace admin permissions.
  - Do not expose the stored secret. Only expose a newly generated secret during create/rotate.

- [x] Add observability and operator diagnostics.
  - Log structured events for received, accepted, rejected, FreshService fetch failed, upsert failed, and assignment trigger skipped.
  - Include counters/status in the webhook config response so the UI can explain whether the connector is working without requiring log access.

- [x] Document setup and rollback.
  - Add a concise setup guide with the exact webhook URL pattern, expected payload field, auth header or token placement, enable/disable behavior, and safe rollback steps.
  - State clearly that scheduled polling remains enabled and catches missed webhook deliveries.

- [ ] Validate with local and staging/prod smoke tests.
  - Unit tests for repository/service/route behavior.
  - Manual curl test against local API with mocked or real FreshService ticket ID.
  - Staging test from FreshService automation for one workspace.
  - Confirm that a new unassigned ticket creates or queues a pipeline run immediately and that scheduled polling still handles missed or duplicate events.
  - Current status: unit tests, build/lint, local migration, backend health, and unauthenticated local webhook-route smoke are complete. Staging/prod FreshService automation delivery is intentionally left for rollout because it requires changing FreshService automation outside the repo.
