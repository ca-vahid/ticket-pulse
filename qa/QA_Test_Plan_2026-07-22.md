# Ticket Pulse — QA Test Plan (2026-07-22)

**Build under test:** next preview build · **Prepared for:** QA team · **From:** Ticket Pulse dev

**Tester:** ________________  **Date:** ____________  **Device / browser:** ________________

This round validates the **Features Request 07-21** fixes: the Notifications page is now its
own destination and has been redesigned, the public API accepts ticket references and returns
a pagination cursor, and the email delivery-health card is easier to find.

**How to use this doc:** Do the **fast-pass smoke check** first, then the detailed sections.
Mark each section **☐ Pass / ☐ Fail** and note the ticket ref (and, for API items, the
`X-Request-Id`). Use a **QA TEST** prefix on tickets you create. `☐` = check the box; ✅ = the
expected result.

> **Not in this build — please don't re-file these yet.** The sync-speed items (07-21 #1 tech
> schedules lag, #2 slow agent list after a workspace switch) and last round's sync-latency /
> mirror items are in a separate backend pass. They are **not** in this build.

---

## Fast-pass smoke check (≈8 min)

- ☐ **Notifications page:** the account-menu → Notifications opens a page titled **Notifications** (no "My Competencies" header, no tab bar) (§1.1)
- ☐ **Notifications redesign:** with no alerts, the "My alerts" area shows **starter templates**, not a big empty box (§1.2)
- ☐ **My Skills:** the old **My Competencies tab bar is gone** (§1.3)
- ☐ **API ref lookup:** `GET /api/v1/tickets/TP-####` returns the ticket JSON (not a 500) (§2.1)
- ☐ **API cursor:** `GET /api/v1/tickets?pageSize=5` response includes a **`next_cursor`** (§2.2)
- ☐ **Email health:** Settings → **Notifications & Public → Notifications** shows the **Email delivery health** card (§3)

**Smoke result:** ☐ Pass   ☐ Fail — Notes: _______________________________________________

---

## 1. Notifications page (Features Request 07-21 #3, #4, #5, #6)

