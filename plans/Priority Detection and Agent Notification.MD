# Priority Detection and Agent Notifications Action Plan

## Summary

- [x] Create `docs/priority-detection-notifications-action-plan.md` with this checklist as the implementation tracker.
- [x] Make Ticket Pulse the source of truth for ticket priority assessment in the assignment pipeline.
- [x] Require the assessment LLM to output structured priority JSON using workspace-specific prompt definitions.
- [x] Write LLM-assessed priority back to Freshservice immediately after successful assessment, even if assignment still needs review.
- [x] Add agent-owned notification settings under the existing self-service agent page, with configurable High/Urgent thresholds and channel opt-ins.
- [x] Scaffold after-hours priority assessment as a disabled workspace setting for later enablement.

## Priority Assessment

- [x] Add first-class assessed priority fields to tickets while preserving the current imported Freshservice priority audit trail.
- [x] Define normalized priority values as `Low`, `Medium`, `High`, and `Urgent`, mapped to Freshservice native priority IDs.
- [x] Extend the assignment LLM `submit_recommendation` schema to require:
  - [x] `assessedPriority`
  - [x] `priorityRationale`
  - [x] `priorityConfidence`
  - [x] optional priority evidence/signals
- [x] Update the default IT assignment prompt with a dedicated "Priority Definitions" section.
- [x] Add a prompt upgrade marker so older workspace prompts are detected and upgraded or flagged.
- [x] Persist assessed priority, rationale, confidence, source run ID, and assessment timestamp on successful pipeline completion.
- [x] Show assessed priority and rationale in Assignment Review run detail, queue/history rows, and relevant ticket summaries.
- [x] Update existing priority filters so the review UI can distinguish Freshservice/imported priority from Ticket Pulse assessed priority.
- [x] Add a recent-open-ticket backfill path for IT tickets missing assessed priority.

## Freshservice Writeback

- [x] Add Freshservice client support for updating native ticket priority.
- [x] Add a priority writeback action that runs immediately after successful LLM assessment, independent of assignment approval.
- [x] Respect assignment dry-run mode: in dry run, store the intended priority update in sync payload but do not call Freshservice.
- [x] Mirror successful Freshservice priority updates back into the local ticket record.
- [x] Record priority writeback status, payload, error, and timestamp for audit/debugging.
- [x] Ensure assignment/category/noise writebacks continue to work independently if priority writeback fails.
- [x] Add sync preview text so reviewers can see the priority update alongside assignment/category actions.

## Agent Notifications

- [x] Add technician notification preference storage scoped by technician and workspace.
- [x] Add agent self-service "Notifications" tab beside the existing competencies tab.
- [x] Support configurable thresholds:
  - [x] `Urgent only`
  - [x] `High and Urgent` as default
  - [x] disabled
- [x] Support channel opt-ins:
  - [x] email
  - [x] SMS
  - [x] WhatsApp
  - [x] phone call
- [x] Pull agent phone candidates from Entra ID first using Graph user profile fields.
- [x] Allow the agent to override the Entra-derived phone number.
- [x] Require phone verification before SMS, WhatsApp, or phone-call notifications can be enabled.
- [x] Scaffold email notifications for SendGrid but keep sends disabled until SendGrid config is present.
- [x] Add Twilio SMS/WhatsApp/voice provider abstraction and required env config checks.
- [x] Add notification delivery/outbox records with status, provider message ID, retry count, error, and dedupe key.
- [x] Trigger notifications only after the ticket is actually assigned to the agent and the assessed priority meets that agent's threshold.
- [x] Avoid duplicate alerts for the same ticket, assignment run, technician, and channel.
- [x] Keep SMS/WhatsApp/voice content minimal: ticket ID, priority, assignment notice, and Freshservice link; avoid sensitive ticket body text.

## After-Hours Framework

- [x] Add a disabled workspace config flag such as `priorityAssessmentAfterHoursEnabled`.
- [x] Add pipeline branching so future after-hours priority-only assessment can run without enabling full after-hours assignment.
- [x] Keep current behavior for now: outside-business-hours assignment runs remain queued unless manually triggered.
- [x] Document the future flow: assess priority after hours, update Freshservice priority, and optionally notify only if assignment/alert policy later permits it.

## Tests and Acceptance Criteria

