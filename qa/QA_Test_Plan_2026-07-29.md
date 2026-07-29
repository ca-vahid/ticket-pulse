# Ticket Pulse — QA Test Plan (2026-07-29)

**Build under test:** v3.0.79-preview · **Prepared for:** QA team · **From:** Ticket Pulse dev

**Tester:** ________________  **Date:** ____________  **Device / browser:** ________________

This round covers **Features Request 07-27** (4 items) and **07-28** (3 items), plus a
**Suggestions & Improvements** section at the end for the team to assess and respond to.

**Before you start:** hard-refresh once (Ctrl/Cmd-Shift-R) so you're not on a cached bundle.

---

## What changed this build

| # | Reported | Shipped |
|---|----------|---------|
| 07-27 #1 | Team Balance counted Pending tickets as Open (74 "open" that was really 15 open + 59 pending) | Open and Pending are now **separate series** in Workload by Agent; the distribution table gains a **Pending Now** column; load badges use the true combined queue |
| 07-27 #2 | "Should we combine Resolved with Closed?" | **Answered + partially consolidated** — see §2 for the decision and reasoning |
| 07-27 #3 | List vs card view with drag-and-drop columns | New **Board** view: Open / Pending / Closed columns, drag cards to change status |
| 07-27 #4 | Flag tickets from external (non-BGC) senders | Amber **External** badge driven by a per-workspace **Trusted domains** list |
| 07-27 #5 | Noise dismissal changed a Closed ticket to Resolved | An agent's Closed status is now preserved |
| 07-28 #1 | Command palette titles don't match the tabs | Palette, side rail, and page titles now agree: **Analytics · Assignment · Agent Maps** |
| 07-28 #2 | TP-1058 wouldn't mirror ("validation error") | Root cause found & fixed: FreshService made **Department required** on create; mirrors now resolve it automatically |
| 07-28 #3 | "What does Today PT mean?" — redesign the auto-assign panel | Redesigned: explicit date/timezone, **automation rate**, outcome-mix bar, freshness chip |

---

## Fast-pass smoke check (≈8 min)

- ☐ **Board view:** Tickets → the view toggle now shows **Compact / Roomy / Board**; Board shows 3 columns with cards (§3)
- ☐ **Drag-drop:** dragging a TP-born card Open → Pending changes its status (undo toast appears) (§3)
- ☐ **Team Balance:** Workload by Agent has separate **Open now** and **Pending now** bars (§1)
- ☐ **External badge:** after adding your domain in Settings → Ticket Ops → Trusted domains, an outside-sender ticket shows an amber **External** chip (§4)
- ☐ **Mirror:** TP-1058 now shows **Mirrored** (or a new TP-born test ticket mirrors within ~1 min) (§6)
- ☐ **Assignment panel:** the "all caught up" panel shows a real date ("… · Pacific Time · since midnight"), not "TODAY PT" (§7)
- ☐ **Palette:** Ctrl+K — entries read **Analytics**, **Assignment** (person-with-check icon), **Agent Maps** (§5)

**Smoke result:** ☐ Pass   ☐ Fail — Notes: _______________________________________________

---

## 1. Team Balance: Open vs Pending split (07-27 #1)

1. Open **Analytics → Team Balance** for IT.
2. **Workload by Agent**: ✅ four series now — *Assigned*, **Open now**, **Pending now** (violet), *Closed / resolved*. Hover shows exact counts per series.
3. Cross-check one agent with a big pending queue (e.g. Alexey): ✅ "Open now" shows only truly-Open tickets; "Pending now" carries the rest. The two together should equal the old inflated number.
4. **Team-Safe Distribution** table: ✅ new **Pending Now** column next to Open Now; the mobile cards read "N open · M pending".
5. The **20+ in queue (open + pending)** filter and the High/Watch/OK badges now consider open+pending together — ✅ an agent with 5 open + 25 pending is still flagged.
6. Export (CSV/XLSX) from the load-imbalance insight: ✅ includes a **Pending Now** column.

**Result:** ☐ Pass   ☐ Fail — Notes: ___________________________________________________

## 2. Resolved vs Closed — decision (07-27 #2)

**Decision: keep both statuses in the data, consolidate where you look at them.**
Reasons, for the team to weigh in on:

- **FreshService itself distinguishes them** (Resolved = agent finished, awaiting requester confirmation; Closed = final). Sync would keep re-introducing the distinction on every FS-born ticket, and the public status page and audit history rely on the exact value.
- **Every aggregate already merges them** — queue "Resolved" segment, dashboards, analytics "closed" counts, SLA/CSAT logic all treat Resolved+Closed as one terminal bucket. So the redundancy QA felt is mostly in pickers, and pickers are where the distinction is occasionally needed (e.g. filtering to genuinely-Closed).
- **What we consolidated now:** the new Board view has a single **Closed** column containing both, with a small "Resolved" tag on resolved cards.

