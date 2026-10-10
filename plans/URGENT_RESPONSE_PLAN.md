# Urgent response — build plan

Source: QA 10-09 item 5 and the design conversation with Vahid on 10 Oct 2026.
Target release: 4.2.37-preview. Worktree: `C:/Cursor/ticket-pulse-urgent` (branch `cursor/urgent-response`).

## The rule

**An Urgent ticket always has an owner who is at work, and somebody touches it within N minutes.**
Everything is deterministic (no LLM), per workspace, configurable on one settings page, logged, and undoable.

Three layers:

1. **When assigning** — the AI pipeline never auto-assigns an in-scope ticket to someone who is not at work (or starting within the grace minutes). It picks the best person at work instead.
2. **When it becomes urgent** — a ticket that enters scope while its owner is not at work is moved right away to someone at work. If the owner was assigned by hand: tell only (setting), and let the clock move it.
3. **If nobody touches it** — a clock in business minutes. After `clockNotifyMinutes` the people at work are told; after `clockMoveMinutes` it moves. At most `maxMoves` moves, then the coordinator.

Decisions (all confirmed by Vahid):

- Defaults: layer 1 Urgent + High; layers 2 and 3 Urgent only; 15 / 30 minutes; grace 30 minutes; max 2 moves.
- A **touch** is any action by **any agent** (public reply, internal note, forward, status change, field change by a person). Nothing the requester or the system does counts.
- Picking the new owner, fixed order: (1) at work now and not on leave; (2) has the skill for the ticket's category (subcategory match, then category match, then none); (3) fewest open tickets; (4) least recently given a ticket.
- Hand-assigned tickets: tell only by default (`raiseManualAction`), the clock still applies.
- Nobody at work: `nobodyMode` = `hold` (leave it, tell a named contact, re-check every minute until someone is at work) or `on_call` (assign to the after-hours on-call person and text them).
- The clock only counts business minutes, so it does not run outside business hours.
- Priority lowered: the clock stops, nothing moves back. Parked: no clock; it restarts on wake or reopen.
- The requester is never notified of a move.
- Mode per workspace: `off` | `observe` (label **Shadow**) | `live`. Off everywhere; IT (workspace 1) starts in Shadow.
- Settings writable by workspace admins; every change recorded (who, when, field, before, after).
- On-call: weekly rotation of existing agents, handover day + time (default Monday 17:00 workspace time), 8-week schedule, reorder, cover for a whole week or part of it without changing the long-term order.
- **On-call person on leave: never skipped automatically.** The week is flagged "needs cover"; an admin either sets the cover directly or sends a cover request (Teams + e-mail + a prompt in the app) to the other people in the rotation; the first to accept takes it.
- "Priority" means the native `ticket.priority` (1 Low, 2 Medium, 3 High, 4 Urgent). Layer 1 runs before the native priority is written, so it uses the run's assessed priority.

## Data model (additive migration `20261010200000_urgent_response`)

No foreign keys, no Prisma relations (ids only), every read wrapped in a `soft()` helper so a missing table degrades instead of throwing. Timestamps `TIMESTAMPTZ(6)`. `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`.

`urgent_response_settings` (model `UrgentResponseSettings`, PK `workspace_id`)

| column | type | default |
|---|---|---|
| mode | varchar(10) | 'off' |
| assign_enabled | bool | true |
| assign_priorities | int[] | {4,3} |
| assign_grace_minutes | int | 30 |
| raise_enabled | bool | true |
| raise_priorities | int[] | {4} |
| raise_manual_action | varchar(10) | 'notify' (`notify` \| `move`) |
| clock_enabled | bool | true |
| clock_priorities | int[] | {4} |
| clock_notify_minutes | int | 15 |
| clock_move_minutes | int | 30 |
| notify_audience | varchar(12) | 'on_shift' (`on_shift` \| `group` \| `named`) |
| notify_technician_ids | int[] | {} |
| notify_channels | text[] | {teams,email} |
| nobody_mode | varchar(10) | 'hold' (`hold` \| `on_call`) |
| nobody_contact_technician_id | int null | |
| coordinator_technician_id | int null | |
| max_moves | int | 2 |
| on_call_order | int[] | {} |
| on_call_handover_day | int | 1 (0 = Sunday) |
| on_call_handover_time | varchar(5) | '17:00' |
| on_call_anchor_date | date null | (the date of the first handover of `on_call_order[0]`) |
| baselined_at | timestamptz null | |
| updated_by | varchar(255) null | |
| created_at / updated_at | timestamptz | now |

