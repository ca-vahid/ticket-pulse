# The Project Accounting setup (2 minutes, once)

Ticket Pulse can now categorize every Project Accounting ticket automatically. The category list for this workspace was rebuilt around the way the team actually works — starting with **Project Setup** and **Proposal Setup** — and the AI reads each new ticket and files it into one of those categories for you.

This checklist is everything you need to switch it on and keep an eye on it. Do steps 1–3 once; steps 4–5 are where you'll live day-to-day.

> **Before you start:** make sure you're in the **Project Accounting** workspace (workspace picker, top of the left sidebar).

---

## 1. Turn on Auto-Categorize

1. Go to **Settings → AI & Routing**.
2. Scroll to the **Assignment Behavior** card.
3. Flip **Auto-Categorize Tickets** on (it turns green).
4. Click **Save**.

That's it — from now on, every AI run writes its chosen category straight onto the ticket, even while assignment itself still waits for human review.

*![Screenshot 1 — Settings → AI & Routing → Assignment Behavior with the Auto-Categorize toggle ON](placeholder: pa-setup-01-toggle.png)*

## 2. Understand the amber "nights & weekends" warning

Right under the toggle you may see an amber notice:

> **Nights & weekends are not covered yet:** Auto-Categorize rides the AI runs, and no runs execute outside business hours…

**What it means:** the AI only runs when a pipeline run happens. If after-hours runs are off, a ticket that arrives Saturday night stays uncategorized until Monday morning's queue drain — then it gets categorized automatically. Nothing is lost; it's just not instant overnight.

**If you want around-the-clock categorization:** go to **Settings → Urgent Escalation** and turn on **Automatic urgent detection**. That enables after-hours AI runs for this workspace (they assess priority and categorize at the same time). If next-business-morning is fine for you, you can ignore the warning entirely.

*![Screenshot 2 — the amber after-hours warning under the toggle](placeholder: pa-setup-02-amber-warning.png)*
*![Screenshot 3 — Settings → Urgent Escalation → Automatic urgent detection](placeholder: pa-setup-03-urgent-detection.png)*

## 3. Know where the categories live

The new category list (Project Setup, Proposal Setup, General / Other, plus any categories added later) shows up in three places:

- **The category tree** — **Assignment Review → Competencies → Categories** tab. This is the single editor: add a category with **New category**, rename or retire from the row menu. (Old categories were retired, not deleted — they're in the "retired" list if you ever need the history.)
- **The ticket itself** — open any ticket (**Tickets → click a row**): the category appears in the ticket's detail sidebar, and on the queue's category filter/flyout.
- **Analytics** — **Analytics → Categories** tab: the treemap and category breakdowns now use the same list, and the old "legacy category mode" banner is gone for this workspace.

*![Screenshot 4 — Categories tree showing Project Setup + Proposal Setup](placeholder: pa-setup-04-category-tree.png)*
*![Screenshot 5 — a categorized ticket's detail sidebar](placeholder: pa-setup-05-ticket-sidebar.png)*
*![Screenshot 6 — Analytics Categories tab, banner gone, treemap populated](placeholder: pa-setup-06-analytics.png)*

## 4. Review and fix the AI's picks

The AI is deliberately **conservative**: when it isn't sure, it files the ticket with a "weak fit" and flags it for review instead of guessing confidently.

- **One ticket:** open the ticket and change the category from the detail sidebar — a human choice always wins and sticks.
- **Flagged tickets:** the **Review Needed** signal (Analytics → Categories) collects every ticket the AI marked as a weak/no fit — skim it weekly; each entry is a hint that either the ticket needs a manual pick or the category list needs a tweak.
- **Batches:** **Assignment Review → Competencies → Categories → Reclassify** opens the batch tool: it dry-runs the AI over a batch of tickets, shows you every proposed category before anything is written, and only applies what you approve. Use it for backlogs and long tails (e.g. everything still uncategorized after the migration).

*![Screenshot 7 — the Reclassify panel with a dry-run preview table](placeholder: pa-setup-07-reclassify.png)*

## 5. What this does NOT do (on purpose)

**Nothing is written back to FreshService for this workspace.** The Project Accounting categories are Ticket Pulse-internal: no FreshService custom fields are created or updated, no FreshService category objects are synced, and nothing about your FreshService configuration changes. Categories live — and are edited — in Ticket Pulse only. (This is a recorded decision for this workspace; the IT workspaces' FreshService category sync is a separate, unrelated feature.)

---

## FAQ

**Do I have to categorize old tickets myself?**
No. The migration pre-filed the obvious ones automatically; the rest are left uncategorized on purpose so the Reclassify batch tool (step 4) can handle them with your approval.

**Can I add a category later?**
Yes — **Assignment Review → Competencies → Categories → New category**. The AI picks it up on its next run; no restart, no request to IT needed. Adding is instant; keep names short and distinct.

**What if the AI keeps mis-filing a certain kind of ticket?**
Fix a few by hand (that's visible history), and tell us — the AI's instructions for this workspace are versioned and we can sharpen the Project Setup vs Proposal Setup guidance in minutes.

**Who do I contact?**
The Ticket Pulse team — same channel as always. Mention "Project Accounting categories" and we'll know exactly where to look.

---

### Screenshots needed for the QA PDF (orchestrator checklist)

1. `pa-setup-01-toggle.png` — Settings → AI & Routing → Assignment Behavior, Auto-Categorize ON (green), ws = Project Accounting.
2. `pa-setup-02-amber-warning.png` — the amber nights-&-weekends warning rendered under the toggle (toggle ON, after-hours OFF).
3. `pa-setup-03-urgent-detection.png` — Settings → Urgent Escalation, Automatic urgent detection toggle.
4. `pa-setup-04-category-tree.png` — Assignment Review → Competencies → Categories tab with Project Setup / Proposal Setup / General / Other active (retired list collapsed).
5. `pa-setup-05-ticket-sidebar.png` — a real categorized ticket's detail view with the category visible in the sidebar.
6. `pa-setup-06-analytics.png` — Analytics → Categories on Project Accounting: no legacy banner, treemap populated, Review Needed count visible.
7. `pa-setup-07-reclassify.png` — the Reclassify panel showing a dry-run batch preview table.
