# MEGA 09-23: QA package + Parked + today's releases

_Source: `qa/09-23 Package/Features Request - 09-23.docx` (Susan Xu, QA). Workspaces: IT (1), Project Accounting
(5). Built 23 Sep 2026 evening as one release, together with Parked (`plans/PARKED_BUILD_PLAN.md`) and the
rotation fix. The response PDF also covers everything shipped today (3.9.69–3.9.72)._

Legend: ☐ to do · ☑ done · **fix** defect · **build** feature · **explain** not a bug · **your call** Vahid decides

## Executive summary

| # | QA said | Verdict | Root cause (production) |
|---|---|---|---|
| 1 | "Request Type" empty in the PA "Ticket arrived" mail; want category; the workflow fires before the AI categorizes | **fix + build** | Workflow 11369 uses `customFields.source_request_type`, which only the Power Apps API sets. TP-1638 came by mail, so `customFields=null`. The mail went at +1 s; the AI set the category at +49 s. |
| 2 | Requester Tickets tab shows 0; wrong empty text; show all by default; blue bar overflows the tab | **fix** | `RequesterDetail.jsx` sends `status:'any'`; the server searches for a status literally called "any" (Nelly: 16 tickets, 0 found). The bar lacks `overflow-hidden`. |
| 3 | Verified-solution badge too small; make a real icon with the image model | **build** | `SolutionMark` is a 16 px circle with a 12 px icon. |
| 4 | PA wants Open + Pending by default; make default statuses per workspace | **build** | Since 3.9.67 the default is "every status", with no setting. |
| 5 | Signature doesn't belong under "Mail & alerts" | **fix** | The `/mail-alerts` page stacks Notifications, Alerts and Signature. Move Signature to Profile. |
| 6 | Gaby (admin) can't edit her internal notes | **fix** | Her notes written in FreshService sync as `private_note`; FE and BE only allow editing `note`. Everyone is affected (1,536 such notes in IT in 30 days). |
| 7 | Cambio profiles inconsistent (800 vs 367) | **fix** | 800 was never looked up in Entra. Lookup only runs on ticket activity; no ticket since March. Not a domain issue: 29 of 75 Cambio profiles (and 1,093 overall) have never been looked up. |
| 8 | Order of multiple workflows; "do not process more workflows" option | **build** | Order and exclusivity exist only within one trigger. TP-1526: one resubmission sent 3 emails (reopened + 2 × fields_updated; the two are a coalesce race). |
| P | Parked tickets (full build) | **build** | `plans/PARKED_BUILD_PLAN.md` |
| R | TP-1597 stayed Resolved after FS closed it | **fix** | The recently-closed reconcile took a fixed top 10 of 23; it now rotates. |

## 1. PA "Ticket arrived": category, and waiting for the AI
- ☐ Config fix now: workflow 11369, published HTML. Replace the Request Type row with
  `Category {{ ticket.internalCategory.name }}` (fallback "Being triaged"). Fix the text part's
  `{{ ticket.freshserviceTicketId }}` → `{{ ticket.displayRef }}`. Publish as a new version through the repository
  (script, dry run first).
- ☐ Build **`ticket.categorized`** trigger. Emitted when the AI pipeline (or a person) sets the category, with
  `extra { first, from, to, fit, by }`, next to the agent-alert hook in `assignmentPipelineService`. Registered in
  `NOTIFICATION_EVENT_TYPES` and the editor.
- Options for QA (your call): (a) keep the acknowledgement on create and send the category mail on
  `ticket.categorized`; (b) move 11369 to `ticket.categorized`; (c) a 2-min delay node before the mail.

## 2. Requester page
- ☐ Drop `status:'any'` (both calls); fix the test. Empty text: "No open tickets…" only when filtered to open;
  "No tickets from this person in this workspace yet" otherwise.
- ☐ Add `overflow-hidden` on the active tab (blue bar).

## 3. Verified-solution icon
- ☐ Generate `brand/actions/verified-solution.png` (+@2x) with gpt-image-2 (flat matte, transparent).
- ☐ `SolutionMark` uses `BrandArt`, 20 px in the queue and 24 px in the header; keep the tooltip and aria label.

## 4. Default statuses per workspace
- ☐ `app_settings` `ticket_default_statuses_ws<N>` via a small service; returned in ticket meta; admin PUT.
- ☐ Ticket Ops → "Default statuses" section. `Tickets.jsx` + `TicketFilterRail.jsx` read `meta.defaultStatuses`.
  "Clear filters" sets `status=any` when a default exists.
- ☐ Set ws5 = Open + Pending (after deploy).

## 5. Signature → Profile
- ☐ `SignaturePanel` on `ProfilePage`; remove it from the Notifications page; menu texts updated.

## 6. Edit notes written in FreshService
- ☐ FE `canEditEntry` accepts `private_note` (not system).
- ☐ BE `updateNote` accepts `private_note`. The author check also matches `actorFreshserviceId` against the acting
  technician's `freshserviceId`. A FreshService 403 on a foreign note → "edit it in FreshService" message.

## 7. Requester profiles from Entra
- ☐ The requester page refreshes a never-synced or stale (> 7 d) profile, capped at 3 s.
- ☐ Backfill script over never-attempted requesters (dry run, throttled); run after deploy.

## 8. Workflow order and "stop further workflows"
- ☐ Fix the `fields_updated` coalesce race (two runs 49 ms apart) with a transaction-scoped advisory lock on
  (workflow, ticket).
- ☐ Per-workflow **"Stop other workflows for this ticket change"** (`stop_further_workflows` column), plus one
  order across triggers per workspace (`routingPriority`, lowest first). When a flagged workflow sends for a ticket,
  lower-priority workflows for the same ticket within the change window (default 2 min) are skipped at send
  time and at resume. The skip is recorded as a suppression with a reason.
- ☐ Editor: checkbox + order position shown. Docs: limits (first to send wins; `fields_updated` waits its
  coalesce window).

## P. Parked
See `plans/PARKED_BUILD_PLAN.md`. Status-change detection is a sweep safety net plus direct hooks in the UI
paths.

## Execution order
Parked backend → 2, 5, 6 (small) → 4 → 7 → 1 → 8 → 3 (image) → Parked frontend → tests → release (additive
migrations applied before merge) → post-deploy scripts (11369 HTML, ws5 default statuses, Entra backfill) → PDF
(QA items + Parked + today's releases 3.9.69–3.9.72 + rotation) → e-mail → watch.
