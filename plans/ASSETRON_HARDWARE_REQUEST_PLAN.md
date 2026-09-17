# ASSETRON ↔ TICKET PULSE — hardware requests start in Ticket Pulse

Source: Vahid ↔ Sam Khadem (Assetron) Teams thread, 17 Sep 2026 — *"ticket pulse → new hardware request →
queries assetron for what's available → lists user to select and adds it to the approval request → when
approved assetron updates asset ownership."* Sam: *"I can work with this… are we assuming the asset is
getting assigned to the requester of the ticket? … Tell me this and I will work on it right away."*

Companion for Sam: `qa/Assetron integration - hardware requests from Ticket Pulse (2026-09-17).pdf`
(source `qa/evidence-0917-assetron/`). This file is the internal build plan.

Status legend: ☐ todo · ☑ done · ⛔ blocked (says on what) · ◇ decision for Vahid

---

## 0. What the data says (measured 17 Sep 2026, IT workspace, 625 hardware-category tickets / 180 d)

Vahid's correction was right: the 12 Sep measurement counted **Ticket Pulse approvals only**. FreshService
carries its own approvals on the ticket object (`approval_status`, `approval_status_name`) and per-ticket
`/tickets/{id}/approvals`; Ticket Pulse never reads either.

| | count |
|---|---|
| Hardware tickets, 180 d | 625 (293 New Hire Workstation, 102 Performance, 101 Hardware Fault, 61 Procurement, 61 Workstation Setup) |
| FreshService approval **Approved** | **95** (40 Service Requests, 55 untyped) |
| FreshService Cancelled / Requested | 9 / 1 |
| Ticket Pulse approval approved | 15 (3 overlap with FS) |
| Approved in either system | **110** |
| A strict "approved or nothing" gate would still refuse | **508 of 625 (81 %)** — 197 of 233 new-hire tickets |

FS #219171 ("Request for Cristian Orellana : Laptop") **had an FS approval approved on 20 Apr 2026**. Assetron's
ALLOW on it was right; Ticket Pulse's reason ("needs no approval") was wrong because it was blind to FS.

Consequences for this plan:
1. Ticket Pulse must **persist FS approval status** (Phase 0.5) so every existing verdict endpoint sees both systems.
2. The strict rule is still a process change (4 of 5 hardware tickets carry no approval anywhere). The new
   flow makes it cheap to raise one: the approval request *is* the hardware request.

## 1. The flow

```
Agent on ticket ──▶ Request approval ──▶ category is hardware-gated
      │                                        │
      │                              Hardware step (new)
      │                   ┌────────────────────┴─────────────────────┐
      │                   │ 1. For whom?  default = ticket requester │
      │                   │    override via GAL person picker        │
      │                   │ 2. Assetron availability browser          │
      │                   │    filters: type, location, CPU, RAM,     │
      │                   │    storage, screen, touch, GPU, OS,       │
      │                   │    condition, warranty; sort; search      │
      │                   │ 3. Pick 1..n assets → selection summary   │
      │                   └────────────────────┬─────────────────────┘
      │                                        ▼
      │              TP: create approval rows (tiers/fan-out as today)
      │                  + hardware_request json  + POST Assetron /reservations (hold)
      │                                        ▼
      │              Approver e-mail / public page / ticket timeline show the asset card + recipient
      │                                        ▼
      │        approved ─▶ TP job: POST Assetron /assignments (idempotent, retried) ─▶ note + activity on ticket
      │        rejected / cancelled / expired ─▶ DELETE Assetron /reservations/{id}
      └─────── Ticket sidebar "Assets": GET Assetron /users/{email}/assets for the requester / recipient
```

Decisions taken (change only if Vahid says so):
- **Recipient is explicit.** Default = ticket requester; the agent may pick anyone from the GAL (Entra
  via `personDirectoryService` / `azureAdService.resolveAddress`). Sent to Assetron as
  `{ email, displayName, entraObjectId? }`. E-mail/UPN is the join key — Assetron uses the same GAL.
- **Assets are held at request time**, released on any non-approval outcome, assigned on approval.
  Without the hold two agents pick the same laptop.
- **One request may carry several assets** (laptop + dock + monitor). Cap 10.
- **Ticket Pulse pushes** the assignment (Vahid: "when approved we sync with Assetron"). The existing
  `approval.decided` webhook stays available if Assetron prefers to pull too.
