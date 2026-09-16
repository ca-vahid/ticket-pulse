---
name: tp-update
description: Run a full Ticket Pulse QA-package cycle — root-cause every item in a "Features Request - MM-DD.docx" package against production, write the plan, implement + test, release (version bump, changelog, PR, merge, migrations), build the branded response PDF, e-mail the QA team, and schedule a 24-hour post-build watch. Use when Vahid types /tp-update [<package folder>] [options].
argument-hint: [<qa/… Package folder>] [email me only | let me review the email | ask me decisions | use the live app]
---

# /tp-update — QA package → plan → build → release → PDF → e-mail → watch

Vahid's standing process for a QA package from Susan Xu (QA). Everything below runs without asking
unless the prompt says otherwise. All times, dates and file names use **Pacific time (America/Vancouver)**.

## 0. Parse the prompt
- **Package**: the folder given, else the newest `qa/*Package*` folder containing a `Features Request*.docx`
  and no `* - Response.pdf`. The date `MM-DD` comes from the docx name (e.g. `Features Request -09-15 2.docx` → `09-15`).
- **Options** (only when explicitly in the prompt):
  - `email me only` → send the e-mail to Vahid only (no Susan). Default: to Susan, cc Vahid.
  - `let me review the email` / `preview first` → write `qa/evidence-<MMDD>/email-preview.html`, stop before
    sending, show Vahid the preview and wait. Default: send.
  - `ask me decisions` → stop and ask Vahid product questions as they arise (AskUserQuestion). Default: never
    block — build everything that is not a product decision, and list decisions in the PDF/e-mail.
  - `use the live app` → screenshots come from the running app (dev login, see memory
    `browser-verify-authed-pages`). Default: render the changed components against `frontend/dist` CSS via a
    throwaway Vitest harness (`renderToStaticMarkup`) + puppeteer (`qa/tools/shoot.mjs`).
  - `no watch` → skip step 7.

## 1. Extract the request
Unzip the docx to the scratchpad; parse `word/document.xml` (replace `<a:blip r:embed>` with `[[IMG:…]]`
markers via `word/_rels/document.xml.rels`); Read every `word/media/*.png`. Copy the images to
`qa/evidence-<MMDD>/qa-reported-<n>.png`. Number the items exactly as the docx does.