The migration ends with: insert a row for workspace 1 with `mode = 'observe'` if workspace 1 exists and has no row (`INSERT … SELECT … WHERE EXISTS … ON CONFLICT DO NOTHING`).

`urgent_response_settings_changes` (`UrgentResponseSettingsChange`): id, workspace_id, changed_by, changed_by_name, field varchar(200), before jsonb, after jsonb, created_at. Index (workspace_id, created_at).

`urgent_response_actions` (`UrgentResponseAction`) — the log
id, workspace_id, ticket_id int null, layer varchar(12) (`assign` | `raise` | `clock` | `on_call` | `undo`), action varchar(24) (see below), shadow bool, priority int null, from_technician_id, to_technician_id, from_name varchar(255), to_name varchar(255), sentence text, details jsonb, dedupe_key varchar(200) unique null, undone_at, undone_by varchar(255), undo_of_id int null, created_at. Indexes (workspace_id, created_at), (ticket_id, created_at).

Actions: `redirected` (layer 1 chose someone else), `held` (nobody at work, left for review / with the owner), `moved`, `told_owner_away` (hand-assigned, tell only), `team_told`, `coordinator`, `on_call_assigned`, `undone`, `cover_needed`, `cover_requested`, `cover_set`, `failed`.

`urgent_response_clocks` (`UrgentResponseClock`, PK `ticket_id`)
workspace_id, owner_technician_id, state varchar(12) (`running` | `waiting` | `stopped`), started_at, notify_at, move_at, notified_at, move_count int default 0, chain_technician_ids int[] default {} (people it has already left), stopped_at, stop_reason varchar(24), shadow bool, updated_at. Index (workspace_id, state).

Stop reasons: `touched`, `priority_lowered`, `closed`, `parked`, `unassigned`, `owner_changed`, `moved`, `coordinator`, `undone`, `baseline`, `shadow_done`, `mode_off`.

`urgent_response_on_call_covers` (`UrgentResponseOnCallCover`): id, workspace_id, original_technician_id, cover_technician_id, starts_at, ends_at, note text, source varchar(10) (`admin` | `request`), request_id int null, created_by, created_at, cancelled_at. Index (workspace_id, starts_at).

`urgent_response_cover_requests` (`UrgentResponseCoverRequest`): id, workspace_id, original_technician_id, starts_at, ends_at, message text, status varchar(10) (`open` | `filled` | `cancelled` | `expired`), asked_technician_ids int[], responses jsonb default '[]' (`[{technicianId, answer, at}]`), filled_by_technician_id, filled_at, created_by, created_at, updated_at. Index (workspace_id, status).

## Backend modules

All under `backend/src/services/urgentResponse/`.

### `rules.js` — pure, no I/O, fully unit-tested
- `atWork(tech, at, { leaves, isBusinessDay, graceMinutes = 0 })` → `{ atWork, reason, startsInMinutes }`. Shift = `workStartTime`/`workEndTime` (default 09:00–17:00) in the technician's own `timezone`; weekday must be a business day (caller supplies `isBusinessDay(localDateStr, dayOfWeek)`; default Mon–Fri); full-day leave (category not WFH/IGNORED) = away; half-day leave = away inside `startMinute..endMinute`; overnight shifts supported. `graceMinutes` counts "starts within N minutes" as at work. Injectable `at` — never `new Date()` inside.
- `rankResponders(candidates)` — the fixed order above; returns the list sorted with a `why` string per candidate. Candidate: `{ id, name, atWork, awayReason, skill: 'exact'|'category'|'none', openTickets, lastAssignedAt }`.
- `handoverInstant(dateStr, time, timezone)`, `onCallWeek(settings, timezone, at)` → `{ index, startsAt, endsAt, technicianId }` using calendar weeks in the workspace zone (DST-safe, `date-fns-tz`), `upcomingWeeks(settings, timezone, from, count)`.
- `resolveOnCall(week, covers, at)` → `{ technicianId, scheduledTechnicianId, cover }`.
- `sentenceFor(action, ctx)` — the one plain-English sentence used for the ticket activity, the log row and notices. Shadow sentences start "Shadow: would have …". Examples:
  - `Moved from David Zapata to Andrew Fong by the Urgent rule. Became Urgent at 07:10; David starts at 09:00. Andrew is at work and has the Network skill.`
  - `Assigned to Andrew Fong instead of David Zapata by the Urgent rule: David starts at 09:00.`
  - `Urgent and untouched for 15 minutes. The people at work were told.`
  - `Urgent and untouched for 30 minutes. Moved from Andrew Fong to Maria Lee: at work, fewest open tickets.`
  - `David Zapata is away and this ticket was assigned by hand, so it stays with them. The people at work were told.`
  - `Nobody is at work. Left with David Zapata; Susan Xu was told.`
  - `Nobody is at work. Assigned to the on-call person, Andrew Fong, who was texted.`
  - `Moved back to David Zapata by Vahid Haeri (undo).`
