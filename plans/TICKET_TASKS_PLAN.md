# Ticket Tasks — Implementation Plan (QA 07-16 #3)

> Status: **PLAN / AWAITING GO-AHEAD**. This is the comprehensive design QA asked
> for ("plan this comprehensively and think about all aspects"). No code shipped
> yet beyond the response PDF. Parent/child tickets are a **separate** doc
> ([PARENT_CHILD_TICKETS_OPTIONS.md](./PARENT_CHILD_TICKETS_OPTIONS.md), QA 07-16 #4).

## What QA asked for

A **Tasks** tab on a ticket for assigning discrete tasks to that ticket. Each
task can be **assigned to a specific agent** and **notify** that agent. Must work
for both **TP-born** tickets (with FreshService write-back) and **FS-born**
tickets.

## What FreshService gives us (probed 2026-07-16, prod ws1)

FreshService has a first-class **Ticket Tasks API**:

- `GET /api/v2/tickets/{id}/tasks` → `{ tasks: [...] }` (returns `200 {tasks:[]}` on our real ticket)
- `POST /api/v2/tickets/{id}/tasks` — create
- `PUT /api/v2/tickets/{id}/tasks/{task_id}` — update
- `DELETE /api/v2/tickets/{id}/tasks/{task_id}` — delete

FS task fields: `id`, `agent_id`, `status` (1 Open / 2 In Progress / 3 Completed),
`due_date`, `notify_before` (seconds), `title`, `description`, `group_id`,
`created_at`, `updated_at`. **`agent_id` is the assignee**, and FS sends the
assignee a task notification email natively when the task is created/assigned.

This means the FS-born half is a thin wrapper over these four endpoints — FS owns
the data and the notification. The TP-born half is where we own everything.

## Data model (TP-owned)

New table `ticket_tasks` (Prisma):

| column | type | notes |
|---|---|---|
| `id` | Int PK | |
| `workspaceId` | Int | |
| `ticketId` | Int FK → tickets | the ticket this task hangs off |
| `title` | String | required |
| `description` | Text? | |
| `status` | String | `open` \| `in_progress` \| `done` (maps to FS 1/2/3) |
| `assignedAgentId` | Int? FK → technicians | TP or FS agent (see agent model) |
| `dueAt` | DateTime? | |
| `notifyAgent` | Boolean @default(true) | whether to email the assignee |
| `notifiedAt` | DateTime? | idempotency guard for the notification |
| `origin` | String | `ticketpulse` (born here) \| `freshservice` (synced) |
| `fsTaskId` | BigInt? | FS task id when mirrored/synced |
| `sortOrder` | Int @default(0) | manual ordering in the tab |
| `createdBy` / `createdByName` | String? | audit |
| `completedAt` | DateTime? | |
| `createdAt` / `updatedAt` | DateTime | |

Indexes: `(workspaceId, ticketId)`, `(assignedAgentId, status)`, `@@unique([workspaceId, fsTaskId])` (nullable — only mirrored rows).

## Origin-aware behavior (the two halves)

Mirror the ticket dual-origin model exactly, the way replies/status already work:

### TP-born ticket (`origin='ticketpulse'`)
- Tasks are **TP-owned**. Full CRUD in-app, no FS round-trip required for the task
  to exist.
- **Write-back to the FS fallback mirror**: TP-born tickets already get a
  `freshserviceTicketId` when mirrored. When that mirror exists and
  `typeWritebackEnabled`-style task-writeback is on, push each task to
  `POST /tickets/{fsMirrorId}/tasks` and store `fsTaskId`. This keeps the FS copy
  in sync so a coordinator watching FreshService sees the same tasks. Gate behind
  a new `taskWritebackEnabled` flag on the workspace/AssignmentConfig (default on
  where the ticket is mirrored), matching the existing writeback-flag pattern.
- **Notification** is TP-owned: when `notifyAgent` and the assignee is a TP or
  local agent, send via the same SendGrid/Graph path approvals use (reuse
  `_emailApprover`'s transport helper — factor it into a small shared
  `sendAgentTaskEmail`). Set `notifiedAt` to prevent re-sends.

### FS-born ticket (`origin='freshservice'`)
- Tasks are **FS-owned**. The tab reads/writes straight through the FS Tasks API
  using the **interactive client** (`mirrorService.getInteractiveClient` — high
  priority, 15s budget; never the low-priority sync client, per [[fs-interactive-lane]]).
- Create/update/delete proxy to `POST/PUT/DELETE /tickets/{fsId}/tasks`. FS sends
  the assignee's notification natively (`notify_before` / assignment email), so we
  **don't** double-send — `notifyAgent` maps to FS's own notify behavior.
- We still cache a shadow `ticket_tasks` row (`origin='freshservice'`, `fsTaskId`
  set) so the tab renders without a live FS call every open, and the ingest/sync
  sweep reconciles FS-side task changes into it (same pattern as thread entries).

### Agent model note
Assignee is a `technicianId`. For FS write-back we need the agent's `fsAgentId`
(already on the technician row for FS-synced agents). **Local/non-FS agents**
([[local-agents-internal-groups]]) have no `fsAgentId` — a task assigned to a
local agent can't be written to FS. Rule (server-enforced, matches local-agents =
TP-born-only): task write-back to FS only when the assignee has an `fsAgentId`;
otherwise the task stays TP-only with an inline "not synced to FreshService"
note, exactly like the existing local-agent affordances.

