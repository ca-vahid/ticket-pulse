# Ticket Pulse Integration API (v1)

Key-authenticated, workspace-scoped REST API — a FreshService-replacement
surface for creating and querying tickets from other systems.
Base path: `https://ticketpulse.bgcsaas.com/api/v1`.

**The living reference is the API itself**: human docs at
[`/api/v1/docs`](https://ticketpulse.bgcsaas.com/api/v1/docs) (includes the
intake-enrichment guide and the Power Apps / Power Automate sender guide) and
the machine-readable spec at `/api/v1/openapi.json` (OpenAPI 3.1). This file is
the repo-side summary.

## Authentication

Two options, both resolving to a single workspace:

1. **API key** (simplest). Issue in **Settings → API Keys**, scoped to exactly
   what the integration needs. The raw key (`tp_live_…`, or `tp_test_…` for a
   read-only test key) is shown **once**. Legacy `tpk_…` keys keep working.
   Keys can be rotated, disabled, IP-allowlisted, and given expiry dates.
2. **OAuth2 client-credentials** (for apps). Create a client in **Settings →
   API Keys → OAuth clients**, exchange at `POST /api/v1/oauth/token` for a
   short-lived bearer token.

Send on every request:

```
Authorization: Bearer tp_live_xxxxxxxxxxxxxxxx
```

Rate limits: **120 req/min per key** (overridable per key) + 300 req/min per
IP; every response carries `X-RateLimit-*` and `X-Request-Id`; `429` includes
`Retry-After`. Errors are RFC 9457 `application/problem+json` with a stable
`code`. Send `Idempotency-Key: <unique>` on writes to make retries safe
(same key + same body replays the cached response).

### Scopes

Deny-by-default `resource:action` scopes with wildcards (`tickets:*`, `*:read`,
`*`): `tickets`, `conversations`, `contacts` (read), `agents` (read), `groups`
(read), `tags`, `categories` (read), `types` (read), **`customfields`**,
`tasks`, `timeentries`, `approvals`, `attachments`, `webhooks`
(read/manage), `search` (read). `customfields:write` is demanded only when a
create/update payload actually carries `customFields`.

## Surface (summary — see `/api/v1/docs` for all endpoints)

- **Tickets**: list/search (cursor or offset pagination), get with public
  conversation, create, PATCH (status/priority/assignee/subject/group/category/
  custom fields), merge, parent/child links.
- **Conversations**: full thread incl. private notes; post replies (emails the
  requester; FS-born tickets reply through FreshService) and internal notes.
- **Tasks, approvals, attachments, tags** per ticket.
- **Directory/taxonomy**: contacts, agents, groups, categories, types,
  **`GET /custom-fields`** (active custom-field definitions incl. which were
  auto-provisioned by API intake — `source: "api"` vs `"manual"`).
- **Outbound webhooks** (Settings → API Keys → Outbound webhooks): Standard
  Webhooks-signed deliveries; payloads carry `customFields` + category names.

## Creating tickets — intake enrichment (FR 08-05)

`POST /tickets` accepts, beyond `subject` (required), `description`,
`priority`, `requesterEmail` (required), `requesterName`, `runAiTriage`:

| Field | Behavior |
|---|---|
| `category` / `subcategory` | **By name**, case-insensitive against the workspace taxonomy; a wrong name 400s listing the allowed values (nothing is created). Subcategory must be a child of category. |
| `customFields` | Object of scalar values. Keys normalize to snake_case (`clientName` → `client_name`); known keys validate against their definition; **unknown keys auto-provision** a definition (type inferred, `source:'api'`, active immediately, curatable in Settings → Ticket Ops → Custom fields). Nothing is silently dropped — unusable entries return in `meta.rejectedCustomFields` `{key, reason}`. Caps: ≤40 keys/request, ≤2000 chars/value, ≤200 definitions/workspace. Requires `customfields:write`. |
| `ccEmails` | **Additional requesters ("Also for")** — array of cc addresses stored on the ticket. Normalized (lowercase), deduped, max 10; an invalid address 400s. See "Additional requesters / carbon copies" below. |
| `source` | Arrival-channel override (1 Email, 2 Portal, 3 Phone, 9 Walk-up, 102 MS Teams, 103 Agent); defaults to 100 = API. |
| `ticketType` (alias `type`) | Type by name from the workspace registry; omitted → default. |

Unknown **top-level** keys are dropped but reported via `meta.ignoredFields` —
extra data belongs inside `customFields`. The `201` response also carries
`meta.provisionedCustomFields`. `PATCH /tickets/{id}` merges `customFields`
but **never auto-provisions** — unknown keys → `422 unknown_custom_fields`
naming every offender.

