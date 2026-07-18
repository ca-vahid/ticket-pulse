# Ticket Pulse Public API — Comprehensive Plan

*FreshService-replacement-grade external API. Security-first. Phased.*

**Status:** Proposal for review · **Author:** Design/UX agent (Claude) · **Date:** 2026-07-18
**Related:** `docs/NATIVE_TICKETING_API.md`, `backend/src/routes/apiV1.routes.js`, `AGENTS.md`

---

## 1. Executive summary

Ticket Pulse already ships a real, if minimal, public API under `/api/v1`: workspace-scoped, key-authenticated (sha256-hashed keys with a non-secret prefix), 8 scopes, per-key rate limiting, a curated public projection, an outbound webhook system (HMAC-signed, 8 events, auto-disable), and a hand-built OpenAPI 3.0.3 spec + docs page. That is a solid **foundation** — the work ahead is not greenfield, it's hardening and broadening it to the point where a third-party app could genuinely treat TP as a FreshService replacement.

The gap to "comprehensive" is in four areas:

1. **Security & auth depth** — no key expiry/rotation, in-memory (non-distributed) rate limiting, no idempotency, one inline auth function rather than a reusable, testable middleware, and inconsistent error envelopes.
2. **Surface breadth** — only tickets/replies/notes/attachments/approvals/tags. Missing: ticket updates (status/priority/assign/merge/parent-child/tasks/time), conversations model, contacts/requesters, agents, groups, categories/types, SLA, CSAT, search, and bulk.
3. **Webhook reliability** — in-process retries lost on restart; no durable outbox, dead-letter, delivery log, or manual redelivery; a bespoke signature scheme rather than the industry Standard Webhooks spec.
4. **Developer experience** — the OpenAPI spec has no schemas/examples; docs are a static table; no SDKs, Postman collection, sandbox/test mode, usage analytics, or deprecation policy.

This plan proposes a **security-first, four-phase roadmap** that upgrades each area to the bar set by Stripe/GitHub/Zendesk-class APIs, while explicitly beating FreshService's known weaknesses (long-lived unscoped keys, thin webhooks).

---

## 2. Current state — assessment

| Area | Today | Verdict |
|---|---|---|
| **Keys** | `ApiKey` model: sha256 `keyHash` (unique), non-secret `keyPrefix`, `scopes String[]`, workspace-bound, `lastUsedAt`/`requestCount`. Raw key `tpk_<base64url(24B)>`, shown once. | Good foundation. **Missing: expiry, rotation, revocation timestamp, test/live mode, IP allowlist, per-key rate tier.** |
| **Scopes** | 8 flat scopes (`tickets:read/write/notes/attachments`, `approvals:read/write`, `tags:read/write`). | Too narrow; no wildcards; not enough resources. |
| **Routes** | `/api/v1`: list/get/create tickets, replies, notes, attachments (list+download), approvals (list+create), tags (list+replace). Mounted before session auth. | Read + shallow write only. No update/assign/status/merge/tasks, no contacts/agents/groups/search. |
| **Auth middleware** | `requireApiKey(scope)` **factory inlined in the route file**; Bearer `tpk_`; sets `req.apiKey` + `req.workspaceId`. | Works, but not reusable/centralized; deny logic and rate-limit are entangled. |
| **Rate limiting** | Hand-rolled in-memory sliding window, 120/min **per key**, per-process. Unbounded `Map`. Login/internal routes unthrottled. | **Not production-grade** (resets on deploy, per-node, no per-IP/global, memory growth). |
| **Webhooks (out)** | `WebhookSubscription` (plaintext `whsec_` secret), 8 events, HMAC-SHA256 `X-TicketPulse-Signature`, retries `[0,30s,2m]` in-process, auto-disable at 20 fails, test-ping. | Functional but **not durable**; bespoke signing; no delivery log/dead-letter/redelivery. |
| **Management UI** | `ApiKeysPanel.jsx`: create/enable/revoke keys (scope checkboxes), create/test/delete webhooks. Management routes under `/api/tickets/*` (session-auth). | Decent. Needs rotation, expiry, test/live, usage charts, delivery logs. |
| **Versioning/docs** | URL `/v1` only. OpenAPI **3.0.3** built inline — **no schemas/examples**. Static HTML docs. | No deprecation scheme, no Swagger/Scalar UI, no SDK/Postman. |
| **Errors/pagination** | Success `{success,data}`. **Two error shapes** (`{success:false,error,message}` on inline guards vs `{success:false,message}` from the global handler). **Offset** pagination only (`page`/`pageSize≤100`). | Inconsistent errors; offset degrades on deep pages. |

