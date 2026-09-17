# MEGA 09-16 — QA package "Features Request - 09-16"

Source: `qa/9-16 Package/Features Request - 09-16.docx` (5 items, 3 screenshots).
Workspaces under test: **ws4 Field Equipment Team** (item 1), **ws5 Project Accounting** (item 2 — Power Apps),
**ws1 IT** (items 3–5). Tester: Susan Xu (QA). Every root cause below was established against **production data**
on 16 Sep 2026 (tickets, activities, pipeline runs, API request log), not inferred from the screenshots.

Status legend: ☐ todo · ☑ done · ❓ needs Vahid/QA · ⛔ no code change (report only) · 📐 plan only

---

## Executive summary — what QA actually found

| # | QA said | Verdict | Root cause (one line) |
|---|---------|---------|------------------------|
| 1 | Field Equipment team starts Friday — set up their inbox (reply, receive, forward) | **Configuration, not code** ❓ | ws4 has native ticketing ON and **no mailbox connection** (`mailbox_connections` has ws5 `patickets@` and ws1 `ticketpulse@` only). The whole pipeline is built; it needs a shared mailbox address and a Settings → Ticket Mailboxes row. |
| 2 | Power Apps needs reopen + fields + note in ONE atomic call | **Already exists, plus a small build** | `POST /api/v1/tickets` with `externalRef` (ws5 derives it from `power_app_record_id`) *is* the atomic resubmission: reopen + fields + custom fields + ONE diff note + ONE coalesced event, `resubmitted:true`. The flow still does `PATCH` + `POST …/notes` pairs (14 pairs in the last 48 h). Build: a caller-supplied `note` on that POST and an `addNote` on PATCH. |
| 3 | On-leave notifications should not be dismissed as noise | **Not noise here — closed by FreshService** + build | All 15 "On Leave Notification" tickets in 60 days have `is_noise = false` (`noise_suppress_reason = person_requester` — the sender veto held). Each was **Resolved 30 s–4 min after arrival and Closed by a FreshService automation** (activities: actor `freshservice_sync`, "Status changed from Resolved to Closed"). The Assignment page shows the AI's *verdict* ("Noise"), not the outcome. |
| 4 | Redesign the Approvals page; add filters and professional features | **Build** | `/approvals` is a plain list with five count tiles; the API filters by status/category only; no search, approver, requester, dates, sort or export. |
| 5 | Column drag-and-drop is jerky and gives no insertion preview | **Build** | The Columns menu uses raw HTML5 drag events with no drop indicator — the only feedback is the dragged row fading to 40 %. |

---

## Item 1 — Field Equipment Team inbox (ws4)

**QA:** the team goes live Friday 18 Sep; they need to reply to requesters, receive replies and forward e-mails.

### What production says
- `workspaces`: id 4 "Field Equipment Team", `is_active = true`, `native_ticketing_enabled = true`.
- `mailbox_connections`: two rows — ws5 `patickets@bgcengineering.ca` (ingest, hold_unmatched, agent_cc_intake) and ws1 `ticketpulse@bgcengineering.ca`. **Nothing for ws4.**
- `workspace_email_identities`: only ws5 ("Project Accounting", reply_uses_agent_name).
- The ingest poller, Graph webhooks, reply loop, agent-forward intake and the Also-for list are all live for ws5 — the same code serves any workspace with a row.

### What has to happen (☐ = Vahid / IT, nothing to build)
- ☐ **Shared mailbox** in Exchange for the team (e.g. `fieldequipment@bgcengineering.ca`); if the Graph app is restricted by an Application Access Policy, add the mailbox to the policy (memory `mega-0901-train`: Mail.ReadWrite is granted at app level).
- ☐ Switch to **Field Equipment Team** → Settings → **Ticket Mailboxes** → address, mode **Both**, route new tickets to the team's group, default ticket type, **Test** (three checks: read, send, webhook) → Save. Set **New-ticket policy** (hold unmatched senders vs. create) and leave **agent Cc intake** on so forwards from agents file correctly.
- ☐ Settings → **E-mail identity** for ws4: From-name "Field Equipment" (+ "reply uses agent name" if wanted).
- ☐ Enable **Reopen on requester reply** in Mail Workflows for ws4 (it is a template; disabled by default).
- ☐ Tell the team: forward any e-mail *to the mailbox* to file it as a ticket under the original sender; Cc the mailbox on a thread to attach it.
- ⛔ Report: the PDF gives this as a 20-minute checklist. Ticket Pulse needs no release for it.

