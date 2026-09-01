# Calling the Ticket Pulse API from Power Apps / Power Automate — research notes

Research notes feeding the official docs section. Facts verified 2026-08-05 against the
repo (branch `cursor/workflow-enterprise`, ~v3.0.9x) and current Microsoft Learn docs.
Anything not fully verified is flagged inline and collected under **Open questions** at the end.

---

## 1. Our API — verified against the codebase (2026-08-05)

Source files: `backend/src/middleware/apiKeyAuth.js`, `backend/src/middleware/apiIdempotency.js`,
`backend/src/routes/apiV1.routes.js`, `backend/src/routes/apiV1.openapi.js`, `backend/src/utils/apiProblem.js`.

| Fact | Value |
| --- | --- |
| Endpoint | `POST https://ticketpulse.bgcsaas.com/api/v1/tickets` |
| Auth header | `Authorization: Bearer <key>` — **the standard `Authorization` header, not `X-Api-Key`**. Key prefixes accepted: `tp_live_…`, `tp_test_…`, `tpk_…` (`apiKeyAuth.js:91,113-116`). Missing/malformed → 401 problem+json, code `api_key_required`. |
| Required scope | `tickets:write` |
| Create body (complete list) | `subject` (required), `description`, `priority` (int 1–4, default 2), `requesterEmail`, `requesterName`, `runAiTriage` (bool, default `true`) — `apiV1.routes.js:202-213`, `CreateTicket` schema in `apiV1.openapi.js`. |
| **Not accepted on create** | `category`, `tags`, custom fields. Category is set by AI triage (when `runAiTriage` is on) or afterwards via `PATCH /api/v1/tickets/{id}` (`internalCategoryId`, `internalSubcategoryId`, `groupId`, `assignedTechId`, `status`, `priority`, `subject`). Tags via `PUT /api/v1/tickets/{id}/tags` (`tagIds`). **There is no public custom-fields surface** — see Open questions; a `sharePointItemLink` today has to travel inside `description`. |
| Success response | `201` with `{ "success": true, "data": { id, ref, origin, subject, status, priority, type, requester{id,name,email}, assignee, group, category, subcategory, tags[], rejections, categoryReviewNeeded, isNoise, assignedBy, createdAt, updatedAt } }`. `ref` is the display ref (`TP-<n>`). |
| Idempotency | Opt-in via **`Idempotency-Key`** request header on API writes (`withIdempotency` on `POST /tickets`, `PATCH /tickets/:id`, merge/replies/notes/tasks/approvals). Max 255 chars. Replay with same key + same body → cached response. Same key + **different** body → `422` code `idempotency_key_reused`. Same key while original still in flight → `409`-style "still processing, retry shortly" problem. |
| Rate limits | Per key: `rateLimitPerMin` on the key, else `API_V1_RATE_LIMIT_PER_MINUTE` (default **120/min**). Per source IP: `API_V1_IP_RATE_LIMIT_PER_MINUTE` (default **300/min**). Every response carries `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` (unix seconds). `429` includes **`Retry-After`** (seconds). |
| Errors | RFC 9457 `application/problem+json`: `{ type, title, status, code, detail?, instance, request_id, errors? }`. `code` is the stable machine-readable field. Every response also carries `X-Request-Id`. |
| OpenAPI spec | `GET /api/v1/openapi.json` — **OpenAPI 3.1.0** (`apiV1.openapi.js:99`). Human docs page at `/api/v1/docs`. Public, unauthenticated. |

---

## 2. Power Automate HTTP action

### Configuration for our POST

The built-in **HTTP** action (cloud flows). Fields:

| Field | Value |
| --- | --- |
| Method | `POST` |
| URI | `https://ticketpulse.bgcsaas.com/api/v1/tickets` |
| Headers | `Content-Type: application/json` · `Authorization: Bearer tpk_…` · `Idempotency-Key: <expr, see §5>` |
| Body | Raw JSON with dynamic-content tokens (see recipe, §6) |
| Authentication (advanced) | Leave **None** — that dropdown is only for Basic/Client-cert/AAD-OAuth. A bearer API key goes in a plain `Authorization` header. |

Custom headers are just rows in the Headers table; there is no special mechanism needed
for `Authorization` (verified pattern across MS docs/community; the built-in
"Authentication" parameter does not have an API-key mode).

### Licensing (verified Aug 2026)