**Net:** ~40% of an enterprise API exists. The bones (hashed keys, scopes, versioned namespace, webhook signing, OpenAPI) are right; the depth and durability are not there yet.

---

## 3. Design principles

1. **Secure by default.** Deny-by-default scopes, least privilege, hashed secrets, short-lived where possible, every write attributable to a key.
2. **One contract, versioned.** `/api/v1` is a stable contract; breaking changes ship as `/v2` with `Deprecation`/`Sunset` headers and a ≥6-month window.
3. **Consistent everywhere.** One success shape, one error shape (RFC 9457 `problem+json`), one pagination model, ISO-8601 UTC timestamps, stable IDs.
4. **Spec is the source of truth.** OpenAPI 3.1 drives docs, SDKs, and request/response validation — no drift.
5. **Durable, observable, idempotent.** Writes are idempotent; webhooks are durably delivered and logged; every key's usage is measurable.
6. **Beat FreshService where it's weak.** Scoped + rotatable keys (vs their long-lived unscoped keys); rich, self-hydrating webhooks (vs their "fetch again for custom fields") ; real docs + sandbox.

---

## 4. Authentication & authorization (security-first)

### 4.1 Token model (upgrade `ApiKey`)
- **Format:** `tp_live_<base64url(24B)>` and `tp_test_<…>` (introduce **live vs test mode**; keep accepting legacy `tpk_` during migration). Continue storing only `sha256(raw)` + a display prefix + last-4.
- **New fields:** `expiresAt` (optional TTL), `mode` (`live`|`test`), `rotatedFromId` (rotation lineage), `revokedAt`, `ipAllowlist String[]` (optional CIDR restriction), `rateLimitPerMin` (per-key override), `lastUsedIp`.
- **Rotation:** `POST /keys/:id/rotate` issues a new secret, keeps the old valid for a **grace window** (e.g. 24–48h) so in-flight callers don't break; old is auto-revoked after.
- **Revocation:** immediate, hard. Disabled/expired/revoked → `401`.
- **Creation:** move key creation into a real `apiKeyService` (out of the route file), audited (`createdBy`, timestamp).

### 4.2 Scopes (expand + enforce centrally)
Full `resource:action` catalogue, deny-by-default, wildcards supported (`tickets:*`, `*:read`):

```
tickets:read  tickets:write  tickets:delete
conversations:read  conversations:write
contacts:read  contacts:write
agents:read  groups:read
tags:read  tags:write
categories:read  types:read
tasks:read  tasks:write
timeentries:read  timeentries:write
approvals:read  approvals:write
attachments:read  attachments:write
webhooks:read  webhooks:manage
csat:read  search:read
```
Enforcement moves to a reusable middleware `requireScope('tickets:write')` that reads `req.apiKey.scopes` and supports wildcard expansion.

