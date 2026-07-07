# QA Feedback 07-06 — Fix Plan

**Source:** `qa/Features Request - 07-06.docx` (13 items, 17 screenshots) · **Created:** 2026-07-06 · **Target release:** 3.0.4-preview
**Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done. Work phase by phase; each phase ends green (lint + tests).

> Root causes marked **CONFIRMED** were verified in code during plan prep; others are hypotheses to validate first.

---

## Phase 1 — Sync correctness (highest severity, prod-affecting)

### 1.1 Prod incident: status→Resolved "network error" ×2 but succeeded + 2 resolved emails (QA #13, ticket 231648)
Symptom: changing an FS-born ticket to Resolved on prod failed twice with a network error, yet both FS and TP show Resolved and the requester got TWO "resolved" emails.
Likely chain (to verify): FS write-back exceeded the frontend's **30s axios timeout** (`api.js` default; `fsUpdate` uses the default client) → UI shows network error while the backend completes → user retries → second full write + second `ticket.resolved_closed` workflow fire (different dedupe stamps) → 2 emails.
- [ ] Investigate on prod (read-only): notification runs + deliveries for ticket 231648 (timestamps, dedupe keys), the two attempts' timing
- [ ] Fix A — timeout: route `fs-update`/status write-backs through a longer-timeout client (90s) and show an "applying…" state instead of failing at 30s
- [ ] Fix B — idempotency: a repeat status change to the same status must be a no-op end-to-end (no second FS write, no second lifecycle event); make the FS-born resolved_closed dedupe stamp stable across retries
- [ ] Fix C — UX: if the request errors client-side, verify actual state on refetch before showing "failed"
- [ ] Tests: idempotent re-resolve; stable dedupe stamp

### 1.2 FS-side requester replies not appearing in TP conversations (QA #4)
Symptom: requester replies by email → FreshService shows the reply immediately, Ticket Pulse conversation stays empty (screenshots show both).
**CONFIRMED root cause (TP-born):** `mirrorService.reconcile(workspaceId)` — which imports FS-side conversation entries for TP-born tickets — **is never called anywhere** (no worker, no schedule).
- [ ] Wire `mirrorService.reconcile` into a worker cadence (ride the mirror drain or its own interval, env-tunable)
- [ ] Reconcile-on-open: opening a TP-born ticket (non-silent) also imports fresh FS conversation entries (like FS-born reconcile does today)
- [ ] Verify the FS-born path too: confirm webhook/poll sync imports new requester conversations promptly; fix any gap found
- [ ] Fire `ticket.reply_received` for entries imported via reconcile (stable stamp = FS conversation id) so workflows react
- [ ] Tests: reconcile imports + no double-import; reply_received emitted once

---

## Phase 2 — Queue & detail interactions

### 2.1 Status dropdown on the ticket queue (QA #2)
- [ ] New `StatusPicker` on queue rows (pattern: AssigneePicker) — TP-born: simple "are you sure" confirm → `changeStatus`; FS-born: the existing `FsSyncConfirm` real-time sync flow, failing first if FS fails (same as assignee/category)
- [ ] Peek/mobile card parity where sensible; SSE refresh after change
- [ ] Tests: component + both confirm paths

### 2.2 Undo toast for instant saves (QA #3)
- [ ] Reusable "Saved — Undo (5s)" toast in TicketDetail for field edits (status, priority, category, group, assignee): keep the previous value, Undo re-applies it through the same API
- [ ] Same toast on the new queue status change (TP-born; FS-born undo re-runs the confirmed sync flow)
- [ ] Tests: undo restores the prior value

### 2.3 Category → "Uncategorized" impossible (QA #5)
Hypothesis: the UI never sends an explicit clear (`''` dropped / undefined skipped), so a category can't be removed once assessed. Backend zod already allows `nullable()`.
- [ ] Trace the detail category editor → ensure choosing "Uncategorized" sends `internalCategoryId: null` (+ clears subcategory) and the backend patch honors explicit null
- [ ] Tests: clearing works after AI assessment; audit records the change

---

## Phase 3 — Approvals & quick notes