1. Open the Board view: ✅ resolved and closed tickets share the **Closed** column; resolved ones carry a small emerald **Resolved** tag.
2. ✅ Status filter and Status picker still offer all four statuses (intentional).

**Team response — do you agree with keeping both statuses?** ☐ Agree  ☐ Prefer full merge — Notes: ______________

## 3. Tickets Board view with drag-drop (07-27 #3)

1. **Tickets** page (desktop) → view toggle (top right of the toolbar): ✅ third option **Board**.
2. Switch to Board: ✅ three columns — **Open / Pending / Closed** — with card counts in each header; cards show ref, type, subject, assignee, priority, and SLA chip (Open cards).
3. ✅ The board shows **all statuses** even though the list default is Open+Pending (the Closed column isn't empty if closed tickets exist on the page).
4. **Drag a TP-born card** (TP-#### ref) from Open to Pending: ✅ card moves, an undo toast appears ("TP-#### → Pending"), and the change survives a refresh. Undo works.
5. **Drag an FS-born card** (#123456 ref): ✅ the **FreshService write-back confirm** dialog appears first; confirming syncs, cancelling leaves the ticket untouched.
6. **Read-only cards** (FS-born without an FS id, or TP-born where native ticketing is off) show a small **lock** and refuse to drag.
7. ✅ Single-click on a card still opens the **peek preview**; double-click opens the full ticket.
8. ✅ The Compact and Roomy list views are unchanged; your view choice persists per browser.

**Result:** ☐ Pass   ☐ Fail — Notes: ___________________________________________________

## 4. External-requester flag + Trusted domains (07-27 #4)

1. **Settings → Ticket Ops → Trusted domains** (new card): add `bgcengineering.ca` (typing `@bgcengineering.ca` or a full email also works — it normalizes).
   ✅ The domain chips render; removing one works; **Saved** confirmation appears.
2. Back on **Tickets**: ✅ tickets whose requester email is OUTSIDE the trusted list (e.g. `notifications@app.bamboohr.com`) now show an amber **External** chip next to the subject; internal senders show nothing.
3. ✅ The same badge appears in the **peek preview** header and the **ticket detail** header.
4. Subdomains: a requester at `mail.bgcengineering.ca` is ✅ **not** flagged (subdomains of a trusted domain are trusted).
5. Remove all domains from the list: ✅ badges disappear everywhere (empty list = feature off).
6. This is per-workspace: ✅ setting domains in IT does not affect Accounting.

> Note: the badge means "sender outside your org" — a triage caution, not a malware verdict.

**Result:** ☐ Pass   ☐ Fail — Notes: ___________________________________________________

## 5. Command palette naming (07-28 #1)

1. Press **Ctrl+K** anywhere.
   ✅ Entries read **Analytics** (was "Analytics & Insights"), **Assignment** (was "Assignment Review") with a **person-with-checkmark** icon, **Agent Maps** (was "Visuals").
2. ✅ The left side-rail shows **Agent Maps** for the map page (was "Member Map"), and the Agent Maps page header now says **Agent Maps** too — palette, rail, and page agree everywhere.

**Result:** ☐ Pass   ☐ Fail — Notes: ___________________________________________________

## 6. Ticket mirroring fixed (07-28 #2 — TP-1058)

**What was wrong:** FreshService (our tenant) recently made **Department a required field**
for ticket creation. Our mirror never sent one, so every new mirror failed with an opaque
"Validation failed" — TP-1058 retried 8 times and dead-lettered. Mirrors now resolve the
department automatically (ticket's department → requester's office/department → fallback),
and mirror errors show FreshService's field-level details.

1. Open **TP-1058**: ✅ the chip reads **Mirrored** (we re-queued it after the deploy) and the FS copy exists.
2. Create a fresh TP-born test ticket ("QA TEST mirror check", any requester): ✅ within ~1 minute the chip goes Mirror pending → **Mirrored**.
3. Force a failure check (optional): if a mirror ever fails now, the ticket's mirror error text shows the **specific field** FreshService rejected, not just "validation error".

**Result:** ☐ Pass   ☐ Fail — Notes: ___________________________________________________

## 7. Assignment "all caught up" panel (07-28 #3)

1. Go to **Assignment** with auto-assign on and an empty review queue.
2. ✅ The old "✨ TODAY PT ✨" label is gone. The hero card now shows:
   - **"Pipeline activity — <Weekday, Month Day>"** with "**Pacific Time · since midnight**" beneath (hover explains the window);
   - **Tickets analyzed** (big number) **and the "fully automatic" rate** — the share of decided tickets routed with no human touch;
   - an **outcome-mix bar** whose colors match the four tiles below (hover each segment for its count);
   - a **"Last auto-assignment X min ago → tech"** chip (answers "is it alive right now?");
   - outside business hours: an **"After hours — resumes <window>"** chip with the queued count.
3. ✅ The four outcome tiles and the process pills below are unchanged and still drill into their sub-tabs with matching counts.

**Result:** ☐ Pass   ☐ Fail — Notes: ___________________________________________________

## 8. Regression guard: noise dismissal vs Closed (07-27 #5)

1. Take a ticket that is **Closed** by an agent (or close a QA TEST ticket), then dismiss it as noise (Mark as noise, or let the pipeline dismiss it).
2. ✅ The ticket **stays Closed** — it does not flip to Resolved. The "[Ticket Pulse] closed without assignment" note still lands on FS-born tickets.
3. A ticket dismissed as noise while still **Open** ✅ still resolves as before (unchanged behavior).

**Result:** ☐ Pass   ☐ Fail — Notes: ___________________________________________________

---

## Suggestions & improvements — for the team to assess

Researched against current service-desk practice (sources at the end). Each row asks for a
verdict so we can plan the next cycles. Benchmarks worth knowing: mature AI triage teams reach
**60–70% automation** and target **90–95% routing accuracy**; assisted teams cut triage time
roughly in half.

| # | Suggestion | Why / what it builds on | Team verdict |
|---|------------|------------------------|--------------|
| S1 | **SLA breach-risk lane** — a queue segment listing tickets *predicted* to breach (aging + no first reply + priority), before they actually do | We already track SLA due dates and pause logic; peers (Jira Service Management) surface "SLA risk" natively | ☐ Want  ☐ Later  ☐ Skip |
| S2 | **Routing-accuracy metric** — weekly % of auto-assignments that stuck (vs reassigned within N days), shown on Automation Ops | Industry target is 90–95%; we already record assignment episodes + corrections, so this is measurable today | ☐ Want  ☐ Later  ☐ Skip |
| S3 | **Auto-resolution for repetitive requests** — confidence-gated auto-replies that also *resolve* (e.g. "how do I reset my password" with the KB steps) | We already have AI proposed-replies with confidence gating; leaders auto-resolve 60%+ of L1 volume | ☐ Want  ☐ Later  ☐ Skip |
| S4 | **Microsoft Teams surface** — approvals + "my ticket" status + urgent alerts inside Teams | Requesters already create tickets via Teams; the best 2026 stacks live where users are (Teams/Slack) | ☐ Want  ☐ Later  ☐ Skip |
| S5 | **Knowledge-article suggestions on tickets** — related KB/canned answers beside the related-tickets card | We suggest related tickets already; suggesting the *answer* is the next step and shortens handle time | ☐ Want  ☐ Later  ☐ Skip |
| S6 | **Requester self-service deflection** — a small FAQ/status portal step before "create ticket" on the public pages | Self-service deflection is the cheapest ticket you never get; we already run public token pages | ☐ Want  ☐ Later  ☐ Skip |
| S7 | **Correction feedback loop** — when a coordinator overrides an AI assignment, capture the reason in one click and feed it to the competency model | Best-practice AI triage: overrides feed the model; we capture corrections but not the *why* | ☐ Want  ☐ Later  ☐ Skip |
| S8 | **External-sender automation** — build on this build's External flag: a workflow condition ("requester is external") for routing/priority rules | The flag ships today; making it automatable is a small follow-up | ☐ Want  ☐ Later  ☐ Skip |

Research sources: ConnectWise help-desk best practices; Kustomer & InvGate AI ticket-triage guides
(automation-rate / accuracy benchmarks); IsosTech "AI in JSM 2026" (SLA risk prediction, article
suggestions); Rezolve/eesel 2026 ITSM landscape (Teams-native service desks, auto-resolution rates).

---

## Notes for QA
- Hard-refresh before testing; the board view needs the new bundle.
- Please report: a board drag that saves without the FS confirm on an FS-born ticket; an External badge on an internal sender (or vice versa); any Team Balance number that disagrees with the technician page; a TP-born ticket stuck on Mirror pending > 5 minutes.
- The trusted-domains list is workspace-scoped — set it up in each workspace you test.

**Overall sign-off:** ☐ All pass   ☐ Issues found (see notes above)  ·  Tester: ______________