- **Assetron stays the system of record for assets.** Ticket Pulse stores a snapshot of what was picked
  (tag, model, specs) so the ticket reads correctly even if the asset changes later.

## 2. Phases

### Phase 0 — Provisioning (no release)
- ☐ 0.1 Assetron credential + base URL per workspace in **Settings → Integrations → Assetron**
      (`workspace_settings` JSON, secret encrypted like the SendGrid key). Feature flag
      `assetron.hardwareRequests` (IT first).
- ☐ 0.2 Sam: test environment or fixtures (10–20 assets across 3 locations) + the endpoints in §3.
- ☐ 0.3 Agree the asset field list (§4) and the facet list with Sam. Contract-first: we build against
      `qa/assetron-handover/assetron-openapi.yaml` (we draft it, he confirms) and a local stub.

### Phase 0.5 — FreshService approvals become visible (release, half a day) — independent of Assetron
- ☐ 0.5.1 Schema: `tickets.fs_approval_status smallint`, `tickets.fs_approval_status_name varchar(40)`,
      `tickets.fs_approval_synced_at`. Additive migration; apply by hand after merge (memory
      `prod-migrations-manual`).
- ☐ 0.5.2 `syncService` ticket mapper: copy `approval_status` / `approval_status_name` from the FS ticket
      payload (already fetched — zero extra calls).
- ☐ 0.5.3 `approvalVerdictService.verdict()` + `handout-check`: FS `Approved` counts as approved
      (`source: 'freshservice'`), FS `Requested` counts as HOLD/PENDING. Response gains `approval.source`.
- ☐ 0.5.4 Backfill: one script over hardware tickets 180 d (the 625 above; the measurement cache
      `scratchpad/fsappr.json` is not reusable across sessions — refetch, 220 ms apart).
- ☐ 0.5.5 Tests: verdict precedence with FS statuses; OpenAPI snapshot; changelog "FreshService approvals now count".

### Phase 1 — Backend (release A, ~2 days)
- ☐ 1.1 `src/integrations/assetronClient.js`: bearer auth, 8 s timeout, 3 retries on 5xx/network with
      jitter, problem+json mapping to `ApiProblem` codes `assetron_unavailable | assetron_conflict |
      assetron_not_found`. Never logs the token.
- ☐ 1.2 Schema (additive): `ticket_approvals.hardware_request jsonb` (recipient, assets snapshot,
      filters used), `ticket_approvals.recipient_email varchar(255)`, `assetron_reservation_id varchar(80)`,
      `assetron_sync_state varchar(20)` (`none|reserved|assigning|assigned|released|failed`),
      `assetron_sync_error text`, `assetron_synced_at`.
- ☐ 1.3 `ticketApprovalService.request()` accepts `hardwareRequest: { recipient, assetIds[] }` when the
      category `gates_hardware`; validates assets via `GET /assets/{id}` (still available), reserves via
      `POST /reservations`, stores the snapshot on **every** sibling row of the request group.
- ☐ 1.4 Decision hooks: `_decide()` approved & `isFinal`/last tier → enqueue **assign job**; rejected /
      cancelled / expired / withdrawn → enqueue **release job**. Jobs live in a small
      `integration_jobs` table worked by the existing outbox worker cadence (durable, idempotent by
      approval id, 6 attempts over 24 h, then `failed` + ticket note + admin banner).
- ☐ 1.5 On success: private note "Assetron assigned {tag} ({model}) to {recipient}" + activity
      `asset_assigned`; SSE `ticket.updated`.
- ☐ 1.6 API v1: approval rows expose `hardwareRequest` and `assetronSync`; `POST /tickets/{id}/approvals`
      accepts `hardwareRequest` (for Power Apps / Simorgh-style callers). OpenAPI + snapshot test.
- ☐ 1.7 Proxy endpoints for the UI (never expose the Assetron token to the browser):
      `GET /tickets/assetron/assets?…filters` (passes through facets), `GET /tickets/assetron/assets/{id}`,
      `GET /tickets/assetron/users/{email}/assets`. Scope: any write-capable agent of the workspace.
