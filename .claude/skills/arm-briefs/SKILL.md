---
name: arm-briefs
description: Re-arm the Ticket Pulse daily (weekdays 8:45 AM PT, Global + IT memos with per-agent standup prep — comprehensive on Tue/Thu) and weekly (Fridays 2 PM PT, with per-agent stats overview) insight-brief cron jobs in the current Claude Code session after a restart — verifies the helpers, prod access and SendGrid key, builds the prompts from briefs/BRIEF_THREADS.md, creates the session crons and reports their expiry. Use when Vahid types /arm-briefs [daily|weekly|both] [status] [dry] [to:<email>].
argument-hint: [daily|weekly|both] [status] [dry] [to:<email,email>]
---

# /arm-briefs — put the daily and weekly briefs back on the clock

The briefs are **session cron jobs** (CronCreate), not cloud routines (the cloud routine never delivered
e-mail — see memory `brief-routines`). They die when the Claude Code session closes and auto-expire 7 days
after creation. This skill makes re-arming a one-liner from ANY session in this worktree
(`C:\Cursor\ticket-pulse-design`). All times are Pacific (America/Vancouver); cron expressions are local time.

## 0. Parse the prompt
- `daily` | `weekly` | `both` (default `both`).
- `status` → only list the current brief crons (CronList) and their expiry; arm nothing.
- `dry` → do every check and print the two prompts, but do not create crons.
- `to:<email[,email]>` → recipient override passed to the send helper (default vhaeri@bgcengineering.ca — Vahid only).

## 1. Pre-flight (all must pass; fix what you can, otherwise stop and say what is missing)
1. **Duplicates and zombies.** `CronList`. If a brief cron already exists in THIS session (prompt starts with `Daily Ticket Pulse briefs` /
   `Weekly Ticket Pulse Insights`), delete it (`CronDelete`) before creating the replacement — never two of a kind.
   Also delete any brief cron whose creation + 7 days is already in the past even though it is still listed —
   expiry is not reliably enforced (16 Sep 2026: a Sep-4 weekly was still listed and still firing on Sep 16,
   which is what caused the double-payload firings). Warn if another Claude session may still hold live brief
   crons (the July–September ones lived in the `ticket-pulse.cursor` session): two sessions armed = two e-mails per brief.
2. **Helpers present** (tracked in git since 15 Sep 2026):
   - `backend/scripts/daily-brief-probe.mjs` — read-only prod probe. Needs `DATABASE_URL` (prod) in the environment or
     `backend/scripts/.env.prod` (`PROD_DATABASE_URL=…`, gitignored). Writes `daily-data.json` to `BRIEF_OUT_DIR`.
     Emits `agentReview` (ws1: per-agent discussion items in three lanes — urgent_no_action / overdue / stale_pending,
     capped 6 per agent with a `truncated` marker) and `agentStats` (ws1: per-agent assigned_new / resolved / open_now /
     overdue_now / pending_now / oldest_open_days). Prints its DB host to stderr — VERIFY it says
     `ticket-pulse-pg.postgres…` and not localhost: the user's shell profile exports a dev `DATABASE_URL`, which
     silently wins over `.env.prod` if the prod URL isn't passed explicitly (22 Sep 2026 lesson).
   - `qa/tools/send-brief.mjs` — SendGrid sender (`"<subject>" <html> [--to …]`); key from `SENDGRID_API_KEY`, else
     `backend/.env` `SMTP_PASSWORD`, else the app setting via `az`. Exits 1 unless SendGrid returns 202.
   - `backend/scripts/weekly-0911-housekeeping.mjs` — the ticket-creation recipe the weekly's standing default action uses.
3. **Prod access.** `az webapp config appsettings list -n ticket-pulse-app -g ticket-pulse-rg --query "[?name=='DATABASE_URL'].value | [0]" -o tsv`
   must return a value (never echo it). Run the probe once with a 1-hour window to prove the lane:
   `cd backend && DATABASE_URL="$(az … -o tsv)" BRIEF_OUT_DIR=<scratchpad> node scripts/daily-brief-probe.mjs 1` — expect a
   digest and `daily-data.json`. Delete the JSON afterwards.
4. **Mail.** `node qa/tools/send-brief.mjs` must find a key (run it with a missing file to see the key check pass and the
   file check fail; do NOT send a test e-mail unless the prompt says `test`).
5. **Thread state.** `briefs/BRIEF_THREADS.md` exists and its `_Last updated_` line is within 7 days. If older, say so and
   still arm (the first brief refreshes it), but warn that the threads may be stale.
6. **Memory format.** Re-read memory `brief-format-preference` (insight memos, never stats tables) so the prompts stay right.

