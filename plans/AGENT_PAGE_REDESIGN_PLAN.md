# Agent (Technician) Page — Complete Redesign Plan (2026-08-01)

Target: `/technician/:id` (`TechnicianDetailNew.jsx`). Mockups: `design-previews/agent-page-options.html`.

## What's wrong today (user audit, 2026-08-01)
1. **Overview is numbers without evidence** — "Closed 33" answers nothing (which tickets? who asked? about what?). Nothing drills.
2. **Tab-badge lie** — user clicks "33" on the dashboard, lands on a page whose Tickets tab says **0** (the badge counts *open now*, not the day's activity they drilled in on). Real bug + broken mental model.
3. **Tickets tab** — bland table, no story, needs redesign.
4. **Coverage tab** — a primitive re-implementation of the Timeline Explorer. Should *reuse* the rich Timeline (embed scoped to the tech, or deep-link with filters) instead of a worse clone.
5. **CSAT vs Feedback split** — FS-native vs TP-native surveys as two tabs is an implementation detail. Merge into one "Satisfaction" view with a source chip per response.
6. **Period-toggle jitter** — Daily/Weekly/Monthly text shifts when icons appear. Fixed-width segmented control.

## Design principles for every option
- **Every number is a door**: any stat click filters/scrolls to the evidence (the actual tickets).
- **The drill context travels**: arriving from "33 closed on Mon" opens the page already scoped to that day + that bucket.
- **One satisfaction view** (FS /4 converted to /5 + TP native /5, source-chipped), N always shown.
- **Coverage = a Timeline preset**, not a separate implementation.
- Team-safe framing preserved (context, not leaderboards).

## Toolbox (offline = already in repo; online = researched additions)
- In repo: Highcharts (+ solidgauge/heatmap modules loadable), Recharts, **TanStack Table**, @dnd-kit (board pattern from Tickets), motion/react, lucide, Tailwind tokens, the full Timeline Explorer page, ExpandableTicketList, TicketBoard.
- Candidate adds: **@uiw/react-heat-map** (~gzip-tiny SVG GitHub-style activity calendar) — the only new dep any option needs. (Tremor/nivo evaluated; Tremor's styling would fight our tokens, nivo is heavy for one calendar — borrowed their *patterns* instead.)

## The four directions (see interactive mockups)
- **A — Command Center** (evidence-first, no tabs): KPI chips are filters over one embedded TanStack ticket table; day strip; everything on one screen. *Existing deps only. Lowest risk, fastest.*
- **B — Story Feed** (narrative): the agent's day as a chronological feed of moments (picked/assigned/closed with inline mini ticket cards), a year activity heatmap for context, merged Satisfaction panel. *Adds @uiw/react-heat-map.*
- **C — Analyst Split** (reuse the Timeline): left rail = profile + compact stats + category mix; right pane = the **real Timeline Explorer embedded and scoped to this tech** — Coverage becomes a one-click preset (overnight window filter) on it. *Existing deps; reuses the most code.*
- **D — Performance Card** (bold visual): hero card with radial gauges (Highcharts solidgauge), category radar, week-rhythm bars, then the day's tickets as status swimlanes (TicketBoard pattern). *Existing deps (Highcharts modules).*

All four fix items 1/2/5/6 identically (drillable stats, day-scoped tab counts, merged satisfaction, fixed-width toggle); they differ in layout philosophy and how 3/4 are handled.

## Cross-cutting fixes to ship regardless of direction
- Badge bug: tab/label counts must be **scoped to the selected period** (the number you clicked = the number you see).
- Dashboard drill passes `{date, bucket}` → page opens pre-filtered (partially exists via location.state; make it visible as an active-filter chip).
- Merge CSAT+Feedback into one endpoint/view (FS /4 ×1.25 + TP /5, source chip, N visible).
- Replace Coverage implementation with Timeline reuse (embed or `/timeline?tech=<id>&window=overnight` deep-link).
- Segmented control with fixed track widths.

## Next step
User picks a direction (or a hybrid) from `design-previews/agent-page-options.html`; then phase the build (shared fixes first, then the chosen layout).

## DECISION (2026-08-01, user)
Hybrid: **C skeleton + A drillable chips + B heatmap**, refined:
- Heatmap hand-rolled (responsive CSS grid, fits container): ranges follow the period filter
  (weekly 7 large cells / monthly day-grid / quarterly 13 week-cols / yearly 52 week-cols) +
  manual override (Auto·W·M·Q·Y). No @uiw dep needed.
- Timeline: duration bars DEMOTED (timestamps unreliable — agents batch-close late; low-volume
  workspaces have 5-6 tickets/week). Daily = event-marker strip (dots, batch-close clustering);
  weekly+ = heatmap + feed only; "Open in Timeline Explorer →" deep link (tech pre-filtered)
  replaces the Coverage tab and the embed at wide ranges.
- Cross-cutting: badge counts scoped to period; drill-context chip; CSAT+Feedback merged
  (/5 with source chips + N); fixed-width period toggle.
