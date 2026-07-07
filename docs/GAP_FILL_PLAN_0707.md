# Gap-Fill & Feature-Completion Plan — July 2026 (post v3.0.4)

**Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done. Work phase by phase; each phase ends green (lint + tests) and browser-verified where visual.

**Inputs:** full re-audit of every plan doc (WORKFLOW_ENTERPRISE, NOTIFICATION_WORKFLOW_BUILDER_UPGRADE, NOTIFICATION_LLM_CONTEXT_AND_TOOLS, NATIVE_TICKETING, TICKETS_UX_UPLIFT, QA_FEEDBACK_0706) + code-level deferred-marker sweep, cross-checked against what actually shipped in v3.0.3/v3.0.4.

**User decisions (2026-07-07):**
- Priorities: **Ticketing depth** and **Platform & API** first; analytics unlocks and LLM tools go-live as later phases.
- **Full tag system** (model + filters + workflow actions + analytics), TP-side only — never written to FreshService.
- **Requester portal (Phase 8) is a separate future initiative** — excluded here.
- LLM evidence tools: **internal notes allowed as guarded evidence** (output guard blocks verbatim quoting); rollout in the later phase.

**Explicitly NOT in this plan:** requester SSO portal / FS intake cutover; BPMN engine replacement; arbitrary custom code tools from the UI; LLM sending email directly without gates; leaderboards (team-safe rule, permanent).

---

## Phase 1 — Tags (full system) ✅ DONE

The single most-referenced deferred item; unlocks queue filtering, workflow automation, and analytics slices. TP-owned annotation layer — applies to BOTH origins, never written back to FreshService.

### 1.1 Model + API
- [x] `ticket_tags` (workspaceId, name unique-per-ws, color, createdBy, isActive) + `ticket_tag_links` (ticketId, tagId) — additive migration (dev via db execute + resolve; prod at deploy)
- [x] Ticket read paths include tags (list, detail, peek, meta); write path `setTags`/`addTag`/`removeTag` with audit entries (both origins — this is TP-side metadata)
- [x] Tag CRUD (rename/recolor/deactivate/merge-two-tags) — admin, Settings → Ticket Ops
- [x] Tests: link/unlink, audit, workspace scoping, tag merge

### 1.2 Queue + detail UI
- [x] Tag chips on queue rows (truncated +N overflow) and detail header; inline add/remove on editable contexts; keyboard-friendly typeahead (create-on-enter for admins, pick-only for agents — confirm role rule at build)
- [x] Filter rail: tag facet (multi-select, AND/OR toggle); saved views + CSV export include tags
- [x] Tests: component + filter param round-trip

### 1.3 Workflow + automation integration
- [x] Conditions: `tags` field in the AND/OR builder (`has any / has all / has none`)
- [x] Actions: `add_tags` / `remove_tags` on update_ticket (origin-agnostic — TP-side)
- [x] Trigger context: tags in the LLM/template context bundle (`{{ ticket.tags }}`)
- [x] Tests: condition compile + action execution + template render

---

## Phase 2 — Ticketing depth ✅ DONE (2 scoped caveats noted)

### 2.1 Merge tickets (true merge)
Links + mark-as-duplicate exist; this is the real thing.
- [x] Design pass: TP-born↔TP-born first-class; FS-born as merge SOURCE only (its thread copies in; FS copy gets a closing note + link — FS stays owner of its record)
- [x] `mergeTicket(sourceId, targetId)`: move/copy thread entries (labeled provenance), attachments, tags, watchers, links; source → status Closed + `merged_into` link; audit both sides; old displayRef resolves/redirects to target
- [x] Requester notification choice (notify / silent) at merge time
- [x] UI: merge action in detail (pick target via typeahead with preview), confirm modal listing exactly what moves
- [x] Tests: merge semantics, idempotency, permissions, origin rules

### 2.2 Bulk edit by query
- [x] Backend: bulk endpoint accepts the current filter params (not just ids) + a server-computed count confirmation token, capped batch size with progress; runs as background job with per-ticket audit + failure report
- [x] UI: "Select all N matching" affordance beyond the current page; progress + result toast (reuse bulk result bar)
- [x] Guardrails: TP-born only for destructive ops (status), FS-born skipped with count (same as today); explicit cap (e.g. 500) with "narrow your filter" message
- [x] Tests: query-scope resolution matches list endpoint; cap; skip logic

### 2.3 Per-group taxonomies + category↔group mapping UI
- [x] Admin UX for the existing CategoryGroupLink API (Settings → Ticket Ops or Categories): map top categories → FS groups; unmapped = visible to all
- [x] Ticket create/edit + queue filters: category picker scoped by the ticket's group where mappings exist (fallback: full tree)
- [~] AI triage + workflows respect the scoping — pickers/UI done; pipeline-side candidate filtering is Codex's domain (coordinate, not edit) — flagged for handoff
- [x] Tests: scoped picker, fallback, API round-trip

### 2.4 Approval composer rich text
- [x] Request note rich end-to-end (modal composer → sanitized HTML → approver email + timeline render); decision-note HTML accepted/stored/rendered. Public magic-link page + clarification stay plain text (self-contained page, deliberate)
- [x] Tests: sanitization, email render

