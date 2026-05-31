# Custom Mail Notifications Workflow Plan

Date: 2026-05-29

## Goal

Build a workspace-scoped notification workflow system for Ticket Pulse that can send configurable email notifications when ticket events occur, including ticket arrival, assignment, reassignment, priority changes, and close/resolution. Workflows must be editable by workspace admins, support optional LLM-generated text, allow recipient rules, provide preview/testing, and keep full delivery/audit history.

## Accepted V1 Decisions

- Email provider: continue with SendGrid first.
- Requester-facing notifications: send normal outbound emails, not FreshService public replies.
- LLM-generated email text: can send automatically after a workflow is published.
- V1 events: ticket arrived, assigned, reassigned, and resolved/closed. Resolved and closed should be treated as the same notification event because resolved tickets close automatically soon after.
- Workflow administration: workspace admins only.
- V1 recipients: requester, assigned agent, and custom email addresses only.
- Historical sync/backfill: must not trigger notifications. Only live events after the workflow is enabled should be eligible.

## Current Repo Findings

- `NotificationDelivery` already exists as a delivery/outbox table, but it is currently shaped around priority assignment alerts. It requires `assessedPriority`, stores one payload blob, and is linked to tickets, assignment pipeline runs, and priority events.
- `notificationDeliveryService.js` currently handles email, SMS, WhatsApp, and phone delivery, but the email path is hardcoded for priority assignment messages.
- `notificationPreferenceService.js` queues per-agent priority/assignment alerts and uses existing provider-status checks for SendGrid and Twilio.
- `notifications.routes.js` is still a placeholder for general notifications.
- `AssignmentConfig` already has workspace-level assignment and email-monitoring flags, plus after-hours urgent escalation settings.
- `autoResponseService.js` has a hardcoded incoming-ticket workflow with LLM classification, LLM response generation, ETA, and SMTP send. It is useful as behavior reference, but it should not become the workflow engine.
- `graphMailClient.js` can read from a Microsoft 365 mailbox and fetch user profiles, but it does not send mail yet.
- The app already has a shared AI provider gateway with per-workspace operation settings and provider-attempt audit records. LLM workflow steps should reuse that gateway.

## Research Snapshot

Package versions checked with `npm view` on 2026-05-29:

- `@xyflow/react`: 12.10.2
- `pg-boss`: 12.18.2
- `bullmq`: 5.77.6
- `@trigger.dev/sdk`: 4.4.6
- `inngest`: 4.5.0
- `@react-email/render`: 2.0.8
- `mjml`: 5.3.0
- `liquidjs`: 10.27.0
- `@tiptap/react`: 3.23.6
- `@azure/communication-email`: 1.1.0
- `resend`: 6.12.4
- `@sendgrid/mail`: 8.1.6
- `elkjs`: 0.11.1
- `json-logic-js`: 2.0.5
- `sanitize-html`: 2.17.4

## Recommended Stack

### Workflow Editor

Use `@xyflow/react` plus `elkjs`.

Reasons:

- React Flow is purpose-built for node-based editors and interactive diagrams.
- It fits the current React/Vite/Tailwind frontend without a second framework.
- It supports custom nodes, validation, save/restore, minimap/controls, and workflow-editor examples.
- `elkjs` gives automatic layout for readable workflows instead of forcing admins to manually place every node.

Fallback: a table/form-driven workflow editor for v1 if canvas scope becomes too large. Still store the same node/edge definition so a canvas can be added without a schema rewrite.

### Workflow Definition And Rules

Use repo-native JSON definitions validated with Zod, plus `json-logic-js` for admin-configured conditions.

V1 workflow nodes:

- `trigger`: ticket.created, ticket.assigned, ticket.reassigned, ticket.resolved_closed
- `condition`: JSONLogic condition over normalized ticket event context
- `recipient_resolver`: requester, assigned_agent, previous_agent, custom_emails
- `llm_generate`: prompt plus JSON schema for subject/body/fragments through `providerGateway.sendJson`
- `template_render`: Liquid variables and optional MJML/HTML wrapper
- `send_email`: SendGrid provider, from address, to/cc/bcc, subject, HTML/plain text
- `stop`: terminal node with reason

Deferred node types:

- `approval_gate`: draft requires admin approval before send
- `freshservice_note`: optional future node if we decide notifications should also be written back to the ticket
- `recipient_resolver`: workspace_admins, escalation_list, ticket_group_owner, Entra manager, Entra group
- `trigger`: ticket.priority_changed, ticket.status_changed beyond the resolved/closed crossing

Use a normalized event context, not raw FreshService payloads, as the workflow input. Example:

```json
{
  "event": {
    "type": "ticket.assigned",
    "source": "webhook",
    "occurredAt": "2026-05-29T19:00:00.000Z"
  },
  "workspace": {
    "id": 1,
    "name": "IT",
    "timezone": "America/Vancouver"
  },
  "ticket": {
    "id": 123,
    "freshserviceTicketId": 456,
    "subject": "Cannot access VPN",
    "status": "Open",
    "priorityLabel": "High",
    "isNoise": false
  },
  "requester": {
    "name": "Requester Name",
    "email": "requester@example.com"
  },
  "assignedAgent": {
    "id": 17,
    "name": "Agent Name",
    "email": "agent@example.com"
  }
}
```

