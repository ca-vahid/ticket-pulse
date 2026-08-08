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
| `ccEmails` | Array of cc addresses, stored and shown on the ticket. |
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
   `Idempotency-Key: concat('sp-', triggerOutputs()?['body/ID'])` — the
   per-item key makes Power Automate's automatic retries (and resubmits)
   at-most-once. Turn on **Settings → Secure Inputs** once tested.
3. Body: the JSON above with dynamic content (`Title`, `Created By Email`,
   `Link to item` → `customFields.sharePointItemLink`). Keep free text out of
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