---

## Item 2 — One atomic call for "resubmitted" records (Power Apps / Power Automate)

**QA:** PATCH + POST /notes creates two events, two e-mails (in an odd order), partial-failure risk and a split audit trail; proposes `PATCH /tickets/{id}` with `addNote`.

### What production says
- `api_request_logs` (7 days, `/api/v1/tickets*`): every hour with a `PATCH /tickets/{id}` also has an equal count of `POST /tickets/{id}/notes` (e.g. 16 Sep 04:00 UTC: 6 + 6; 17 Sep 04:00: 4 + 4). That is the two-call pattern QA describes.
- The **resubmission upsert** already does the whole thing in one call: `POST /api/v1/tickets` with the same `externalRef` (ws5 derives it from the `power_app_record_id` custom field, so the Power App need not even send it) → `ticketResubmissionService.applyResubmission`: reopens Resolved → Open, applies subject/priority/type/category/group/ccEmails/description/custom fields with `emitEvent:false`, writes **one** system note with a before/after table, one audit row, then emits **one** `ticket.fields_updated` (with `reopened`) so the coalesced e-mail reads the final row. Response `200 { resubmitted:true, meta.changedFields, meta.reopened }`. Closed tickets are never silently reopened (a linked new ticket is created instead; `reopenOnResubmit:false` opts out).

### Fix — make the one-call path complete, and document it for the flow
- ☐ `POST /tickets` (resubmission branch) and `PATCH /tickets/:id` accept **`addNote`** — a string, or `{ body, bodyHtml?, stage?, agent? }`. Also accept the alias `note`.
  - Resubmission: the caller's text is appended to the diff note (one note, one `note_added`), or written as its own private note when nothing else changed.
  - PATCH: the note is added after the field/status writes, in the same request, and the response carries `note: { entryId }`.
- ☐ OpenAPI: `UpdateTicket.addNote`, `CreateTicket.addNote`; the resubmission section explains the one-call pattern.
- ☐ Tests: PATCH with `addNote` calls `addPrivateNote` once after the update; resubmission with `addNote` appends the text; string and object forms; scope stays `tickets:write` (a note riding a ticket write is part of the write).
- ⛔ Report: recommend the flow switch to the single `POST /tickets` (no `PATCH`, no `/notes` call); if the flow must PATCH, `addNote` is there.

---

## Item 3 — "On Leave Notification" tickets

**QA:** these should not be dismissed as noise. What is the best way?

