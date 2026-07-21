# Ticket Pulse — QA Test Plan (2026-07-21)

**Build under test:** next preview build · **Prepared for:** QA team · **From:** Ticket Pulse dev

This round covers two bodies of work landing together:

1. **Mobile overhaul** — the Dashboard, Technician page, ticket queue, and ticket detail
   were reworked to be genuinely usable on a phone (new features + fixes).
2. **Features Request 07-20 fixes** — the items you reported last round (Notifications
   restructure, Settings reorg, escalation alerts, ticket-detail tweaks, task sync, API).

**How to test:** Use a real phone where a section says "mobile", or Chrome DevTools device
mode (iPhone/Pixel, ~390px wide). Everything else can be tested on desktop. Use a **QA TEST**
prefix on tickets you create and clean them up as usual. Report anything that deviates from
the ✅ expected result, with the ticket ref (and, for API items, the `X-Request-Id`).

> **Not in this build — please don't re-file these yet.** The sync-timing and mirror items
> from 07-20 (#1 reply/attachment mirror, #2 email image attachment, #8/#10 priority/status
> sync latency, #11 FreshService tags → TP, #13 close latency) are diagnosed and in a
> separate backend pass. They are **not** in this build.

---

## 1. Mobile experience

Test these on a phone (or device mode). The goal: no squeezed desktop layouts, real touch
targets, and the things that only worked on desktop now work on mobile.

### 1.1 Dashboard — technician cards + inline tickets (NEW)
1. Open **Dashboard** on a phone.
2. ✅ Each technician shows as a single-column card sized for a phone (avatar and numbers no
   longer oversized; no hover-zoom on the photo).
3. On any card, tap **"View tickets (N)"** at the bottom of the card.
   ✅ The technician's tickets expand **inline, right on the Dashboard** (previously there
   was no way to see a tech's tickets on mobile). Tapping again collapses them.
4. In that expanded list, tap a ticket reference (e.g. `TP-1042`).
   ✅ It opens the **in-app ticket page** (`/tickets/…`), not FreshService.
5. Tap the small **hide (eye-off)** control at a card's top-right.
   ✅ It's tappable on touch (it used to only appear on hover, so phones couldn't reach it).

### 1.2 Technician (agent) page — mobile
1. From the Dashboard, tap a technician to open their page on a phone.
2. ✅ The header controls (Daily/Weekly/Monthly, date nav, **Export**, **Today**) wrap onto
   multiple rows and are all reachable — they no longer scroll off a hidden strip.
3. ✅ The metrics ribbon fills cleanly (no orphaned tile); tiles read clearly at phone width.
4. ✅ Ticket rows render as tidy cards (not a squeezed table).

### 1.3 Ticket queue — live cues on mobile (NEW)
1. Open **Tickets** on a phone.
2. Trigger an AI auto-assignment (or have one land) on a visible ticket.
   ✅ The assignee cell on the **mobile card** shows the completion "pop" cue when the
   assignment lands (this previously only fired on desktop).
3. If your device has **Reduce Motion** on (Settings → Accessibility), create/observe a new
   or just-updated ticket.
   ✅ New/updated tickets still show a **static** highlight (a steady tint/left accent) — the
   cue no longer silently disappears under reduced motion.

### 1.4 Ticket detail — mobile assign + properties (NEW)
1. Open any ticket detail on a phone.
2. ✅ Just under the header (above the conversation) there's a **properties bar** showing the
   **assignee** and **status** — so you don't scroll the whole thread to see/change them.
3. Tap the assignee in that bar.
   ✅ A **bottom-sheet assign picker** opens (ranked AI suggestion + one-tap approve, current
   assignee with Unassign, searchable member list) — the same touch-first sheet as the queue,
   instead of the cramped desktop popover.
4. Assign someone from the sheet. ✅ It saves and the properties bar updates.

---

## 2. Technician page fixes (desktop AND mobile)

These are correctness fixes that apply on any screen.

### 2.1 Ticket links open in Ticket Pulse (not FreshService)
1. Open a technician page → **Tickets** tab. Also check the **Coverage**, **CSAT**,
   **Bounced**, and **Feedback** tabs.
2. Click any ticket reference or subject.
   ✅ It opens the **in-app** ticket page (`/tickets/:id`). FreshService is now only a small
   secondary "external" icon beside the reference (click it to open FS if needed).