## 2. Build the prompts
The prompts stay SMALL and topic-free: thread state is NOT pasted in. Each firing reads
`briefs/BRIEF_THREADS.md` fresh (the file is tracked and every brief run updates it), so threads added or
retired mid-week reach the very next brief without re-arming — and no campaign or ticket names get frozen
into a cron prompt. Fill the scratchpad path where `{{SCRATCH}}` appears and the recipient override (if any)
as `--to …` on the send commands. Compute and fill the date placeholders: `{{TODAY}}` = today's date,
`{{LAST_DAILY}}` = the last weekday on or before today + 7 days, `{{NEXT_FRIDAY}}` = the next Friday the
weekly will actually fire (a Friday creation after 2 PM fires the following Friday). Never leave a `{{…}}`
token in a created cron prompt.

### Daily (cron `45 8 * * 1-5`, recurring)
```
Daily Ticket Pulse briefs (insight format — memory: brief-format-preference). Recipient: Vahid only.
(1) From C:/Cursor/ticket-pulse-design/backend run `DATABASE_URL="$(az webapp config appsettings list -n ticket-pulse-app -g ticket-pulse-rg --query "[?name=='DATABASE_URL'].value | [0]" -o tsv)" BRIEF_OUT_DIR="{{SCRATCH}}" node scripts/daily-brief-probe.mjs 24` (use 72 on Mondays, or after a BC statutory holiday). Never echo the URL.
(2) Read C:/Cursor/ticket-pulse-design/briefs/BRIEF_THREADS.md NOW — it is the living thread state (probe read rules, active threads, ledger). Keep the probe read rules, carry the threads, exit lines on state change. If the file is missing or its _Last updated_ line is older than 14 days, say so in the memo footer and proceed on sanity + fresh analysis only. Analyze as the analyst — compare against the prior briefs and that state. Investigate anything broken in the sanity block before writing; fix only if certain and safe, otherwise recommend.
(3) Write TWO self-contained HTML memos in {{SCRATCH}}: brief-global-<YYYY-MM-DD>.html (platform-health TL;DR first, every workspace, workspaces never blended) and brief-it-<YYYY-MM-DD>.html (ws1 deep dive). TL;DR → numbered findings (evidence + so-what + recommendation) → wins / watchlist. NO stats tables. Team-safe framing (balance and coaching signals, never leaderboards). Track improved/recurred; no template rot. Header bands must be solid `bgcolor` cells, never CSS gradients (Outlook drops them).
(3b) IT memo — PER-AGENT REVIEW section, from the probe's `agentReview` (ws1). This is Vahid's standup prep: the tickets to raise with each person. Three lanes: urgent_no_action (P3/P4 with zero agent activity), overdue (Open past dueBy — judge the last-note snippet: a real explanation means SKIP it, machine notes like "[Ticket Pulse] Assignment auto-assigned" do NOT count), stale_pending (Pending 5+ days without agent content).

**LAYOUT IS RENDERED, NOT HAND-WRITTEN (Vahid chose it 23 Sep 2026 after three rounds: "overdue inside the bar" workload table on top + the one-row-per-ticket table below; no pills, priority spelled out Urgent/High/Medium).** Run
`python C:/Cursor/ticket-pulse-design/briefs/agent_section.py {{SCRATCH}}/daily-data.json [--standup] --exclude <fs,fs> [--asks {{SCRATCH}}/asks.json]`
and paste its HTML output VERBATIM as the IT memo's per-agent section (under a short heading and one or two sentences of your read). `--standup` on Tue and Thu (the team's standup mornings: up to 4 tickets per person); other days omit it (one pressing ticket per person). YOUR JUDGMENT goes in the flags, not the markup: `--exclude` = FS numbers whose own last note already explains them (they are footnoted, never silently dropped); `--asks` = a JSON {"<fs>": "ask"} only where a ticket-specific ask beats the lane default. Never restyle the output. What it renders: bar per person (red overdue slice, blue open on time, grey pending, all on one scale), every name/number a Ticket Pulse deep link (?assignee=<id>&status=Open|Pending, segment=overdue…), alphabetical with Vahid's queue last, inactive people holding tickets flagged "needs reassigning", people with nothing open omitted. Team-safe framing in your prose around it: a discussion agenda, not a scoreboard.
(4) Send: `node C:/Cursor/ticket-pulse-design/qa/tools/send-brief.mjs "Ticket Pulse Daily Brief (Global) — <Mon DD>" <global.html>` then the IT one with "(IT)". Verify 202 each; retry once; report loudly on failure. If a brief for today was already sent (double fire after sleep/wake), verify health quickly and SKIP — never duplicate.
(5) Update C:/Cursor/ticket-pulse-design/briefs/BRIEF_THREADS.md: adjust/retire threads, add new ones, bump the `_Last updated_` line. Do not commit — /arm-briefs commits it when re-arming.
(6) Expiry: this cron auto-expires 7 days after creation (created {{TODAY}}, last weekday firing {{LAST_DAILY}}). In the final brief before expiry warn Vahid, and immediately after the final firing re-arm the daily cron by running the /arm-briefs steps (daily) with the updated thread file. Mention the re-arm status in the memo footer.
```

