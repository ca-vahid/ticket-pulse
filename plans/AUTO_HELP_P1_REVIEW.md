# Auto-help P1: review guide for Vahid

_Built 26 Sep 2026 overnight on branch `cursor/auto-help-p1` (worktree `C:/Cursor/ticket-pulse-autohelp-p1`, cut from 3.9.89).
**Nothing here is released.** It ships only after your review. Plan: `plans/AUTO_HELP_P1_PLAN.md`._

## In one paragraph
Auto-help can now take a playbook from "shadow" to **approve mode**: when a playbook is in approve mode, the ticket shows
"Auto-help suggests…" and an agent sends it with one click (or edits it first, or dismisses it with a reason). A sent answer
starts the follow-up you chose: a check-in after 2 business days of silence, then a close after 2 more. Any reply from the
requester goes back to a person unless it clearly says it worked. Everything that happens is measured per playbook, and a
readiness check shows how far each playbook is from being trusted with more. **Auto mode (sending without a click) is
switched off in this build**; the readiness check is there so we can see the evidence, not to enable it. Knowledge also
learns: a Gaps tab groups the questions Auto-help couldn't answer, drafts articles from how the team solved them, can turn
a ticket's verified solution into an article, imports FreshService solution articles, and can backtest a playbook on
past tickets.

## What to look at (screenshots in `qa/p1-evidence/`)
| Screen | Files |
|---|---|
| Suggestion card on a ticket (send / edit / dismiss) | 01-*, 02-*, 03-*, 09 (phone) |
| After sending: toast, ticket history, Waiting | 11-*, 12-*, 13-* |
| Activity: per-playbook metrics + readiness lines | 04-*, 10 (phone) |
| Loop in the ticket history (answer → check-in → close) | 05-* |
| Settings strip (approve mode, cost cap, thank-you) | 06-* |
| Playbook editor (modes, sensitive, follow-up) | 08-* |
| Gaps tab + drafting | gaps-*, mobile-390-gaps-* |
| Drafted article banner | drafted-article-banner-* |
| Turn a ticket's solution into an article | turn-into-article-* |
| FreshService article import | fs-import-settings-*, fs-article-read-only-* |
| Backtests | backtest-*, activity-backtest-*, mobile-390-backtest-* |

## Safety design (what makes it safe to try)
- **Three locks on sending**: workspace Auto-help switch → workspace Approve-mode switch → playbook in Approve mode. Auto mode
  is refused by the server in this build (`AUTO_MODE_BUILD_ENABLED = false`), and sensitive playbooks (password / MFA /
  access / security) can never be auto.
- **Only an agent's click sends** in approve mode; the disclosure line and the follow-up footer are added by the server.
- **The follow-up re-checks everything before each step**: ticket still waiting, not closed/deleted/noise/merged, Auto-help
  and the playbook still on, no reply from the requester or an agent, same assignee. Otherwise it stops and hands the ticket
  to a person. The plan (days, texts, what happens on silence) is frozen when the answer is sent.
- **Claims before sends**: two containers (during deploys) can't both send a check-in or close; a failed send never
  leaves a ticket closed without the answer; retries can't double-send (idempotency key per run).
- **Replies**: only a clearly positive reply closes a ticket ("that worked, thanks"). Anything with a "not / still / again
  / broken / ?" goes to a person; an unsure model means a person.
- **Team numbers**: tickets Auto-help closes don't lower an agent's close rate (left out of both sides), and show as their
  own "by Auto-help" line. Existing numbers are unchanged when nothing has been closed by Auto-help (pinned by tests).
- **Knowledge drafts** read only resolved tickets' verified solutions and public replies, never internal notes, with names,
  e-mail addresses, phone numbers, ticket numbers, IPs and secrets removed; drafts are never published automatically.
- **FreshService import** only reads (GET), in production only, through the shared rate limiter; never archives on a
  partial listing; one advisory lock per workspace.