### Template Rendering

Use `liquidjs` for user-editable variables and conditions.

Reasons:

- Liquid syntax is familiar, safe, serializable, and works in Node and browser contexts.
- It supports variable insertion without allowing arbitrary JavaScript.
- It is better suited to admin-edited templates than React Email components.

Use `mjml` only if we want branded responsive HTML templates with sections/columns/buttons. For a first version, support simple sanitized HTML plus plain text fallback. Add MJML as a renderer option after the workflow engine is stable.

Use `sanitize-html` before storing or sending HTML from admin-editable templates or LLM output.

React Email is better for developer-owned templates than workspace-admin-owned templates. I would not lead with it unless we want fixed Ticket Pulse-branded components in code.

### Delivery Provider

Accepted V1 provider: SendGrid first.

Longer-term provider order:

1. SendGrid for v1, because Ticket Pulse already has provider settings and delivery scaffolding.
2. Microsoft Graph `sendMail` from the workspace mailbox, if the organization later wants mail to come from an internal/shared mailbox and appear in Sent Items.
3. Azure Communication Services Email, if we want Azure-native email without Exchange mailbox semantics.

For Ticket Pulse v1, keep SendGrid as the only outbound email provider in the workflow engine. Do not add Microsoft Graph sending until there is a product requirement for shared-mailbox identity or Sent Items semantics.

Keep the provider boundary generic:

```text
notificationEmailProvider.send({
  workspaceId,
  provider,
  from,
  to,
  cc,
  bcc,
  subject,
  html,
  text,
  headers,
  metadata
})
```

### Durable Execution

Recommended: keep the workflow run and delivery audit in Ticket Pulse Postgres, and add `pg-boss` only for durable retries/backoff/deferred delivery once the schema is ready.

Reasons:

- Ticket Pulse already runs PostgreSQL and already has Prisma-backed audit tables.
- `pg-boss` uses Postgres, supports retries/backoff/cron/dead-letter style behavior, and avoids introducing Redis only for notification jobs.
- BullMQ is strong but would add Redis infrastructure.
- Trigger.dev and Inngest are modern and attractive for hosted durable workflows, but they move workflow execution and observability partly outside the current Azure/Postgres application boundary. Use only if we explicitly want an external workflow platform.

## Data Model Direction

Add these tables instead of stretching `AssignmentConfig` or the current priority-only notification model:

- `notification_workflows`
  - `workspace_id`
  - `key`
  - `name`
  - `description`
  - `trigger_type`
  - `is_enabled`
  - `draft_definition`
  - `published_definition`
  - `published_version`
  - `last_published_at`
  - `last_changed_by`
  - timestamps

- `notification_workflow_versions`
  - immutable published snapshots
  - node/edge definition
  - validation result
  - change note

- `notification_workflow_runs`
  - `workflow_id`
  - `workflow_version_id`
  - `workspace_id`
  - `ticket_id`
  - `event_type`
  - `event_context`
  - `status`
  - `trigger_source`
  - `started_at`
  - `completed_at`
  - `error`
  - `dedupe_key`

- `notification_workflow_step_runs`
  - `run_id`
  - `node_id`
  - `node_type`
  - `status`
  - `input`
  - `output`
  - `started_at`
  - `completed_at`
  - `duration_ms`
  - `error`

- Update or replace `notification_deliveries`
  - allow generic notification types beyond priority
  - make `assessedPriority` nullable or move priority-specific data into payload
  - add `workflowRunId`, `workflowStepRunId`, `eventType`, `subject`, `htmlBody`, `textBody`, `fromAddress`, `to`, `cc`, `bcc`
  - keep `dedupeKey`, provider status, retry count, error, queued/sent timestamps

## Trigger Points

Start with these event emitters:

- FreshService webhook single-ticket ingest: emit live `ticket.created`, `ticket.assigned`, `ticket.reassigned`, and `ticket.resolved_closed` events after the shared sync upsert detects changes.
- Scheduled live polling: emit the same events only for tickets changed after the workflow was enabled.
- Historical sync/backfill: do not emit workflow notification events.
- Assignment pipeline: emit `ticket.assigned` or `ticket.reassigned` only after Ticket Pulse or FreshService state confirms the assignment.
- Status sync: emit `ticket.resolved_closed` when status crosses into resolved or closed. Treat resolved and closed as one lifecycle notification event.

## Admin UI Direction

Add a workspace-admin "Notification Workflows" settings surface. I would place the entry under Settings first, with a shortcut from Assignment Review configuration.

Expected controls:

- Workspace-level master toggle.
- Workflow list with status, trigger, published version, last run, and last error.
- Workflow designer:
  - left node palette
  - center canvas or linear steps
  - right inspector for selected node settings
  - top actions: Preview, Test, Save draft, Publish, Disable
