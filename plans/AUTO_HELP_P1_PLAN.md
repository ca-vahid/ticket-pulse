# Auto-help P1: from shadow drafts to answers people can send

_Status: build plan, 26 Sep 2026 (weekend). Follows P0 (3.9.89: Knowledge section, playbooks, shadow runs, review
verdicts). Everything here ships behind per-workspace and per-playbook switches that default OFF. Auto mode stays
server-locked until a playbook earns it. Parent plan: `plans/AUTO_HELP_PLAN.md`._

## Goals
1. **Approve mode**: an agent sees "Auto-help suggests…" on the ticket and sends it with one click (or edits first).
2. **The follow-up loop** Vahid chose: answer → nudge after N business days → resolve after N more, via a dedicated
   `auto_help` park, with its own waiting queue. Any reply from the requester hands the ticket to a person.
3. **Outcomes we can trust**: every sent answer ends in a recorded outcome, so the rollout bar is measured, not guessed.
4. **Knowledge that grows**: find the gaps, turn solved tickets into articles, import FreshService articles.
5. **An evidence-based path to auto mode**: backtests + shadow reviews + approve-mode edit rates → a server-enforced
   readiness gate per playbook.

## 1. Approve mode
- Playbook `mode: 'approve'` allowed (server) once the workspace switch is on. Runner, after all gates pass, creates a
  `TicketProposedReply` (source `auto_help`, links `autoHelpRunId`), status `staged`, gateDecision `staged_for_agent`.
  One open proposal per ticket (existing rule) — an existing human draft wins; Auto-help never overwrites.
- `ProposedReplyCard` learns the Auto-help variant: title "Auto-help suggests" + playbook name, confidence as plain
  text, the sources list (title › section, link to the article), the disclosure line preview, and the follow-up
  promise ("If they don't reply, we'll check in on <date> and close on <date>"). Buttons: **Send**, **Edit & send**,
  **Dismiss** (asks for a one-tap reason: wrong answer / not needed / other).
- Outcome capture on the run: `agent_sent` (unchanged), `agent_edited_sent` (store a normalized edit distance),
  `agent_dismissed` (+ reason). Edit distance feeds the readiness bar.
- Both origins: send goes through `ticketService.addReply` (TP-born) / the FS reply lane (FS-born, IT has it on), so
  threading, Cc, signatures and the mailbox lane stay the ones agents already use. The sending agent is the author.

## 2. Follow-up loop (park kind `auto_help`)
- On send (approve or auto): park the ticket, kind `auto_help`, until the nudge date = send + `nudgeAfterBusinessDays`
  (businessCalendarService, workspace holidays). TP-born → Pending; FS-born → FS Pending via the existing park path.
  The ticket keeps its assignee (decision) and shows in Knowledge → Waiting and Tickets → "Auto-help waiting".
- Park sweep (existing 60 s loop) wakes `auto_help` parks:
  - not yet nudged → send the nudge (playbook `nudgeText`, `{{days}}` rendered) on the same thread, set `nudgedAt`,
    re-park until close date = nudge + `closeAfterBusinessDays`;
  - nudged and still silent → `onSilence: resolve` → resolve with reason `auto_help` + note "Resolved after no reply
    to the Auto-help answer", outcome `resolved_silence`; `leave_open` → unpark, outcome `no_reply_left_open`.
- Requester reply (existing `requester_replied` park end) → classify the reply (cheap LLM + keyword fast path:
  "thanks / that worked / sorted / fixed" vs anything else):
  - positive → resolve (reason `auto_help`, outcome `resolved_confirmed`), thank-you only if the workspace wants it;
  - otherwise → outcome `help_requested`, unpark to Open, and route per `onHelp`: `assign_normally` (keep assignee,
    alert them), or `group:<id>`.
- Reopen within 7 days after an Auto-help resolution → outcome `reopened` (hook in ticketReopenService).
- Agent replies while parked → the park ends (existing), outcome `agent_took_over`.
- Every step writes a ticket activity line ("Auto-help checked in", "Auto-help closed after no reply") so the history
  tells the story.

