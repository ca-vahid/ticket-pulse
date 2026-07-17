# Parent / Child Tickets — Options (QA 07-16 #4)

> Status: **OPTIONS ONLY — DO NOT IMPLEMENT.** QA explicitly said: "If this is
> not possible, provide other options but don't implement workaround until we
> discuss." This document lays out what FreshService actually supports and three
> implementation paths with trade-offs, for a team decision.

## What QA asked for

- Mark a ticket as a **child** and associate it with a **parent** ticket.
- Child tickets can be **assigned to different agents**.
- FreshService has this natively → they want **two-way write-back** (FS-native and
  TP-native, both directions). If not possible, alternatives.

## What FreshService actually supports (probed 2026-07-16, prod ws1)

FreshService's "linking" is **plan- and type-gated**, and the public API surface
is thin:

- **Parent-child tickets** in FreshService are a feature of higher plans and are
  driven mostly through the UI and *service-request items* (a service item with
  child tasks/tickets), **not** a general "make ticket B a child of ticket A" API
  you can call on arbitrary tickets.
- Our probes returned **404** for `/tickets/{id}/associated_tickets`,
  `/tickets/{id}/related_tickets`, `/tickets/{id}/child_tickets`, and
  `/tickets/{id}/parent`. The ticket object we get back has **no `parent_id` /
  `child_ids` fields populated**, and `?include=related_tickets` returns an empty
  `related_tickets: {}`.
- The **ticket-form fields** list contains **no** parent/child/association field
  (probe: `HAS_PARENT_FIELD none`).
- FreshService *does* expose `tasks_dependency_type` on the ticket object and a
  full **Tasks API** (see [TICKET_TASKS_PLAN.md](./TICKET_TASKS_PLAN.md)) — so
  "sub-work with its own assignee" maps cleanly onto **tasks**, but **tasks are
  not tickets** (no independent status workflow, no requester, no CSAT).

**Bottom line:** true two-way parent/child *ticket* sync with FreshService is
**not reliably achievable through the API** on our instance/plan. The building
blocks FS exposes are (a) tasks (assignable sub-work, API-complete) and (b) UI-only
associations we can't read or write programmatically.

## Options

### Option A — TP-native parent/child, no FS ticket-link sync (recommended for v1)
Build parent/child entirely in Ticket Pulse using the **`ticket_links` table we
already have** (it already stores `merged_into`; add a `child_of` kind).

- A ticket can have one parent (`child_of` link) and many children.
- Children are **real tickets** — own status, own assignee, own everything. This
  satisfies "assign child tickets to different agents" fully.
- Parent detail shows a Children card; child shows a "Child of TP-####/#FS" banner.
- **FS write-back**: instead of a native FS parent-link (unavailable), drop a
  **note + a stable marker** on both FS mirrors ("Child of #12345 in Ticket
  Pulse") so a coordinator in FreshService sees the relationship, even though FS
  won't render it as a native hierarchy. One-way, cosmetic, honest about the
  limitation.
- **Pro:** fully in our control, works for every ticket regardless of origin,
  ships fast, no plan dependency. **Con:** the link is TP-authoritative; FS shows
  it as a note, not a native parent field, and FS-side changes to the
  relationship don't flow back (there's no FS field to watch).

### Option B — Model child work as FreshService **Tasks**
Use the Tasks API (Option in TICKET_TASKS_PLAN.md) for the sub-work, with
per-task assignees.

- **Pro:** genuinely two-way with FS (tasks are a real, writable FS API), native
  FS assignee + notification. **Con:** tasks aren't tickets — no independent
  status lifecycle, requester, or CSAT — so this only satisfies QA if what they
  really want is "assignable sub-work," not "independent child tickets."

### Option C — Hybrid
Ship **Option A** (TP parent/child of real tickets) for the ticket-hierarchy need,
**and** ship Tasks (Option B / the Tasks plan) for lightweight assignable sub-work.
Most helpdesks want both and they're not the same feature. This is the most
complete answer but the largest scope.

## Recommendation to discuss

- If the need is **"break a request into independently-worked, independently-tracked
  tickets with different owners"** → **Option A** (TP-native, real child tickets;
  FS gets a cosmetic note). Fastest path that actually meets the assignee
  requirement.
- If the need is **"a checklist of assignable sub-steps on one ticket"** →
  **Tasks** (the separate plan), which *is* truly two-way with FS.
- True native FS parent/child *ticket* sync is **not on the table** with the
  current API/plan — confirm with FreshService whether a higher plan exposes a
  parent-link API before committing to any two-way ticket-hierarchy sync.

**No implementation until the team picks a direction.**
