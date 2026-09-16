---
name: agentmassreport
description: Generate workload-story PDFs for SEVERAL Ticket Pulse technicians in one go (one PDF per person), following the same per-agent process. Use when the user types /agentmassreport <names | "Everyone in IT"> [in <workspace>] [for <range>] (e.g. "/agentmassreport Everyone in IT for 2026", "/agentmassreport Mehdi, Gaby, Vahid in IT workspace for the last three months").
argument-hint: <names | Everyone in IT> [for <range>]
---

# /agentmassreport — batch workload stories (one file per agent)

Generate several technicians' PDFs using the same generator as `/agentreport`, looping per person.

## 1. Parse the request
- **who** — either an explicit comma list of names ("Mehdi, Gaby, Vahid") OR "Everyone" / "Everyone in IT" / "the whole team".
- **workspace** — "IT" → `1` (default). If another workspace is named, find its id with
  `node backend/scripts/list-agents.mjs --workspace N` or ask.
- **range** — text after "for"/"over". Default current year ("2026 so far"). Same range vocabulary as `/agentreport`.

**Nicknames:** in an explicit list, disambiguate with `Display=DB name`, e.g. `Mo=Muhammad Shahidullah`.

## 2. Run
From `reports/agent-reports/` (Push-Location/Pop-Location):

Explicit list:
```powershell
Push-Location 'C:\Cursor\ticket-pulse-design\reports\agent-reports'
node make-mass-report.mjs --names "Mehdi,Gaby,Vahid,Mo=Muhammad Shahidullah" --range "<range>" --workspace 1
Pop-Location
```

Everyone in a workspace:
```powershell
Push-Location 'C:\Cursor\ticket-pulse-design\reports\agent-reports'
node make-mass-report.mjs --everyone --workspace 1 --range "<range>"
Pop-Location
```

It runs `make-report.mjs` per person (data → Entra photo → hero+badges → PDF/XLSX/CSV) and prints a
✅/❌ summary. Shared badge/mascot art is generated once and reused; existing heroes are skipped, so
re-runs are cheap.

**Parallelism:** it runs **3 agents at once by default** (`--concurrency N`, use `1` for sequential).
Most of each person's time is waiting on the OpenAI hero call, so 3–5 concurrent collapses wall-clock
to roughly the slowest one. Each build spins up its own headless Chrome (~250 MB), so keep N ≤ 5 on a
normal machine. The runner primes the shared art with the first agent before fanning out (avoids a race).

For big batches, run it in the **background** and report progress from the task output file; don't block.

## 3. Verify & report
Spot-check 2–3 covers in `reports/agent-reports/output/preview/<slug>/slide-01.png`, then list every
output PDF path: `reports/agent-reports/output/<firstname-lastname>-<rangeslug>.pdf` (+ `.xlsx`/`.csv`).
Call out any ❌ (e.g. a name that didn't resolve, or someone with no Entra photo — that hero falls back
to a described illustration).

## Notes
- Same guardrails as `/agentreport`: secrets stay in the untracked `.env`; team-safe framing; CSAT shows N; metrics match the dashboard.
- If a name matches multiple technicians, the generator picks the one with the most assigned tickets and logs the choice — re-run with `Display=Full Name` if it chose wrong.