## 2. Root-cause against production (read-only)
For each item: find the code path, then prove the cause with real data — prod DB probes
(`backend/scripts/tmp-*.mjs`, DATABASE_URL via `az webapp config appsettings list -n ticket-pulse-app -g ticket-pulse-rg --query "[?name=='DATABASE_URL'].value | [0]" -o tsv` into scratchpad `.produrl`; prefer Prisma model
calls over raw SQL; table names from `information_schema`, never guessed), the app log (concatenate ALL of the
day's rotated `*_default_docker*.log` files, strip ANSI — memory `hourly-review-log-rotation`), and FreshService
reads where needed. Delete temp scripts and `.produrl` afterwards. Never echo secrets. Never touch sandbox
workspaces 6/7.

Classify each item: **fix** (defect / clear improvement), **build** (feature), **explain** (not a bug — say why
with evidence), **your call** (product decision — list, do not block), **plan only** (large change the QA
asked to be planned).

## 3. Write the plan
`plans/MEGA_<MMDD>_PLAN.md` in the established shape: header (source, workspaces, tester), status legend,
executive-summary table (# / QA said / verdict / root cause in one line), one section per item ("QA said",
"Root cause (production)", "Fix" with ☐ tasks and tests), cross-cutting notes, execution order, deliverables.
Large "plan only" items get their own `plans/<TOPIC>_PLAN.md` with model, data, API/UI, effort, open questions.

## 4. Implement and test
- Patch with the Write tool or Python patch scripts with exact-anchor asserts (heredocs eat quotes/backslashes).
- Before editing a file, `git diff --numstat origin/main -- <file>`; if it diverges from main for reasons other
  than today's work, restore it with `git show origin/main:<path> > <path>` first (the worktree branch is old).
- Wrap NEW Prisma reads in shared services (`Promise.resolve().then(() => prisma.x…)` + catch) so partial mocks
  and a missing column degrade instead of failing the caller. A `const` that reads React state declared later is a
  TDZ error — declare after the `useState`.
- Tests per item (backend Jest, frontend Vitest). Then full suites: backend
  `node --experimental-vm-modules ./node_modules/jest/bin/jest.js` (output to a scratchpad file, grep totals),
  frontend `npx vitest run`, `npm run lint:dark`, `npm run build`. All green before release.
- Schema changes: add the migration under `backend/prisma/migrations/<YYYYMMDDHHMMSS>_<slug>/migration.sql`
  (additive, `IF NOT EXISTS`), update `schema.prisma`, run `npx prisma generate` (if EPERM, stop stale
  `node src/app.js` dev servers by PID first).
- **Second look**: before releasing, re-read every diff with fresh eyes for holes; fix them and note them in the PDF.

## 5. Release (one release per package unless something is urgent)
Refresh `frontend/src/data/changelog.js` and both `package.json` from `origin/main`; bump to the next
`X.Y.Z-preview` (both package.json for a backend release; frontend only when nothing backend changed); one
changelog entry per item in plain product language. Plumbing commit from the repo root
`C:\Cursor\ticket-pulse-design`:
`GIT_INDEX_FILE=<scratch>/idx git read-tree origin/main` → `git hash-object -w --path` + `git update-index --add --cacheinfo 100644,<sha>,<path>` per file → `git write-tree` → `git commit-tree -p origin/main -F <msg>` → `git update-ref refs/heads/cursor/qa-<MMDD>` → push → `gh pr create` → `gh pr merge <N> --squash --admin --delete-branch`.
Commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: <url>`; PR body ends with the 🤖 line.
Then wait for `/health` on `ticket-pulse-app.azurewebsites.net` (backend) and the served `assets/index-*.js`
bundle on `ticketpulse.bgcsaas.com` (frontend) to show the version.

**Migrations are NOT run by the deploy pipeline** (memory `prod-migrations-manual`). Right after the merge:
`cd backend && DATABASE_URL="$(cat <scratch>/.produrl)" npx prisma migrate deploy`, verify with
`select migration_name, finished_at from _prisma_migrations order by finished_at desc limit 3` and a Prisma read of
the new column, then re-check the app log five minutes later for `Error fetching`/`does not exist` lines.
Additive migrations run without asking; anything that drops/renames stops and asks Vahid.

## 6. Response PDF + e-mail
- Tools live in `qa/tools/`: `build_html.py` (branded CSS, cover, sections), `render-pdf.mjs <in.html> <out.pdf> "<footer>"`,
  `shoot.mjs <dir>` (screenshots every `*.html` in the evidence dir), `send-qa-response.mjs`.
- Author `qa/evidence-<MMDD>/report_content.py` (COVER + SECTIONS) in the established voice: cover → "The short
  version" verdict table → one section per item ("You asked" quote, screenshot, "What production says" with a
  `<pre>` of real rows, "What we changed", "Try it") → "What changed, and your list" with the decisions for Vahid.
  Copy `qa/tools/build_html.py` into the evidence dir (it imports `report_content` from its own folder) and run it,
  then `render-pdf.mjs`. Verify by screenshotting the HTML (cover + one section) — `pdftoppm` is not installed.
- Save `qa/Features Request - <MM-DD> - Response.pdf` and a copy inside the package folder.
- E-mail via `node qa/tools/send-qa-response.mjs --pdf "<pdf>" --package <MM-DD> --version <X.Y.Z> --content <evidence>/email_content.mjs [--to vhaeri@bgcengineering.ca] [--dry]`
  (from "Ticket Pulse", reply-to Vahid, signed "Vahid"; subject
  `Ticket Pulse - your <MM-DD> QA package: all <N> answered (PDF attached)`). `email_content.mjs` exports
  `{ headline, intro, rows:[{n, what, verdict, tone, cause}], retest:[…], questions:[…], extra?, thanks }`.
  Honour `email me only` / `let me review the email`.

## 7. Post-build watch (24 hours, PT)
Unless the prompt says `no watch` or a review cron already exists (`CronList`): create a session cron that
runs the production review every 2 hours for 24 hours from now — or, when that window crosses a Friday
evening, weekend or BC statutory holiday, until 9:00 AM PT of the next business day. Pin day/month in the cron
(`M H/2 D M *`, minute off :00, e.g. `13`). The prompt is the hourly-review checklist (health, sync freshness,
Simorgh, workflows/mirror, log groups with ANSI stripped across rotated files, mail, limiter, preheat, plus
"anything referencing the code shipped today"), with "fix and ship what merits fixing, list product decisions".
Tell Vahid the job exists only while this session is open.

## 8. Report to Vahid
Lead with what shipped (version, PR) and where the PDF is (full paths). One line per item: verdict + cause.
Then "your list": decisions and configuration only he can do. Mention the watch schedule. Update memory
`qa-feedback-response-loop` with the round's non-obvious lessons.
