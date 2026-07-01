# Native Ticketing — Phased Plan & Task Board

> Status: **v2 — approved direction, all open items resolved; ready to implement** (2026-07-01)
> Owner: collaborative (single-agent execution for now; Codex resting)
> Source: codebase audit (schema, sync engine, API/auth/email, frontend) + product decisions below.
> This doc is the living tracker — check off tasks as they land.

---

## 1. Vision & end state

Ticket Pulse becomes a **ticket system in its own right**, not just a FreshService mirror. Tickets can be born inside Ticket Pulse (agent console, inbound email, later a public API), live richer lives here than FreshService allows, and are **mirrored back to FreshService as a fallback copy** so the org can retreat to FS during a Ticket Pulse outage. Long-term: FreshService is decommissioned and Ticket Pulse is the sole system of record.

## 2. Locked decisions

| # | Decision |
|---|----------|
| 1 | **Dual-origin model.** TP is source of truth for TP-born tickets (async, best-effort mirror to FS). FS-born tickets remain FS-owned and keep today's sync behavior until a later cutover. |
| 2 | **Full-ish fallback mirror.** Subject/description/status/priority/category/assignee, **public replies as FS replies, and private notes as FS private notes** are mirrored (queued, eventual — minutes acceptable). |
| 3 | **Creation channels v1:** email-to-ticket, email-updates-existing-ticket (reply ingestion surfaced as workflow triggers), and agent-created tickets in their workspace. Agents view/reply in-app. **No requester login for now.** Public integration API later. |
| 4 | **Email is per-workspace and user-configurable** — admins add/remove one or more monitored mailboxes per workspace in Settings (other groups will adopt the app). Channel is Microsoft Graph. |
| 5 | **v1 feature cut:** create / edit fields / assign (manual + AI triage) / public reply / private notes / status changes. Attachments via Workstream A. SLA later. Approvals scaffolded (Phase 6). |
| 6 | **Requester identity:** extend per-ticket magic links. Full SSO requester portal is a later phase. |
| 7 | **Numbering:** TP-born tickets get a native number (`TP-<n>`) as primary reference; FS id attached once mirrored. |
| 8 | **Rollout:** per-workspace enable/disable setting; **IT workspace pilots**. |
| 9 | **Agent home:** once `/tickets` exists, the `agent` role's landing page becomes `/tickets` (from `/my-competencies`). |
| 10 | **Attachments infra:** Azure Storage account created via `az` CLI in the app's existing resource group, when Workstream A starts. |
| 11 | **Reopen-on-requester-reply is a customizable workflow**, not a hardcoded toggle — shipped as a seeded default workflow once the builder supports ticket-update actions (Phase 5). |

## 3. Audit summary — what we build on