### 2.5 Small but real
- [x] Impact + urgency as optional separate fields (TP-born; priority derived or manual — confirm matrix at build), shown on detail sidebar; workflow condition fields
- [x] Print view for a ticket (clean CSS print stylesheet: header, thread, attachments list)

---

## Phase 3 — Platform & API

### 3.1 Public API v1 completion
- [ ] New scopes: `tickets:notes` (add note/reply), `tickets:attachments` (upload/download), `approvals:read/write`, `tags:read/write` — each individually grantable per key
- [ ] OpenAPI 3 spec generated + served at `/api/v1/openapi.json` + a rendered docs page (self-contained, public-safe)
- [ ] Settings → API Keys admin panel: create/revoke keys, scope picker, last-used timestamp, per-key rate-limit display
- [ ] Tests: scope enforcement per endpoint, spec validity

### 3.2 Attachment mirroring to FS fallback copies (WS-A.5)
- [ ] Mirror queue: TP-born ticket attachments (≤ FS size limits) attach to the FS copy on create/upload; failures logged non-fatally, badge shows partial mirror
- [ ] Tests: queue behavior, size-cap skip, failure tolerance

### 3.3 Perf + hygiene debt
- [ ] `ticketActivityRepository` JSON-details filtering → proper indexed columns (additive migration + backfill) or GIN index — measure first, pick cheapest that removes the scan
- [ ] Workflow graph v1→v2 migration (structured condition groups everywhere) + delete the dual-path handling
- [ ] Archive stale MVP docs (`docs/todo.md`, `docs/product.md` → `docs/archive/`) with a one-line pointer to AGENTS.md

---

## Phase 4 — Analytics unlocks (secondary priority)

### 4.1 First-response metrics
- [ ] Backfill `firstPublicAgentReplyAt` from cached thread entries (agent public replies exist in `ticket_thread_entries` for both origins now); ongoing population already wired — verify
- [ ] Unlock the gated first-response analytics (Overview + Quality) once coverage ≥ threshold; keep the sparse-data caveat banner logic
- [ ] Tests: backfill idempotency, coverage gate

### 4.2 Origin dimension + map polish
- [ ] TP-born vs FS-born as a filter/split in Analytics (Demand & Flow + Overview) — deterministic counts only
- [ ] Category-map: timeline animation × Agent-Lens interaction fix (animation currently disabled under lens); polish pass on lens UX
- [ ] Tests: dimension math

---

## Phase 5 — LLM evidence tools go-live (secondary priority)

Policy decided: internal notes ARE allowed as evidence, guarded — the output guard hard-blocks verbatim quoting of internal notes and flags close paraphrases for audit.

- [ ] Implement the internal-notes evidence policy: notes enter the evidence bundle labeled `internal`; output guard rule blocks verbatim/near-verbatim internal content in requester-facing drafts (extend `notificationWorkflowOutputGuard`)
- [ ] Resolve remaining open decisions (defaults unless overridden at build): `context_only` default for NEW/edited workflows only; no per-workflow opt-out of workspace policy; ILIKE search first, pg_trgm after prod cost data; admin can manually mark a known outage
- [ ] Rollout sequence: 1 week mock mode on one non-critical workflow → audit review (unsupported claims, latency, tokens) → admin banner on first enable → enable live per-workflow
- [ ] Milestone D leftovers: last-used/last-error tool indicators in the admin UI; prod smoke script (catalog, policy, context preview, mock/live)
- [ ] Tests: guard rules for internal evidence; tool loop regression

---

## Phase 6 — Wrap & ship

- [ ] Full lint + backend/frontend suites green
- [ ] Version → next preview bump + concise changelog (fixes-first)
- [ ] Dev self-test (no outbound email / FS writes — same guardrails as before)
- [ ] Migrations: dev during phases; prod via `migrate deploy` at deploy
- [ ] QA test doc for the new surfaces (tags, merge, bulk-by-query, API panel)
- [ ] Deploy to prod on user go-ahead → verify health/version + probe new endpoints

---

## Backlog (named, not in this plan)
- Requester SSO portal + FS intake cutover (separate initiative — user decision 2026-07-07)
- Presence ("N viewing"), command palette / j-k nav, per-ticket task checklists
- Requester sentiment on threads; semantic/vector similar-ticket retrieval
- Future LLM evidence tools: status page, monitoring incidents, change windows, KB articles
- Per-workspace email icon sets; feedback-page custom emoji / BYO rating images
- `NotificationWorkflowContextSnapshot` table (only if step output size becomes a problem)

## Traceability
| Gap (from review) | Phase |
|---|---|
| Tags (deferred 2×) | **1** |
| Merge tickets | 2.1 |
| Bulk edit by query | 2.2 |
| Per-group taxonomies + mapping UI | 2.3 |
| Approval rich text | 2.4 |
| Impact/urgency, print view | 2.5 |
| API scopes / OpenAPI / key panel | 3.1 |
| Attachment mirroring to FS (WS-A.5) | 3.2 |
| Activity-repo perf, workflow v1→v2, stale docs | 3.3 |
| First-response unlock | 4.1 |
| Origin dimension, map polish | 4.2 |
| LLM tools rollout + policy + Milestone D | 5 |
| Portal, presence, sentiment, vector, icons… | Backlog |
