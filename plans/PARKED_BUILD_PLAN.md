# Parked tickets: full build plan (tonight's QA nightly build)

_23 Sep 2026. Built **in one go** together with the 09-23 QA package (Vahid). Product source:
`ticket-pulse-design/plans/PARKED_TICKETS_PLAN.md` (Part B). This file adds Vahid's decisions of 23 Sep and
the code-level corrections from the review. Part A (Pending Response ↔ FreshService 6, latest change wins)
already shipped in 3.9.72; see `plans/PENDING_RESPONSE_STATUS_SYNC.md`._

## 0. Decisions (locked)

| # | Decision | Source |
|---|---|---|
| D1 | Parked is a **marker, not a status**. In Ticket Pulse the ticket reads **Parked** everywhere a status shows; FreshService sees plain **Pending (3)**. | Vahid 23 Sep ("pending in FS, parked in our system") |
| D2 | Three kinds: **Waiting until a date**, **Waiting on someone** (anyone but the requester, with a chase-on date), **In progress with an ETA**. | plan |
| D3 | "Waiting on the **requester**" is not a park: the dialog sets **Pending Response** (FS 6), and FreshService's reminders take over. | plan + 3.9.72 |
| D4 | Parking always sets the ticket to **Pending**, so no live SLA-pause state is needed. Pending already sits outside every SLA path. On wake, a TP-born ticket's **dueBy moves out by the parked time**. FS-born due dates are FreshService's and are not touched. | review + Vahid answer 1 |
| D5 | Max **6 months** out. **Standard role or higher** (readonly is already blocked by `blockReadonlyWrites`). | Vahid |
| D6 | A park always carries a **one-line reason**. | plan |
| D7 | **Unpark** on: a requester reply; a status change by a person; a status change adopted from FreshService (latest change wins). Never on the park/wake's own change or a sync echo. | plan + review |
| D8 | **HR notices:** strict date parser only. Auto-park only when the date is unambiguous, in the future and within 6 months; otherwise show a suggestion. Backfill the open ones once. | plan |
| D9 | Agent follow-up-email reply-to-notes: **dropped**. The follow-up skill and briefs just **exclude parked** tickets. | Vahid 23 Sep |
| D10 | One release with the QA items. Parked gets its own section in the response PDF. Pending Response (3.9.72) also gets a section. | Vahid 23 Sep |

**Open for Vahid (ask with the plan tonight; build the default meanwhile):**
- Q1: **How is the assignee told a ticket woke?**
  - Default: an in-app toast + Activity entry, a line in their daily brief, and a **My Alerts** option "My parked tickets wake" that is **on by default** for the assignee (email). This is agent-facing; requesters get nothing.
- Q2: **HR auto-park on arrival.** Default: **on in IT** for unambiguous dates, with the Activity note carrying an undo link.

## 1. Data model (additive migration `2026092400xxxx_ticket_parks`)

```
ticket_parks
  id serial PK, ticket_id int FK→tickets ON DELETE CASCADE, workspace_id int
  kind varchar(20)            -- until_date | waiting_on | eta
  until timestamptz           -- wake / chase-on / ETA date
  reason text NOT NULL
  waiting_on jsonb NULL       -- [{ technicianId? , email?, name }]
  source varchar(20)          -- agent | suggested_hr | api | workflow | bulk
  parked_by varchar(255), parked_at timestamptz default now()
  status_before varchar(50)   -- restored sensibly on wake (Open when it was Open-base)
  ended_at timestamptz NULL, end_reason varchar(30) NULL  -- woke | unparked | requester_replied | status_changed | closed | extended
  ended_by varchar(255) NULL
  index (ticket_id, ended_at), index (workspace_id, until) where ended_at is null
tickets
  parked_until timestamptz NULL, park_kind varchar(20) NULL  -- denormalised, current park only
  index (workspace_id, parked_until) where parked_until is not null   -- CREATE INDEX CONCURRENTLY out of band
agent_alert_subscriptions
  on_parked_wake boolean default false, on_park_due_soon boolean default false
```
At most one active park per ticket, enforced in the service inside a transaction. Re-park ends the previous one
with `end_reason='extended'`. History is kept, and "re-parked 3+ times" comes from it.

