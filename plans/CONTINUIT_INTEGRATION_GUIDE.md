# ContinuIT × Ticket Pulse — integration guide (go-live edition)

**For:** the ContinuIT team (office check-ins), moving from FreshService to Ticket Pulse.
**Answers:** "ContinuIT ↔ Ticket Pulse — Integration request", rev. 2, 15 Sep 2026. Section letters below (A, R, B, C, D, E, F) are yours. `plans/SIMORGH_INTEGRATION_GUIDE.md` stays the long-form reference for anything not repeated here.
**Ticket Pulse version:** 3.9.73 (23 Sep 2026; search added — §11). **Status:** live in IT. Decision from Vahid: **no sandbox round — go straight to IT.** The sandbox workspace exists if you ever want a scratch space, but acceptance happens on real tickets.

---

## 1. In one page

- **One credential** in the IT workspace, OAuth2 client-credentials, **trusted intake ON**, your 32-address allowlist applied, default source **105 "Office Check-in"**. What you file is final: Ticket Pulse never re-categorises, re-types, re-prioritises, review-flags or noise-closes a ticket you created. It assigns **only when you leave the assignee out**.
- **Everything on your list is built.** Due date on create and update (B1). Assignee on create, by e-mail (B4). Agents with origin, groups and FreshService id (C1). Contacts by office with department and title (C3). Categories with description and active flag (B6). Batch read by ids (C2). A per-subscription `externalRefPrefix` filter on webhooks (D2).
- **Requester** `continuit@bgcengineering.ca` is *unattended*: Ticket Pulse never e-mails it. Real requesters (the office contact, B3) get the normal acknowledgement and status mail and are enriched from Entra.
- **Webhooks** to `https://continuit-api.azurewebsites.net/api/webhooks/ticketpulse`, Standard-Webhooks signed, limited to tickets whose `externalRef` starts with `continuit:`.
- **Migration:** nothing to do. Legacy FreshService tickets run their course; you can read them through Ticket Pulse and their changes fire your webhooks (F2/F3).
- **New since you reviewed 3.8.66:** ticket relations (parent/child, links, merge, split), ticket tasks with your own keys, the ready-to-close roll-up, and eight more webhook events. Section 9 explains them; they were built for Simorgh and are yours to use.

## 2. Identity (A1–A6)

| | IT (live) | Sandbox (optional scratch space) |
|---|---|---|
| Workspace | IT, workspace **1** | *ContinuIT Sandbox*, workspace **8** (native only, no FreshService mirror, no schedulers) |
| Client | **`tpc_1fb963c93a147540fa5bb2f9`** "ContinuIT", issued 19 Sep 2026 | `tpc_ca78630f5da17ec40a30c34a` |
| Token | `POST /api/v1/oauth/token`, `grant_type=client_credentials` → Bearer JWT carrying the scopes (fetch a new one after any scope change) | same |
| Scopes (A1) | `tickets:*`, `conversations:*`, `customfields:*`, `tags:*`, `search:read`, `agents:read`, `groups:read`, `categories:read`, `types:read`, `contacts:read`, `webhooks:read`, `tasks:*` | same |
| Trusted intake (A2) | on | on |
| Own-tickets-only guard | on — structural moves (merge, parent/child, links, split) are limited to tickets your credential created; a 403 `not_client_ticket` names the offender | on |
| Default source (A5) | **105 "Office Check-in"** — new code, shows in the queue's Source column and filter | 105 |
| IP allowlist (A4) | your 32 addresses from §2 of your document | none |
| Webhook subscription (D1/D2) | **#7** → `https://continuit-api.azurewebsites.net/api/webhooks/ticketpulse`, 12 events, `externalRefPrefix = continuit:` | #6, same URL, no prefix |
| Tags (B9) | `continuit` = **15**, `office-check-in` = **16** | 13 / 14 |
| Requester (A6) | `continuit@bgcengineering.ca`, id **3847**, unattended (shared across workspaces) | same |
| Base URL | `https://ticket-pulse-app.azurewebsites.net/api/v1` | same |
| Rate limit | 120 requests/min per credential (`X-RateLimit-*` headers; 429 carries `Retry-After`) | same |