## How it was checked
- Built by two agents, then **four rounds of independent audit** on the parts that can e-mail or close:
  1. 7 blockers (e.g. "Not yet fixed" read as "it worked"; the loop not re-checking a ticket closed in FreshService;
     deleting a playbook turning "leave open" into "close"; a possible second check-in).
  2. 2 more: a ticket could close although the answer e-mail silently failed (unattended / no address / send error);
     the quick reply reader still confirmed "It worked for 5 minutes then stopped".
  3. 1 more: a saved-but-unsent reply could later be taken as delivered.
  4. 1 more: real replies like "I'm away until Monday so I'll try it then" were taken for out-of-office and ignored.
  All fixed, each with a test that proves it. The last check traced every e-mail lane (Graph, SendGrid, FreshService
  via Ticket Pulse, FreshService API) and every recovery path.
- The PII scrubber for drafted articles went through three rounds (names incl. two-letter surnames, phones, IDs, cards,
  addresses and postcodes, API keys / tokens / passwords in prose, share links) with tests both ways.
- Backend 351 suites / 4,268 tests; frontend 193 files / 1,484 tests; eslint, dark-mode lint and build green.
- Local visual pass in light, dark and 390 px (`qa/p1-evidence/`).

## Integration (W1–W5) — how Auto-help fits intake, workflows and the pipeline
_Built 26 Sep 2026 on the same branch, after your decisions in `plans/AUTO_HELP_INTEGRATION_PLAN.md`. Unshipped._

**In one paragraph.** Auto-help no longer starts on the first "ticket categorized". It starts when the ticket's intake
has *settled* — the AI has saved the category, the priority, the noise verdict and its decision — so it never answers a
ticket the AI is about to close as noise or judge not actionable. At night (with the night priority run on) that verdict
is *provisional*: Auto-help drafts on it, the draft waits for an agent, and the morning run either confirms it (the draft
stays) or changes it (the draft is withdrawn, with the reason on the run, and Auto-help tries once more on the new
category). If an agent already sent the night answer and the morning run disagrees, the assignee gets an internal note.
Every settle is a row in a small database queue, so a restart or a busy morning never loses one, and a sweep picks up any
the queue missed. Workflows can now see Auto-help (its state, and five new triggers), the old "AI first-reply draft"
template is retired, and the seeded templates no longer nudge, summarise or reopen on top of Auto-help.

| Item | What changed |
|---|---|
| W1 one trigger | `ticket.intake_settled` (also a workflow trigger "Ticket intake settled") after the pipeline's run update: provisional at night, final in the morning; `source: manual` when a person / API / workflow sets the category with no run open. Skips recorded (never "already ran"): noise decision, not actionable, never-noise hold, a non-Auto-help park (HR), merged, split child. Morning: same → keep; changed → withdraw (`outcome withdrawn` + why) + at most one re-run; already sent → internal note. |
| W2 one owner | `tickets.reply_owner` (+ ref): agent > Auto-help > workflow draft, under the per-ticket lock. A workflow draft never replaces an Auto-help answer waiting for an agent; an agent replying themselves sets the Auto-help draft aside (`outcome superseded_by`). "AI first-reply draft" template: out of the gallery, install refused, installed copies still load. |
| W3 workflows | `ticket.autoHelp.{state, expected, playbook, mode, sentAt, outcome}`, `ticket.parkKind` (+ `auto_help`), `ticket.resolvedByKind`; triggers `auto_help.staged / answered / nudged / help_requested / resolved`. Send-email option **"When Auto-help will answer: merge"** (wait 5 min, max 15). Guards: Follow-up nudge skips while Auto-help waits and after it closed; Resolution summary skips Auto-help closes; reopen-on-reply reads the reply first within 7 days of an Auto-help close and stays closed on thanks / an out-of-office. |
| W4 pipeline | An "Auto-help Context" block in the pipeline's evidence; a noise verdict on a ticket whose requester got an Auto-help answer (or replied to it) is held for a person (`pending_review`, step `auto_help_guard`). First response: agent-sent counts as today; an auto-sent answer stamps `first_automated_reply_at` only (switch `counts_as_first_response`, off). |
| W5 durable | `auto_help_jobs`: one row per settle, claim by conditional update, retries 1/5/15 min (4 attempts), 6 h age cap, stale claims recovered; drained by its **own 45 s tick** (never inside the park sweep); one job per ticket at a time; catch-up every ~5 minutes for the last 6 h (paged, only since Auto-help was switched on); a missed morning settle is recovered; finished rows deleted after 14 days. See "Audit follow-ups" below. |

