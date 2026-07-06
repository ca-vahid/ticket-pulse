# Workflow Engine → Enterprise Readiness — Implementation Plan

**Owner:** Claude (design + full-stack, `cursor/*`)  ·  **Created:** 2026-07-06  ·  **Basis:** the Jul 2026 Ticketing & Workflow audit.

Goal: take the Mail Workflow (notification workflow) engine from a single-path notifier to a real, enterprise-grade automation engine, wire tickets fully into it, and spend our LLM-email advantage — sequenced so each phase unlocks the next.

> **Reality check (verified against current code 2026-07-06).** The audit was point-in-time and overstated the "critical" gaps. Confirmed already-working: `emitTicketEvent()` really dispatches to `notificationWorkflowEngine.executeForEvent`; `ticket.status_changed` (`ticketService.js:1583`), `ticket.note_added` for private notes (`ticketService.js:1768`), `ticket.reply_received` for inbound email (`mailboxIngestService.js:318`), and `approval.requested`/`approval.decided`/`approval.clarification_requested` (`ticketApprovalService.js:119/616/260`) all fire. LLM failures degrade to a **template fallback** unless `failWorkflowOnError === true` (`notificationWorkflowEngine.js:2006`); the provider gateway already has cross-provider failover. **Phase 1 is therefore verify + harden + close small gaps, not a rebuild.** Re-verify every `file:line` before editing — these move.

**Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done. Tick subtasks as we go.

> **Gap assessment — second pass (2026-07-06, verified in code):**
> 1. *Already built, plan overstated:* the editor already exposes `failWorkflowOnError` + `contentSource` (LLM flows default to `llm_with_template_fallback`); `send_email` refuses to send an empty body (skips, engine ~L2040/2077); the provider gateway already fails over across providers. Those 1.3 items become verify-and-test, not build.
> 2. *New gap found:* **FS-born status changes never fire `ticket.status_changed`** — `deriveTicketLifecycleEvents` derives only created/assigned/reassigned/resolved_closed, so an FS ticket moving Open→Pending triggers no workflow. Added as task 1.2b.
> 3. *`llm_only` failure loses the email:* on LLM failure the send is skipped (safe but silent). Hardening = fall back to rendered template / minimal built-in template instead of dropping the notification (task 1.3 refined).
> 4. *Phase 2 cheaper than planned:* `node-cron` + the start/stop worker pattern already exist (`emailPollingService`, `scheduledSyncService`, `notificationWorkflowRunWatchdogService`) — reuse, don't build.
> 5. *Phase 3 Wait/Delay is the big architectural lift:* the engine is a synchronous single pass; durable resume needs run-state persistence (`resumeAt`, `resumeNodeId`, state snapshot on `NotificationWorkflowRun`) + a resume worker. Sequenced last in Phase 3.
> 6. *Definition schema versioning added to Phase 2:* new node types + condition groups ⇒ definition `version: 2` with backward-compatible loading of v1.
> 7. *Phase 5 scoping locked:* custom fields = pragmatic JSON UDF (`Ticket.customFields Json` + per-workspace field definitions), not EAV; merge/relations = junction table + service + minimal UI.
> 8. *Delivery constraint:* **no deploys** — all phases land on a local branch + dev DB migrations until the user has tested on dev.

**Working agreement:** one phase at a time; each phase ends green (lint + tests) and, when it touches UI/prod behavior, gets deployed and eyeballed before the next phase starts. Team-safe + origin-aware constraints hold throughout (no leaderboards; TP-born fully mutable, FS-born gated to write-back/reply-via-FS).

---

## Phase 1 — Foundation: verify & harden the event + LLM-fallback layer

*Lock in what already works with tests, close the last wiring gaps, and guarantee an email is never silently lost.*

### 1.1 Event dispatch verification + regression tests
- [x] Integration test: `ticket.status_changed` reaches the engine on a status change
- [x] Integration test: `ticket.note_added` reaches the engine on a private note
- [x] Integration test: `ticket.reply_received` reaches the engine on an inbound-email reply
- [x] Integration test: `approval.requested` / `approval.decided` / `approval.clarification_requested` each dispatch
- [x] Add a single source-of-truth map (code comment or small registry) of event → emit site(s), so future events can't be defined-but-unfired

### 1.2 Close the agent-reply event gap
- [x] Add `ticket.public_reply_added` event; emit it in `_addThreadEntry` for non-private replies (both origins), with a stable `dedupeStamp` (`reply:<entryId>`)
- [x] Register in `NOTIFICATION_EVENT_TYPES`, labels, and trigger metadata (`notificationWorkflowDefinition.js`)
- [x] Test coverage for the new event