## API surface (backend)

`ticketTaskService.js`:
- `list(ticketId, workspaceId)` — origin-aware read (TP: DB; FS: interactive client + cache)
- `create(ticketId, workspaceId, { title, description, assignedAgentId, dueAt, notifyAgent }, actor)`
- `update(taskId, workspaceId, patch, actor)` — incl. status transitions, reassignment
- `remove(taskId, workspaceId, actor)`
- `_writeBackToFs(task)` / `_syncFromFs(...)` internals

Routes under the existing tickets router (agent-aware, `req.ticketActor`):
- `GET /tickets/:id/tasks`
- `POST /tickets/:id/tasks`
- `PATCH /tickets/:id/tasks/:taskId`
- `DELETE /tickets/:id/tasks/:taskId`

Migration: additive `ticket_tasks` table (apply to dev + prod before merge, per
the standing recipe).

## Frontend

- New **Tasks** tab on `TicketDetail.jsx` (count badge = open task count), sitting
  alongside Conversation / Approvals / AI & Routing / History.
- Task list: title, status chip, assignee avatar (AssigneePicker reuse),
  due-date, notify toggle, complete/reopen, add/edit/delete.
- Origin banner reuse: on FS-born tickets show the "FreshService owns this" note
  and that FS sends the notification; on TP-born show full editing + the
  synced/not-synced-to-FS indicator per task.
- Peek panel: read-only task count + list (no editing in the peek, matching how
  approvals render there).

## Notifications

- TP path: reuse the approval email transport (SendGrid as `ticketpulse@`, Graph
  send-as fallback) — factor `_emailApprover`'s send helper into a shared util so
  tasks, approvals, and clarifications share one tested path.
- FS path: rely on FS's native task-assignment email; expose the toggle but map it
  to FS's notify semantics rather than sending our own (avoids double emails).

## Open questions for the team

1. **Task statuses** — mirror FS's 3 (Open / In Progress / Completed) exactly, or
   add a TP-only "Blocked"? FS won't round-trip a 4th status.
2. **Due-date + SLA** — should a task due-date feed the ticket's overdue signal, or
   stay independent? (Recommend independent for v1.)
3. **Group assignment** — FS tasks support `group_id`. Assign tasks to a group
   instead of/as well as an agent? (Defer to v2 unless needed.)
4. **Task-writeback default** — on for all mirrored TP-born tickets, or opt-in per
   workspace like type-writeback? (Recommend on where a mirror exists.)

## Rollout

Additive and behind a `ticketTasksEnabled` workspace flag (like native ticketing).
Ship TP-born + notifications first (fully in our control), then the FS-born proxy
once the interactive-client task calls are validated against a real FS ticket.