**About the ack merge (read this one).** **In approve mode the ack is never merged — by design.** The merge only
holds the "Ticket arrived" ack when Auto-help is going to **send by itself** (auto mode), and auto mode is locked in this
build, so today it never changes an e-mail. In approve mode the answer waits for an agent — possibly hours — so holding
the ack back would only delay it: the ack goes out at once, exactly as today, and the agent's answer is its own e-mail.
FreshService-born tickets get FreshService's own ack, which Ticket Pulse cannot merge. When auto mode is ever switched
on, turn the option on in the "Ticket arrived" workflow's send step.

**How it was checked.** 90 new backend tests (8 files, `backend/tests/autoHelp{IntakeQueue,ReplyOwnership,FirstResponse,EventWiring,WorkflowAwareness,AckMergeEngine,PipelineIntegration,IntegrationTimeline}.test.js`) and 19 frontend source tests pin every behaviour: the queue (dedupe, two workers, backoff, age cap, stale
claims, catch-up), every settle rule (night → morning same / recategorized / noise / approval / already sent / agent
mid-send / run still drafting), reply ownership (ranks, lock, yielding, superseding, release on dismiss), the reply
path (first-response stamps, owner writes), the event door (intake listener, reply read before reopen), the engine's ack
merge (hold, wake → consumed / released / mid-send), the pipeline (settle order and flags, evidence block, noise guard),
workflow awareness (context states, condition fields, the three template guards evaluated the way the engine does, the
one-off transforms), and **timeline simulations** with fake timers and the business calendar: business hours / after
hours × TP-born / FS-born × night priority run on/off — Auto-help runs once, the requester gets exactly one ack, then one
answer (after an agent sends it), then one check-in, in that order, the generic follow-up nudge never fires, the ticket
closes on silence; plus the morning withdraw + re-run, a lost settle recovered by the catch-up, two workers on a morning
burst, and the ack merge with auto stubbed on (one e-mail: ack line on top of the answer). Mutation checks: removing the
nudge guard or the "keep the draft" rule fails the timelines. Full backend suite: 361 suites / 4,384 tests green (one
timing-sensitive pool test flaked under load and passes on its own); eslint `src` clean.

