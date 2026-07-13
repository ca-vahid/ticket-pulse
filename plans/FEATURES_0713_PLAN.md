# Features Request 07-13 — implementation plan

Source: `qa/Features Request - 07-13.docx` (9 items). Scoping decisions confirmed 2026-07-13:
full FS-style merge; monthly+yearly+weekly recurrence; Department field shows Entra department
+ office location; items 1–7 built this batch, audit page + backup delivered as designs first.

## This batch (build)

### 1. Ticket merge — full FS-style, TP-born tickets
- **Backend** `ticketMergeService.mergeTickets(workspaceId, primaryId, secondaryIds[], actor)`:
  secondaries must be TP-born (FS-born stay FreshService-owned; they can be *linked*, not
  merged) and open; primary TP-born. Per secondary: copy its conversation (replies + notes,
  chronological) into the primary as internal notes prefixed "↪ merged from TP-<n> — <author>,
  <date>"; link `merged_into`; pointer note on the secondary ("Merged into TP-<n> — the
  conversation continues there"); Close the secondary through the normal status path (mirror +
  events); merge requester/Cc emails into the merge summary note on the primary. Audit entries
  both sides, SSE both tickets. Route: `POST /tickets/:id/merge`.
- **Frontend** TicketDetail toolbar "Merge" → modal: multi-select ticket picker
  (search + checkbox list), **pre-suggested candidates** (open tickets from the same requester
  in the last 7 days; burst-guard `duplicate_of` links pre-checked), primary selector
  (radio, defaults to oldest), consequence summary, typed confirmation.

### 2. Recurring scheduler (extends existing one-shot ScheduledTicket)
- Schema (additive): `recurrence` ('none'|'weekly'|'monthly'|'yearly'), `recurrenceDay`
  (weekday 0-6 or day-of-month 1-31), `recurrenceMonth` (yearly), `endAt?`, `lastSpawnedAt?`.
  `scheduledForAt` keeps meaning "next fire".
- Activation sweep: recurring rows spawn the ticket, then advance `scheduledForAt` to the next
  occurrence (workspace timezone; clamp day 29-31 to month end) instead of completing.
  `endAt` passed → status 'completed'. Spawned tickets go through normal AI triage.
- UI: the existing Schedule flow gains a Repeat control (Never/Weekly/Monthly/Yearly + day
  pickers); Scheduled view rows show "Monthly · next Jul 31, 5:00 AM" + pause/resume.
- Migration dev+prod before merge.

### 3. "Unknown" note author → "Ticket Pulse"
FS-born thread entries authored by FS workflows/API (no user id) currently render "Unknown".
Resolver fallback: private notes with no actor → `actorName: 'Ticket Pulse'`; frontend renders
the TP logo avatar for it. Frontend-side fallback also applied so historical entries (e.g.
#179369) display correctly without a backfill.

### 4. Department field on the ticket sidebar (read-only)
New SidebarField "Department" under Group: `requester.entraDepartment` + `officeLocation`
("Engineering · Vancouver"), em-dash when Entra has neither. Read-only (no Entra write access).

### 5. Remove Impact & Urgency from the create form
Delete the two selects (detail sidebar keeps them).

### 6. Tickets-page left rail: full icons by default, collapsible
Reverse the peek default on /tickets*: show the standard 58px icon rail, with a collapse
control (chevron at the rail foot) that shrinks it to the existing 20px peek edge
(hover/click-to-pin behaviors kept). Choice persists per user (localStorage). Page padding
follows via a `--tp-rail-w` CSS variable so both states reserve the right gutter.

### 7. Susan Xu → approval manager (prod config)
Add Susan to the approval managers of every existing approval category in ws1 (script; same
pattern as other prod config changes).

## Designs to review before building (next batch)

### 8. Comprehensive audit page
One admin surface unifying: ticket activity (ticket_activities), AI runs + write-backs
(assignment_pipeline_runs/steps), workflow executions (notification_workflow_runs/steps +
deliveries), sync cycles (sync_logs), and — the missing piece — **admin/config mutations**,
which today only live in logger output. Requires a small `audit_events` table + emitters at
settings/config mutation points (SLA, types, mailboxes, AI config, approval categories,
noise rules…). Page: `/settings#audit` with type/actor/ticket/date filters, detail drawer,
CSV export. Retention setting (default 180d).

### 9. Data backup capability
Recommended shape: (a) **nightly full-dataset dump** (pg_dump) to Azure Blob with 30-day
retention — infra-level, covers everything including attachments metadata; plus (b)
**on-demand workspace export** button (Settings → Sync Ops): tickets + conversations +
audit fields as JSON/CSV zip, streamed download for spot compliance asks. Attachment BLOBS
already live in Azure Storage (referenced by blobName, not duplicated). Needs: a small worker
schedule, storage account/container + SAS config, restore runbook doc.

## Ship checklist
Per convention: migrations dev+prod before merge; jest/vitest/eslint; Playwright verify (merge
modal, recurring schedule UI, rail toggle, department field); version bump (re-check prod
/health + origin/main first — parallel sessions active); changelog.js entries + APP_VERSION;
QA response PDF next to the docx.
