# FreshService Ticket Webhook Setup — Instant Status Sync

Ticket Pulse supports a per-workspace FreshService ticket webhook that gives **instant status sync**: any FreshService-side change (new ticket, status change, priority change, assignee change) posted to the webhook is fetched, upserted through the shared sync path, and pushed live to open Ticket Pulse queues and ticket views over SSE within seconds — no page refresh needed. Scheduled sync and the 60-second fast lane stay enabled and remain the reliability backstop.

For full coverage the FreshService workflow automator must fire on **both create and update events** — see the two recipes below. An automator that fires only on ticket creation gives instant *arrival* but leaves status changes to the (slower) polling lanes.

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

Ticket Pulse does not trust the rest of the webhook payload. It fetches the ticket from FreshService with `include=requester,stats`, validates that the returned ticket belongs to the requested workspace, upserts it through the shared sync path (which broadcasts a `ticket-change` SSE event to that workspace when the status or assignee actually changed), then runs the existing unassigned-ticket polling logic for that ticket.

The same payload works for create and update events — the endpoint is idempotent and always syncs current FreshService truth, so you can point every automator rule at the one URL.

## FreshService Automation

Both recipes post to the same workspace URL with the same body and secret header. Use the numeric ticket ID placeholder from FreshService. If `ticket.id_numeric` is not available in the placeholder picker, choose the ticket ID placeholder that resolves to digits only, such as `224183`, not `SR-224183`.

Recommended body (both rules):

```json
{
  "ticket_id": "{{ticket.id_numeric}}"
}
```

### Recipe 1 — Ticket created (instant arrival + assignment)

Workflow Automator -> New Automator -> **Event based** workflow:

1. **Event**: `Ticket is raised` (all sources).
2. *(Optional condition)*: restrict by workspace/group if the FS instance hosts multiple workspaces and the automator is not already workspace-scoped.
3. **Action**: `Trigger Webhook`
   - Request type: `POST`
   - URL: the workspace endpoint above
   - Encoding: `JSON`
   - Custom header: `X-Ticket-Pulse-Webhook-Secret: <secret>` (or use the `?token=` URL fallback)
   - Body: the recommended body above.

### Recipe 2 — Ticket updated (instant status sync)

Create a second event-based automator (or add a second event rule to the same automator where the plan allows):

1. **Event**: `Ticket is updated`, with the update-type checkboxes for:
   - `Status is changed` — any -> any
   - `Priority is changed` — any -> any
   - `Agent is changed` — any -> any (assignee set, reassigned, or cleared)
2. **Action**: identical `Trigger Webhook` action as Recipe 1 (same URL, header, body).

Notes:

- Do **not** fire on "any field updated" — note-adds and tag edits would multiply deliveries without changing anything Ticket Pulse displays live. The three update types above cover everything the queue renders.
- FreshService retries webhook deliveries on 5xx responses. Ticket Pulse returns `503` when its FreshService API queue is congested (`freshservice_queue_timeout`), so a delivery during heavy background sync is retried by FS rather than lost.
- Delivery counters (Received / Accepted / Rejected, last delivery time) are visible per workspace in Assignment Review -> Configuration -> Ticket Detection — use them to confirm the update-event rule is actually firing after setup.

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

`assignmentTriggered` can be `false` when the ticket is already assigned, filtered as noise, closed, or already has an active/completed assignment run. For a status-change delivery on an assigned ticket that is the normal, correct outcome — the sync (and the live SSE push) still happened.

To watch the live update: keep `/tickets` open in a browser, change the ticket's status in FreshService (or re-run the curl after changing it), and the affected row updates in place without a refresh.

## Stop Service-bot note notifications

**Problem (FR 08-07 #9):** every internal note written in Ticket Pulse lands in FreshService too (the fallback mirror on TP-born tickets, the direct FS note on FS-born tickets), and FreshService's own note-add automation ("Service bot" / notify-on-note observer rules) then emails agents about each one. Ticket Pulse never asks FreshService to notify anyone — since v3.2.08 every note payload carries `notify_emails: []` — so the remaining spam is FS-side automation reacting to the note-add event itself. That rule has to be told to skip Ticket Pulse traffic.

**Markers to match on.** Every note Ticket Pulse pushes into FreshService now begins with a machine-matchable header line:

- `[Ticket Pulse mirror]` — mirror pushes onto the FS fallback copies of TP-born tickets (notes, replies, attachments, the intro note).
- `[Ticket Pulse note]` — internal notes written in Ticket Pulse on FS-born tickets (added in v3.2.08; edits re-send the same marker).

**Recipe (FS admin, per workspace):** open the automator/observer rule that fires on *"Note is added"* (or the notification rule emailing agents about private notes) and add an exclusion condition group:

1. Admin → Automation → Workflow Automator (or Observer) → the rule reacting to note adds.
2. Add conditions (AND with the existing ones):
   - `Note content` **does not contain** `[Ticket Pulse note]`
   - `Note content` **does not contain** `[Ticket Pulse mirror]`
3. Save and re-order so the exclusion is evaluated before any notify action.

If the rule builder cannot inspect note content, the alternative is a first-step condition on the note author: exclude notes added by the API/service account whose key Ticket Pulse uses (all Ticket Pulse note pushes authenticate as that agent).

After the rule change, verify: add an internal note in Ticket Pulse on an FS-born ticket → no Service-bot email; add a note directly in FreshService → notification still fires.

## Rollback

Disable the workspace webhook in Assignment Review -> Configuration -> Ticket Detection. FreshService deliveries will be rejected for that workspace, while scheduled sync, the 60-second status-refresh lane, and assignment polling continue to catch missed tickets. To fully roll back, disable or delete the FreshService workflow automator rules (create and update) after disabling the Ticket Pulse config.

Rotate the secret immediately if a webhook URL with `?token=` was exposed in logs, chat, screenshots, or automation history.
