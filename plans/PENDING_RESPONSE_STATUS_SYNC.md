# Pending Response + FreshService status sync: build notes

_23 Sep 2026. Decisions by Vahid in conversation the same day. Companion to
`ticket-pulse-design/plans/PARKED_TICKETS_PLAN.md` (Part A). Parked (Part B) is a later build._

## What Vahid decided

1. **One name:** Ticket Pulse calls FreshService status **6** **"Pending Response"**, in every workspace.
2. **FreshService sends the reminders** until cut-over. Setting Pending Response in Ticket Pulse must put the
   FreshService ticket in status 6, so FreshService's own 72 h / 96 h process runs. Ticket Pulse sends no
   requester reminders in IT (all IT requester-facing workflows are observe-only; the TP "Pending Response,
   close after 96 h" workflow #13955 stays **off**).
3. **No cut-over switch. The latest change wins.** When the Ticket Pulse ticket and its FreshService copy disagree
   on status or agent, the side that changed it most recently wins, and the other side follows.
4. **Parked** (later) shows as "Parked" in Ticket Pulse and as plain Pending (3) in FreshService.

## What was wrong (production evidence, 23 Sep)

| # | Problem | Evidence |
|---|---|---|
| 1 | FreshService status 6 synced into Ticket Pulse as **"Waiting on Customer"**. That label is in no status registry, so those tickets dropped out of open counts, the load colour, the queue's open/awaiting views and the requester-silent trigger (only analytics added them back). | `freshserviceTransformer.js` STATUS_MAP[6]. IT: 2 tickets in that state; #222020 was "Waiting on Customer" in TP but Closed in FS. |
| 2 | Choosing **"Pending Response"** in Ticket Pulse sent FreshService **3 (Pending)**, not 6, so FreshService's pending-response reminders never started. The next sync then rewrote the label to "Pending". | `getStatusId` falls back to the base; `syncService` single-ticket reconcile compares `getStatusString(3)='Pending'`. |
| 3 | A Ticket Pulse ticket's FreshService copy, when closed or reassigned in FreshService, was **ignored**. Ticket Pulse only logged a "mirror conflict", leaving ghost-open tickets. | 30 days: IT 25 tickets, Project Accounting 31. Still open on 23 Sep: TP-1294 (closed in FS by Mehdi Abbaspour), TP-1514 (FS copy deleted by Sam Khadem), TP-1285/1286/1517 (Pending in FS). |
| 4 | Any FreshService status other than 2–7 synced silently as **Open**. | transformer fallback `|| 'Open'`. |

## What the build does

### A. Status binding (registry row ↔ FreshService status id)
- `ticket_status_definitions` gains `freshservice_status_id` (and `fs_detected_at`). Migration
  `20260923230000_status_fs_binding` (additive).
- **Status choice sync:** alongside the 6-hourly ticket-type sync, Ticket Pulse reads FreshService's status
  choices (`GET /ticket_form_fields`) per workspace:
  - A FreshService status beyond Open/Pending/Resolved/Closed binds to the registry row with the same name
    (case-insensitive), so IT's existing "Pending Response" binds to 6.
  - If no row matches, one is created with FreshService's label in title case ("Pending response" → "Pending
    Response"), with base Pending unless the name says otherwise, but **only where the workspace's tickets actually
    use that status**. FreshService offers "Pending response" in every workspace, but it's IT's process (Vahid,
    23 Sep). On 23 Sep: IT binds its existing row; Accounting gets one (2 tickets use it); H&S, Field Equipment and
    Project Accounting get nothing. If a ticket there later reaches that status, the row appears at the next status
    sync (≤ 6 h).
- **Both directions use the binding:**
  - FreshService → Ticket Pulse: FS status 6 becomes "Pending Response". This covers the batch sync, the
    single-ticket reconcile, the workflow write-back check and the write-back echo check.
  - Ticket Pulse → FreshService: "Pending Response" sends **6**. This covers FS-born write-back and the
    TP-born mirror.
- Fallbacks if the binding isn't loaded yet: 6 → "Pending Response", 7 → "Waiting on Third Party". Unknown ids
  use the FreshService label from the last choice sync.
- **Settings → Ticket statuses** shows the binding on each row ("FreshService: Pending response (6)").

### B. Latest change wins (Ticket Pulse tickets and their FreshService copy)
The mirror reconcile (every few minutes, the 30 most recently active Open/Pending TP tickets per workspace,
plus TP tickets closed in the last 3 days so a reopen in FreshService is seen) compares status and agent. On a
difference it reads the FreshService activity feed (one call, only when they differ):

- The newest **"set Status as X"** / **"set Agent as Y"** by anyone **other than "Ticket Pulse"** (our own
  write-backs) is FreshService's change. If it's **newer** than Ticket Pulse's last status/assign change, Ticket
  Pulse adopts it:
  - The ticket takes the status or agent, with lifecycle events, assignment episodes and roll-up as usual.
  - It is **not** written back to FreshService, which already has it.
  - No resolution reason is demanded.
  - The Activity entry reads e.g. "Closed in FreshService by Mehdi Abbaspour".
- If Ticket Pulse's change is newer, or no human FreshService change is found, Ticket Pulse keeps its value,
  records the conflict (as today), and re-queues its own value to the copy.
- **A deleted FreshService copy deletes the Ticket Pulse ticket too** (Vahid, 23 Sep, mirroring how a Ticket
  Pulse delete already removes the copy). It's a soft delete: status Deleted, kept under the Deleted view with
  its history. Activity reads "Deleted in FreshService by <name>". Deleted/Spam Ticket Pulse tickets are never
  revived by a FreshService change.
- An agent is adopted only if the FreshService agent maps to a technician in the workspace.

### C. Guard against duplicate requester emails
Turning on a Ticket Pulse workflow that emails requesters about silence (`ticket.requester_silent_for`) in a
workspace whose FreshService copy has a bound Pending Response status returns a **warning**: "FreshService
already sends pending-response reminders for this workspace — requesters would get both." It doesn't block.

### D. One-off repair (`backend/scripts/fix-pending-response-status.mjs`, dry run by default)
1. Runs the status choice sync for workspaces 1–5 (creates or binds the Pending Response rows).
2. Checks every FS-born ticket labelled "Waiting on Customer" / "Waiting on Third Party" against FreshService:
   - still 6 → relabelled "Pending Response";
   - anything else → takes FreshService's real status, which fixes #222020-style drift.

## Test on one ticket before relying on it
1. Pick an IT FreshService ticket. Set **Pending Response** in Ticket Pulse. FreshService should show
   **Pending response** within seconds, and Ticket Pulse should still say Pending Response after two sync cycles.
2. Set a FreshService ticket to Pending response in FreshService. Ticket Pulse should show **Pending Response**
   (not "Waiting on Customer") after the next sync.
3. Close a Ticket Pulse ticket's copy in FreshService. Within one reconcile pass Ticket Pulse should show
   Closed, with "Closed in FreshService by <you>" in Activity.
4. Change a Ticket Pulse ticket's status in Ticket Pulse. The FreshService copy follows, and nothing flips back.
