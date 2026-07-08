# Features Request 07-07 — Implementation Plan

Source: `docs/Features Request - 07-07.docx` (8 items). Investigated against **main @ v3.0.9-preview** (post gap-fill 2 + AP reorg) — none of the items were resolved by today's releases; item 4's plumbing already works end-to-end but has never been proven or made discoverable, and item 5 is a real validation/UX bug.

Working branch: `cursor/workflow-enterprise` (rebased onto v3.0.9). Version at ship time: check prod `/health` first (main moves fast) — expect **3.0.10-preview**.

Per-phase gate: backend lint + jest, frontend lint + vitest, item-level self-test where feasible. Deploy only on go-ahead, then the branded response PDF next to the request doc (standing QA loop).

---

## Phase 1 — Bug fixes & small asks (items 5, 6, 2, 7) ✅ DONE

### 1.1 (Item 5) "Stage for approval" publish error — fix both the rule and the UX  ✅ root-caused
The validator (`notificationWorkflowDefinition.js:685`) requires `propose_reply` to have an upstream `llm_generate`; a `template_render → propose_reply` chain is rejected, and the client toast shows only the generic "Notification workflow definition is invalid" — the specific `errors` array is thrown server-side (`ValidationError` details) but never surfaced.

- [x] **Allow staging template output**: extend the `propose_reply` executor to fall back to `state.template` rendered output (subject/html/text) when no LLM draft exists; relax the validator to accept `template_render` **or** `llm_generate` upstream (staging a rendered template for human approval is a legitimate flow)
- [x] **Surface real errors**: include `details` in the error response for workflow save/publish; frontend toast lists the actual validation messages (first 2 + count), not the generic line
- [x] **Editor guardrails**: the palette's "Stage for approval" node shows an inline hint when its upstream is invalid (mirror of the backend rule) so users see the problem before save
- [x] Tests: template→propose staging works in the engine; validator accepts both shapes; error details serialize

### 1.2 (Item 6) Ticket linking accepts real-world refs
`ticketLinkService.link()` resolves only internal ids; users type the visible refs (`TP-1042`, `#231164`). Search already parses these (`ticketService.buildListWhere` q-handling).

- [x] Shared `resolveTicketRef(refString, workspaceId)` in ticketService: accepts internal id, `TP-####`, `#123456`, bare number (native first, then FS id) — workspace-scoped
- [x] Link / mark-duplicate / merge endpoints accept a `ref` (keep `relatedTicketId` for compat); clearer 404 message naming the ref that failed
- [x] `TicketLinksCard` placeholder → "TP-1042 or 231164"; strip `#`/whitespace client-side; likely-target chips (shipped in 3.0.8) remain the one-click path
- [x] Tests: resolver matrix (TP ref, FS number, plain id, cross-workspace miss)

### 1.3 (Item 2) Internal-note composer: Quick notes only
`TicketDetail.jsx` — Quick notes already render only in note mode (L1968); Templates render in **all** modes (L1998).

- [x] Hide the Templates picker when `composerMode === 'note'` (reply templates are requester-facing content; quick notes are the internal canned layer)
- [x] Keep Templates for reply + forward modes; visual spacing re-check after removal

