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
- [ ] Integration test: `ticket.status_changed` reaches the engine on a status change
- [ ] Integration test: `ticket.note_added` reaches the engine on a private note
- [ ] Integration test: `ticket.reply_received` reaches the engine on an inbound-email reply
- [ ] Integration test: `approval.requested` / `approval.decided` / `approval.clarification_requested` each dispatch
- [ ] Add a single source-of-truth map (code comment or small registry) of event → emit site(s), so future events can't be defined-but-unfired

### 1.2 Close the agent-reply event gap
- [ ] Add `ticket.public_reply_added` event; emit it in `_addThreadEntry` for non-private replies (both origins), with a stable `dedupeStamp` (`reply:<entryId>`)
- [ ] Register in `NOTIFICATION_EVENT_TYPES`, labels, and trigger metadata (`notificationWorkflowDefinition.js`)
- [ ] Test coverage for the new event

### 1.2b Close the FS-born status-change gap (new — from gap assessment)
- [ ] Derive `ticket.status_changed` in `deriveTicketLifecycleEvents` when `existing.status !== upserted.status` (stable dedupe stamp `status:<old>-><new>:<fsUpdatedAt>`), so FS-synced transitions fire workflows like TP-native ones
- [ ] Test coverage (incl. no double-fire alongside `resolved_closed`, and no fire on first sight/create)

### 1.3 LLM-email fallback hardening
- [ ] `llm_only` nodes: on LLM failure, fall back to the rendered template (or a minimal built-in factual template) instead of silently skipping the send — the notification must not be lost
- [ ] Test: LLM throw/timeout on `llm_with_template_fallback` → template email still sends; on `llm_only` → fallback email sends; `failWorkflowOnError:true` still aborts

### 1.4 Wrap phase
- [ ] Lint + backend tests green (no deploy — dev-test gate)

---

## Phase 2 — Condition model & richer triggers

*Remove the boolean-only / weak-condition limitation and add the triggers a real engine needs.*

### 2.1 Condition data model
- [ ] Define a condition schema: `{ field, operator, value }` rows inside `ALL | ANY` groups, **nestable one level** (hard depth/count cap for legibility)
- [ ] Compile condition groups → json-logic at save/runtime so the existing evaluator is reused (no runtime rewrite)
- [ ] Field catalog: ticket (status, priority, category, group, assignee, tags, origin, SLA/due, age, CSAT), requester (dept, location…), agent, availability, workspace
- [ ] Operator set: `is`/`is not`, `in`/`not in`, `contains`, `changed`/`changed to`/`changed from`, `> / <` (numeric), relative-time (age, SLA), `is empty`, `matches regex`

### 2.2 Condition builder UI
- [ ] AND/OR group builder in `NotificationWorkflowsPanel.jsx` (typed field picker → operator → value), replacing hand-written JSONLogic for common cases
- [ ] Keep a "raw JSONLogic / advanced" escape hatch for power users
- [ ] Value inputs by type: text, number, select/multiselect, relative-time, changed-from/to

### 2.3 Trigger expansion
- [ ] Scheduler/worker for time-based triggers (reuse the existing `node-cron` + start/stop worker pattern; workspace-timezone aware)
- [ ] `scheduled` (cron-ish) trigger + `ticket aging N hours` trigger
- [ ] `sla.breach` / `sla.pre_breach` triggers derived from `dueBy` / `frDueBy` (business-hours aware where possible)
- [ ] Manual "run this workflow on this ticket" trigger (ad-hoc)

### 2.4 Definition schema versioning (new — from gap assessment)
- [ ] Definition `version: 2` for graphs using condition groups / new node types; loader accepts + normalizes v1 unchanged

### 2.5 Wrap phase
- [ ] Tests for compile→evaluate parity + each new trigger; lint green (no deploy — dev-test gate)

---

## Phase 3 — Action taxonomy: from notifier to orchestrator

*Remove the "two actions" ceiling. Every action origin-aware.*

### 3.1 Mutate actions (extend `update_ticket` + new)
- [ ] `assign` / route action (specific tech; strategies: round-robin, least-loaded, skill-match with capacity)
- [ ] set group / category / subcategory
- [ ] add / remove tags
- [ ] set custom fields (depends on Phase 5 custom fields; stub the action contract now)
- [ ] Origin guard on all mutate actions (TP-born full; FS-born → write-back/reply-via-FS only)

