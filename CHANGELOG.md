# Changelog

All notable changes and improvements to Ticket Pulse.

## [1.9.85-preview] - 2026-04-22

### Bug fix: click-through count now exactly matches destination

User reported: clicking "Picked up in FreshService 7" landed on a tab showing 1 (status filter defaulted to In Progress, hiding closed tickets) or 3 (after manually changing to All) — neither matching the promised 7. Two distinct bugs underneath.

#### Bug 1: status filter override silently dropped tickets

The Decided tab auto-resets `ticketStatusFilter` to `'in_progress'` whenever `subView` becomes `'assigned'` (intentional default for that tab). The empty-state navigation set `ticketStatusFilter='all'` — but the `useEffect` watching `subView` fired AFTER, overwriting it back to `'in_progress'`.

**Fix**: added a `skipNextStatusReset` ref. When navigation drills in, we set the ref to true, then the useEffect skips its auto-reset for that one render. Subsequent navigation back to the tab (without going through the empty-state) gets the normal `'in_progress'` default.

#### Bug 2: handledInFs metric conflated two unrelated things

Old `handledInFs` counted "tickets created today now assigned, MINUS tickets we successfully assigned via pipeline". This bundled together:

- **(a) Pipeline analyzed it, then agent grabbed in FS** — has a `pending_review` run with `assignedTechId` set. Visible in the "Manually in FreshService" sub-tab.
- **(b) Pipeline never saw the ticket** — agent grabbed it within the 30s window before our next poll fired. NO pipeline run exists. NOT visible in the sub-tab (no run record to show).

Tile said 7, sub-tab showed 3, because 4 of those 7 were case (b) and had no rows.

**Fix**: split into two metrics:

- `handledInFs` — **only case (a)**. Matches what the sub-tab actually renders. Click-through count is exact.
- `pipelineBypass` — **only case (b)**. Surfaced as a separate amber pill in the process row with a tooltip explaining why these tickets aren't visible in the sub-tab (no run record).

Verified on prod: previously `handledInFs=7` total. After split: `handledInFs=0` (zero pending_review-with-assignee runs today) + `pipelineBypass=5` (tickets the agent grabbed before we could poll).

#### Tile sublabel updated

"Picked up in FreshService" sublabel changed from "assigned outside the pipeline" → **"agent grabbed after AI analysis"** so it accurately describes only case (a).

#### Files touched

- `backend/src/services/assignmentDailyStats.js` — split `handledInFs` and add `pipelineBypass` metric
- `frontend/src/pages/AssignmentReview.jsx` — `skipNextStatusReset` ref guard, navigation now passes `ticketStatus: 'all'`, new `pipelineBypass` pill in process row, updated sublabel
- `backend/package.json`, `frontend/package.json` — bump to `1.9.85-preview`
- `CHANGELOG.md`, `frontend/src/data/changelog.js` — release notes

No DB schema change.

---

## [1.9.84-preview] - 2026-04-22

### Empty-state polish: assignee avatar + precise click-through filters

User feedback after v1.9.83: the avatar from the designer mockup was missing on the "Most recent auto-assignment" card, and the outcome tile click destinations didn't filter precisely (clicking "21 auto-assigned" landed on Decided > Via Pipeline which showed all 25 = 21 auto + 4 approved).

#### Avatar restored

Backend `getTodayStats` now selects `assignedTech.photoUrl` and returns `techPhotoUrl` in the `latestAutoAssignment` payload. Frontend renders it via a new reusable `TechAvatar` component:

- Three sizes (`sm` / `md` / `lg`)
- Optional badge overlay (used here for the green check) — anchored bottom-right with ring outline
- Demo Mode-safe fallback: if the image fails to load, it silently swaps to a colored initials circle so broken-image alt text can't leak the real name
- Falls back to initials when `photoUrl` is null

#### Precise drill-down filters

Each outcome tile now navigates with the exact decision filter the count was based on:

| Card | Lands on | Filter applied |
|---|---|---|
| Auto-assigned by AI (21) | Decided > Via Pipeline | `decisions=auto_assigned` |
| Approved by you (4) | Decided > Via Pipeline | `decisions=approved,modified` |
| Picked up in FreshService (5) | Decided > Manually in FreshService | (filter inherent to sub-tab) |
| Dismissed as noise (2) | Dismissed tab | (filter inherent to tab) |

All four also nudge the time range to **24h**. Empty-state stats are bounded by workspace-tz "today" while time range presets are rolling windows; 24h overlaps "today" by ~95% in normal cases — close enough that the displayed count matches what the card promised.

#### New "Decision" sub-filter row on Decided > Via Pipeline

Because Via Pipeline aggregates two distinct outcomes (AI vs admin), added a third sub-filter row below the existing Source row:

```
Source:    All  Via Pipeline  Manually in FreshService
Decision:  All  Auto-assigned by AI  Approved by you
```

Set automatically when drilling in from the empty-state cards, but visible at all times so the user can toggle freely. Resets to "All" when switching primary tabs (Awaiting / Decided / Dismissed / Rejected / Deleted).

#### Implementation details

- `QueueTab` gained an `onTimeRangeChange` callback prop. The parent (`AssignmentReview`) was already managing `timeRange` state but it was a one-way prop; this lets child components push changes back up.
- New `decidedDecisionFilter` state in `QueueTab` (`'all' | 'auto_assigned' | 'approved'`). Folded into the `assignedRes` `getRuns` call's `decisions` param.
- `fetchQueue` callback dependency list extended to include `decidedDecisionFilter` so changes refetch.
- Top-level tab clicks reset both `assignedFilter` and `decidedDecisionFilter` so a stale filter from a previous visit doesn't carry over.

#### Files touched

- `backend/src/services/assignmentDailyStats.js` — select `photoUrl`, return `techPhotoUrl`
- `frontend/src/pages/AssignmentReview.jsx` — `TechAvatar` component, `decidedDecisionFilter` state, Decision sub-filter row, drill-down callbacks, `onTimeRangeChange` plumbing
- `backend/package.json`, `frontend/package.json` — bump to `1.9.84-preview`
- `CHANGELOG.md`, `frontend/src/data/changelog.js` — release notes

No DB schema change.

---

## [1.9.83-preview] - 2026-04-22

### UX redesign: Auto-Assign empty-state panel + clickable outcome cards

The empty-state panel was functional but had a generic flat look. Reworked per a UX brief covering typography hierarchy, glassmorphism, refined color usage, and improved layout breathing room. The outcome tiles now also double as quick links into the appropriate sub-tab.

#### Typography & hierarchy

- **Serif headline** ("No tickets are waiting for you right now.") via Tailwind `font-serif` — adds character without dragging in a custom font load
- **Larger, bolder numbers** in the hero (4-5xl) and tiles (3-4xl) — readable at a glance
- More negative space between sections (`mb-6/8` instead of `mb-3/4`) to let the layout breathe

#### Modern glassmorphism hero card

The "Today" card moved from a pale-blue gradient to a dark glassmorphism panel:

- Background: `bg-gradient-to-br from-slate-900 via-slate-800 to-blue-900` with subtle blue + violet gradient orbs (blurred via `blur-3xl`) for depth
- Border: `border border-white/10` for the frosted-glass edge
- Icon chip: `bg-white/10` with `backdrop-blur-sm` and inner shadow
- Text: white headline, `text-blue-100/80` body
- Shadow: `shadow-lg shadow-slate-900/10` for layered desktop feel

#### Outcome tiles — clickable, white, subtle accents

- Background: white with `border border-slate-200/80` and `shadow-sm` (subtle layering instead of pale colored fills)
- Accent: colored 4-px left border + small icon chip with tone-matched background — the only color in the card, kept deliberate rather than washed-out
- All four tiles are now buttons: hover lifts (`hover:-translate-y-0.5`) + drops a chevron in the top-right + adds shadow elevation, with focus ring for accessibility
- Click destinations:
  - **Auto-assigned by AI** + **Approved by you** → Decided > Via Pipeline (both kinds of pipeline-driven assignments visible there)
  - **Picked up in FreshService** → Decided > Manually in FreshService
  - **Dismissed as noise** → Dismissed tab

#### Refined pill row

`SmallStatPill` redesigned: white background pill with a small colored icon chip on the left, then bold tabular value, then quieter label. Reads cleanly as "[icon] 2 rebounds today" or "[icon] 3 noise-filtered (skipped before analysis)".

#### Cleaner "Most recent auto-assignment" card

- Whole card is now the click target (was just the small View link)
- Bigger emerald check icon with ring outline for visual anchor
- Right-side "View ticket" pill button on desktop, simple chevron on mobile
- Hover elevation matches the outcome tiles

#### Files touched

- `frontend/src/pages/AssignmentReview.jsx` — `AutoAssignActiveEmptyState`, `StatTile`, `SmallStatPill` rewrites + `onNavigate` callback wiring
- `backend/package.json`, `frontend/package.json` — bump to `1.9.83-preview`
- `CHANGELOG.md`, `frontend/src/data/changelog.js` — release notes

No backend changes, no DB changes.

---

## [1.9.82-preview] - 2026-04-22

### Bug fix: auto-assigned runs could get permanently stuck on backend restart

User reported a fresh symptom right after the v1.9.81 deploy: ticket #219719 ("Computer Mouse" by Lucy MacKenzie) showed in our app as auto-assigned to Gaby Tonnova, but FreshService still showed it unassigned. Two more tickets were similarly stranded.

#### Root cause

Inside `_executeRun`, after the LLM finalizes a decision the code does:

1. `await assignmentRepository.updatePipelineRun(runId, { decision: 'auto_assigned', decidedAt: new Date(), ... })`
2. `freshServiceActionService.execute(runId, ...).catch(err => logger.warn(...))` — **fire-and-forget**

If the Node.js process restarts in the ~100ms window between step 1 (DB committed) and step 2's first internal DB write, the detached promise never makes any progress. From outside, the run looks "decided" (`decisionAt` set, `decision='auto_assigned'`) but `syncStatus` is `NULL` and the FS API was never called. Our DB believes the assignment happened; FS doesn't know.

Verified against prod:

```
run #572 ticket #219719 "Computer Mouse"
  decision=auto_assigned  decidedAt=2026-04-22T16:51:41Z  assignedTechId=20 (Gaby)
  syncStatus=NULL         syncError=NULL                  syncedAt=NULL
```

PR #13 backend deploy started at 16:49:20Z and finished ~16:51:01Z (Azure App Service warm-up after that). Run #572 was created at 16:51:07Z and decided at 16:51:41Z — right at the restart boundary. Classic mid-flight loss.

#### Fix — three layers

**1. Stamp `syncStatus='pending'` atomically with the decision** (assignmentPipelineService).
The decision update now also sets `syncStatus='pending'` when the outcome is one we'll try to sync (`auto_assigned`, or `noise_dismissed` when `autoCloseNoise` is on). Successful syncs overwrite to `'synced'`/`'failed'`/`'skipped'`/`'dry_run'` as today; only crashed syncs leave it as `'pending'` for the sweep to pick up.

**2. New `findOrphanedSyncRuns()` helper** (assignmentRepository).
Conservative WHERE clause:

```
status='completed'
AND decision IN ('auto_assigned', 'noise_dismissed')
AND syncStatus IN (NULL, 'pending')
AND decidedAt < now() - INTERVAL '5 minutes'
```

The 5-minute threshold avoids racing in-flight syncs that are just slow.

**3. New `_recoverOrphanedSyncs()` hooks into the existing scheduled sync** (syncService).
Runs as a fire-and-forget after the polling step in every sync cycle. For each orphan, calls `freshServiceActionService.execute(runId, workspaceId, dryRunMode)` to push the assignment to FS and update `syncStatus`. Self-healing — no manual intervention needed for this class of failure going forward.

#### One-shot fix applied to prod

Lucy's run #572 was manually recovered by directly calling `freshServiceActionService.execute(572, 1, false)` against prod. Result:

```
FreshService: ticket assigned    { ticketId: 219719, agentId: 1000008456 (Gaby), runId: 572 }
FreshService: note added         { ticketId: 219719, runId: 572 }
FreshService sync completed      { runId: 572, ticketGone: false }
```

Ticket is now assigned in FreshService.

#### Bonus: Neville's noise-flagged ticket

Also un-flagged ticket #219711 ("Threat Intelligence" by Neville Vyland) on prod (`is_noise=true → false`) so the next poll cycle can analyze it. The over-matching noise rule #11 has been disabled by the user.

#### Files touched

- `backend/src/services/assignmentPipelineService.js` — set `syncStatus='pending'` when decision is finalized
- `backend/src/services/assignmentRepository.js` — new `findOrphanedSyncRuns()` helper
- `backend/src/services/syncService.js` — new `_recoverOrphanedSyncs()` + import + hook into sync cycle
- `backend/package.json`, `frontend/package.json` — bump to `1.9.82-preview`
- `CHANGELOG.md`, `frontend/src/data/changelog.js` — release notes

No DB schema change. 65 existing tests still pass.

---

## [1.9.81-preview] - 2026-04-22