Secrets (client secret, webhook signing secret) were printed once by the provisioning script and are handed over out of band — never in this document.

## 3. Creating a ticket — your shape works as written

```http
POST /api/v1/tickets
Idempotency-Key: continuit-task-6d129c88-v1

{ "subject": "Replace boardroom TV cable (Halifax)",
  "description": "<p>…</p><p>From the Halifax IT check-in on 9 Sep 2026.</p>",
  "priority": 2,
  "requesterEmail": "jordan.blake@bgcengineering.ca", "requesterName": "Jordan Blake",
  "ccEmails": ["priya.nair@bgcengineering.ca"],
  "category": "Audio Visual", "subcategory": "Meeting Room Equipment",
  "ticketType": "Service Request",
  "assignedTechEmail": "snasiri@bgcengineering.ca",
  "dueBy": "2026-12-09T17:00:00-08:00",
  "runAiTriage": false,
  "externalRef": "continuit:task:6d129c88-9438-4bef-b648-32718017422f",
  "customFields": { "continuitOffice": "Halifax", "continuitOfficeCode": "HFX",
                    "continuitMeetingId": "…", "continuitMeetingDate": "2026-09-09",
                    "continuitSeries": "IT Check-In & Support - Halifax",
                    "continuitTaskUrl": "https://continuit.bgcsaas.com/tasks/6d129c88-…" } }
```

| Field | Notes |
|---|---|
| `dueBy` (B1) | ISO datetime with offset. Stored with `dueBySetBy: "manual"`; the workspace SLA policy never recomputes it. Trusted-intake credentials only (403 `due_by_requires_trusted_intake` otherwise). `dueBy: null` on PATCH clears it and the SLA clock may own it again. |
| `assignedTechEmail` (B4) | The owner by e-mail, resolved to the active agent with that address in IT; unknown address → 400 `unknown_agent_email` before anything is written. `assignedTechId` still works and wins when both are sent. On PATCH, `""` unassigns. **An assignee on create means the assignment pipeline does not run.** |
| `externalRef` | Your per-record key. A second POST with the same ref **updates** the ticket (200, `resubmitted: true`) instead of creating a twin. A resubmission never touches status, assignee or due date — they belong to the people working the ticket — and lists them in `meta.ignoredFields` when you sent them. |
| `customFields` (B2/B10) | Keys are normalised to snake_case on first use, so `continuitOffice` and `continuit_office` are the same field, filtered as `cf_continuit_office`. Unknown keys auto-provision a definition; the type is inferred from the first value (`2026-09-09` → `date`, so `cf_continuit_meeting_date_gte` works). Your six keys are fine. |
| `category` / `subcategory` (B6) | By name against the **full IT taxonomy** (not only the Security branch). Unknown names 400 with the allowed values. |
| `internalGroupId` | Optional. Leave it out and the IT default internal group applies. |
| `source` | Optional; your credential's default (105) applies when omitted. |
| `Idempotency-Key` | Same key + same body → the same response replayed; same key + different body → 422 `idempotency_key_reused`. |

Response: `201` with the ticket (`ref` like `TP-1601`, `id`, `dueBy`, `assignee`, `source`, …). Every later URL accepts `TP-1601`, the id, or `#<freshservice id>`.

### 3a. Your automation rules (R1–R5) — all honoured

| Rule | How Ticket Pulse enforces it |
|---|---|
| R1 never re-categorise / re-type / re-prioritise | Trusted intake: the pipeline's persist step refuses to write category, subcategory, ticket type or priority for a trusted ticket, on every trigger. `impact`/`urgency` are never written by the pipeline for any ticket. |
| R2 ours wins when we send an assignee | Assignment runs once, on creation, and only when the ticket is unassigned. An assignee on POST (id or e-mail) means it never runs. Nothing re-assigns a ticket that has an owner. |
| R3 no `categoryReviewNeeded` | Nothing in Ticket Pulse sets that flag any more; it is a read-only analytics field. Your tickets never enter a review queue. |
| R4 no noise, no auto-resolve | Trusted intake is a veto in its own right: no noise rule may close your tickets. No auto-resolve workflow is installed for you. |
| R5 rebounds and manual re-runs | The guard sits in the persist step, so every trigger (rebound, manual re-run, priority pass, sync) obeys R1 and R2. |

