# Approvals v2 + per-workspace fast-sync interval — build plan (15 Sep 2026, v3.8.91)

Source: Vahid's decisions on the 09-15 QA package (item 8) — "go with all your assumptions", plus
amount-based auto-escalation, an enriched request modal, forward-to-anyone, and a confirmation step
on the public page. Supersedes the "not built" status in `TIERED_APPROVALS_PLAN.md`.

## Decisions locked
| Topic | Decision |
|---|---|
| Tiers | Up to 3 tiers per category. Tier 1 is today's manager list (backward compatible: `tiers` null → single tier from `manager_emails`). |
| Escalation | A current-tier approver can **Escalate** (required note) to the next tier. Handed off: the escalating approver's row closes as `escalated`; siblings at that tier auto-cancel ("Superseded — escalated by X"). |
| Requester | Sees the escalation (e-mail + timeline), **without** the note. |
| Amount | A category can be **monetary** (`has_amount`). Then every request carries an amount (required) in the category currency (default CAD). |
| Auto-escalation | Each tier except the last can have an **approval limit**. When an approver **approves** an amount above their tier's limit, the request moves to the next tier automatically ("Approved at Tier 1 · over the $5,000 limit · sent on to Tier 2"). Rejection at any tier ends the request. Everything still starts at Tier 1. |
| Forward | An approver can **Forward** an open request to anyone in the workspace (members + technicians) as the **final** approver (required note). The target's decision ends the request — no further auto-escalation. Forwarder's row closes as `forwarded`; siblings auto-cancel. |
| Confirmation | Public page: Approve / Reject / Escalate / Forward each open a confirmation sheet ("You are about to approve TP-1234 for Rita …") before the call. Keyboard A/R open the same sheet. |
| Request modal | Searchable category combobox with rich rows (description, tier chain, approver avatars, amount badge), amount field when monetary (shows which tier finalises), rich composer with pasted/dropped images + attach button (files land on the ticket's attachments, note carries `[Image: name]` markers), notify toggle kept. |
| Category editor | Tier rows (name, approvers, limit), "+ Add a tier", monetary toggle + currency. |
| Fast sync | `workspaces.fast_sync_interval_minutes` (default 1, 1–30). Scheduler builds the cron from it; editable in Settings → Workspaces (with the full-sync interval); saving restarts that workspace's schedules. |

## Data (migration `20260916010000_approvals_v2`, additive)
```
approval_categories: tiers JSONB NULL, has_amount BOOLEAN NOT NULL DEFAULT false, amount_currency VARCHAR(8) NOT NULL DEFAULT 'CAD'
  tiers = [{ name: 'Tier 1', managerEmails: [...], limit: 5000 | null }, ...]   (tier 1 mirrors manager_emails)
ticket_approvals: tier INT NOT NULL DEFAULT 1, amount NUMERIC(14,2) NULL, amount_currency VARCHAR(8) NULL,
  is_final BOOLEAN NOT NULL DEFAULT false, escalation_log JSONB NULL
  escalation_log = [{ kind: 'escalated'|'forwarded'|'auto', fromTier, toTier, byEmail, byName, toEmails, note, at, decision? }]
  status gains 'escalated' | 'forwarded' (row handed off; the group's live rows carry the state)
workspaces: fast_sync_interval_minutes INT NOT NULL DEFAULT 1
```

## API
- `POST /tickets/:id/approvals` body + `amount`.
- `POST /tickets/:id/approvals/:approvalId/escalate { note }` — current-tier approver or admin.
- `POST /tickets/:id/approvals/:approvalId/forward { toEmail, note }` — approver or admin.
- `POST /ticket-approvals/public/:token/handoff { mode: 'escalate'|'forward', note, toEmail }`.
- `GET /ticket-approvals/public/:token` adds `approval.tier/tierName/tierCount/nextTier/canEscalate/amount/amountCurrency/amountLimit/autoEscalates/isFinal/escalationLog`, `approvers[].tier`, `forwardCandidates[]`, `ticket.attachments[]`.
- Settings approval-categories create/patch accept `tiers`, `hasAmount`, `amountCurrency`.
- `PUT /workspaces/:id` accepts `fastSyncIntervalMinutes`; interval changes restart the workspace schedules.
- Workflow events: `approval.escalated`, `approval.forwarded` (same payload shape as `approval.requested`).

## E-mails
- Approver request e-mail gains a hand-off block ("Escalated by Vahid Haeri (Tier 1): <note>", "Forwarded to you by …", or "Approved by … at Tier 1 — over the $5,000 limit, so your approval is needed") and an Amount fact.
- Requester gets "Your request moved to <names> (Tier 2)" / "… was forwarded to <name>" — no note.

## Tests
- Backend `approvalsV2.test.js`: request requires amount on monetary category; escalate creates tier-2 rows + supersedes siblings + e-mails; forward creates a final row; approve over limit auto-escalates; approve at final row ends; token hand-off; category service validates tiers/limits.
- Frontend: modal (combobox filter, amount required, submit payload), DecisionBox confirmation (approve needs confirm; A opens sheet), category form tiers, timeline labels.
