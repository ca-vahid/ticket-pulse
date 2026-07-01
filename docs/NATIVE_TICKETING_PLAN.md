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

### - [x] Phase 1 — Ticket engine + internal API ✅ 2026-07-01
*Goal: origin-aware create/read/update/reply backend wired into triage, workflows, SSE. Exit: API-created ticket → AI triage → workflow email → reply/note in thread, with FS-born tickets untouched.*

- [x] 1.1 `ticketService.createTicket` (new `services/ticketService.js`) — Zod validation, canonical category/subcategory + group + technician validation, `nativeNumber` from the sequence, `origin='ticketpulse'`, `mirrorState='pending'`, noise evaluation at parity with FS ingest
- [x] 1.2 Requester resolution — email → existing `Requester` (case-insensitive) → else `requesterRepository.createNative` (nullable FS id) enriched best-effort from Entra
- [x] 1.3 Field updates (`updateTicketFields`) + status transitions (`changeStatus`: resolve/close stamp `resolvedAt`/`resolutionTimeSeconds`, reopen clears them) — every change audited to `ticket_activities`
- [x] 1.4 Public replies + private notes → `ticket_thread_entries` (`source='ticketpulse_user'`, `authorType='agent'`, `mirrorState='pending'`); first public reply stamps `firstPublicAgentReplyAt`
- [x] 1.5 REST (`routes/tickets.routes.js`): `GET /api/tickets` (+filters/search/paging), `GET /:id` (thread+episodes+audit+latest run), `GET /meta`, `POST /`, `PATCH /:id`, `POST /:id/status|assign|replies|notes`. Mounted before global workspace-access enforcement; access = workspace role OR **agent with an active technician profile in the workspace**; mutations gated by the per-workspace flag
- [x] 1.6 Event emission — native mutations flow through `emitTicketLifecycleNotifications` (same `ticket.created/assigned/resolved_closed` path as FS ingest) + `ticket-change` SSE broadcasts
- [x] 1.7 AI triage on create — `runPipeline(..., 'app_native')` fire-and-forget; pipeline made TP-born-aware: activities tool returns a well-formed empty result for null FS ids, and `freshServiceActionService.execute` gained a **local-only branch** (assignment + `workflow_assigned` episode + notifications applied locally, run marked `synced` with `localOnly` payload — no FS calls; mirror picks it up in Phase 3)
- [x] 1.8 Outbound requester reply email v1 — direct SendGrid/SMTP send with the `TP-<n>` ref in the subject (future email threading hook) + full `NotificationDelivery` audit row; non-fatal by design
- [x] 1.9 Assignment episodes for native tickets — created/ended locally (`self_picked`/`coordinator_assigned`/`workflow_assigned`; `reassigned`/`closed` end methods), no FS activities dependency
- [x] 1.10 Tests: 13-test `ticketService` suite (mocked deps) + live end-to-end smoke on the dev Postgres with real services — **17/17 checks green** (create TP-1003 → reply → note → assign → resolve → reads → post-mirror clobber guard). Full backend suite 502/503 (same pre-existing failure); route chain import-verified; lint clean

### - [x] Phase 2 — Ticketing UI (`/tickets`) ✅ 2026-07-01
*Goal: agents run their day in Ticket Pulse — list, first-ever ticket detail + thread view, composer. Exit: browser-verified flows, WCAG AA, both origins usable.*

