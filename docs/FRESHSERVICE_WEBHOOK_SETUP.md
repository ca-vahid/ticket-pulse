# FreshService Ticket Webhook Setup

Ticket Pulse supports a per-workspace FreshService ticket webhook that speeds up assignment processing for newly created or updated tickets. Scheduled sync and assignment polling stay enabled and remain the reliability backstop.

## Endpoint

Use the workspace-specific URL shown in Assignment Review -> Configuration -> Ticket Detection:

```text
https://<ticket-pulse-host>/api/freshservice-webhooks/<workspace-slug>/tickets
```

Example:

```text
https://ticket-pulse.example.com/api/freshservice-webhooks/it/tickets
```

## Authentication

Preferred header:

```text
X-Ticket-Pulse-Webhook-Secret: <workspace webhook secret>
```

If the FreshService automation cannot send custom headers, use the tokenized URL fallback:

```text
https://<ticket-pulse-host>/api/freshservice-webhooks/<workspace-slug>/tickets?token=<workspace webhook secret>
```

Store the secret only in FreshService. Ticket Pulse stores only a hash and the last four characters for display.

## Payload

Send JSON with the FreshService ticket ID. Supported shapes include:

```json
{ "ticket_id": 224183 }
```

```json
{ "ticket": { "id": 224183 } }
```

```json
{ "data": { "ticket": { "id": 224183 } } }
```

Ticket Pulse does not trust the rest of the webhook payload. It fetches the ticket from FreshService with `include=requester,stats`, validates that the returned ticket belongs to the requested workspace, upserts it through the shared sync path, then runs the existing unassigned-ticket polling logic for that ticket.

## FreshService Automation

Create a FreshService workflow automator for ticket create/update events that posts to the workspace URL. Include the ticket ID in the body and the workspace webhook secret in the header above.

Recommended body:

```json
{
  "ticket_id": "{{ticket.id_numeric}}"
}
```

Use the numeric ticket ID placeholder from FreshService. If `ticket.id_numeric` is not available in the placeholder picker, choose the ticket ID placeholder that resolves to digits only, such as `224183`, not `SR-224183`.

## Local Curl Smoke Test

Use a real FreshService ticket ID from the same workspace:

```bash
curl -X POST "http://localhost:3000/api/freshservice-webhooks/it/tickets" \
  -H "Content-Type: application/json" \
  -H "X-Ticket-Pulse-Webhook-Secret: <secret>" \
  -d "{\"ticket_id\":224183}"
```

Expected success response:

```json
{
  "success": true,
  "data": {
    "accepted": true,
    "synced": true,
    "assignmentTriggered": true
  }
}
```

`assignmentTriggered` can be `false` when the ticket is already assigned, filtered as noise, closed, or already has an active/completed assignment run.

## Rollback

Disable the workspace webhook in Assignment Review -> Configuration -> Ticket Detection. FreshService deliveries will be rejected for that workspace, while scheduled sync and assignment polling continue to catch missed tickets. To fully roll back, disable or delete the FreshService workflow automator after disabling the Ticket Pulse config.

Rotate the secret immediately if a webhook URL with `?token=` was exposed in logs, chat, screenshots, or automation history.