### Weekly (cron `2 14 * * 5`, recurring — ~2 PM Friday: late enough to cover most of the week, early enough that people still read it; the off-minute dodges the top-of-hour spike)
```
Weekly Ticket Pulse Insights (Mon–Fri of the current week, sent Friday ~2 PM PT). Recipient: Vahid only.
If a weekly memo for this week was already sent (double fire after sleep/wake, or a zombie cron), verify health quickly and SKIP — never duplicate.
Read C:/Cursor/ticket-pulse-design/briefs/BRIEF_THREADS.md NOW — it is the living thread state, including the weekly-only carry-overs and the standing default action. If it is missing or its _Last updated_ line is older than 14 days, say so in the memo and proceed on sanity + fresh analysis only.
From C:/Cursor/ticket-pulse-design/backend run `DATABASE_URL="$(az webapp config appsettings list -n ticket-pulse-app -g ticket-pulse-rg --query "[?name=='DATABASE_URL'].value | [0]" -o tsv)" BRIEF_OUT_DIR="{{SCRATCH}}" node scripts/daily-brief-probe.mjs 120` plus targeted read-only prod queries (per-workspace volumes; failed/fallback runs; bounce leaders via rejected episodes in window; each active thread in the file) and `git log origin/main --since=<monday>` for shipped-this-week.
The 2 PM send means Friday-afternoon events (this repo ships heavily on Friday PM) roll into NEXT week's memo — say so rather than reporting the week as quieter than it was, and open next week's memo by picking up anything the cutoff clipped.
Write ONE self-contained HTML memo weekly-insights-<monday>.html in {{SCRATCH}} in the established style: week-in-one-paragraph → themed findings with takeaways → standing risk line → shipped-this-week → next-week priorities → PER-AGENT OVERVIEW. The per-agent overview = `python C:/Cursor/ticket-pulse-design/briefs/agent_section.py {{SCRATCH}}/daily-data.json --workload-only` pasted verbatim (the same "overdue inside the bar" table the dailies use; agentStats' new/resolved are a fixed 7-day window), followed by 2–4 sentences of your read — an OVERVIEW of what's happening per person, NOT per-ticket detail (the dailies carry that). This section is the ONE sanctioned exception to the no-stats rule, kept team-safe: workload-balance and coaching signals ("X is carrying the oldest backlog", "Y absorbed the most new intake"), never a ranking, never praise/blame framing. Flag only patterns that need Vahid: rising overdue counts, a person whose pending pile is growing week-over-week, load concentration.
Send via `node C:/Cursor/ticket-pulse-design/qa/tools/send-brief.mjs "Ticket Pulse Weekly Insights — <Mon DD–Fri DD>" <file>`; verify 202, retry once, report loudly on failure. Then update briefs/BRIEF_THREADS.md (weekly carry-overs, ledger exits, risk line) and bump its `_Last updated_` line.
Expiry: this cron auto-expires 7 days after creation (created {{TODAY}}; it fires {{NEXT_FRIDAY}} and expires the Friday after). Re-arm the weekly cron right after each firing by running the /arm-briefs steps (weekly), and note the re-arm status in the memo footer.
```

## 3. Arm
- `daily`: `CronCreate { cron: "45 8 * * 1-5", recurring: true, prompt }`.
- `weekly`: `CronCreate { cron: "2 14 * * 5", recurring: true, prompt }`.
- Record the returned job ids. Compute expiry = creation + 7 days; the daily's last firing is the last weekday before
  expiry, the weekly's is the first Friday after creation (a Friday creation after 2 PM fires the following Friday).

## 4. Commit the thread file
If `briefs/BRIEF_THREADS.md` differs from `origin/main`, commit it to main with the plumbing recipe from the `tp-update`
skill (branch `cursor/brief-threads-<MMDD>`, PR, squash-merge with `--admin`). Never commit `.env.prod`, `daily-data.json`
or memo HTML.

## 5. Report
One line per cron: id, schedule in PT, next firing, expiry date and the re-arm reminder. State the recipient. Remind Vahid
that the crons live only while this session is open, and that any OTHER session still holding brief crons must have them
deleted to avoid duplicate e-mails. Update memory `brief-routines` with the new ids.

## State ownership
`briefs/BRIEF_THREADS.md` SUPERSEDES the memory file `brief-routines.md` for thread state (active threads,
ledger, probe read rules). Memory keeps only lessons, plumbing history and cron ids. When the two disagree on a
thread, the file wins — update memory to match, never the other way around.
