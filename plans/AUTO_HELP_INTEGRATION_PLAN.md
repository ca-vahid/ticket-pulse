# Auto-help ↔ intake, workflows and the pipeline: integration plan

_26 Sep 2026. Source: Vahid's question ("what triggers Knowledge; business hours vs after hours; how do 'Ticket arrived'
workflows work hand in hand with it?") and a deep read of shipped 3.9.90 + the P1 branch. Builds on
`plans/AUTO_HELP_PLAN.md` and `plans/AUTO_HELP_P1_PLAN.md`. Work lands on branch `cursor/auto-help-p1` (unshipped)._

## Decisions (Vahid, 26 Sep 2026)
| Topic | Decision |
|---|---|
| After hours | **Answer at night only once a playbook has earned auto mode.** Until then, night runs draft on the provisional category; the draft waits for an agent (approve mode) and is re-checked when the morning run settles the category. |
| "Ticket arrived" ack | **Merge**: when Auto-help will answer, the ack waits a few minutes and the requester gets ONE e-mail (ack line on top, answer below); otherwise the normal ack goes out. Only matters once something is actually sent. |
| First response / SLA | **Counts only when an agent sends it.** A future auto-sent answer gets its own `firstAutomatedReplyAt` and does not stop the first-response clock unless a workspace opts in. |
| Old "AI first-reply draft" template | **Retire it.** It was installed twice in IT in July and never enabled; zero proposed replies ever. Auto-help is the one source of AI first answers; the `propose_reply` workflow step stays for custom workflows but never replaces a person's draft or an Auto-help answer. |

## How it works today (the answer to "what triggers it")
Auto-help starts on the **first `ticket.categorized`** event (`first=true`), from the AI pipeline or a person/API/workflow
setting the category. It has **no time gate of its own**:
- Business hours: the full pipeline run (~49 s after arrival) saves the category → Auto-help.
- After hours with priority assessment on: the priority-only night run saves the category → Auto-help at night
  (P0 shadow / P1 a staged draft nobody sends until morning).
- After hours without it: nothing until the business-hours queue drains in the morning.
- Never: category edits made in FreshService, tickets created with a category (API/agent form), trusted-intake
  integrations (Simorgh/Sentinel), duplicate-burst / alert-correlated tickets.

## Gaps found (numbered for the work below)
1. Auto-help fires **before** the noise verdict and the decision are saved (`ticket.categorized` is emitted inside
   `_persistInternalClassification`).
2. "Not actionable" verdicts in workspaces without auto-close only live on the pipeline run — not skipped.
3. Only the FIRST category counts; a night category that changes in the morning leaves a stale draft.
4. The (never-enabled) AI first-reply template would block Auto-help for good (`open_proposed_reply` + `already_ran`).
5. (P1) a workflow `propose_reply` supersedes an Auto-help proposal silently; the run is left `staged` forever.
6. (P1) the "Follow-up nudge" template (public reply → 24 h → "still need help?") double-nudges parked tickets.
7. First-response stamping: any public reply sets `firstPublicAgentReplyAt` — right for agent-sent, wrong for auto.
8. Missing skips: already-parked (HR park), never-noise held, merged / split children, untrusted API intake rules.
9. The trigger queue is in memory — restarts / morning drain bursts lose triggers; no catch-up sweep.
10. FS-born: FS sends its own ack; FS supervisor rules act on the FS copy; FS category edits never reach Auto-help.
11. The pipeline doesn't know about Auto-help (can noise-close a ticket whose requester is engaging with an answer).
12. Requester replies wake Auto-help's classifier and the reply workflows at once; a "thanks" after an Auto-help close
    reopens the ticket via reopen-on-reply and counts as `reopened`.
13. Workflows can't see Auto-help at all (no context variables, no triggers); Resolution summary / CSAT mails go to
    Auto-help closes unlabelled.

