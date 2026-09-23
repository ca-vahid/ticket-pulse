# Brief threads — living state for the daily and weekly briefs

This file is the memory the briefs carry between runs. **Every brief run updates it** (add, adjust,
retire lines) after sending; `/arm-briefs` pastes it into the cron prompts when re-arming, so the
state survives Claude session restarts. Keep it terse and factual. Dates are Pacific.

**This file supersedes the memory file `brief-routines.md` for thread state** (active threads, ledger,
probe read rules). Memory keeps lessons, plumbing history and cron ids only; when the two disagree on a
thread, this file wins.

_Last updated: 23 Sep 2026 (per-agent review debuted compact; hulk CLOSED via decision playbook; two new P4s; Thu = first full standup edition)._

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

### (b) Hedberg BEC campaign — NOW 15 INSTANCES
- Instance #15 = #242789 "Outstanding Fee – Invoice 80044710620" (Sep 16, ws2), sender m@emsgdirect.com — one of the four KNOWN fake "Steve Hedberg" requester records from the PDF. Spam-marked SAME-DAY (vs 5 days for #14). Two lessons: vocabulary drifted again ("outstanding fee"), and the actor REUSES old infrastructure — the block list has real teeth.
- FOLLOW-THROUGH still needs owners (ask weekly until landed): transport rule, tenant blocks (7 domains + 2 Gmails + the 4 fake senders incl. m@emsgdirect.com), consolidated incident record, AP brief-in, CAFC report. #241544 spam-closed Sep 14.
- Briefing PDF: `reports/Hedberg BEC Campaign - Cyber Ops Briefing (2026-09-11).pdf` (14 instances; #15 above is new). Watch for #16.
- FALSE-POSITIVE GUARD: #241803 is a legitimate internal Stornoway-Renard retainer request — any mail/noise rule must key persona + external sender, never bare payment vocabulary. #241803 is the standing test case a rule must NOT catch.

### (c) Storage
- TP-1120: one live leg — Azure Backup `sharepointfilesy` failing daily. CORRECTION on record: never call TP-1120 idle; Anton fixed the other legs Aug 17 / Aug 25 (invisible pre-3.8.37 attribution gap).
- TP-1294 = FS #241865 (VAN-LCD1, Mehdi): RELAPSED — 9 alerts over the Sep 19–20 weekend after two quiet days. Intermittent, so NOT the target-IP alone (a wrong IP fails every run); something stateful (destination availability / queue / network flap). Diagnostic: diff succeeded-vs-failed run timestamps against destination logs. NEW READ RULE: quiet days prove nothing until THREE consecutive.
- TOR-LIDAR1 Vol 2: alarm RETURNED Sep 18 after exactly one quiet day — Wednesday was coincidence, not cleanup; threshold-or-cleanup decision back on the table.

### (d) Wanderers (hand-off count — pattern lesson: every wanderer telegraphed by hand-off 3; flag then, while it's cheap)
- DECISION-TICKET LANE: playbook PROVEN Sep 22 — #243374 hulk decided, handed to Mehdi, closed same-day. #242774 Ring Camera (day 8, Vahid) is the remaining test; apply the same playbook.
- #239678 Outlook access — Pending (Reza), parked OK.
- Fording River #241459 — Pending (Anton), third holder.
- CLOSED: #240446 "Outlook down" (7 hand-offs, Sep 14); #242189 BGCPT Folders (Sep 16 — FIRST CLEAN SAVE for the hand-off-3 flag: flagged Mon, owner-noted Tue, closed Wed).

### (e) Ledger (one quiet line; exit on state change)
Bora Yoo #241114 (Muhammad) · Fredericton #241534 (Pending, carrier decision) · rota blessing + weekend-only auto-route (AP) · Luna guardrail retry · AR graduation · GIS licence pool check (GPS Pathfinder Sep 16; stream continuing) · ws1 mailbox default group (seventh ask Sep 17) + ws5 default group (last unset).
- AP board week resolved EARLY: hill 210 → 66 by Sep 17 (61 < 2 d, 0 > 7 d) mid-meeting — recognition-worthy.
- #242270 "Passkeys?" → Waiting on Customer (Anton) — parked OK; pairs with ROPC work.
- H&S non-zero unassigned Sep 17–18 was morning-queue flow both days, not backlog — softened; drop unless multi-day carryover appears.
- Pentest HIGHs #241753/#241754 finished week one unmoved: calendar-block suggestion (half-day each, noted in ticket) — track uptake; ROPC pairs naturally with the Passkeys question.
- #242963 Rachel Sutherland new-hire build (Adrian) — hire-date deadline; confirm date is in-thread.
- #243247 crashing-laptop P4 — Pending with Reza (parked mid-diagnosis, OK).
- #243704 Kelowna firewall coordination — scheduled-infra; date-in-thread ask made Sep 23.
- PER-AGENT REVIEW notables (first pass Sep 23, raise Thu): Andrew's #204686 New Hire Devansh Babla P1 pending since MAY (close/re-scope); Stephen's #199582 stock-room access due Dec 2025 = oldest overdue in ws1; Mehdi's #238939 "Weird" (retitle); Vahid's own queue = largest review pile (6 untouched urgents +49, top #241861 Teams allow-list); Sam's overdue tail (+20) second-largest; excluded-as-explained: Reid #179369, Susan QA-test.
- #243775 P4 email-search (Reza, Sep 23 AM) + #243678 P4 laptop-no-internet (unowned Sep 23 AM) — track to close.
- CLOSED/RESOLVED Sep 22: #243458 Outlook Glitch (Soheil, at hand-off two — no wanderer).
- #243396 BeyondTrust/PowerShell policy hardening — proactive security lane, good sign; no chase needed.
- H&S HASP burst = Banyan/AurMac 2026 geotech ramp — expect elevated HASP volume for weeks (normal).
- #242950 screen-lock — Pending (Marcus), single report; second report ⇒ GPO/policy push.
- CLOSED Sep 19–20: #242898 GWV4 (Reza — early owner note worked), #242984 laptop bounce (Adrian), #242803 iPad erase (Marcus).

### (f) External integrations (Simorgh + ContinuIT)
- Simorgh: v3.8.56–70 base + v3.9.50–52 SOC relations Phases A/B (relation/task webhooks, FS-side closes delivered). Note trusted-intake volume when traffic appears.
- ContinuIT LIVE Sat Sep 19 (v3.9.53–55, source 105): dead-webhook issue RESOLVED within a day (0 new dead in 24h by Sep 22, 430 successes) — watch drops to routine; mention only on new dead deliveries.

### (h) Platform reliability
- Drain thread RETIRED Sep 21: first Monday 8 AM drain under the v3.9.34 concurrency bound ran 20/20 clean. Mention only on relapse.
- Alert correlation shipped Sun Sep 20 (v3.9.60/61 — pair rules + storm grouping for machine alerts; the July "noise digest" idea). Suggested first customer: the storage family (LCD1 / Azure Backup / TOR-LIDAR1).
- fetickets@bgcengineering.ca connected (3rd mailbox, Field Equipment) — already producing GROUPLESS tickets (#243022 real). Default-group ask made Sep 18 day one; one Settings visit fixes fetickets@ + ws1 (7th ask) + ws5.
- Reply-lane expansion v3.9.28–30 (FS-born replies from TP per-workspace, attribution fallback, agent inbox copies) — all off by default; watch first workspace that enables one.

### (g) Approvals v2 + drift (new 15 Sep)
- v3.8.91/92 shipped tiered approvals; v3.9.20–22 (Sep 16–17) added the approvals redesign (filters, CSV, one-call resubmission) and the NAMED-APPROVER rule (only the named approver decides; approvers resolve to people). Watch: first real escalation/forward, `approval.escalated` / `approval.forwarded` events, any 500 on `/ticket-approvals/public/:token/handoff`, and any friction reports from the named-approver tightening.
- v3.9 UI generation shipped Sep 16 (~30 releases, v3.8.96–3.9.22): search v3, rebuilt ticket header/page, full-width + density, motion preference. Expect user feedback tickets referencing the new UI; route as product feedback, not incidents.
- Four TP-born tickets drifted from FreshService (TP-1120, TP-1235, TP-1267, TP-1284 — agents worked the FS copies). Product decision pending with Vahid: adopt FS status/assignee on TP-born tickets, or steer agents to TP. Report only; do not change behaviour.
- Per-workspace fast-sync cadence exists (Settings → Workspaces); all five workspaces still on 1 minute.

## Weekly-only carry-overs
- Sep 14–18 memo highlights (context for next week): 70 releases (v3.8.81→3.9.43); AP board week 551 in/551 out; two failed runs all week (both auto-recovered); "excellent at fires, stuck on projects" pattern named re pentest HIGHs + RTBT; no housekeeping ticket opened (all alert streams owned — bar is unowned+unswept); v3.9.42 = readonly observers actually see Dashboard/Analytics (Bryan Baker role now delivers).
- Standing default action: promised ticket lists — confirm prod state; if unswept AND unowned, open consolidated owned housekeeping tickets via `ticketService` (TP-1120/TP-1294 pattern; `backend/scripts/weekly-0911-housekeeping.mjs`: DATABASE_URL=prod before the service import, requester ticketpulse@, `suppressRequesterAck: true`). Document the reasoning if not opened.
- Standing risk line: Azure Backup leg of TP-1120 + TP-1294 until both stop alerting or carry accepted-risk notes.
- Accepted-risk ledger exits after the Sep 11 sweep: bank #238335 (closed, Dominic), choppy-video #240835, cambioearth #239761, Vancouver voicemail #239030.