### What production says (ws1, 60 days)
- 15 tickets "On Leave Notification: <name>" from `humanresources@bgcengineering.ca` (requester "Human Resources Team"). **All 15 have `is_noise = false`**; `noise_suppress_reason = person_requester` — the sender-protection veto (v3.8.44) held every time. Only #241450 was flagged noise, by a person.
- The AI run on #242554 (25016): `decision = noise_dismissed`, `non_actionable = true`, reason "Automated HR leave-record notification with no IT service request embedded … matches 100+ prior identical tickets closed without action". That verdict is what the Assignment page prints as **Noise**. It did not act — the veto stops it.
- Who closes them: activities show `status_changed` Open → Resolved → Closed by **FreshService** (`actorKind: freshservice_sync`, e.g. #242554 resolved 04:33:16, closed 04:34:06, created 04:29:53). Same pattern on every one of the 15: resolved 30 s–4 min after arrival, unassigned. That is a **FreshService supervisor/automation rule**, not Ticket Pulse.
- Category is set to `internal_category_id 144` on about half (FS-side) and left null on the rest.

### Fix
- ☐ **Assignment page honesty**: when a run's decision is `noise_dismissed` but the ticket's `isNoise` is false, the Decision pill reads **"Noise verdict · kept"** with a tooltip ("The AI called this noise; the sender is protected so the ticket stayed a normal ticket"). History rows carry `ticket.isNoise` + `noiseSuppressReason`.
- ☐ **Workflow template "HR leave notice — keep and file"** (installable, disabled until enabled): trigger `ticket.created`; conditions requester e-mail is `humanresources@bgcengineering.ca` **and** subject contains "On Leave Notification"; actions `update_ticket` (priority Low, add tag `leave-notice`, category name configurable) + `add_note` ("Leave notice — keep open until accounts, licences and equipment are handled; dates are in the description."). Ships with a new `leave-notice` pictogram.
- ❓ **Your call (Vahid / IT):** switch off the FreshService rule that auto-resolves these; decide the owning group/category (Onboarding & Offboarding?) so the template can be enabled with the right routing.

---

## Item 4 — Approvals page redesign

**QA:** modern look matching the rest of the site; filtering; professional features.

### Root cause
`frontend/src/pages/ApprovalsInbox.jsx` (303 lines): a plain list; five count tiles double as the only filter; `GET /tickets/approvals/all` accepts `status` and `categoryId` only; no search, no approver/requester/date filters, no sort, no export, no per-row context.

### Build
- ☐ Backend `ticketApprovalService.overview()` + route: `q` (subject / ref / note), `approver`, `requestedBy`, `from`, `to`, `sort` (newest | oldest | status), `limit ≤ 500`; stats stay workspace-wide.
- ☐ Frontend redesign: illustrated hero (new `approval-*` pictograms), stat tiles as filter chips with art, a filter bar (search, category FancySelect, approver, requester, date range, sort), rows as cards with approver photo, amount/tier chips, decision note preview, hover actions; **Export CSV** of the filtered set; empty states. "For you" keeps the composer; both tabs get the same visual language; motion via `animate-popIn`.
- ☐ Tests: overview filters (backend), inbox filter bar + CSV (frontend).

---

## Item 5 — Column drag-and-drop

**QA:** not smooth, hard to see, wants an insertion preview.

### Root cause
`QueueColumnsMenu` (queueColumns.jsx): HTML5 drag events; the only feedback is `opacity-40` on the dragged row; the drop lands on whichever row you release over, with no line showing where.

### Build
- ☐ Track `dropTarget = { key, before }` from the pointer's position within each row; render a 2 px blue insertion line (animated) at that edge; rows shift to make room (`transition-transform`); the dragged row gets a lifted card look; a drop outside the list cancels cleanly. Keyboard: Alt+↑/↓ moves the focused row.
- ☐ Tests: dragOver on the upper half → indicator before the row; drop reorders accordingly; Alt+Arrow reorders.

---

## Cross-cutting
- All frontend work in one release (3.9.20); backend changes (API `addNote`, approvals filters, history `isNoise`, template) ride the same release — no migration.
- Artwork: 8 more gpt-image-2 pictograms (approval-stamp/-waiting/-question/-rejected/-escalate/-forward/-inbox, leave-notice), same flat duotone style, contact-sheet reviewed.

## Execution order
1. Item 2 backend (small, unblocks the Power Apps team) → 2. Item 3 (history flag + template) → 3. Item 5 → 4. Item 4 (largest) → 5. release → 6. PDF + e-mail → 7. 24-hour watch.

## Deliverables
- Release 3.9.20-preview (PR), `plans/MEGA_0916_PLAN.md` (this), `qa/evidence-0916/` (screenshots, report), `qa/Features Request - 09-16 - Response.pdf` (+ copy in the package folder), e-mail to Susan cc Vahid.
