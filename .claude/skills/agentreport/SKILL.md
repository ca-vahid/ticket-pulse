---
name: agentreport
description: Generate a polished, fun "workload story" PDF for ONE Ticket Pulse technician over a date range — pulls their real prod data + Entra photo, builds charts and AI hero art, and outputs a per-agent PDF (+ XLSX/CSV). Use when the user types /agentreport <name> [for <range>] (e.g. "/agentreport Anton for the last 3 months", "/agentreport Mehdi for 2026").
argument-hint: <name> [for <range>]
---

# /agentreport — single-agent workload story

Generate one technician's workload-story PDF using the reusable generator at
`reports/agent-reports/`. Follow the SAME process every time; do not hand-roll it.

## 1. Parse the request
From the user's argument, extract:
- **name** — the technician (first name is fine; the generator resolves it against prod).
- **range** — everything after "for"/"over"/"in". If absent, default to the current year ("2026" → rendered as "2026 so far").

Supported ranges (the orchestrator parses these): `2026`, `2025`, `this year`, `last 3 months`,
`the last three months`, `last 6 weeks`, `last 30 days`. Pass the phrase through verbatim as `--range`.

**Nicknames:** if the name is a nickname that won't substring-match the DB name, add `--alias "<full DB name>"`.
Known: `Mo` → `Muhammad Shahidullah`. To discover real names, run
`node backend/scripts/list-agents.mjs --workspace 1`.

**Workspace:** default `1` (the IT workspace). Override with `--workspace N` if the user names another.

## 2. Run the pipeline (one command)
From `reports/agent-reports/` (use Push-Location so the persistent cwd is restored):

```powershell
Push-Location 'C:\Cursor\ticket-pulse-design\reports\agent-reports'
node make-report.mjs "<name>" --range "<range>" [--workspace N] [--alias "<full name>"]
Pop-Location
```

This runs all four steps in order: **data fetch (prod)** → **Entra photo + job title** →
**AI hero (from their photo) + shared badges** → **PDF + XLSX + CSV**. It is re-runnable;
add `--skip-images` to rebuild the PDF without regenerating art.

## 3. Verify (always look at it)
Read the cover preview and skim one chart slide:
`reports/agent-reports/output/preview/<slug>/slide-01.png` (and `slide-03.png`).
Confirm the hero resembles the person and the period label is correct. The `<slug>` is the
lowercased, hyphenated name argument (e.g. `anton`, `mehdi`, `mo`).

## 4. Report back
Give the full output path(s):
`reports/agent-reports/output/<firstname-lastname>-<rangeslug>.pdf` (+ `.xlsx` / `.csv`).
The cover reads "<N> so far in tickets…" when the year is partial.

## Notes / guardrails
- Secrets (prod DB URL, OpenAI key) live only in `reports/agent-reports/.env` (folder `.gitignore` is `*`). Never commit, never echo the connection string.
- Image prompts contain no ticket data/PII; art is non-blocking (falls back to a designed illustration if generation fails).
- Metrics reuse the app's own category normalizer + definitions, so they match the dashboard. Keep it team-safe: this is one person's own data, framed as personal workload — never a cross-tech leaderboard. CSAT always shows N.