- [x] 2.1 Routes `/tickets` + `/tickets/:id` via new `TicketsRoute` (auth + workspace, **agents admitted**); sky "Tickets" nav tile gated on the workspace flag; agent workspaces resolved from technician profiles (`getTechnicianWorkspaces` backend fallback so agents can select a workspace at all)
- [x] 2.2 Agent home → `/tickets` (HomeRedirect, ProtectedRoute bounce, PublicRoute, AuthCallback); agent nav shows only Tickets; flag-off state links agents to My Competencies
- [x] 2.3 List page (`pages/Tickets.jsx`) — status pill-group, assignee (incl. Me/Unassigned), priority, origin filters + debounced search (`TP-1042`/`#12345`/subject/requester), pagination, SSE `ticket-change` live refresh (new `onTicketChange` in `useSSE`), desktop table + mobile cards, glass language
- [x] 2.4 Detail page (`pages/TicketDetail.jsx`) — first-ever thread view: public replies vs internal notes vs requester messages visually distinct (plain-text render for safety — HTML sanitize deferred to the email phase), description card, collapsible activity log, `TP-<n>`/`#<fsid>` header with origin + mirror chips
- [x] 2.5 Reply / internal-note composer — segmented toggle, "emails <requester>" hint, sending states, toasts
- [x] 2.6 Sidebar editors — status, priority, assignee w/ avatar, canonical category→subcategory, group (from the new Group cache), requester card with Entra fields; instant-save with per-field busy state
- [x] 2.7 Create composer (`components/tickets/TicketComposer.jsx`) — slide-over: requester email+name (typeahead deferred; Entra enrichment happens server-side), subject, description, priority segmented control, category/sub, group, assignment choice (AI triage default / me / pick / none)
- [x] 2.8 AI triage panel (latest run decision/trigger/sync + deep link to the pipeline run) + mirror-state chip + approvals "coming soon" scaffold block
- [x] 2.9 FS-born tickets share the views — read-only banner ("FreshService owns this ticket…"), disabled editors, thread from cache, explicit Open-in-FreshService link
- [x] 2.10 Verified in a real browser (puppeteer + dev-login): list, native detail, FS-born detail, composer, **ticket created through the UI (TP-1004) and replied to through the UI** with screenshots reviewed; aria labels/roles + `tp-focus-ring` throughout; mobile card layout; RTL tests for the shared ticket UI kit. Fixed en route: `bg-white/78 → bg-white/[.78]` (index.css broke fresh builds on tailwind 3.4.18), ticketsAPI double-unwrap, SSE-aware navigation waits

### - [x] Phase 3 — FreshService mirror (the fallback copy) ✅ 2026-07-01
*Goal: every TP-born ticket has a usable FS shadow; fallback rehearsed. Exit: kill-switch drill passes — work in FS during simulated outage, reconcile cleanly after.*