### 3.1 Admins can't be approval managers (QA #7 — Vahid, Soheil, Mo, Sam, Susan missing)
**CONFIRMED root cause:** the manager picker lists `settingsAPI.getTechnicians()` only — admins who aren't workspace technicians never appear.
- [x] Extend the picker source to technicians **+ app users/admins** (labeled), or the Entra directory typeahead used by Members — pick whichever matches the approval flow (managers act in-app, so app users + technicians)
- [x] Backend: ensure approval routing/inbox works for manager emails that aren't technicians (it keys on email — verify)
- [x] Tests: an admin-only email can be added and receives/decides approvals

### 3.2 "Quick notes" — canned internal notes per top category, editable in settings (QA #12)
- [x] Model: `quick_notes` (workspaceId, name, body, internalCategoryIds int[], isActive, sortOrder) + additive migration (dev now, prod at deploy)
- [x] CRUD in Settings → Ticket Ops (new section; body + top-category multi-select)
- [x] Ticket composer: in **Internal note** mode show a "Quick notes" dropdown filtered by the ticket's top category (unscoped notes always shown); insert into the editor
- [x] Seed nothing — Gaby's three examples go in the QA response as ready-to-paste content, not hardcoded
- [x] Tests: CRUD + category filtering

---

## Phase 4 — Presentation & cleanup

### 4.1 Remove Mail Workflows from Settings (QA #1)
- [x] Remove the Settings nav item + section render (the homepage nav destination remains the single home). Keep the route working via the main tab only
- [x] Verify deep links to settings?section=notification-workflows redirect sensibly

### 4.2 Ticket header spacing (QA #6)
- [x] Per screenshot: even out subject ↔ type ↔ category spacing on the detail header (gap audit, one consistent rhythm)

### 4.3 Description: show more by default (QA #8)
- [x] Default to expanded; clamp only genuinely long descriptions (≈2 "pages" — pick a px threshold, e.g. ~1200px) with Show more; short/medium emails never clipped

### 4.4 Inline description images (QA #9)
- [x] Investigate how description images are stored per source (email-born cid images, TP-created pasted images) — why they land only in the attachments rail
- [x] Render inline images inline where the HTML references them; otherwise show an image strip directly under the description (click → existing preview lightbox)
- [x] Keep the attachments rail as the canonical list

---

## Phase 5 — Mobile

### 5.1 Template button overflows on mobile (QA #10)
- [x] Composer toolbar: make the Templates button/toolbar wrap or compact (icon-only under sm) so nothing exceeds the viewport

### 5.2 Bottom nav missing on Tickets pages (QA #11)
**CONFIRMED root cause:** `MobileTabBar` renders via `AppShell`, but Tickets/TicketDetail/TicketCreate render standalone (own `AppHeader`) — Settings adds it manually; Tickets pages don't.
- [x] Add `MobileTabBar` to Tickets, TicketDetail, TicketCreate (and any other standalone pages missing it)
- [x] Fix stacking: the mobile sticky "Create ticket" bar / composer must sit above the tab bar (safe-area + spacing), no overlap

---

## Phase 6 — Wrap & ship

- [ ] Full lint + backend/frontend suites green
- [ ] Version → **3.0.4-preview** + concise changelog (fixes-first)
- [ ] Self-test the sync fixes on dev (no outbound email / FS writes — action-only or mock, same guardrails as last time)
- [ ] Dev migrations applied (`quick_notes`); prod migration at deploy via `migrate deploy`
- [ ] Branded **QA response PDF** next to the request file (per the established loop): item-by-item what changed, incl. the 231648 incident explanation
- [ ] Deploy to prod on user go-ahead → verify health/version + probe new endpoints

---

## Item → phase map (traceability)

| QA item | Phase |
|---|---|
| #1 Remove Settings Mail Workflows tab | 4.1 |
| #2 Queue status dropdown + confirms | 2.1 |
| #3 Undo toast | 2.2 |
| #4 FS replies not syncing to TP | **1.2** |
| #5 Category → Uncategorized | 2.3 |
| #6 Header spacing | 4.2 |
| #7 Admins as approval managers | 3.1 |
| #8 Description show-more default | 4.3 |
| #9 Inline description images | 4.4 |
| #10 Mobile Template button overflow | 5.1 |
| #11 Mobile bottom nav on Tickets | 5.2 |
| #12 Quick notes (canned internal notes) | 3.2 |
| #13 Resolved "network error" + double email (231648) | **1.1** |