## Design
**A. One trigger point: `ticket.intake_settled`.** Emitted once per ticket after the pipeline has saved category,
priority, noise and its decision (after the run is recorded), with `extra { category, subcategory, decision,
nonActionable, noiseVeto, afterHours, provisional, fullRunPending, source }`. The after-hours priority-only run emits it
with `provisional: true`; the morning full run emits it again with `provisional: false`. A person/API setting the
category with no open pipeline run also emits it. Auto-help listens only to this; `ticket.categorized` stays for
workflows. Also registered as a workflow trigger ("Ticket intake settled").

**B. One owner of the first reply per ticket** (`tickets.reply_owner` + `reply_owner_ref`, under the existing
per-ticket advisory lock): `agent` > `auto_help` (grounded answer) > `workflow_draft`. `propose_reply` never replaces
a higher owner; any replacement is recorded on the loser (Auto-help run outcome `superseded_by`). Skip reasons that
can clear (open workflow draft, approval in progress, provisional night run) don't count as "already ran".

**C. Night vs morning.** Night (provisional) run → Auto-help drafts on the provisional category (approve mode: staged
for the morning). Morning settle → if the category/subcategory or the decision changed (noise, not actionable,
approval), the staged draft is withdrawn (reason recorded) and at most one re-run happens on the new category; if
unchanged, the draft stays. Auto mode's night answer (later) needs: auto earned, not sensitive, night run said
actionable, not observe-only; the ticket still gets its morning assignment.

**D. Workflows are aware.** Context: `ticket.autoHelp.{state, expected, playbook, mode, sentAt, outcome}`,
`ticket.parkKind`. Triggers: `auto_help.staged`, `auto_help.answered`, `auto_help.nudged`, `auto_help.help_requested`,
`auto_help.resolved`. Ack merge: the "Ticket arrived" send step gets an option **"When Auto-help will answer: merge"**
(wait up to N minutes; if Auto-help sends in that window the ack line is prepended to the answer and the ack is not sent
separately; otherwise the ack goes as usual). Seeded-template guards: Follow-up nudge skips `parkKind = auto_help`;
reopen-on-reply classifies before reopening within 7 days of an Auto-help close; Resolution summary skips Auto-help
closes; CSAT on Auto-help closes is reported separately with N. The retired template is removed from the gallery.

**E. The pipeline knows.** An Auto-help context block in the pipeline evidence (run state, staged/sent answer); it never
noise-closes a ticket with a sent answer or a requester reply to it (downgrades to review); a note to the assignee when
the morning category differs from what Auto-help answered.

**F. First response / SLA.** Agent-sent answers stamp `firstPublicAgentReplyAt` as today. Auto-sent answers (later)
stamp new `firstAutomatedReplyAt` only; workspace switch `autoHelpCountsAsFirstResponse` (default off). Analytics show
"automated first answer" separately with N.

**G. Durable triggers.** Auto-help jobs move from the in-memory queue to a small DB-backed queue (claimed rows,
retries, age cap), plus a sweep for "intake settled, no Auto-help decision" in the last 6 h.

**H. FreshService-born.** Checklist of FS supervisor rules vs TP parks (for Vahid/IT); optional FS→internal category
mapping so FS-side categorization can settle intake; FS group handover for "still need help".

## Work plan (all on `cursor/auto-help-p1`, shipped only after review)
- **W0** Sync the branch with main 3.9.91 (Settings tab + shared tab bar, mirror/stats fixes); move P1's extra
  settings (approve mode, cost cap, thank-you, FS import, review digest) into the new Settings tab.
- **W1** `ticket.intake_settled` (A) + Auto-help moved onto it + skips 2/8 + provisional/settle handling (C).
- **W2** Reply ownership (B) + `propose_reply` yields + outcome `superseded_by` + template retired.
- **W3** Workflow awareness (D): context, triggers, ack merge option, seeded-template guards.
- **W4** Pipeline awareness (E) + first-response / SLA (F).
- **W5** Durable queue + catch-up sweep (G).
- **W6** Timeline simulations (fake timers + business calendar): business hours / after hours × TP-born / FS-born ×
  priority-at-night on/off; assert exactly one requester e-mail per stage, the right order, no double nudge.
- **W7** Docs (AGENTS.md, review guide) + FS checklist (H).