- Validation helpers and defaults: `DEFAULT_SETTINGS`, `normalizeSettings(input)`, `validateSettings(s)` (minutes 1–480, move ≥ notify, priorities subset of [3,4] and non-empty when the layer is on, channels subset of teams/email, handover time HH:MM, day 0–6).

### `settingsService.js`
`getSettings(workspaceId)` (defaults when no row; never creates on read), `getMode(workspaceId)`, `updateSettings(workspaceId, input, actor)` (validate, upsert + change rows in one transaction, people ids must be active technicians of the workspace, widening scope or leaving `off` sets `baselined_at = null`), `listChanges(workspaceId, { limit })`, `listTechnicians(workspaceId)` (id, name, email, isActive, timezone, workStartTime, workEndTime — **never photoUrl**). When `on_call_order` is empty and `UrgentEscalationPolicy.afterHoursRotationOrder` is not, `getSettings` returns that order as a suggestion (`onCallOrderSuggested: true`), not saved until the admin saves.

### `onCallService.js`
`schedule(workspaceId, { from, weeks = 8 })` (weeks with scheduled person, covers, leave days of the scheduled person inside their window from `technician_leaves`, `needsCover`, open request), `current(workspaceId, at)` → `{ technician, scheduled, cover, until, onLeaveNoCover }`, `createCover`, `cancelCover`, `createRequest` (asks the other people in the order unless `askTechnicianIds` given; notifies them by Teams + e-mail with a link to `/on-call?request=<id>`; logs `cover_requested`), `respond(requestId, technicianId, answer)` (first accept wins atomically via `updateMany where status='open'`; creates the cover with `source='request'`, tells the admin who asked and the original person, logs `cover_set`), `cancelRequest`, `requestsFor(technicianId)`, `dailyCoverCheck(workspaceId, now)` (once per day per week: if next week's or this week's person has leave and no cover/request, tell the coordinator and log `cover_needed` with a dedupe key).

`urgentEscalationContactService.resolveAfterHoursActiveContact`: in `weekly_rotation` mode, when the new settings have a non-empty `on_call_order`, use `onCallService.current()` (so the phone shown to requesters follows handover time and covers). Otherwise the legacy logic, unchanged.

### `notifier.js`
`tellPeople({ workspaceId, technicianIds, title, lines, ticket, refKey, channels })` → `{ teams, email }` summary; Teams through `teamsNotificationService.sendWorkflowMessage` (check `.off`), e-mail through `sendTransactionalEmail` with `emailShell` HTML (no CSS gradients; never pass `ticket` to the mail call; link via `resolvePublicBaseUrl`). `textOnCall(technician, body)` → SMS through `sendSms` to a verified phone (`phoneOverride || entraMobilePhone || entraPhone`, `phoneVerifiedAt` set), reported in the log when there is none. Never throws.