## 4. Updating, reading, reconciling

- `PATCH /tickets/{id}` — `subject`, `priority`, `category`/`subcategory`, `internalGroupId`, `ccEmails`, **`dueBy`**, `status` (+ optional `resolutionReason`/`resolutionNote`), `assignedTechId` / **`assignedTechEmail`**, `customFields` (merge), `addNote`. One call, several changes. B8: a resolution reason is required only for Security tickets; yours resolve without one.
- B7: IT has five labels — **Open, Pending, Pending Response, Resolved, Closed** — over the four bases Open / Pending / Resolved / Closed. Key on `GET /meta → statusDetails[].baseStatus`, as you planned; "Pending Response" then folds into Pending.
- `GET /tickets/{id}` — read shape with `dueBy`, `dueBySetBy` (`manual` = yours, `sla` = the clock), `source`, `assignee { id, name, email }`, `relations`, `readyToCloseAt`, `externalRef`, `customFields`. (Your sandbox finding of 19 Sep — the date was stored but not echoed — is fixed in 3.9.55; the `POST` 201 body and every webhook `data.ticket` carry `dueBy` too.)
- **C2** `GET /tickets?ids=1601,TP-1602,1603&limit=100` — ids or TP-refs, mixed, up to 200 per request; pages are 100 at most, so follow `next_cursor` past that.
- Sweep: `GET /tickets?externalRefPrefix=continuit:&updatedFrom=<watermark>` (cursor pagination; `limit` up to 100). `GET /tickets/{id}/activities` for who did what (`due_changed` rows carry `changes.dueBy.from/to`).
- Notes (E1): `POST /tickets/{id}/notes { "body": "…", "agent": "ContinuIT · Halifax check-in (9 Sep)" }` — `agent` (≤ 60 chars) is accepted without `stage` and becomes the author line. E2 attachments: not on v1 yet; keep the link in the description.

## 4a. People sync (C1, C3, C4, C5)

```http
GET /api/v1/agents?active=true
→ [{ "id": 56, "name": "Soheil Nasiri", "email": "snasiri@bgcengineering.ca", "isActive": true,
     "origin": "freshservice", "freshserviceId": "1002090111", "location": "Vancouver", "photoUrl": null,
     "groups": [{ "id": 12, "name": "IT Operations", "origin": "freshservice", "freshserviceId": "1000210021" }] }]

GET /api/v1/contacts?location=Halifax&limit=500
GET /api/v1/contacts?email=jordan.blake@bgcengineering.ca
→ [{ "id": 3, "name": "Jordan Blake", "email": "…", "phone": null, "department": "Geotechnical",
     "jobTitle": "Office Manager", "location": "Halifax", "unattended": false }]
```

- C1: `origin` is `freshservice` or `local`; `freshserviceId` is a string (64-bit); `groups[]` covers internal and FreshService groups. `?includeInactive=false` (or `?active=true`) narrows to active agents; the default returns everyone with `isActive`. No pagination — IT has a few dozen agents, the list is one page. Ticket Pulse does not store the Entra object id of technicians; join on e-mail.
- C3: `location` is the Entra office (contains, case-insensitive). `department` and `jobTitle` come from FreshService or Entra, whichever is filled.
- C4: a requester created implicitly from `requesterEmail` is enriched from Entra (display name, title, department, office) exactly like one who e-mails the help desk, and gets the normal acknowledgement and status e-mails (B3). The unattended `continuit@` requester is the only exception.
- C5: agreed — no people webhooks; a nightly pull is fine.