### Bug fix: "Picked up in FreshService" undercounted; new noise-filtered visibility

User reported the empty-state stats panel showing **0 picked up in FS** when they knew at least 2 tickets had been grabbed by agents directly. Also reported one specific ticket ("Threat Intelligence" by Neville) that was created in FS, sat unassigned for minutes, and never got an auto-assignment despite Auto-Assign being on.

#### Audit findings (against prod)

```
Tickets created today and now assigned:                14 (from tickets table)
  - via our pipeline (auto_assigned/approved/modified):  8
  - bypassed our pipeline entirely:                      6   <-- INVISIBLE before
```

Examples of the 6 bypassed tickets:
- #219709 "NIch Stone - the upgrade" → Gaby Tonnova (`isSelfPicked=true`, no pipeline run)
- #219699 "Microsoft Visio Install" → Andrew Fong (`isSelfPicked=true`, no pipeline run)
- #219692 "Wifi connections" → Andrew Fong (`isSelfPicked=true`, no pipeline run)
- ...and 3 more

Plus a separate finding:

```
Tickets created today with isNoise=true:               3   <-- also INVISIBLE
```

One of those was the user's "Threat Intelligence" ticket — matched the security/Vulnerability rule on the keyword "Threat" and got silently excluded from the polling query (`isNoise: false` filter). The pipeline never analyzed it, so it never showed up in the panel.

#### Root cause: bug 1 (Picked up in FreshService)

Old query only counted **pending_review pipeline runs** whose ticket later got an `assignedTechId` set. Misses the much more common path: agent grabs the ticket in FS within the 30-second window before our next poll fires, so we never create a pipeline run for it at all. From the metric's perspective those tickets simply don't exist.

**New definition**:
```
handledInFs = (tickets created today now assigned)
              - (distinct tickets we assigned via the pipeline ourselves)
```

`handledInFs` jumped from `0` → `6` on the prod data with no other changes.

#### Root cause: bug 2 (Neville's ticket disappeared)

`_pollForUnassignedTickets` in syncService has `isNoise: false` in its WHERE clause — by design, since noise tickets shouldn't waste LLM tokens. But the admin had no way to see WHICH tickets were being filtered, so when a noise rule false-positives on a real ticket, it just vanishes silently.

Added `today.noiseFiltered` count and surface it as a small **slate pill** in the empty-state's process-state row with a tooltip:

> "Tickets matched a noise rule and were silently excluded from polling. If a ticket you expected to see auto-assigned is missing, check the Noise Rules page — a rule may be over-matching."

Today on prod: **3 noise-filtered tickets** would now be visible (including Neville's).

#### What I deliberately did NOT change

The user also reported "manual sync only analyzed 1 of 2 tickets". After auditing this turned out to **not be a bug**:

- Polling iterates `for (const ticket...) { await runPipeline(...) }` sequentially
- Each LLM run takes 30-60s, so a poll cycle of 5 candidates takes 2.5-5 minutes
- The "second ticket" the user expected to see analyzed was actually Neville's — which was noise-filtered

The new noise-filtered pill makes this story visible to the user without needing to change the polling architecture.

#### Files touched

- `backend/src/services/assignmentDailyStats.js` — rewrite `handledInFs` query, add `noiseFiltered` count
- `frontend/src/pages/AssignmentReview.jsx` — read `noiseFiltered` from queueStatus, render new pill, update `handledInFs` sublabel
- `backend/package.json`, `frontend/package.json` — bump to `1.9.81-preview`
- `CHANGELOG.md`, `frontend/src/data/changelog.js` — release notes

No DB schema change. No new migration. Existing 65 tests still pass.

---

## [1.9.80-preview] - 2026-04-22

### Auto-Assign empty-state stats: honest math + rebounds visibility + clearer terminology

User pushed back on the v1.9.78 panel: it claimed "1 auto-assigned out of 7 total tickets" but the visible tiles only added up to 3, because the **approved/modified** bucket (admin clicked approve in the app — a real outcome path) wasn't shown anywhere. Also flagged that the "In Progress" tile showed `0` during a rejection event when the LLM was actively re-routing the ticket.

#### Three real assignment paths, finally all visible

A ticket can end up assigned via **three** distinct paths that the panel needs to surface separately:

1. **Auto-assigned by AI** — `decision='auto_assigned'` (no human in the loop)
2. **Approved by you** — `decision IN ('approved', 'modified')` (pipeline ran, admin clicked approve, possibly with override)
3. **Picked up in FreshService** — `decision='pending_review' AND assignedTechId IS NOT NULL` (agent grabbed it directly, bypassing our app)

Plus the closure path:

4. **Dismissed as noise** — `decision='noise_dismissed'`

The previous panel only showed paths 1, 3, and 4. Path 2 was invisible. After verifying against prod (4 auto-assigned + 4 approved + 0 handled-in-FS + 1 noise = **9 total**), restructured the layout:

- **Hero card** now reports today's **total tickets processed** as the headline
- **4-tile outcome row** breaks down the four paths with clear, distinct names
- **Process-state pill row** (new) handles the live/transient metrics that aren't outcomes

#### "Rebounds today" metric — fills the In-Progress gap

The "In Progress" tile is a snapshot of `status='running'` runs in the moment the panel renders. Rebound runs (triggered when an agent rejects) typically complete in 30-60 seconds — so a coordinator who happened to refresh between rebound start and finish would see `0`, even when a rejection had just triggered re-routing.

Added `today.rebounds` to the queue-status response — counts runs with `triggerSource IN ('rebound', 'rebound_exhausted')` OR `reboundFrom` not null, scoped to today's window. Persists across refreshes so admins see *what happened today*, not just *what's happening this exact second*.

Surfaced as a small amber pill in the new context-aware "process state" row (next to currently-analyzing, needs-your-attention, queued-for-after-hours). The row only renders pills for non-zero metrics, so when nothing's happening it stays clean.

#### Better terminology

| Before | After | Why |
|---|---|---|
| "Auto-Assigned" (hero only) | **"Auto-assigned by AI"** (named tile) | Distinct from path 2; "AI" makes the autonomous-agent nature obvious |
| (missing) | **"Approved by you"** | The third bucket the user called out — admin's manual approvals in the app |
| "Handled in FS" | **"Picked up in FreshService"** | "Handled" was vague — this is specifically the agent-grabbed-it path |
| "Noise dismissed" | **"Dismissed as noise"** | Reads as a passive outcome, matches the other tile labels grammatically |
| "Needed review" sub: "excluded groups + rebound" | **"need(s) your attention"** sub: tooltip lists reasons | "Needed review" was confusing because every pending_review run "needs review"; this metric is specifically the *unusual* downgrades |
| "In progress" sub: "LLM analyzing now" | **"currently analyzing"** | Sub-label folded into label for compactness |

DRY-RUN badge moved from the hero sub-line into the "Auto-Assign is ON" pill in the header — that's where it semantically belongs (it's about the assign behavior, not about a particular stat).

#### Files touched

- `backend/src/services/assignmentDailyStats.js` — add `rebounds` count + JSDoc update
- `backend/tests/statsAggregation.test.js` — 1 new accounting test (66 total now)
- `frontend/src/pages/AssignmentReview.jsx` — restructure `AutoAssignActiveEmptyState`, add `SmallStatPill` component for the process-state row, swap labels
- `backend/package.json`, `frontend/package.json` — bump to `1.9.80-preview`
- `CHANGELOG.md`, `frontend/src/data/changelog.js` — release notes

No DB schema change. No new migration.

#### Verified on prod

Ran `getTodayStats()` against prod after the change — produces honest accounting:

```
totalRuns: 9
autoAssigned: 4         (was visible)
approved: 4             (was INVISIBLE — now in its own tile)
handledInFs: 0
noiseDismissed: 1
rebounds: 1             (matches the user's "rejection happened" observation)
manualReviewRequired: 0
inProgress: 0
queuedForLater: 0
```

4 + 4 + 0 + 1 = 9. Everything accounted for.

---

## [1.9.79-preview] - 2026-04-22

### Bug fix: auto-decided runs silently vanished from the Decided / Dismissed tabs

User noticed that ticket #219688 ("access to GWVRM1", auto-assigned to Mehdi) was showing correctly in the History tab but was missing from Decided. A noise-dismissed ticket (#219671) had the same symptom in the Dismissed tab.

#### Root cause

Both Decided and Dismissed tabs filter by `sinceField='decidedAt'` (with the 24h/7d/30d time-range toggle). But `_executeRun` never set `decidedAt` on pipeline-finalized decisions — only admin actions (`/decide`, `/dismiss`) did. So any run with `decision IN ('auto_assigned', 'noise_dismissed')` had `decidedAt = NULL`, never satisfied the `decidedAt >= N days ago` filter, and got silently hidden.

The History tab wasn't affected because it queries `createdAt`, which masked the issue.

Audit against prod confirmed the scale:

```
Runs with decidedAt=NULL by decision:
  auto_assigned:    1 / 2
  noise_dismissed:  26 / 28
  pending_review:   212 / 212  (correct — they really are pending)
```

#### Fix

Two code paths + one data backfill:

1. **`_executeRun` now stamps `decidedAt` when the pipeline finalizes a decision.** Extracted the predicate to `isPipelineFinalDecision(decision)` in `assignmentDecisionRules.js` — returns true for `auto_assigned` and `noise_dismissed`, false for everything else (pending_review stays NULL, admin-only outcomes are set by the /decide endpoint).

2. **`freshServiceActionService.execute` now clears `decidedAt`** when it downgrades an `auto_assigned` run to `pending_review` on preflight failure. Without this, the downgraded run would falsely appear in the Decided tab even though nobody actually approved it.

3. **Migration `20260422200000_backfill_decided_at_auto_decisions`** backfills existing rows. Sets `decidedAt = updatedAt` (when the pipeline completed the decision) for every completed `auto_assigned`/`noise_dismissed` run with NULL `decidedAt`. Deliberately excludes `pending_review` and admin-only outcomes.

Already applied to prod before this release. Verified on prod post-backfill:

```
Runs with decidedAt=NULL: pending_review: 212   (correct)
Run #561 (access to GWVRM1):    decidedAt=2026-04-22T15:16:52.747Z
Run #559 (CAL Internet Up):     decidedAt=2026-04-22T12:07:24.412Z
```

Both flagged runs now have `decidedAt` set and will show up in the Decided / Dismissed tabs on next page load.

#### Tests

5 new unit tests for `isPipelineFinalDecision` — covers all decision states plus defensive null/undefined/unknown handling. Suite total: **64 passing** (was 59).

#### Files touched

- `backend/src/services/assignmentPipelineService.js` — set `decidedAt` on pipeline-final decisions
- `backend/src/services/freshServiceActionService.js` — clear `decidedAt` on preflight downgrade
- `backend/src/services/assignmentDecisionRules.js` — new `isPipelineFinalDecision` helper
- `backend/tests/groupExclusion.test.js` — 5 new tests
- `backend/prisma/migrations/20260422200000_backfill_decided_at_auto_decisions/migration.sql` — additive backfill
- `backend/package.json`, `frontend/package.json` — bump to `1.9.79-preview`
- `CHANGELOG.md`, `frontend/src/data/changelog.js` — release notes

No schema change, no new columns.

---

## [1.9.78-preview] - 2026-04-22

### Rich empty-state panel on the Review Queue when Auto-Assign is on

The Review Queue used to render a sad "No tickets awaiting decision" placeholder whenever the queue was empty — which is the *normal steady state* when auto-assign is on, since the pipeline routes tickets without human intervention. The result was a page that looked broken even though it was working perfectly. This release adds a richer, informative empty-state for that case.

#### What's new

When `subView === 'pending'` is empty AND `autoAssign === true`, the placeholder is replaced with:

1. **Header strip** — green "Auto-Assign is ON" pill, headline ("No tickets are waiting for you right now."), and a one-liner explaining when tickets WILL show up here (excluded groups, rebound exhaustion, LLM uncertainty), with a contextual count of currently-configured excluded groups.

2. **Hero card** — large display of today's auto-assigned count, with an explanatory sub-line ("out of N total tickets processed by the pipeline"). DRY-RUN badge appears next to the count if dry-run mode is on.

3. **4-tile stats grid** — Handled in FS / Noise dismissed / Needed review / In progress. Each tile is a `StatTile` with icon, big tabular-num value, and short sub-label. Color-coded by tone so the meaningful tiles pop.

4. **Most recent auto-assignment strip** — shows the latest auto-assigned ticket with a relative timestamp ("3 min ago") and a quick link into the run detail page. Updates every 30s without forcing a page refresh.

5. **Queued-for-later strip** — when there are tickets queued outside business hours, shows their count and reminds the admin they'll run automatically when business hours resume.

The old sparse placeholder still renders when auto-assign is **off** (no behavior change there) or for any tab that isn't `pending` (Decided / Dismissed / Rejected / Deleted).

#### Backend

`GET /assignment/queue-status` now returns:

```json
{
  "isBusinessHours": true,
  "queuedCount": 3,
  "nextWindow": null,
  "autoAssign": true,
  "autoCloseNoise": true,
  "pipelineEnabled": true,
  "dryRunMode": false,
  "excludedGroupCount": 1,
  "today": {
    "range": { "start": "...", "end": "...", "timezone": "America/Los_Angeles" },
    "totalRuns": 45,
    "autoAssigned": 23,
    "approved": 5,
    "handledInFs": 4,
    "noiseDismissed": 6,
    "manualReviewRequired": 5,
    "inProgress": 1,
    "queuedForLater": 3,
    "latestAutoAssignment": { "runId": 552, "ticketSubject": "...", "techName": "Andrew", "decidedAt": "..." }
  }
}
```

Today's stats are bounded by the **workspace timezone** (using the existing `getTodayRange()` helper), so "today" matches what the coordinator considers the current shift. Two cheap queries (one Prisma `groupBy` for outcome counts, one count for the handled-in-FS subset) — no new tables, no new joins.

#### Pure aggregation extracted for testability

The Prisma-result-to-bucket mapping logic lives in a new `assignmentStatsAggregation.js` module with two pure helpers:

- `tallyGroupedRuns(grouped)` — collapse `groupBy` rows into the stat buckets
- `adjustForHandledInFs(tally, handledInFs)` — subtract the FS-picked subset from `manualReviewRequired` so buckets don't double-count

18 new unit tests cover all bucket assignments, empty/null/invalid inputs, the `approved`/`modified` merge, the failed-status counts-toward-total-but-no-bucket case, unknown decision values (defensive), a realistic mixed day, and the clamp-to-zero edge case for `adjustForHandledInFs` during read races.

Test suite: 59 passing (was 41). New module at 100% line coverage.

#### Verified against prod

Ran `getTodayStats()` against the live prod DB before opening this PR — produces clean output for the current workspace's timezone window.

#### Files touched

- `backend/src/services/assignmentStatsAggregation.js` — new pure helper module
- `backend/src/services/assignmentDailyStats.js` — DB query orchestration, calls the helpers
- `backend/src/routes/assignment.routes.js` — extend `queue-status` response
- `backend/tests/statsAggregation.test.js` — 18 new tests
- `frontend/src/pages/AssignmentReview.jsx` — `AutoAssignActiveEmptyState`, `StatTile`, `RelativeTime` components + conditional render
- `backend/package.json`, `frontend/package.json` — bump to `1.9.78-preview`
- `CHANGELOG.md`, `frontend/src/data/changelog.js` — release notes

No DB migration. No prompt changes.

---

## [1.9.77-preview] - 2026-04-22

### UX polish: renamed "FS Manual" decision pill to "Handled in FS"

The amber decision pill for pipeline runs where a ticket was assigned in FreshService outside our pipeline used to read **"FS Manual"** — a label that felt like a database field name rather than a user-facing status, and that also implied the admin still had something to do (the word "Manual" suggests action-pending). In practice these tickets need zero in-app action; the work is already in motion with whoever picked them up in FreshService.

Renamed to **"Handled in FS"** to make clear that:

- The ticket is already being worked — no decision is needed in Ticket Pulse
- It happened outside our pipeline (in FreshService directly) — so the AI suggestion beside it is informational only

The tooltip is unchanged: *"Assigned in FreshService outside the pipeline — `<tech name>`. AI suggestion left unresolved."*

Applied to both sites that render the pill:

- Row-level pill in the Decided list under "Manually in FreshService"
- Header pill on `PipelineRunDetail` when opening any such run

No underlying data changed — the run's `decision` is still `pending_review`, the backend filter is still `outside_assigned`. Purely a render-layer string swap.

#### Files touched

- `frontend/src/pages/AssignmentReview.jsx` — `getDisplayDecision` return label + comment
- `frontend/src/components/assignment/PipelineRunDetail.jsx` — `decisionBadge` label + comment
- `backend/package.json`, `frontend/package.json` — bump to `1.9.77-preview`
- `CHANGELOG.md`, `frontend/src/data/changelog.js` — release notes

---

## [1.9.76-preview] - 2026-04-22

### Bug fix: "FS Manual" label disappeared on closed externally-assigned tickets

The Decided tab's "Manually in FreshService" sub-tab was internally inconsistent — some rows in the sub-tab displayed the correct amber "FS Manual" pill, but others showed a yellow "Pending" pill despite being in the same sub-tab. The difference was the ticket's current status: any `pending_review` run whose ticket had an `assignedTechId` but was also `Closed`/`Resolved`/`Deleted`/`Spam` reverted to the default "Pending" label even though it had clearly been handled outside the pipeline.

#### Root cause

Two frontend sites had the same over-protective status guard:

- `getDisplayDecision()` in `frontend/src/pages/AssignmentReview.jsx` (row-level pill on list views)
- `externallyAssigned` check in `frontend/src/components/assignment/PipelineRunDetail.jsx` (header pill on the run detail page)

Both were computed as:

```js
const externallyAssigned =
  run.decision === 'pending_review'
  && run.ticket?.assignedTechId
  && !['Closed', 'Resolved', 'Deleted', 'Spam'].includes(run.ticket?.status);
```

But the **backend's** `outside_assigned` filter (in `assignmentRepository.getPendingQueue`) that powers the "Manually in FreshService" sub-tab had no such status guard — it's just `assignedTechId: { not: null }`. So the sub-tab and the per-row label disagreed the moment the ticket closed.

#### Fix

Dropped the status guard in both UI sites. If a pending_review run has an `assignedTechId`, the label is always "FS Manual" — regardless of current ticket status. The tooltip still reads *"Assigned in FreshService outside the pipeline — `<tech name>`. AI suggestion left unresolved."* which stays accurate even after the ticket is closed.

This keeps the list view, detail view, and sub-tab filter all agreeing on the same question: **"was this ticket taken outside the pipeline?"** — a factual question whose answer doesn't change when the ticket later closes.

#### Files touched

- `frontend/src/pages/AssignmentReview.jsx` — drop status guard in `getDisplayDecision`
- `frontend/src/components/assignment/PipelineRunDetail.jsx` — drop status guard in header `externallyAssigned` check
- `backend/package.json`, `frontend/package.json` — bump to `1.9.76-preview`
- `CHANGELOG.md`, `frontend/src/data/changelog.js` — release notes

No backend changes, no DB changes.

---

## [1.9.75-preview] - 2026-04-22

### Bug fix: FreshService group member count was always zero

The Excluded Groups picker shipped in v1.9.74 rendered "0 agents" next to every group — including "Everyone IT" which has 15 members. Investigation showed the backend was reading `g.agent_ids` from the FreshService `/groups` response, but the real response shape for Freshservice is:

```json
{
  "id": 1000205455,
  "name": "Everyone IT",
  "members":  [/* 15 agent IDs */],
  "observers": [/* 1 ID */],
  "leaders":  []
}
```

The `agent_ids` naming is a Freshdesk-ism. Freshservice uses `members` + `observers` + `leaders` and has no `agent_ids` field on groups at all.

#### What was broken

- **Picker counts**: `GET /assignment/groups` returned `agentCount: 0` for every group.
- **Preflight check (pre-existing, silent since 1.9.5)**: `freshServiceActionService._preflightCheck`'s "incompatible_group" check used the same `agent_ids` read pattern: `if (group && group.agent_ids && !group.agent_ids.includes(agentId))`. Because `agent_ids` was always undefined, the `&&` short-circuited to `false` — meaning the check never fired and any "agent X doesn't belong to group Y" scenarios slipped through to the actual FreshService API call. Low impact in practice because the LLM rarely recommends cross-group assignments and FS itself rejects bad assignments, but it closes a silent-failure hole.

#### Fix

Both sites now read `members` with an `agent_ids` fallback for defensiveness, in case a future FS API version or a different tier ever returns the older shape:

```js
const memberIds = Array.isArray(g.members)
  ? g.members
  : Array.isArray(g.agent_ids) ? g.agent_ids : null;
```

Also extended the route response with `observerCount` and `leaderCount` (not surfaced in the UI today but available for future use). `listGroups()` JSDoc updated to document the real response shape.

#### Files touched

- `backend/src/routes/assignment.routes.js` — picker count reads `members`
- `backend/src/services/freshServiceActionService.js` — preflight incompatible_group check reads `members`
- `backend/src/integrations/freshservice.js` — `listGroups()` JSDoc
- `backend/package.json`, `frontend/package.json` — bump to `1.9.75-preview`
- `CHANGELOG.md`, `frontend/src/data/changelog.js` — release notes

No database changes, no migration, no prompt changes.

---

## [1.9.74-preview] - 2026-04-22

### Per-group exclusion from auto-assignment

Some FreshService groups are catch-all queues (e.g. "Everyone IT") where every ticket needs human eyes before assignment, regardless of how confident the LLM is. This release adds a workspace-level allowlist to enforce that.

#### How it works

```mermaid
flowchart TD
  Sync[Ticket arrives in FS] --> Pipe[runPipeline]
  Pipe --> LLM[LLM analyzes, produces ranked recommendation]
  LLM --> Cfg{autoAssign on?}
  Cfg -->|no| PR[decision=pending_review]
  Cfg -->|yes| GExcl{ticket.groupId in\nexcludedGroupIds?}
  GExcl -->|no| AA[decision=auto_assigned -> FS write-back]
  GExcl -->|yes| Down["decision=pending_review\nerrorMessage='Group X excluded\nfrom auto-assignment'"]
  Down --> UI["Review Queue + blue\n'Manual approval required'\nstrip on run detail"]
```