## 3. Outcomes, metrics, readiness gate
- Activity → per-playbook panel: sent N, resolved by silence / confirmed / help requested / reopened (all with N and
  %), approve-mode sends unchanged vs edited (median edit distance) vs dismissed, CSAT on Auto-help-resolved tickets
  with N (never a rate without its N), cost per run and per month.
- **Readiness gate (server-enforced)** for `mode: 'auto'`: ≥ 30 reviewed shadow runs with ≥ 85 % "good" and no
  "wrong" in the last 30; ≥ 20 approve-mode sends with ≥ 70 % unchanged and reopen ≤ 5 %; playbook not flagged
  `sensitive`. The UI shows each criterion as met / not met with numbers. Admin still flips it; the server refuses
  when the gate isn't met. Auto mode remains OFF in P1 builds unless Vahid asks.
- `sensitive` flag on playbooks (password / MFA / access / security): approve-only forever, never auto.
- Agent / team stats: Auto-help resolutions are excluded from agent closing numbers and shown as their own line
  (team-safe; no per-person ranking).

## 4. Knowledge that grows
- **Gap finder**: runs that ended `no_sources` / `no_grounded_source` / `insufficient_context`, clustered by embedding
  similarity per playbook → Knowledge → Gaps: "12 tickets asked about installing Revit add-ins; no article covers it"
  with example tickets and a **Draft an article** button.
- **Draft an article from solved tickets**: LLM drafts a structured article (title, headings, numbered steps) from the
  verified solutions / agent replies of the cluster's resolved tickets; it lands as a draft for a person to edit and
  publish (never auto-published). Internal notes are excluded; requester names are removed.
- **Promote a ticket solution**: on a ticket with a verified solution, "Turn into an article" → draft pre-filled.
- **FreshService solution articles import** (optional per workspace): pick FS folders; nightly import of published
  articles as `source: fs_solution`, read-only in TP, re-imported when FS changes (content hash), same sections + index.
- **Verified-solution embedding job**: embed verified-solution tickets (subject + solution note) nightly so retrieval
  uses meaning, not only keywords.
- Stale articles: weekly digest to owners with "Review due" articles (in-app + e-mail, owner-only, grouped).

## 5. Evidence before trust: backtests
- **Backtest a playbook**: run it in shadow on the last N (default 20, max 50) resolved tickets that match, with a cost
  estimate and a confirm. Runs are tagged `trigger: backtest`, never touch the tickets, and show next to what the team
  actually replied (R6), ready for review. This gets a new playbook to 30 reviewed drafts in an afternoon instead of a
  month.
- Reviewer workflow: a "Review queue" in Activity (unreviewed drafted runs, oldest first, keyboard shortcuts G/P/W/S).

## 6. Engineering notes
- New columns: `ticket_proposed_replies.auto_help_run_id`, `auto_help_runs.edit_distance`, `dismiss_reason`,
  `outcome_detail`, `cost_usd`, `input_tokens`, `output_tokens`; `auto_help_playbooks.sensitive`,
  `knowledge_articles.fs_updated_at`; table `knowledge_gaps` (optional; can be computed on demand first).
- Scheduling reuses the park sweep; no new worker. Business days via businessCalendarService.
- Budgets: per-workspace monthly cost cap (settings), runner refuses with `budget_exhausted` when reached.
- Tests: approve staging (never overwrites a human draft), send → park → nudge → close timeline with fake timers and
  a business calendar, reply classification both ways, reopen outcome, readiness gate math, backtest never writes to
  tickets, FS import idempotency, gap clustering.

## Build order
1. Outcome plumbing + approve mode + ProposedReplyCard variant. 2. Park loop (nudge/close/reply/reopen).
3. Metrics + readiness gate + sensitive flag. 4. Backtests + review queue. 5. Verified-solution embeddings + gap finder
+ draft-from-tickets + promote. 6. FS article import. Each step: tests, local visual check (light/dark/phone), then a
review note for Vahid. Ship only after Vahid's review.
