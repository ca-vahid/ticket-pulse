# Brief threads — living state for the daily and weekly briefs

This file is the memory the briefs carry between runs. **Every brief run updates it** (add, adjust,
retire lines) after sending; `/arm-briefs` pastes it into the cron prompts when re-arming, so the
state survives Claude session restarts. Keep it terse and factual. Dates are Pacific.

**This file supersedes the memory file `brief-routines.md` for thread state** (active threads, ledger,
probe read rules). Memory keeps lessons, plumbing history and cron ids only; when the two disagree on a
thread, this file wins.

_Last updated: 23 Oct 2026 PM (weekly Oct 19–23 sent; cert #240981 closed as 'ready and saved' — install unconfirmed; VDV1 permanently internal; weekly cron re-armed)._

## Probe read rules (do not remove)
- Oct 23 2026: az app-settings lookup WORKS again (refused Oct 20–22). Keep the .env.prod fallback.
- Oct 20 2026: `az webapp config appsettings list` → AuthorizationFailed for vhaeri (sub 'IT Services'). The probe falls back to backend/scripts/.env.prod PROD_DATABASE_URL automatically; ad-hoc scripts: read PROD_DATABASE_URL from .env.prod. ALWAYS verify the host banner = ticket-pulse-pg. Asked Vahid whether the role change is intended (PIM?).
- 'No business hours configured for this day' = the WEEKEND queue reason (in use since Apr) — by design, not a regression (checked Oct 5).
- Oct 2 2026: agentReview urgent lane now requires status Open/Pending (Deleted RTBT tickets had leaked in as urgent_no_action). Read requester customer_reply before escalating anything (laptop false alarm).
- `sync_logs` failed rows reading "Abandoned — run never completed (stale started row)" = v3.8.70 deploy-hygiene labels — BENIGN when timestamps match deploys; never report as an outage.
- Failed pipeline runs with "server restarted / orphaned-run recovery" that have later completed runs = recovered, benign.
- `stale3d` is artifact-inflated (Aug-31 sync-touch cohort) — trust named lists and episodes, never the raw count.
- Probe bounces = rejected episodes ended in the window (never lifetime rejection_count).
- ws2/3/5 noise verdicts = `decision='noise_dismissed' OR non_actionable=true` (`is_noise` is NOT authoritative there).
- After-hours check = zero dismissals without `non_actionable=true` (v3.8.52, verified through Sep 15 incl. first full weekend) — any unflagged dismissal is a REGRESSION, shout.
- "Idle ticket" claims need a thread-entry check (`occurred_at`), never `updated_at` (TP-1120 lesson).
- FS-synced thread entries have `author_type` NULL; requester replies = `event_type='customer_reply'`.
- Queued runs waiting for business hours / holidays are by design; only unexplained queued/running runs are stuck.
- BC statutory holidays (e.g. Sep 30 Truth & Reconciliation) queue ALL pipeline runs with reason "Holiday: …" — unassigned counts spike BY DESIGN; the next business day's brief uses a 48 h window (72 h after a Monday holiday) and expects a big morning batch.
- AP (ws2) Monday hill: read age bands, not the raw unassigned count (Sep 11: 127 unassigned, 121 < 2 d, 0 > 7 d).

- NOTES GAP RESOLVED (Sep 29, dev confirmed): the FS double-check rule is RETIRED. App's own gap metric = 0 in every workspace (6-hourly log line "FS notes gap … ws1=0"). The ~385 plateau in my counter was TP's own write-back notes (activity actor "Ticket Pulse") that never return as conversations. Counter from now on: add `AND coalesce(actor_name,'') <> 'Ticket Pulse'` on the activity side → residual ~40 tickets across ws1–4 (old merges / FS-rule replies / FS-deleted notes, unclassified). Flag only if that residual GROWS. Note-based stats are trustworthy again.
- (history) NOTES GAP Sep 29: plateaued (ws1 385, ws2 488) — standup spot-check of ~60 items found NO FS-note missing in TP; asked dev to confirm the remainder is counting noise → if yes, DROP the FS double-check rule.
- NOTES GAP status Sep 28: backfill nearly done — ws1 90d gap 388 (from ~2,290), ws2 493, ws3 95, ws4 12; samples #176019/#240410/#241450 all show notes. RELAXED RULE: 90-day note stats are usable again; still FS-spot-check any ticket named individually as 'no note'. Drop entirely when ws1 90d gap < ~50.
- NOTES GAP (Sep 24, original): TP thread entries are missing FS notes/replies on ~half of FS-born tickets (IT 3,696 incomplete). Any "no action / no note / no update" claim in the brief (per-agent lanes, closure quality) must be spot-checked against FS conversations before it's stated as fact; say "per Ticket Pulse's copy" otherwise. Report: plans/FS_THREAD_SYNC_GAP_REPORT.md. Dev ACCEPTED for Sep 24 night: onFsTicketTransition on both sync paths, pull-on-change (DB-backed queue, debounced), no 60 cap, warn logs, notes-gap metric on an admin endpoint + nightly log line, backfill ws1 90d first (~3–4 h at ~20 FS calls/min, self-pausing), FS-deleted→Deleted fix (#243816), #222020 check. SHIPPED v3.9.83 (PR #452, Sep 24 18:55 PT); backfill started 19:11 PT at ~10 tickets/min. Start gaps: ws1 2,290 (90d) / 3,792 (all), ws2 3,401, ws3 693, ws4 420. ETA: ws1 90d ~23:30 PT Sep 24, ws1 all +2.5 h, ws2 +6 h, ws3/4 +2 h → done ~Fri Sep 25 afternoon. Gap metric: log line every 6 h 'FS notes gap (last 90 days, tickets): ws1=…' and GET /api/sync/fs-thread-gap?days=90|all (admin); kill switch app_settings fs_thread_backfill_enabled=false. Verify #240410 (phase 0) and #176019 (ws1-all phase) show FS notes. NOTE: preheat cursor could read 'caught up' with notes still missing (#241450) — the backfill has its own marker (tickets.fs_thread_pulled_at). #243816 was already marked Deleted 09:25 PT; #222020 closed by the 3.9.72 repair — both resolved. Sep 25 09:20: ws1 1,062 pulled (1,058 with notes — fix works) but ~1.3/min avg vs 10/min planned; #240410/#176019 NOT pulled yet; ws2 3, ws3/4 0. Asked dev about pace/off-hours cap/ordering → ANSWER: the Sep 24 night stall was Vahid's 3-year IT HISTORY IMPORT (13,604 tickets, 20:00–03:10 PT) flooding the low FS queue; 3.9.86 (05:27) made the gate trickle at depth 30–149. Nights (20:00–06:00) + weekends run up to 20/min; ws1 90-day remainder (~1,200) expected to clear ~1–2 h after 20:00 Sep 25; tonight's release widens the night gate + switches the sweep to NEWEST-FIRST. NOTE: the history import explains why ws1 gap_all jumped to ~12.5k (13.6k old tickets added) — expect the 'all time' gap to take days; judge progress on the 90-day number. WATCH: read the gap metric in sanity; report backfill progress; once ws1 gap ≈0, drop the FS spot-check rule. FS API BUDGET IS TIGHT (110/min shared; hit 109/110 in business hours) — any ad-hoc FS API checks from this session must be small and throttled (≤1 call/s), never bulk in business hours.

- RTBT-2026 Finding 1 recs #236272–#236275 + test #236197 were DELETED by Vahid (Sep 29–30) — thread closed.
- Sep 30 holiday held-for-Thursday IT tickets worth a same-day look: #244717 'Disable or locate computer' (P3, security-ish), #244718 'Tyler Southam sent a message' (P4). Check Thu they were handled. New: #244687 DC baseline remediation (Mo) no first note; KAM-DC2 #244103 quiet since Sep 24.

## Active threads
### (a) Security
- Oct 8: Cambio (Sapu, Oct 7) — swamped this week, will take BGC-AZU-DBPRD1 next week; the OTHER SQL hosts in #241754 are NOT Cambio's → need an owner on our side (Mo has context; Anton freed by ROPC). Raised at Oct 8 standup.
- Pentest HIGHs: #241753 ROPC CLOSED Oct 2 (Anton, after 7-day sign-in review). #241754 TLS/SSL (Mo) Pending on Cambio sprint planning since Sep 16 — ask for a date.
- RTBT-2026 burn-down flat at 11 open + 1 pending since Aug 28 (Mehdi 7, Muhammad 3) — cyber load concentrated on three people; who-takes-what ask stands.
- CLEARED Sep 14 (mention only on relapse): #242218 CRITICAL defense-evasion (closed same-day, Anton), #241869 Darktrace 100-score (closed, Anton), #242225 suspicious-CAPTCHA report (same-day).

### (b) Hedberg BEC campaign — NOW 17 INSTANCES
- Oct 14: #17 SPAM-CLOSED. Watch for #18 (persona/subject check).
- #17 = #246182 'FWD: CONFIDENTIAL: Retainer Billing – Executive Search Engagement - Steve Hedberg' Oct 8 06:00 PT, ws2, from jade@novus-online.com (NEW domain, outside tcg family; 7 domains total). Open, not noise as of Oct 9. Oct 8 daily wrongly said 'no #17' — corrected in weekly. Ask: spam-close + persona rule.
- Oct 2: #16 SPAM-CLOSED (day 2).
- Instance #16 = #244809 "FWD: CONFIDENTIAL: Initial Retainer Billing – Executive Search Engagement 'Steve Hedberg'" (Sep 30 12:05 PT, ws2), from christina@tcgglobal-usa.com ("Christina Graham") — NEW domain, 6th in the tcg-global lookalike family; zero-width characters between letters (same trick as #8). Open + UNASSIGNED over the holiday. Flagged Oct 1: spam-close + block domain; transport-rule argument (persona + external sender) restated. Exit when spam-closed and domain blocked.
- Instance #15 = #242789 "Outstanding Fee – Invoice 80044710620" (Sep 16, ws2), sender m@emsgdirect.com — one of the four KNOWN fake "Steve Hedberg" requester records from the PDF. Spam-marked SAME-DAY (vs 5 days for #14). Two lessons: vocabulary drifted again ("outstanding fee"), and the actor REUSES old infrastructure — the block list has real teeth.
- FOLLOW-THROUGH still needs owners (ask weekly until landed): transport rule, tenant blocks (7 domains + 2 Gmails + the 4 fake senders incl. m@emsgdirect.com), consolidated incident record, AP brief-in, CAFC report. #241544 spam-closed Sep 14.
- Briefing PDF: `reports/Hedberg BEC Campaign - Cyber Ops Briefing (2026-09-11).pdf` (14 instances; #15 above is new). Watch for #17. Oct 2: #16 still open/unassigned in ws2 (day 2).
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
- Sep 24 outcome: Andrii DONE (closed #216841/#220915; transfers were AUTO-parked to Oct 5–6 by the HR reader). Anton: closed #165792, parked #202791 to Nov 16, but #173857 DarkTrace + #228595 still NO note/park — flagged to Vahid Sep 24 to update from Anton's email or ask at standup. Next check: if still bare Fri, one quiet line only.
- IT resolved 129 vs 49 in on Sep 23 (post-email cleanup day).
- CLOSURE QUALITY — CORRECTED against FreshService (Sep 24): 89 closed → 68 real note (incl. 5 merged), 4 one-word, 8 old-note-only, 9 no note in either system. The first pass (47 'no note') was WRONG: FS notes on older tickets never reached TP threads (Mo: 20 of 24 had FS notes). READ RULE: never grade notes/closures from TP thread entries alone — check FS conversations (the Fong lesson again). Original wrong numbers for the record: 25 good note, 6 thin, 11 old-note-only, 47 NO note ever; 47 were 30d+ old (23 with no note). Heaviest silent closes: Muhammad 20/25, Sam 9/11. Security items closed silently: #190967 Sentinel↔XDR, #220917 Snaffler findings, #240410 Darktrace tuning. Vahid raising "one line when you close" at the Sep 24 meeting. Track: closure-note rate on future closes; consider making it a follow-up/brief rule.
- 12 personal follow-up emails went out Sep 23 (/ticket-followups). Anton and Andrii replied to Vahid BY EMAIL, not in the tickets. Vahid's call: give them until Thu morning; if the tickets still show no human note, flag it in the IT brief so Vahid updates them himself (don't nag the person).
- Anton: #165792 Group Policy Cleanup (closing it) · #173857 DarkTrace (in progress, ETA Oct 31) · #202791 Michèle Ostiguy on leave (nothing until return Nov 16) · #228595 accounting DL external access (waiting on Alexa + Kirsten).
- Andrii: #216841 + #220915 were reminder tickets (closing both) · #235207 Alyssa Sandeman + #238553 Laura Beamish transfers (nothing until Oct 5).
- Until the "Parked" feature ships, treat these as PARKED in brief counts and never call them stale: #235207/#238553 until Oct 5, #202791 until Nov 16, #173857 until Oct 31, #228595 chase ~Sep 30. Knowledge only — no stopgap code.
- "Parked" feature: plan reviewed by TP Continious Dev (plans/PARKED_TICKETS_PLAN.md, decisions block at top); they are building Part A (status binding) first. Vahid announces Parked at the Thu Sep 24 meeting. Follow-up email actions/reply-to-notes were DROPPED.
- EXPECTED METRIC SHIFT when Part A ships: 'Waiting on Customer' rows get relabelled "Pending Response" (FS status 6) and start counting in dashboard/queue open counts; FS status 7 / custom 8+ stop syncing as "Open". Read those moves as the fix, not an anomaly. TP pending-response workflows must stay OFF for FS-born tickets (FreshService owns those reminders) — flag it if one is enabled for FS-born.

### (j) Parked + Pending Response LIVE (v3.9.78 / v3.9.72, Sep 23 eve)
- 27 IT tickets parked on day one — ALL AUTO by the HR-notice reader (source suggested_hr, parked_by "Ticket Pulse (HR notice)"); NO manual parks yet. Sep 24 briefs wrongly credited the team/Andrii — corrected in the parked list email. Open question for Vahid: departures wake ON the last day (Kenneth Lockwood Sep 25) — maybe wake 1–2 days before. Probe/renderer exclude parked from open/pending/stale/review (parked_now shown faintly). Only until_date used so far — waiting_on / eta unused.
- 'Waiting on Customer' label gone → "Pending Response" (IT 1, ws2 2). TP pending-response workflows stay OFF for FS-born.
- NEW WATCH: Sentinel alert intake (v3.9.79) — new machine-alert source into IT; watch volume, point alert correlation at it.
- NEW: #243879 Mac mail blocked by new IT policies (3 bounces, Soheil) — likely legacy-auth/ROPC side effect; + #243921 MS Authenticator issues same day.

### (l) Infra alert intake — Sep 29: every open [Infra] ticket has an owner note; HV40 RAID alert CLOSED; HV41 updated by Mehdi Sep 29; TOR-HV05 (#244279, Anton) RE-OPENED after Sat close (Sentinel reopen window) — ask whether truly fixed; KAM-DC2 (#244103, Mo) no update since Sep 24. Mehdi's HV40 DIMM note: all 24 modules OK now.
### (l-sep28) Sep 28: HV40 now ALSO has a storage/RAID fault (#244288, Mehdi) next to HV41 HW fault (#244144, Mehdi) — framed as a cluster-capacity question. Closed over weekend: CAL-DC1 (#244292), TOR-HV05 (#244279), CAL-HV02 low disk (#244297). Open: KAM-DC2 AMA + VAN-HULK agent + BGC32000 expired (Mo), DTSCI11 (Mehdi).
### (l-old) (new Sep 24–25, source 106 "[Infra] …")
- First night: BGC-CAL-DC1 offline (Arc disconnected), BGC-KAM-DC2 AMA not reporting, BGC-VAN-HV41 HARDWARE FAULT (sits beside HV40 whose DIMM ticket #230045 is open since Jul — cluster health question), BGC-VAN-DTSCI11 offline, BGC32000 agent expired 45d (retired machine?), BGC-CAL-HV03 AMA. Owners asked for Sep 25. Consider alert-correlation grouping for agent-only alerts.

### (m) Parked usage (Sep 24–25)
- Manual parks began: Anton 1, Andrii 2, Marcus 3 (real reasons). HR lead-time wake shipped (departures/transfers wake days BEFORE the date — answers Vahid's Sep 24 question). 21 parked in IT on Sep 25. Anton's #173857/#228595: mentioned for the LAST time Sep 28 — retired from the brief (Vahid's to finish if he wants).

### (o-tail) Vancouver hypervisors + DC follow-ups
- VAN-HV46 hardware fault #245431 (Mehdi, since Oct 3) = 3rd VAN hypervisor alert in 2 weeks (HV40/41). FDR-DC1 'DC service not answering' #245903 Oct 6 16:31–17:01 PT, auto-resolved — likely planned DC work (stale-DC removal item 2 on #244687, still open); ask Mo one line. AD storm itself EXITED (fixed Oct 2, written up Oct 5).
### (p) AP review backlog — RE-OPENED Oct 13
- Oct 23: 277 (Fri creep again); <1d 88, 1–3d 94, 3–7d 88, >7d 7. 129 resolved Thu.
- Oct 20: 353 → 230; <1d 72, 1–3d 49, 3–7d 109, >7d 0. 199 resolved Mon. Suggest a standing Monday AP review slot + Travel auto-assign.
- Oct 19: 353; <1d 44, 1–3d 88, 3–7d 198, >7d 23. TP accept/modify decisions by PT day: Oct 14 66, Oct 15 76, Oct 16 0 (reviewers may also assign in FS — decisions undercount). Monday push + Travel/Collection auto-assign decision recommended.
- Oct 16: slipped 204 → 291 (125 in / 54 resolved Thu); age <1d 107, 1–3d 121, 3–7d 45, >7d 18. Fragile without a holiday too → auto-assign case for weekly. Recommended Fri PM review session (else Mon ~400).
- Oct 14: 345 → 240; age <1d 97, 1–3d 71, 3–7d 59, >7d 13; 24 h approved 38 / modified 28. Recovery ~48 h after a gap (2nd time). Exit when >7d tail ≤5 two days running.
- Oct 13: 345 unassigned; age <1d 57, 1–3d 55, 3–7d 171, >7d 62 (pre-holiday tail never cleared). 8 AM drain → 135 pending_review; 2 runs failed on provider error. Third post-gap backlog in two weeks → auto-assign high-acceptance categories is now the structural recommendation (agenda with AP lead).
- Oct 9: 194 unassigned going into the Thanksgiving 4-day weekend; projection ~350 Tue AM → Tuesday review push recommended. Check the 3–7d tail on Oct 13.
- 281 (Oct 2 AM) → 269 (Oct 5, 127 aged 3–7d) → 198 → 156 (Oct 7, only 2 aged 3–7d). Lesson for Thanksgiving Oct 12: review step absorbs ~2 days before aging; four-day weekend needs a Tuesday push or auto-assign of high-acceptance categories. Re-open only if 3–7d tail >30 again.
### (s) Re-routing ignores hand-back notes — PRODUCT DEFECT (Oct 8)
- Oct 20: 11 hand-backs/24 h; #247868 SplitDesktop 3 hops (Andrew: no access to SplitDesktop licensing) → 'licensing' skill suggestion.
- Oct 16: hand-backs 2 (Wed) → 9 (Thu); network/connectivity bounce (#247494 ethernet → Mehdi, #247496 BeyondTrust → Adrian). v4.2.76 allows up to 3 coordinators per group → suggest naming one for Everyone IT.
- Oct 14: 10 hand-backs in 24 h. #246812 'Claude not connecting to 365' 3 hops → Alexey closed same day (also removed ChatGPT at user request). AI-tool access = unrouted category → suggest 'AI tools' skill for licence owner (Alexey). Dev-thread send STILL awaiting Vahid's go.
- Oct 9: SYSTEMIC. Oct 8 also: #246299 modeling computer (Andrii→Alexey "This is not to Calgary team"→Mo→Reza fixed: access to BGC-VAN-MODEL2); #246305 N: drive (Soheil→Adrian→Mo→Mehdi +1 TB); #246312 N: drive dup (Mo→Andrii→Andrew→Mehdi, open — likely fixed by the 1 TB); #246331 Pembina Azure restart (Mo→Vahid→Anton rebooted). BGC1392 rebooted by Reza Oct 8. Recommended: (1) hand-back note outranks requester office on re-route, (2) 2nd hand-back → coordinator not a 3rd guess. STILL awaiting Vahid's go to send to TP Continuous Dev thread. No fix in v4.2.24–34.
- #246097 BGC1392 restart (P4, requester Bogart Mendez, Calgary; PC in Vancouver): auto-assigned Andrii (Calgary) → note "needs someone in Vancouver" + reject → re-assigned Alexey (Calgary, "you are based there") → Alexey reject Oct 8 07:02 PT: "Not sure if anyone (or even AI) is reading the notes at all" → Soheil. 17 h for a power button. Re-route pass must weight the rejecting agent's note above requester office. Offered to send to TP Continuous Dev thread (awaiting Vahid). Trust signal: answer at standup.
### (v) Long-weekend release train (v4.2.35–4.2.61, Oct 9–13)
- v4.2.37 Urgent response (rules + on-call rotation with cover) = product answer to Oct 1 holiday-hold gap → ask if ON for IT + rotation set up. v4.2.41 ticket grouping (one ticket per problem; already grouped 68 EDM alerts). Knowledge phases 1–5; phone layouts + web push; v4.2.54–56 helpdesk mailbox profile → it@bgcengineering.ca connected (4th mailbox). Re-routing hand-back fix NOT included (hand-backs 5 over the holiday).
- #241861 Teams external lockdown implemented Oct 7 14:19 PT (Vahid's own note) → close. Reid Laird (inactive) still holds #241459 + #179369 → reassign.
### (u) Comings & Goings live (v4.2.29–4.2.33, Oct 8–9)
- On/offboarding child tickets park with their family, wake 21/14 days before date, route to the office's IT people. ws1 parked 30 → 44 = the flow, not hiding. Departure notices now carry "Offboarding organised by Ticket Pulse" + child list (Vahid's overdue departure notices are bookkeeping).
### (t) ContinuIT meeting → tasks (Oct 8)
- 13 tasks 08:52 PT from ops meeting + 3 Brisbane via Reza 09:04 (source 105), owned + dated (mostly Nov 7; Brisbane Feb 18). Excluded from per-agent lists while fresh; expect bars +1–2 each (planned work). Review at next ops meeting.
### (x) Undeclared remote-access outage (Mon Oct 20, 11:28–12:21 PT)
- Oct 23: Anton closed #248086 + #248095; #248078 (GIS) still open.
- Oct 22: cause = 'DC1 domain controller', fixed (Mehdi #248098). Andrew closed #248028/#248202 via PIN→email/password RDP workaround. Anton's #248078/#248086/#248095 still open, no note — users not told. Mo #245877 (BGC2054) may be same cause → retest.
- GIS remote desktop drop (Lucy Lee #248078 'all GIS remote logins fail', Cambio Susan too), BST stopped (#248084, Mehdi fixed), VPN/RDP drops (Vicky #248086), Surrey 'bumped continuously' (Lina #248095), GWV4 (#248098, Mehdi), new-PC .rdp (#248202, Andrew), Celeste's tower (#248028, Andrew, untouched since Mon AM). Spread over Anton/Mehdi/Andrew, no shared cause written. Ask: Anton writes root cause on #248078, link others, one reply. Product idea: Urgent response rules to bundle ≥3 'kicked off' tickets/hour. Mo #245877 BGC2054 (since Oct 8) possibly related.
### (y) External security events (Oct 21)
- Oct 22: RESPONSE DONE. #248224 (Anton table): BGC-VAN-VDV1 (Vista Data Vision) PHP 8.1.14 EOL, public 443 any source, ~3,500 public IPs/30 d → Mehdi paused firewall forward, verified unreachable; BGC-VAN-WEBSVR1 PHP 7.0.9 + 5.3.28 in IIS, public 443, no PHP use in 90 d → Vahid disabled PHP in IIS; BGC-VAN-GEOINT1 PHP 8.2.28 (inventoried). Bryan → Melissa → WordZite to patch WordPress (bgcengineering.ca). BambooHR back online Oct 21 11:00 PT. Open: #248391 VDV1 decision (upgrade vs internal-only, Mehdi). Exit after VDV1 decided.
- BambooHR offline over a security threat (#248183/#248196, Reza; Bryan: 'pretty serious threat'). CCCS threat-intel site offline over newly exploitable PHP vuln (#248224 Neville → Anton, no touch). Asks: PHP exposure inventory (Cambio sites, WordPress, vendor portals); does BambooHR outage affect C&G HR-notice feed; all-staff line.
### (w) Infra monitor misclassification (Oct 17–19)
- Oct 20: #247718 bundle CLOSED (Anton). EDM-HV02 #247659 closed (target rebooted). NEW: BGC-CAL-DC1 'DC service not answering' #247863 + 'not monitored (no Azure Arc)' merged (Mehdi, open). VAN-HV41 CMOS #247689 no note. Cambio certs #247798 → Sapu, closed.
- Sat Oct 17 ~05:00 PT: 'Storage / RAID hardware fault' on 9 servers (VAN-HV32/41/42/43/52, EDM-HV02/03, KAM-HV02, CAL-HV03) bundled into #247718 (TP-10202, Anton) by v4.2.88 burst bundling. Anton Oct 19: trigger = Microsoft-Windows-Time-Service event 129 (same ID as storport reset) — time hierarchy NT5DS + secure channel OK, no bad blocks. Recommend: monitor rule must key on provider+ID. Ask Mo why time-service warned fleet-wide (post DC time remediation). Real item: VAN-HV41 CMOS battery error #247689 (Mehdi). EDM-HV02 2 more RR failures Sat (network) #247659 (Anton).
### (r) SSL certificate ownership + Mehdi concentration (Oct 7)
- Oct 19: NEW [Cert Monitor] tickets #247798/#247799 — cambioearth.com + www expire 2026-11-30 (issuer WE1), → Mehdi; forward to Cambio (Sapu). Our wildcard #240981 still undated.
- Oct 12: GoDaddy 'SSL Certificate Subscription Renewal' #246689 + 'Your new SSL Certificate is ready' #246690 (unassigned, holiday-held). Now 4 cert tickets (#240981, #245983 Vahid, #246689, #246690), no confirmed install. Ask Tue standup: one owner, merge, install date.
- Oct 16: COL #246587 CLOSED, no failures in 24 h. Cert: #246690 closed ('already shared it with Sapu'); #240981 Mehdi 'we will need to schedule to install it' — no date. BGC-AZU-DC1 DC-service blip #247459 auto-closed.
- Oct 15: EDM #246531 CLOSED by Vahid ('resolved by rebooting the server'; cause RPC server unavailable). COL-FILE2 failed 3 more times overnight (timeout 600 s), #246587 still UNASSIGNED day 5. Kamloops firewall #244074 CLOSED ('replaced by Syd'). Brisbane network #246725: Mehdi engaged Smile IT. DigiCert #245983 = SAP Concur forward → Deleted (correct).
- Oct 14: EDM silent since Sun 20:00 PT but #246531 (Vahid) has no note — unconfirmed. COL-FILE2 #246587 failed 2nd time Oct 13 11:20, still unassigned. TP-1766 day 12. Kamloops firewall swap #244074 (Mehdi, ContinuIT plan) due Oct 24, no note. Mehdi holds 4 of 5 open infra items → priorities chat recommended.
- Oct 13: EDM-HV02 Rapid Recovery = 53x EDM-FILE3 + 15x EDM-DC3 'Transfer has failed' Fri 17:00 → Sun 20:00 PT, grouped into #246531 (now VAHID). Silent since Sun evening — recovered or stopped running? COL-FILE2 #246587 single, unassigned. Recommended: verify last night's EDM transfers; name ONE backup owner (EDM, COL, TP-1766). Related: Alexey #195054 EDM-DC3/FILE3 licensing (pending since Oct 2025).
- Oct 13: #246689 closed itself; #246690 → Mehdi (merge into #240981 + install date).
- Oct 12 NEW backup thread: Rapid Recovery 'Transfer has failed' BGC-EDM-DC3 on EDM-HV02 (#246531, Fri 18:00 MT) and 'Volume transfer has failed' BGC-COL-FILE2 on COL-HV01 (#246587, Sat 12:20 MT), both unassigned/held. Check next transfers Tue; if repeat → storage owner with TP-1766.
- Oct 8: #245983 DigiCert now assigned to VAHID. #240981 wildcard still no note. #245867 W: drive CLOSED (Andrii); #245961 BST CLOSED (Mehdi, service restart). TP-1766 day 6 no note.
- #245983 DigiCert 'CTE API SSL certificate' notice (Oct 7) → Anton noted "not to me or to Calgary" (bounce risk). #240981 GoDaddy wildcard *.bgcengineering.ca reissue (Mehdi) ready since Sep 7, overdue since Sep 26, NO note. Ask: name one cert owner (Mehdi natural), route #245983, confirm wildcard installed, recurring expiry check. Exit when owned + noted.
- Mehdi concentration: #245867 W: drive access (UNASSIGNED after first agent lacked security-tab rights), #245961 BST prebill/invoicing/bank recs (Accounting month-end, 2 reboots failed), TP-1766 (day 5 no note), HV46. Coaching/structural: second person with file-share security-group rights.
- #245974 Teams search bounced 2x (Soheil now) — wanderer watch.
### (q) Small loose ends (Oct 6)
- Oct 16: #246387 moved to Pending, still no note.
- Oct 15: #246387 1Password Enterprise renewal (Alexey) — subject 'Renewal locks on 13 October 2026', no note; TP due Oct 30 → check renewal status. #241861 Teams lockdown CLOSED. Vahid queue down to 1 (#174096).
- Oct 7: MikroTik serial (#245402) still not posted.
- #245402 year-end serials (Reza): 2 of 3 posted (ECS-Core); MikroTik CRS812 missing, Accounting date was Oct 5.
- #240709 Dec printer lease (Gaby) — waiting on VAHID per note; raised at Oct 6 standup.
- #245159 On-Leave notice ws1 sat in pending_review since Oct 2 (unassigned) — minor.
### (k) TO FIX LATER
- Oct 5: FS-deleted ticket handling SHIPPED — v4.1.41 delete FS tickets from TP (+bulk), v4.1.42 FS-trashed tickets marked when opened. Retire the #243816-style item once confirmed in use. (Vahid, Sep 24)
- FS notes on OLDER tickets don't reach TP threads (thread hydration at resolution isn't covering them): 47 of 64 flagged closes had FS notes TP never saw. Raise with the dev team.
- FS deletions don't sync back:
- #243816 "Keeping our IT tickets up to date" (Vahid) was DELETED in FreshService but still shows Open + overdue in Ticket Pulse's Tickets page (Overdue + assignee filter showed 4 instead of 3). Same family as the #222020 closed-in-FS drift and the known FS record-deletion gap (memory ap-category-reorg). Ask the dev team: detect FS 404/deleted on reconcile and mark the TP row Deleted. Until fixed, brief counts must not trust a single oddball overdue on a freshly-touched ticket.

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
- Oct 19–23 memo: IT 382 new / 401 resolved, 0 unassigned all week. AP 525 / 598; 353 Mon → 230 Tue → ~296 Fri (Mon push / Thu–Fri creep rhythm). Hand-backs 38/19/47/27/40 (33 tickets). Incidents: PHP exposure closed in a day (VDV1 permanently internal per Mehdi Oct 23; WEBSVR1 PHP disabled; WordPress patched via WordZite); Mon remote outage = DC1 (6 tickets/3 people, no bundling) → product ask: user-reported outage bundling in Urgent response; Sat 9-server RAID = time-service misclassification. AP accept 30 d: Travel 79%, Vendor Invoices 53%. Per-agent: Mo 3 new (reduced availability?); Sam 15 pending, 7 new / 2 resolved, oldest 455 d → re-dating session. 38 releases v4.2.78–4.3.14.
- Product asks awaiting Vahid's go for the dev thread: (1) re-route reads hand-back note; (2) user-reported outage bundling (≥3 'can't connect' in an hour → one incident).
- Oct 12–16 memo (4-day week): IT 295 new / 344 resolved. AP 525 new / 453 resolved; 345 → 204 (Wed) → ~330 (Fri) after light Thu. Hand-backs 47 → 27 (21 tickets; Andrii 9). Closed: TP-1766 (root cause), Kamloops FW, EDM + COL backups, Hedberg #17. Per-agent: Mo 0 new / 6 resolved (away?); Sam 6 overdue + 12 pending flat 3 weeks (oldest 448 d) → pre-Fredericton session; Marcus parked 10 (C&G). 44 releases v4.2.35–4.2.77.
- AP ACCEPTANCE BY CATEGORY (30 d, approved vs modified): Travel & Accommodation 120/27 (82%), Collection Notes 15/3 (83%), Vendor Invoices 113/112 (50%), Statements 23/32, Payment Processing 26/28, Facilities 12/25. → CORRECTED recommendation: auto-assign Travel + Collection Notes only; Vendor Invoices stays in review; ask AP lead for the invoice re-assignment rule. Earlier briefs (Oct 5–16) said 'vendor invoices and travel' — superseded.
- Oct 5–9 memo: IT 312 new / 288 resolved, 0 unassigned all week. AP 585 new / 722 resolved; aged tail 127 → ~0; Fri ~200 → Thanksgiving projection ~350 Tue. IT hand-backs by week 28/18/38/19/46 (34 tickets) — 5-wk high, mostly re-route-ignores-note; Andrii 13 hand-backs (Calgary-office routing, not his work). Mo AD close = model; Mehdi specialist queue (cert #240981, TP-1766 day 7/135 alerts, HV46) no notes → 1:1 priorities suggested. Sam pending 12 flat 2 weeks (oldest 441 d) → Fredericton visit moment. 48 releases v4.1.39–4.2.34 (Availability, Comings & Goings, ContinuIT office requesters, FS delete). 2nd /ticket-followups round now a week late.
- PROBE READ RULE (Oct 9): Hedberg check must be persona/subject-based ("Hedberg", "Retainer Billing", "Executive Search"), not tcg-domain only — #17 came from novus-online.com and was missed in the Oct 8 brief.
- Sep 28–Oct 2 memo: short week (Sep 30 holiday). IT 219 new / 220 resolved, 0 unassigned. ROPC #241753 CLOSED Oct 2 (Anton); TLS/SSL #241754 (Mo) last pentest item, pending Cambio sprint date since Sep 16. Mo's #244687 got a real write-up Oct 2: time sync fixed on 15 DCs; stale-DC removal (FDR-DC2/EDM-DC2/KAM-DC1) approved by Vahid → expected root of AD integrity errors; watch the 5 integrity tickets close mid-week, else real fault. AP review pile 281 (Fri AM) → 186 (PM); Thanksgiving Oct 12 = next long-weekend test. Two corrections owned (laptop false alarm, Deleted tickets in probe). Per-agent: Mo heaviest open load (9 overdue = machine-dated AD alerts); pending piles Gaby 19 / Marcus 13 / Vahid 21 (old departure notices). 39 releases v4.1.00–4.1.38. Next: /ticket-followups ~Wed Oct 7.
- Oct 6: TP-1766 still no note (alert day 131).
- TP-1766 = FS #245376, auto-assigned Mehdi; no note by Oct 5 (alerts continued Sat/Sun, 130 days). Expect first note by Wed Oct 7.
- STANDING DEFAULT ACTION used Oct 2: opened TP-1766 "Azure Backup failing daily for sharepointfilesync01 since May 28 (128 alerts, consolidated)" via ticketService (pipeline assigns). Track owner + first note.
- Sep 21–25 memo: IT 385 resolved / 291 new; team overdue fell from dozens to 6 (none >2 — Vahid 2; Mo 10→0, Sam 5→1, Gaby 3→0) after the Sep 23 follow-ups; closure review (FS-checked) 68/89 real notes; notes-gap discovery + fix; Parked idea→daily use in 3 days; Sentinel/[Infra] intake found CAL-DC1/KAM-DC2/VAN-HV41. Per-agent weight now: open work Mehdi 17 / Mo 16 / Anton 13; pending piles Gaby 19 / Marcus 17; Andrii mostly parked. Recommended a 2nd /ticket-followups run ~Oct 7 (fortnightly), not sooner. Standing risk now includes the HV40+HV41 cluster (two unhealthy hosts).
- Sep 14–18 memo highlights (context for next week): 70 releases (v3.8.81→3.9.43); AP board week 551 in/551 out; two failed runs all week (both auto-recovered); "excellent at fires, stuck on projects" pattern named re pentest HIGHs + RTBT; no housekeeping ticket opened (all alert streams owned — bar is unowned+unswept); v3.9.42 = readonly observers actually see Dashboard/Analytics (Bryan Baker role now delivers).
- Standing default action: promised ticket lists — confirm prod state; if unswept AND unowned, open consolidated owned housekeeping tickets via `ticketService` (TP-1120/TP-1294 pattern; `backend/scripts/weekly-0911-housekeeping.mjs`: DATABASE_URL=prod before the service import, requester ticketpulse@, `suppressRequesterAck: true`). Document the reasoning if not opened.
- Standing risk line (Oct 23): wildcard cert #240981 CLOSED Oct 23 by Mehdi 'the cert is ready and saved here P:\Cert\Cert_Star\CA\2026' — INSTALL NOT CONFIRMED; pentest TLS/SSL our-side hosts unowned; 1Password #246387 Pending no note (day 11). PHP exposure EXITED.
- Standing risk line (Oct 16): cert #240981 install unscheduled; pentest TLS/SSL our-side hosts unowned; 1Password Enterprise renewal (#246387) Pending w/o note, vendor 'locks Oct 13'.
- Standing risk line (Oct 15): TP-1766 EXITED — Mehdi Oct 14: storage account sharepointfilesync01 (DMI-prod-rg) deleted 2026-05-28 but its Azure Files backup item ('projectcontent') never removed from vault BGC-VAULT-DEVIT (CAMBIOBGC-PROD-RG); removed (one expected 'delete backup data' alert, merged). Lesson: decommission checklist must remove backup items. Remaining risk: COL-FILE2 backups (#246587 unassigned), cert install (#240981/#246690), pentest TLS hosts.
- Standing risk line (Oct 9): TP-1766 Azure Backup (135 days, no note after a week); wildcard cert #240981 unconfirmed since Sep 7; pentest TLS/SSL hosts mostly ours (Cambio = DBPRD1 only).
- Standing risk line (Oct 2): Azure Backup sharepointfilesync01 (TP-1766) until alerts stop or a written retire decision. TP-1294/LCD1 EXITED (fixed Sep 23 by Mehdi, quiet since). New: RAID fault KAM-HV02 #245153 (Anton, open); VAN-HV33 #245317 closed same day (Mehdi).
- Accepted-risk ledger exits after the Sep 11 sweep: bank #238335 (closed, Dominic), choppy-video #240835, cambioearth #239761, Vancouver voicemail #239030.