### 2.2 Overview stat cards are clickable (NEW)
1. On the technician page **Overview** tab, click the **Open now / Self-picked / Assigned /
   Closed** cards (and **Total** / **Self-pick rate**).
   ✅ Each jumps to the **Tickets** tab pre-filtered to that set (a chevron on the card hints
   it's clickable).

### 2.3 Number accuracy
1. Compare **"Assigned"** on the Overview tab vs the Tickets-tab ribbon.
   ✅ They now agree (Overview previously added app-assignments into "Assigned"; both now
   count coordinator-assigned, with any app-assigned shown as a separate "+N via app" note).
2. Check the daily **CSAT** count on the CSAT tab against a day you know.
   ✅ The day boundary now matches the weekly/monthly counts (Pacific time) — no more
   off-by-one-day mismatch for non-Pacific browsers.

---

## 3. Notifications (Features Request 07-20 #3, #4, #7)

### 3.1 Notifications is a top-level menu item
1. Click your **avatar menu** (top-right).
   ✅ There's a **Notifications** item (bell, "Email & alert preferences") between **My Skills**
   and **Skill Matrix** — it's no longer buried inside My Skills.
2. On a phone, open the **More** sheet (bottom bar).
   ✅ **Notifications** appears there too.
3. Click it. ✅ It lands directly on the Notifications view.

### 3.2 One Notifications page, no sub-tabs
1. On the Notifications view:
   ✅ It's a **single page with two stacked sections** — delivery **preferences** (priority
   threshold + Email/SMS/WhatsApp/Phone channels + phone verification) on top, **My alerts**
   (your alert subscriptions + Quiet hours) below. The old "Notification preferences / My
   alerts" sub-tabs are gone.

### 3.3 Escalation alerts fire on an in-app priority raise (FIX)
1. As an agent, add a **My alerts** subscription with **"is escalated"** on, matching a
   category you can generate a test ticket for.
2. Create a **QA TEST** ticket in that category, then **raise its priority in Ticket Pulse**
   (e.g. Medium → High, then High → Urgent).
   ✅ You receive an escalation alert (previously, priority changes made *inside* Ticket Pulse
   didn't fire any alert — only changes made in FreshService did).
3. ✅ The second raise (High → Urgent) alerts again — a repeat escalation on the same ticket
   isn't suppressed.

---

## 4. Settings reorganization (Features Request 07-20 #9)

1. Open **Settings** (as an admin).
   ✅ The left nav is now grouped under headers — **Integrations · Tickets & AI ·
   Notifications & Public · Team & Scheduling · Sync & Data · Workspace** — and items are
   alphabetical within each group.
2. Find **Notifications** (the email/SMS provider setup).
   ✅ It's under the **Notifications & Public** group — easy to locate now. (This is the
   provider config, distinct from your personal Notifications page in §3.)

---

## 5. Ticket detail tweaks (Features Request 07-20 #5, #6)

### 5.1 Tab accent
1. On a ticket, look at the active tab's blue top accent (Conversation / Approvals / AI &
   Routing / Tasks / Activity).
   ✅ The blue bar sits **inside** the rounded tab corners — it no longer pokes out past them.

### 5.2 Impact / Urgency removed
1. Open a ticket's detail sidebar.
   ✅ **Impact** and **Urgency** fields are gone.

---

## 6. Tasks & FreshService (Features Request 07-20 #12, #14)

### 6.1 FreshService task descriptions are clean
1. On a **FreshService-born** ticket that has tasks (or add a task in FS with a description),
   open the ticket's **Tasks** tab in Ticket Pulse.
   ✅ The task description shows as **plain text** — no more raw HTML / `<div style=…>` markup.

### 6.2 TP-born tasks sync to FreshService (FIX)
1. Create a **QA TEST** ticket in Ticket Pulse (native ticketing workspace) and **immediately
   add 1–2 tasks** to it (before its FreshService copy has been created).
2. Wait for the ticket to mirror to FreshService (~a few minutes), then open the FS copy.
   ✅ The tasks you added are now present on the FreshService ticket (previously, tasks added
   before the mirror existed were never pushed).
3. Add another task **after** the ticket is mirrored. ✅ It appears in FreshService too.

---

## 7. Public API — base URL (Features Request 07-20 #15-17)

1. Open **Settings → API Keys**.
   ✅ A **Base URL** is shown with a **Copy** button, and a note that the app domain serves
   the web UI, not the API. The "API docs" link points at the API host.
2. Create a **Live** key with `tickets:read` (and copy it), then call the API using the
   **Base URL shown on that page** (not the web address):
   ```
   curl <BASE_URL>/me -H "Authorization: Bearer tp_live_…"
   ```
   ✅ Returns **JSON** (your key name, workspace, scopes) — not the HTML web page.
3. `GET <BASE_URL>/tickets` ✅ returns JSON. `POST <BASE_URL>/tickets` with a body ✅ creates
   a ticket (no more 405/HTML — those happened because the earlier calls went to the web
   address instead of the API host).

---

## Notes for QA
- **Reduced Motion:** several live cues have static fallbacks now — if your test device runs
  Reduce Motion, expect steady highlights rather than animations (that's intended).
- **Origin matters:** "TP-born" = created in Ticket Pulse (fully editable, mirrored to FS);
  "FS-born" = created in FreshService (read-mostly). Test steps call out which is needed.
- Please report: any ticket link that still opens FreshService instead of the in-app page;
  any stat card that isn't clickable; a mobile layout that squeezes or hides content; an
  escalation alert that doesn't arrive; or an API call to the shown Base URL that returns
  HTML instead of JSON.