### 1.2b Close the FS-born status-change gap (new — from gap assessment)
- [x] Derive `ticket.status_changed` in `deriveTicketLifecycleEvents` when `existing.status !== upserted.status` (stable dedupe stamp `status:<old>-><new>:<fsUpdatedAt>`), so FS-synced transitions fire workflows like TP-native ones
- [x] Test coverage (incl. no double-fire alongside `resolved_closed`, and no fire on first sight/create)

### 1.3 LLM-email fallback hardening
- [x] `llm_only` nodes: on LLM failure, fall back to the rendered template (or a minimal built-in factual template) instead of silently skipping the send — the notification must not be lost
- [x] Test: LLM throw/timeout on `llm_with_template_fallback` → template email still sends; on `llm_only` → fallback email sends; `failWorkflowOnError:true` still aborts

### 1.4 Wrap phase
- [x] Lint + backend tests green (no deploy — dev-test gate)

---

## Phase 2 — Condition model & richer triggers

*Remove the boolean-only / weak-condition limitation and add the triggers a real engine needs.*

### 2.1 Condition data model
- [x] Define a condition schema: `{ field, operator, value }` rows inside `ALL | ANY` groups, **nestable one level** (hard depth/count cap for legibility)
- [x] Compile condition groups → json-logic at save/runtime so the existing evaluator is reused (no runtime rewrite)
- [x] Field catalog: ticket (status, priority, category, group, assignee, tags, origin, SLA/due, age, CSAT), requester (dept, location…), agent, availability, workspace
- [x] Operator set: `is`/`is not`, `in`/`not in`, `contains`, `changed`/`changed to`/`changed from`, `> / <` (numeric), relative-time (age, SLA), `is empty`, `matches regex`

### 2.2 Condition builder UI
- [x] AND/OR group builder in `NotificationWorkflowsPanel.jsx` (typed field picker → operator → value), replacing hand-written JSONLogic for common cases
- [x] Keep a "raw JSONLogic / advanced" escape hatch for power users
- [x] Value inputs by type: text, number, select/multiselect, relative-time, changed-from/to

### 2.3 Trigger expansion
- [x] Scheduler/worker for time-based triggers (reuse the existing `node-cron` + start/stop worker pattern; workspace-timezone aware)
- [x] `scheduled` (cron-ish) trigger + `ticket aging N hours` trigger
- [x] `sla.breach` / `sla.pre_breach` triggers derived from `dueBy` / `frDueBy` (business-hours aware where possible)
- [x] Manual "run this workflow on this ticket" trigger (ad-hoc)

### 2.4 Definition schema versioning (new — from gap assessment)
- [x] Definition `version: 2` for graphs using condition groups / new node types; loader accepts + normalizes v1 unchanged

### 2.5 Wrap phase
- [x] Tests for compile→evaluate parity + each new trigger; lint green (no deploy — dev-test gate)

---

## Phase 3 — Action taxonomy: from notifier to orchestrator

*Remove the "two actions" ceiling. Every action origin-aware.*

### 3.1 Mutate actions (extend `update_ticket` + new)
- [x] `assign` / route action (specific tech; strategies: round-robin, least-loaded, skill-match with capacity)
- [x] set group / category / subcategory
- [ ] add / remove tags (deferred — tickets have no tag model yet; lands with Phase 5 staples)
- [ ] set custom fields (deferred to Phase 5 with the JSON UDF model)
- [x] Origin guard on all mutate actions (TP-born full; FS-born → write-back/reply-via-FS only)

### 3.2 Control-flow nodes
- [x] Branch / Switch node (N-way, first-match + explicit "otherwise")
- [x] Try / Catch wrapper for fallible nodes (external calls)
- [x] Wait / Delay node (duration or until-datetime) — **the big lift**: run-state persistence (`resumeAt`/`resumeNodeId` + state snapshot on `NotificationWorkflowRun`) + a resume worker; do last in this phase

### 3.3 Reach-out actions
- [x] Webhook / call-API action (sync + async), branch on response status
- [x] Create task / child ticket
- [x] Request-approval action (drives the existing approval system)
- [x] Notify team / distribution list / group routing (recipient resolver beyond individuals)

### 3.4 Editor, wiring & validation
- [x] Node palette + config panels for each new node; graph validation rules updated
- [x] Render branches as indented collapsible sub-lists (reuse the indigo collapsible-group pattern); reserve canvas for complex splits
- [x] Tests per node; lint green (no deploy — dev-test gate)

