# Tiered approvals — design plan (QA 09-15 #8) — BUILT in v3.8.91 (see APPROVALS_V2_PLAN.md for the shipped design incl. amounts/auto-escalation and forward)

**Ask (Susan Xu, 15 Sep 2026):** "Imagine that for Security, Vahid can approve most of the items, but
some items he needs to escalate to Neville. Everything is sent to Vahid first and he can involve
Neville when need be. This is a comprehensive change and should be planned and applied carefully."

## Today
An approval category has a flat list of **managers**. A request goes to all of them at once; the
first decision wins and the siblings auto-cancel ("any-one-approves"). Deciding is open to anyone the
request is addressed to, including read-only members (v3.8.38), via the e-mailed link or in-app.

## Proposed model — tiers with manual escalation

```
Category "Security"
  Tier 1  Vahid Haeri                 ← every request starts here
  Tier 2  Neville Howell              ← only when Tier 1 escalates
```

- A request is **addressed to Tier 1 only** (same any-one-approves rule inside a tier).
- A Tier-1 manager gets a fourth action next to Approve / Reject / Ask a question:
  **Escalate to Tier 2**, with a required note ("needs CISO sign-off — new vendor").
- Escalation **re-addresses the same request** to Tier 2: new e-mails with the same token page, a new
  "Escalated by Vahid: <note>" block at the top of the page, Tier 1 kept on the thread as observers
  (they can still ask questions, they can no longer decide). The requester is told the request moved
  to a second approver. Nothing is auto-approved on the way up.
- Tier 2 decides exactly as Tier 1 would. A rejection at any tier ends the request.
- **No automatic escalation** in v1 (no timers, no amount thresholds). If Tier 1 does nothing, the
  existing expiry/reminder behaviour applies unchanged.
- Up to **three tiers**; most categories will have one, which is exactly today's behaviour.

## Data
- `approval_categories.tiers JSONB NULL` — `[{ "name": "Tier 1", "managerEmails": [...] }, …]`.
  When `tiers` is null the existing `managerEmails` column is the single tier → **backward compatible,
  no migration of existing categories**.
- `ticket_approvals.tier INT DEFAULT 1` and `escalation_log JSONB` (`[{ from, to, byEmail, note, at }]`)
  alongside the existing `clarification_log`.
- The per-approver rows (`ticket_approval_approvers`) gain `tier INT`; the "any-of first decision wins"
  logic already keys on the approver set, so tier N's set is simply the addressed set at that moment.

## API and UI
- `POST /tickets/:id/approvals/:approvalId/escalate { note }` — Tier-N manager only (same actor check
  as decide). Emits `ticket.approval_escalated` for workflows.
- Public token page: the decision box shows **Escalate** when the category has a higher tier and the
  viewer is on the current tier; the header shows "Tier 1 of 2 · with Vahid Haeri".
- Approvals → Categories editor: managers become **tier rows** ("+ Add a tier"); drag to reorder.
- Approvals inbox: a "Waiting on" column showing the current tier's names.

## Effort and risk
About two days: schema + service (½), token page + editor (1), e-mails + tests (½). Risk is low because
a category without tiers takes the existing code path; the new path is exercised only by categories
that opt in. Suggested pilot: **Security** in IT with Vahid → Neville.

## Open questions for Vahid / QA
1. Should Tier 1 still be able to approve **after** escalating, or is the decision fully handed off?
   (Plan assumes handed off.)
2. Should the requester see the escalation, or only "still awaiting approval"? (Plan: see it, no note.)
3. Any category that should escalate **automatically** (e.g. above a purchase amount)? Not in v1.
