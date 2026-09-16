# MEGA 09-15 — QA package "Features Request - 09-15"

Source: `qa/09-15 Package/Features Request -09-15 2.docx` (8 items, 8 screenshots).
Workspaces under test: **ws1 IT** (items 2, 3) and **ws5 Project Accounting** (items 1, 4, 5, 6, 7); item 8 is IT approvals.
Tester: Susan Xu (QA), with Alvina Ho, Mo Shahidullah, Alexa Faerber. All root causes below were
established against **production data** on 15 Sep 2026, not inferred.

Status legend: ☐ todo · ☑ done · ❓ needs Vahid/QA · ⛔ no code change (report only) · 📐 plan only

---

## Executive summary — what QA actually found

| # | QA said | Verdict | Root cause (one line) |
|---|---------|---------|------------------------|
| 1 | Basic-access user sees AI suggestions; want a per-workspace switch | **Real, by design so far** | `canSeeAi = Boolean(user)` (QA 08-19 #2 decided *everyone* sees the chip) and the API sends the `ai` block to everyone. No switch exists. |
| 2 | Split did not carry messages/attachments | **Real gap** | The parent had **no messages** yet (0 copied is correct); its 3 PDFs hang off the **description**, and split only moves attachments tied to *selected messages*. The description itself is not carried either. |
| 3 | Basic access cannot Split / Merge | **Real** | "Basic access" = technician with no workspace grant → actor `kind: 'agent'` → both buttons are hidden by `kind !== 'agent'`. The API has no such gate. |
| 4 | TP-1516 (A-code) left Uncategorized | **Real — two causes** | (a) The after-hours run was **skipped at claim** ("Ticket already assigned", Alvina picked it up 12 s after creation) and categorisation rides on that run; (b) all four PA categories have **no description**, so the model has nothing to reason with even when it runs. |
| 5 | Power Apps reopened TP-1526, then a "mirror conflict" closed it; reopen e-mail came before update e-mails | **Real race** | The on-open reconcile pulls a FreshService **closure** back to TP; it ran 21 s after the reopen, while the mirror push (queued behind a busy FS queue) had not yet reopened the FS copy. E-mail order is by design: reopen fires immediately, field changes coalesce for 3 min. |
| 6 | Forward-created ticket tagged "Requester replied" | **Real** | The forwarded original is stored as an `original_email` entry with `incoming: true`; the awaiting-reply query treats *any* latest incoming entry as a reply, including the ticket's own opening message. |
| 7 | Reply e-mail had no ticket description | **Real gap** | The reply quotes the **last inbound message**. TP-1506 came from Power Apps (no inbound e-mail), so there was nothing to quote and the description is never used as a fallback. |
| 8 | Read-only people cannot be approval managers; want tiered approvals | **Real (picker) + 📐 plan** | The manager picker lists **technicians** only (`meta.technicians`); read-only members are not technicians and directory search is admin-only. Deciding is already allowed for anyone addressed (v3.8.38). Tiered approvals = design, not built this round. |

---

## Item 1 — AI suggestions visible to basic-access members (ws5)

**QA:** Alexa (Basic access) sees "SUGGESTED · 82%" chips. Wants Basic users to see only "Unassigned",
with a **per-workspace** switch.

### Root cause
`frontend/src/pages/Tickets.jsx:205` — `const canSeeAi = Boolean(user);` (decided in QA 08-19 #2:
"every signed-in member may SEE the pending AI suggestion; act is reviewer-only"). The backend attaches
the `ai` block to every row (`ticketService.listTickets` → `aiByTicket`) regardless of who asks.
"Basic access" (MembersPanel) = technician profile with no workspace grant → `req.ticketActor.kind === 'agent'`.

### Fix — a workspace switch, enforced on the server
- ☐ `assignment_config.ai_suggestions_for_basic` BOOLEAN NOT NULL DEFAULT true (migration
  `20260915010000_qa_0915`). Default **on** = today's behaviour everywhere; PA turns it off.
- ☐ `assignment.routes.js` whitelist + `getConfig` (already returns all columns).
- ☐ `ticketService.listTickets(workspaceId, query, { actor })`: when the actor is `kind: 'agent'` **or**
  `workspaceRole: 'readonly'` and the switch is off, rows carry `ai: null` (and `aiBypass: null`).
  Route passes `req.ticketActor`. Server-side so the data never reaches the browser.
- ☐ `getMeta` exposes `aiSuggestionsForBasic`; `Tickets.jsx` gates the chip the same way
  (`canSeeAi = canReview || meta.aiSuggestionsForBasic !== false`) so the row falls through to the
  normal "Unassigned" rendering.
- ☐ Toggle in **Assignment Review → Configuration** next to "Auto-categorize": *Show AI assignment
  suggestions to basic-access and read-only members*. Reviewers/admins always see them.
- ☐ Tests: list route strips `ai` for an agent when off / keeps for reviewer / keeps for everyone when on.

---

## Item 2 — Split: messages and attachments did not carry over (TP-1517 → TP-1519)

**QA:** ticked "Move attachments and messages", saw neither on the child.

### Root cause (production)
`ticket_activities` for the split: `{copied: 0, attachmentsMoved: 0}`. At 11:26 AM TP-1517 had **no
conversation messages** — its Conversation tab showed 2 because both are the split notes themselves —
so "0 copied" is correct. Its three PDFs (`BGC_AdminHub_Pilot_Checks.pdf`, …) have
`thread_entry_id = NULL`: they belong to the **description**, and `ticketSplitService` only moves
attachments tied to the *selected messages* ("ticket-level attachments stay on the parent — we cannot
know which issue they belong to"). The child's description was the placeholder "Split out of TP-1517".

### Fix — carry the description and its attachments as **copies**
- ☐ New option `includeDescription` (default **on**): the child's description becomes the parent's
  description (quoted under a "From TP-1517" heading) unless the agent typed their own, and every
  **description-level** attachment is **copied** (new blob, new row; blob names are unique so rows
  cannot share one) to the child. The parent keeps everything — a split never removes evidence.
- ☐ `attachmentService.copyToTicket(attachment, { ticketId, threadEntryId })` — download + upload
  under the child's prefix; FS-ingested rows fetch bytes first (same path as download).
- ☐ Modal: rename the existing option to "Move attachments on the ticked messages" and add
  "Include the original description and its attachments (copied)". Summary line reports both counts.
- ☐ Tests: split with description attachments → child has N copies, parent untouched; option off → none.

---

## Item 3 — Basic access cannot Split or Merge

**QA:** Mo on Basic could not split; on Reviewer he could. Wants Split **and** Merge for Basic.

### Root cause
`tickets.routes.js:52` — `kind: user.role === 'admin' ? 'admin' : (workspaceRole ? 'member' : 'agent')`.
Basic access = no `workspace_access` row → `agent`. `TicketDetail.jsx:2128` hides Split and
`TicketLinksCard canMerge={meta?.actor?.kind !== 'agent'}` hides Merge for `agent`. The split/merge
routes themselves have **no role gate** — the restriction was UI-only, inherited from "agents only see
their own queue".

### Fix
- ☐ Show Split and Merge for `agent` actors (keep `ticketingOn` and the FS-born rules as they are).
  Delete stays reviewer/admin.
- ☐ Tests: TicketDetail renders Split and the merge option for an agent actor.

---

## Item 4 — TP-1516 "A-Code Setup Template" stayed Uncategorized

**QA (with Vahid's note):** should be detected by the AI, not hard-coded; give users a way to steer it.

### Root cause (production)
1. Run **24906** (`app_native`, queued 15:54:47 "Outside business hours", claimed 16:00:56) ended
   `skipped_stale` — **"Ticket already assigned to a technician"**: Alvina assigned it at 15:54:58, twelve
   seconds after creation. Categorisation only happens inside a run, so nothing classified it.
   The pipeline already has a **Classification-only mode** for assigned tickets — but the *claim* step
   discards the run instead of switching to it.
2. `competency_categories` for ws5: **all four categories have `description = NULL`**. The model is
   handed names only ("Internal Proposals", "Project Setup", "Proposal Setup", "Research & Development")
   — "A-code" appears nowhere. No prompt can guess that.

### Fix
- ☐ **Claim-time downgrade, not skip:** when the only local blocker is "already assigned" and the
  workspace has `autoCategorizeEnabled`, run the queued run as **classification-only** (assignee
  untouched, category/priority/type still assessed). Applies to every workspace with auto-categorise.
- ☐ Tests: queued run + assigned ticket + autoCategorize on → runs classification-only; off → skipped.
- ☐ **No hard-coding.** The steering surface already exists: **Assignment Review → Categories →
  edit → Description** is fed to the model verbatim (`get_ticket_categories` returns descriptions).
  The PDF gives PA a ready-to-paste description for each of the four categories, including the
  "A-code" vocabulary, and shows where to paste it. ❓ QA/PA paste and adjust; nothing is written to prod
  by us.
- ☐ Categories page: add a hint under the description field — "The AI reads this when it categorises
  a ticket. Name the words requesters actually use (e.g. 'A-code', 'proposal number')."

---

## Item 5 — TP-1526: reopen from Power Apps, then "FreshService changed status Closed"

**QA:** why did a mirror conflict close it? And the reopen e-mail arrived before the update e-mails.

### Root cause (production timeline, UTC)
```
21:01:37  Power Apps  status Open → Closed            mirror job 1463 → FS copy Closed (21:03)
21:24:32  Power Apps  status Closed → Open  (reopen)  mirror job 1475 queued
21:24:33  Power Apps  subject + 6 custom fields
21:24:53  on-open reconcile (someone had the ticket open): FS copy still 5=Closed vs TP Open
          → mirror_conflict recorded, then "FreshService changed status Closed"  ← pulled FS closure back
21:27:12  mirror job 1475 finally ran (FS queue was busy) — but TP was already Closed again
```
`syncService.reconcileSingleTicket` ("TP-born mirrored tickets: pull a FreshService-side CLOSURE back so
the two sides don't diverge") trusts FS's terminal status whenever TP is open — even when TP's own
change is **newer** than FS's copy and a mirror push is **still queued**. A 2-minute mirror delay turned
a legitimate reopen into a re-close.

### Fix
- ☐ In the closure pull-back: **skip** when (a) a `mirror_jobs` row for the ticket is `pending`/
  `processing` (TP has changes FS has not seen), or (b) the FS copy's `updated_at` is older than TP's
  own `updated_at` (TP is newer). Record the conflict as today, but do not act on it.
- ☐ Tests: pending job → untouched; FS older than TP → untouched; FS newer + terminal → mirrored back.

### E-mail order (⛔ explained, one small improvement offered)
Power Apps sends **two calls**: the status change (fires `ticket.reopened` at once) and the field
update (fires `ticket.fields_updated`, which by design **coalesces for 3 minutes** so an agent editing
six fields sends one e-mail, not six). So the reopen e-mail always wins. Two options for QA:
1. Power Apps sends the field changes **first**, then the status (one PATCH can carry both) — no code.
2. ❓ We hold the reopen e-mail for ~60 s and merge it with field changes in the same window
   ("Reopened and updated") — product call, not built this round.

---

## Item 6 — Forwarded e-mail creates a ticket tagged "Requester replied"

### Root cause (production)
TP-1516 has exactly one entry: the forwarded original (`original_email`, `incoming: true`, author
requester, dated 14 Sep 04:38 — the *original* send time). `_awaitingReplyTicketIds` /
`_lastPublicEntryIncoming` flag a ticket when its **latest public entry** is incoming — they never ask
whether that entry is the ticket's **own opening message**. Any e-mail-born ticket with no reply yet is
therefore "Requester replied" instead of "New"; forwards make it obvious because the tag shows before
anyone touches the ticket.

### Fix
- ☐ Both queries exclude `event_type = 'original_email'` (the opening message is not a reply).
  `deriveQueueState` then falls through to `new` for an unassigned ticket, `—` for an assigned one.
- ☐ Tests: forward-created ticket → `new`; ticket with a genuine later requester reply → `requester_responded`.

---

## Item 7 — Reply e-mail carried only the agent's text (TP-1506)

### Root cause (production)
`_emailRequesterReply` appends `_lastInboundQuote` — the last **inbound e-mail**. TP-1506 was created
by Power Apps (source API): no inbound e-mail exists, so the quote is `null` and the requester receives
Alvina's one line with no context. The earlier fix (RL-8) covered e-mail-born tickets only.

### Fix
- ☐ `_lastInboundQuote`: when no quotable inbound entry exists, quote the **ticket description** as
  the "original request" block (same sanitiser, same 20 KB cap, same `> ` text twin), attributed to the
  requester at the ticket's creation time. E-mail-born tickets are unchanged (their opening message is
  already the first quotable entry).
- ☐ Tests: API-born ticket → description quoted; e-mail-born → inbound quoted, description not duplicated.

---

## Item 8 — Read-only people as approval managers · tiered approvals

### Root cause
`ApprovalCategoriesPanel` picker = `meta.technicians` (+ directory search, which is **admin-only** —
Susan is a reviewer in IT). Neville is read-only, not a technician → not offered; typing his full e-mail
works but is not discoverable. Deciding is already allowed for anyone addressed (read-only grant text:
"except deciding approvals addressed to them").

### Fix (built)
- ☐ `getMeta` adds `members`: every `workspace_access` row (email, role, name from the users table),
  so the picker offers **read-only and reviewer members** alongside technicians, labelled by role.
- ☐ Picker copy: "Search members and technicians, or type an e-mail address."
- ☐ Tests: panel offers a read-only member; category saves with that e-mail.

### Tiered approvals — 📐 plan only (QA: "comprehensive change, plan carefully")
Design in `plans/TIERED_APPROVALS_PLAN.md`: a category gets **tiers** (Tier 1: Vahid; Tier 2:
Neville). A request goes to Tier 1 only. A Tier-1 manager can *Approve*, *Reject*, *Ask a question*, or
**Escalate to Tier 2** (with a note). Escalation re-addresses the same request (same token page, new
e-mail) to Tier 2, records the hand-off in the clarification log, and keeps Tier 1 informed. No parallel
fan-out, no auto-escalation timers in v1. Schema: `approval_categories.tiers JSONB` alongside
`managerEmails` (backward compatible: no tiers = today's any-one-approves). Not built this round.

---

## Cross-cutting
- Items 5 and 6 are the second and third time this week that the *opening* state of a ticket was
  misread by a rule written for later states. Both fixes are small and each has a production example.
- Item 4's claim-time downgrade also benefits IT: every after-hours queued run that an agent picks up
  first currently loses its categorisation too.

## Execution order
1. Backend: migration + item 1 gate; item 4 claim downgrade; item 5 reconcile guard; item 6 queries;
   item 7 description quote; item 8 members in meta; item 2 copy helper + split option. Tests for each.
2. Frontend: item 1 toggle + chip gate; item 3 buttons; item 2 modal option; item 8 picker; item 4 hint.
3. Full suites, build, dark lint. Release **v3.8.89-preview** (backend + frontend).
4. Screenshots on the local app (dev login), response PDF `qa/Features Request - 09-15 - Response.pdf`,
   copy in `qa/09-15 Package/`.

## Deliverables
- `plans/MEGA_0915_PLAN.md` (this file), `plans/TIERED_APPROVALS_PLAN.md`
- Release v3.8.89-preview (PR), changelog entries
- `qa/Features Request - 09-15 - Response.pdf` (+ copy next to the request)
