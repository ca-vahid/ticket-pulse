# Brief threads — living state for the daily and weekly briefs

This file is the memory the briefs carry between runs. **Every brief run updates it** (add, adjust,
retire lines) after sending; `/arm-briefs` pastes it into the cron prompts when re-arming, so the
state survives Claude session restarts. Keep it terse and factual. Dates are Pacific.

**This file supersedes the memory file `brief-routines.md` for thread state** (active threads, ledger,
probe read rules). Memory keeps lessons, plumbing history and cron ids only; when the two disagree on a
thread, this file wins.

_Last updated: 16 Sep 2026 (Sep 15 daily outcomes folded in; /arm-briefs improvements pass)._

## Probe read rules (do not remove)
- `sync_logs` failed rows reading "Abandoned — run never completed (stale started row)" = v3.8.70 deploy-hygiene labels — BENIGN when timestamps match deploys; never report as an outage.
- Failed pipeline runs with "server restarted / orphaned-run recovery" that have later completed runs = recovered, benign.
- `stale3d` is artifact-inflated (Aug-31 sync-touch cohort) — trust named lists and episodes, never the raw count.
- Probe bounces = rejected episodes ended in the window (never lifetime rejection_count).
- ws2/3/5 noise verdicts = `decision='noise_dismissed' OR non_actionable=true` (`is_noise` is NOT authoritative there).
- After-hours check = zero dismissals without `non_actionable=true` (v3.8.52, verified through Sep 15 incl. first full weekend) — any unflagged dismissal is a REGRESSION, shout.
- "Idle ticket" claims need a thread-entry check (`occurred_at`), never `updated_at` (TP-1120 lesson).
- FS-synced thread entries have `author_type` NULL; requester replies = `event_type='customer_reply'`.
- Queued runs waiting for business hours / holidays are by design; only unexplained queued/running runs are stuck.
- AP (ws2) Monday hill: read age bands, not the raw unassigned count (Sep 11: 127 unassigned, 121 < 2 d, 0 > 7 d).

## Active threads
### (a) Security
- Pentest HIGHs #241753 (ROPC → Anton) and #241754 (TLS/SSL → Muhammad), landed Sep 11, unmoved — named the natural next pull now the Monday fires are out.
- RTBT-2026 burn-down flat at 11 open + 1 pending since Aug 28 (Mehdi 7, Muhammad 3) — cyber load concentrated on three people; who-takes-what ask stands.
- CLEARED Sep 14 (mention only on relapse): #242218 CRITICAL defense-evasion (closed same-day, Anton), #241869 Darktrace 100-score (closed, Anton), #242225 suspicious-CAPTCHA report (same-day).

### (b) Hedberg BEC campaign
- #241544 spam-closed Sep 14 (day 5). Thread shifts to FOLLOW-THROUGH: the cyber-ops meeting actions (transport rule, tenant blocks of 7 domains + 2 Gmails, consolidated incident record, AP brief-in, CAFC report) need owners — ask weekly until landed.
- Briefing PDF delivered Sep 11 (`reports/Hedberg BEC Campaign - Cyber Ops Briefing (2026-09-11).pdf`, 14 instances). Watch for instance #15 (persona "Steve Hedberg", rotating lookalike domains, current pair renglobalusa.com / ren-globalusa.com).
- FALSE-POSITIVE GUARD: #241803 is a legitimate internal Stornoway-Renard retainer request — any mail/noise rule must key persona + external sender, never bare payment vocabulary. #241803 is the standing test case a rule must NOT catch.

### (c) Storage
- TP-1120: one live leg — Azure Backup `sharepointfilesy` failing daily. CORRECTION on record: never call TP-1120 idle; Anton fixed the other legs Aug 17 / Aug 25 (invisible pre-3.8.37 attribution gap).
- TP-1294 = FS #241865 (VAN-LCD1 replication failing daily since Sep 7, owner Mehdi since Sep 12, target-IP theory in the ticket).
- TOR-LIDAR1 Vol 2 "acceptable" but alarming ~6×/week — threshold-or-cleanup decision pending.

### (d) Wanderers (hand-off count — pattern lesson: every wanderer telegraphed by hand-off 3; flag then, while it's cheap)
- #242189 BGCPT Folders — 3 early hand-offs (Soheil); owner-note ask made Sep 15.
- #239678 Outlook access — Pending (Reza), parked OK.
- Fording River #241459 — Pending (Anton), third holder.
- CLOSED Sep 14: #240446 "Outlook down" after 7 hand-offs (Soheil) — keep only as the pattern lesson above.

### (e) Ledger (one quiet line; exit on state change)
Bora Yoo #241114 (Muhammad) · Fredericton #241534 (Pending, carrier decision) · rota blessing + weekend-only auto-route (AP) · Luna guardrail retry · AR graduation · GIS licence pool check (11-ticket cluster wk Sep 7, continuing; Adobe/engineering stream keeps it warm) · ws1 mailbox default group (sixth ask Sep 15) + ws5 default group (last unset).
- AP context through Fri Sep 18: Fall Board Meeting Tue–Fri — queue hands are supporting it; expect the hill (210 on Sep 15) to drain Thu–Fri, not daily.
- #242270 "Passkeys?" (ws1, open) — small ticket, roadmap-adjacent answer; pairs with the ROPC pentest work.

### (f) Simorgh
- v3.8.56–70 weekend train added the external IT-client integration (trusted intake, benign-resolve, webhooks). Note trusted-intake volume when traffic appears.

### (g) Approvals v2 + drift (new 15 Sep)
- v3.8.91/92 shipped tiered approvals (tiers, amounts + auto-escalation, forward, confirm-before-decide). Watch: first real escalation/forward, `approval.escalated` / `approval.forwarded` events, any 500 on `/ticket-approvals/public/:token/handoff`.
- Four TP-born tickets drifted from FreshService (TP-1120, TP-1235, TP-1267, TP-1284 — agents worked the FS copies). Product decision pending with Vahid: adopt FS status/assignee on TP-born tickets, or steer agents to TP. Report only; do not change behaviour.
- Per-workspace fast-sync cadence exists (Settings → Workspaces); all five workspaces still on 1 minute.

## Weekly-only carry-overs
- Standing default action: promised ticket lists — confirm prod state; if unswept AND unowned, open consolidated owned housekeeping tickets via `ticketService` (TP-1120/TP-1294 pattern; `backend/scripts/weekly-0911-housekeeping.mjs`: DATABASE_URL=prod before the service import, requester ticketpulse@, `suppressRequesterAck: true`). Document the reasoning if not opened.
- Standing risk line: Azure Backup leg of TP-1120 + TP-1294 until both stop alerting or carry accepted-risk notes.
- Accepted-risk ledger exits after the Sep 11 sweep: bank #238335 (closed, Dominic), choppy-video #240835, cambioearth #239761, Vancouver voicemail #239030.