```json
{
  "subject": "Coyote Landslide",
  "priority": 2,
  "requesterEmail": "jdoe@bgcengineering.ca",
  "category": "Project Setup",
  "subcategory": "Quebec",
  "customFields": {
    "clientName": "ACME Inc",
    "powerAppRecordId": "1260",
    "sharePointItemLink": "https://…/DispForm.aspx?ID=1260",
    "sourceRequestType": "Project Setup"
  }
}
```

Route on the metadata with workflows: condition
`custom:source_request_type is "Project Setup"` → update-ticket "Category by
name". The installable **API intake router** workflow template is exactly this.

## Resubmissions — `externalRef` (upsert on `POST /tickets`)

A form that is submitted twice (Power Apps re-submit, an edited SharePoint
item, a re-run flow) must **update** the ticket it already created, not open a
duplicate. Send your stable **per-record** key as `externalRef` (opaque,
≤200 chars, unique per workspace):

| First POST with a ref | `201` — created, `externalRef` stored (read back on every ticket shape). `meta.resubmitted: false`. |
|---|---|
| **Later POST, same ref** | `200` + top-level **`resubmitted: true`**. The existing ticket is updated: `subject`/`priority`/`ticketType`/`category`/groups/`ccEmails` replace-if-changed; the new `description` is **appended** as a dated "— Resubmitted … via API key …—" revision block (never replaced; `resubmitStrategy: "replace"` opts out); `customFields` **merge** (unknown keys still auto-provision); a **private** note carries the before/after table; `meta.changedFields` lists what changed. **Status and assignee are never touched.** |
| Identical re-send | `200`, `meta.changedFields: []` — nothing written, no note. |
| Matched ticket is **Resolved** | reopened to the workspace's default Open status (`meta.reopened: true`); `reopenOnResubmit: false` leaves it Resolved and creates a linked new ticket instead. |
| Matched ticket is **Closed** | never reopened: a **new** ticket is created (`201`), linked `related_to` the old one, and the `externalRef` moves to it (`meta.priorExternalRefTicket`, `meta.linkedToTicket`). |
| Same ref, different workspaces | independent tickets (the key is per workspace). |

AI: a resubmission that changed the subject or description queues a
**classification-only** AI pass when the ticket is unassigned or its category
was AI-set (`meta.aiRetriage`) — the full assignment pipeline never re-runs, so
a resubmission can never bounce a ticket away from its agent.

**`externalRef` ≠ `Idempotency-Key`.** The header is per *run* (retry
protection: same key + same body replays; same key + *different* body is a
`422 idempotency_key_reused`). The body field is per *record*. Using the record
id for both makes every resubmission a 422 before the upsert logic runs.

```json
{ "subject": "Coyote Landslide — revised", "priority": 3,
  "requesterEmail": "jdoe@bgcengineering.ca",
  "externalRef": "sp-projectrequests-1260",
  "description": "Client moved the start date to October.",
  "customFields": { "powerAppRecordId": "1260", "clientLocation": "Montreal" } }
```
```json
{ "success": true, "resubmitted": true,
  "data": { "id": 501, "ref": "TP-1042", "externalRef": "sp-projectrequests-1260", "priority": 3, "…": "…" },
  "meta": { "resubmitted": true, "ticketRef": "TP-1042",
            "changedFields": ["priority", "description", "customFields"],
            "reopened": false, "aiRetriage": { "queued": false }, "matchedBy": "external_ref",
            "ignoredFields": [], "rejectedCustomFields": [], "provisionedCustomFields": [] } }
```

`PATCH /tickets/{id}` accepts `externalRef` **set-once** for tickets created
without one (`409 external_ref_immutable` if a different ref is already set,
`409 external_ref_taken` if another ticket owns it).

**No sender change needed (bridge).** If the payload already carries a
per-record value inside `customFields` (ws5 posts `powerAppRecordId` →
stored key `power_app_record_id`), an admin sets Settings → Ticket Ops →
**API resubmissions → Match on a custom field** to that field: the ref is
derived from it (stored as `pa-<value>`, `meta.matchedBy: "custom_field_key"`)
and resubmissions work with today's payload. A deprecated requester + subject
heuristic (same API key, Open/Pending, within N days) exists behind a
workspace toggle for the transition; when more than one ticket fits it creates
normally and flags `meta.resubmissionAmbiguous` with the candidate refs.

## Additional requesters / carbon copies (`ccEmails`)

A ticket has ONE primary requester (`requesterEmail`) plus an optional
**"Also for"** list — additional requesters carried as `ccEmails` on the
ticket (the same field the app's create form and ticket page label
*Also for (additional requesters)*).

What the list does:

- **Every public reply** to the requester is sent To the requester and Cc the
  list (deduped, the requester never duplicated). A per-reply `cc` on
  `POST /tickets/{id}/replies` is **unioned** with the ticket list, not a
  replacement.
- The FreshService fallback copy carries the list as `cc_emails` (create and
  later edits), so FS-side replies reach them too.