- ☐ 1.8 Tests: request with reservation (mock client), conflict 409 → clear error, assign on final
      approval only (tiered), release on each negative outcome, job retry/backoff, proxy auth.

### Phase 2 — Frontend (release B, ~3 days)
- ☐ 2.1 `RequestApprovalModal`: when the chosen category gates hardware, a **Hardware** step appears:
      recipient row (avatar + name from GAL, "Change" → person picker with type-ahead), then the
      **asset browser**.
- ☐ 2.2 Asset browser: left filter rail built from Assetron facets (counts), top search, sortable table
      (Tag · Model · CPU · RAM · Storage · Screen · Touch · GPU · Condition · Location · Warranty), row
      expand for full spec, multi-select with a sticky "Selected (n)" summary, empty state "nothing
      matches — loosen a filter", 30 s facet cache. Dense but calm; tokens only (`lint:dark`).
- ☐ 2.3 Approval surfaces show the **asset card** (model, tag, specs, location, recipient): approver
      e-mail (`approvalEmailTemplate.js`, table layout, no gradients), public decision page,
      `ApprovalTimeline`, `ApprovalsInbox` row chip ("Dell Latitude 5550 · 32 GB · for J. Smith").
- ☐ 2.4 Sync state on the row: reserved / assigning / assigned ✓ / release ✓ / failed (with Retry for admins).
- ☐ 2.5 Ticket sidebar card **Assets** (requester's current assets from Assetron; recipient's too when
      different). Requester page gets the same panel. Read-only, cached 5 min.
- ☐ 2.6 Tests: modal step gating, browser filters/selection, timeline card, inbox chip.

### Phase 3 — later
- ☐ 3.1 Assetron → TP webhook when ownership changes outside TP (keeps the Assets card honest).
- ☐ 3.2 Reporting: hardware requests per month, lead time request→assigned, refusal reasons.
- ☐ 3.3 Retire `handout-check` once every handout starts in TP (◇ Vahid).

## 3. What we need from Assetron (Sam builds) — summary; full contract in the PDF

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/assets?status=available&type=&location=&cpu=&ramGb=&storageGb=&screenIn=&touch=&gpu=&os=&condition=&q=&sort=&page=&pageSize=` | Availability search; returns `items[]`, `total`, `facets{}` |
| `GET /api/v1/assets/{id}` | One asset, full spec, current status |
| `POST /api/v1/reservations` | Hold assets for a request; 409 when one is gone |
| `DELETE /api/v1/reservations/{id}` | Release (idempotent) |
| `POST /api/v1/assignments` | Assign the reserved assets to the recipient on approval; idempotent via `Idempotency-Key` |
| `GET /api/v1/users/{email}/assets` | The person's current assets |
| Auth | Bearer token issued by Assetron to Ticket Pulse; no IP allow-list (Azure egress rotates) |
| Errors | problem+json `{ code, title, detail }`; `asset_unavailable`, `reservation_expired`, `user_not_found` |

## 4. The asset record we want

`id, assetTag, serial, type (laptop|desktop|monitor|dock|other), make, model, cpu, cores, ramGb, storageGb,
storageType, gpu, screenIn, touch, os, condition (new|refurbished|used), purchaseDate, warrantyEnd,
location { site, room }, status (available|reserved|assigned|retired), currentOwner { email, displayName },
imageUrl?, notes?, updatedAt` — and `facets` for `type, location.site, cpu, ramGb, storageGb, screenIn, touch,
gpu, os, condition` with counts.

## 5. Effort and order

Phase 0.5 first (half a day, fixes today's blind spot for every caller) → Phase 0 with Sam in parallel →
Phase 1 (2 d) → Phase 2 (3 d) → joint test on 5 real requests in IT → flag on.

## 6. Decisions for Vahid (◇)

1. Reservation TTL when the approval sits undecided (proposal: until the approval expires, i.e. the
   category's expiry; release automatically).
2. Categories with **no approval needed** (most new-hire tickets today): allow "Assign now" without an
   approval, or require an approval on every hardware handout? (Strict = 4 of 5 tickets change process.)
3. Who may pick a recipient other than the requester — any agent, or admins/coordinators only?
4. IT only, or Project Accounting / Field Equipment too?
5. Should TP write the assigned asset tag into FreshService (a custom field) for FS-born tickets?
