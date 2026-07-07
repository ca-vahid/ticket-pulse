# Gap-Fill Plan 2 — July 2026 (post v3.0.5 build)

**Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done. Work phase by phase; each phase ends green (lint + tests) and browser-verified where visual.

**Inputs:** second full gap review (2026-07-08): GAP_FILL_PLAN_0707 outcome audit + fresh code sweep for parity gaps the v3.0.5 velocity created + prod data checks.

**User decisions (2026-07-08):**
- **Deploy v3.0.5 first** (Phase 0) so QA tests it while the next round builds.
- **Requester portal stays parked** — its own initiative after QA validates v3.0.5.
- Backlog features IN: **scheduled-ticket attachments, API webhooks, presence + command palette, AI sentiment + vector similar-tickets**.
- **Public approval page to parity** (rich notes + clarification composer).

**Explicitly NOT in this plan:** requester SSO portal / FS cutover; unmerge; workflow v1→v2 forced migration; email icon sets / feedback-page cosmetics; future LLM evidence tools (status page / monitoring / change windows / KB); LLM mock-week (operational, runs alongside).

---

## Phase 0 — Ship v3.0.5 to prod ✅ DONE (deployed 2026-07-08, QA doc at docs/QA_Test_Plan_v3.0.5.docx)

- [x] Prod `migrate deploy` (4 additive: ticket_tags, approval rich notes, impact/urgency, activity GIN index) + schema verification
- [x] Rebase → PR → squash-merge → pipelines green → health shows 3.0.5-preview
- [x] Probe new surfaces (tags CRUD, /api/v1/openapi.json + docs, merge route 401-gated)
- [x] Backfill ran (45d, set-only, 819 tickets stamped) → 30d coverage 495/4,772 (~10%; the 30% reveal gate correctly stays closed — most tickets never get a public reply; ongoing syncs keep filling)
- [x] Hand QA `docs/QA_Test_Plan_v3.0.5.docx`

## Phase 1 — Parity fast-follows ✅ DONE

The v3.0.5 features exist end-to-end but not *everywhere*. Close the loops:

### 1.1 Peek preview parity
- [x] TicketPreview shows tag chips, impact/urgency (read-only), and the merged-into banner
- [x] Tests: preview render with tags/merged data

### 1.2 Mobile parity
- [x] Mobile queue cards show tag chips (match desktop 3+overflow)
- [x] MobileAssignSheet header shows tags + category so assignment has context

### 1.3 Create-form parity
- [x] Tag picker on TicketCreate (existing palette; admins create inline) — tags apply at creation
- [x] Impact/urgency selects on TicketCreate (optional, collapsed under "More fields")

### 1.4 Analytics tag dimension
- [x] Tag breakdown in Analytics (Demand & Flow or Overview): created/open per tag for the range, top-N + "untagged" bucket; deterministic counts only
- [x] Tag filter param on the analytics queries (mirrors queue tagId semantics)
- [x] Tests: dimension math

### 1.5 Bulk + filter completions
- [x] Bulk-by-query actions: `remove_tags` and `set_category` (TP-born only for category, same guardrails)
- [x] Queue filter facet for impact/urgency (simple 1–3 multi-select; hidden until any ticket in the workspace uses them)

### 1.6 Public approval page parity
- [x] Magic-link page renders requestNoteHtml (sanitized) and gives the clarification/decision note the rich composer; payloads carry noteHtml through decideByToken
- [x] Tests: token decide with noteHtml; sanitization

## Phase 2 — Scheduled-ticket attachments ✅ DONE

- [x] Stage uploads against the ScheduledTicket (blob storage rows keyed to the schedule, not a live ticket)
- [x] On activation, staged files become real ticket attachments (and ride the FS mirror like any upload)
- [x] Create-form: drop the "can't ride a scheduled ticket yet" error; show staged chips
- [x] Tests: stage → activate → attached; schedule deletion cleans blobs

## Phase 3 — API webhooks (outbound events) ✅ DONE