### `urgentResponseService.js` — the engine (singleton)
- `start()` / `stop()` / `sweep({ now })` — 60-second worker registered in `app.js` like the park sweep; kill switch `URGENT_RESPONSE_SWEEP_ENABLED=false`; only started when `config.sync.enableScheduledSync`; in-memory re-entry guard; sequential; batches of 50; durable claims with `updateMany` guards.
- The sweep is a **reconciler**, not event-driven (there are ten code paths that can raise a priority, most record no event):
  1. Load settings rows with `mode != 'off'`.
  2. If `baselined_at` is null: every open, assigned, unparked ticket currently in scope gets a clock row `state='stopped', stop_reason='baseline'`; set `baselined_at`. (No flood on switch-on.)
  3. In-scope tickets = open status, `priority` in (raise ∪ clock priorities), `assignedTechId` not null, `parkedUntil` null. A **new cycle** starts when there is no clock row, or the row's owner differs from the ticket's owner, or the row is stopped with a reason other than `touched` / `undone` / `baseline` / `coordinator` / `shadow_done` / `moved`.
  4. New cycle: owner at work → clock `running` (if the clock layer covers this priority). Owner not at work and the raise layer covers it → hand-assigned + `notify`: `told_owner_away` + tell the audience, clock `running`; otherwise pick a responder and move (`moved`), new clock for the new owner. Nobody at work → `nobodyMode`: `hold` → `held`, tell the contact, clock `waiting` (re-evaluated every sweep until someone is at work); `on_call` → `on_call_assigned` + SMS (falls back to `hold` when the on-call person is on leave without cover or cannot be resolved).
  5. Active clocks (`running` / `waiting`): stop when the ticket left scope (closed, priority lowered, parked, unassigned, owner changed by a person) or was touched since `started_at`; else at `notify_at` → `team_told` once; at `move_at` → move (or `coordinator` when `move_count >= maxMoves`: assign to the coordinator if set, tell them, stop).
  - `notify_at` / `move_at` come from `businessCalendarService.addBusinessMinutes(started_at, n, { workspaceId })`.
  - Shadow: everything is computed and logged with `shadow = true`; nothing is sent, nothing moves; after the "would have moved" row the clock stops (`shadow_done`).
- Touch detection (per ticket, only for active clocks): a `TicketThreadEntry` after `started_at` that is an agent's (`authorType = 'agent'`, or `eventType` in `public_reply`, `private_note`, `forward`), not `authorType = 'system'`; or a `status_event` / other FS activity entry that passes `countsAsRealActivity`; or a `TicketActivity` after `started_at` whose `details.actorKind = 'human'`. Our own writes use actor `{ name: 'Ticket Pulse (urgent response)', role: 'automation' }` and never count.
- "Assigned by hand" = current open `TicketAssignmentEpisode.startMethod` in (`coordinator_assigned`, `self_picked`), or no episode and the latest pipeline run for the ticket is not `auto_assigned` to this person.
- `pickResponder(workspaceId, ticket, { exclude, now, graceMinutes })` → `{ chosen, considered }`: active technicians of the workspace (FS-born tickets need a `freshserviceId`), leave from `technician_leaves`, business days from `businessCalendarService.loadCalendar`, skills from `TechnicianCompetency` against `internalSubcategoryId` / `internalCategoryId`, open counts by one `groupBy`, last `assignedAt` by one `groupBy`.
- `moveTicket(ticket, toTech)` — origin-aware exactly like `applyWorkflowAssignment` (`assignTicket` for TP-born, `updateFsTicket` for FS-born); on failure try the next candidate (max 3), then log `failed`.
- Every action: one `UrgentResponseAction` row + (when it concerns a ticket and is not shadow) one `TicketActivity` `activityType: 'urgent_response'`, `performedBy: 'Ticket Pulse'`, `details: { sentence, layer, action, fromTechId, toTechId }` + a log line `Urgent response: <sentence> (ticket <id>)`.
- `guardAutoAssignment({ workspaceId, ticket, techId, assessedPriorityId, runId, now })` → `{ outcome: 'keep' | 'redirect' | 'hold' | 'on_call', techId, sentence, shadow }` — layer 1, called from `assignmentPipelineService._executeRun` just before the run row is written with `assignedTechId`. Live `redirect` replaces the technician; live `hold` downgrades the decision to `pending_review` (same pattern as the existing guards: a `createPipelineStep` with `kind: 'urgent_response_guard'`). Shadow only logs. Any error → `keep` (never block assignment).
- `undo(actionId, actor)` — for live `moved` / `redirected` / `on_call_assigned` / `coordinator` rows with a `from` person, when the ticket is still with the `to` person: assign back, log `undone` (`undo_of_id`), stamp `undone_at/by` on the original, stop the clock with `undone`. Otherwise 409 with a plain reason.
- `listActions(workspaceId, { limit, before, layer, shadow })`, `stats(workspaceId, { days })` (counts by layer/action, live and shadow separately), `clockView(ticketId)` (for the ticket page, live only), `preview(workspaceId, draft, { days = 30 })` — deterministic replay estimate from history: auto-assigned runs whose person was not at work at `decidedAt` (layer 1); `TicketPriorityEvent` raises into scope with an owner not at work (layer 2); in-scope cycles with no agent touch within the notify / move business minutes (layer 3). Returned with `estimate: true`.
- `weeklySummary(workspaceId, { since, until })` + a weekly admin e-mail (`urgentResponseDigestService.js`, cron Monday 08:10 Pacific in `scheduledSyncService`, kill switch `URGENT_RESPONSE_DIGEST=false`, to workspace admins, skipped when mode is off or nothing happened, sandbox workspaces 6/7/8 excluded).
- `analyticsService.getAutomationOps` gains an optional `urgentResponse` block (try/catch → null): counts by layer for the selected range, live and shadow. No per-person numbers.