**Assets (already built, reusable):**
- FS API client covers reads for tickets/conversations/requesters/agents/**groups/departments/form fields**; write-back proven in 5 paths (assignment, priority, category custom fields, noise auto-close, private notes) via `freshServiceActionService` with preflight checks, dry-run, per-workspace gates, shared rate limiter (110 req/min).
- `ticket_thread_entries` conversation cache (HTML/text bodies, actor, public/private, incoming) — 80% of a native thread model.
- AI assignment pipeline entry point: `assignmentPipelineService.runPipeline(ticketId, workspaceId, triggerSource)`.
- Notification workflow engine (JSON graph, LLM drafting, SendGrid + Twilio, after-hours, delivery audit) + Graph mailbox poller (`emailPollingService` + `graphMailClient`) — currently only matches mail to existing FS tickets to fast-trigger the pipeline.
- Mature auth (Entra SSO; admin/viewer/reviewer/agent roles), workspace scoping middleware, workspace-scoped SSE, public token infrastructure (`PublicTicketStatusLink` + status/escalation/urgency/feedback pages).
- Frontend kit: status/priority badges, canonical category pickers, search w/ AND-OR, Sheet/modal, toasts, `useSSE`, workspace-header API layer.

**Gaps (the work):**
- Schema hard-assumes FS origin: `Ticket.freshserviceTicketId` NOT NULL UNIQUE; same pattern on Requester/Technician; no `origin` concept.
- Sync unconditionally clobbers local fields from FS payloads; no echo suppression.
- No `/tickets` UI anywhere; ticket rows deep-link out to FS; thread cache never rendered.
- No true email-to-ticket; outbound conversation email (threading, reply loop) unsolved; SendGrid is a notifier, not a mailbox.
- No Groups table (raw `groupId` BigInt), no attachments/file storage, `agent` role locked out of the app proper.
- Workflow triggers are a hardcoded event list.

## 4. Target architecture (one screen)

```
                       ┌────────────────────────────────────────────┐
  Agent console  ────▶ │            TICKET SERVICE (new)            │
  (create/reply/edit)  │  origin-aware CRUD · thread entries ·      │
                       │  status transitions · audit events         │
  Inbound email  ────▶ │                                            │──▶ AI triage pipeline
  (Graph, per-ws       │   emits domain events on an event bus      │    (runPipeline 'app_native'/'email')
   mailboxes)          └───────┬──────────────────┬─────────────────┘
                               │                  │
                               ▼                  ▼
                     Notification workflows   SSE broadcast
                     (generalized triggers)   (live UI)
                               │
              ┌────────────────┴───────────────┐
              ▼                                ▼
     Outbound email (Graph sendMail     FS MIRROR QUEUE (new)
     from workspace mailbox; threaded;  TP-born → create/update FS copy,
     Message-ID map for reply ingest)   replies + notes mirrored,
                                        retry + rate-limit aware,
                                        echo-suppressed
```

**Ownership rule (the core invariant):** every ticket has `origin`. `origin='freshservice'` → FS→TP sync (today's behavior, untouched). `origin='ticketpulse'` → TP→FS mirror only; **the FS→TP sync path must never write to these tickets** except explicit reconciliation (Phase 3).

---

## 5. Task board

### - [x] Phase 0 — Foundations: dual-origin schema + sync guardrails ✅ 2026-07-01
*Goal: database and sync become origin-aware with zero behavior change for existing tickets. Exit: prod migration applied, regression green, a hand-inserted TP-born row is ignored by sync and renders sanely everywhere.*

- [x] 0.1 Prisma migration — `Ticket.origin` (`'freshservice'|'ticketpulse'`, backfill `'freshservice'`, indexed); `Ticket.nativeNumber` (global sequence `ticket_native_number_seq` starting 1000, TP-born only, displayed `TP-<n>`); `freshserviceTicketId` → nullable (Postgres unique tolerates NULLs); mirror bookkeeping (`mirrorState`, `mirroredAt`, `mirrorError`) → `20260701000000_native_ticketing_foundations`
- [x] 0.2 `Requester.freshserviceId` → nullable (TP-native requesters), uniqueness preserved
- [x] 0.3 `TicketThreadEntry` — nullable `externalEntryId`; new `source` values (`'ticketpulse_user'`, `'email_inbound'`); added `authorType` (`agent|requester|system`) and `mirrorState`/`mirroredAt`
- [x] 0.4 New `Group` cache table + `groupSyncService` (self-throttled 6h, non-fatal) hooked into `syncTechnicians`; `Ticket.groupId` stays the raw FS id, resolvable via the cache
- [x] 0.5 Sync guardrails — race-proof origin filter in `ticketRepository.upsert/update/updateByFreshserviceId/cleanOldTickets`; early exit in `syncFreshServiceTicketSnapshot`; `origin='freshservice'` filters on all 8 FS-facing sweeps (noise auto-close, thread preheat ×2, pipeline sweep ×2, deletion reconciliation, episode hydration, pickup-time backfill). Proven by 10 unit tests + a live clobber-attempt smoke test on a prod-shaped Postgres (TP-born row survived FS ingest untouched)
- [x] 0.6 `triggerSource` needed no widening (free VARCHAR(60), no allowlist) — canonical `'app_native'` value documented in `utils/ticketOrigin.js`
- [x] 0.7 Per-workspace `nativeTicketingEnabled` flag (schema + `PUT /api/workspaces/:id` + toggle in Settings → Workspace Management). Enabling IT happens at rollout
- [x] 0.8 Downstream tolerance pass — `Number(null)`→0 is crash-safe everywhere; all `BigInt()` conversions sit behind origin filters; preheat cohort query was the one hidden FS-facing path and got filtered. Cosmetic null-FS-id display handled properly in Phase 2
- [x] 0.9 Migration validated by rebuilding origin/main schema on a fresh Postgres 16, applying the new migration, and diffing against the new schema (empty diff); backend suite 489/490 (1 pre-existing unrelated failure, present on baseline). Prod apply rides the CI/CD migration step on merge. Note: the historical migration chain has a pre-existing replay bug (`20260325..multi_workspace` references `noise_rules` before creation) — fresh-DB bootstraps need the schema-diff route, prod is unaffected

### - [ ] Phase 1 — Ticket engine + internal API
*Goal: origin-aware create/read/update/reply backend wired into triage, workflows, SSE. Exit: API-created ticket → AI triage → workflow email → reply/note in thread, with FS-born tickets untouched.*

- [ ] 1.1 `ticketService.createTicket` — validation (Zod), canonical category/subcategory, group, priority, `nativeNumber` assignment, `origin='ticketpulse'`
- [ ] 1.2 Requester resolution — email → existing `Requester` → else create TP-native requester enriched from Entra (`azureAdService`)
- [ ] 1.3 Field updates + status transition rules, each writing audit/thread events
- [ ] 1.4 Public replies + private notes → `ticket_thread_entries` (`source='ticketpulse_user'`, `authorType`)
- [ ] 1.5 REST — `POST/GET/PATCH /api/tickets`, `GET /api/tickets/:id` (incl. thread), `POST /api/tickets/:id/replies|notes`, status endpoint; workspace scoping; role rules **admitting `agent`** (own workspace only)
- [ ] 1.6 Event emission — native tickets fire the same `ticket.created`/`assigned`/`resolved_closed` path as FS ingest (existing workflows just work) + SSE broadcasts
- [ ] 1.7 AI triage on create — `runPipeline(..., 'app_native')`, respecting business-hours queueing and noise rules
- [ ] 1.8 Outbound requester email v1 via existing SendGrid workflow path (Graph threading arrives in Phase 4)
- [ ] 1.9 Assignment episodes for native tickets (start/end methods derived locally, no FS activities dependency)
- [ ] 1.10 Unit + integration tests — full create→triage→workflow→reply roundtrip; FS-born regression untouched

### - [ ] Phase 2 — Ticketing UI (`/tickets`)
*Goal: agents run their day in Ticket Pulse — list, first-ever ticket detail + thread view, composer. Exit: browser-verified flows, WCAG AA, both origins usable.*

- [ ] 2.1 Route scaffolding — `/tickets`, `/tickets/:id`, nav item; gating incl. `agent` role access, hidden when workspace flag off
- [ ] 2.2 Agent home becomes `/tickets` — update `HomeRedirect`, `ProtectedRoute`/`AgentRoute` (keep `/my-competencies` reachable in nav)
- [ ] 2.3 Ticket list — filters (status, priority, canonical category, assignee, group, origin), search, sort, SSE live updates, glass/blue design language
- [ ] 2.4 Ticket detail — conversation thread (public replies vs private notes visually distinct), activity timeline, `TP-<n>`/FS-id header treatment
- [ ] 2.5 Reply / internal-note composer — toggle, optimistic send, error + retry states
- [ ] 2.6 Sidebar editors — status, priority, assignee (photo picker), canonical category/subcategory, group, requester card w/ Entra info
- [ ] 2.7 Create-ticket composer — requester typeahead (requesters + Entra lookup), subject, rich description, category, priority, group, assign-now vs let-AI-decide
- [ ] 2.8 AI triage panel (pipeline run + recommendation) + mirror-state indicator + approvals placeholder block
- [ ] 2.9 FS-born tickets in the same views — thread from cache, actions limited to supported write-backs (assignment), stop deep-linking out as the only affordance
- [ ] 2.10 A11y (WCAG AA), responsive pass, RTL/Vitest coverage, in-browser verification with screenshots

### - [ ] Phase 3 — FreshService mirror (the fallback copy)
*Goal: every TP-born ticket has a usable FS shadow; fallback rehearsed. Exit: kill-switch drill passes — work in FS during simulated outage, reconcile cleanly after.*

- [ ] 3.1 Mirror outbox table + worker — retry/backoff, integrates the shared FS rate limiter, per-item `mirrorState`
- [ ] 3.2 FS client write methods — create ticket (on behalf of requester email), update fields, public reply, private note
- [ ] 3.3 TP-create → FS create → store `freshserviceTicketId` + `mirroredAt`; UI mirror-state updates via SSE
- [ ] 3.4 Field-change mirroring — status/priority/category/assignee (reuse `freshServiceActionService` patterns)
- [ ] 3.5 Public replies mirrored as FS replies; private notes as FS private notes
- [ ] 3.6 Echo suppression — tag mirror writes, drop webhook/poll echoes for TP-born tickets
- [ ] 3.7 Out-of-band FS edit detection on TP-born copies → conflict log + admin surface
- [ ] 3.8 Reconciliation job — import FS-side thread/status deltas on TP-born tickets after an outage (mirror watermark)
- [ ] 3.9 Reply-from-TP on **FS-born** tickets via FS reply API (FS still emails the requester)
- [ ] 3.10 Fallback runbook in `SYNC_OPERATIONS.md` + kill-switch drill executed on the pilot workspace

### - [ ] Phase 4 — Email channel (Graph, per-workspace mailboxes)
*Goal: email-to-ticket and email-updates-ticket live; outbound conversations thread properly. Exit: end-to-end mail roundtrip verified in a real mail client.*

- [ ] 4.1 `MailboxConnection` model — N per workspace: address, display name, folder, mode (ingest/send/both), interval, health state
- [ ] 4.2 Settings UI — admins add/remove/test mailboxes per workspace (self-serve for future groups)
- [ ] 4.3 Outbound — Graph `sendMail` from the connected mailbox for TP-born conversations; persist `internetMessageId`/`conversationId` per thread entry
- [ ] 4.4 Inbound matching ladder — `In-Reply-To`/`References` → stored message ids; ticket ref in subject (`TP-1042` / FS `#12345`); sender+recency fallback
- [ ] 4.5 Matched mail → public reply thread entry + emit `ticket.reply_received` (+ SSE); replies on resolved tickets append + notify (reopen arrives as seeded workflow in Phase 5)
- [ ] 4.6 Unmatched mail → create TP-native ticket (requester from sender) → AI triage → auto-ack via existing `ticket.created` workflows
- [ ] 4.7 Email attachment capture → Blob (Workstream A) or strip-with-notice interim
- [ ] 4.8 Loop & noise protection — auto-reply/bounce/out-of-office detection, self-send guard, noise rules apply to email-born tickets
- [ ] 4.9 Pilot mailbox strategy — new address for IT pilot to avoid FS double-ingestion; per-workspace migration guidance for existing forwarded addresses
- [ ] 4.10 (Stretch) Graph change notifications replace polling; else keep interval polling with watermark

### - [ ] Phase 5 — Workflow builder generalization
*Goal: triggers/actions become a registry, not a hardcoded list; reply automation buildable no-code. Exit: "on requester reply → LLM ack → send" and "reopen on reply" exist as editable workflows.*

- [ ] 5.1 Event registry — catalog w/ payload schemas: `ticket.reply_received`, `ticket.note_added`, `ticket.status_changed`, `email.inbound_unmatched`, `approval.requested/decided`, origin/channel filters on `ticket.created`
- [ ] 5.2 Configurable trigger node (event + condition filters) replacing the hardcoded enum; Zod validation updates
- [ ] 5.3 Migration path for existing published workflows (no breakage, no silent behavior change)
- [ ] 5.4 New action nodes — update ticket fields (incl. reopen), post reply/note to thread, assign, request approval
- [ ] 5.5 Seeded default **"Reopen on requester reply"** workflow per workspace — enabled-by-default, fully customizable (decision #11)
- [ ] 5.6 Builder UI — trigger config panel, new node types in the ReactFlow palette, condition field additions
- [ ] 5.7 Run audit + mock/preview mode coverage for new triggers/actions
- [ ] 5.8 Tests + docs; verify the reply-ack workflow is buildable with zero code

### - [ ] Phase 6 — Approvals (scaffold → usable loop)
*Goal: single-step approvals on tickets, decidable from email. Exit: request → magic-link decide → workflow reacts.*

- [ ] 6.1 `TicketApproval` schema + migration (ticket, approver, requestedBy, status, note, decidedAt)
- [ ] 6.2 API — request / decide / list, with role rules
- [ ] 6.3 Ticket-detail approval block (request UI, status chips, history)
- [ ] 6.4 Magic-link email approve/reject via public token infra
- [ ] 6.5 Workflow integration — request-approval action + `approval.decided` trigger
- [ ] 6.6 Mirror approval decisions to FS as private notes (audit trail)
- [ ] 6.7 Tests + a11y pass

### - [ ] Phase 7 — Public integration API
*Goal: external apps create/query/reply. Exit: documented, keyed, rate-limited `/api/v1`.*

- [ ] 7.1 API key model — per workspace, scoped permissions, hashed storage + management UI
- [ ] 7.2 Versioned `/api/v1` — create ticket, query/list, get ticket + thread, reply
- [ ] 7.3 Rate limiting + request audit logging
- [ ] 7.4 OpenAPI spec + docs page
- [ ] 7.5 Integration tests + example client snippet

### - [ ] Phase 8 — Requester SSO portal & FS cutover (horizon — detail when reached)
- [ ] 8.1 SSO requester portal — my tickets, create, reply (same Entra tenant)
- [ ] 8.2 Per-workspace FS intake freeze + final import (attachments, full conversation history)
- [ ] 8.3 FS read-only → decommission

### - [ ] Workstream A — Attachments (cross-cutting; starts alongside Phase 2/4)
- [ ] A.1 Create Azure Storage account via `az` CLI in the app's existing resource group; private container, lifecycle policy
- [ ] A.2 `Attachment` model + upload API — size/type limits, SAS download links, ownership checks
- [ ] A.3 Composer + thread UI — upload, preview, download
- [ ] A.4 Email attachment capture hook (Phase 4)
- [ ] A.5 Best-effort attachment mirroring to FS copies

### - [ ] Workstream B — Docs, analytics & product-rule compatibility
- [ ] B.1 `origin` exposed as an analytics dimension; TP-born CSAT stays on `TicketFeedback` (N-count rule unchanged)
- [ ] B.2 Update `AGENTS.md` + `CLAUDE.md` — "read-heavy / no ticket editing" doctrine superseded per-workspace by the feature flag (when Phase 2 ships)
- [ ] B.3 Keep `SYNC_OPERATIONS.md` current — mirror mechanics, rate budget share, fallback runbook

---

## 6. Rollout

Everything ships behind `nativeTicketingEnabled` (per-workspace Settings toggle). **IT workspace pilots** each phase; the email pilot uses a **new mailbox address** so FS's existing forward-based ingestion can't double-create. Expand to other workspaces after the Phase 3 kill-switch drill passes.