### 4.3 Auth options (phased)
- **Phase 0–1:** Personal/App API keys (Bearer) — the primary path (matches FreshService's ergonomics, but scoped + rotatable).
- **Phase 3:** **OAuth 2.0 client-credentials** for app-to-app installs (client id/secret → short-lived access token with scopes), and optional **JWT bearer** for user-context calls (reuse the app's existing session-JWT verify path).

### 4.4 Test/sandbox mode
`tp_test_` keys operate against test data (either a per-workspace `mode=test` data partition flag on created records, or a dedicated sandbox workspace). Test webhooks and test tickets never touch production dashboards/AI spend. Lets integrators build safely.

### 4.5 Audit & attribution
Every write via a key is already attributed to a synthetic actor (`apikey:<prefix>`). Add an **`ApiAuditLog`** row per mutating call (key id, scope used, method, path, target id, ip, result) — feeds the usage UI and security review.

---

## 5. Security hardening (explicit — this is the priority)

1. **Reusable auth middleware** — extract `requireApiKey`/`requireScope` into `backend/src/middleware/apiKeyAuth.js`; unit-tested; applied via a router-level guard, not per-route copy.
2. **Distributed rate limiting** — replace the in-memory `Map` with a durable token-bucket (Postgres-backed counter or Redis if/when available), enforced **per key + per IP + global**, with standard headers on **every** response: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`; `429` + `Retry-After`. **Also throttle `/api/auth/*`** (login/token) which is currently unprotected. Per-key tiers via `rateLimitPerMin`.
3. **Idempotency** — honor `Idempotency-Key` on all `POST`; store `(key, keyHash, requestHash) → {status, body}` for 24h in an `IdempotencyKey` table; replay the stored response on duplicate; reject mismatched-body reuse. Prevents double-created tickets on client retries.
4. **Optimistic concurrency** — return `ETag` on resources; accept `If-Match` on `PATCH`/`PUT`; `412 Precondition Failed` on stale writes. Conditional `GET` (`If-None-Match` → `304`) doesn't spend rate quota.
5. **Input validation + output projection** — validate every body against the OpenAPI/zod schema (`400 problem+json` with `errors[]`); keep the curated `publicTicketShape()` discipline so internal AI/sync fields never leak; deny unknown fields.
6. **Transport & secrets** — HTTPS-only + HSTS; **encrypt outbound webhook secrets at rest** (app-level AES, decrypt only to sign) rather than plaintext; constant-time compares; request body size limits; attachment type/size limits + AV scan hook.
7. **SSRF** — reuse the workflow webhook SSRF guard for any user-supplied webhook URL (block private/link-local ranges, require https).
8. **Deny-by-default + revocation** — expired/disabled/revoked/out-of-scope/over-limit → structured `problem+json`. IP allowlist enforced when set.
9. **Abuse controls** — per-key daily quota (not just per-minute), anomaly flags (spike in 4xx/creates), and an admin kill-switch per key and workspace.
10. **Response hygiene** — echo `X-Request-Id` (generate if absent) on every response and log line; `Deprecation`/`Sunset` headers on retired endpoints.

---

## 6. API surface — resource model (FreshService parity)

Grouped by resource; **bold = new**. All under `/api/v1`, all scope-gated, all workspace-scoped by key.

- **Tickets** — list (filter/sort/**cursor**), get, create, **update (fields/status/priority)**, **assign/reassign**, **merge**, **parent/child link**, **delete/close**, **bulk update**. Include `?expand=requester,assignee,tasks`.
- **Conversations** — **list thread**, add reply (public), add note (private), **forward**, **update/delete own entries** (TP-born).
- **Tasks** — **list/create/update/delete** per ticket (mirrors the Tasks tab; syncs to FS where mirrored).
- **Time entries** — **list/create/update/delete** (the model already exists).
- **Attachments** — list, download, **upload (multipart)** on ticket/reply.
- **Contacts / Requesters** — **list/get/create/update** (people who raise tickets).
- **Agents / Technicians** — **list/get** (read-only; identity is FS/Entra-owned).
- **Groups** — **list/get**.
- **Categories & subcategories, Ticket types, Tags** — **list/get** (+ tags write already exists).
- **SLA policies** — **list/get** (read).
- **CSAT** — **read** ratings + response counts (respect the "always show N" rule).
- **Approvals** — list/create (exists) + **decide** via API.
- **Search** — **`GET /search/tickets?query=…`** with a documented filter grammar (status, priority, tag, category, requester, date ranges, free-text).
- **Webhooks** — **manage subscriptions via the versioned API** (currently only under the internal namespace).
- **Meta/discovery** — **`GET /me`** (key identity, workspace, scopes, rate limit), **`GET /meta`** (enums: statuses, priorities, sources, types), **`GET /openapi.json`** (exists).

---

## 7. API conventions

- **Versioning:** keep URL `/v1`. Additive changes stay in v1; breaking changes → `/v2` with `Deprecation: true` + `Sunset: <date>` on v1 and a published migration guide (≥6-month notice, per Zalando/RFC 8594/9745).
- **Errors (unify to RFC 9457):** one handler emits `application/problem+json`:
  ```json
  { "type":"https://api.ticketpulse…/errors/insufficient-scope",
    "title":"Insufficient scope","status":403,
    "detail":"This key lacks the 'tickets:write' scope.",
    "instance":"/api/v1/tickets","code":"insufficient_scope",
    "request_id":"req_…","errors":[/* field-level for 400 */] }
  ```
  Retire the split `{success:false,error}` vs `{success:false,message}` shapes.
- **Success:** single resource → the resource object; collections → `{ "data":[…], "pagination":{ "next_cursor":…, "limit":… } }` (+ `Link` headers).
- **Pagination:** **cursor/keyset** for large/growing collections (tickets, conversations) — `?cursor=&limit=` → opaque `next_cursor`; keep `page`/`pageSize` only for small bounded lists. Offset stays available on v1 for back-compat but is documented as legacy.
- **Filtering/shaping:** `?status=&priority=&tag=&updated_since=`; `?sort=&dir=`; `?fields=` (sparse fieldsets); `?expand=` (include related). ISO-8601 UTC everywhere; stable IDs (`TP-<n>` for native, numeric FS id for FS-born, clearly typed).
- **Idempotency/Request-Id headers** as in §5.

---

## 8. Webhooks 2.0 (adopt Standard Webhooks + durable delivery)

- **Signing → [Standard Webhooks](https://www.standardwebhooks.com):** headers `webhook-id`, `webhook-timestamp`, `webhook-signature`; sign `id.timestamp.body` with HMAC-SHA256; secret `whsec_<base64>`; signature `v1,<b64>`; verify with constant-time compare + timestamp tolerance (replay guard); `webhook-id` doubles as the consumer's idempotency key. Keep the current `X-TicketPulse-*` headers in parallel for one deprecation cycle. Support **dual active secrets** for zero-downtime rotation.
- **Durable delivery:** a `WebhookDelivery` **outbox** table (`subscriptionId, eventId, payload, status, attempts, nextAttemptAt, responseCode, error`). A background worker (same pattern as the alert flush worker) drains it with **exponential backoff over hours→days**, dead-letters after N, and records every attempt. Survives restarts.
- **Delivery log + redelivery:** per-subscription delivery history in the UI with response codes and a **manual "redeliver"** button; auto-disable stays (now with a reason + re-enable).
- **Expanded event catalogue:** `ticket.created/updated/status_changed/priority_changed/assigned/merged/closed/deleted`, `conversation.reply_added/note_added`, `task.created/updated/completed`, `contact.created/updated`, `approval.requested/decided`, `csat.received`. Payloads are **self-hydrating** (full resource embedded — explicitly better than FreshService, which makes you re-fetch for custom fields).
- **Subscription management** via the versioned API (`webhooks:manage` scope) + event filtering.

---

## 9. Developer experience

- **OpenAPI 3.1 as source of truth** — full `components/schemas`, request/response bodies, examples, and the scope catalogue per operation. Generate it from zod schemas (`@asteasolutions/zod-to-openapi`) or maintain the spec and validate requests against it at runtime. Replaces the schema-less 3.0.3 stub.
- **Rendered docs** — self-hosted **Scalar** or **Redoc** at `/api/v1/docs` (CSP-safe, no external CDN — inline the bundle), driven by the spec. Interactive "try it" with a test key.
- **SDKs & Postman** — generate TypeScript + Python SDKs and a Postman collection from the spec in CI; publish alongside docs.
- **Keys/usage UI upgrade** (`ApiKeysPanel`): scope groups, **test/live toggle**, **rotate** (with grace countdown), **expiry**, per-key **usage charts** (calls, 4xx/5xx, top endpoints), IP allowlist, and the **webhook delivery log**.
- **API changelog + deprecation policy** page; every change dated; `Deprecation`/`Sunset` surfaced in docs.
- **Sandbox/test mode** (from §4.4) documented as the recommended way to build.

---

## 10. Observability & ops

- **Usage metrics** — extend the existing `requestCount`/`lastUsedAt` into an `ApiRequestLog`/rollup (per key, endpoint, status, latency) reusing the health-event telemetry pattern we just shipped for email. Powers the per-key charts and a workspace API dashboard.
- **Audit log** (§4.5) for all writes.
- **Alerting** — reuse the admin-banner/health pattern to flag abnormal 4xx/5xx rates, webhook dead-letters, and per-key quota breaches.

---

## 11. Data-model changes (migrations, additive)

1. `ApiKey`: `+ expiresAt, mode, rotatedFromId, revokedAt, ipAllowlist, rateLimitPerMin, lastUsedIp`; widen `scopes` catalogue.
2. `IdempotencyKey` (new): `keyHash, requestHash, method, path, statusCode, body, createdAt` (24h TTL sweep).
3. `WebhookDelivery` (new): durable outbox (see §8). `WebhookSubscription`: `+ signingVersion, secretPrevious, secretRotatedAt, disabledReason`; encrypt `secret` at rest.
4. `ApiRequestLog` (new): usage/audit rollup.
5. `RateLimitCounter` (new) if DB-backed limiter (or Redis, no table).

All additive; apply to prod via the established `db execute` + `migrate resolve` flow, verify tables, then deploy.

---

## 12. Phased roadmap

**Phase 0 — Hardening & consistency (foundation; no new resources).** Extract reusable `apiKeyAuth`/`requireScope` middleware; unify errors to `problem+json` + `X-Request-Id`; distributed rate limiting + standard headers (and throttle `/auth`); `Idempotency-Key`; key **expiry + rotation + revocation + test/live mode**; expand scopes; OpenAPI 3.1 with real schemas; Scalar docs. *Ships the security bar the user asked for.*

**Phase 1 — Surface parity (core).** Ticket update/status/priority/assign/merge/parent-child/close; conversations model; tasks + time entries; attachment upload; contacts/agents/groups read; categories/types read; **cursor pagination**; `/me`, `/meta`, `/search/tickets`.

**Phase 2 — Webhooks 2.0.** Standard Webhooks signing + dual-secret rotation; durable outbox + backoff + dead-letter + delivery log + manual redeliver; expanded self-hydrating event catalogue; subscription management via `/v1`.

**Phase 3 — Enterprise & DX.** OAuth 2.0 client-credentials + optional JWT user-context; SDKs (TS/Python) + Postman in CI; sandbox/test data isolation; bulk endpoints; ETag/If-Match concurrency; per-key usage analytics UI + API dashboard; deprecation/versioning tooling.

---

## 13. Security checklist (acceptance gate)

- [ ] Keys hashed at rest (✓ today), + expiry, rotation with grace, hard revocation, test/live separation.
- [ ] Deny-by-default scopes, wildcard-aware, enforced by shared middleware; every write attributed + audited.
- [ ] Distributed rate limiting per key **and** per IP **and** global; standard headers; `/auth` throttled; per-key quota + kill-switch.
- [ ] `Idempotency-Key` on all writes; replay-safe; mismatch-rejecting.
- [ ] `problem+json` errors, no internal-field leakage, unknown-field rejection, schema validation on every body.
- [ ] Outbound webhook secrets encrypted at rest; Standard Webhooks signing + replay tolerance + rotation.
- [ ] SSRF guard on subscription URLs; HTTPS/HSTS; body/attachment size + type limits.
- [ ] Optimistic concurrency (ETag/If-Match) on updates.
- [ ] IP allowlist honored when set; expired/revoked keys hard-fail.
- [ ] Full audit + usage telemetry; anomaly alerting.

---

## 14. Open questions for the user

1. **OAuth priority** — is app-to-app OAuth2 (for a future TP "app marketplace") a Phase-3 nicety, or needed sooner?
2. **Redis** — is a Redis instance available in the Azure setup? It's the clean home for distributed rate limiting + idempotency; otherwise we do Postgres-backed (works, slightly heavier).
3. **Sandbox model** — dedicated sandbox workspace vs. a `mode=test` flag on records? The former is cleaner/safer; the latter is less infra.
4. **Scope granularity** — is per-resource read/write enough, or do we want per-field / per-status-transition scopes (Zendesk-style) for enterprise buyers?
5. **Surface priority** — which integrations are driving this (e.g. create-ticket from another app, status sync, agent tooling)? That reorders Phase 1.