## API — `backend/src/routes/urgentResponse.routes.js`, mounted at `/api/urgent-response` after the global workspace gates

All responses `{ success: true, data }`.

Any member (agents included):
- `GET /status` → `{ mode }`
- `GET /on-call` → `{ timezone, handoverDay, handoverTime, current: { technician: {id,name}, scheduled: {id,name}, cover: {id,…}|null, until }, weeks: [{ index, startsAt, endsAt, scheduled: {id,name}, covers: [{ id, technician: {id,name}, startsAt, endsAt, note, source }], leaveDays: ['yyyy-MM-dd'], needsCover, openRequest: { id, status, askedCount, declinedCount } | null }], me: { technicianId } }`
- `GET /on-call/requests/mine` → `[{ id, original: {id,name}, startsAt, endsAt, message, createdBy }]` (open, I am asked, I have not answered)
- `POST /on-call/requests/:id/respond` `{ answer: 'accept' | 'decline' }` → `{ status, cover | null }` (409 when already filled)

Workspace admin (`requireAdmin`):
- `GET /settings` → `{ settings, technicians: [{ id, name, email, isActive, timezone, workStartTime, workEndTime }], teamsEnabled, onCallOrderSuggested }`
- `PUT /settings` (partial, camelCase of the columns) → `{ settings, changes }`
- `GET /settings/changes?limit=50`
- `POST /preview` (draft settings) → `{ days, estimate: true, assign: { redirected, held }, raise: { moved, told }, clock: { teamTold, moved, coordinator }, inScopeTickets }`
- `GET /actions?limit=50&before=<id>&layer=&shadow=` → `{ items: [{ id, createdAt, layer, action, shadow, priority, ticket: { id, displayRef, subject } | null, from: {id,name}|null, to: {id,name}|null, sentence, details, undoable, undoneAt, undoneBy }], nextBefore }`
- `GET /stats?days=30` → `{ days, live: { redirected, held, moved, toldOwnerAway, teamTold, coordinator, onCallAssigned, undone }, shadow: { same keys } }`
- `POST /actions/:id/undo` → `{ action }`
- `POST /on-call/covers` `{ originalTechnicianId, coverTechnicianId, startsAt, endsAt, note }` · `DELETE /on-call/covers/:id`
- `POST /on-call/requests` `{ originalTechnicianId, startsAt, endsAt, message, askTechnicianIds? }` · `POST /on-call/requests/:id/cancel`

Settings JSON (camelCase): `mode, assignEnabled, assignPriorities, assignGraceMinutes, raiseEnabled, raisePriorities, raiseManualAction, clockEnabled, clockPriorities, clockNotifyMinutes, clockMoveMinutes, notifyAudience, notifyTechnicianIds, notifyChannels, nobodyMode, nobodyContactTechnicianId, coordinatorTechnicianId, maxMoves, onCallOrder, onCallHandoverDay, onCallHandoverTime, onCallAnchorDate, updatedBy, updatedAt`.

Ticket page: `GET /api/tickets/:id` is decorated (like `ticket.park`) with `ticket.urgentClock = { state: 'running' | 'waiting', startedAt, notifyAt, moveAt, notifiedAt, notifyMinutes, moveMinutes }` — live mode and an active clock only.

Frontend API object (`frontend/src/services/api.js`): `urgentResponseAPI = { getStatus, getSettings, updateSettings(patch), getChanges(limit), preview(draft), getActions(params), getStats(days), undoAction(id), getOnCall(), createCover(body), cancelCover(id), createCoverRequest(body), cancelCoverRequest(id), myCoverRequests(), respondCoverRequest(id, answer) }`.