### 1.4 (Item 7) Remove Time Tracking
Cleanly isolated, no FK dependents, no tests. Remove the feature surface; **keep the three ticket columns** (dropping columns is a destructive migration with zero upside — they're nullable and invisible).

- [x] Frontend: remove `TimeTrackingCard` (TicketOpsCards.jsx L285–359), its render + import in TicketDetail.jsx, `api.js logTime`
- [x] Backend: remove `POST /:id/time` route + `ticketService.logTime`
- [x] Note in AGENTS.md/CLAUDE.md sync that time tracking was retired on request

---

## Phase 2 — Workflow authoring UX (items 3, 4)

### 2.1 (Item 3) Create workflow / sub-workflow + editable trigger
Today workflows can only be born from a **template install** or "**+ New variant**" of an existing workflow — there is no blank-start; the trigger event is read-only text in the inspector.

- [ ] **"+ New workflow" button** (always visible in the list header): opens a creation dialog — name + trigger picker (all event types incl. time-based, grouped, with descriptions) + optional "start from template" gallery (folds item 4's discoverability in) → creates a disabled draft scaffold (trigger → stop)
- [ ] **"Sub-workflow" creation choice** in the same dialog: creates a workflow with a `manual` trigger type (new trigger meaning "runs only when called by a Run-workflow node or manual dispatch") so reusable subflows are first-class instead of "a disabled workflow that happens to be called"
  - Engine: `manual` trigger never matches lifecycle events; `run_workflow` node dropdown lists manual-trigger workflows first
- [ ] **Editable trigger**: the trigger inspector's event type becomes a select; changing it re-validates the graph (some nodes/conditions are event-specific — surface any resulting issues via the improved 1.1 error display), preserves nodes, resets trigger-specific params sensibly
- [ ] Tests: scaffold creation, manual-trigger exclusion from lifecycle dispatch, trigger-change revalidation

### 2.2 (Item 4) AI first-reply draft — prove it, then make it findable
Investigation: the template's full chain **is implemented** (ticket.created → `llm_generate` → `propose_reply` → `ticket_proposed_replies` → `ProposedReplyCard` with Approve-&-send / Edit / Dismiss). It is not a placeholder. What's missing is proof and discoverability (it hides behind the toolbar "Templates" sparkles menu).

- [ ] **End-to-end functional audit in dev**: install the template, enable it, create a guardrailed throwaway ticket, verify the run executes (llm_generate produces a draft; proposal row created; card renders; Approve-&-send path gated by no-email dev config; Edit-in-composer prefills; Dismiss clears) — scripted like selftest-306, kept as `scripts/selftest-ai-first-reply.mjs`
- [ ] Fix anything the audit shakes out (e.g. confidence gating defaults, guard summary rendering, ticket.created timing vs AI triage)
- [ ] **Discoverability**: templates move into the "New workflow" creation dialog as a first-class gallery (2.1); the ProposedReplyCard stays on the ticket— add a queue-row indicator (small sparkle dot) when a ticket has a pending proposed reply so drafts don't sit unseen
- [ ] Docs: short "AI drafted replies" section in the workflow page's help popover

---

## Phase 3 — Ticket source channel (item 1)

Goal: workflows (and the queue) can condition on **how the ticket arrived**: Email / Portal / Phone / API / Webhook / Agent-created — across both origins, extensible for future portal intake.

Current state: FS-born tickets carry FS's numeric `source` (1=Email, 2=Portal, 3=Phone… via `FS_SOURCE_LABELS`); TP-born tickets never set `source` (only `lastIngestSource: 'ticketpulse_native'`); the workflow event context exposes `origin` but not `source`.

- [ ] **Persist source for TP-born tickets** at creation, reusing the FS numeric space + TP extension range (values ≥100 so FS never collides):
  - app/agent-created → `103 (Agent)`  · email ingest (mailbox) → `1 (Email)` · public API v1 → `100 (API)` · scheduled activation → inherits creator's channel · future portal → `2 (Portal)`, webhook intake → `101 (Webhook)`
  - one label map (`TICKET_SOURCE_LABELS`) shared by queue meta, CSV, and workflows; backfill existing TP-born rows to `103` (email-ingested ones detectable via `lastIngestSource`/mailbox provenance → `1`)
- [ ] **Expose `ticket.sourceLabel`** in the workflow event context (buildEventContext) as the friendly enum string
- [ ] **Condition field** `ticket.source` (enum: Email, Portal, Phone, Chat, API, Webhook, Agent, …) in both catalogs (backend `CONDITION_FIELDS` + frontend `CG_FIELDS`) — enum `is / is not / any of`
- [ ] Queue: the existing source filter flyout + stat labels pick up the new values automatically (they read the groupBy) — verify
- [ ] Migration: none needed for FS values; one additive backfill script for TP-born rows
- [ ] Tests: creation channels set the right source; context exposes label; condition evaluates

---

## Phase 4 — Workflow page overhaul (item 8)

The canvas is already **React Flow** (the industry standard — Stripe/Typeform-class tooling; no library change needed there). The weak layers are the **list** and the **visual language**. Research reference points: Zapier's workflow index (status toggle + last-run health + folders), n8n's list (search/sort/tags/owner), ServiceNow Flow Designer (trigger-first grouping).

### 4.1 Workflow index, redesigned
Replace the ~300px sidebar list with a **proper index view** shown when no workflow is open (full width), collapsing to a compact rail when editing:

- [ ] **Card/table hybrid rows**: trigger icon + workflow name, enabled toggle (inline, optimistic), chips (Default/Variant, after-hours, sub-workflow), **last-run status + relative time**, 7-day run count, failure indicator
- [ ] **Grouping & findability**: group-by-trigger (today's behavior) plus search-as-you-type, "enabled only" and "has failures" quick filters; collapse state persists
- [ ] **Empty/onboarding state**: when a trigger group is empty, inline "＋ create for this trigger" affordance; global empty state points at the template gallery
- [ ] **Health at a glance**: the ribbon stats (SendGrid, failures 24h) stay; failing workflows bubble to a pinned "needs attention" strip
- [ ] Component split: extract `WorkflowIndex.jsx` from the 10k-line `NotificationWorkflowsPanel.jsx` (structural refactor pays down the file; editor stays put this pass)

### 4.2 Visual polish pass (design-language alignment)
- [ ] Node cards on the canvas: consistent tp-card styling, type-colored left accents, clearer selected/error states, better edge styling (smoothstep, subtle animated dash on the active run path in audit view)
- [ ] Inspector: section rhythm, sticky node header, `.tp-focus-ring`/token adoption where raw grays remain
- [ ] Palette: grouped node picker with icons + one-line descriptions (today's flat list), drag or click-to-append
- [ ] Motion: 0.25–0.4s ease-out on list→editor transition; respects reduced-motion
- [ ] Before/after screenshots at 1920 + 390px (list only; canvas is desktop-first)

Deliberately **not** in scope: swapping React Flow, rewriting the editor architecture, workflow versioning UI changes.

---

## Phase 5 — Wrap & ship
- [ ] Full lint + both suites green (backend known-failure budget: 1 pre-existing CC-resolver test)
- [ ] Version bump following prod `/health` at that moment + in-app changelog
- [ ] Dev self-test (guardrails: no email, no FS writes, throwaway tickets, cleanup) covering 1.1/1.2/2.1/2.2/3
- [ ] QA test doc + **response PDF** ("Features Request - 07-07 - Response.pdf") next to the request doc
- [ ] Deploy on go-ahead → prod verify (health, bundle marker, new endpoints)

---

## Decisions (confirmed with Vahid, Jul 7)
1. **Overhaul depth**: incremental this round — index redesign + polish pass; full editor re-architecture deferred.
2. **Time tracking**: remove UI + API, keep the nullable DB columns (no destructive migration).
3. **App-created ticket source label**: **"Agent"** (new TP-range value, distinct from future Portal intake).