### 1.1 It's a standalone page (no My Competencies chrome)
1. Click your **avatar menu** (top-right) → **Notifications**. (On a phone: **More → Notifications**.)
2. ✅ It opens a page whose header reads **"Notifications"** (with "Email & alert
   preferences") — **not** "My Competencies".
3. ✅ There is **no tab bar** (My Competencies / Notifications / IT Summit) on this page.
4. ✅ "Back to Dashboard" (or "Back to My Skills" for agents) and "Logout" work.

**Result:** ☐ Pass   ☐ Fail — Notes: ___________________________________________________

### 1.2 Redesigned layout (delivery preferences + My alerts)
1. On the Notifications page:
   ✅ A page intro at the top, then a **"How you're notified"** card (priority threshold +
   Email/SMS/WhatsApp/Phone channels + phone verification), then **"My alerts"** below.
2. If you have **no alerts yet**:
   ✅ Instead of a large empty box, the **My alerts** area shows **one-click starter
   templates** — **Urgent tickets**, **Escalations**, **A category** — plus a "build one from
   scratch" link. The space no longer looks sparse/empty.
3. Tap a template (e.g. **Urgent tickets**).
   ✅ The alert form opens **pre-filled** for that template; you can adjust and **Create alert**.
4. ✅ Once created, the alert shows as a compact card (with Pause / Edit / Delete), and
   **Quiet hours** sits in its own row below.

**Result:** ☐ Pass   ☐ Fail — Notes: ___________________________________________________

### 1.3 My Skills no longer shows the nav bar
1. Account menu → **My Skills** (My Competencies page).
   ✅ The old horizontal **tab bar** (My Competencies / Notifications / IT Summit) is **gone**.
2. (IT workspace only) ✅ The archived **IT Summit** view is reachable via a small **"IT
   Summit"** pill in the page header; tapping it toggles to the Summit view and back.

**Result:** ☐ Pass   ☐ Fail — Notes: ___________________________________________________

---

## 2. Public API (Features Request 07-21 #7, #8)

Use the **Base URL** shown in **Settings → API Keys** (the API host, not the web address) and
a **Live** key.

### 2.1 Lookup by ticket reference (no more 500)
1. `GET <BASE_URL>/tickets/36533` (a numeric internal id) ✅ returns the ticket JSON (as before).
2. `GET <BASE_URL>/tickets/TP-1048` (its visible ref) ✅ returns the **same ticket** JSON —
   **not** a 500 internal error.
3. `GET <BASE_URL>/tickets/#233976` (an FS-born ref; URL-encode the `#` as `%23`) ✅ returns
   that ticket.
4. `GET <BASE_URL>/tickets/TP-999999` (a ref that doesn't exist) ✅ returns a clean **404**
   problem+json (`code: not_found`), never a 500.

**Result:** ☐ Pass   ☐ Fail — Notes: ___________________________________________________

### 2.2 Pagination returns a cursor
1. `GET <BASE_URL>/tickets?pageSize=5`
   ✅ The `pagination` block now contains a **`next_cursor`** (and `total`).
2. Call again with `?pageSize=5&cursor=<next_cursor>` from the previous response.
   ✅ Returns the **next** 5 tickets (no overlap); on the last page `next_cursor` is `null`.
3. (Optional) `GET <BASE_URL>/tickets?page=2&pageSize=5` ✅ still works for offset paging
   (returns `page` / `page_size` / `total`).

**Result:** ☐ Pass   ☐ Fail — Notes: ___________________________________________________

### 2.3 Concurrent idempotency (07-20 4.5.3, now testable)
Firing two requests at once is hard by hand — this PowerShell one-liner fires two identical
POSTs in parallel with the same `Idempotency-Key`:
```
$h = @{ Authorization = "Bearer tp_live_…"; "Idempotency-Key" = "qa-conc-1"; "Content-Type"="application/json" }
$b = '{"subject":"QA TEST concurrent","requesterEmail":"you@bgcengineering.ca"}'
1..2 | ForEach-Object { Start-Job { param($u,$h,$b) Invoke-WebRequest -Uri $u -Method Post -Headers $h -Body $b } -ArgumentList "<BASE_URL>/tickets",$h,$b } | Wait-Job | Receive-Job
```
✅ Exactly **one** ticket is created; the other returns **409 `idempotency_in_flight`**.

**Result:** ☐ Pass   ☐ Fail — Notes: ___________________________________________________

---

## 3. Email delivery health is findable (Features Request 07-21 #10)

1. As an admin, open **Settings**.
   ✅ The left nav is **grouped** (Integrations · Tickets & AI · Notifications & Public · …).
2. Go to **Notifications & Public → Notifications**.
   ✅ The **Email delivery health** card is at the top — status badge (Healthy / Degraded /
   Delivery failing), last successful send, 24h sent/failed counts, and a hint if failing.
3. In that same section → **SendGrid**, send a test email to yourself.
   ✅ It arrives and the health card shows a recent success / bumped 24h count.

> If you don't see a **Notifications** item under Settings at all, that page is admin-scoped —
> tell us and we'll check your access level (it's a permission, not a missing feature).

**Result:** ☐ Pass   ☐ Fail — Notes: ___________________________________________________

---

## Notes for QA
- **API base URL:** always call the API at the **Base URL shown in Settings → API Keys**, not
  the web address (the web address serves the UI and will return HTML).
- Please report: a Notifications page that still shows "My Competencies" or a tab bar; a
  starter template that doesn't pre-fill; an API ref lookup that 500s; a `/tickets` response
  with no `next_cursor`; or an inability to find the email-health card as an admin.

**Overall sign-off:** ☐ All pass   ☐ Issues found (see notes above)  ·  Tester: ______________