- [x] Unit test priority normalization and Freshservice priority ID mapping.
- [x] Unit test LLM tool schema validation rejects missing or invalid assessed priority.
- [x] Unit test prompt upgrade detection for prompts missing the priority-output marker.
- [x] Unit test pipeline persistence of assessed priority fields.
- [x] Unit test immediate priority writeback, including dry-run behavior and writeback failure handling.
- [x] Unit test notification threshold matching for `High`, `Urgent`, disabled, and channel-specific opt-ins.
- [x] Unit test Entra phone fallback versus agent override.
- [x] Unit test SMS/voice verification gating.
- [x] Integration test an auto-assigned High/Urgent ticket updates Freshservice priority and queues notifications after assignment sync.
- [x] Integration test a pending-review High/Urgent ticket updates Freshservice priority but sends no agent notification until assignment occurs.
- [x] Integration test recent-open-ticket priority backfill only processes active IT tickets in scope.
- [x] Frontend test the agent Notifications tab loads, saves preferences, validates phone override, and shows verification state.
- [x] Frontend test Assignment Review displays assessed priority and rationale.
- [x] Run backend tests, frontend tests/build, and targeted manual review of one dry-run pipeline payload before enabling real writeback.

## Assumptions and Defaults

- [x] Freshservice native priority will be replaced by Ticket Pulse priority assessment over time.
- [x] Ticket Pulse writes priority to Freshservice immediately after assessment, not only after assignment approval.
- [x] Agent notification threshold defaults to `High and Urgent`.
- [x] SMS, WhatsApp, and phone calls require verified phone numbers.
- [x] Existing tickets are backfilled for recent open/active IT tickets first, not the full historical corpus.
- [x] SendGrid is the future email provider; implementation should scaffold the provider boundary now but not require SendGrid to ship priority detection.
- [x] Twilio will be used for SMS, WhatsApp, and phone calls.
- [x] After-hours priority-only assessment is scaffolded but remains disabled for this phase.

## Verification Log

- [x] Phase 1 backend tests: `npm test --prefix backend -- priorityAssessment.test.js promptRepository.test.js --runInBand`
- [x] Phase 1 Prisma generation: `npm run prisma:generate --prefix backend -- --schema prisma/schema.prisma`
- [x] Phase 1 mock assessment: normalized a representative High priority recommendation into ticket persistence fields.
- [x] Phase 2 backend tests: `npm test --prefix backend -- freshServiceActionService.test.js --runInBand`
- [x] Phase 2 mock writeback: generated an Urgent `update_priority` action preview without calling Freshservice.
- [x] Phase 3 backend tests: `npm test --prefix backend -- notificationPreferenceService.test.js freshServiceActionService.test.js priorityBackfillService.test.js --runInBand`
- [x] Phase 3 frontend tests: `npm test --prefix frontend -- NotificationSettingsPanel.test.jsx --run`
- [x] Phase 3 mock notification: verified High/Urgent threshold matching and generated a minimal Freshservice-linked assignment message without sending.
- [x] Phase 4 backend tests: `npm test --prefix backend -- notificationPreferenceService.test.js freshServiceActionService.test.js priorityBackfillService.test.js assignmentPipelinePriorityPersistence.test.js priorityAssessment.test.js promptRepository.test.js --runInBand`
- [x] Phase 4 frontend tests: `npm test --prefix frontend -- NotificationSettingsPanel.test.jsx PipelineRunDetail.priority.test.jsx --run`
- [x] Phase 4 mock backfill: normalized recent-active backfill options and verified cap behavior without touching production.
- [x] Final Prisma generation: `npm run prisma:generate --prefix backend -- --schema prisma/schema.prisma`
- [x] Final backend suite: `npm test --prefix backend -- --runInBand`
- [x] Final frontend suite: `npm test --prefix frontend -- --run`
- [x] Final frontend build: `npm run build --prefix frontend`
- [x] Browser smoke: opened local Vite dev server at `http://127.0.0.1:5173`; login rendered, with only expected auth-session network errors because the backend API was not started.
- [x] Provider follow-up backend suite: `npm test --prefix backend -- --runInBand`
- [x] Provider follow-up frontend suite: `npm test --prefix frontend -- --run`
- [x] Provider follow-up frontend build: `npm run build --prefix frontend`
- [x] Provider browser smoke: verified Twilio voice test validation is isolated from SendGrid by using an invalid test phone number; no real call was placed.
- [x] WhatsApp backend tests: `npm test --prefix backend -- notificationPreferenceService.test.js notificationDeliveryService.test.js --runInBand`
- [x] WhatsApp frontend tests: `npm test --prefix frontend -- NotificationSettingsPanel.test.jsx --run`
- [x] WhatsApp build verification: `npm run build --prefix frontend`
- [x] Final v2.45 backend suite: `npm test --prefix backend -- --runInBand`
- [x] Final v2.45 frontend suite: `npm test --prefix frontend -- --run`
- [x] Local and production Prisma migrations: `20260526010000_add_whatsapp_notifications` applied and both databases report schema up to date.