- Template editor:
  - Tiptap for friendly rich text editing
  - variable picker for ticket/requester/agent/workspace fields
  - raw Liquid/MJML advanced mode later
  - live preview with sample ticket context
- Audit tab:
  - runs
  - step outputs
  - LLM prompts/results
  - delivery status and errors
  - retry/resend controls for admins

## Phased Implementation Checklist

### Phase 1 - Product Decisions And Schema

- [x] Confirm notification events for v1: arrived, assigned, reassigned, resolved/closed.
- [x] Confirm email provider priority: SendGrid first.
- [x] Confirm whether notifications are direct outbound email, FreshService ticket replies, FreshService private notes, or a mix: direct outbound email only.
- [x] Confirm whether LLM-generated messages require approval before sending: no approval required after workflow publish.
- [x] Confirm editor/publisher role: workspace admins only.
- [x] Confirm v1 recipient scope: requester, assigned agent, custom email addresses.
- [x] Confirm historical sync/backfill behavior: live events only after workflow enablement.
- [x] Design Prisma schema for workflows, workflow versions, runs, step runs, and generic deliveries.
- [x] Add migration and Prisma client generation.
- [x] Add Zod schemas for workflow definitions, node types, and event contexts.

### Phase 2 - Event And Execution Core

- [x] Add `ticketEventService` to normalize ticket lifecycle events from sync, webhook ingest, assignment pipeline, and status changes.
- [x] Add dedupe keys so sync/backfill cannot duplicate notification sends.
- [x] Add `notificationWorkflowRepository`.
- [x] Add `notificationWorkflowEngine` with deterministic node execution.
- [x] Implement condition, recipient resolver, template render, LLM generate, and send email nodes.
- [x] Add dry-run execution mode for preview/testing.
- [x] Add unit tests for validation, dedupe, conditions, recipients, and template rendering.

### Phase 3 - Email Provider Abstraction

- [x] Adapt SendGrid provider to the generic provider interface.
- [x] Keep Microsoft Graph send as a deferred provider, not a v1 task.
- [x] Add provider config/status API reuse for SendGrid.
- [x] Add provider error normalization and retryable/non-retryable classification.
- [x] Add delivery processing tests for accepted, failed, retry, and duplicate paths.

### Phase 4 - Admin API

- [x] Add `/api/notification-workflows` routes with workspace access checks.
- [x] Support list, get draft, save draft, publish, disable, test run, run history, and delivery retry.
- [x] Require workspace admin role for workflow edits and publishing.
- [x] Include audit-safe redaction for prompt/output payloads where needed.

### Phase 5 - Frontend Workflow UI

- [x] Add Notification Workflows settings page or section.
- [x] Add workflow list with enable/disable and health summary.
- [x] Add canvas or linear step builder.
- [x] Add node inspector components for triggers, conditions, recipients, LLM generation, templates, and send email.
- [x] Add template editor with variable picker and live preview.
- [x] Add publish/test flow with visible validation errors.
- [x] Add run/delivery audit view.

### Phase 6 - Rollout Safety

- [x] Seed disabled default workflows for ticket created, assigned, reassigned, and closed/resolved.
- [x] Add dry-run-only mode for initial workspace rollout.
- [x] Add delivery throttling and max recipients per workflow.
- [x] Add admin-visible health checks.
- [x] Add e2e-ish tests for a ticket event producing a workflow run and queued delivery.
- [x] Update AGENTS.md, docs, and changelog.

## Suggested V1 Defaults

- Workflow 1: Ticket received
  - Trigger: `ticket.created`
  - Recipients: requester
  - Steps: condition not noise -> LLM draft optional -> template -> send email
  - Default: disabled

- Workflow 2: Ticket assigned
  - Trigger: `ticket.assigned`
  - Recipients: assigned agent and optionally requester
  - Steps: template -> send email
  - Default: disabled

- Workflow 3: Ticket resolved/closed
  - Trigger: `ticket.resolved_closed`
  - Recipients: requester
  - Steps: template -> send email
  - Default: disabled

## Deferred Questions

- Whether to add Microsoft Graph sending later for shared-mailbox identity and Sent Items.
- Whether to add FreshService public replies or private notes as workflow actions later.
- Whether to add Entra manager/group recipient resolvers later.
- Whether to add provider-selectable email delivery per workspace after SendGrid v1 is stable.

## Sources

- React Flow: https://reactflow.dev/
- pg-boss: https://github.com/timgit/pg-boss
- BullMQ: https://docs.bullmq.io/
- Trigger.dev: https://trigger.dev/docs
- Inngest: https://www.inngest.com/docs/
- Microsoft Graph sendMail: https://learn.microsoft.com/en-us/graph/api/user-sendmail
- SendGrid API: https://www.twilio.com/docs/sendgrid/for-developers/sending-email/
- Azure Communication Services Email: https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/email/send-email
- Tiptap React: https://tiptap.dev/docs/editor/getting-started/install/react
- LiquidJS: https://liquidjs.com/api/index.html
- MJML: https://mjml.io/faq
- React Email render: https://react.email/docs/utilities/render
- JsonLogic: https://jsonlogic.com/operations.html