**Decided since (26 Sep 2026)**
1. **Delayed workflows read the live ticket.** Every run resumed after a delay (a delay step, or the 3-minute
   coalescing window of "Ticket updated (fields)") now re-reads **status (+ base status), priority, assignee, group,
   noise flag, park, resolver, internal category / subcategory, and the dates resolvedAt, closedAt, dueBy and frDueBy**
   (the dates since the audit, so a template can't print "Open" next to a resolved date) before it continues. Everything
   else in the stored copy stays, and **`event.*` stays the trigger-time record** — for a coalesced fields_updated run
   that is the merged change set (`event.extra.changes`, `changedFields`, actor), exactly as before. A "wait a day → still open? → e-mail" workflow no longer mails a ticket resolved during
   the wait (behaviour change for ALL delayed workflows — release note below). No existing test relied on the old copy.
2. **A person / the API recategorizing** while nothing has been sent withdraws the staged draft and re-runs on the new
   category (also after the morning run withdrew a draft); an agent's dismissal is final. Every ticket gets at most
   3 real Auto-help runs. Already sent → internal note only.
3. Manual settles are durable too: a marker row on the ticket's history (`auto_help_manual_settle`) plus the job,
   inserted in the same code path with retries; the catch-up sweep re-queues from the marker.
4. `firstAutomatedReplyAt` is on the API v1 ticket (and in the OpenAPI spec).

**Still open**
- FreshService-side category edits never reach Auto-help (plan gap 10 / H — needs an FS→internal mapping).
- `counts_as_first_response` has no switch in Knowledge settings yet (coming after the Knowledge redesign); it only
  matters once auto mode exists.

## Audit follow-ups (26 Sep 2026, after an independent audit of this branch)
| # | Finding | Fix |
|---|---|---|
| S1 | The park sweep awaited the Auto-help drain (10 jobs × up to 45 s) inside its running guard: park wakes and due-soon notices in every workspace waited on model calls. | The queue has its own 45 s tick and running guard (`autoHelpIntakeService.start/tick`, started in `app.js`); the park sweep no longer touches it. `AUTO_HELP_JOB_SWEEP_ENABLED=false` switches the tick off. |
| S2 | Two settle jobs for one ticket (morning settle + a manual recategorization, two containers) could both pass "already ran" and both run the model. | Per-ticket advisory lock (namespace 48213, transaction-scoped, milliseconds): a job is not claimed while another job for the same ticket is running (it waits for the next tick); the first run's "already ran" re-check and its row insert happen under the same lock. |
| S3 | The workflow-guard script could touch sandboxes and custom look-alike workflows; its version number was `publishedVersion + 1`. | Workspaces 6-9 never; by default only workspaces with Auto-help on (`--workspace N` names one); every match is printed with how it matched; a name / step-id match is changed only with `--include <ids>`; next version = max(version) + 1. |
| S4 | Resume refreshed the status but not the dates. | resolvedAt / closedAt / dueBy / frDueBy refresh too (see "Decided since" 1). |
| S5 | "Runs in Activity" / "Knowledge settings" skipped the unsaved-changes guard; "Duplicate" silently dropped edits. | Both go through the guard; Duplicate with unsaved edits asks in-app first ("Duplicate saved version" / "Keep editing"). |
| S6 | Release notes missed the reopen change. | Added below. |
| + | Nice-to-haves | Workspaces without Auto-help skip the pipeline's Auto-help reads (cached 60 s; a workspace that switched it off after answering keeps the noise-close guard) · catch-up paged and bounded by `auto_help_settings.enabled_at` · `auto_help_jobs` cleanup (14 days) · missed morning settle (no final settle within business hours + 2 h → settled from the latest full pipeline run) · ack merge: the "merged" mark is retried and a waking node reads the thread for the answer's send key first · a stay-quiet check that says nothing about the conditions is a failed check (`check_failed`) · schema comments for the partial indexes, `updatedAt` default on pending acks · test-leak fix · "existing behaviour unchanged" tests · tab badge announced, "Drafted from tickets" label. |

**About the migration.** Lines were appended to `20260926020000_auto_help_p1_core` after it was first applied locally
(the audit's `enabled_at`). A dev database that applied an earlier version shows a checksum mismatch in
`prisma migrate status` — re-apply the appended lines by hand and update the checksum, or reset the dev DB. Prod has
never applied this migration, so prod is unaffected. The `ALTER TABLE "tickets" ... ADD COLUMN` lines are metadata-only
but still take a brief ACCESS EXCLUSIVE lock on the live table: run the migration at a quiet time (outside 7-17 PT).

## Known limits (by design or for later)
- Out-of-office detection is English-only (a non-English auto-reply is treated as a real reply → a person looks: safe side).
- The PII scrubber is best effort (common-first-name list; street formats) — every drafted article is a draft a person
  must check before publishing; the editor banner says so.
- A multi-word secret on the same line as "passphrase" is removed to the end of the sentence; other secret formats are
  pattern-based.
- Graph → SendGrid fallback can double-send if Graph delivered and then threw (existing behaviour, not Auto-help's).

## Decisions I need from you
1. **Bar for trusting a playbook more** (shown as readiness lines): ≥ 30 reviewed shadow drafts with ≥ 85 % good and no
   "wrong" in the last 30; ≥ 20 approve-mode sends with ≥ 70 % unchanged and ≤ 5 % reopened; not sensitive. Keep?
2. **How Auto-help closes are recorded**: the resolution-reason list is Security-only (Simorgh relies on it), so Auto-help
   closes are marked `resolved_by_kind = auto_help` instead. OK?
3. **"Still need help" on FreshService-born tickets** keeps the assignee and tells them (group re-routing works only on
   TP-born tickets). OK?
4. **Check-in timing**: sent at the next business-hours moment. Avoid early mornings / specific windows?
5. **Thank-you reply** when the requester confirms it worked: off by default. On?
6. **Dashboard team total**: team "closed" adds up agents' closes with "by Auto-help" on its own line. Or one combined figure?
7. **FreshService articles' "last verified"** comes from FreshService's last update, so old ones rank lower at once. Keep?
8. **Does "the model declined" count as a knowledge gap?** (Currently yes.)
9. **Disclosure line**: configurable per workspace (your decision); the suggestion card now says when it is off. Fine?
10. **Monthly cost cap**: none set by default. Want one for IT (e.g. US$50)?

## To release (after your review)
1. Rebase onto main (3.9.90+), re-run all suites.
2. Apply migrations `20260926020000_auto_help_p1_core` and `20260926030000_knowledge_growth` to prod **before** the merge
   (both additive with `lock_timeout`; the second adds a small unique index on `knowledge_articles`).
   The core migration now ends with the integration lines (W1–W5), all `IF NOT EXISTS`:
   `tickets.reply_owner` VARCHAR(20), `tickets.reply_owner_ref` VARCHAR(80), `tickets.first_automated_reply_at`
   TIMESTAMPTZ — nullable, no default, no index (metadata-only on the live table);
   `auto_help_settings.counts_as_first_response` BOOLEAN NOT NULL DEFAULT false, `auto_help_settings.enabled_at`
   TIMESTAMPTZ (backfilled from updated_at where enabled); new tables `auto_help_jobs`
   (unique `dedupe_key`, index `(status, run_after)`, `(ticket_id)`) and `auto_help_pending_acks`
   (index `(ticket_id, status)`). Record the migration as applied (the deploy never runs `migrate deploy`).
   Run it at a quiet time (outside 7-17 PT): the `tickets` ADD COLUMN lines take a brief exclusive lock.
   Then, out of band (never inside a migration — `tickets` is a live table): check
   `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'tickets' AND indexdef ILIKE '%parked_until%';` —
   if no partial index on `parked_until` exists, run `backend/scripts/sql/auto-help-parked-until-index.sql`
   (`CREATE INDEX CONCURRENTLY`, not in a transaction). The park sweep and Auto-help's stale-marker recovery read it every minute.
3. When Auto-help is switched on in a workspace (or name it: `--workspace N`):
   `node backend/scripts/auto-help-workflow-guards.mjs --prod` (dry-run — read it; it prints every matching workflow,
   how it matched and why it is or isn't selected), then with `--apply`: adds the Auto-help guards to the Follow-up
   nudge / Resolution summary copies and the seeded "Reopen on requester reply" workflows installed before this build
   (a new published version each, max(version) + 1; enabled / mock untouched). Workspaces 6-9 are never touched; a
   workflow matched only by its name or step ids is changed only with `--include <ids>`. With Auto-help off everywhere
   (the state at release) the default run selects nothing. Local dev dry-run today: nothing selected by default;
   `--workspace 1` selects 2 (the seeded reopen draft and the Resolution summary draft).
4. Ship; Auto-help stays OFF in every workspace. Then: write 5–10 IT articles, switch IT to shadow, review ~30 drafts per
   playbook, backtest each playbook, and only then turn on approve mode for one playbook.
5. Release notes (behaviour changes outside Auto-help): `resolvedByKind` is now kept when a workflow moves
   Resolved→Closed (API v1/webhook consumers see the original resolver instead of 'workflow'). A workflow
   `propose_reply` / low-confidence downgrade no longer dismisses an Auto-help answer waiting for an agent, and yields
   (`yieldedToHigherOwner`) when an agent or Auto-help owns an unanswered first reply. The "AI first-reply draft"
   template is gone from the gallery. `ticket.categorized` no longer starts Auto-help (use "Ticket intake settled").
   **Every workflow resumed after a delay now sees the ticket's current status, priority, assignee, group, noise flag,
   park, resolver, category and resolvedAt / closedAt / dueBy / frDueBy** (it used to see the copy from when it
   started); `event.*` stays as it was at the trigger. **Prod inventory 26 Sep: of 15 enabled workflows, only #12874
   (ws5 'Ticket updated (fields)', coalesced) is affected — its ticket.isNoise condition now reads the value at send
   time instead of at trigger time.** API v1 tickets gain `firstAutomatedReplyAt`. **`resolvedByKind` is now cleared
   on every reopen** (native, workflow, FreshService sync, reconcile — `ticketReopenService`), and API v1 exposes it:
   integrators see `null` on a reopened ticket instead of the kind of its last close.