## 5. Webhooks (D1, D2, D3)

Subscription **#7** on `https://continuit-api.azurewebsites.net/api/webhooks/ticketpulse`, events:
`ticket.created`, `ticket.status_changed`, `ticket.assigned`, `ticket.reply_received`, `ticket.public_reply_added`, `ticket.fields_updated`, `ticket.custom_fields_changed`, `ticket.tags_changed`, `ticket.note_added`, `task.created`, `task.updated`, `task.completed`.

- **D2 built:** the subscription carries `externalRefPrefix = continuit:`. You receive only events whose ticket's `externalRef` starts with it — never the rest of IT. Keep your own check as belt and braces if you like; it is no longer needed.
- D3: the envelope is the Simorgh one — `{ type, event, timestamp, workspaceId, data }`, with `data.ticket` (id, ref, externalRef, status, priority, dueBy, resolutionReason, `externalReferences`), `data.extra.from/to` on status and assignment changes, `data.actor`, `data.assignedAgent { name, email, technicianId }`. Due-date edits arrive as `ticket.fields_updated` with `changedFields` containing `dueBy`.
- Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature` over `id.timestamp.body`), retries with backoff for 8 attempts, auto-disable after 20 consecutive failures (re-enable in Settings → API keys & webhooks). Dedupe on `webhook-id`.
- Want more? Any of the 19 events in §9.4 can be added to the subscription by an admin.

## 6. Migration (F2, F3, F4)

- **F2:** the IT workspace ingests every FreshService ticket — a 5-minute sync, a 1-minute fast lane for unassigned tickets, and the FreshService webhook for immediate changes — so `GET /tickets/#<fs id>` finds each legacy ticket.
- **F3:** a status or assignee change that reaches Ticket Pulse through the FreshService ingest **does** fire `ticket.status_changed` / `ticket.assigned` (and `ticket.fields_updated` with the FreshService-side diff), with `actorKind: "freshservice"` and `data.ticket.externalReferences: [{ "system": "FRESHSERVICE", "id": "<fs id>" }]`. Note the D2 prefix filter: legacy tickets have no `continuit:` externalRef, so they are **not** delivered to your filtered subscription. If you want the legacy lane over webhooks, tell us and we add a second, unfiltered subscription for the status/assignment events only (you then filter on `externalReferences`), or you keep the read-through poll for those ~58 tickets until the lane empties.
- **F4:** send the 220 FreshService ids and we bulk-tag them `continuit-legacy` on our side.

## 7. What is different from your document