- The **HTTP connector is Premium**. Confirmed current in the [Power Automate licensing FAQ](https://learn.microsoft.com/en-us/power-platform/admin/power-automate-licensing/faqs) and community threads through 2026.
- Covered by: **Power Automate Premium** (~$15/user/mo), **Power Automate Process** (per-flow) license, **Power Apps Premium** (~$20/user/mo), or Power Apps per-app — *2026 list prices, re-check before publishing exact dollar figures*.
- If the flow runs **in context of a Power Apps canvas app** (triggered from the app, shares the app's data sources), the app users' **Power Apps premium licenses cover the flow** — no separate Power Automate license needed per the [Power Platform licensing FAQ](https://learn.microsoft.com/en-us/power-platform/admin/powerapps-flow-licensing-faq).
- Gotcha: an app whose connected flow uses HTTP still shows license designation **"Standard"** in the maker portal (flow-level premium isn't reflected in the app's designation), but users **do** need premium use rights. Worth a warning box in our docs.
- The "free" standard `Send an HTTP request` actions (Office 365 Groups/Outlook/Users, SharePoint) only reach **Microsoft Graph/SharePoint endpoints** — they cannot call an external API like ours. No standard-license escape hatch exists; custom connectors are premium too.

### Dynamic content in the body

- Tokens from any prior step (trigger outputs, SharePoint item fields, `ParseJSON` outputs) can be inserted straight into the raw JSON body in the designer.
- From a **SharePoint item** trigger: `Title`, `Created By Email`/`DisplayName`, choice columns as `Value`, and **`Link to item`** (the item URL) are all available as dynamic content.
- From a **Power Apps (V2)** trigger: each declared input appears as a token.

---

## 3. Custom connector (the alternative)

### When it's worth it

Worth building when: multiple flows/makers will call Ticket Pulse (shared connection = key entered once, stored server-side as a connection credential, never visible in flow definitions); you want the API usable **directly from canvas apps as a data source** (no flow hop); or you want typed operations/outputs instead of hand-written JSON + Parse JSON. Plain HTTP action wins for a one-off flow: zero setup, no connector to certify/share/ALM.

Licensing: **custom connectors are also Premium** — same license tiers as HTTP. No cost advantage; the win is ergonomics + governance (connector can be DLP-classified, shared, solution-packaged).

### OpenAPI import — version support (verified 2026-08-05)

- Microsoft Learn, [Create a custom connector from an OpenAPI definition](https://learn.microsoft.com/en-us/connectors/custom-connectors/define-openapi-definition) (page dated 2025-08-04, updated 2025-09-10): *"An OpenAPI definition needs to be in **OpenAPI 2.0** (formerly known as Swagger) format. **OpenAPI definitions that are in OpenAPI 3.0 format are not supported.**"* Also: definition must be **< 1 MB**; import is via file upload (Data → Custom connectors → New → **Import an OpenAPI file**; import-from-URL also exists in the wizard).
- OpenAPI v3 support has been *announced* repeatedly (2022 wave 1 release plan — converted v3→v2 on import; a 2025 wave 2 release-plan item "Build Power Platform connectors with OpenAPI v3" now redirects to a Copilot Studio roadmap page). **As of the docs' Sep 2025 revision it is still not GA** for the classic custom-connector wizard. Treat "Swagger 2.0 required" as the operative fact; note in our docs that this may change.
- **Consequence for us:** our `/api/v1/openapi.json` is **OpenAPI 3.1.0** — it will NOT import as-is. Options for the docs: (a) we publish a down-converted 2.0 variant (e.g. `/api/v1/openapi-v2.json`) — needs a backend change, coordinate with Codex; (b) instruct users to convert (most converters, e.g. `api-spec-converter`, target 3.0→2.0, so 3.1 may need a 3.1→3.0 pass first); (c) document a hand-built minimal 2.0 file containing just `POST /tickets` (+ `GET /tickets/{id}`), which is likely the friendliest path.

### API-key auth in the connector wizard

Security tab → Authentication type **"API Key"** → set **Parameter label** (shown when a user creates a connection, e.g. "Ticket Pulse API key"), **Parameter name** = `Authorization`, **Location** = `Header`. Equivalent swagger:

```json
"securityDefinitions": {
  "api_key": { "type": "apiKey", "in": "header", "name": "Authorization" }
}
```

**Gotcha:** the API-key auth type injects the connection value verbatim into that header — so users must paste **`Bearer tpk_…`** (including the `Bearer ` prefix) when creating the connection. Say this explicitly in the docs; it is the #1 support question with this pattern. (There is no "prefix" field in the wizard.) MS docs note: with multiple security definitions the wizard picks the top one; testing right after creation can fail for a few minutes.

---

## 4. Power Apps → Power Automate patterns

Two shapes for their SharePoint-backed scenario (canvas app over a `ProjectProposalSetup` list):

### A. Automatic: SharePoint trigger (recommended for them)

- Trigger **"When an item is created"** (SharePoint connector — Standard tier; the *flow* is still premium because of the HTTP action). Fires on new list items regardless of how they were created (canvas app form submit included).
- Or **"For a selected item"** for a manual, user-invoked flow from the SharePoint list UI. Limitation per MS: manual invocation from SharePoint works only for flows in the **default environment**.
- All list columns arrive as dynamic content; requester = **`Created By Email`** / **`Created By DisplayName`**; the item URL = **`Link to item`** dynamic content.

### B. Direct: Power Apps (V2) trigger

- Trigger **"When Power Apps calls a flow (V2)"** (aka PowerApps V2). Declare **typed inputs** (Text/Number/Boolean/File/Email/Date) with "+ Add an input"; each can be required or optional.
- Canvas app calls `MyFlow.Run(txtSubject.Text, txtCategory.Selected.Value, User().Email, ...)` — arguments are **positional, matched by declaration order**, not by name.
- V2 supersedes the old "Ask in PowerApps" (V1) token pattern; V1 had the notorious stale-parameter problem. Use V2 in docs.
- Use "Respond to a Power App or flow" to return the created `ref`/`id` to the app if the app needs to show it.

For their described flow (list item created → ticket → write back), pattern A is the fit:
the write-back step is just SharePoint **"Update item"** setting a `TicketPulseRef` /
`TicketPulseId` column from the parsed response.

---

## 5. Practical gotchas to document

1. **JSON escaping in the raw body.** Inserting a dynamic token inside a hand-typed JSON string (`"subject": "@{triggerOutputs()?['body/Title']}"`) does **not** escape quotes/newlines/backslashes in the value — a subject containing `"` produces invalid JSON and a 400. Safe options: (a) build the body as an object expression — `setProperty(...)` chain or `json()` over safely composed parts; (b) run risky free-text fields through `replace(replace(<v>, '\', '\\'), '"', '\"')`; (c) simplest to teach: pass free text through the expression `string(<token>)`? — *not sufficient; do not document (c)*. Recommend (a) for `description`, plain tokens for constrained fields (choice columns, emails).
2. **Retry policy defaults duplicate POSTs.** Power Automate auto-retries an action on **408, 429, and 5xx** (and connectivity errors). Defaults per the [limits doc](https://learn.microsoft.com/en-us/power-automate/limits-and-config) (page dated 2026-07-17): Low performance profile = up to **2 retries** (exponential, ~5 min scale); Medium/High = up to **12 retries** (exponential, scaling to ~1 h). Older docs/UI describe "exponential, 4 retries" — the profile-based table is the current statement; flag the discrepancy. Configure under action **Settings → Retry policy**: `Default` / `None` / `Exponential Interval` / `Fixed Interval`; limits: ≤ 90 attempts, delay 5 s–1 day (`PT…` ISO 8601). **Because retries re-send the POST, our `Idempotency-Key` header is what makes retries safe — lead with this in the docs.** Our 429s include `Retry-After`, which the retry runtime honors.
3. **Timeout.** Outbound synchronous request limit = **120 seconds** (limits doc). The action's `Timeout` setting (ISO 8601, e.g. `PT2M`) governs the async-polling pattern overall duration, not the per-request 120 s cap. Our create endpoint responds well under that; no async pattern needed.
4. **Two keys, two jobs — `Idempotency-Key` vs `externalRef`** *(rewritten 2026-08-31, Phase PA — the earlier advice to key `Idempotency-Key` per SharePoint item is WRONG and produces `422`s on resubmission).*

   > **`Idempotency-Key` = per RUN.** Expression: `workflow()?['run']?['name']` (the run ID; also `workflow().run.name`). Evaluated once per action execution, so every automatic retry of the HTTP action (408/429/5xx) re-sends the same key with the same body → the cached response replays, no double ticket. Retry protection, nothing more.
   >
   > **`externalRef` = per RECORD** (a body field, not a header). Expression: `concat('sp-projectrequests-', triggerOutputs()?['body/ID'])` — the SharePoint item id, stable forever. Ticket Pulse stores it on the ticket; a later POST with the same `externalRef` (a re-submitted form, a re-run flow, an edited item) **updates the existing ticket** and answers `200` with top-level `resubmitted: true` (`meta.changedFields`, `meta.reopened`, …). A first-seen ref answers `201` exactly as before.
   >
   > **Never use the record id for both.** A second run for the same item sends a *different* body (that's the point of a resubmission) under the *same* idempotency key → `422 idempotency_key_reused` — rejected by the idempotency layer before the resubmission logic ever runs. Same key + same body would merely replay the old response (no update). Keep the header per run, the body field per record.

   Nuance (unverified): community posts show `workflow()['run.name']` (single key) failing — the correct form is the nested two-key access. `externalRef` is opaque, ≤200 chars, unique per workspace; `Idempotency-Key` ≤255 chars.

   **Zero-change bridge for existing flows.** ws5's flow already posts `customFields.powerAppRecordId` (stored as `power_app_record_id`). In Ticket Pulse → Settings → Ticket Ops → *API resubmissions*, set "Match on a custom field" to **Power App Record Id**: the ref is derived from that value (stored as `pa-<id>`) and resubmissions match with the payload they send today. Existing ws5 tickets were backfilled (`scripts/backfill-external-ref-ws5.mjs`, lowest ticket id per record wins). Adding `externalRef` to the flow later is still recommended — it is explicit and survives field renames.
5. **Hiding the API key in run history.** Action **Settings → Secure Inputs** (and optionally Secure Outputs) hides the action's inputs — including the `Authorization` header — from run history; the action shows a lock icon. Docs: [use secure inputs/outputs](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/use-secure-inputs-outputs-triggers). Trade-off: the body is hidden too, which hurts debugging — suggest enabling after the flow works.
6. **Storing the key properly.** Best practice: Power Platform **environment variable of data type "Secret"** backed by **Azure Key Vault** ([docs](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/environmentvariables-azure-key-vault-secrets)). Constraints: AKV is the only supported store; same tenant; secret env vars **don't appear in the dynamic-content picker** — retrieve in-flow via Dataverse connector → **"Perform an unbound action"** → `RetrieveEnvironmentVariableSecretValue` (turn on Secure Outputs on that action). Alternative: **Azure Key Vault connector "Get secret"** action (also premium). Simplest acceptable fallback for their team: plain-text env variable + Secure Inputs on the HTTP action.
7. **Handling 4xx.** Non-retryable errors (400 validation, 401 bad key, 403 scope/IP, 422 idempotency reuse) fail the action. Pattern: a parallel branch or subsequent action with **Configure run after → "has failed"**, then **Parse JSON** on `body('HTTP')` with the problem schema (§6) and act on `code`. `outputs('HTTP')?['statusCode']` gives the status. Our stable `code` values worth listing in docs: `api_key_required`, `rate_limited`, `idempotency_key_reused`, `validation_failed` (check exact list against `apiProblem.js` before publishing).

---

## 6. Recommended sender recipe (for the docs)

Scenario: SharePoint list `ProjectProposalSetup` → new item → Ticket Pulse ticket → write ref back.

**Trigger:** SharePoint "When an item is created" (site + list).

**Action 1 — HTTP** (rename it `Create Ticket Pulse ticket`):

| Setting | Value |
| --- | --- |
| Method | POST |
| URI | `https://ticketpulse.bgcsaas.com/api/v1/tickets` |
| Header `Content-Type` | `application/json` |
| Header `Authorization` | `Bearer tpk_…` (from secret env var / Key Vault, see §5.6) |
| Header `Idempotency-Key` | `workflow()?['run']?['name']` — per RUN (retry protection; see §5.4) |
| Body `externalRef` | `concat('sp-projectrequests-', triggerOutputs()?['body/ID'])` — per RECORD (resubmission → update; see §5.4) |
| Settings → Secure Inputs | On (once tested) |
| Settings → Retry policy | Default |

Body (dynamic-content placeholders in `«»`; keep free text out of hand-typed strings — see §5.1):

```json
{
  "subject": "New project proposal: «Title»",
  "description": "Submitted by «Created By DisplayName» («Created By Email»).\n\nProposal: «Link to item»\n\n«Description column, escaped per §5.1»",
  "priority": 2,
  "requesterEmail": "«Created By Email»",
  "requesterName": "«Created By DisplayName»",
  "externalRef": "sp-projectrequests-«ID»",
  "runAiTriage": true
}
```

Response status tells the flow what happened: `201` = created, `200` + `resubmitted: true` = the
existing ticket for this record was updated (`meta.changedFields` lists what changed; `[]` means
an identical re-send — nothing written). Branch on `outputs('HTTP')?['statusCode']` if the
write-back step should skip on updates.

(Category cannot be set on create — either let AI triage classify, or add a follow-up
`PATCH /api/v1/tickets/@{body('Parse_ticket_response')?['data']?['id']}` with
`internalCategoryId` if they want a fixed category. `sharePointItemLink` rides in the
description until a custom-fields/API extension exists.)

**Action 2 — Parse JSON** (`Parse ticket response`), Content `body('Create_Ticket_Pulse_ticket')`, schema:

```json
{
  "type": "object",
  "properties": {
    "success": { "type": "boolean" },
    "data": {
      "type": "object",
      "properties": {
        "id": { "type": "integer" },
        "ref": { "type": "string" },
        "origin": { "type": "string" },
        "subject": { "type": "string" },
        "status": { "type": "string" },
        "priority": { "type": "integer" },
        "category": { "type": ["string", "null"] },
        "createdAt": { "type": "string" }
      }
    }
  }
}
```

**Action 3 — SharePoint "Update item"**: same site/list, Id = trigger `ID`, set
`TicketRef` = `ref`, `TicketId` = `id` from Parse JSON outputs.

**Error branch — Parse JSON (problem)**: run after HTTP **has failed**; Content
`body('Create_Ticket_Pulse_ticket')`; schema:

```json
{
  "type": "object",
  "properties": {
    "type": { "type": "string" },
    "title": { "type": "string" },
    "status": { "type": "integer" },
    "code": { "type": "string" },
    "detail": { "type": "string" },
    "instance": { "type": "string" },
    "request_id": { "type": "string" }
  }
}
```

Then e.g. post to Teams / send mail including `code`, `detail`, `request_id` (tell users
to quote `request_id` when contacting us). Terminate with status Failed to keep run
history honest.

---

## 7. Open questions / could not fully verify

1. **OpenAPI v3 custom-connector GA status.** The 2025 wave 2 release-plan URL now redirects to a Copilot Studio roadmap page; the Learn how-to (rev. 2025-09-10) still says 3.0 unsupported. Re-check right before publishing; the "convert to 2.0" guidance may become optional.
2. **Default retry count wording.** Current limits doc (2026-07-17) says 2 retries (Low profile) / 12 (Medium-High); many secondary sources and the older action UI say "exponential, 4 retries". Publish the profile-based numbers with a "defaults may vary by environment performance profile" caveat.
3. **Exact 2026 license prices** ($15 Premium / $20 Power Apps) — sourced from secondary licensing guides; verify against the official licensing guide PDF before printing dollar amounts.
4. **`workflow()['run']['name']` uniqueness guarantees on retries** — behavior (same value across in-action retries, new value on resubmit) is community-established, not stated in one canonical MS doc. Our per-item key recommendation (`sp-<ID>`) sidesteps the ambiguity.
5. **Our API gaps surfaced by this scenario** (needs Codex coordination, not doc wording): no `category`/custom fields on `POST /tickets`; no public custom-fields surface for `sharePointItemLink`. Decide: extend `CreateTicket`, or document the description-embedding + PATCH workaround (drafted above).
6. **Stable problem `code` list** — pull the definitive set from `backend/src/utils/apiProblem.js` when writing the error-reference table.

## Sources

- Repo (verified 2026-08-05): `backend/src/middleware/apiKeyAuth.js`, `backend/src/middleware/apiIdempotency.js`, `backend/src/routes/apiV1.routes.js`, `backend/src/routes/apiV1.openapi.js`, `backend/src/utils/apiProblem.js`
- [Custom connector from an OpenAPI definition — Microsoft Learn](https://learn.microsoft.com/en-us/connectors/custom-connectors/define-openapi-definition) (2025-09-10 revision; OpenAPI 2.0 requirement, <1 MB, API-key wizard)
- [Limits of automated, scheduled, and instant flows — Microsoft Learn](https://learn.microsoft.com/en-us/power-automate/limits-and-config) (2026-07-17 revision; 120 s outbound timeout, retry profiles, 90-attempt cap, message sizes)
- [Power Automate licensing FAQ — Microsoft Learn](https://learn.microsoft.com/en-us/power-platform/admin/power-automate-licensing/faqs) (HTTP = premium)
- [Power Platform licensing FAQ — Microsoft Learn](https://learn.microsoft.com/en-us/power-platform/admin/powerapps-flow-licensing-faq) (in-context flows covered by Power Apps licenses; app designation caveat)
- [Use secure inputs/outputs — Microsoft Learn](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/use-secure-inputs-outputs-triggers)
- [Environment variables for Azure Key Vault secrets — Microsoft Learn](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/environmentvariables-azure-key-vault-secrets)
- [SharePoint connector reference — Microsoft Learn](https://learn.microsoft.com/en-us/connectors/sharepoint/) ("For a selected item" default-environment limitation; triggers)
- Secondary (cross-checked, not authoritative): Manuel T. Gomes workflow()/PowerApps-V2 references, tomriha.com run-identifier posts, 4sysops PowerApps V2 trigger guide, community licensing threads (2025–2026)
