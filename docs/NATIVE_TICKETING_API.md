# Ticket Pulse Integration API (v1)

Key-authenticated REST API for creating and querying native tickets from other
systems. Base path: `https://<your-ticket-pulse-host>/api/v1`.

## Authentication

Create a key (workspace admin): `POST /api/tickets/api-keys` with
`{ "name": "My integration", "scopes": ["tickets:read", "tickets:write"] }`
— the raw key (`tpk_…`) is returned **once**; store it securely.

Send it on every request:

```
Authorization: Bearer tpk_xxxxxxxxxxxxxxxx
```

Keys are workspace-scoped (the key determines the workspace), can be disabled
or deleted at any time, and are rate-limited to **120 requests/minute** each
(HTTP 429 + `Retry-After` beyond that).

| Scope | Grants |
|---|---|
| `tickets:read` | `GET /tickets`, `GET /tickets/:id` |
| `tickets:write` | `POST /tickets`, `POST /tickets/:id/replies` |

## Endpoints

### `GET /api/v1/tickets`
Query parameters: `status` (comma list: Open,Pending,Resolved,Closed),
`priority` (1–4, comma list), `origin` (`ticketpulse` \| `freshservice`),
`assignedTechId` (`unassigned` or an id), `q` (search subject / requester /
`TP-1042` / `#12345`), `page`, `pageSize` (≤100), `sort`
(`createdAt|updatedAt|priority|status`), `dir` (`asc|desc`).

```json
{ "success": true, "data": { "items": [ { "id": 12, "ref": "TP-1042", "origin": "ticketpulse", "subject": "…", "status": "Open", "priority": 3, "requester": { "name": "…", "email": "…" }, "assignee": null, "category": "Devices & Hardware", "createdAt": "…", "updatedAt": "…" } ], "total": 1, "page": 1, "pageSize": 25 } }
```

### `GET /api/v1/tickets/:id`
Full ticket incl. `description` and the conversation `thread`
(`[{ id, type, author, authorType, isPrivate, body, at }]`).

### `POST /api/v1/tickets`
```json
{
  "subject": "Printer jammed on 3rd floor",
  "description": "<p>optional HTML</p>",
  "priority": 2,
  "requesterEmail": "person@company.com",
  "requesterName": "Optional Name",
  "runAiTriage": true
}
```
Creates a TP-born ticket (native number, AI triage unless disabled, workflow
acknowledgement email, FreshService fallback mirror). Returns `201` with the
ticket shape above.

### `POST /api/v1/tickets/:id/replies`
```json
{ "body": "Plain-text reply to the requester" }
```
Posts a public agent reply (the requester is emailed; FS-born tickets reply
through FreshService). Returns `201` with `{ entryId, emailed }`.

## Errors

`401 api_key_required | invalid_api_key`, `403 insufficient_scope`,
`429 rate_limited`, `400` with a message for validation failures (e.g. native
ticketing disabled for the workspace, missing requester).

## Notes

- Creating tickets requires the workspace to have **native ticketing enabled**.
- `origin: "freshservice"` tickets are readable and reply-able, not editable.
- Webhooks out to third parties are a later addition; poll `GET /tickets`
  with `sort=updatedAt` for changes in the meantime.