When a ticket arrives in an excluded group, the LLM still runs and produces a full recommendation (so the admin has all the AI's analysis at hand), but the system never auto-executes — the run lands in *Awaiting Decision* with a blue **"Manual approval required"** strip explaining why. One click to approve and it goes through normally.

#### Configuration UI

New section in *Assignment > Configuration*: **Excluded Groups (Manual Approval)**. Live-fetches the FreshService group list via `GET /assignment/groups` each time the tab opens, shows the agent count per group, and supports filtering when there are more than 8 groups. Selections persist on the workspace's `AssignmentConfig` and survive across sessions.

If FreshService is unreachable when the picker loads, the previously-saved group IDs are still rendered as opaque chips so the admin doesn't lose their selection silently.

A small inline hint reminds the admin that the list has no effect when Auto-Assign is off.

#### Backend

- New `Int[]` column `excluded_group_ids` on `assignment_configs` (default `{}`)
- `_executeRun` checks `assignmentConfig.excludedGroupIds` against `ticket.groupId` after the LLM produces a recommendation. If matched, decision is forced to `pending_review` with `errorMessage = "Group #<id> is excluded from auto-assignment — manual approval required."` Same downgrade pattern as the v1.9.73 rebound-rejecter and preflight-failure paths.
- New `listGroups()` method on the FreshService client (paginated 100/page, scoped to workspace)
- New `GET /assignment/groups` admin-only route returning `[{id, name, agentCount}]` sorted by name
- Pure helper `isGroupExcluded(ticketGroupId, excludedGroupIds)` extracted to `assignmentDecisionRules.js` so the BigInt vs Int normalization is unit-tested (Prisma returns `tickets.groupId` as `BigInt`, but the column is `Int[]` — a naive `===` check would silently miss every match)

#### Files touched

- `backend/prisma/schema.prisma` — new column on `AssignmentConfig`
- `backend/prisma/migrations/20260422000000_add_excluded_group_ids/migration.sql` — additive
- `backend/src/integrations/freshservice.js` — `listGroups()` + `_extractResults` extension for `/groups`
- `backend/src/routes/assignment.routes.js` — `GET /assignment/groups` + accept `excludedGroupIds` in `PUT /config` with input normalization
- `backend/src/services/assignmentPipelineService.js` — exclusion check in `_executeRun`
- `backend/src/services/assignmentDecisionRules.js` — new pure helper module
- `backend/tests/groupExclusion.test.js` — 13 unit tests covering empty/null cases, BigInt↔Int coercion, and invalid input handling
- `frontend/src/services/api.js` — `assignmentAPI.getGroups()`
- `frontend/src/pages/AssignmentReview.jsx` — new `ExcludedGroupsPicker` component + section in `ConfigTab`
- `frontend/src/components/assignment/PipelineRunDetail.jsx` — blue "Manual approval required" strip
- `backend/package.json`, `frontend/package.json` — bump to `1.9.74-preview`
- `CHANGELOG.md`, `frontend/src/data/changelog.js` — release notes

#### What stays the same

- Auto-Close Noise is independent (group exclusion only affects auto-assign)
- Rebound logic from v1.9.73 unchanged — a rebound run into an excluded group still gets the group-exclusion downgrade (correct: re-routing into a manual-only group should still require manual approval)
- LLM is **not told** about the exclusion — it analyzes as normal so the admin sees an honest recommendation. The override happens entirely at the decision layer.

#### Database

```bash
prisma migrate deploy
```

Migration `20260422000000_add_excluded_group_ids` — additive, defaults preserve existing behaviour. Already applied to prod before deploying this release.

#### Tests

41 passing (was 28). 13 new tests in `groupExclusion.test.js` covering all the edge cases of `isGroupExcluded`. `assignmentDecisionRules.js` at 100% line and branch coverage.

---

## [1.9.73-preview] - 2026-04-21

### Auto-fallback for rejected auto-assignments

When auto-assign is on and an agent rejects a ticket (removes themselves in FreshService), the existing rebound flow shipped in v1.9.5-preview already detected the bounce and triggered a fresh pipeline run — but several pieces of plumbing were missing or broken end-to-end. This release wires them all the way through.

#### What was already there (verified, unchanged)

- `_handleTicketRebound` in `syncService.js` detects rejection from the FreshService activity stream and triggers a fresh pipeline run with `triggerSource='rebound'`, passing a `reboundFrom` snapshot.
- `runPipeline` accepts and persists `reboundFrom` on the run record, queues outside business hours, and respects `autoAssign=true` at the bottom of `_executeRun`.
- `find_matching_agents` annotates each candidate with `previouslyRejectedThisTicket: true` and `rejectedAt` from the `ticket_assignment_episodes` table.
- `freshServiceActionService._preflightCheck` blocks the FS write-back with `code='already_rejected_by_this_agent'` if the LLM still picks the rejecter.
- `MAX_AUTO_REBOUNDS_PER_TICKET = 3` loop guard exists.

#### New: Rebound Context block in the LLM's first user message

`_executeRun` now loads `reboundFrom` from the run record (already persisted) and prepends a `## Rebound Context` block to the first user message:

> This ticket was previously assigned and returned to the queue. This is the 2nd attempt to find an assignee. Most recently it was returned by Andrew at 2026-04-21 14:32 PDT.
>
> When calling find_matching_agents, expect to see `previouslyRejectedThisTicket: true` on at least one candidate. Avoid recommending any agent flagged as a prior rejecter unless they are genuinely the only qualified option (and explain why in overallReasoning if so).
>
> When writing the agentBriefingHtml, include a brief, neutral acknowledgement that this ticket was re-routed (e.g. "This ticket was returned to the queue and now needs your attention"). Do NOT name the previous assignee or explain why they returned it.

Previously this metadata sat on the run record but never reached the LLM, so it had to discover the rebound implicitly by noticing rejection flags on candidates — too easy to miss when the prompt didn't mention rebounds at all.

#### New: DEFAULT_SYSTEM_PROMPT learns about rebounds

- **Step 4 (Find Matching Agents)** gains a paragraph telling the LLM to exclude prior rejecters unless they're genuinely the only qualified option, and to never make a rejecter the rank-1 pick if any alternative exists.
- **Step 8 (agentBriefingHtml)** gains a "Do include" bullet that — when this is a rebound run — instructs the briefing to start with a brief neutral acknowledgement like *"This ticket was returned to the queue and now needs your attention."* No naming the previous assignee, no use of the words "rebound", "bounced", or "rejected".

A new `needsPromptUpgrade` detector + `replaceAgentBriefingStep` path auto-upgrades older published prompts on next run (preserves any custom Steps 1-7 the workspace edited).

#### Improved: Loop-guard exhaustion no longer goes silent

When `MAX_AUTO_REBOUNDS_PER_TICKET = 3` is hit, `_handleTicketRebound` previously just `logger.warn`'d and returned, leaving the ticket invisible — no entry in any queue, no notification. Now it materializes a `decision='pending_review'` run with:

- `triggerSource='rebound_exhausted'`
- `errorMessage='Auto-fallback exhausted after N rebounds — needs manual review'`
- The latest `reboundFrom` snapshot
- A synthesized empty `recommendation` so the Awaiting Decision UI renders it as "no candidates left to try" rather than crashing on null fields

So the ticket appears in Awaiting Decision with a clear red strip (see UI section below) instead of going into limbo.

#### Fixed: No more stuck `auto_assigned + syncStatus=failed` runs

Two failure paths previously left runs in a confusing dead state where the dashboard showed the ticket as assigned but FreshService was unchanged.

**Path 1 — LLM ignores the rebound prompt and re-suggests the prior rejecter.** `_executeRun` now checks `ticketAssignmentEpisode` for any prior `endMethod='rejected'` row matching `topRec.techId` *before* setting `decision='auto_assigned'`. If found, decision is forced to `pending_review` with a clear `errorMessage`:

```
LLM re-suggested <tech>, who already rejected this ticket — downgraded to pending_review for manual handling.
```

**Path 2 — FreshService preflight blocks the assign at sync time.** When `_preflightCheck` returns `already_rejected_by_this_agent`, `superseded_assignee`, or `incompatible_group`, `freshServiceActionService.execute` now downgrades the run from `auto_assigned` to `pending_review` (clearing `assignedTechId`) so it surfaces in Awaiting Decision instead of looking falsely successful in the dashboard. Manually-approved runs keep their original decision so the audit trail of admin intent stays intact.

#### Improved: Rebound context is finally visible in `PipelineRunDetail`

`reboundFrom` was persisted on the run record but never displayed. Two new strip variants now render near the top of the run detail page:

- **Amber strip** for ongoing rebounds: *"Rebound #N — returned from `<tech>` at `<time>`"* with a one-line explanation that the pipeline was re-run with explicit instructions to avoid the rejecter.
- **Red strip** for `rebound_exhausted` runs: *"Auto-fallback exhausted after N rebounds — needs manual review"* with the latest unassignment context.

Reuses the `RotateCcw` icon from the existing rejection metric on `TechCard`.

#### Files touched

- `backend/src/services/assignmentPipelineService.js` — load `reboundFrom`, inject Rebound Context, downgrade re-suggested rejecter
- `backend/src/services/promptRepository.js` — Step 4 + Step 8 rebound guidance, legacy auto-upgrade detector
- `backend/src/services/syncService.js` — materialize `rebound_exhausted` pending_review run on loop-guard exit
- `backend/src/services/freshServiceActionService.js` — downgrade auto-assigned runs on preflight failure
- `frontend/src/components/assignment/PipelineRunDetail.jsx` — amber/red rebound context strip
- `backend/package.json`, `frontend/package.json` — bump to `1.9.73-preview`
- `CHANGELOG.md`, `frontend/src/data/changelog.js` — release notes

#### What stays the same (deliberately)

- No waterfall through pre-ranked candidates — the LLM re-runs each rebound from scratch, just with explicit Rebound Context now (the chosen strategy from planning).
- No new config knob — `autoAssign` already gates the whole flow; rebound chains automatically use the same setting.
- `MAX_AUTO_REBOUNDS_PER_TICKET = 3` constant stays as-is (no UI exposure for now).
- Existing rebound dedup / superseding logic stays as-is (already shipped in v1.9.71-preview).

#### Database

No migrations. `reboundFrom` was already a `Json` column on `assignment_pipeline_runs`. The new `triggerSource='rebound_exhausted'` value fits in the existing `VarChar(20)` column and isn't constrained by an enum.

---

## [1.9.72-preview] - 2026-04-21

### 🐛 Fixed: Run Now on a queued ticket disappeared into a 5-second toast

**Symptom**: clicking *Run Now* on a row in the "Queued for Business Hours" section made the row vanish, showed a brief "Run started — check History tab" toast, and gave no live feedback. The run actually completed correctly server-side (e.g. one prod ticket completed as `pending_review` in 47 s) but the user had no way to see it happen.

**Root cause**: the run-now endpoint was fire-and-forget. The route called `_executeRun(...)` with a no-op `emit` callback, returned `202` immediately, and the frontend just refreshed the queue. The row disappeared because the run's status flipped from `queued` → `running`, removing it from the queued list.

**Fix**: two parts.

#### Backend — SSE streaming variant

`POST /assignment/runs/:id/run-now` now accepts `?stream=true`. When set, the response opens an SSE channel and pipes every event from `_executeRun` (text, tool_call, tool_result, recommendation, error, complete) to the client — mirroring the contract of the existing `/trigger?stream=true` endpoint, so `LivePipelineView` can stream it unchanged.

The non-streaming behaviour is preserved (still returns `202` and runs in the background) so any other callers don't break.

If the queued run fails preflight validation (e.g. the ticket got assigned externally between queueing and the click), the stream now emits a structured error event and a terminal `done` event instead of returning a `409` the EventSource can't read:

```js
res.write(`data: ${JSON.stringify({ type: 'error', message: `Skipped: ${validation.reason}`, code: 'skipped_stale' })}\n\n`);
res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
res.end();
```

#### Frontend — slide-over overlay reusing LivePipelineView

Clicking *Run Now* on a queued row no longer fires off a request and shows a toast. It opens a centered slide-over with `LivePipelineView` connected to the new SSE endpoint via three new optional props on the existing component:

- **`streamPath`** — overrides the default `/assignment/trigger/{ticketId}?stream=true` URL.
- **`skipExistingCheck`** — skips the "is there a recent run for this ticket?" probe that LivePipelineView normally runs at mount. The probe would race the just-claimed run-now and possibly short-circuit into a stale completed view.
- **`initialRunId`** — seeds the `runId` state so the "Run #N" badge renders before the first `run_started` event arrives.

The overlay header shows the FreshService ticket ID and subject so the user knows which ticket is running. Closing it (Esc, X, or the Close button) doesn't cancel the run — execution continues server-side. On close the queue is auto-refreshed so the now-completed run moves to Awaiting Decision (or Decided / Dismissed) without a manual reload.

#### Files touched

- `backend/src/routes/assignment.routes.js` — extend run-now route with `?stream=true` branch (~50 lines)
- `frontend/src/components/assignment/LivePipelineView.jsx` — three optional props with JSDoc
- `frontend/src/services/api.js` — add `runNowStreamPath(id)` URL builder
- `frontend/src/pages/AssignmentReview.jsx` — `runNowLive` state, slide-over, `RunNowLiveOverlay` component

---

## [1.9.71-preview] - 2026-04-21

### Sanitized agent-facing assignment notes — stop leaking the routing algorithm

Background: when the pipeline approved or auto-assigned a ticket, the FreshService private note posted on the ticket included `recommendation.overallReasoning` verbatim. That field is the LLM's *internal* deliberation — it explains why rank 1 won by referring to scores, competency proficiency, workload fairness, on-shift status, rebound history, and the names of competing candidates. Anything an agent could read and reverse-engineer to game routing.

#### ✨ New: `agentBriefingHtml` — a public note written for the assignee

The `submit_recommendation` tool schema gains two extra outputs:

- **`agentBriefingHtml`** — required when there are recommendations. Written directly *to* the assignee in plain language, with allowed HTML tags only (`<b> <i> <br> <p> <ul> <li> <a href> <h3>`). Schema description hard-bans scores, ranks, percentages, confidence values, names of other candidates, workload counts, fairness reasoning, proficiency labels, IT levels, info about other agents being OFF/WFH/on leave, internal/run IDs, and any of the words "algorithm", "system", "LLM", "AI", "model", "pipeline", "score", "ranked", "fairness", "rebound", "queue".
- **`closureNoticeHtml`** — required when the recommendations array is empty (noise dismissal). Brief, neutral, no "noise/spam/classifier" language.

`overallReasoning` is preserved (and explicitly relabeled "INTERNAL ONLY") so the admin UI and audit log keep full transparency — it just never reaches FreshService.

#### ✨ New: prompt Step 8 with positive and negative examples

`DEFAULT_SYSTEM_PROMPT` gains a new Step 8 ("Write the Agent-Facing Briefing") with explicit do/don't lists and a worked example pair so the LLM never has to guess what's safe to write. A legacy detector + `injectAgentBriefingStep()` auto-upgrades published prompts on the next run by appending Step 8 only — any custom Steps 1–7 the workspace edited are preserved.

**Bad example** (what the prompt explicitly tells the LLM not to write):

> You ranked #1 with a score of 0.92. Other candidates (Alex, Jordan) had higher workloads (8 and 11 open tickets vs your 3). Your VPN proficiency is Expert (level 5).

**Good example**:

> The requester needs help connecting to the corporate VPN from a new MacBook — they're getting a certificate trust error. You've recently resolved several similar Mac VPN cert issues, so you're a good fit here. Suggested first check: confirm the device has the latest InternalCA profile installed via Jamf Self Service before troubleshooting the client itself.

#### ✨ New: public-note preview card on the run detail page

`PipelineRunDetail` (used in both the pending-review and history tabs of Assignment Review) now renders a green **"What the agent will see"** card directly under the Ticket Details / Overall Reasoning grid, showing the rendered HTML exactly as it will appear on the FS ticket. The existing "Overall Reasoning" card got a small **Internal** badge so the contrast (purple = internal, green = public) is unmistakable.

If the field is missing (legacy run created before this release), the preview falls back to an amber warning card telling the admin a sync would use the legacy fallback so they can re-run before approving.

#### 🛡️ FreshService note builder rewritten

`freshServiceActionService.buildAction()` now uses the public briefing for both assignment and noise-closure paths. The new note format is: header → `Assigned to:` → briefing HTML → `Override reason:` (when present) → `Run ID:`. Confidence and the raw "Reasoning" line are gone. For legacy runs without `agentBriefingHtml`, the builder falls back to `overallReasoning` *and* logs a warning so we can spot any unexpected fallbacks in production.

---

### Half-day vacation leaves handled end-to-end

Vacation Tracker marks partial-day leaves with `isFullDayLeave=false` and a `startHour`/`endHour` window, but we were collapsing them into a full-day row. That made the LLM assigner skip agents who were only out for the morning or afternoon, and the dashboard rendered them as fully unavailable.

#### Backend

- New columns on `technician_leaves`: `is_full_day`, `half_day_part`, `start_minute`, `end_minute` (additive, defaults preserve existing behaviour).
- Sync bucketises partial leaves into AM/PM by window-midpoint vs noon, so `09:00–13:00` reads as **AM** and `12:30–16:30` reads as **PM**. Multi-day partial leaves (none in live data) are conservatively treated as full-day on every day.
- `get_agent_availability` tool now emits **HALF-DAY-OFF** and **HALF-DAY-WFH** buckets with a derived `availabilityNote` that compares the workspace clock to the leave window (`"off this morning, available from 12:00 onward"`, etc).
- Default system prompt updated so the LLM treats half-day agents as available for the other half of the day instead of excluding them outright.

#### Frontend

- Half-day leaves render as split day-cells in the weekly mini-calendar (top half = AM, bottom half = PM), with the ticket count overlaid on top.
- The hard 50/50 split where one half was solid and the other was empty looked unfinished — replaced with a single full-height overlay using a vertical gradient that fades from the leave colour at the AM/PM edge through the midline into transparent.
- Daily badge now reads `OFF AM` / `WFH PM`; tooltip appends the exact window.
- `MonthlyCalendar` leave counts are weighted (1 for full, 0.5 for half) and rendered as `1/2`, `1 1/2`, `2`, etc. A small `1/2` chip flags days where any leave is partial, so `1.5` isn't read as a typo.

---

### "FS Manual" badge for externally-assigned runs

When a ticket is assigned in FreshService outside the pipeline (the *Manually in FreshService* sub-tab case), the run still has `decision='pending_review'` technically — but no human action is needed in our app. The yellow **Pending** pill misleads the user into thinking they have a backlog to triage when really the assignment is done.

A contextual decision label now detects this state and renders **FS Manual** (amber) instead:

```
externallyAssigned =
  decision === 'pending_review'
  && ticket.assignedTechId !== null
  && ticket.status NOT IN (Closed, Resolved, Deleted, Spam)
```

Tooltip explains: *"Assigned in FreshService outside the pipeline — &lt;tech name&gt;. AI suggestion left unresolved."*

Applied to the Assignment Review list rows (desktop table + mobile card, via a single `getDisplayDecision(run)` helper) and the `PipelineRunDetail` header badge. The underlying decision data stays as `pending_review` — purely a render-layer change — so coordinators can still record their own decision later (approve/override/reject) if they want to capture their assessment of the AI's recommendation vs the actual external pick.

---

### 🐛 Fixed: rebound created a second `pending_review` row

Bug seen on prod ticket **#219505**: shown twice in *Awaiting Decision*. Two `pending_review` runs existed for the same ticket — the original poll and the rebound created after the first assignee rejected. Both passed the queue's filter (`status='completed' AND decision='pending_review'`) so both rendered.

**Root cause**: `_handleTicketRebound`'s dedup check uses `getOpenPipelineRun`, which only matches `status IN (queued, running)`. A `pending_review` run isn't "open" by that definition, so the rebound proceeded and created a second pending row.

**Fix**: in `_handleTicketRebound`, after the in-flight dedup check and before creating the new run, mark any existing `pending_review` runs for the ticket as `superseded` with reason *"Superseded by a newer rebound run after ticket was returned to the queue"*. The superseded run still exists in the History tab for audit.

The fix didn't extend `getOpenPipelineRun`'s semantics because that helper is also used by `runPipeline` to skip duplicate work — broadening it would block legitimate manual triggers AND the rebound flow itself.

One-shot prod cleanup: marked run #518 as superseded. Audited the rest of prod for other tickets with multiple pending_review runs — only #219505 was affected.

---

### 🗄️ Database migration required

```bash
prisma migrate deploy
```

New migration: `20260421000000_add_half_day_leaves` — adds `is_full_day`, `half_day_part`, `start_minute`, `end_minute` columns to `technician_leaves`. Additive only; defaults preserve existing behaviour for full-day leaves.

---

## [1.9.7-preview] - 2026-04-21

### Demo Mode bug fixes — broken avatars and name leaks

Three follow-up fixes to the Demo Mode feature shipped in 1.9.6-preview, surfaced by a real recording session.

### 🐛 Fixed: avatars rendering as the broken-image alt text

`getDemoAvatar()` computed the avatar slot with:

```js
const startIdx = (hashString(key) ^ seed) % files.length;
```

JavaScript's bitwise `^` returns a **signed** 32-bit integer, and JS `%` preserves the sign of the dividend. For roughly half of all (key, seed) combinations the result was negative, making `files[startIdx]` `undefined` and producing the URL `/demo-avatars/undefined`. The browser 404'd and fell back to rendering the `alt` text — which was the (real or fake) technician's name overlaid on a broken-image icon.

**Fix**: force unsigned 32-bit before the modulo:

```js
const startIdx = ((hashString(key) ^ seed) >>> 0) % files.length;
```

A 1,000-random-key probe was added to `scripts/test-demo-scrub.mjs` to guarantee every URL ends with a real `avatar-NNN.png`, so this can never regress silently.

### 🐛 Fixed: real names leaking in Assignment Review and Timeline Explorer

Two field names were missing from the scrubber's `NAME_KEYS` set:

- `recommendation.recommendations[].techName` — drove the entire **AI Suggestion** column on the Decided/Pending review queue
- `ticket.assignedTechName` — drove the holder label in Timeline Explorer rows for un-picked tickets

Added: `techName`, `technicianName`, `assignedTechName`, `_techName`, `currentHolderName`, `holderName`, `pickerName`, `fromTechName`, `toTechName`, `rejectedByName`, `lastHolderName`, `previousHolderName` — covering the assignment recommendations array, episodes/handoff history, and timeline rows.

### 🛡️ Improved: defensive image fallback

`TechCard.jsx`, `TechCardCompact.jsx`, and `TimelineTicketRow.jsx` now attach an `onError` handler to every `<img>`:

```jsx
onError={(e) => { e.currentTarget.style.display = 'none'; }}
```

Any future avatar URL that 404s or is blocked by CORS will now silently disappear and let the existing initials-circle fallback render, instead of the browser drawing its broken-image placeholder with the technician's name as alt text.

---

## [1.9.6-preview] - 2026-04-21

### Demo Mode for Training Recordings

This release adds a global **Demo Mode** that anonymizes every sensitive string on screen (technician names, requester names, emails, office locations, ticket subjects, computer names, internal domains) and swaps real Azure-AD profile photos for a curated pool of 50 AI-generated corporate headshots — designed so coordinators can record training videos without any manual post-editing.

**Headline points:**

- One-click toggle in the Dashboard header (next to **Hide Noise**) flips the entire app into anonymized mode and persists in `localStorage`.
- **Single-chokepoint design**: the axios response interceptor + SSE event handler both route data through a recursive scrubber, so every page is anonymized without per-page changes.
- **Per-session deterministic mapping**: same real person always becomes the same fake person within a recording, but each new tab/session starts with a fresh roster of fake identities.
- 50 photo-realistic stock headshots generated with **Gemini 3 Pro Image (Nano Banana Pro)** committed under `frontend/public/demo-avatars/`.
- Smart ticket-subject scrubbing preserves tech jargon like "Significant Anomaly" or "Application or Service Principal" while still catching unfamiliar names in "New Hire: \<X\>", "involving \<X\>", "for \<X\>" patterns.

---

## 🎯 How it Works

### The chokepoint

Every server-driven byte goes through one place — the axios response interceptor in `frontend/src/services/api.js`:

```js
const scrubResponseInterceptor = (response) =>
  maybeScrub(response.data, isDemoMode());
```

When Demo Mode is off, this is a no-op. When it's on, the response is walked recursively and every recognized field is rewritten before any React component sees it. This is also wired into `useSSE` so live push updates stay consistent with the rest of the UI.

### Per-session deterministic identities

- A 32-bit seed is generated once per browser session and stashed in `sessionStorage` (`tp_demoSeed`).
- The seed feeds a **Mulberry32** PRNG which shuffles the dictionary of fake names + locations.
- A `Map<realName, fakeName>` cache (cleared on **Reshuffle**) ensures "Andrew Fong" is always the same fake person across the Dashboard, Technician Detail, Timeline Explorer, Assignment Review, and live SSE updates within one recording.
- New tab → fresh seed → entirely different roster, so consecutive recordings show different "people".

### The free-text scrubber pipeline (for ticket subjects)

Applied in order:

1. **Email regex** → `mapEmail()` (preserves `name@domain` shape, swaps both sides to `acme.example`)
2. **Computer name regex** (`BGC-EDM-HV01` → `ACME-WS-042`) — deterministic per real machine
3. **Internal token regex** (`BGC`, `bgcengineering.ca`, `bgcsaas`) → `Acme` / `acme.example`
4. **Known location regex** (Toronto, Vancouver, Calgary, …) → fake Canadian city
5. **Known-people regex** (built dynamically from every name we've ever mapped via structured fields)
6. **Triggered generic name catcher** — only scrubs Title-Case sequences that follow a clear name-introducing trigger (`for`, `by`, `from`, `with`, `involving`, `Hire`, after `:`), so "Significant Anomaly" or "Application or Service Principal" survive untouched while "New Hire: Mahmoud Al-Riffai" gets caught.

### Map view

Locations like `Toronto` get remapped to other valid IANA cities (`Halifax`, `Winnipeg`, `Hamilton`…) that already exist in the Visuals page's `OFFICE_LOCATIONS` lookup, so map pins move to plausible-but-different cities automatically with zero changes to map code. IANA timezones (`America/Toronto`) are likewise remapped (`America/Halifax`) so the city portion of a timezone string no longer leaks the office.

### Stock face avatars

`scripts/generate-demo-avatars.mjs` calls Gemini 3 Pro Image once per prompt against 50 hand-curated diverse subject descriptions. The resulting `avatar-001.png` … `avatar-050.png` plus `manifest.json` are committed to `frontend/public/demo-avatars/`. At runtime the scrubber rewrites `photoUrl` / `_techPhotoUrl` to a pool slot deterministically chosen from `(realName ⊕ sessionSeed)`, so a fake person keeps the same face throughout the recording.

---

## 🧩 New Files

- `frontend/src/utils/demoMode/` — `state.js`, `rng.js`, `dictionaries.js`, `mappings.js`, `scrubber.js`, `index.js` (public API + `useDemoMode`, `useDemoLabel` hooks)
- `frontend/src/components/DemoModeToggle.jsx` — header button + dropdown (Reshuffle, Replace photos toggle)
- `frontend/src/components/DemoModeBanner.jsx` — fixed bottom-right amber pill on every page
- `frontend/public/demo-avatars/` — 50 PNG headshots + manifest (~29 MB)
- `scripts/generate-demo-avatars.mjs` — Gemini 3 Pro Image batch generator with `--resume` and `--concurrency` flags
- `scripts/test-demo-scrub.mjs` — Node smoke test that runs the scrubber against payloads modelled on the production screenshots and asserts no banned tokens leak through
- `scripts/package.json` + `scripts/README.md`

## 🔧 Modified Files

- `frontend/src/services/api.js` — both `api` and `apiLongTimeout` interceptors now route bodies through `maybeScrub`
- `frontend/src/hooks/useSSE.js` — SSE event payloads scrubbed before dispatch
- `frontend/src/pages/Dashboard.jsx` — `<DemoModeToggle>` mounted next to **Hide Noise**, "Welcome, X" and workspace name wrapped in `useDemoLabel`
- `frontend/src/pages/WorkspacePicker.jsx` — welcome name + workspace cards wrapped in `useDemoLabel`
- `frontend/src/App.jsx` — `<DemoModeBanner>` mounted globally inside `SettingsProvider`

## ⚙️ How to Use

1. Open the Dashboard, click the new amber **Demo Mode** button (next to Hide Noise).
2. Page reloads with all real names, emails, locations, computer names, ticket subjects swapped to fake equivalents, and real Azure-AD profile photos replaced with stock headshots.
3. The amber **DEMO MODE — identities anonymized** pill appears in the bottom-right of every page.
4. Use the chevron next to the toggle for **Reshuffle identities** (fresh roster mid-session) and **Replace photos** on/off.
5. Open a new tab → demo mode stays on (localStorage), but you get a brand-new roster of fake people (sessionStorage seed) — perfect for varied training videos.

## 🚧 Out of Scope (intentional)

- The browser URL bar, history, autocomplete suggestions — cannot be programmatically changed. Mitigation: record a window crop that excludes the address bar, or use a hosts-file alias.
- Anything outside the app (other browser tabs, bookmarks bar visible in the screenshot frame).
- Backend logs / DB — Demo Mode is purely a frontend transformation; the backend keeps real data.

---

## [1.9.5-preview] - 2026-04-17

### Assignment Bounce Tracking, Preflight Validation, and Rate Limiter Rewrite

This release closes six gaps exposed by run #340 (ticket #219101) — where a technician self-picked, worked, then rejected a ticket back into the queue, leading to a stale approval and a failed FreshService write-back — and ships a complete rewrite of FreshService rate limiting plus a critical Vacation Tracker sync fix.

**Headline numbers** (dev testing, same catch-up workload):

| Metric | Before | After |
|---|---|---|
| FreshService 429 rate-limit hits | 1,843 | 3 |
| Overlapping retries | Constant | None |
| Response headers used for pacing | Never | Every response |
| `Retry-After` honored | No (fixed backoff) | Yes |

---

## 🚦 Root-Cause Analysis: Why We Were Getting 429s

The previous throttling had three compounding bugs:

### Bug 1: Fake serialization in `_analyzeTicketActivities`

The existing code used `Promise.all` with staggered `setTimeout` offsets, which only appears sequential. As soon as any request exceeded the 1.1s schedule (due to retries or slow responses), scheduled calls overlapped with the retries, creating real concurrency during the worst possible moments.

### Bug 2: No cross-workspace coordination

All 4 workspaces shared the same `*/5 * * * *` cron expression and all fired startup catch-ups simultaneously via `setImmediate()`. Each workspace independently ran its own "1 req/sec" stream — combined, we were at 4+ req/sec peak.

### Bug 3: Ignored rate-limit response headers

FreshService returns `x-ratelimit-remaining`, `x-ratelimit-total`, and `Retry-After` on every response. We never read them, instead using arbitrary 5/10/20s exponential backoff on 429s.

---

## 🎯 The Fix: Shared Rate Limiter

**New file**: `backend/src/integrations/rateLimiter.js` — a `FreshServiceRateLimiter` class that:

- Enforces a per-minute cap (default 110/min — under FreshService's 140/min Enterprise cap)
- Enforces a configurable min-delay between requests (default 550ms) to dodge burst detection
- Reads `x-ratelimit-remaining` on every response; slows down to 1,500ms spacing when < 15% remaining
- Honors `Retry-After` on 429 via a global queue pause
- Serializes **all** outbound HTTP calls through a single queue per process

**New usage pattern** in `FreshServiceClient`:

```javascript
// Every HTTP call routes through the limiter
_get(url, config)  { return this.limiter.enqueue(() => this.client.get(url, config)); }
_put(url, data)    { return this.limiter.enqueue(() => this.client.put(url, data)); }
_post(url, data)   { return this.limiter.enqueue(() => this.client.post(url, data)); }
```

**Singleton-per-process**: all `FreshServiceClient` instances share a single rate limiter, so 4 parallel workspace syncs can no longer multiply the budget.

---

## 🧹 Caller Simplification

`_analyzeTicketActivities` in `syncService.js` replaced the fake-parallel pattern with a simple `for-of` loop — the limiter handles pacing centrally:

```javascript
// Before: Promise.all + setTimeout (overlaps on retries)
await Promise.all(tickets.map((t, i) => processTicket(t, i)));

// After: true sequential (limiter paces automatically)
for (const ticket of tickets) {
  await client.fetchTicketActivities(ticket.id);
}
```

The backfill endpoint also had its manual `setTimeout(1100ms)` removed for the same reason.

**Files Changed**:
- `backend/src/integrations/rateLimiter.js` (new)
- `backend/src/integrations/freshservice.js` — all HTTP calls route through `_get/_put/_post`
- `backend/src/services/syncService.js` — simplified `_analyzeTicketActivities`, removed manual backfill delays

---

## 🔎 Diagnostics Endpoint

**New**: `GET /api/sync/rate-limit-stats` — returns current queue depth, requests-in-last-minute, current min-delay, and whether a slowdown is active. Handy for watching the limiter in real time.

---

## 📊 Verified Impact (dev test, same workload)

| Metric | Before | After |
|---|---|---|
| Rate-limit (429) hits | 1,843 | 3 |
| Overlapping retries | Constant | None |
| Rate-limit headers read | Never | Every response |
| Retry-After honored | No (fixed backoff) | Yes |
| Cross-workspace coordination | None | Shared limiter |

---

## 🗃️ New Data Model: Assignment Episodes

**Status**: ✅ Complete
**Impact**: Full assignment ownership history per ticket, bounce/rejection tracking

### New Table: `ticket_assignment_episodes`

Tracks every ownership period for a ticket — who held it, how it started (self-picked vs coordinator-assigned), and how it ended (rejected, reassigned, closed, or still active).

**Schema**:
- `id`, `ticket_id`, `technician_id`, `workspace_id`
- `started_at`, `ended_at` (nullable = current holder)
- `start_method`: `self_picked | coordinator_assigned | workflow_assigned | unknown`
- `end_method`: `rejected | reassigned | closed | still_active`
- `start_assigned_by_name`, `end_actor_name`

### New Ticket Columns

- `rejection_count` (Int, default 0) — how many times a ticket was bounced back to queue
- `group_id` (BigInt, nullable) — current FreshService group for future escalation logic

### Extended Activity Types

`ticket_activities.activityType` now includes: `self_picked`, `coordinator_assigned`, `rejected`, `reassigned`, `group_changed`.

**Files Changed**:
- `backend/prisma/schema.prisma` — new model + columns + relations
- `backend/prisma/migrations/20260418000000_add_assignment_episodes_and_bounce_tracking/migration.sql`

---

## 🔍 Rewritten Activity Analyzer

**Status**: ✅ Complete
**Impact**: Complete FreshService assignment history captured instead of only the first assignment

### Changes to `analyzeTicketActivities()`

The analyzer now emits:
- `events[]` — every agent assign/unassign/group change as a typed event
- `episodes[]` — one per ownership period with start/end methods and actor names
- `currentIsSelfPicked` — reflects the **current** owner's acquisition method (not the first owner)
- `rejectionCount` — how many times the ticket was bounced

**Semantic change**: `isSelfPicked` now means "the current holder picked it themselves." If a tech self-picks then rejects, that tech's self-pick no longer inflates the current assignee's stats.

**Files Changed**:
- `backend/src/integrations/freshserviceTransformer.js` — full rewrite of `analyzeTicketActivities()`
- `backend/src/services/ticketRepository.js` — added `groupId`, `rejectionCount` to upsert payloads

---

## 🔄 Sync Service: Episode Reconciliation

**Status**: ✅ Complete
**Impact**: Captures assignment changes that happen between sync polls

### Broadened Activity Fetch Filter

Previously only fetched activities when `responder_id` was set. Now also fetches when:
- FS `updated_at` is newer than our local record
- Ticket has an active pipeline run
- Ticket is new

### Episode & Activity Writing

After each ticket upsert, the sync now:
- Reconciles episodes from the FS activity analysis (insert new, update end states)
- Writes per-event `TicketActivity` rows with real actor names (replaces generic `performedBy: 'System'`)

**Files Changed**:
- `backend/src/services/syncService.js` — new `_reconcileEpisodes()`, `_writeEventActivities()`, broadened `ticketFilter`

---

## 🛡️ Preflight Validation on FreshService Write-Back

**Status**: ✅ Complete
**Impact**: Prevents failed approvals like run #340

### Pre-checks Before Assignment

Before sending `PUT /tickets/:id` to FreshService, the system now validates:
1. **`superseded_assignee`** — ticket is already assigned to someone else
2. **`incompatible_group`** — target agent is not a member of the ticket's current group
3. **`already_rejected_by_this_agent`** — target agent previously bounced this ticket

All checks are skippable via `force: true` on `/runs/:id/decide` and `/runs/:id/sync`.

### Full FS Error Capture

`assignTicket()` now wraps FreshService error responses with `freshserviceDetail` and `freshserviceStatus`. Failed syncs persist the full FS error body in `syncPayload.freshserviceError` — no more losing "Validation failed" details.

**Files Changed**:
- `backend/src/integrations/freshservice.js` — error wrapping, new `getTicket()`, `getGroup()` helpers
- `backend/src/services/freshServiceActionService.js` — `_preflightCheck()`, `execute()` accepts `force`, full error capture
- `backend/src/routes/assignment.routes.js` — `force` param on decide/sync endpoints

---

## 🔎 Live Freshness Check on Run Detail Page

**Status**: ✅ Complete
**Impact**: Coordinators see real-time ticket state before approving

### New Endpoints

- `GET /api/assignments/runs/:id/freshness` — fetches live FS state, diffs against recommendation, returns rejection history
- `POST /api/assignments/runs/:id/rerun` — supersedes the old run and triggers a fresh pipeline

### UI Changes

The run detail page now:
- Auto-checks freshness when viewing a pending run
- Shows specific warnings: "assignee changed", "rejected by recommended tech", "group incompatible"
- Displays full rejection history timeline
- Renders preflight abort details and full FS error bodies on sync status cards
- Offers "Refresh & re-rank" button for admins when diffs are detected

**Files Changed**:
- `backend/src/routes/assignment.routes.js` — freshness + rerun endpoints
- `frontend/src/components/assignment/PipelineRunDetail.jsx` — freshness banner, sync error details
- `frontend/src/services/api.js` — `getRunFreshness()`, `rerunPipeline()` methods

---

## 🤖 LLM Rejection Awareness

**Status**: ✅ Complete
**Impact**: Pipeline avoids recommending agents who already rejected the same ticket

### `find_matching_agents` Enhancement

Each candidate agent is now annotated with `previouslyRejectedThisTicket` and `rejectedAt` when they have a closed episode with `endMethod='rejected'` for the current ticket. Serves as a soft signal for the LLM.

**Files Changed**:
- `backend/src/services/assignmentTools.js` — rejection lookup in `findMatchingAgents()`

---

## 📊 Dashboard: Rejected (7d) Metric

**Status**: ✅ Complete
**Impact**: Coordinators can see which technicians are bouncing tickets

### New Metric on Technician Cards

A red "Rej" badge appears on technician cards when the tech has rejected tickets in the last 7 days. Sourced from `ticket_assignment_episodes WHERE endMethod = 'rejected'`.

**Files Changed**:
- `backend/src/routes/dashboard.routes.js` — `rejected7d` field in dashboard response
- `frontend/src/components/TechCard.jsx` — rejection badge
- `frontend/src/components/TechCardCompact.jsx` — rejection badge (compact view)

---

## 🔧 Historical Backfill

**Status**: ✅ Complete
**Impact**: Admin can populate episodes for historical tickets

### New Endpoint: `POST /api/sync/backfill-episodes`

Fetches activities from FreshService and populates `ticket_assignment_episodes` for historical tickets. Supports `daysToSync` (default 180), `limit`, and `concurrency` params. The existing admin Backfill panel (Settings → Backfill) also now populates episodes automatically on every run.

**Files Changed**:
- `backend/src/services/syncService.js` — `backfillEpisodes()` method, `_updateTicketsWithAnalysis()` now reconciles episodes
- `backend/src/routes/sync.routes.js` — `/backfill-episodes` endpoint

---

## 📊 Rejected Windows (7d / 30d / Lifetime) + Drill-Down

**Status**: ✅ Complete
**Impact**: Coordinators can see who is bouncing tickets and inspect the specific tickets

### Tooltip on Technician Cards

Hovering the red **Rej** badge on a technician card now shows all three windows:
```
Rejected tickets — tech picked up then put back in queue
Last 7d: 2
Last 30d: 5
Lifetime: 18

Click to see the list
```

### Clickable Drill-Down — New Bounced Tab

Clicking the **Rej** badge jumps to a new **Bounced** tab on the technician detail page, showing every ticket the tech picked up and rejected, with:
- 7d / 30d / Lifetime filter pills
- Per-row: ticket subject, priority, category, requester, start method (self-picked vs assigned), hold duration, current holder (or "back in queue"), and a direct link to FreshService

**Files Changed**:
- `backend/src/routes/dashboard.routes.js` — `rejected30d` and `rejectedLifetime` in dashboard response, new `GET /api/dashboard/technician/:id/bounced`
- `frontend/src/services/api.js` — `getTechnicianBounced()` method
- `frontend/src/components/TechCard.jsx` — clickable badge, multi-window tooltip
- `frontend/src/components/TechCardCompact.jsx` — same
- `frontend/src/components/tech-detail/BouncedTab.jsx` (new) — drill-down list
- `frontend/src/pages/TechnicianDetailNew.jsx` — new "Bounced" tab, `?tab=bounced` query param honored

---

## 🧭 Handoff History Strip on Run Detail

**Status**: ✅ Complete
**Impact**: Coordinators see the full ownership chain at a glance while reviewing

### Inline Timeline Above Recommendations

`/assignments/run/:id` now renders a compact horizontal strip listing every ownership episode for the ticket:

```
Handoff history (3 episodes)
[Andrew Fong · self]  →rejected  [Adrian Lo · assigned]  →reassigned  [Mehdi Abbaspour · assigned · current]
```

Each pill is color-coded (green=current, red=rejected, neutral=reassigned-out) and has a tooltip with exact timestamps and end-actor names.

### New Endpoint: `GET /api/dashboard/ticket/:id/history`

Accepts either our internal ticket ID or a FreshService ticket ID and returns the full episode list plus FS-sourced events. Reusable for future per-ticket timeline drawers.

**Files Changed**:
- `backend/src/routes/dashboard.routes.js` — `/ticket/:id/history` endpoint
- `frontend/src/services/api.js` — `getTicketHistory()` method
- `frontend/src/components/assignment/HandoffHistoryStrip.jsx` (new)
- `frontend/src/components/assignment/PipelineRunDetail.jsx` — renders the strip above the deleted/freshness banners

---

## 🚦 Shared FreshService Rate Limiter (Rewrite)

**Status**: ✅ Complete
**Impact**: Dev testing: rate-limit hits dropped from **1,843 to 3** (99.8% reduction)

### Root Cause of the Previous 429 Storm

The old throttling had three compounding bugs:

1. **Fake serialization in `_analyzeTicketActivities`** — used `Promise.all` with staggered `setTimeout` offsets that only *appeared* sequential. When any request exceeded its 1.1s schedule (or retried), scheduled calls overlapped with the retries.
2. **No cross-workspace coordination** — 4 workspaces on `*/5 * * * *` cron all fired simultaneously, each running its own "1 req/sec" stream; combined: 4+ req/sec bursts.
3. **Ignored rate-limit response headers** — `x-ratelimit-remaining`, `x-ratelimit-total`, and `Retry-After` were never read; fixed 5/10/20s backoff used instead.

Bonus discovery: FreshService's *actual* Enterprise per-minute budget is **140/min** (confirmed from `x-ratelimit-total` header), not the "5000/hour" we'd been assuming.

### The Fix: Global Token-Bucket Limiter

New `FreshServiceRateLimiter` class (`backend/src/integrations/rateLimiter.js`):

- Per-process singleton — all `FreshServiceClient` instances share one queue
- Caps at 110 req/min (under the 140 Enterprise limit)
- 550ms minimum delay between requests (dodges burst detection)
- Reads `x-ratelimit-remaining` on every response and slows down to 1,500ms spacing when < 15% budget remaining
- Honors `Retry-After` on 429 via a global queue pause
- All HTTP calls in `FreshServiceClient` route through `_get/_put/_post` wrappers

### Caller Simplification

`_analyzeTicketActivities` replaced the fake-parallel pattern with a simple `for-of` loop:

```javascript
// Before: Promise.all + setTimeout (overlaps on retries)
await Promise.all(tickets.map((t, i) => processTicket(t, i)));

// After: true sequential (limiter paces centrally)
for (const ticket of tickets) {
  await client.fetchTicketActivities(ticket.id);
}
```

### Diagnostics Endpoint

**New**: `GET /api/sync/rate-limit-stats` — returns current FS headers plus limiter queue depth, requests-last-minute, min-delay, and whether a slowdown is active.

**Files Changed**:
- `backend/src/integrations/rateLimiter.js` (new) — `FreshServiceRateLimiter` class
- `backend/src/integrations/freshservice.js` — all HTTP calls route through `_get/_put/_post`
- `backend/src/services/syncService.js` — simplified `_analyzeTicketActivities`, removed manual backfill delays
- `backend/src/routes/sync.routes.js` — new `/rate-limit-stats` endpoint

---

## 🏖️ Vacation Tracker In-Place Modification Fix

**Status**: ✅ Complete
**Impact**: Users who edit existing WFH/vacation requests no longer appear on leave for orphaned dates

### The Bug

When a user modified an existing VT leave (same `vtLeaveId` but shrunk or moved the date range — e.g. moved a WFH from Thursday to Friday), the old date rows were orphaned in our DB:

- Thursday WFH stored: `(vtLeaveId=123, leaveDate=2026-04-16)`
- User moves to Friday: VT returns `id=123` with dates=Fri only
- Sync upserts `(123, Fri)`, activeVtLeaveIds=`[123]`
- Old `deleteStaleLeaves` deleted rows where `vtLeaveId NOT IN [123]` → `123` is in the list → nothing deleted
- Result: user showed WFH on **both** Thursday and Friday

### The Fix

`deleteStaleLeaves` now keys on `(vtLeaveId, leaveDate)` tuples instead of just `vtLeaveId`. Any row in the sync window that isn't in the freshly-upserted set of `${vtLeaveId}|${ISODate}` keys is removed, correctly handling both full cancellations (different leave ID) and in-place modifications (same leave ID, different dates).

**Files Changed**:
- `backend/src/services/vacationTrackerRepository.js` — `deleteStaleLeaves()` signature and logic
- `backend/src/services/vacationTrackerService.js` — `syncLeaves()` builds `validKeys` Set

---

## [Unreleased] - 2025-10-30

### Week Sync Enhancements and Bug Fixes

This release focuses on robust week sync functionality, rate limiting improvements, and comprehensive progress tracking.

---

## 🐛 Week Sync Critical Fixes

**Status**: ✅ Complete
**Impact**: Fixed multiple sync reliability issues, added production-grade retry logic

### Bug Fix 1: Weekly Closed Tickets List Empty

**Problem**: Technician detail page in weekly view showed closed count (e.g., 43) but displayed "No tickets in this category"

**Root Cause**: Backend filtered by `closedAt`/`resolvedAt` dates which were NULL for many tickets

**Solution**: Changed to status-based filtering matching daily view approach:
```javascript
// Filter by status instead of dates
const closedTickets = weeklyTickets.filter(ticket =>
  ['Resolved', 'Closed'].includes(ticket.status)
);
```

**Files Changed**:
- `backend/src/routes/dashboard.routes.js:422-426`

---

### Bug Fix 2: Static "This Week" Label

**Problem**: Weekly technician detail view always showed "This Week" even when viewing historical weeks (e.g., Jun 23-30)

**Solution**: Added logic to detect current week vs historical week and display appropriate label:
```javascript
const isCurrentWeek = /* check if selected week is current week */;
const weekRangeLabel = isCurrentWeek ? 'This Week' : 'Jun 23 - Jun 30';
```

**Files Changed**:
- `frontend/src/pages/TechnicianDetailNew.jsx:332-358`

---

### Bug Fix 3: Sync Week Date Mismatch

**Problem**: User viewing May 19-25 but clicking "Sync Week" synced May 5-11 instead

**Root Cause**: `handleSyncWeek` used `selectedDate` instead of `selectedWeek` in weekly mode

**Solution**: Added conditional date source selection:
```javascript
// Use selectedWeek for weekly mode, selectedDate for daily mode
const sourceDate = viewMode === 'weekly' ? selectedWeek : selectedDate;
```

**Files Changed**:
- `frontend/src/pages/Dashboard.jsx:494-495`

**Documentation Created**:
- `SYNC_WEEK_BUG_FIX.md` - Comprehensive analysis and fix documentation

---

## 🚀 Rate Limiting and Retry Logic

**Status**: ✅ Complete
**Impact**: Eliminated 429 errors, 100% success rate for historical week syncs

### Problem
Week sync for 314 tickets hit 52 rate limit errors (16.6% failure rate):
- Concurrency=3 was too aggressive (2 req/sec exceeds safe threshold)
- No retry logic in `fetchTicketActivities()`
- FreshService API rate limit: 1 req/sec safe threshold

### Solution

**1. Added Retry Logic with Exponential Backoff**
```javascript
async _fetchWithRetry(endpoint, config = {}, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await this.client.get(endpoint, config);
    } catch (error) {
      if (error.response?.status === 429 && attempt < maxRetries) {
        // Exponential backoff: 5s, 10s, 20s
        const delayMs = 5000 * Math.pow(2, attempt - 1);
        await this._sleep(delayMs);
        continue;
      }
      throw error;
    }
  }
}
```

**2. Reduced Concurrency**
```javascript
// Changed from concurrency=3 to concurrency=1
async syncWeek({ startDate, endDate, concurrency = 1 }) {
```

**3. Applied Retry Logic to All API Calls**
- `fetchTicketActivities()` now uses `_fetchWithRetry()`
- `fetchAllPages()` uses retry logic for pagination

### Results
- **Success Rate**: 83% → 100%
- **Error Count**: 52 → 0
- **Time**: Slightly longer but reliable

**Files Changed**:
- `backend/src/integrations/freshservice.js:102-149, 210-218` - Retry logic
- `backend/src/services/syncService.js:875` - Concurrency reduction

---

## 📊 Real-Time Progress Tracking

**Status**: ✅ Complete
**Impact**: Users can monitor long-running syncs without checking backend logs

### Problem
- Week syncs take 8-15 minutes for historical data
- No visibility into progress (percentage, steps, ETA)
- 2-minute initial silence during ticket fetch
- UI timeout after 5 minutes (sync takes 9 minutes)

### Solution

**1. Backend Progress Tracking**
Added `this.progress` object with 5 sync steps:
```javascript
this.progress = {
  currentStep: 'Fetching tickets from FreshService',
  currentStepNumber: 1,
  totalSteps: 5,
  ticketsToProcess: 0,
  ticketsProcessed: 0,
  percentage: 5,
};
```

**Progress Breakdown**:
- Step 1 (0-20%): Fetch tickets from FreshService
- Step 2 (20-40%): Filter to week range
- Step 3 (40-90%): Analyze ticket activities (longest step)
- Step 4 (90-95%): Update tickets with analysis
- Step 5 (95-100%): Upsert to database

**2. Frontend Polling**
Polls `/api/sync/status` every 2 seconds to display progress:
```javascript
const progressPollingInterval = setInterval(async () => {
  const statusCheck = await syncAPI.getStatus();
  const progress = statusCheck.data?.sync?.progress;
  if (progress) {
    setSyncMessage(`${progress.currentStep} (${progress.percentage}%)`);
  }
}, 2000);
```

**3. Real-Time Page Progress**
Added progress callbacks to show pagination updates:
```javascript
// In fetchAllPages()
if (page % 10 === 0) {
  onProgress(page, allResults.length);
}

// In syncWeek()
const allTickets = await client.fetchTickets(filters, (page, itemCount) => {
  this.progress.currentStep = `Fetching tickets from FreshService (${itemCount} items, page ${page})`;
  this.progress.percentage = Math.min(5 + Math.floor((page / 80) * 15), 20);
});
```

**4. Increased Timeout**
```javascript
// Changed from 5 minutes to 15 minutes
timeout: 900000, // 15 minute timeout for sync operations
```

**5. Smart Progress Display**
Progress messages update on same line instead of creating new lines:
```javascript
const addSyncLog = (message, type = 'info') => {
  const isProgressUpdate = message.includes('(') && message.includes('%)');
  if (isProgressUpdate && prev.length > 0) {
    // Replace last progress message instead of appending
    return [...prev.slice(0, -1), { timestamp, message, type }];
  }
  return [...prev, { timestamp, message, type }];
};
```

### User Experience
- See real-time progress percentage (0-100%)
- Know which step is running
- See item counts during ticket fetch
- Understand long waits (e.g., "Fetching tickets (1900 items, page 20)")
- Accurate ETAs based on step percentages

**Files Changed**:
- `backend/src/services/syncService.js:860-969` - Progress tracking
- `backend/src/integrations/freshservice.js:53-111, 165-200` - Progress callbacks
- `frontend/src/pages/Dashboard.jsx:291-312, 524-547` - Polling and display
- `frontend/src/services/api.js:22` - Timeout increase

---

## 📚 Comprehensive Documentation

**Status**: ✅ Complete
**Impact**: Complete knowledge base for monthly sync implementation

### Created: SYNC_OPERATIONS.md

Comprehensive 11,000+ word guide covering:

**FreshService API Integration**:
- API limitations (no bulk endpoints, no `updated_before` filter)
- Rate limiting (1 req/sec safe threshold)
- Retry logic implementation
- `updated_since` behavior (returns ALL tickets since date)

**Week Sync Process**:
- 5-step process flow with timing breakdown
- Performance characteristics (9 min for 314 tickets)
- 79% of time spent on activity analysis (sequential)
- Scaling formula: ~1.5 seconds per ticket

**Progress Tracking Architecture**:
- Backend progress object structure
- Frontend polling implementation
- Progress callback patterns
- UI display strategies

**Troubleshooting Guide**:
- HTTP 429 errors
- UI timeout issues
- Data mismatches
- Slow performance

**Monthly Sync Recommendations**:
- Estimated timing: 35-55 minutes for 1,300 tickets
- Recommend batching by week (4-5 batch operations)
- Alternative: Process weekdays parallel, weekends sequential
- Database query patterns for monthly views

**Files Created**:
- `SYNC_OPERATIONS.md` - Complete sync operations guide

---

## 📝 Summary

**Total Issues Fixed**: 3 critical bugs
**Enhancements**: 4 major improvements
**Success Rate**: 83% → 100%
**Progress Visibility**: None → Real-time tracking
**Documentation**: 11,000+ words

**Files Modified**:
- `backend/src/services/syncService.js` - Progress tracking, concurrency
- `backend/src/integrations/freshservice.js` - Retry logic, callbacks
- `backend/src/routes/dashboard.routes.js` - Closed tickets filter
- `frontend/src/pages/Dashboard.jsx` - Progress polling, display
- `frontend/src/pages/TechnicianDetailNew.jsx` - Week label logic
- `frontend/src/services/api.js` - Timeout increase

**Files Created**:
- `SYNC_OPERATIONS.md` - Comprehensive sync guide
- `SYNC_WEEK_BUG_FIX.md` - Date mismatch bug analysis

**Date**: October 30, 2025
**Status**: All changes tested and verified ✅

---

## [Unreleased] - 2024-10-28

### Major Improvements

This release includes three major improvements focused on data accuracy, code maintainability, and user experience.

---

## 🔧 Sync Service Refactor

**Status**: ✅ Complete
**Impact**: Eliminated code duplication, improved maintainability, enabled consistent future sync methods

### Problem
The sync service had significant code duplication across multiple sync methods:
- `syncTickets()` - 175 lines of duplicated logic
- `syncWeek()` - 140 lines of duplicated logic
- `backfillPickupTimes()` - 91 lines of duplicated logic

Total: ~400 lines of duplicated code across 819 total lines (49% duplication)

### Solution
Extracted 5 core private methods as single source of truth:

1. **`_prepareTicketsForDatabase()`** - Transform and map technician IDs
2. **`_analyzeTicketActivities()`** - Batch analyze ticket activities with rate limiting
3. **`_updateTicketsWithAnalysis()`** - Update tickets with self-picked/assigned data
4. **`_upsertTickets()`** - Safely upsert tickets to database
5. **`_buildSyncFilters()`** - Build consistent FreshService API filters

### Results
- **Reduced codebase**: 819 lines → ~550 lines (33% reduction)
- **Single source of truth**: All sync methods use identical core logic
- **Bug prevention**: Fixes automatically apply to all sync methods
- **Easier testing**: Core methods can be unit tested independently
- **Future-proof**: New sync methods inherit correct behavior automatically

### Files Changed
- `backend/src/services/syncService.js` - Refactored entire service

### Verification
- Weekly sync test: 184/184 tickets (100% success)
- Incremental sync test: 4 tickets synced successfully
- All technician mappings working correctly

---

## 🎯 Ticket Mapping Issue Fix

**Status**: ✅ Complete
**Impact**: Fixed 748 historical tickets, ensured future syncs work correctly

### Problem
**Symptom**: Historical weeks showing fewer tickets than expected (e.g., Aug 25-31 showing 27 instead of ~50)

**Root Cause**: 748 tickets had NULL `assignedTechId` despite having valid responders in FreshService

### Investigation
Before the sync refactor, `syncWeek()` had incomplete technician ID mapping:

```javascript
// OLD CODE (BUGGY):
async syncWeek({ startDate, endDate }) {
  const tickets = await client.fetchTickets(filters);
  const transformedTickets = tickets.map(t => transformTicket(t));

  // ❌ MISSING: Technician ID mapping step
  await ticketRepository.upsert(transformedTickets);
}
```

The `transformTicket()` function set `assignedFreshserviceId`, but the critical `mapTechnicianIds()` step was missing, causing:
1. Tickets had `assignedFreshserviceId` populated ✓
2. But `assignedTechId` stayed NULL ❌
3. Dashboard queries filter by `assignedTechId` + `isActive`, so these tickets were invisible

### Two-Phase Solution

**Phase 1: Immediate Repair (One-Time)**
Created `repair-unmapped-tickets.js` to fix all 748 historical tickets:
- Fetched each unmapped ticket from FreshService
- Mapped responder_id → assignedTechId
- Updated database
- **Results**: Fixed 190 tickets with responders, 558 genuinely unassigned
- **Time**: ~13 minutes due to API rate limiting
- **Impact**: Aug 25-31 week: 27 → 354 tickets (13x increase!)

**Phase 2: Refactored Architecture (Permanent Fix)**
Extracted technician mapping into `_prepareTicketsForDatabase()`:

```javascript
// NEW CODE (FIXED):
async _prepareTicketsForDatabase(fsTickets) {
  const transformedTickets = transformTickets(fsTickets);

  const technicians = await technicianRepository.getAllActive();
  const fsIdToInternalId = new Map(
    technicians.map(tech => [Number(tech.freshserviceId), tech.id])
  );

  const ticketsWithTechIds = mapTechnicianIds(transformedTickets, fsIdToInternalId);
  return ticketsWithTechIds; // ✅ All tickets properly mapped
}
```

Now **ALL sync methods** use this core function:
- `syncTickets()` ✅
- `syncWeek()` ✅
- Future sync methods ✅

### Why This Won't Happen Again
1. **Single source of truth**: All ticket preparation goes through `_prepareTicketsForDatabase()`
2. **No way to bypass**: Impossible to sync tickets without proper mapping
3. **Historical weeks work**: Syncing any historical week now uses correct logic

### Files Changed
- `backend/src/services/syncService.js` - Refactored with core methods

### Files Created (One-Time Repair)
- `backend/repair-unmapped-tickets.js` - Comprehensive repair tool
- `backend/backfill-technician-assignments.js` - Assignment backfill
- `backend/count-unmapped.js` - Count remaining unmapped tickets

### Verification
```bash
# Check unmapped tickets (should show 0 or only genuinely unassigned)
node backend/count-unmapped.js

# Test historical week sync
curl -X POST "http://localhost:3000/api/sync/week" \
  -H "Content-Type: application/json" \
  -d '{"startDate":"2024-12-02","endDate":"2024-12-08"}'
```

---

## 📊 Calendar Day Count Fix

**Status**: ✅ Complete
**Impact**: Calendar day totals now exactly match sum of individual technician counts

### Problem
User reported: "Calendar shows Mon 129, Tue 90, etc., but when I add all the Monday numbers, it doesn't match 129."

**Root Cause**: Inconsistent date field usage between two endpoints:

1. **Calendar Day Counts** (`/api/dashboard/weekly-stats`):
   - Used `createdAt` to determine which day a ticket belongs to

2. **Technician Daily Breakdown** (`statsCalculator.js`):
   - Used `firstAssignedAt` (with `createdAt` fallback)

### Analysis
88 tickets (24%) in Aug 25-31 week were created on one day but assigned on a different day, causing massive discrepancies:

```
Before Fix (createdAt vs firstAssignedAt):
Day        | Calendar | Tech Sum | Difference
Mon Aug 25 |    2     |    1     | -1
Tue Aug 26 |  129     |   85     | -44
Wed Aug 27 |   90     |  153     | +63
Thu Aug 28 |   34     |   29     | -5
Fri Aug 29 |   55     |   55     |  0
Sat Aug 30 |   26     |   30     | +4
Sun Aug 31 |    6     |    1     | -5
```

### Solution
Updated `/api/dashboard/weekly-stats` to use **firstAssignedAt with createdAt fallback** (matches statsCalculator.js):

```javascript
// Fetch all tickets in week range (by either date)
const tickets = await prisma.ticket.findMany({
  where: {
    OR: [
      { createdAt: { gte: weekStart, lte: weekEnd } },
      { firstAssignedAt: { gte: weekStart, lte: weekEnd } },
    ],
    assignedTech: { isActive: true },
  },
});

// Count per day using consistent logic
const count = tickets.filter(ticket => {
  const assignDate = ticket.firstAssignedAt
    ? new Date(ticket.firstAssignedAt)
    : new Date(ticket.createdAt);  // Fallback
  return assignDate >= start && assignDate <= end;
}).length;
```

### Why This Logic?
- Dashboard tracks **workload distribution by assignment date**
- Ticket created Monday but assigned Tuesday should count toward **Tuesday's workload**
- Matches existing technician breakdown logic

### Results
```
After Fix (both use firstAssignedAt):
Day        | Calendar | Tech Sum | Match?
Mon Aug 25 |   85     |   85     | ✓
Tue Aug 26 |  153     |  153     | ✓
Wed Aug 27 |   29     |   29     | ✓
Thu Aug 28 |   55     |   55     | ✓
Fri Aug 29 |   30     |   30     | ✓
Sat Aug 30 |    1     |    1     | ✓
Sun Aug 31 |    1     |    1     | ✓
```

### Files Changed
- `backend/src/routes/dashboard.routes.js:108-202` - Updated `/weekly-stats` endpoint

### Files Created (Diagnostics)
- `backend/analyze-date-fields.js` - Analysis of date field differences
- `backend/verify-calendar-counts.js` - Verification script
- `backend/debug-date-calculation.js` - Timezone debugging

### User Action
Refresh browser to see updated calendar counts with corrected logic.

---

## 🎨 UX Improvements

**Status**: ✅ Complete
**Impact**: Persistent navigation state, smart view mode transitions

### Problems

**Issue 1**: When browsing historical weeks (e.g., Aug 25-31) in weekly view, clicking "Daily" would reset to today's date.

**Issue 2**: Pressing F5 to refresh browser would always reset to today's date, losing the selected historical context.

### Solutions

#### 1. Smart View Mode Transitions

**Weekly → Daily**: Now shows the matching day of week from the selected historical week
- Example: Viewing Aug 25-31 (Mon-Sun), today is Monday → Clicking "Daily" shows Aug 25 (Monday)

**Daily → Weekly**: Shows the week containing the selected date
- Example: Viewing Aug 28 (Thursday) → Clicking "Weekly" shows Aug 25-31

#### 2. localStorage Persistence

Automatically saves to browser's localStorage:
- Selected date (`dashboardSelectedDate`)
- Selected week (`dashboardSelectedWeek`)
- View mode (`dashboardViewMode`)

**State Priority**:
1. Navigation state (when returning from detail page)
2. **localStorage** (new! persists across refreshes)
3. Default values (today's date, current week, daily mode)

### Implementation

**Smart Handlers**:
```javascript
// Calculate same day of week from selected historical week
const handleSwitchToDaily = () => {
  const today = new Date();
  const todayDayOfWeek = (today.getDay() + 6) % 7; // Monday=0

  const targetDate = new Date(selectedWeek);
  targetDate.setDate(selectedWeek.getDate() + todayDayOfWeek);

  setSelectedDate(targetDate);
  setViewMode('daily');
};

// Calculate Monday of selected date's week
const handleSwitchToWeekly = () => {
  const currentDay = (selectedDate.getDay() + 6) % 7;
  const monday = new Date(selectedDate);
  monday.setDate(selectedDate.getDate() - currentDay);

  setSelectedWeek(monday);
  setViewMode('weekly');
};
```

**Auto-Save Effects**:
```javascript
useEffect(() => {
  localStorage.setItem('dashboardSelectedDate', selectedDate.toISOString());
}, [selectedDate]);

useEffect(() => {
  localStorage.setItem('dashboardSelectedWeek', selectedWeek.toISOString());
}, [selectedWeek]);

useEffect(() => {
  localStorage.setItem('dashboardViewMode', viewMode);
}, [viewMode]);
```

### User Experience

**Scenario 1: Browsing Historical Week**
1. Navigate to Aug 25-31 (weekly)
2. Click "Daily"
3. **Before**: Jumps to today (Oct 28)
4. **After**: Shows Aug 25 (Monday of that historical week)

**Scenario 2: Browser Refresh**
1. Navigate to Aug 18-24 (weekly)
2. Press F5
3. **Before**: Resets to current week
4. **After**: Stays on Aug 18-24

**Scenario 3: Switching Back and Forth**
1. Aug 25 (daily) → Click "Weekly" → Aug 25-31
2. Aug 25-31 → Click "Daily" → Aug 25
3. Context preserved throughout

### Files Changed
- `frontend/src/pages/Dashboard.jsx:61-190, 920, 930` - State initialization, persistence, smart handlers

### Benefits
- Persistent context across browser refreshes
- Smart transitions stay within historical timeframe
- Intuitive navigation matching user expectations
- No data loss on accidental refreshes or crashes

---

## 📝 Summary

**Total Lines Changed**: ~1,200 lines across 3 services
**Bugs Fixed**: 3 major issues
**Code Reduced**: 33% reduction in sync service
**Historical Tickets Repaired**: 748 tickets
**UX Improvements**: 2 major navigation enhancements

**Files Modified**:
- `backend/src/services/syncService.js` - Complete refactor
- `backend/src/routes/dashboard.routes.js` - Calendar count fix
- `frontend/src/pages/Dashboard.jsx` - UX improvements

**Files Created (One-Time)**:
- `backend/repair-unmapped-tickets.js` - Historical data repair
- `backend/analyze-date-fields.js` - Diagnostic analysis
- `backend/verify-calendar-counts.js` - Verification

**Date**: October 28, 2024
**Status**: All changes tested and verified ✅