- [x] `webhook_subscriptions` model (workspaceId, url, secret, events[], isEnabled, lastDeliveryAt, failureCount) + additive migration
- [x] Delivery: fire-and-forget with in-process retries (0s/30s/2m, documented as non-durable across restarts), HMAC-SHA256 signature header, auto-disable after 20 consecutive failures with the error visible in the admin UI; 8-event catalog incl. assigned + public_reply + approval.requested
- [x] SSRF guard on target URLs (reuse the workflow webhook guard)
- [x] Admin UI in Settings → API Keys (same page: "Outbound webhooks" section — subscribe, test-ping, delivery log tail)
- [x] OpenAPI/docs page documents the event payloads + signature verification
- [x] Tests: signing, retry/backoff, event fan-out, SSRF guard

## Phase 4 — UX: presence + command palette ✅ DONE

### 4.1 Presence
- [x] SSE-based "viewing" registry (in-memory per backend instance is fine — single-instance prod): opening a ticket announces presence; leave/timeout clears
- [x] Detail header shows "Also viewing: <avatars>" when someone else has the ticket open; queue rows get a subtle dot
- [x] Team-safe: presence only — no duration tracking, nothing stored

### 4.2 Command palette + keyboard nav
- [x] Ctrl/Cmd+K palette: go to page, search tickets (reuses queue search), quick actions on the open ticket (assign to me, resolve, tag…)
- [x] j/k row navigation on the queue (moves peek selection), Enter opens, x toggles select
- [x] Respect inputs/composer focus; discoverable hint in the queue header
- [x] Tests: palette component; key handling doesn't fire while typing

## Phase 5 — AI: sentiment + vector similar-tickets

### 5.1 Requester sentiment
- [ ] Per-ticket sentiment (positive/neutral/frustrated) computed from the latest requester messages via the provider gateway (schema-constrained, cheap model tier); stored on the ticket with computedAt; refreshed on new requester replies (debounced)
- [ ] Chip on detail header + optional queue dot; workflow condition field `ticket.sentiment`
- [ ] TEAM-SAFE: sentiment describes the REQUESTER's state, never agent performance; no aggregation by agent
- [ ] Tests: refresh triggers, condition field

### 5.2 Vector similar-tickets
- [ ] Enable pgvector on Azure Postgres (azure.extensions) — dev first; fall back plan: cosine over float[] if the extension is unavailable
- [ ] `ticket_embeddings` (ticketId, embedding, model, updatedAt); generate on create + subject/description edit; nightly backfill sweep for recent history (rate-limited)
- [ ] Related-tickets card gains "similar by content" section (labeled as suggestion, with distance); merge modal suggests likely duplicates
- [ ] Tests: storage round-trip, query shape; embedding calls mocked

## Phase 6 — Wrap & ship

- [ ] Full lint + backend/frontend suites green
- [ ] Version → 3.0.6-preview + concise changelog
- [ ] Dev self-test (no outbound email / FS writes — same guardrails)
- [ ] Migrations: dev during phases; prod via `migrate deploy` at deploy
- [ ] QA test doc for the new surfaces
- [ ] Deploy to prod on user go-ahead → verify

---

## Backlog (named, still not in this plan)
- Requester SSO portal + FS intake cutover (own initiative, post-QA)
- Unmerge; merge attachment-copy option
- Pipeline-side category↔group candidate scoping (Codex coordination — flagged)
- Future LLM evidence tools (status page, monitoring, change windows, KB)
- Per-workspace email icon sets; feedback-page custom emoji / BYO rating images
- Workflow v1→v2 dual-path retirement (attrition)
- Per-key API rate-limit customization

## Traceability
| Remaining gap (review 2026-07-08) | Phase |
|---|---|
| v3.0.5 undeployed + backfill + QA handoff | **0** |
| Peek/mobile/create parity for tags & impact | 1.1–1.3 |
| Analytics tag dimension | 1.4 |
| Bulk remove-tags/set-category, impact filter | 1.5 |
| Public approval page parity | 1.6 |
| Scheduled-ticket attachments | 2 |
| API outbound webhooks | 3 |
| Presence, command palette, j/k | 4 |
| Sentiment, vector similar-tickets | 5 |
| Portal, unmerge, icons, LLM future tools… | Backlog |
