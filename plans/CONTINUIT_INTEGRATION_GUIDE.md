# ContinuIT × Ticket Pulse — integration guide

**For:** the ContinuIT team (business continuity / office check-ins), moving from FreshService to Ticket Pulse.
**Answers:** "ContinuIT integration request", rev. 2, 15 Sep 2026 — section numbers below follow that document (they line up with Simorgh's, so `plans/SIMORGH_INTEGRATION_GUIDE.md` is the long-form reference for anything not repeated here).
**Ticket Pulse version:** 3.9.53 (19 Sep 2026). **Status:** sandbox provisioning ready; IT client issued after your sandbox acceptance.

---

## 1. In one page

- **One credential**, OAuth2 client-credentials, **trusted intake ON**. What you file is final: Ticket Pulse never re-categorises, re-types, re-prioritises or noise-closes a ticket you created (§3a, R1–R5). It picks an assignee **only when you leave `assignedTechId` out**.
- **Due dates are yours** (§B1). Send `dueBy` on `POST /tickets` and `PATCH /tickets/{id}`; it is stored as a manual date and the SLA clock never overwrites it. Reserved for trusted-intake credentials.
- **People sync** (§4a): `GET /agents` (id, name, email, isActive, freshserviceId, location, photoUrl) and `GET /contacts?location=…` / `?email=…`. E-mail is the join key on both.
- **Requester** `continuit@bgcengineering.ca` is *unattended*: Ticket Pulse never e-mails it. Put the person who should hear back in `ccEmails`, or set them as the requester when the ticket is really theirs.
- **Webhooks** to `https://continuit-api.azurewebsites.net/api/webhooks/ticketpulse`, Standard-Webhooks signed. Events listed in §6.
- **Migration** (§7): nothing to do. FreshService tickets stay in FreshService and run their course; Ticket Pulse ingests them read-mostly and **does** fire webhooks for FreshService-side changes (§F2/F3 below).

## 2. Identity

| | Sandbox | IT |
|---|---|---|
| Workspace | *ContinuIT Sandbox* (native only, no FreshService mirror, inactive so no scheduler touches it) | IT (workspace 1) |
| Token | `POST /api/v1/oauth/token` `grant_type=client_credentials` — Bearer JWT, carries the scopes; fetch a new one after any scope change | same |
| Scopes | `tickets:*`, `conversations:*`, `customfields:*`, `tags:*`, `search:read`, `agents:read`, `groups:read`, `categories:read`, `types:read`, `contacts:read`, `webhooks:read`, `tasks:*` | same |
| Trusted intake | on | on |
| IP allowlist | none | your 32 outbound addresses (your §2) |
| Base URL | `https://ticket-pulse-app.azurewebsites.net/api/v1` | same |

Secrets (client secret, webhook signing secret) are printed once by the provisioning script and handed over out of band — never in this document.

## 3. Creating a ticket

```http
POST /api/v1/tickets
Idempotency-Key: <uuid>

{ "subject": "Office check-in — Calgary — 26 Sep",
  "description": "…",
  "requesterEmail": "continuit@bgcengineering.ca",
  "ccEmails": ["site.lead@bgcengineering.ca"],
  "category": "…", "subcategory": "…",
  "priority": 2,
  "ticketType": "Service Request",
  "dueBy": "2026-09-26T17:00:00-07:00",
  "assignedTechId": 56,
  "externalRef": "continuit:checkin:2026-09-26:calgary",
  "customFields": { "continuit_task_id": "…", "continuit_office": "Calgary" } }
```

| Field | Notes |
|---|---|
| `dueBy` | **§B1.** ISO datetime with offset. Stored with `dueBySetBy: "manual"` — the workspace SLA policy never recomputes it. Trusted-intake only; otherwise `403 due_by_requires_trusted_intake`. `null` on PATCH clears it (the SLA clock may then own it again). |
| `assignedTechId` | The owner you agreed in the meeting (`GET /agents`). **Leave it out** to let the assignment pipeline pick — that is the only automation that runs on your tickets. |
| `externalRef` | Your per-record key. A second POST with the same ref **updates** the ticket (200, `resubmitted: true`) instead of creating a twin. A resubmission never touches status, assignee or due date — they belong to the people working the ticket — and reports them in `meta.ignoredFields`. |
| `customFields` | Unknown keys auto-provision a definition. Prefix yours `continuit_`. |
| `category` / `subcategory` | By name, resolved against the IT taxonomy (`GET /categories`). Unknown names 400 with the allowed values. |
| Tags | `PUT /tickets/{id}/tags { "tagIds": [...] }` — `continuit` and `office-check-in` exist in both workspaces (`GET /tags` for ids). |

Response: `201` with the ticket (`ref` like `TP-1601`, `id`, `dueBy`, `assignee`, …). The URL segment on every later call accepts `TP-1601` as well as the id.

## 3a. Automation rules on your tickets (R1–R5)

| Rule | Ticket Pulse behaviour |
|---|---|
| R1 never re-categorise | Trusted intake: the pipeline's persist step refuses to write category for a trusted ticket. |
| R2 never re-type | Same guard on ticket type. |
| R3 never re-prioritise | Same guard on priority; the after-hours priority pass skips trusted tickets entirely. |
| R4 never re-assign | Assignment runs once, on creation, and only when `assignedTechId` was left out. Nothing re-assigns a ticket that has an owner. |
| R5 no noise / auto-resolve | Trusted intake is a veto in its own right: no noise rule may close your tickets; no auto-resolve workflow is installed for you. |

## 4. Updating, resolving, reading

- `PATCH /tickets/{id}` — `subject`, `priority`, `category`/`subcategory`, `groupId`/`internalGroupId`, `ccEmails`, **`dueBy`**, `status` (+ `resolutionReason`/`resolutionNote`), `assignedTechId`, `customFields`, `addNote`. One call, several changes.
- `GET /tickets/{id}` — the read shape (see the Simorgh guide §4) plus `dueBy`, `relations`, `readyToCloseAt`.
- `GET /tickets/{id}/activities` — the audit feed (`due_changed` rows carry `changes.dueBy.from/to`).
- Notes and replies: `POST /tickets/{id}/notes` (private), `POST /tickets/{id}/replies` (e-mails the requester — not `continuit@`, it is unattended; the Cc list still receives it).

## 4a. People (C1, C3, C4)

```http
GET /api/v1/agents?active=true
→ [{ "id": 56, "name": "Soheil Nasiri", "email": "snasiri@bgcengineering.ca", "isActive": true,
     "freshserviceId": "1002090111", "location": "Vancouver", "photoUrl": null }]

GET /api/v1/contacts?location=Calgary&limit=500
GET /api/v1/contacts?email=drichard@bgcengineering.ca
→ [{ "id": 3, "name": "Dana Richard", "email": "…", "phone": null, "department": "…", "location": "Calgary", "unattended": false }]
```

`location` on a contact is the Entra office; on an agent it is the FreshService location. Both are `contains`, case-insensitive. `freshserviceId` is a string (it is a 64-bit id). Join on e-mail.

## 5. Reconciliation

Poll `GET /tickets?updatedFrom=<iso>&externalRefPrefix=continuit:` (cursor pagination) to catch anything a webhook missed; `GET /tickets/{id}/activities` for who did what. Same pattern Simorgh's reconciler uses.

## 6. Webhooks (Ticket Pulse → ContinuIT)

Subscription on `https://continuit-api.azurewebsites.net/api/webhooks/ticketpulse`, events:
`ticket.created`, `ticket.status_changed`, `ticket.assigned`, `ticket.reply_received`, `ticket.public_reply_added`, `ticket.fields_updated`, `ticket.custom_fields_changed`, `ticket.tags_changed`, `ticket.note_added`, `task.created`, `task.updated`, `task.completed`.

Envelope `{ type, event, timestamp, workspaceId, data }`; Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature` over `id.timestamp.body`); retries with backoff for 8 attempts; a subscription that fails 20 times in a row is disabled. `data.ticket` carries `externalRef`, `dueBy`, `status`, `resolutionReason`, `assignedAgent`, `actor`. Due-date edits arrive as `ticket.fields_updated` with `changedFields` containing `dueBy`.

### F2 / F3 — FreshService-side changes

FreshService → Ticket Pulse ingest covers tickets (every 5 min, plus a 1-minute fast lane for unassigned ones and the FreshService webhook for IT), conversations, tasks and approval status. Changes ingested from FreshService **do** emit lifecycle webhooks (`ticket.status_changed`, `ticket.assigned`, `ticket.fields_updated` with the FreshService-side field diff, `ticket.reply_received`), with `actorKind: "freshservice"`. So the FreshService tickets that keep running to their end will report their closes to you.

## 7. Migration

Nothing on our side. Existing FreshService tickets stay where they are; you file new work into Ticket Pulse. If you later want the old ones referenced from the new, `POST /tickets/{id}/links { "related": "#241155", "kind": "related_to" }` accepts a FreshService number.

## 8. Sandbox acceptance — suggested run

1. Token → `GET /agents?active=true` → `GET /contacts?location=Calgary`.
2. `POST /tickets` with `dueBy`, `assignedTechId`, `externalRef`, `customFields`, tags. Read it back: `dueBy` equals what you sent; `assignee` is yours.
3. `POST` again with the same `externalRef` and a new description → 200, `resubmitted: true`, `meta.ignoredFields` lists nothing you care about.
4. `PATCH` a new `dueBy` → `GET` shows it; `GET …/activities` has a `due_changed` row.
5. `PATCH { "status": "Resolved" }` → your webhook receives `ticket.status_changed`.
6. Create without `assignedTechId` → within a minute the assignment pipeline picks someone and `ticket.assigned` arrives. Confirm category/priority/type were left exactly as sent.

## 9. Go-live

Once the sandbox run passes: the IT client is issued with your 32-address allowlist, the IT webhook subscription is created, and the `continuit` / `office-check-in` tags and the unattended requester already exist in IT. Joint acceptance in IT as with Simorgh (one ticket end to end), then you switch the endpoint.

## 10. Hand-over (out of band)

client_id, client_secret, webhook signing secret, sandbox workspace id, tag ids.