- [x] 3.1 `mirror_jobs` outbox (`20260701200000_add_mirror_jobs`) + `mirrorService` worker — 60s drain, strict per-ticket id ordering (a failed job blocks that ticket's later jobs only), exponential backoff 5m→6h, dead-letter after 8 attempts → `mirrorState='error'`; low-priority lane on the shared FS rate limiter; `NATIVE_TICKET_MIRROR_ENABLED` kill switch
- [x] 3.2 FS client gains `createTicket`, `updateTicket`, `addNote(isPrivate)`, `createReply` (+ env-gated `FRESHSERVICE_BASE_URL_OVERRIDE` test hook for stub drills)
- [x] 3.3 TP-create → FS create on behalf of the requester email → FS id + `mirroredAt` stored, requester `freshserviceId` backfilled, private `[Ticket Pulse mirror]` intro note dropped, SSE `mirror` action broadcast
- [x] 3.4 Field sync — idempotent snapshot push (status label→FS code map, priority, subject, group, responder, TP category custom fields), deduped to one pending job per ticket; AI local-only pipeline decisions enqueue too
- [x] 3.5 Public replies mirror as **public notes** (portal-visible; deliberate deviation from FS replies so the requester isn't emailed twice — TP already emailed them); internal notes mirror privately
- [x] 3.6 Echo suppression complete by design — every FS→TP ingest path drops `origin='ticketpulse'` (Phase 0 guardrails), so mirror writes cannot boomerang; verified live in the drill
- [x] 3.7 Out-of-band FS edit detection — reconciliation compares FS status/assignee vs TP state → `mirror_conflict` ticket activity + warn log; drift surfaced, never auto-applied
- [x] 3.8 `mirrorService.reconcile(workspaceId)` + `POST /api/tickets/mirror/reconcile` (admin) — imports FS-side conversation entries added during an outage (skips mirror-authored notes, dedupes by `fs-conv-<id>`), idempotent
- [x] 3.9 FS-born tickets: replies/notes from TP now go through the FS API synchronously (FS emails the requester), cached locally as `mirrored`; detail-page composer enabled for FS-born with "sent via FreshService" hint
- [x] 3.10 Runbook added to `SYNC_OPERATIONS.md` + **kill-switch drill executed against a local FS stub on the dev DB: 13/13 checks** (create→mirror→reply→status→outage worked in "FS"→reconcile imports requester reply + flags status/assignee drift→idempotent re-run). Real-FS drill on the IT pilot happens at rollout. 10 new unit tests (mirror worker + FS-born conversation paths); backend 512/513 (same pre-existing failure)

### - [x] Phase 4 — Email channel (Graph, per-workspace mailboxes) ✅ 2026-07-01
*Goal: email-to-ticket and email-updates-ticket live; outbound conversations thread properly. Exit: end-to-end mail roundtrip verified in a real mail client.*

- [x] 4.1 `MailboxConnection` model (`20260702000000_add_mailbox_connections`) — N per workspace: address, display name, mode ingest/send/both, poll interval, health fields; + `TicketThreadEntry.emailMessageId` (RFC Message-ID) for threading
- [x] 4.2 Settings → **Ticket Mailboxes** panel — add/remove/enable/mode-switch/test (Graph connectivity test), with the new-address-vs-FS-double-ingestion warning and Mail.Read/Mail.Send permission note; API under `/api/tickets/mailboxes*` (admin)
- [x] 4.3 Outbound — Graph **draft-then-send** (`sendMailAsMailbox`) so the `internetMessageId` is captured and stored on the reply entry; `_emailRequesterReply` prefers the workspace's send-capable mailbox and falls back to SendGrid; full `NotificationDelivery` audit either way
- [x] 4.4 Inbound matching ladder (`mailboxIngestService`) — ① `In-Reply-To`/`References` ↔ stored Message-IDs ② `TP-1042` subject ref ③ FS `#12345` ref → **deliberately skipped** (FS ingests the same mail; double-ingest would duplicate threads) ④ sender+recency vs open TP-born tickets
- [x] 4.5 Matched mail → `email_inbound` requester reply entry (+ mirror-queued to the FS copy!) + `requester_reply` audit + SSE; `ticket.reply_received` workflow trigger call-site marked for Phase 5 (reopen ships there as the seeded workflow)
- [x] 4.6 Unmatched mail → TP-born ticket via the normal engine (requester resolved/created from sender, AI triage, `ticket.created` workflows ack) + an `original_email` entry stores the Message-ID so follow-ups thread
- [x] 4.7 Attachments: strip-with-notice interim (`hasAttachments` → visible notice in the entry/description); real capture lands with Workstream A (Blob)
- [x] 4.8 Loop & noise protection — self-send, no-reply/mailer-daemon senders, autoreply subjects, `Auto-Submitted`/`Precedence: bulk` headers, exact-Message-ID dedupe, per-sender per-cycle create cap; noise rules run inside createTicket as usual
- [x] 4.9 Pilot strategy documented in the panel UI + plan: new address for the IT pilot; per-workspace repointing later
- [x] 4.10 Polling with per-connection watermarks (30s tick, per-mailbox interval); Graph change notifications remain a later upgrade. 9-test ingest suite green; backend 521/522 (same pre-existing failure); **real-mailbox roundtrip needs a provisioned pilot mailbox + Mail.Read/Mail.Send consent at rollout**

### - [x] Phase 5 — Workflow builder generalization ✅ 2026-07-01
*Goal: triggers/actions become a registry, not a hardcoded list; reply automation buildable no-code. Exit: "on requester reply → LLM ack → send" and "reopen on reply" exist as editable workflows.*

- [x] 5.1 Event registry — `NOTIFICATION_EVENT_TYPES` gains `ticket.reply_received`, `ticket.note_added`, `ticket.status_changed`; `listEnabledForEvent` now gates on the registry instead of the hardcoded default-spec list (any registered event drives workflows). `email.inbound_unmatched` dropped (unmatched mail already creates a ticket → `ticket.created` fires); `approval.*` arrive with Phase 6
- [x] 5.2 Triggers are event-registry-driven end to end; new `emitTicketEvent(eventType, ticketId, {dedupeStamp, extra})` dispatcher (reuses the hydrate/context/fingerprint machinery) fires them from the ticket engine and mailbox ingest
- [x] 5.3 Migration path — validation only relaxed (never tightened), all existing published workflows validate unchanged; entire pre-existing workflow test surface still green
- [x] 5.4 **`update_ticket` action node** (status incl. reopen semantics + priority; TP-born only, audited, mirror-queued, SSE) with dry-run/mock/preview support. *Post-reply/assign nodes deferred; request-approval node ships with Phase 6*
- [x] 5.5 Seeded **"Reopen on requester reply"** default per workspace — trigger → jsonLogic condition (status ∈ Resolved/Closed) → `update_ticket(setStatus: Open)`; the email-only invariant relaxed (workflows need send_email OR update_ticket). Seeds as a draft like all defaults; publish+enable at pilot rollout (one click, `{enabled:true}` on publish)
- [x] 5.6 Builder UI — new events in `EVENT_LABELS` + trigger visuals; `update_ticket` in the node palette (config via the node JSON editor; a dedicated form field editor is polish for later)
- [x] 5.7 Mock/preview modes return `wouldSet` previews for `update_ticket` instead of writing; runs/steps audit flows through the existing engine persistence
- [x] 5.8 6-test definition suite + **live drill on the dev DB (8/8)**: seed → publish+enable → resolved TP-born ticket + `ticket.reply_received` → reopened (resolution cleared, mirror queued, audited) and open tickets untouched. Backend 528/529 (same pre-existing failure); build green

### - [x] Phase 6 — Approvals (scaffold → usable loop) ✅ 2026-07-01
*Goal: single-step approvals on tickets, decidable from email. Exit: request → magic-link decide → workflow reacts.*

- [x] 6.1 `TicketApproval` schema (`20260702100000_add_ticket_approvals`) — status pending/approved/rejected/cancelled, approver, requestedBy, notes, decidedVia link/app, sha256 `tokenHash` + 30-day expiry
- [x] 6.2 API — `POST /:id/approvals` (request, dedupes pending per approver), `/decide`, `/cancel` (authed); public magic-link router `GET|POST /api/ticket-approvals/public/:token` mounted pre-auth; only the approver or an admin may decide in-app
- [x] 6.3 Ticket-detail approvals block — status chips, decision notes, request form, in-app Approve/Reject/Cancel for the right people (replaces the Phase 2 placeholder)
- [x] 6.4 Magic-link decision page `/approval/:token` (self-contained public page: ticket summary, request note, optional decision note, Approve/Reject, decided/expired states); approver emailed via Graph mailbox → SendGrid fallback; `decisionUrl` returned for hand-delivery
- [x] 6.5 Workflow integration — `approval.requested` / `approval.decided` registered as triggers (buildable with condition + send_email/update_ticket nodes). *A dedicated request-approval action node stays on the wishlist*
- [x] 6.6 Decisions land in the conversation as a private system note, mirror-queued to the FS fallback copy (audit on both systems)
- [x] 6.7 **Live drill 11/11** (request → dedupe guard → token read → link decision → audit + mirrored note → double-decision block → permission guard → admin override); backend 528/529 (same pre-existing failure); build green

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