---

## Phase 4 — LLM output as email (spend the wedge)

*We already own the guardrails. Point them at real use cases, safely.*

### 4.1 Reusable LLM-email building blocks
- [x] Draft-vs-send mode on the LLM node: staged **draft → approval** vs **auto-send**, gated by a confidence threshold
- [x] "Proposed reply" storage + an agent approve / edit / send affordance on the ticket
- [x] Reusable prebuilt-workflow templates (installable per workspace)

### 4.2 Use cases (ship as prebuilt workflows)
- [x] Auto-drafted first reply — grounded + cited, draft→approve
- [x] Resolution-summary email on close — draft→approve; auto-send above confidence on templated closures
- [x] Follow-up nudge for an unresponsive requester — Wait node + LLM check-in; auto-close branch if still silent
- [x] Escalation digest to managers — scheduled/SLA trigger; team-safe framing (coaching, not ranking)
- [x] Auto-triaged acknowledgement on new ticket — classify → set fields → personalized ack
- [ ] Sentiment "at-risk" alert (deferred — no sentiment model yet; revisit after Phase 5) — negative-sentiment branch → owner alert with suggested de-escalation (basic heuristic now; model-based in Phase 5)

### 4.3 Guardrail completions
- [x] Granular evidence redaction — verified the workspace LLM tool policy already offers per-source toggles (thread/private notes/similar tickets); per-node overrides deferred as low-value
- [x] `always-human` policy tag (regulated / VIP / complaint) that blocks auto-send regardless of confidence
- [x] Audit trail of every draft + send (who/what/when/model/guard outcome)

### 4.4 Ship
- [x] Tests (draft-gate, auto-send threshold, guardrail blocks, redaction); lint green (no deploy — dev-test gate)

---

## Phase 5 — Enterprise hardening & the ticketing staples that unblock automation

*Lifecycle, reuse, observability, and the ticket-model features the actions depend on.*

### 5.1 Workflow lifecycle
- [x] Per-step dry-run against a chosen ticket — VERIFIED already built (executePreview + preview-tickets picker + per-step outputs in the editor test panel); new nodes all implement dry-run outputs
- [x] Version pinning: delay-parked runs resume on their launch version (Phase 3); synchronous runs trivially complete on their launch definition
- [x] Per-fire audit trail — VERIFIED already built (runs + step rows + TP-NWF audit ids + listAuditRuns admin view); every new node records step outputs incl. skip/downgrade reasons

### 5.2 Reuse & composition
- [x] Sub-workflows: run_workflow node (published child, one level deep, self/nesting guards, onError continue|fail, editor picker)

### 5.3 Ticketing staples (unblock the action taxonomy)
- [x] Custom fields (JSON UDF): definitions CRUD + typed values on tickets (both origins — TP annotation layer), setCustomFields workflow action, custom:<key> condition fields, detail-sidebar card + Ticket Ops settings section
- [x] Macros: bundles (status/priority/note/reply) applied through the normal audited service paths, per-step results; Macros menu on the ticket + Ticket Ops settings CRUD
- [x] TP-side SLA policies: per-priority clocks set dueBy/frDueBy at TP ticket creation (Ticket Ops settings). Escalation ladders = workflows on sla_pre_breach/sla_breach triggers with assign/priority/notify actions (all shipped)
- [x] Explicit ticket links (duplicate_of/related_to/parent_of) + "mark as duplicate" (links + resolves TP-born source with audit note). Full thread-merge deferred — honest scoping; the duplicate-close flow covers the daily need

### 5.4 Observability
- [x] Workflow analytics — VERIFIED substantially built (7-day health rollups: failures, mock runs, deliveries, provider errors + per-fire audit view); template-fallback visible per-run

### 5.5 Ship
- [x] Tests; lint green (no deploy — dev-test gate); docs synced

---

## Cross-phase notes
- **Verify before edit:** the audit's `file:line` are point-in-time; re-grep each anchor.
- **Sequencing dependencies:** Phase 3 Wait/Delay needs the Phase 2 scheduler; Phase 3 set-custom-field & Phase 4 sentiment lean on Phase 5 items (stub the contract, land the feature later).
- **Team-safe + origin-aware** constraints are non-negotiable in every phase.
- Deploy cadence: each phase → fresh `cursor/*` branch off `origin/main` → PR → squash-merge → watch backend + SWA → verify.