## Frontend

- Settings nav: new item `{ id: 'urgent-response', label: 'Urgent Response', Icon: Siren, minRole: 'admin', group: 'Tickets & AI' }` replacing `urgent-escalation`; hash alias `urgent-escalation → urgent-response` (opens the "Requester escalation" tab). Existing links keep working.
- `components/settings/urgentResponse/UrgentResponsePanel.jsx` with a light tab bar: **Rules** · **On-call** · **Log** · **Requester escalation** (the existing `UrgentEscalationPanel`, embedded; its rotation order list is replaced by one line pointing to the On-call tab when the new order is in use).
- **Rules** tab: Mode control (Off / Shadow / Live, the same radio cards and status dots as On/Offboarding, with hints written for this feature); the three layers drawn left to right as a path (① When assigning → ② When it becomes urgent → ③ If nobody touches it), each a quiet card with its own switch, "Applies to" Urgent / High checkboxes and its numbers; below: "Nobody at work" choice + contact; "Who is told" (audience + named people + Teams / e-mail checkboxes; Teams shown as unavailable when the workspace has Teams off); coordinator + max moves; "How the next owner is picked" (the four fixed steps, read-only); a **preview line** recalculated on change (debounced `POST /preview`): "With these settings, the last 30 days would have had 12 redirected, 3 moved, 5 team notices and 1 clock move (estimate)."; Save; "Changes" list (who, when, field, before → after).
- **On-call** tab: who is on call now and until when; handover day + time; the order with up/down buttons (no new drag dependency) and add/remove; the next 8 weeks as rows (dates, avatar + name, cover lines, leave days, "Needs cover" in plain amber text with **Set cover** and **Ask for cover** actions, request state "Asked 4 people · 1 declined"); Set cover dialog (who, from, to — whole week by default, or the remaining days; note).
- **Log** tab: the 30-day counts (live and shadow separately), filters (layer, live/shadow), rows = time, ticket link, the sentence, and **Undo** ("Move back to David") on undoable live rows with an in-app confirm.
- `/on-call` page (any signed-in member, agents included; add to `TRACKED_ROUTES` as `oncall`; reachable from the nav for agents): the same 8-week schedule read-only, my weeks marked, open cover requests addressed to me with **Take it** / **Not this time**; `?request=<id>` scrolls to that request.
- App-wide prompt: when `myCoverRequests()` is non-empty, a slim banner under the header: "Andrew Fong needs on-call cover 12–19 Oct. Can you take it?" [Take it] [Not this time] [See schedule]. Checked on load and every 10 minutes; dismissible per request for the session.
- Ticket page: under the title, when `ticket.urgentClock` is present, one plain line (no pill): "Urgent: untouched for 12 min. The team is told at 15 min; it moves at 30 min." (updates every 30 s client-side); `waiting` → "Urgent: nobody is at work. It moves as soon as someone is."
- Ticket activity timeline: `urgent_response` entries render `details.sentence` with the Ticket Pulse actor.
- Analytics → Automation Ops: one `Panel` "Urgent response" with the counts by layer for the range (live; shadow in muted text). No people.
- House rules: design tokens only (`npm run lint:dark` must stay at 0 for new files), no pills (status = coloured dot + word), avatar + name for people, `FancySelect` not native selects, in-app confirm dialogs, plain words, WCAG AA focus rings, holds up at 390 px width.

## Tests

- Backend Jest (ESM, mocked Prisma): `urgentResponseRules.test.js` (atWork incl. weekend, leave, half day, overnight, grace, zones; ranking order; handover math across the 1 Nov DST change; on-call with covers; sentences), `urgentResponseSettings.test.js`, `urgentResponseOnCall.test.js`, `urgentResponseEngine.test.js` (baseline, each layer live and shadow, touch stops the clock, chain → coordinator, nobody at work both modes, hand-assigned tell-only, undo, failures never throw), `urgentResponseGuard.test.js` (pipeline hook), `urgentResponseRoutes.test.js` (gates: member vs admin, readonly), plus stubs in `roleLockdownGates.test.js` and any Prisma mock the touched services need.
- Frontend Vitest: panel tabs, rules save + validation + preview, on-call schedule + cover dialog + request, log + undo, `/on-call` page, banner, ticket line, activity sentence, settingsNav alias, usageTracker route.
- Full suites green before release; `lint:dark`; build.
