# Site-wide visual review — 2026-07-12

Full sweep at v3.0.50-preview: 17 desktop surfaces (1720×950) + dashboard/tickets/analytics at
390px mobile, screenshotted from dev with prod-mirrored data and reviewed screen by screen.
Overall verdict: the visual language is in good shape — the glass/slate/blue system is applied
consistently, the new type pills and Paused chips slot in cleanly, and no surface looks broken.
The list below is ordered by how much each item matters, not by effort.

---

## A. Defects (wrong, not just improvable)

1. ~~**In-app version badge stuck at v3.0.47.**~~ **FIXED in v3.0.51** — `changelog.js
   APP_VERSION` (which feeds the header badge and the What's-new modal) hadn't been bumped since
   #158, so three releases shipped invisibly. QA validates releases by this badge. Entries for
   3.0.48–3.0.50 backfilled.

2. **Analytics → Demand → Source Mix shows a raw code: "Source 103".** The channel histogram
   labels most sources ("Email", "Portal", "Bot"…) but prints the numeric code for TP's
   extended sources (103 = Agent; 100/101/102 would do the same). Wire the axis labels through
   `TICKET_SOURCE_LABELS` / `ticketSourceLabel()`.

3. **Analytics overdue numbers don't respect the new SLA pause.** Overview "Overdue Risk 269 —
   open tickets past dueBy" and Category Map's "269 overdue" are computed in
   `analyticsService` independently of the tickets page and still count Pending tickets. Now
   that Pending pauses the clock, these should count `status='Open'` only, or they'll
   permanently disagree with the Tickets page's Overdue card.

4. **Overview "Assignment Mix" donut clips its center label** — renders as "982 / SSIGNED
   TICKETS" (the "A" is swallowed by the donut hole at this width). Shrink the tracking/size
   or stack "982" over "assigned".

5. **Approvals page shows the red "Offline" connection pill.** The page doesn't establish the
   SSE stream the header pill reports on, so an otherwise healthy session looks broken —
   alarming exactly where managers approve things. Either subscribe (approvals *do* have live
   events) or hide the pill on pages without a stream.

---

## B. High-value polish (worth a slot in the next batch)

6. **Timeline page lands on an empty state** ("Select technicians to view their timeline").
   First-visit value is zero until the user finds the picker. Default to all active techs (or
   the 5 busiest today) with the picker as refinement, not a prerequisite.

7. **Team Balance "Timeline by Agent" is 13-line spaghetti.** All agents graphed at once in
   full-saturation colors — unreadable and it undercuts the otherwise careful team-safe
   presentation. Default to the Agent-focus selection (top 5 by volume), let the legend add
   more; consider a small-multiples toggle.

8. **Dashboard weekly grid is a sea of "0" pills** on quiet weeks: 13 rows × 7 bordered
   day-cells all reading 0 plus a 0-TOTAL column. Ghost the zero cells (no border, faint dash)
   so non-zero activity pops; the eye should find the two worked days instantly.

9. **Mobile analytics burns ~40% of the first screen on stacked controls** — Range, Trend,
   Categories, Exclude-noise, Export each get a full-width row before any number appears.
   Collapse into a 2-column grid or a single "Filters" sheet button (the tickets page already
   does this well with its Filters button).

10. **Mobile dashboard has six stacked control rows** (week band, Hide Noise, Demo Mode,
    Expand All, Search, Categories) before the first technician card. Same treatment: one
    compact toolbar row + sheet.

11. **Ticket detail: closed TP-born tickets remain fully editable** — status/priority/type/
    source selects are live on a Closed ticket with no friction. Consider a read-only-until-
    reopened treatment (fields dimmed + a "Reopen to edit" affordance) so closed history isn't
    accidentally rewritten.

12. **Approvals layout: content hugs a narrow left column** of an otherwise empty canvas, and
    the tab row's divider runs on past the last tab. Center the column (`max-w` + `mx-auto`,
    like Settings panels) and clip the divider to the tab strip.

---

## C. Nice-to-have (batch with adjacent work)

13. **Workflows editor: Inspector is a large empty panel** when a trigger is selected (one
    field + a hint in ~500px of white). Fold trigger metadata (variant, version, run stats,
    enable state) into the inspector so the third column earns its width.

14. **Ticket detail: description image attachments render as a tiny fixed thumbnail** (~90px).
    Scale to a bounded preview (max-h-48) with the existing click-to-preview.

15. **Category Map agent-lens tiles: the "Unassigned 321 · 32.7%" tile** uses the same visual
    weight as agents; a third of demand being unassigned is a signal worth a distinct
    (amber?) treatment.

16. **Assignment queue empty state repeats the business-hours banner twice** (top banner and
    "Queued for Business Hours" drawer, both amber, same message). One should defer to the
    other when counts match.

17. **Dashboard "APP" column ghost icons** read as disabled buttons; if the column is
    informational-only when zero, drop the ghost chrome entirely.

18. **Analytics range picker still says "Last 30 days" while a custom Trend-by is possible** —
    fine today, but when the type dimension lands (deferred from the ticket-types plan), this
    header row is at capacity; plan a filter-sheet consolidation then.

## Not broken, deliberately left alone

- Tickets queue, ticket create, Settings panels (FreshService / Ticket Ops / AI & Routing),
  assignment history, category map, member map, mobile tickets: all render clean and
  on-system. The new registry pills, SLA type tabs, Paused chips, and Source fields integrate
  without visual debt.