### 3.2 Control-flow nodes
- [ ] Branch / Switch node (N-way, first-match + explicit "otherwise")
- [ ] Try / Catch wrapper for fallible nodes (external calls)
- [ ] Wait / Delay node (duration or until-datetime) — **the big lift**: run-state persistence (`resumeAt`/`resumeNodeId` + state snapshot on `NotificationWorkflowRun`) + a resume worker; do last in this phase

### 3.3 Reach-out actions
- [ ] Webhook / call-API action (sync + async), branch on response status
- [ ] Create task / child ticket
- [ ] Request-approval action (drives the existing approval system)
- [ ] Notify team / distribution list / group routing (recipient resolver beyond individuals)

### 3.4 Editor, wiring & validation
- [ ] Node palette + config panels for each new node; graph validation rules updated
- [ ] Render branches as indented collapsible sub-lists (reuse the indigo collapsible-group pattern); reserve canvas for complex splits
- [ ] Tests per node; lint green (no deploy — dev-test gate)

---

## Phase 4 — LLM output as email (spend the wedge)

*We already own the guardrails. Point them at real use cases, safely.*

### 4.1 Reusable LLM-email building blocks
- [ ] Draft-vs-send mode on the LLM node: staged **draft → approval** vs **auto-send**, gated by a confidence threshold
- [ ] "Proposed reply" storage + an agent approve / edit / send affordance on the ticket
- [ ] Reusable prebuilt-workflow templates (installable per workspace)

### 4.2 Use cases (ship as prebuilt workflows)
- [ ] Auto-drafted first reply — grounded + cited, draft→approve
- [ ] Resolution-summary email on close — draft→approve; auto-send above confidence on templated closures
- [ ] Follow-up nudge for an unresponsive requester — Wait node + LLM check-in; auto-close branch if still silent
- [ ] Escalation digest to managers — scheduled/SLA trigger; team-safe framing (coaching, not ranking)
- [ ] Auto-triaged acknowledgement on new ticket — classify → set fields → personalized ack
- [ ] Sentiment "at-risk" alert — negative-sentiment branch → owner alert with suggested de-escalation (basic heuristic now; model-based in Phase 5)

### 4.3 Guardrail completions
- [ ] Granular evidence redaction (keep thread, hide internal notes) — replace the current binary redaction
- [ ] `always-human` policy tag (regulated / VIP / complaint) that blocks auto-send regardless of confidence
- [ ] Audit trail of every draft + send (who/what/when/model/guard outcome)

### 4.4 Ship
- [ ] Tests (draft-gate, auto-send threshold, guardrail blocks, redaction); lint green (no deploy — dev-test gate)

---

## Phase 5 — Enterprise hardening & the ticketing staples that unblock automation

*Lifecycle, reuse, observability, and the ticket-model features the actions depend on.*

### 5.1 Workflow lifecycle
- [ ] Per-step dry-run against a chosen ticket (preview each node, no side effects) — extend mock mode + editor UI
- [ ] Version pinning: in-flight runs stay on the version they launched on
- [ ] Per-fire audit trail (which workflow/rule fired, why, what it did) + an admin view

### 5.2 Reuse & composition
- [ ] Sub-workflows (triggerless, invoked via a "run workflow" action) so common notify/escalation chains are authored once

### 5.3 Ticketing staples (unblock the action taxonomy)
- [ ] Custom fields (UDF) — unblocks set-custom-field action + conditions on custom data
- [ ] Macros — agent quick-action bundles that reuse the Phase 3 action taxonomy
- [ ] TP-side SLA policy definitions + multi-level escalation ladders (auto-reassign/re-prioritize on breach)
- [ ] Merge tickets + explicit ticket relationships (parent/child, duplicates, blocked-by)

### 5.4 Observability
- [ ] Workflow analytics for admins: fires, failures, template-fallbacks, delivery outcomes

### 5.5 Ship
- [ ] Tests; lint green (no deploy — dev-test gate); update `AGENTS.md` / `CLAUDE.md` if surfaces changed

---

## Cross-phase notes
- **Verify before edit:** the audit's `file:line` are point-in-time; re-grep each anchor.
- **Sequencing dependencies:** Phase 3 Wait/Delay needs the Phase 2 scheduler; Phase 3 set-custom-field & Phase 4 sentiment lean on Phase 5 items (stub the contract, land the feature later).
- **Team-safe + origin-aware** constraints are non-negotiable in every phase.
- Deploy cadence: each phase → fresh `cursor/*` branch off `origin/main` → PR → squash-merge → watch backend + SWA → verify.