- **Lifecycle mails** (created / status changed / resolved workflow sends whose
  To is the requester) cc the list **only when** the workspace toggle
  *Settings → Ticket Ops → Additional requesters → "Also notify additional
  requesters"* is on (default off). CSAT surveys are always primary-only.

Surface:

| Where | Behavior |
|---|---|
| `POST /tickets` `ccEmails` | Initial list. |
| `PATCH /tickets/{id}` `ccEmails` | **Replaces** the list (`[]` clears it). Ticket Pulse–born tickets only — on a FreshService-born ticket the list is FreshService-owned (the app's FS write-back edits it there; the API returns 400). |
| `GET /tickets/{id}` / list items | `ccEmails: string[]` (always present, `[]` when none). |

Validation: addresses are trimmed + lowercased, duplicates collapse, max **10**
after dedupe, and an invalid address rejects the whole request (400).

```bash
curl -X PATCH "$BASE/api/v1/tickets/1084" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{ "ccEmails": ["manager@example.com", "assistant@example.com"] }'
# → { "data": { "ref": "TP-1084", "ccEmails": ["manager@example.com", "assistant@example.com"], … } }
```

## Groups — `groupId` vs `internalGroupId`

`GET /groups` lists both kinds of group, distinguished by `origin`:

| `origin` | What it is | How tickets address it |
|---|---|---|
| `freshservice` | Synced from FreshService | `groupId` = the row's **`freshserviceId`** (not its `id`) |
| `local` | Internal (TP-native) group | `internalGroupId` = the row's **`id`** |

Tickets read the placement back as `group` (FS) or `internalGroup`
(internal). When a create sends neither field, the workspace's default
internal group — if configured — applies automatically.

**Worked example — assign to the internal "Project Accounting" group:**

```bash
# 1. Find the group; origin:'local' → use its id as internalGroupId
curl https://ticketpulse.bgcsaas.com/api/v1/groups \
  -H "Authorization: Bearer tp_live_xxx"
# → { "data": [ { "id": 3458, "name": "Project Accounting",
#                 "origin": "local", "freshserviceId": null }, … ] }

# 2a. Create straight into the group…
curl -X POST https://ticketpulse.bgcsaas.com/api/v1/tickets \
  -H "Authorization: Bearer tp_live_xxx" -H "Content-Type: application/json" \
  -d '{ "subject": "New AP project", "requesterEmail": "jdoe@bgcengineering.ca",
        "internalGroupId": 3458 }'

# 2b. …or move an existing ticket (clear the other field when switching kinds)
curl -X PATCH https://ticketpulse.bgcsaas.com/api/v1/tickets/TP-1076 \
  -H "Authorization: Bearer tp_live_xxx" -H "Content-Type: application/json" \
  -d '{ "internalGroupId": 3458, "groupId": null }'
```

The response carries `"internalGroup": { "id": 3458, "name": "Project
Accounting" }`. For a FreshService group instead, send `groupId` = the row's
`freshserviceId` (e.g. `1000210021`) — its `id` would be rejected.

## Power Automate recipe (compact)

Full guide (licensing, escaping, Parse JSON schemas, custom-connector notes):
`/api/v1/docs` → "Calling from Power Apps / Power Automate"; research notes in
[`docs/research/POWER_PLATFORM_API_NOTES.md`](research/POWER_PLATFORM_API_NOTES.md).

1. Trigger: SharePoint **"When an item is created"** (or Power Apps V2).
2. **HTTP** action (Premium): `POST https://ticketpulse.bgcsaas.com/api/v1/tickets`,
   headers `Content-Type: application/json`,
   `Authorization: Bearer tp_live_…`,
   `Idempotency-Key: workflow()?['run']?['name']` — per **run**, so Power
   Automate's automatic retries are at-most-once. Turn on **Settings → Secure
   Inputs** once tested.
3. Body: the JSON above with dynamic content (`Title`, `Created By Email`,
   `Link to item` → `customFields.sharePointItemLink`) **plus
   `"externalRef": concat('sp-projectrequests-', triggerOutputs()?['body/ID'])`**
   — per **record**, so a re-submitted item updates its ticket (`200`,
   `resubmitted: true`) instead of creating another. Keep free text out of
   hand-typed JSON strings (quote/newline escaping).
4. **Parse JSON** over `body('HTTP')`, then SharePoint **"Update item"**
   writing back `ref` (`TP-1042`) and `id`.
5. Error branch (**run after → has failed**): Parse JSON with the problem+json
   shape (`title/status/code/detail/request_id`), alert with `code` + `detail`.

## Notes

- Creating tickets requires **native ticketing enabled** on the workspace.
- `origin: "freshservice"` tickets are readable and reply-able, not editable;
  TP-born tickets (`TP-<n>`) are fully editable and mirrored to FreshService
  as fallback copies.
- Test-mode keys (`tp_test_…`) are read-only — writes return
  `403 test_mode_read_only`.