## 2. Backend

### 2.1 `ticketParkService.js` (new): the only writer
- `park(ticketId, ws, { kind, until, reason, waitingOn, source }, actor)`: validates kind, date (future, ≤ 6 months), reason and waitingOn (not the requester; if it is, return `{ redirect: 'pending_response' }`). It sets status Pending through the normal path:
  - TP-born: `changeStatus(..., { parkChange: true })`
  - FS-born: `updateFsTicket` status Pending → FS 3
  Then it writes the park row and the denormalised columns, adds Activity `ticket_parked`, emits `ticket.parked`, broadcasts SSE, and dispatches the webhook.
- `extend(ticketId, ws, { until, reason }, actor)`, `unpark(ticketId, ws, { reason:'unparked'|… }, actor)`.
- `wake(park)`: status → Open (or `status_before` when that was Open-base). For TP-born, shift `dueBy` by the parked duration. Adds Activity `ticket_woke`, emits `ticket.woke`, and runs the assignee notification (Q1).
- `suggestFromHrNotice(ticket)`: see 2.6.
- The status changes it makes carry `parkChange: true`, so the unpark hook (2.3) ignores them.

### 2.2 Wake sweep
- Copy `scheduledTicketService.activateDue`: `setInterval` 60 s, a `_running` guard, batches of 20, and an atomic `updateMany` claim (`ended_at` set where null and until ≤ now).
- It must **not** filter on `nativeTicketingEnabled`, because FS-born parks exist.
- Also emits `ticket.park_due_soon` (N hours before, deduped per park) for the time trigger and alerts.
- Started from `app.js` beside the scheduled-ticket worker.

### 2.3 Unpark hooks
Status changes have no single funnel today, so the hook goes on each path:
- `ticketService.changeStatus`: unpark when the ticket is parked and `!parkChange`. This covers people, the API, bulk, and latest-change-wins adoption (`fromFreshService`).
- `ticketService.updateFsTicket`: same rule for FS-born. Since 3.9.76 (#441, API Dev) this also covers public-API status changes on FS-born tickets: `fsBornStatusService.js` calls `updateFsTicket(id, ws, { status }, apiActor)` with actor role `'api'`. Only ContinuIT has `oauth_clients.fs_status_write`.
- **FS sync status change on FS-born tickets** (`syncService` single-ticket reconcile and the batch upsert):
  - a FreshService status change away from Pending unparks;
  - an echo of our own Pending doesn't (compare with the park's `parkedAt`, plus the existing 10-minute write-back hold).
- **Workflow `update_ticket`** (`notificationWorkflowEngine.js` ~3850, which writes the DB directly): add an explicit unpark call there.
- **Requester reply:** a side effect in `ticketLifecycleNotificationService` on `ticket.reply_received`, beside `maybeRefreshSentiment`. It covers mailbox ingest, mirror pull-back and FS sync. Caveat: the FS-sync reply event fires only for entries under 24 h old, so a late sync won't unpark; acceptable.
- Closing/resolving always ends the park (`end_reason='closed'`).

### 2.4 Guards that must exist before the first park
- `ticket.requester_silent_for` and every pending-response template exclude parked tickets. Add the condition in `ticketReplyClockService.requesterSilentCandidates` (`parked_until is null`).
- The AI assignment pipeline and after-hours sweeps skip parked tickets.
- Noise auto-close skips parked tickets.

### 2.5 Everywhere it counts: queries
- `ticketService.buildListWhere`:
  - new segment `parked`;
  - `open`, `awaiting`, `mine`, `overdue`, `due_today` and the "Open" scopes **exclude** parked;
  - new filter `parked=any|until_date|waiting_on|eta|none|waking7`.
