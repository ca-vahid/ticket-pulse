# Brief threads — living state for the daily and weekly briefs

This file is the memory the briefs carry between runs. **Every brief run updates it** (add, adjust,
retire lines) after sending; `/arm-briefs` pastes it into the cron prompts when re-arming, so the
state survives Claude session restarts. Keep it terse and factual. Dates are Pacific.

**This file supersedes the memory file `brief-routines.md` for thread state** (active threads, ledger,
probe read rules). Memory keeps lessons, plumbing history and cron ids only; when the two disagree on a
thread, this file wins.

_Last updated: 24 Sep 2026 (sent by hand ~9:30 — 8:45 cron did not fire; Parked + Pending Response shipped; follow-up outcomes)._

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

### (i) Follow-up email responses (23 Sep)
- Sep 24 outcome: Andrii DONE (closed #216841/#220915, parked transfers to Oct 5–6). Anton: closed #165792, parked #202791 to Nov 16, but #173857 DarkTrace + #228595 still NO note/park — flagged to Vahid Sep 24 to update from Anton's email or ask at standup. Next check: if still bare Fri, one quiet line only.
- IT resolved 129 vs 49 in on Sep 23 (post-email cleanup day).
- 12 personal follow-up emails went out Sep 23 (/ticket-followups). Anton and Andrii replied to Vahid BY EMAIL, not in the tickets. Vahid's call: give them until Thu morning; if the tickets still show no human note, flag it in the IT brief so Vahid updates them himself (don't nag the person).
- Anton: #165792 Group Policy Cleanup (closing it) · #173857 DarkTrace (in progress, ETA Oct 31) · #202791 Michèle Ostiguy on leave (nothing until return Nov 16) · #228595 accounting DL external access (waiting on Alexa + Kirsten).
- Andrii: #216841 + #220915 were reminder tickets (closing both) · #235207 Alyssa Sandeman + #238553 Laura Beamish transfers (nothing until Oct 5).
- Until the "Parked" feature ships, treat these as PARKED in brief counts and never call them stale: #235207/#238553 until Oct 5, #202791 until Nov 16, #173857 until Oct 31, #228595 chase ~Sep 30. Knowledge only — no stopgap code.
- "Parked" feature: plan reviewed by TP Continious Dev (plans/PARKED_TICKETS_PLAN.md, decisions block at top); they are building Part A (status binding) first. Vahid announces Parked at the Thu Sep 24 meeting. Follow-up email actions/reply-to-notes were DROPPED.
- EXPECTED METRIC SHIFT when Part A ships: 'Waiting on Customer' rows get relabelled "Pending Response" (FS status 6) and start counting in dashboard/queue open counts; FS status 7 / custom 8+ stop syncing as "Open". Read those moves as the fix, not an anomaly. TP pending-response workflows must stay OFF for FS-born tickets (FreshService owns those reminders) — flag it if one is enabled for FS-born.

### (j) Parked + Pending Response LIVE (v3.9.78 / v3.9.72, Sep 23 eve)
- 27 IT tickets parked on day one (all until_date). Probe/renderer exclude parked from open/pending/stale/review (parked_now shown faintly). Only until_date used so far — waiting_on / eta unused.
- 'Waiting on Customer' label gone → "Pending Response" (IT 1, ws2 2). TP pending-response workflows stay OFF for FS-born.
- NEW WATCH: Sentinel alert intake (v3.9.79) — new machine-alert source into IT; watch volume, point alert correlation at it.
- NEW: #243879 Mac mail blocked by new IT policies (3 bounces, Soheil) — likely legacy-auth/ROPC side effect; + #243921 MS Authenticator issues same day.

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
