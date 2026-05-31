# Custom Mail Notification Workflows

Date: 2026-05-29

## Scope

Ticket Pulse supports workspace-scoped mail workflows for live ticket lifecycle events:

- `ticket.created`
- `ticket.assigned`
- `ticket.reassigned`
- `ticket.resolved_closed`

Resolved and closed tickets share one event because resolved tickets are expected to close shortly after resolution.

## V1 Product Decisions

- Outbound provider is SendGrid.
- Requester-facing notifications are normal outbound emails, not FreshService public replies.
- LLM-generated email text may send automatically after the workflow is published and enabled.
- Workflow editing and publishing requires workspace admin access.
- V1 recipients are requester, assigned agent, and custom email addresses.
- Historical sync and backfill must not trigger workflow email sends.

## Data Model

- `notification_workflows`: workspace draft/published definition and enablement state.
- `notification_workflow_versions`: immutable published snapshots.
- `notification_workflow_runs`: one execution audit row per workflow and event.
- `notification_workflow_step_runs`: node-level input/output/status audit.
- `notification_deliveries`: generic email delivery outbox/audit, including workflow links, recipients, body, provider ID, error, retry count, and dedupe key.

## Execution

Live sources call the shared lifecycle dispatcher after a ticket state change is confirmed:

- FreshService webhook ingest
- Scheduled live polling
- Assignment pipeline writeback after FreshService confirms assignment or close

Backfill paths do not set `allowNotificationWorkflows`, so they remain silent.

Workflow definitions are JSON graphs. V1 nodes are:

- `trigger`
- `condition`
- `recipient_resolver`
- `llm_generate`
- `template_render`
- `send_email`
- `stop`

Conditions use JSONLogic. Templates use Liquid. Admin-edited and LLM-generated HTML is sanitized before delivery.

## Admin UI

Workspace admins use Settings > Mail Workflows to:

- inspect default disabled workflows
- edit workflow nodes
- add an optional LLM generation step
- edit templates with variables
- preview without sending
- save drafts
- publish versions
- enable or disable workflows
- review runs and deliveries
- retry failed deliveries
- view SendGrid/workflow health

## Safety Notes

- Workflows only execute events whose occurred time is after the workflow `enabledAt`.
- Run and delivery dedupe keys prevent repeated sends for the same event.
- A workflow email is capped at 25 total recipients.
- Delivery failures record retryable/permanent provider classification where available.
- Run history truncates large body fields before returning audit payloads to admins.