- `getQueueStats`: `parked` count and `parkedWakingWeek`.
- `_listFacets` (only `source` today): add a `parked` facet with the same "drop your own dimension" groupBy.
- `statsCalculator` `openLike` and `getLoadLevel`: exclude parked from load; return `parkedCount` per tech. Callers in `dashboard.routes.js` pass it through.
- `analyticsService`:
  - the pending split gains a **Parked** band;
  - overdue/stale metrics exclude parked;
  - Automation Ops gains parks created / woke / extended / **re-parked 3+** (coaching signal, never a leaderboard).
- Search: `parked:yes` / `parked:waiting-on` if the operators exist (they don't yet), otherwise just the facet.

### 2.6 HR notice auto-suggest
1. **Measure first** (read-only script): pull the open IT HR notices and report parser hits per template. Candidates: sources 13 / 18 (Employee On/Offboarding), subject `^NH\s`, requester "BambooHR Notifications", categoryMatcher onboard/offboard synonyms.
2. **Strict parser** `utils/hrNoticeDates.js`: labelled fields only:
   - "Start date", "Effective (date)", "Last day", "Expected Return Date", "Leave start/end", "Transfer effective";
   - formats ISO, `Mon D, YYYY`, `D Mon YYYY`, `MM/DD/YYYY` (BGC is Canadian: reject ambiguous numeric dates).
   Returns `{ date, label, confidence:'exact'|'ambiguous' }`.
3. On ticket creation (IT, when Q2 is on) and once as a backfill over open notices:
   - exact, future and ≤ 6 months → park `until_date`, `source='suggested_hr'`, reason "Transfer effective Oct 5 (from the HR notice)", Activity with undo;
   - otherwise → a suggestion banner on the ticket.
   Departures park until the last day.

### 2.7 Workflows (Settings → Mail Workflows)
- **Triggers:** `ticket.parked`, `ticket.woke` in `NOTIFICATION_EVENT_TYPES`; `ticket.park_due_soon` in `TIME_TRIGGER_EVENT_TYPES` (hours before).
- **Conditions:** `ticket.isParked`, `ticket.parkKind`, `ticket.parkedUntil` (`notificationConditionModel.CONDITION_FIELDS` + engine context).
- **Actions:** `park_ticket` (kind, until as a date or "+N days", reason) and `unpark_ticket` (`NOTIFICATION_NODE_REGISTRY` + `ACTION_NODE_TYPES` + engine executor + editor UI).
- One installable template: **"Park HR notices until their date"**, off by default.

### 2.8 Alerts (My Alerts)
New triggers `parked_wake` and `park_due_soon` (boolean columns + `agentAlertService.TRIGGERS`), matching "tickets assigned to me". The default for the assignee follows Q1.

### 2.9 Public API v1 + webhooks
- The ticket shape gains `parked: { kind, until, reason, waitingOn, parkedBy, parkedAt } | null`; add filter `?parked=`.
- `POST /api/v1/tickets/:id/park` and `DELETE /api/v1/tickets/:id/park` (scope `tickets:write`, problem+json codes `park_date_invalid`, `park_requester_use_pending_response`).
- Webhook events `ticket.parked` and `ticket.woke` (`WEBHOOK_EVENTS`). OpenAPI updated; `apiV1OpenApiSpec` test.
- Update the ContinuIT and Simorgh guides' event lists.

### 2.10 Briefs and follow-up skill (design worktree, local)
- `briefs/daily-brief-probe.mjs`, `briefs/agent_section.py`, `briefs/followups/followups.py` and the `/ticket-followups` rules: parked tickets are never stale, overdue or untouched until their date.
- A ticket that woke with no update for 3 days counts again.
- The agent workload bar gets a hatched-grey **parked** segment.
- The weekly brief flags **re-parked 3+** as a coaching signal.

## 3. Frontend

- **Ticket page:**
  - one quiet line under the subject: clock pictogram, "Parked until Oct 5 · Transfer effective Oct 5 · by Andrii", then **Extend** and **Unpark** (no pill);
  - **Park…** in the More menu opens the park dialog;
  - the HR suggestion banner;
  - Activity entries for parked / extended / woke / unparked.
- **Park dialog:**
  - kind (3 choices);
  - date with quick picks (next Monday, in 2 weeks, "the date in the email" when suggested), capped at 6 months;
  - reason;
  - a people picker for waiting-on (the requester redirects to Pending Response, with the one-line explanation);
  - a "Repeating task? Schedule it instead" link to scheduled tickets.
- **Status display:** wherever status renders (queue row, peek, header, public status page stays "Pending"), a parked ticket shows **Parked** (`ticketUi` status chip → a "Parked" treatment, not a pill per Vahid's taste).
- **Queue:**
  - `QUEUE_CARD_REGISTRY` `parked` card ("N parked · 3 wake this week");
  - `TicketFilterRail` **Parked** facet;
  - canned view **Parked** (next to Scheduled, sorted by wake date);
  - opt-in column "Parked until";
  - bulk bar **Park… / Unpark**;
  - URL `?parked=`.
- **Dashboard / Technician page / Timeline:** load excludes parked; a muted "+4 parked"; a Parked filter on the technician page.
- **Analytics:** Parked band; Automation Ops park metrics.
- **Settings:** Mail Workflows triggers/conditions/actions and the template; My Alerts options.
- Dark mode via tokens; `lint:dark` clean. Accessibility: the dialog traps focus, the date input is labelled, the Unpark button has an aria-label.

## 4. Tests
- **Backend:**
  - park/extend/unpark/wake rules (6-month cap, reason required, requester → pending_response redirect, one active park);
  - FS-born park writes 3 and wake writes 2;
  - no echo unpark on the park's own change or a sync echo;
  - unpark on requester reply, person status change, latest-wins adoption, workflow update_ticket, and close;
  - wake sweep claim atomicity; dueBy shift (TP-born only);
  - requester_silent excludes parked;
  - list segments and facets; stats `openLike` excludes parked;
  - API park endpoints + OpenAPI; webhook events; workflow trigger/condition/action;
  - HR parser table (real notice formats from the measurement) and the backfill dry run.
- **Frontend:** the park dialog (validation, requester redirect, quick picks), header line, stat card and facet, bulk park, dashboard "+N parked".
- **Full suites:** backend Jest, Vitest, `lint:dark`, build.

## 5. Acceptance checks (real tickets, after deploy)
- #235207 / #238553 (Andrii, transfers) parked until **Oct 5**:
  - out of the follow-up rules, the brief's pending counts and the queue's open scopes;
  - FreshService shows Pending;
  - on Oct 5 they wake as Open and Andrii is told (Q1).
- #202791: suggested from "Expected Return Date: 2026-11-16".
- #173857: parked with **ETA Oct 31**.
- #228595: "waiting on Alexa + Kirsten, chase Sep 30" wakes Anton on Sep 30.
- A requester reply on a parked ticket unparks it with a note. The park's own Pending doesn't unpark it after two sync cycles.
- A park more than 6 months out is refused; a read-only member gets 403.

## 6. Order tonight (one release with the QA items)
1. Measure HR notices (read-only) → parser table.
2. Migration (additive) → apply to prod **before** the merge; partial index CONCURRENTLY out of band.
3. `ticketParkService` + wake sweep + unpark hooks + guards (2.1–2.4) with tests.
4. Queries/counts (2.5) → API/webhooks (2.9) → workflows (2.7) → alerts (2.8) → HR suggest (2.6).
5. Frontend (3).
6. The QA package items.
7. Full suites → release → migration check → acceptance checks on the real tickets (parks created only with Vahid's OK, or by the assignee).
8. Briefs/follow-up skill updates (design worktree, local) + the response PDF sections (Parked, and Pending Response 3.9.72).

Size: large, roughly the plan's ~2 weeks of focused work compressed into one build, so it runs as a long session. If time runs short, the cut line is after step 5 (core + counts + API + UI). Workflows, alerts and HR suggest follow in the next build, and the PDF says so.