| Yours | Ours |
|---|---|
| A3 sandbox first, then IT | Straight to IT (Vahid's call). Sandbox ws 8 exists; use it if you want. |
| B2 first-class location field? | No. The custom field is the intended pattern; `cf_continuit_office` filters the queue and the API alike. A grouped-by-office queue view is a UI item we can add later if the office managers ask. |
| B6 `sortOrder` | Not stored; rows come in name order. |
| C1 pagination, Entra object id | Neither: the agent list is one page, and technicians carry no Entra id. Join on e-mail. |
| D2 "ignore events whose externalRef ≠ continuit:" | Done server-side by the subscription filter; legacy FreshService tickets therefore do not reach this subscription (see F3). |

## 8. Go-live acceptance (your §8, run in IT)

1. Token → `GET /me` shows workspace 1 and the scopes → `/meta` (statuses, `sources` includes 105), `/categories`, `/agents?active=true`, `/groups`, `/tags`, `/custom-fields`.
2. `POST /tickets` with `externalRef`, six custom fields, real requester, `assignedTechEmail`, `dueBy` → 201; read back identical; `source` = 105; the requester receives the acknowledgement. Idempotency replay → same ticket; replay with a different body → 422.
3. `PATCH` status Open → Pending → Resolved (no reason) → Closed; `priority`; `assignedTechEmail`; `dueBy`; custom-field merge. `GET …/activities` shows `due_changed`.
4. Private note with `agent` → author "ContinuIT · …".
5. Re-POST the same `externalRef` with an edited description → 200 `resubmitted: true`, status untouched.
6. `GET /tickets?ids=…`, `externalRefPrefix=continuit:&updatedFrom=…`, `tag=continuit`, cursor paging.
7. Webhooks: create, status change, assignment, note, custom-field change arrive signed; a ticket without `continuit:` is not delivered.
8. Create without an assignee → within a minute `ticket.assigned` arrives; category, type and priority are exactly as sent.
9. Read a legacy ticket by `#<fs id>`.
10. 40 creates in a minute stay under the limit.

## 9. New since 3.8.66 — features you may want

Built for Simorgh in September; every one is in your scopes.

### 9.1 Parent / child tickets
A check-in that produces several tasks can be **one parent with children**. `POST /tickets/{parent}/children { "child": "TP-1602" }` or `PUT /tickets/{child}/parent { "parent": "TP-1600" }`; `DELETE /tickets/{child}/parent` detaches. `GET /tickets/{id}` → `relations { parent, children[], mergedInto, links[] }`.
**Roll-up rule:** a parent **cannot be closed while any child is open** (409 `open_children` lists them). When the last child closes, the parent is **not** auto-closed: it gets a "ready to close" mark (`readyToCloseAt`), its owner is e-mailed, a `ready_to_close` activity is written and `ticket.ready_to_close` fires. A person (or your app) then closes it.

### 9.2 Links
`POST /tickets/{id}/links { "related": "TP-1580", "kind": "related_to" | "duplicate_of" }` — `related` also takes a FreshService number (`"#241155"`). `GET …/links`, `DELETE …/links/{linkId}`. Fires `ticket.linked`.

### 9.3 Merge and split
- `POST /tickets/{source}/merge { "target": "TP-1580", "notifyRequester": false }` closes the source (the ticket in the URL) as `duplicate` — reason stamped automatically — copies its thread into the target and fires `ticket.merged`. `POST /tickets/{target}/merge-many { "sources": ["TP-1603", "TP-1604"] }` for clean-up, one result per source.
- `POST /tickets/{id}/split { "subject": "…", "entryIds": [...] }` carves a new ticket out of a conversation; fires `ticket.split`.
- Your credential has the **own-tickets-only guard**: merge/parent/link/split are limited to tickets ContinuIT created (403 `not_client_ticket` otherwise), so a bug in your app can never restructure someone else's IT ticket.

### 9.4 Tasks on a ticket
`POST /tickets/{id}/tasks { "title", "description", "dueAt", "assignedTechId" | none, "externalRef": "continuit:step:…", "remindBeforeMinutes" }`. Leave the assignee out and the task **belongs to the ticket owner** (they are alerted, get the due reminder, and inherit open tasks on hand-over). `externalRef` is create-or-return: a repeat returns the existing task (200, `existing: true`). `PATCH …/tasks/{taskId}` (`status: open | in_progress | done`), `DELETE`. Events `task.created`, `task.updated` (coalesced 60 s), `task.completed` — already on your subscription. Use tasks for the checklist inside one ticket; use children (9.1) when each step needs its own owner, due date and status.

### 9.5 All webhook events (19)
`ticket.created`, `ticket.status_changed`, `ticket.assigned`, `ticket.reply_received`, `ticket.public_reply_added`, `ticket.note_added`, `ticket.tags_changed`, `ticket.custom_fields_changed`, `ticket.fields_updated`, `ticket.ready_to_close`, `ticket.linked`, `ticket.parent_changed`, `ticket.merged`, `ticket.split`, `task.created`, `task.updated`, `task.completed`, `approval.requested`, `approval.decided`. Relation payloads carry `parent` / `child` / `target` / `source` ticket refs (`id, ref, subject, status, externalRef`) and an `actor`.

### 9.6 Also useful
- `GET /tickets/{id}/activities` is the full audit feed (status, assignment, due, relations, tasks, notes).
- `GET /meta` lists `resolutionReasons` and `sources` so nothing is hard-coded.
- Resolution `resolutionReason` / `resolutionNote` on a resolving PATCH, optional for you.

## 10. Hand-over (out of band)

IT `client_id` + `client_secret`, webhook signing secret. Sandbox pair from 19 Sep still valid if wanted.

## 11. Finding a ticket that already exists (search request, 23 Sep 2026)

Your "ticket search for meeting follow-ups" request is live in IT. Requests 1, 2 and 3 are all built. Nothing new is needed on the credential: `search:read` is already in your scopes.

### 11.1 `POST /api/v1/search/similar`

```http
POST /api/v1/search/similar
{ "text": "Replace the failing firewall at the Fredericton office once the shipment arrives",
  "limit": 5, "minScore": 0.5,
  "status": ["open", "pending"],
  "updatedFrom": "2026-06-01",
  "excludeExternalRefPrefix": "continuit:",
  "requesterEmail": "om@bgcengineering.ca",
  "department": "Fredericton" }
```

Every field except `text` is optional, with the defaults you proposed. The response is exactly your shape, best first, plus `office` (the requester's Entra office) and a `meta` block:

```json
{ "data": [ { "id": 45790, "ref": "TP-1591", "subject": "Fredericton firewall replacement",
              "status": "Open", "baseStatus": "open", "score": 0.82, "matchedOn": "semantic",
              "requester": { "name": "…", "email": "…" }, "assignee": { "name": "…", "email": "…" },
              "department": "…", "office": "Fredericton",
              "createdAt": "…", "updatedAt": "…", "dueBy": null,
              "externalRef": null, "externalReferences": [{ "system": "FRESHSERVICE", "id": "243301" }],
              "url": "https://ticketpulse.bgcsaas.com/tickets/45790",
              "snippet": "first ~200 characters of the description" } ],
  "meta": { "scoreModel": "2026-09-23", "thresholds": { "likely": 0.7, "possible": 0.6 },
            "semantic": true, "candidates": 980, "embedded": 980, "truncated": false, "tookMs": 310 } }
```

How it ranks:

- **Semantic.** Your text is embedded with the same model as the stored ticket vectors (subject + description).
- **Keyword.** Postgres full-text search on subject and description. This is what catches exact names like "BGC1" or "A82". A mixed letter-and-digit token that appears in a ticket lifts it to at least 0.75.
- **References.** `TP-1591` or `#241406` in the text returns that ticket with score 1.
- **Tickets without a vector** are still found by the keyword half. They come back as `matchedOn: "keyword"`, capped at 0.6.
- **FreshService-born tickets** are included, with `externalReferences` filled. Every open IT ticket now has a vector: we embedded the 626 open FreshService tickets that were missing one, and the nightly job now covers every open ticket regardless of age.
- **`department`** is treated as an office name. The same office named in your text and in the ticket lifts the score. A different named office lowers it. It is never a filter.
- **`requesterEmail`** adds 0.05 when it matches. It is never a filter.

### 11.2 What the score means (please read before setting thresholds)

`score` is calibrated, not raw cosine similarity. With these embeddings every IT ticket "sounds like" every other one: unrelated IT phrases reach 0.55–0.70 raw cosine, so a raw threshold cannot tell "same work" from "same kind of work". The score blends how close the ticket is, how far it stands out from the rest of the open tickets, how far it leads the runner-up, and whether the offices agree. It was fitted on 165 meeting-style sentences against the 588 open IT tickets and checked on held-out data:

| Your threshold | True matches flagged (in the top 3) | Unrelated sentences flagged |
|---|---|---|
| 0.6 ("worth asking") | about 80% | about 20% |
| 0.7 ("likely the same work") | about 75% | about 10% |

On a fresh run of 30 meeting-style paraphrases and 15 unrelated IT items, which the fit never saw:
- All 30 paraphrases had the right ticket in the top 3, and 28 had it first.
- 29 of the 30 scored 0.6 or more.
- 3 of the 15 unrelated items scored 0.6 or more.

The unrelated items that score high are nearly always same-office work in a neighbouring area, for example "replace the UPS batteries in the Kelowna network closet" against "Kelowna office firewall replacement". Your **Not the same** button is the right answer to those. We recommend prompting at 0.6 as you planned, and wording the card as a question.

`score` is comparable across calls as long as `meta.scoreModel` stays the same. If we ever re-calibrate, the version changes and we will tell you first.

### 11.3 `POST /api/v1/search/similar/batch` (Request 2)

```http
POST /api/v1/search/similar/batch
{ "items": [ { "key": "extracted-1", "text": "…" }, { "key": "extracted-2", "text": "…" } ],
  "limit": 3, "minScore": 0.55 }
→ { "data": { "extracted-1": [ …hits… ], "extracted-2": [] }, "meta": { … } }
```

Up to 20 items; keys must be unique; the options are shared. One embedding request serves the whole batch, so one meeting review costs one call.

### 11.4 Speed and limits

- **Timings measured** from outside Azure against production: median 0.4 s, worst 1.0 s for a single search, and 1.6 s for a batch of 10. Inside Azure it is faster.
- **First call after a restart** also loads the ticket vectors, so allow about a second more.
- **Rate limit:** 120 requests per minute per credential, as before.
- **Repeated texts** are cached, so calling again for the same sentence is cheap.
- **Statuses:** the default is open plus pending, about a thousand IT tickets. Resolved and closed history runs to about 21,000 tickets. Pass `updatedFrom` with those statuses; at most the 5,000 most recently updated tickets are compared, and `meta.truncated` tells you when that cap was hit.

### 11.5 Keyword search over more than the subject (Request 3)

`GET /api/v1/search/tickets?query=lenovo calgary&in=subject,description,conversations&limit=25`

- Full-text search with English stemming. Subject hits rank first, then description, then conversation text.
- `limit` goes up to 50. There is no cursor in this mode.
- `conversations` needs `conversations:read`, which you have.
- Without `in`, the old substring search on subject, requester and number is unchanged.

### 11.6 Linking a task to an existing ticket — use a tag and a custom field, not `externalRef`

Your document proposed setting `externalRef = continuit:task:<id>` on the ticket you link to. That will fail more often than it works:
- `externalRef` is set once. A ticket that already has one returns 409 `external_ref_immutable`, and every Simorgh ticket and every ticket you created already has one.
- One ref names one ticket, so two meetings could never link to the same ticket.

Link like this instead:

```http
POST  /api/v1/tickets/TP-1591/tags          { "name": "continuit" }
PATCH /api/v1/tickets/TP-1591               { "customFields": { "continuit_task_ids": "6d129c88,9a1f03bb" } }
```

- **Adding the tag.** `POST …/tags` adds one tag and keeps the ones already there. `PUT …/tags` replaces the whole set, so never use it on a ticket someone else tags. `DELETE /api/v1/tickets/{id}/tags/continuit` removes just that tag when you unlink.
- **Recording the task ids.** `continuit_task_ids` is a plain text field holding a comma-separated list of your task ids. Your trusted credential creates the field on first write. Read the current value from `GET /tickets/{id}`, then write the new list.
- **Webhooks for linked tickets.** Subscription #7 now also delivers events for tickets tagged `continuit`, alongside tickets whose `externalRef` starts with `continuit:`. A linked ticket's status changes, assignments and notes therefore reach you like your own tickets do.
- **Reconciliation.** Your 30-minute sweep should add `GET /tickets?tag=continuit&updatedFrom=…` to the `externalRefPrefix=continuit:` query.
- **What doesn't change.** Tickets you create keep `externalRef = continuit:task:<id>` as now. Linking is only for tickets that already existed.

### 11.7 Your acceptance test

Every step of your plan works as written. Before you run steps 1 and 2 with your own phrases, expect the following. Step 1 should pass at 0.6. Step 2 ("none above 0.5") will fail for some phrases if they are same-office neighbours of a real ticket (see 11.2). In that case the question to ask is whether the top hit was a reasonable "is this it?", not whether the score stayed low.
